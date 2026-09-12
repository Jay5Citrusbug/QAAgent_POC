/**
 * Validate and lint intents and missions.
 *
 *   npm run validate                 # every intent and mission, draft and approved
 *   npm run validate -- SM-001       # one of them by id
 *
 * Schema errors are fatal. Lint warnings are not — they are the things a human
 * should see at a gate before approving.
 *
 * [R3] Intents are checked first because they come first: an intent resting on
 * an unanswered question is reported here as a blocker, so it surfaces while
 * the analysis is still fresh rather than at the moment someone tries to
 * approve it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/config.js';
import { isApproved, lintMission, readMissionFile, validateMission } from '../src/validate.js';
import { loadLedger } from '../src/clarifications.js';
import {
  approvalBlockers,
  isApproved as isIntentApproved,
  lintIntent,
  listIntents,
  readIntentFile,
  validateIntent,
} from '../src/intents.js';
import type { TestIntent, TestMission } from '../src/types.js';

function collect(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dir, f));
}

const filter = process.argv[2];
const byId = (f: string) => !filter || path.basename(f, '.json') === filter;

const intentFiles = [...listIntents(PATHS.intentsDraft), ...listIntents(PATHS.intentsApproved)].filter(byId);
const files = [...collect(PATHS.missionsDraft), ...collect(PATHS.missionsApproved)].filter(byId);

if (files.length === 0 && intentFiles.length === 0) {
  console.error(filter ? `No intent or mission named ${filter}.` : 'No intents or missions found.');
  process.exit(1);
}

let failures = 0;
let warnings = 0;
let blocked = 0;

// --- Intents (Gate 1) -------------------------------------------------------

/** One ledger per feature, loaded once — a feature's intents all share it. */
const ledgers = new Map<string, ReturnType<typeof loadLedger>>();
function ledgerFor(feature: string) {
  if (!ledgers.has(feature)) ledgers.set(feature, loadLedger(feature));
  return ledgers.get(feature)!;
}

for (const file of intentFiles) {
  const where = path.relative(PATHS.root, file).split(path.sep).join('/');
  let intent: TestIntent;
  try {
    intent = readIntentFile(file);
  } catch (err) {
    console.error(`✗ ${where}: not valid JSON — ${String(err)}`);
    failures += 1;
    continue;
  }

  const { valid, errors } = validateIntent(intent);
  if (!valid) {
    console.error(`✗ ${where}`);
    for (const e of errors) console.error(`    ${e}`);
    failures += 1;
    continue;
  }

  const approved = isIntentApproved(intent);
  const inApprovedDir = file.startsWith(PATHS.intentsApproved);
  const ledger = ledgerFor(intent.feature);
  const blockers = approvalBlockers(intent, ledger);

  const tag = approved ? '[approved]' : blockers.length ? '[blocked]' : '[draft]';
  console.log(`✓ ${where}  ${tag}${intent.assumption ? '  (rests on an assumption)' : ''}`);

  if (inApprovedDir && !approved) {
    console.error('    ✗ in approved/ but has no approval block — the binding phase will refuse it.');
    failures += 1;
  }

  for (const b of blockers) {
    // Not a schema failure: an intent SHOULD exist while its question is open.
    // That is the honest order — the question and the intent arrive together.
    console.warn(`    ⧗ ${b}`);
    blocked += 1;
  }

  for (const w of lintIntent(intent, ledger)) {
    console.warn(`    ! ${w}`);
    warnings += 1;
  }
}

if (intentFiles.length > 0 && files.length > 0) console.log('');

// --- Missions (Gate 1.5, reviewed by exception) ----------------------------------------------------

for (const file of files) {
  const where = path.relative(PATHS.root, file).split(path.sep).join('/');
  let mission: TestMission;
  try {
    mission = readMissionFile(file);
  } catch (err) {
    console.error(`✗ ${where}: not valid JSON — ${String(err)}`);
    failures += 1;
    continue;
  }

  const { valid, errors } = validateMission(mission);
  if (!valid) {
    console.error(`✗ ${where}`);
    for (const e of errors) console.error(`    ${e}`);
    failures += 1;
    continue;
  }

  const lint = lintMission(mission);
  const approved = isApproved(mission);
  const inApprovedDir = file.startsWith(PATHS.missionsApproved);

  console.log(`✓ ${where}${approved ? '  [approved]' : '  [draft]'}`);

  if (inApprovedDir && !approved) {
    console.error('    ✗ in approved/ but has no approval block — the executor will refuse it.');
    failures += 1;
  }

  for (const w of lint) {
    console.warn(`    ! ${w}`);
    warnings += 1;
  }
}

console.log('');
console.log(
  `${intentFiles.length} intent(s), ${files.length} mission(s), ${failures} invalid, ` +
    `${blocked} blocked on clarifications, ${warnings} warning(s).`,
);
if (warnings > 0 && failures === 0) {
  console.log('Warnings are for the human at a gate to judge — they do not block execution.');
}
if (blocked > 0) {
  console.log('Blocked intents cannot pass Gate 1 until the questions are answered:');
  console.log('  npm run clarify -- --open');
}
process.exit(failures > 0 ? 1 : 0);
