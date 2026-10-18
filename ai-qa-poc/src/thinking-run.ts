import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { askStructured, aiProvider } from './ai-client.js';
import { analysisPath, appendQuestions } from './analysis-gate.js';
import { PATHS, type ThinkingConfig } from './config.js';
import { markAddressed, rejectionOf } from './intent-approval.js';
import { lintIntent, validateIntent } from './intents.js';
import { buildSheets, type SheetSummary } from './test-case-sheet.js';
import type { Clarification } from './clarifications.js';
import type { TestIntent } from './types.js';

/**
 * The Thinker Agent, run headless through Claude Code on the subscription —
 * the same prompt pack a person used to paste by hand, so both routes produce
 * the same artifacts and the pack stays the single definition of the job.
 *
 * The model has no tools. It cannot write a file, approve anything or see the
 * repository: it returns structured fields, and this module decides what is
 * saved where. Every intent is schema-validated here, not trusted.
 */

const Question = z.object({
  question: z.string().describe('The gap, phrased as a question the requirement author can answer.'),
  why: z.string().describe('Which test is stuck, or what breaks if we guess.'),
  requirement_ref: z.string().optional().describe('The requirement section or sentence that is silent or ambiguous.'),
});

const AnalyseOutput = z.object({
  analysis_markdown: z.string().describe('The complete analysis document, in the Analysis format from the pack.'),
  questions: z.array(Question).describe('Every new question. Do not repeat one already in the ledger.'),
});

const GenerateOutput = z.object({
  intents: z.array(z.record(z.string(), z.unknown())).describe('Every draft test intent, each a complete object valid against the intent schema.'),
  coverage_audit_markdown: z.string().describe('The required final audit table: requirement sentence → intent ids, kind, automation status, uncovered risk.'),
  new_questions: z.array(Question).describe('Gaps found only now. Write no intent that depends on one of these.'),
});

const RepairOutput = z.object({
  intents: z.array(z.record(z.string(), z.unknown())),
});

const SYSTEM = [
  'You are the QA Thinker Agent (analysis) and Test Case Agent (test case writing), running headless.',
  'The user message is your complete prompt pack: rules, inputs, schema, example and task.',
  'You have no tools and cannot write files or talk to anyone. Wherever the pack tells you to save',
  'a file, ask in the chat or run a command, put that content in the structured output fields',
  'instead; the caller saves it, validates it and runs the checks.',
].join(' ');

function options(cfg: ThinkingConfig) {
  return {
    model: cfg.model,
    effort: cfg.effort,
    timeoutMs: Number(process.env.THINKING_TIMEOUT_MS ?? 45 * 60_000),
    maxTokens: 64_000,
  };
}

function preflight(): void {
  if (aiProvider() !== 'claude-cli') {
    throw new Error(
      'Claude Code was not found. The Thinker Agent runs on the Claude subscription only: install Claude Code, run `claude` once to sign in, or set CLAUDE_CLI to its path.',
    );
  }
}

