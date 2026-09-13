import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';
import type { ExecutionResult, TestMission } from './types.js';

export interface ExecutionAiAnalysis {
  status: 'available' | 'skipped' | 'failed';
  model?: string;
  summary?: string;
  likely_cause?: 'product_defect' | 'test_or_binding_problem' | 'environment_problem' | 'inconclusive';
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  evidence?: string[];
  follow_up?: string[];
  error?: string;
}

const MAX_CONTEXT = 12_000;

export function analysisKey(result: ExecutionResult): string | undefined {
  if (result.status === 'PASS' && !result.incidental_findings?.length) return undefined;
  const finding = result.incidental_findings?.[0];
  if (finding) {
    const resource = `${finding.detail ?? ''} ${finding.summary}`.match(/https?:\/\/[^\s)"']+/)?.[0];
    return `finding:${finding.kind}:${resource ?? finding.summary}:${finding.detail ?? ''}`;
  }
  const failed = result.assertion_results?.find((assertion) => !assertion.passed);
  return `result:${result.failure_kind ?? 'unknown'}:${failed?.error ?? failed?.observed ?? result.actual.join('|')}`;
}

function enabled(): boolean {
  return process.env.EXECUTION_AI === 'true' && Boolean(process.env.ANTHROPIC_API_KEY);
}

function readEvidence(result: ExecutionResult): string {
  const files = result.evidence
    .filter((file) => /failure-snapshot\.yaml$|execution\.log$/.test(file))
    .map((file) => path.resolve(PATHS.root, file));
  return files
    .filter((file) => fs.existsSync(file))
    .map((file) => `\n--- ${file} ---\n${fs.readFileSync(file, 'utf8').slice(0, MAX_CONTEXT)}`)
    .join('\n')
    .slice(0, MAX_CONTEXT * 2);
}

function extractJson(text: string): Omit<ExecutionAiAnalysis, 'status' | 'model'> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI response did not contain a JSON object.');
  return JSON.parse(candidate.slice(start, end + 1)) as Omit<ExecutionAiAnalysis, 'status' | 'model'>;
}

export async function analyzeExecution(
  mission: TestMission,
  result: ExecutionResult,
): Promise<ExecutionAiAnalysis> {
  if (!enabled()) return { status: 'skipped' };

  const model = process.env.EXECUTION_AI_MODEL ?? 'claude-sonnet-5';
  const prompt = `You are a QA triage analyst reviewing one deterministic browser execution.
Do not invent a result and do not change PASS/FAIL/BLOCKED/INCONCLUSIVE. Analyze only the evidence provided.
Return ONLY JSON with this shape:
{
  "summary": "short evidence-grounded explanation",
  "likely_cause": "product_defect|test_or_binding_problem|environment_problem|inconclusive",
  "confidence": "HIGH|MEDIUM|LOW",
  "evidence": ["specific observed facts"],
  "follow_up": ["bounded human or read-only checks"]
}

Mission:
${JSON.stringify(mission)}

Deterministic result:
${JSON.stringify(result)}

Captured evidence:
${readEvidence(result)}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY as string,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 700,
        temperature: 0,
        system: 'You are a careful QA reviewer. Evidence beats speculation.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`Anthropic API returned HTTP ${response.status}.`);
    const body = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n') ?? '';
    return { status: 'available', model, ...extractJson(text) };
  } catch (error) {
    return {
      status: 'failed',
      model,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}