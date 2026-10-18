import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { featurePaths, PATHS } from './config.js';
import { hashAnswer, loadLedger, resolveDependencies } from './clarifications.js';
import { approvalBlockers, lintIntent, readIntentFile, validateIntent } from './intents.js';
import { hashFile, localeFilePath } from './requirement-hash.js';
import type { TestIntent } from './types.js';

/**
 * Gate 2 — the decisions a person makes about a draft test case, shared by
 * `npm run approve-intent` (one case) and `npm run approve-sheet` (a reviewed
 * sheet). One implementation, so the sheet cannot become a way around a check
 * the single-case command enforces.
 *
 * Nothing here prints. Callers decide how to tell the person.
 */

export type ApproveOutcome =
  | {
      ok: true;
      intent: TestIntent;
      from: string;
      to: string;
      warnings: string[];
      notes: string[];
    }
  | { ok: false; reasons: string[]; hint?: string };

export function approveIntent(
  testId: string,
  by: string,
  opts: { minutes?: number; edited?: boolean; checkOnly?: boolean } = {},
): ApproveOutcome {
  const src = path.join(PATHS.intentsDraft, `${testId}.json`);
  if (!fs.existsSync(src)) return { ok: false, reasons: [`No draft at intents/draft/${testId}.json.`] };

  const intent = readIntentFile(src);
  const { valid, errors } = validateIntent(intent);
  if (!valid) return { ok: false, reasons: ['Does not match the intent schema:', ...errors] };

  const ledger = loadLedger(intent.feature);

  // The hard gate: an intent resting on an unanswered question asserts
  // behaviour nobody has stated, and would later report a guess as a defect.
  const blockers = approvalBlockers(intent, ledger);
  if (blockers.length) {
    return {
      ok: false,
      reasons: blockers,
      hint: `Answer it: npm run clarify -- --feature ${intent.feature} --answer <Q-n> --text "..." --by "${by}"  (add --assumed to record an assumption)`,
    };
  }

  const warnings = lintIntent(intent, ledger);
  const notes: string[] = [];
  const dest = path.join(PATHS.intentsApproved, `${testId}.json`);
  // Every refusal above has been checked; a dry run stops before anything moves.
  if (opts.checkOnly) return { ok: true, intent, from: src, to: dest, warnings, notes };

  // Pin the requirement as it reads today, so a later edit to it is detectable.
  if (intent.requirement_ref) {
    const file = localeFilePath(intent.requirement_ref.locator);
    if (file) {
      intent.requirement_ref.content_hash = hashFile(file);
      notes.push(`Requirement pinned at ${intent.requirement_ref.content_hash}`);
    } else {
      warnings.push(`requirement_ref points at "${intent.requirement_ref.locator}", which is not a local file — a later change to it cannot be detected.`);
    }
  } else {
    warnings.push('No requirement_ref — results from this intent will not trace back to a requirement.');
  }

  // Pin each answer it rests on: an answer can change as easily as a requirement.
  const hashes: Record<string, string> = {};
  for (const d of resolveDependencies(intent.depends_on_clarifications, ledger)) {
    if (d.state === 'missing' || d.state === 'open') continue;
    const hash = hashAnswer(d.question);
    if (hash) hashes[d.id] = hash;
    if (d.state === 'assumed') intent.assumption = true;
  }
  if (Object.keys(hashes).length) notes.push(`Clarifications pinned: ${Object.keys(hashes).join(', ')}`);
  if (intent.assumption) notes.push('Rests on an ASSUMED answer — assumption: true rides into the run report.');

  intent.approval = {
    approved_by: by,
    approved_at: new Date().toISOString(),
    edits_made: Boolean(opts.edited),
    ...(opts.minutes !== undefined ? { review_minutes: opts.minutes } : {}),
    ...(Object.keys(hashes).length ? { clarification_hashes: hashes } : {}),
  };

  fs.mkdirSync(PATHS.intentsApproved, { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
  fs.rmSync(src);
  return { ok: true, intent, from: src, to: dest, warnings, notes };
}

export interface Rejection {
  rejected_by: string;
  rejected_at: string;
  reason: string;
}

/**
 * Move a draft to intents/rejected/ with who and why. Kept rather than deleted:
 * without it, the next generation proposes the same case again.
 */
export function rejectIntent(testId: string, by: string, reason: string): { ok: true; to: string } | { ok: false; reason: string } {
  const src = path.join(PATHS.intentsDraft, `${testId}.json`);
  if (!fs.existsSync(src)) return { ok: false, reason: `No draft at intents/draft/${testId}.json.` };
  const intent = readIntentFile(src) as TestIntent & { rejection?: Rejection };
  intent.rejection = { rejected_by: by, rejected_at: new Date().toISOString(), reason };
  fs.mkdirSync(PATHS.intentsRejected, { recursive: true });
  const dest = path.join(PATHS.intentsRejected, `${testId}.json`);
  fs.writeFileSync(dest, `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
  fs.rmSync(src);
  return { ok: true, to: dest };
}

export function rejectionOf(testId: string): Rejection | undefined {
  const file = path.join(PATHS.intentsRejected, `${testId}.json`);
  if (!fs.existsSync(file)) return undefined;
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { rejection?: Rejection }).rejection;
}

// --- Rework: the reviewer's change requests, fed to the next generation ---------

export interface ReworkRequest {
  test_id: string;
  request: string;
  requested_by: string;
  requested_at: string;
  status: 'open' | 'addressed';
  addressed_at?: string;
}

export function feedbackPath(feature?: string): string {
  return path.join(featurePaths(feature).requirementDir, 'review-feedback.yaml');
}

export function loadFeedback(feature?: string): ReworkRequest[] {
  const file = feedbackPath(feature);
  if (!fs.existsSync(file)) return [];
  return ((YAML.parse(fs.readFileSync(file, 'utf8')) as { requests?: ReworkRequest[] } | null)?.requests ?? []);
}

function saveFeedback(feature: string | undefined, requests: ReworkRequest[]): void {
  const file = feedbackPath(feature);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = '# Gate 2 rework requests. The next `npm run think -- --run` rewrites these test cases.\n';
  fs.writeFileSync(file, header + YAML.stringify({ requests }), 'utf8');
}

/** Record (or replace) the open rework request for a test case. */
export function requestRework(feature: string | undefined, testId: string, request: string, by: string): void {
  const all = loadFeedback(feature).filter((r) => !(r.test_id === testId && r.status === 'open'));
  all.push({ test_id: testId, request, requested_by: by, requested_at: new Date().toISOString(), status: 'open' });
  saveFeedback(feature, all);
}

export function markAddressed(feature: string | undefined, testIds: string[]): void {
  if (!testIds.length) return;
  const now = new Date().toISOString();
  const all = loadFeedback(feature).map((r) =>
    r.status === 'open' && testIds.includes(r.test_id) ? { ...r, status: 'addressed' as const, addressed_at: now } : r,
  );
  saveFeedback(feature, all);
}
