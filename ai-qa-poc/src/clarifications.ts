import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { featurePaths, PATHS } from './config.js';

/**
 * The clarification ledger.
 *
 * The Thinking Agent's first hard rule is "never invent expected behaviour — a
 * gap is a question you report, not a blank you fill". That was prose, and
 * prose enforces nothing. Worse, the answers were given in a chat window and
 * died with the tab, so the next story asked the same questions again.
 *
 * This makes the questions an artifact:
 *
 *   1. The agent writes questions here, alongside the intents that depend on
 *      them. Question and intent arrive together — that is the honest order.
 *   2. `npm run approve-intent` refuses while any dependency is still `open`.
 *      That is the enforcement: the rule becomes a gate.
 *   3. `assumed` is a legitimate answer, because waiting is not always an
 *      option — but it is stamped, and it rides into the run report so nobody
 *      mistakes a guess for a confirmed requirement.
 *
 * Answers are hashed for the same reason requirements are (see
 * requirement-hash.ts): an answer revised after approval silently changes what
 * the test claims to prove, and the approval stamp still looks valid.
 *
 * Deliberately YAML rather than Markdown. A human edits this file by hand to
 * answer a question, and a parser that can misread a hand-written heading is a
 * parser that will one day report a question as answered when it is not.
 */

export type ClarificationStatus = 'open' | 'answered' | 'assumed';

export interface Clarification {
  id: string;
  question: string;
  /** Why it matters — which intents are stuck, or what breaks if we guess. */
  why?: string;
  status: ClarificationStatus;
  answer?: string | null;
  answered_by?: string | null;
  answered_at?: string | null;
  raised_at?: string | null;
  /** Free-text pointer to the requirement line that is silent on this. */
  requirement_ref?: string | null;
}

export interface Ledger {
  file: string;
  feature?: string;
  questions: Clarification[];
}

const EMPTY: Omit<Ledger, 'file'> = { questions: [] };

export function ledgerPath(feature?: string): string {
  return path.join(featurePaths(feature).requirementDir, 'clarifications.yaml');
}

export function loadLedger(feature?: string): Ledger {
  const file = ledgerPath(feature);
  if (!fs.existsSync(file)) return { file, ...EMPTY };

  const parsed = YAML.parse(fs.readFileSync(file, 'utf8')) as Partial<Ledger> | null;
  const questions = (parsed?.questions ?? []).map((q) => ({
    ...q,
    // A missing status is treated as open. The safe default is the one that
    // blocks approval: a ledger typo must never silently unblock a gate.
    status: (q.status ?? 'open') as ClarificationStatus,
  }));
  return { file, feature: parsed?.feature, questions };
}

export function byId(ledger: Ledger): Map<string, Clarification> {
  return new Map(ledger.questions.map((q) => [q.id, q]));
}

/**
 * Hash of the answer as it reads now.
 *
 * Normalised for whitespace and line endings so reflowing a paragraph is not
 * mistaken for a change of meaning — the same reasoning as the requirement
 * hash, where a Windows/Unix checkout difference must not read as drift.
 */
