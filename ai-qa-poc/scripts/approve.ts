/**
 * Gate 2 — human approval of a drafted mission.
 *
 *   npm run approve -- SM-001 --by "jay.r" --minutes 4 --edited
 *
 * Moves missions/draft/SM-001.json to missions/approved/SM-001.json and stamps
 * the approval block. That is the whole approval system: a file move plus a git
 * commit. No tooling to build, and a real audit trail.
 *
 * --minutes and --edited are not bureaucracy. They are the mission edit rate,
 * which is the number most likely to quietly kill this approach: missions that
 * cost twenty minutes of review each are a net loss even when execution is
 * free. See docs/BASELINE.md.
 *
 * This script will not approve a mission that fails schema validation, and it
 * deliberately has no --yes-approve-everything mode. If approving feels like a
 * formality, the gate is not doing its job.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/config.js';
import { hashRequirement } from '../src/requirement-hash.js';
import { lintMission, readMissionFile, validateMission } from '../src/validate.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const testId = process.argv[2];
if (!testId || testId.startsWith('--')) {
  console.error('Usage: npm run approve -- <TEST_ID> --by "<name>" [--minutes <n>] [--edited]');
  process.exit(1);
}

const by = arg('by');
if (!by) {
  console.error('Refusing to approve anonymously. Pass --by "<your name>".');
  process.exit(1);
}

const src = path.join(PATHS.missionsDraft, `${testId}.json`);
if (!fs.existsSync(src)) {
  console.error(`No draft mission at missions/draft/${testId}.json`);
  process.exit(1);
}

const mission = readMissionFile(src);

const { valid, errors } = validateMission(mission);
if (!valid) {
  console.error(`${testId} does not match the mission schema, so it cannot be approved:`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

/**
 * Gate 2.5 — [R4] the binding review, by exception.
 *
 * A mission produced by phase 2a carries the list of things the binder could
 * not settle: a control it could not find, two it could not choose between, an
 * expected message nobody ever wrote down. Approving without reading those is
 * how a mission ends up asserting something nobody chose — and this codebase
 * has already been bitten twice by tests that passed against the bug they were
 * written to catch.
 *
 * Deliberately NOT a gate on every binding. A clean binding needs no human, and
 * a gate that rubber-stamps manufactures the appearance of review, which is
 * worse than no gate at all. So: exceptions block, everything else flows.
 */
const exceptions = mission.binding?.exceptions ?? [];
if (exceptions.length > 0 && !process.argv.includes('--reviewed')) {
  console.error(`${testId} was bound with ${exceptions.length} unresolved exception(s):`);
  console.error('');
  for (const e of exceptions) {
    console.error(`  ✗ ${e.where} (${e.kind}) — ${e.summary}`);
  }
  console.error('');
  console.error('The reconciliation report lists what the page actually offers for each of');
  console.error('these, so you are choosing from a list rather than guessing:');
  console.error('  reports/reconciliation-*.md');
  console.error('');
  console.error('Edit the mission to settle them, then approve with --reviewed to confirm');
  console.error('you read them:');
  console.error(`  npm run approve -- ${testId} --by "${by}" --reviewed`);
  process.exit(1);
}

if (exceptions.length > 0) {
  console.warn(`${testId}: ${exceptions.length} binding exception(s), accepted as reviewed by ${by}:`);
  for (const e of exceptions) console.warn(`  ~ ${e.where} (${e.kind}) — ${e.summary}`);
  console.warn('');
}

if (mission.binding?.rests_on_assumption) {
  console.warn('! This mission came from an intent resting on an ASSUMED clarification.');
  console.warn('  A FAIL here may mean the assumption was wrong rather than the product.');
  console.warn('');
}

const warnings = lintMission(mission);
if (warnings.length > 0) {
  console.warn(`Approving ${testId} with ${warnings.length} warning(s):`);
  for (const w of warnings) console.warn(`  ! ${w}`);
  console.warn('');
}

// Stamp the requirement as it reads today. If it is edited later and the
// mission is not, the run can say so — otherwise a mission silently stops
// testing what it claims while its approval stamp still looks valid.
if (mission.requirement_ref) {
  const hash = hashRequirement(mission);
  if (hash) {
    mission.requirement_ref.content_hash = hash;
    console.log(`Requirement pinned at ${hash}`);
  } else {
    console.warn(
      `! requirement_ref points at "${mission.requirement_ref.locator}", which is not a local file — ` +
        'a later change to it cannot be detected automatically.',
    );
  }
} else {
  console.warn('! No requirement_ref — results from this mission will not trace back to a requirement.');
}

// Stamp who settled each binding exception, so the record shows a person
// decided rather than a tool defaulting.
if (mission.binding?.exceptions?.length) {
  mission.binding.exceptions = mission.binding.exceptions.map((e) => ({
    ...e,
    resolved_by: by,
    resolution: e.resolution ?? 'Reviewed and accepted at Gate 2.5.',
  }));
}

mission.approval = {
  approved_by: by,
  approved_at: new Date().toISOString(),
  ...(process.argv.includes('--edited') ? { edits_made: true } : { edits_made: false }),
  ...(arg('minutes') ? { review_minutes: Number(arg('minutes')) } : {}),
};

fs.mkdirSync(PATHS.missionsApproved, { recursive: true });
const dest = path.join(PATHS.missionsApproved, `${testId}.json`);
fs.writeFileSync(dest, `${JSON.stringify(mission, null, 2)}\n`, 'utf8');
fs.rmSync(src);

console.log(`Approved ${testId} — ${by} at ${mission.approval.approved_at}`);
console.log(`  missions/draft/${testId}.json → missions/approved/${testId}.json`);
console.log('');
console.log('Commit the move so the approval is part of the audit trail:');
console.log(`  git add missions && git commit -m "QA: approve ${testId}"`);
