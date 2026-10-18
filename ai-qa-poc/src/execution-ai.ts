import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';
import { z } from 'zod';
import { aiAvailable, askStructured } from './ai-client.js';
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

type Provider = 'anthropic' | 'openai' | 'google';

function providerForModel(model: string): Provider {
  if (/^(gpt-|o[1-9]|chatgpt-)/i.test(model)) return 'openai';
  if (/^(gemini-|gemma-)/i.test(model)) return 'google';
  return 'anthropic';
}

function providerAvailable(provider: Provider): boolean {
  if (provider === 'anthropic') return Boolean(process.env.ANTHROPIC_API_KEY);
  if (provider === 'openai') return Boolean(process.env.OPENAI_API_KEY);
  return Boolean(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY);
}

/** A non-Claude model is used only when named explicitly and its key is set. */
function wantsOtherProvider(): boolean {
  const m = process.env.EXECUTION_AI_MODEL ?? '';
  const p = providerForModel(m);
  return p !== 'anthropic' && providerAvailable(p);
}

function enabled(): boolean {
  // Claude runs through ai-client.ts: the Claude Code subscription by default,
  // the API only when a key is set — so no key is needed for triage either.
  return process.env.EXECUTION_AI === 'true' && (aiAvailable() || wantsOtherProvider());
}

const Triage = z.object({
  summary: z.string(),
  likely_cause: z.enum(['product_defect', 'test_or_binding_problem', 'environment_problem', 'inconclusive']),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  evidence: z.array(z.string()),
  follow_up: z.array(z.string()),
});

function defaultModel(): string {
  if (process.env.EXECUTION_AI_MODEL) return process.env.EXECUTION_AI_MODEL;
  if (providerAvailable('openai')) return 'gpt-5';
  return 'gemini-2.5-pro';
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

  const model = defaultModel();
  const provider = wantsOtherProvider() ? providerForModel(model) : 'anthropic';
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

  const system = 'You are a careful QA reviewer. Evidence beats speculation.';
  if (provider === 'anthropic') {
    const answer = await askStructured(Triage, system, prompt, { timeoutMs: 180_000 });
    return answer.ok
      ? { status: 'available', model: answer.model, ...answer.value }
      : { status: 'failed', model: answer.model, error: answer.error };
  }

  try {
    let text = '';
    if (provider === 'openai') {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model, max_completion_tokens: 700, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
      });
      if (!response.ok) throw new Error(`OpenAI API returned HTTP ${response.status}.`);
      const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      text = body.choices?.[0]?.message?.content ?? '';
    } else {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 700, responseMimeType: 'application/json' },
        }),
      });
      if (!response.ok) throw new Error(`Google AI API returned HTTP ${response.status}.`);
      const body = (await response.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    }
    return { status: 'available', model, ...extractJson(text) };
  } catch (error) {
    return {
      status: 'failed',
      model,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}