export function hashAnswer(q: Clarification): string | undefined {
  if (!q.answer) return undefined;
  const text = q.answer.replace(/\r\n/g, '\n').trim().replace(/\s+/g, ' ');
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)}`;
}

export type DependencyState =
  | { id: string; state: 'missing' }
  | { id: string; state: 'open'; question: Clarification }
  | { id: string; state: 'answered'; question: Clarification }
  | { id: string; state: 'assumed'; question: Clarification };

/**
 * Resolve an intent's declared dependencies against the ledger.
 *
 * A referenced id that is not in the ledger is `missing`, and is treated
 * exactly as severely as `open`. An intent pointing at a question nobody ever
 * wrote down is not cleared to run — it is a broken reference, and letting it
 * through would make the whole mechanism bypassable with a typo.
 */
export function resolveDependencies(ids: string[] | undefined, ledger: Ledger): DependencyState[] {
  const index = byId(ledger);
  return (ids ?? []).map((id) => {
    const question = index.get(id);
    if (!question) return { id, state: 'missing' as const };
    return { id, state: question.status, question };
  });
}

/** The ones that must be resolved before Gate 1 can pass. */
export function blocking(deps: DependencyState[]): DependencyState[] {
  return deps.filter((d) => d.state === 'open' || d.state === 'missing');
}

/** Answered by assumption rather than confirmation — allowed, but stamped. */
export function assumed(deps: DependencyState[]): DependencyState[] {
  return deps.filter((d) => d.state === 'assumed');
}

export function describeDependency(d: DependencyState): string {
  switch (d.state) {
    case 'missing':
      return `${d.id} is not in the ledger at all — a broken reference, not an answered question.`;
    case 'open':
      return `${d.id} is unanswered: "${d.question.question}"`;
    case 'assumed':
      return `${d.id} is answered by ASSUMPTION: "${d.question.answer ?? '(no answer text)'}"`;
    case 'answered':
      return `${d.id} answered: "${d.question.answer ?? '(no answer text)'}"`;
  }
}

/** Human-readable one-liner per question, for `npm run clarify`. */
export function describe(q: Clarification): string {
  const mark = q.status === 'open' ? '?' : q.status === 'assumed' ? '~' : '✓';
  return `${mark} ${q.id}  [${q.status}]  ${q.question}`;
}

/** The ledger rendered for the Thinking Agent's prompt pack. */
export function renderLedger(ledger: Ledger): string | undefined {
  if (ledger.questions.length === 0) return undefined;

  const lines: string[] = ['## Clarifications already raised', ''];
  lines.push(
    'These questions have been asked before. **Do not ask any of them again.**',
    'Where one is answered, the answer is authoritative — treat it as part of the',
    'requirement. Where one is still open, you may write an intent that depends on',
    'it (declare the id in `depends_on_clarifications`), but you may not guess the',
    'answer, and that intent cannot be approved until a human answers.',
    '',
  );

  for (const q of ledger.questions) {
    lines.push(`### ${q.id} — ${q.question}`);
    lines.push(`* status: **${q.status}**`);
    if (q.why) lines.push(`* why it matters: ${q.why}`);
    if (q.answer) lines.push(`* answer: ${q.answer}`);
    lines.push('');
  }

  const open = ledger.questions.filter((q) => q.status === 'open').length;
  lines.push(
    `${ledger.questions.length} question(s), ${open} still open.`,
    '',
    'New questions you raise go in your analysis under "Requirement gaps", one per',
    'line, in the ledger format — a human appends them to clarifications.yaml.',
    '',
  );

  return lines.join('\n');
}

/**
 * Which half of the Thinking Agent's job is due next.
 *
 * The agent used to do both halves in one pass: analyse, raise the gaps, and
 * write every intent anyway with `depends_on_clarifications` declared. The
 * file-level gate still caught those intents at Gate 1, so nothing unsafe
 * reached execution — but the intents resting on an unanswered question had to
 * be rewritten once the answer arrived, and regenerating a whole set to correct
 * three of them is pure waste. Worse, it puts the question in front of a human
 * *after* the work that depended on it, which is exactly backwards.
 *
 * So the two halves are now separate runs, and which one is due is read off
 * disk rather than remembered:
 *
 *   analyse   no analysis exists for this feature yet → read the requirement,
 *             raise the gaps, and stop. Write no intents.
 *   blocked   the analysis exists but questions are still open → a human
 *             answers them; generating now would bake in a guess.
 *   generate  the analysis exists and nothing is open → write the intents,
 *             every one of them against a settled requirement.
 *
 * A feature whose requirement genuinely raises no questions moves straight from
 * `analyse` to `generate` on the next run, because the analysis file is what
 * marks the first half done — not the presence of questions.
 */
export type ThinkingPhase =
  | { phase: 'analyse'; reason: string; open: Clarification[] }
  | { phase: 'blocked'; reason: string; open: Clarification[] }
  | { phase: 'generate'; reason: string; open: Clarification[] };

/** Has the analysis half been done for this feature? */
export function hasAnalysis(feature?: string): boolean {
  if (!fs.existsSync(PATHS.thinkingAnalysis)) return false;
  const prefix = `${feature ?? 'default'}-`;
  return fs
    .readdirSync(PATHS.thinkingAnalysis)
    .some((f) => f.startsWith(prefix) && f.endsWith('.md'));
}

export function thinkingPhase(feature?: string): ThinkingPhase {
  const open = loadLedger(feature).questions.filter((q) => q.status === 'open');

  if (!hasAnalysis(feature)) {
    return {
      phase: 'analyse',
      open,
      reason: `No analysis exists yet for ${feature ?? 'the default feature'}.`,
    };
  }
  if (open.length > 0) {
    return {
      phase: 'blocked',
      open,
      reason: `${open.length} question(s) still unanswered.`,
    };
  }
  return {
    phase: 'generate',
    open,
    reason: 'The analysis is done and every question it raised has been answered.',
  };
}

/** Next free id, so appended questions do not collide. */
export function nextId(ledger: Ledger): string {
  const used = ledger.questions
    .map((q) => Number.parseInt(q.id.replace(/^Q-/, ''), 10))
    .filter((n) => Number.isFinite(n));
  return `Q-${Math.max(0, ...used) + 1}`;
}
