import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { answersTurn, runAgent, type ClarifyingQuestion } from '@/lib/agent';
import { configuredDefault, estimateCost, isAllowedModel } from '@/lib/models';
import path from 'node:path';
import { listFeatures, PROJECT_ROOT } from '@/lib/paths';

export const runtime = 'nodejs';
// Every call costs real money and takes real time — never cached.
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Feature list + configured default, for the UI to render its controls. */
export async function GET() {
  return NextResponse.json({
    features: listFeatures().map((f) => ({ id: f.id, label: f.label })),
    default: configuredDefault(),
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      phase: 'analyze' | 'generate';
      model?: string;
      effort?: string;
      requirement?: string;
      featureId?: string;
      requirementPath?: string;
      idPrefix?: string;
      history?: unknown[];
      questions?: ClarifyingQuestion[];
      answers?: Record<string, string>;
    };

    const cfg = configuredDefault();
    const model = body.model ?? cfg.model;
    const effort = body.effort ?? cfg.effort;

    if (!isAllowedModel(model)) {
      return NextResponse.json({ error: `Unknown model: ${model}` }, { status: 400 });
    }

    if (body.phase === 'analyze' && !body.requirement?.trim()) {
      return NextResponse.json({ error: 'Paste a requirement first.' }, { status: 400 });
    }

    // Load the chosen feature's application context, if one was picked, and
    // work out where its requirement lives so missions cite the right file.
    let appContextYaml: string | undefined;
    let requirementPath = body.requirementPath;
    if (body.featureId) {
      const feature = listFeatures().find((f) => f.id === body.featureId);
      if (feature && fs.existsSync(feature.contextFile)) {
        appContextYaml = fs.readFileSync(feature.contextFile, 'utf8');
      }
      if (!requirementPath) {
        const dir = body.featureId === 'default' ? 'feature' : `feature-${body.featureId}`;
        const candidate = path.join('input', dir, 'requirement.md');
        // Only claim a path that actually exists — a confident citation of a
        // missing file is worse than admitting there isn't one.
        if (fs.existsSync(path.join(PROJECT_ROOT, candidate))) {
          requirementPath = candidate.split(path.sep).join('/');
        }
      }
    }

    let history = (body.history ?? []) as Parameters<typeof runAgent>[0]['history'];

    // Phase 2 begins by recording the human's answers as an authoritative turn.
    if (body.phase === 'generate' && body.questions?.length) {
      history = [...history, answersTurn(body.questions, body.answers ?? {})];
    }

    const { result, usage, history: nextHistory } = await runAgent({
      phase: body.phase,
      model,
      effort,
      requirement: body.requirement ?? '',
      appContextYaml,
      requirementPath,
      idPrefix: body.idPrefix,
      history,
    });

    return NextResponse.json({
      result,
      usage: { ...usage, estimatedCost: estimateCost(model, usage.inputTokens, usage.outputTokens) },
      history: nextHistory,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Surfaced verbatim to the UI: a missing key or a refused model is
    // something the human must see and fix, not a generic 500.
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
