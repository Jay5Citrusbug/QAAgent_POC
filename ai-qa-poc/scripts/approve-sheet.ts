/**
 * Gate 2 — apply the decisions a reviewer wrote into the test case sheet.
 *
 *   npm run approve-sheet -- --feature login --by "jay.r" --minutes 40 --dry-run
 *   npm run approve-sheet -- --feature login --by "jay.r" --minutes 40
 *
 * In reports/TEST-CASES-<feature>.csv, fill the "Gate 2 Decision" column per row:
 *
 *   Approve   the case is right as written
 *   Reject    the case should not exist — say why in QA Comment
 *   Rework    the case needs changing — say what in QA Comment (or edit the
 *             cells directly; the edits are sent along as the request)
 *
 * Blank rows are left waiting. There is no "approve all": every row needs its
 * own decision, which is the difference between a reviewed sheet and a bulk
 * approve flag.
 *
 * Every approval goes through the same checks as `npm run approve-intent`.
 * One more is added here: if the test case text in the sheet differs from the
 * test case file, the row is NOT approved as-is — that would sign off text
 * that is not what will run. It becomes a rework request carrying the edits.
 * Rework requests are picked up by the next `npm run test-case-agent -- --feature <name>`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, rel } from '../src/config.js';
import { analysisGate } from '../src/analysis-gate.js';
import { approveIntent, feedbackPath, rejectIntent, requestRework } from '../src/intent-approval.js';
import { readIntentFile } from '../src/intents.js';
import { buildSheets, CONTENT_COLUMNS, contentCells, readSheet, sheetPath } from '../src/test-case-sheet.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const feature = arg('feature');
const by = arg('by');
const dryRun = has('dry-run');
if (!feature) {
  console.error('Usage: npm run approve-sheet -- --feature <name> --by "<your name>" [--minutes <n>] [--dry-run]');
  process.exit(1);
}
if (!by) {
  console.error('Refusing to record decisions anonymously. Pass --by "<your name>".');
  process.exit(1);
}

const sheet = readSheet(feature);
if (!sheet) {
  console.error(`No sheet at ${rel(sheetPath(feature))}. Build it: npm run test-cases -- --feature ${feature}`);
  process.exit(1);
}
if (sheet.rows.length && !('Gate 2 Decision' in sheet.rows[0]!)) {
  console.error('The sheet has no "Gate 2 Decision" column — it predates this command. Rebuild it first:');
  console.error(`  npm run test-cases -- --feature ${feature}`);
  process.exit(1);
}

type Decision = 'approve' | 'reject' | 'rework';
function decisionOf(raw: string): Decision | 'unknown' | undefined {
  const v = raw.trim().toLowerCase();
  if (!v) return undefined;
  if (/^(approve|approved|ok|yes|y)$/.test(v)) return 'approve';
  if (/^(reject|rejected|no|n|drop)$/.test(v)) return 'reject';
  if (/^(rework|change|changes|edit|fix)$/.test(v)) return 'rework';
  return 'unknown';
}

const tidy = (s: string): string => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).join('\n').trim();

const gate1 = analysisGate(feature);
if (gate1.state !== 'approved') {
  console.warn(`! Gate 1 (analysis) for ${feature} is ${gate1.state.toUpperCase()}${gate1.reasons.length ? `: ${gate1.reasons.join(' ')}` : ''}`);
  console.warn('  Test cases are being reviewed against an analysis nobody has signed off as current.');
  console.warn('');
}

const decided = sheet.rows
  .map((row) => ({ row, id: row['Test Case ID'] ?? '', decision: decisionOf(row['Gate 2 Decision'] ?? '') }))
  .filter((r) => r.id && r.decision);
const waiting = sheet.rows.filter((r) => !decisionOf(r['Gate 2 Decision'] ?? '') && r['QA Status'] === 'Draft - awaiting approval');

const minutes = arg('minutes');
const share = minutes !== undefined && decided.length ? Math.round((Number(minutes) / decided.length) * 10) / 10 : undefined;

const approved: string[] = [];
const rejected: string[] = [];
const reworked: string[] = [];
const approvedWithEdits: string[] = [];
const refused: { id: string; reasons: string[] }[] = [];

for (const { row, id, decision } of decided) {
  const draft = path.join(PATHS.intentsDraft, `${id}.json`);
  if (decision === 'unknown') {
    refused.push({ id, reasons: [`"${row['Gate 2 Decision']}" is not a decision. Use Approve, Reject or Rework.`] });
    continue;
  }
  if (!fs.existsSync(draft)) {
    refused.push({ id, reasons: ['Not a draft any more (already approved or rejected) — nothing to decide.'] });
    continue;
  }

  const intent = readIntentFile(draft);
  const expected = contentCells(intent);
  const edited = CONTENT_COLUMNS.filter((c) => tidy(row[c] ?? '') !== tidy(expected[c]));
  const comment = (row['QA Comment'] ?? '').replace(/^Manual: .*$/m, '').trim();

  // "Approve" on a row whose test case text was edited means "approve it with
  // these changes". Approving as-is would sign off text that will not run, and
  // refusing would lose the edits when the sheet is rebuilt — so it becomes a
  // rework request carrying them, and comes back for approval once rewritten.
  if (decision === 'approve' && edited.length) {
    const request = [comment, ...edited.map((c) => `${c} should read:\n${tidy(row[c] ?? '')}`)].filter(Boolean).join('\n\n');
    if (!dryRun) requestRework(feature, id, request, by);
    reworked.push(id);
    approvedWithEdits.push(id);
    continue;
  }

  if (decision === 'approve') {
    const outcome = approveIntent(id, by, { ...(share !== undefined ? { minutes: share } : {}), checkOnly: dryRun });
    if (outcome.ok) approved.push(id);
    else refused.push({ id, reasons: [...outcome.reasons, ...(outcome.hint ? [outcome.hint] : [])] });
    continue;
  }

  if (decision === 'reject') {
    if (!comment) {
      refused.push({ id, reasons: ['Reject needs a reason in QA Comment — the next generation reads it so it does not propose this case again.'] });
      continue;
    }
    if (!dryRun) {
      const r = rejectIntent(id, by, comment);
      if (!r.ok) {
        refused.push({ id, reasons: [r.reason] });
        continue;
      }
    }
    rejected.push(id);
    continue;
  }

  // Rework: what the reviewer asked for, plus any cells they rewrote directly.
  const changes = edited.map((c) => `${c} should read:\n${tidy(row[c] ?? '')}`);
  const request = [comment, ...changes].filter(Boolean).join('\n\n');
  if (!request) {
    refused.push({ id, reasons: ['Rework needs a change: describe it in QA Comment, or edit the cells in the sheet.'] });
    continue;
  }
  if (!dryRun) requestRework(feature, id, request, by);
  reworked.push(id);
}

console.log(`${dryRun ? 'DRY RUN — nothing changed. ' : ''}Gate 2 decisions from ${rel(sheet.file)}`);
console.log('');
console.log(`  approved   ${approved.length}${approved.length ? `  (${approved.join(', ')})` : ''}`);
console.log(`  rejected   ${rejected.length}${rejected.length ? `  (${rejected.join(', ')})` : ''}`);
console.log(`  rework     ${reworked.length}${reworked.length ? `  (${reworked.join(', ')})` : ''}`);
if (approvedWithEdits.length) {
  console.log(`             ${approvedWithEdits.join(', ')}: marked Approve but the text was edited, so sent as rework with the edits`);
}
console.log(`  refused    ${refused.length}`);
console.log(`  waiting    ${waiting.length} draft(s) with no decision yet`);
for (const r of refused) {
  console.log('');
  console.log(`  ✗ ${r.id}`);
  for (const reason of r.reasons) console.log(`      ${reason}`);
}

if (dryRun) process.exit(refused.length ? 1 : 0);

const [summary] = buildSheets(feature);
console.log('');
if (summary) console.log(`Sheet rebuilt: ${rel(summary.file)} — ${summary.approved} approved, ${summary.draft} draft, ${summary.rejected} rejected`);
if (share !== undefined) console.log(`Review time recorded: ${share} min per decided case (${minutes} min total).`);
if (reworked.length) {
  console.log('');
  console.log(`Rework requests saved to ${rel(feedbackPath(feature))}. Regenerate those cases:`);
  console.log(`  npm run test-case-agent -- --feature ${feature}`);
}
if (approved.length) {
  console.log('');
  console.log('Approved cases wait for a front-end URL: inspect → bind → verify → run-mission.');
}
process.exit(refused.length ? 1 : 0);
