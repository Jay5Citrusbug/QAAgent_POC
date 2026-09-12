/**
 * Run approved missions.
 *
 *   npm run run-mission                            # every approved mission
 *   npm run run-mission -- SM-001                  # one mission
 *   npm run run-mission -- --feature ecommerce     # against a second app's context
 *   HEADED=false npm run run-mission               # headless
 *
 * Only missions in missions/approved/ with a populated approval block run. A
 * draft never executes, however valid it looks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { applyClassification } from '../src/classify.js';
import { loadAppContext, PATHS, rel, RUNTIME } from '../src/config.js';
import { runMission } from '../src/executor.js';
import { writeReport } from '../src/report.js';
import { checkRequirementDrift, describeDrift } from '../src/requirement-hash.js';
import { isApproved, readMissionFile, validateMission, validateResult } from '../src/validate.js';
import type { ExecutionResult } from '../src/types.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const featureName = flag('feature');
// The positional test id is the first bare argument — skip flag values so
// `--feature ecommerce` is not mistaken for a mission id.
const positional = process.argv.slice(2).filter((a, i, arr) => {
  if (a.startsWith('--')) return false;
  const prev = arr[i - 1];
  return !(prev && prev.startsWith('--'));
});
const filter = positional[0];

const files = fs.existsSync(PATHS.missionsApproved)
  ? fs
      .readdirSync(PATHS.missionsApproved)
      .filter((f) => f.endsWith('.json'))
      .filter((f) => !filter || path.basename(f, '.json') === filter)
      .map((f) => path.join(PATHS.missionsApproved, f))
      .sort()
  : [];

if (files.length === 0) {
  console.error(
    filter
      ? `No approved mission named ${filter}. Approve it first:  npm run approve -- ${filter} --by "<name>"`
      : 'No approved missions. Draft missions do not run — that is the point of Gate 1.',
  );
  process.exit(1);
}

const ctx = loadAppContext(featureName);
console.log(`Application : ${ctx.application.name}${featureName ? `  (--feature ${featureName})` : ''}`);
console.log(`Environment : ${ctx.application.environment}`);
console.log(`Base URL    : ${ctx.application.base_url}`);
console.log(`Browser     : ${RUNTIME.browser} (${RUNTIME.headed ? 'headed' : 'headless'})`);
console.log(`Missions    : ${files.length}`);
console.log('');

if (ctx.application.base_url.includes('example.com')) {
  console.warn(
    'Base URL is still the placeholder stage.example.com. Set BASE_URL in .env before a real run.\n',
  );
}

const results: ExecutionResult[] = [];

for (const file of files) {
  const mission = readMissionFile(file);

  const { valid, errors } = validateMission(mission);
  if (!valid) {
    console.error(`Skipping ${path.basename(file)} — does not match the mission schema:`);
    for (const e of errors) console.error(`  ${e}`);
    continue;
  }

  if (!isApproved(mission)) {
    // Belt and braces: the directory is the gate, but a mission could be
    // dropped in by hand.
    console.error(`Skipping ${mission.test_id} — no approval block. Unapproved work does not run.`);
    continue;
  }

  // Has the requirement moved under an approved mission? Not fatal — some edits
  // are typo fixes, some invalidate the mission entirely, and only a person can
  // tell which. So it is surfaced loudly and recorded on the result.
  const drift = checkRequirementDrift(mission);
  const driftNote = describeDrift(drift);
  if (drift.state === 'drifted') {
    console.warn(`! ${mission.test_id}: ${driftNote}`);
    console.warn('');
  }

  const raw = await runMission(mission, { feature: featureName });
  const result = applyClassification(raw, mission);
  if (driftNote) result.notes.push(driftNote);
  results.push(result);

  const check = validateResult(result);
  if (!check.valid) {
    console.error(`Result for ${mission.test_id} does not match the result schema:`);
    for (const e of check.errors) console.error(`  ${e}`);
  }

  // The result lands next to its own evidence, so a run directory is
  // self-contained for review.
  const dir = path.join(PATHS.runs, mission.test_id, result.run_id ?? 'unknown');
  fs.mkdirSync(dir, { recursive: true });
  const resultFile = path.join(dir, 'result.json');
  fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(`${result.test_id}: ${result.status}${result.failure_classification ? ` (${result.failure_classification}, confidence ${result.confidence})` : ''}`);
  console.log(`  result: ${rel(resultFile)}`);
  console.log('');
}

if (results.length > 0) {
  const report = writeReport(results);
  console.log(`Report: ${rel(report)}`);
  console.log('');
  console.log('Nothing here is a confirmed defect. Gate 2 is a human reading that report.');
}

// Exit code reflects whether a human needs to look, not whether the product is
// broken — BLOCKED and INCONCLUSIVE both need attention.
process.exit(results.some((r) => r.status !== 'PASS') ? 1 : 0);
