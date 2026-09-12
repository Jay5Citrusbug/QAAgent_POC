import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { answersTurn, runAgent, type ClarifyingQuestion } from '@/lib/agent';
import { configuredDefault, estimateCost, isAllowedModel } from '@/lib/models';
import { listFeatures } from '@/lib/paths';

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

    // Load the chosen feature's application context, if one was picked.
    let appContextYaml: string | undefined;
    if (body.featureId) {
      const feature = listFeatures().find((f) => f.id === body.featureId);
      if (feature && fs.existsSync(feature.contextFile)) {
        appContextYaml = fs.readFileSync(feature.contextFile, 'utf8');
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
