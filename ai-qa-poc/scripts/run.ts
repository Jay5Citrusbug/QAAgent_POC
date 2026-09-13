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
import { closeBrowserSession, runMission } from '../src/executor.js';
import { writeReport } from '../src/report.js';
import { writeFinalReport } from '../src/final-report.js';
import { fromExecution, fromFinding, listDefects, upsert, writeReport as writeDefectReport } from '../src/defect.js';
import { checkRequirementDrift, describeDrift } from '../src/requirement-hash.js';
import { isApproved, readMissionFile, validateMission, validateResult } from '../src/validate.js';
import { analysisKey, analyzeExecution } from '../src/execution-ai.js';
import type { ExecutionResult } from '../src/types.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const featureName = flag('feature');

/**
 * Boolean flags take no value. Without this list the token after `--headless`
 * gets swallowed as its value, so `--headless EC-001` silently runs every
 * mission instead of the one asked for.
 */
const BOOLEAN_FLAGS = new Set(['headless', 'headed', 'copy', 'stdout']);

const positional = process.argv.slice(2).filter((a, i, arr) => {
  if (a.startsWith('--')) return false;
  const prev = arr[i - 1];
  if (!prev || !prev.startsWith('--')) return true;
  // Previous token was a flag: this is its value only if that flag takes one.
  return BOOLEAN_FLAGS.has(prev.slice(2));
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
const aiByFinding = new Map<string, NonNullable<ExecutionResult['ai_analysis']>>();

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
  const aiKey = process.env.EXECUTION_AI === 'true' ? analysisKey(result) : undefined;
  if (aiKey) {
    const existing = aiByFinding.get(aiKey);
    const analysis = existing ?? (await analyzeExecution(mission, result));
    aiByFinding.set(aiKey, analysis);
    result.ai_analysis = analysis;
    if (analysis.status === 'failed') result.notes.push(`Execution AI unavailable: ${analysis.error}`);
    const aiFile = path.join(PATHS.root, 'runs', mission.test_id, result.run_id ?? 'unknown', 'ai-analysis.json');
    fs.writeFileSync(aiFile, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
    result.evidence = [...new Set([...result.evidence, rel(aiFile)])];
  }
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

/**
 * The suite is over, so let the shared browser go.
 *
 * Missions hand their page to the next mission rather than closing it, which is
 * what makes a run fast and what lets a cart survive from one step to the next.
 * Nothing else ever closes it, so this is the one place Chromium is shut down.
 */
await closeBrowserSession();

if (results.length > 0) {
  const report = writeReport(results);
  console.log(`Report: ${rel(report)}`);

  /**
   * [R5] The execution report is written every run, unasked.
   *
   * The summary above covers the missions that ran. It cannot tell you the
   * thing that matters most after a run — whether what ran is what was
   * approved. After the first real run it was 3 of 29, and every artifact
   * reported cheerfully on the 3. A report nobody has to remember to ask for
   * is the only kind that keeps getting written, so this is not a flag.
   */
  const defectsBuilt = buildDefects(results);
  const finalReport = writeFinalReport({ feature: featureName, results });

  console.log(`Execution report: ${finalReport}`);
  console.log('');
  if (defectsBuilt.created + defectsBuilt.merged > 0) {
    console.log(
      `  ${defectsBuilt.created} new defect report(s), ${defectsBuilt.merged} repeat(s) merged into existing ones.`,
    );
  }
  console.log('  It leads with what did NOT run, then results, then every defect in full');
  console.log('  bug format with reproduction steps and evidence paths.');
  console.log('');
  console.log('Nothing here is a confirmed defect. Gate 2 is a human reading that report.');
}

// Exit code reflects whether a human needs to look, not whether the product is
// broken — BLOCKED and INCONCLUSIVE both need attention.
process.exit(results.some((r) => r.status !== 'PASS') ? 1 : 0);


/**
 * Turn this run's failures into defect reports as part of the run itself.
 *
 * Previously `npm run defects` was a separate command, so a run could finish
 * with real failures and produce no ticket until somebody remembered. The
 * fingerprinting still deduplicates, so re-running a known failure updates its
 * existing report rather than raising another.
 */
function buildDefects(all: ExecutionResult[]): { created: number; merged: number } {
  let created = 0;
  let merged = 0;
  for (const result of all) {
    const file = files.find((f) => path.basename(f, '.json') === result.test_id);
    if (!file) continue;
    const candidate = fromExecution(readMissionFile(file), result, ctx.application.base_url);
    if (candidate) {
      const { isNew } = upsert(candidate);
      if (isNew) created += 1;
      else merged += 1;
    }
    for (const finding of result.incidental_findings ?? []) {
      const findingCandidate = fromFinding(finding, {
        url: finding.url ?? ctx.application.base_url,
        build: result.build,
        run_id: result.run_id,
        feature: result.feature,
        ai_analysis: result.ai_analysis,
        session: result.session,
      });
      const { isNew } = upsert(findingCandidate);
      if (isNew) created += 1;
      else merged += 1;
    }
  }
  for (const d of listDefects()) writeDefectReport(d);
  return { created, merged };
}
