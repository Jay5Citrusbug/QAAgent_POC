import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { featurePaths, PATHS } from './config.js';
import {
  hashAnswer,
  ledgerPath,
  loadLedger,
  nextId,
  thinkingPhase,
  type Clarification,
} from './clarifications.js';
import { hashFile } from './requirement-hash.js';

/**
 * Gate 1 — a person approves the requirement analysis before any test case is
 * written from it.
 *
 * Answering the questions is not the same as approving the analysis. The
 * analysis also ranks the risks, decides what is P0 and rules whole coverage
 * categories out — and every test case generated afterwards inherits those
 * calls. So they get a named approver, like the test cases do at Gate 2.
 *
 * The approval fingerprints what it approved: the analysis, the requirement
 * and documentation, and every answer. Change any of them and the approval is
 * stale, and generation stops until someone re-reads and re-approves. An
 * approval that silently outlives the thing it approved is just a signature.
 */

export interface AnalysisApproval {
  feature: string;
  analysis_file: string;
  approved_by: string;
  approved_at: string;
  review_minutes?: number;
  edits_made?: boolean;
  fingerprint: Fingerprint;
}

interface Fingerprint {
  analysis: string;
  requirement: string;
  answers: string;
}

const name = (feature?: string): string => feature ?? 'default';