/** Keep what came back, before anything is filtered — the only way to debug a bad run. */
function keepRaw(feature: string, phase: string, value: unknown): string {
  fs.mkdirSync(PATHS.thinkingPrompts, { recursive: true });
  const file = path.join(PATHS.thinkingPrompts, `response-${feature}-${phase}-${Date.now()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

export interface AnalyseResult {
  analysisFile: string;
  questions: Clarification[];
  rawFile: string;
  model: string;
}

/**
 * The header facts are ours, not the model's: it copies the template's
 * example values, and a committed analysis naming the wrong model or file is
 * a small lie in the audit trail. The reviewer line waits for Gate 1.
 */
function stampHeader(markdown: string, facts: { source: string; model: string }): string {
  return markdown
    .replace(/^\* \*\*Requirement source:\*\*.*$/m, `* **Requirement source:** ${facts.source}`)
    .replace(/^\* \*\*Model:\*\*.*$/m, `* **Model:** ${facts.model}`)
    .replace(/^\* \*\*Analyst \(human reviewer\):\*\*.*$/m, '* **Analyst (human reviewer):** pending Gate 1 — `npm run approve-analysis`');
}

export async function runAnalyse(
  feature: string | undefined,
  pack: string,
  cfg: ThinkingConfig,
  opts: { requirementLocator: string },
): Promise<AnalyseResult> {
  preflight();
  const answer = await askStructured(AnalyseOutput, SYSTEM, pack, options(cfg));
  if (!answer.ok) throw new Error(`Thinker Agent failed: ${answer.error}`);
  const label = feature ?? 'default';
  const rawFile = keepRaw(label, 'analyse', answer.value);

  fs.mkdirSync(PATHS.thinkingAnalysis, { recursive: true });
  const analysisFile = analysisPath(feature, new Date().toISOString().slice(0, 10));
  const markdown = stampHeader(answer.value.analysis_markdown.trim(), {
    source: opts.requirementLocator,
    model: `${answer.model}, effort ${cfg.effort}, headless`,
  });
  fs.writeFileSync(analysisFile, `${markdown}\n`, 'utf8');
  const questions = appendQuestions(feature, answer.value.questions);
  return { analysisFile, questions, rawFile, model: answer.model };
}

export interface GenerateResult {
  written: string[];
  /** Drafts rewritten in answer to a Gate 2 rework request. */
  reworked: string[];
  /** Intents whose requirement_ref.locator named no real file and was corrected. */
  relocated: number;
  skipped: { id: string; reason: string }[];
  invalid: { id: string; errors: string[] }[];
  warnings: { id: string; warnings: string[] }[];
  questions: Clarification[];
  auditFile: string;
  sheets: SheetSummary[];
  rawFile: string;
  model: string;
}

type Candidate = Record<string, unknown>;
const idOf = (c: Candidate, i: number): string => (typeof c.test_id === 'string' ? c.test_id : `#${i + 1}`);

function check(candidates: Candidate[]) {
  const ok: Candidate[] = [];
  const bad: { candidate: Candidate; id: string; errors: string[] }[] = [];
  candidates.forEach((c, i) => {
    const v = validateIntent(c);
    if (v.valid) ok.push(c);
    else bad.push({ candidate: c, id: idOf(c, i), errors: v.errors });
  });
  return { ok, bad };
}

export async function runGenerate(
  feature: string | undefined,
  pack: string,
  cfg: ThinkingConfig,
  opts: { overwrite?: boolean; requirementLocator: string; rework?: Set<string> },
): Promise<GenerateResult> {
  preflight();
  const answer = await askStructured(GenerateOutput, SYSTEM, pack, options(cfg));
  if (!answer.ok) throw new Error(`Test Case Agent failed: ${answer.error}`);
  const label = feature ?? 'default';
  const rawFile = keepRaw(label, 'generate', answer.value);

  // A locator that names no real file breaks traceability, verify's quote
  // check and the sheet's grouping all at once. Only one requirement file was
  // in the pack, so a missing path can only mean that one.
  let relocated = 0;
  for (const c of answer.value.intents) {
    // `feature` is the key verify, bind, inspect, the reports and Gate 2 all
    // select by. The model tends to write the product name ("Sign in"), which
    // would hide the test case from every one of them.
    if (feature) c.feature = feature;
    const ref = c.requirement_ref as { locator?: string } | undefined;
    if (ref && (!ref.locator || !fs.existsSync(path.join(PATHS.root, ref.locator)))) {
      ref.locator = opts.requirementLocator;
      relocated++;
    }
  }

  let { ok, bad } = check(answer.value.intents);

  // One repair round. A schema slip (a missing field, a wrong enum) is cheap to
  // fix with the error in hand; re-running the whole generation is not.
  if (bad.length) {
    const schema = fs.readFileSync(path.join(PATHS.schemas, 'test-intent.schema.json'), 'utf8');
    const prompt = [
      'These draft test intents failed JSON Schema validation. Return each one corrected, keeping its',
      'test_id and its meaning. Fix only what the errors name; do not invent requirement content.',
      '',
      '## Intent schema',
      '```json',
      schema,
      '```',
      '',
      ...bad.flatMap((b) => [`## ${b.id}`, '', 'Errors:', ...b.errors.map((e) => `- ${e}`), '', '```json', JSON.stringify(b.candidate, null, 2), '```', '']),
    ].join('\n');
    const repaired = await askStructured(RepairOutput, SYSTEM, prompt, { ...options(cfg), effort: 'medium' });
    if (repaired.ok) {
      keepRaw(label, 'repair', repaired.value);
      const second = check(repaired.value.intents);
      ok = [...ok, ...second.ok];
      bad = second.bad;
    }
  }

  const written: string[] = [];
  const reworked: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const warnings: { id: string; warnings: string[] }[] = [];
  const rework = opts.rework ?? new Set<string>();
  fs.mkdirSync(PATHS.intentsDraft, { recursive: true });
  for (const c of ok) {
    const intent = c as unknown as TestIntent;
    const id = intent.test_id;
    if (fs.existsSync(path.join(PATHS.intentsApproved, `${id}.json`))) {
      skipped.push({ id, reason: 'already approved — never overwritten by generation' });
      continue;
    }
    const rejection = rejectionOf(id);
    if (rejection) {
      skipped.push({ id, reason: `rejected at Gate 2 by ${rejection.rejected_by} (${rejection.reason}) — not brought back` });
      continue;
    }
    const target = path.join(PATHS.intentsDraft, `${id}.json`);
    // A draft under a rework request is exactly what the reviewer asked to be
    // rewritten; any other existing draft may hold edits made by hand.
    if (fs.existsSync(target) && !opts.overwrite && !rework.has(id)) {
      skipped.push({ id, reason: 'a draft already exists (may hold reviewer edits) — pass --overwrite to replace' });
      continue;
    }
    fs.writeFileSync(target, `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
    (rework.has(id) ? reworked : written).push(id);
    const lint = lintIntent(intent);
    if (lint.length) warnings.push({ id, warnings: lint });
  }
  markAddressed(feature, reworked);

  const auditFile = path.join(PATHS.thinkingAnalysis, `${label}-coverage-audit-${new Date().toISOString().slice(0, 10)}.md`);
  fs.mkdirSync(PATHS.thinkingAnalysis, { recursive: true });
  fs.writeFileSync(auditFile, `${answer.value.coverage_audit_markdown.trim()}\n`, 'utf8');

  const questions = appendQuestions(feature, answer.value.new_questions);
  const sheets = buildSheets(feature);

  return {
    written,
    reworked,
    relocated,
    skipped,
    invalid: bad.map((b) => ({ id: b.id, errors: b.errors })),
    warnings,
    questions,
    auditFile,
    sheets,
    rawFile,
    model: answer.model,
  };
}
