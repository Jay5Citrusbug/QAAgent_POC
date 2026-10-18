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
import { execFileSync } from 'node:child_process';
import { PATHS } from '../src/config.js';
import { isApproved, lintMission, readMissionFile, validateMission } from '../src/validate.js';
import { loadLedger } from '../src/clarifications.js';
import { buildCoverage, loadExclusions } from '../src/coverage.js';
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

// --- Intents (Gate 2) -------------------------------------------------------

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

// --- Missions (Gate 2.5, reviewed by exception) ----------------------------------------------------

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
  console.log('Blocked intents cannot pass Gate 2 until the questions are answered:');
  console.log('  npm run clarify -- --open');
}

/**
 * [R5] Coverage is reported here, unasked.
 *
 * It used to be a separate command someone had to remember to run, which meant
 * four empty categories sat unnoticed in a 23-intent set until they were
 * audited by hand. Surfacing it as part of the ordinary "is this okay?" command
 * is what stops it being a question anyone has to think to ask.
 *
 * Reported, not failed: `npm run coverage -- --check` is the gate. This is the
 * reminder that the gate exists and what it would currently say.
 */
if (intentFiles.length > 0 || files.length > 0) {
  const intents = intentFiles.map(readIntentFile);
  const missions = files.map(readMissionFile);
  const report = buildCoverage(missions, intents);
  const features = Array.from(new Set(intents.map((i) => i.feature).filter(Boolean)));
  const excluded = new Set(
    features.flatMap((f) => loadExclusions(f).map((e) => e.category.toLowerCase())),
  );
  const open = report.gapsAutomatable.filter(
    (g) => !excluded.has(g.key.toLowerCase()) && !excluded.has(g.label.toLowerCase()),
  );

  console.log('');
  if (open.length === 0) {
    console.log('Coverage: every automatable category is covered or recorded as not applicable.');
  } else {
    console.log(`Coverage: ${open.length} automatable category(s) have nothing covering them —`);
    console.log(`  ${open.map((g) => g.key).join(', ')}`);
    console.log('  Each needs an intent, or a reason in input/feature-*/coverage-exclusions.yaml.');
    console.log('  npm run coverage -- --check --drafts   (fails the build on exactly this)');
  }

  // Keep the human-readable catalog beside the source missions every time the
  // normal validation command runs, so reviewing JSON one file at a time is
  // never required.
  if (files.length > 0 && !filter) {
    const reportScript = path.join(PATHS.root, 'scripts', 'test-cases-report.ts');
    if (fs.existsSync(reportScript)) {
      console.log('');
      try {
        execFileSync(process.execPath, [path.join(PATHS.root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), reportScript], {
          cwd: PATHS.root,
          stdio: 'inherit',
        });
      } catch {
        console.warn('! Could not refresh the consolidated test-case catalog. Run `npm run test-cases` manually.');
      }
    }
  }
}
process.exit(failures > 0 ? 1 : 0);