function analysisPattern(feature?: string): RegExp {
  const escaped = name(feature).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}-\\d{4}-\\d{2}-\\d{2}\\.md$`);
}

/** The newest analysis for a feature — the one generation works from. */
export function latestAnalysis(feature?: string): string | undefined {
  if (!fs.existsSync(PATHS.thinkingAnalysis)) return undefined;
  const pattern = analysisPattern(feature);
  const found = fs.readdirSync(PATHS.thinkingAnalysis).filter((f) => pattern.test(f)).sort();
  const last = found[found.length - 1];
  return last ? path.join(PATHS.thinkingAnalysis, last) : undefined;
}

export function analysisPath(feature: string | undefined, date: string): string {
  return path.join(PATHS.thinkingAnalysis, `${name(feature)}-${date}.md`);
}

export function approvalPath(feature?: string): string {
  return path.join(PATHS.thinkingAnalysis, `${name(feature)}.approval.json`);
}

const sha = (text: string): string => `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)}`;

function fingerprint(feature: string | undefined, analysisFile: string): Fingerprint {
  const paths = featurePaths(feature);
  const requirement = [path.join(paths.requirementDir, 'requirement.md'), paths.documentationFile]
    .map((f) => (fs.existsSync(f) ? hashFile(f) : 'absent'))
    .join('+');
  const answers = loadLedger(feature)
    .questions.map((q) => `${q.id}:${q.status}:${hashAnswer(q) ?? ''}`)
    .sort()
    .join('\n');
  return { analysis: hashFile(analysisFile), requirement: sha(requirement), answers: sha(answers) };
}

export type GateState =
  | { state: 'missing'; reasons: string[] }
  | { state: 'stale'; reasons: string[]; approval: AnalysisApproval }
  | { state: 'approved'; reasons: []; approval: AnalysisApproval };

export function analysisGate(feature?: string): GateState {
  const file = approvalPath(feature);
  const analysis = latestAnalysis(feature);
  if (!fs.existsSync(file) || !analysis) return { state: 'missing', reasons: ['Nobody has approved the analysis yet.'] };

  const approval = JSON.parse(fs.readFileSync(file, 'utf8')) as AnalysisApproval;
  const now = fingerprint(feature, analysis);
  const reasons: string[] = [];
  if (path.basename(analysis) !== path.basename(approval.analysis_file)) {
    reasons.push(`A newer analysis exists (${path.basename(analysis)}) than the one approved (${path.basename(approval.analysis_file)}).`);
  } else if (now.analysis !== approval.fingerprint.analysis) {
    reasons.push('The analysis was edited after it was approved.');
  }
  if (now.requirement !== approval.fingerprint.requirement) reasons.push('The requirement or documentation changed after approval.');
  if (now.answers !== approval.fingerprint.answers) reasons.push('A clarification was added, answered or re-answered after approval.');
  return reasons.length ? { state: 'stale', reasons, approval } : { state: 'approved', reasons: [], approval };
}

export function approveAnalysis(
  feature: string | undefined,
  by: string,
  opts: { minutes?: number; edited?: boolean } = {},
): AnalysisApproval {
  const analysis = latestAnalysis(feature);
  if (!analysis) throw new Error(`No analysis for ${name(feature)} in thinking/analysis/.`);
  const approval: AnalysisApproval = {
    feature: name(feature),
    analysis_file: path.relative(PATHS.root, analysis).replace(/\\/g, '/'),
    approved_by: by,
    approved_at: new Date().toISOString(),
    ...(opts.minutes !== undefined ? { review_minutes: opts.minutes } : {}),
    ...(opts.edited ? { edits_made: true } : {}),
    fingerprint: fingerprint(feature, analysis),
  };
  fs.writeFileSync(approvalPath(feature), `${JSON.stringify(approval, null, 2)}\n`, 'utf8');
  return approval;
}

/**
 * Where the Thinking Agent is in the job.
 *
 *   analyse    no analysis yet — run it
 *   blocked    questions are open — a human answers them
 *   approval   analysis done, all answered — Gate 1 waits for a person
 *   generate   Gate 1 approved and still current — write the test cases
 */
export type ThinkingStage =
  | { stage: 'analyse' | 'blocked' | 'generate'; reason: string; open: Clarification[] }
  | { stage: 'approval'; reason: string; open: Clarification[]; gate: GateState };

export function thinkingStage(feature?: string): ThinkingStage {
  const phase = thinkingPhase(feature);
  if (phase.phase !== 'generate') return { stage: phase.phase, reason: phase.reason, open: phase.open };
  const gate = analysisGate(feature);
  if (gate.state === 'approved') {
    return { stage: 'generate', reason: `Gate 1 approved by ${gate.approval.approved_by}.`, open: [] };
  }
  return {
    stage: 'approval',
    reason: gate.state === 'missing' ? 'Every question is answered; the analysis is waiting for Gate 1.' : `Gate 1 approval is stale: ${gate.reasons.join(' ')}`,
    open: [],
    gate,
  };
}

/**
 * Add questions the Thinking Agent raised to the ledger as open.
 * Keeps the file's comments: a colleague's note in the YAML is not ours to drop.
 */
export function appendQuestions(
  feature: string | undefined,
  items: { question: string; why?: string; requirement_ref?: string }[],
): Clarification[] {
  if (items.length === 0) return [];
  const file = ledgerPath(feature);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const doc = fs.existsSync(file)
    ? YAML.parseDocument(fs.readFileSync(file, 'utf8'))
    : YAML.parseDocument(`feature: ${name(feature)}\nquestions: []\n`);

  const ledger = loadLedger(feature);
  const asked = new Set(ledger.questions.map((q) => q.question.trim().toLowerCase()));
  const added: Clarification[] = [];
  for (const item of items) {
    if (asked.has(item.question.trim().toLowerCase())) continue;
    const entry: Clarification = {
      id: nextId({ ...ledger, questions: [...ledger.questions, ...added] }),
      question: item.question,
      ...(item.why ? { why: item.why } : {}),
      status: 'open',
      answer: null,
      raised_at: new Date().toISOString().slice(0, 10),
      ...(item.requirement_ref ? { requirement_ref: item.requirement_ref } : {}),
    };
    added.push(entry);
  }
  const questions = doc.get('questions');
  if (YAML.isSeq(questions)) for (const e of added) questions.add(e);
  else doc.set('questions', added);
  fs.writeFileSync(file, doc.toString(), 'utf8');
  return added;
}
