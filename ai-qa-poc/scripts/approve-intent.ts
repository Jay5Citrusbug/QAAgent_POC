/**
 * Gate 1 — human approval of a test intent.
 *
 *   npm run approve-intent -- LG-004 --by "jay.r" --minutes 3 --edited
 *
 * Moves intents/draft/LG-004.json to intents/approved/LG-004.json and stamps
 * the approval. Same mechanism as mission approval: a file move plus a git
 * commit, no tooling to build, a real audit trail.
 *
 * What this gate does that the mission gate cannot: it refuses an intent whose
 * expected behaviour rests on a question nobody has answered. VISION's first
 * hard rule for the Thinking Agent — never invent expected behaviour, report
 * the gap — was previously enforced by nothing at all. An intent asserting an
 * invented rule does not merely fail to help; it produces a confident false
 * defect, and a false defect costs more human QA time than reporting nothing.
 *
 * --minutes is not bureaucracy. The entire argument for splitting intent from
 * mission is that reviewing business intent should cost LESS than reviewing
 * locator descriptors. If this number is not smaller than the mission review
 * time in docs/BASELINE.md, the split is not paying for itself and should go.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, rel } from '../src/config.js';
import { hashAnswer, loadLedger, resolveDependencies } from '../src/clarifications.js';
import { approvalBlockers, lintIntent, readIntentFile, validateIntent } from '../src/intents.js';
import { hashFile, localeFilePath } from '../src/requirement-hash.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const testId = process.argv[2];
if (!testId || testId.startsWith('--')) {
  console.error('Usage: npm run approve-intent -- <TEST_ID> --by "<name>" [--minutes <n>] [--edited]');
  process.exit(1);
}

const by = arg('by');
if (!by) {
  console.error('Refusing to approve anonymously. Pass --by "<your name>".');
  process.exit(1);
}

const src = path.join(PATHS.intentsDraft, `${testId}.json`);
if (!fs.existsSync(src)) {
  console.error(`No draft intent at intents/draft/${testId}.json`);
  process.exit(1);
}

const intent = readIntentFile(src);

const { valid, errors } = validateIntent(intent);
if (!valid) {
  console.error(`${testId} does not match the intent schema, so it cannot be approved:`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

const ledger = loadLedger(intent.feature);

// --- The hard gate ----------------------------------------------------------

const blockers = approvalBlockers(intent, ledger);
if (blockers.length > 0) {
  console.error(`${testId} depends on ${blockers.length} unresolved clarification(s):`);
  console.error('');
  for (const b of blockers) console.error(`  ✗ ${b}`);
  console.error('');
  console.error('This intent asserts behaviour nobody has stated yet. Approving it would turn');
  console.error('a guess into something the system later reports as a product defect.');
  console.error('');
  console.error('Answer it:');
  console.error(`  npm run clarify -- --feature ${intent.feature} --answer <Q-n> --text "..." --by "${by}"`);
  console.error('');
  console.error('Or, if waiting is not an option, record the assumption explicitly:');
  console.error(`  npm run clarify -- --feature ${intent.feature} --answer <Q-n> --text "..." --by "${by}" --assumed`);
  process.exit(1);
}

// --- Warnings — judgement calls, shown but not blocking ---------------------

const warnings = lintIntent(intent, ledger);
if (warnings.length > 0) {
  console.warn(`Approving ${testId} with ${warnings.length} warning(s):`);
  for (const w of warnings) console.warn(`  ! ${w}`);
  console.warn('');
}

// --- Stamp ------------------------------------------------------------------

// Pin the requirement as it reads today, so a later edit to it is detectable.
if (intent.requirement_ref) {
  const file = localeFilePath(intent.requirement_ref.locator);
  if (file) {
    intent.requirement_ref.content_hash = hashFile(file);
    console.log(`Requirement pinned at ${intent.requirement_ref.content_hash}`);
  } else {
    console.warn(
      `! requirement_ref points at "${intent.requirement_ref.locator}", which is not a local file — ` +
        'a later change to it cannot be detected automatically.',
    );
  }
} else {
  console.warn('! No requirement_ref — results from this intent will not trace back to a requirement.');
}

// Pin each answer this intent rests on, for the same reason. A requirement can
// change; so can the answer that filled one of its gaps, and that answer is
// just as load-bearing.
const deps = resolveDependencies(intent.depends_on_clarifications, ledger);
const clarificationHashes: Record<string, string> = {};
let restsOnAssumption = false;

for (const d of deps) {
  if (d.state === 'missing' || d.state === 'open') continue; // already refused above
  const hash = hashAnswer(d.question);
  if (hash) clarificationHashes[d.id] = hash;
  if (d.state === 'assumed') restsOnAssumption = true;
}

if (Object.keys(clarificationHashes).length > 0) {
  console.log(`Clarifications pinned: ${Object.keys(clarificationHashes).join(', ')}`);
}

if (restsOnAssumption) {
  intent.assumption = true;
  console.warn('');
  console.warn('! This intent rests on an ASSUMED answer, not a confirmed one.');
  console.warn('  assumption: true is stamped on it and rides into the run report — a FAIL here');
  console.warn('  may mean the assumption was wrong rather than the product.');
}

intent.approval = {
  approved_by: by,
  approved_at: new Date().toISOString(),
  edits_made: process.argv.includes('--edited'),
  ...(arg('minutes') ? { review_minutes: Number(arg('minutes')) } : {}),
  ...(Object.keys(clarificationHashes).length ? { clarification_hashes: clarificationHashes } : {}),
};

fs.mkdirSync(PATHS.intentsApproved, { recursive: true });
const dest = path.join(PATHS.intentsApproved, `${testId}.json`);
fs.writeFileSync(dest, `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
fs.rmSync(src);

console.log('');
console.log(`Approved intent ${testId} — ${by} at ${intent.approval.approved_at}`);
console.log(`  ${rel(src)} → ${rel(dest)}`);
console.log('');
console.log('Commit the move so the approval is part of the audit trail:');
console.log(`  git add intents && git commit -m "QA: approve intent ${testId}"`);
console.log('');
console.log('This intent is now waiting on a front-end URL. When the build lands, the');
console.log('Execution Agent binds it to the real page in one pass before any mission');
console.log('runs, and a human reviews only the bindings it could not settle cleanly.');
