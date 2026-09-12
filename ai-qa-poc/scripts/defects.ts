/**
 * Turn run artifacts into defect reports a developer can act on.
 *
 *   npm run defects                              # build from every run on disk
 *   npm run defects -- --test SM-004             # just one test's runs
 *   npm run defects -- --from-exploration        # sweeps, probe and build regressions
 *   npm run defects -- --list                    # what is already on file
 *   npm run defects -- --show <fingerprint>      # print one, ready to paste
 *   npm run defects -- --confirm <fp> --by "jay.r" --ticket QA-123
 *   npm run defects -- --reject  <fp> --by "jay.r" --note "environment, not the product"
 *
 * POC-1 deliberately does not talk to a tracker (VISION §13b). What it does is
 * remove the ten minutes of writing-up per defect that gets skipped when the
 * sprint is tight — which is how real bugs end up as a line in a report nobody
 * actions. Each report is complete enough to paste in and assign.
 *
 * Nothing is filed automatically and nothing is confirmed by a machine. Gate 2
 * is a person.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadAppContext, PATHS, rel } from '../src/config.js';
import { fromExecution, fromFinding, listDefects, renderDefect, upsert, writeReport, type DefectCandidate } from '../src/defect.js';
import { listExplorations } from '../src/exploration.js';
import { readMissionFile } from '../src/validate.js';
import type { ExecutionResult, TestMission } from '../src/types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

// --- Read-only modes --------------------------------------------------------

if (has('list')) {
  const all = listDefects();
  if (all.length === 0) {
    console.log('No defect reports yet. Run some missions, then: npm run defects');
    process.exit(0);
  }
  console.log(`${all.length} defect report(s) in ${rel(PATHS.defects)}`);
  console.log('');
  for (const d of all) {
    const mark = d.status === 'confirmed' ? '●' : d.status === 'rejected' ? '·' : '○';
    const seen = d.occurrences > 1 ? ` ×${d.occurrences}` : '';
    const ticket = d.human_review?.ticket ? ` [${String(d.human_review.ticket)}]` : '';
    console.log(`${mark} ${d.fingerprint}  ${d.severity.padEnd(8)} ${d.status.padEnd(9)}${seen}${ticket}`);
    console.log(`    ${d.title}`);
  }
  console.log('');
  console.log('● confirmed   ○ candidate, waiting on Gate 2   · rejected');
  console.log('');
  console.log('  npm run defects -- --show <fingerprint>      the paste-ready report');
  console.log('  npm run defects -- --confirm <fingerprint> --by "<name>" --ticket <KEY>');
  process.exit(0);
}

if (has('show')) {
  const fp = arg('show');
  const file = path.join(PATHS.defects, `${fp}.json`);
  if (!fp || !fs.existsSync(file)) {
    console.error(`No defect ${fp}. List them with: npm run defects -- --list`);
    process.exit(1);
  }
  console.log(renderDefect(JSON.parse(fs.readFileSync(file, 'utf8')) as DefectCandidate));
  process.exit(0);
}

// --- Gate 2 decisions -------------------------------------------------------

for (const decision of ['confirm', 'reject'] as const) {
  if (!has(decision)) continue;

  const fp = arg(decision);
  const by = arg('by');
  const file = path.join(PATHS.defects, `${fp}.json`);

  if (!fp || !fs.existsSync(file)) {
    console.error(`No defect ${fp}. List them with: npm run defects -- --list`);
    process.exit(1);
  }
  if (!by) {
    console.error(`Refusing to ${decision} anonymously. Pass --by "<your name>".`);
    process.exit(1);
  }

  const d = JSON.parse(fs.readFileSync(file, 'utf8')) as DefectCandidate;
  d.status = decision === 'confirm' ? 'confirmed' : 'rejected';
  d.human_review = {
    reviewed_by: by,
    reviewed_at: new Date().toISOString(),
    decision: decision === 'confirm' ? 'Confirmed as a product defect.' : 'Not a product defect.',
    ...(arg('note') ? { note: arg('note') } : {}),
    ...(arg('ticket') ? { ticket: arg('ticket') } : {}),
    // Gate 2 minutes matter as much as Gate 1's. A run producing four
    // INCONCLUSIVE results and forty minutes of investigation has cost more
    // than doing it by hand, and nothing else records that.
    ...(arg('minutes') ? { review_minutes: Number(arg('minutes')) } : {}),
  };

  fs.writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`, 'utf8');
  const md = writeReport(d);

  console.log(`${fp} → ${d.status} by ${by}`);
  if (decision === 'confirm') {
    console.log('');
    console.log(`Paste-ready report: ${md}`);
    if (!arg('ticket')) {
      console.log('');
      console.log('Once it is raised, record the key so the next run can link to it:');
      console.log(`  npm run defects -- --confirm ${fp} --by "${by}" --ticket <KEY>`);
    }
  } else {
    console.log('');
    console.log('Kept, not deleted. A defect the team decided was not a defect is information');
    console.log('the next run needs, or it gets re-raised forever.');
  }
  process.exit(0);
}

// --- Build from exploration -------------------------------------------------

/**
 * Findings from `npm run explore` — sweeps, the input probe, build regressions.
 *
 * These are the bugs no test case describes, which is the only reason §7b
 * exists. They deduplicate against findings noticed during missions by the same
 * fingerprint, so the same broken image seen both ways is one report.
 */
if (has('from-exploration')) {
  const reports = listExplorations(arg('feature'));
  if (reports.length === 0) {
    console.error('No exploration reports found. Run one first:');
    console.error('  npm run explore -- --feature <feature>');
    process.exit(1);
  }

  let made = 0;
  let repeated = 0;

  for (const report of reports) {
    for (const finding of report.findings) {
      const { isNew } = upsert(
        fromFinding(finding, { url: finding.url, build: report.build, feature: report.feature }),
      );
      isNew ? (made += 1) : (repeated += 1);
    }
  }

  for (const d of listDefects()) writeReport(d);

  const waiting = listDefects().filter((d) => d.status === 'candidate');
  console.log(`Read ${reports.length} exploration report(s).`);
  console.log('');
  console.log(`  new defect reports  ${made}`);
  console.log(`  repeats merged      ${repeated}`);
  console.log('');
  console.log(`${waiting.length} report(s) awaiting Gate 2 in ${rel(PATHS.defects)}`);
  console.log('');
  console.log('These came from exploration, so no requirement states what should have');
  console.log('happened. Whether each is a defect is a product judgement, not a test result.');
  process.exit(0);
}

// --- Build from runs --------------------------------------------------------

const onlyTest = arg('test');

let baseUrl: string | undefined;
try {
  baseUrl = loadAppContext(arg('feature')).application.base_url;
} catch {
  // No context is fine — the trace usually carries a real URL anyway.
}

function loadMission(testId: string): TestMission | undefined {
  for (const dir of [PATHS.missionsApproved, PATHS.missionsDraft]) {
    const file = path.join(dir, `${testId}.json`);
    if (fs.existsSync(file)) return readMissionFile(file);
  }
  return undefined;
}

if (!fs.existsSync(PATHS.runs)) {
  console.error('No runs/ directory — nothing to build defects from.');
  console.error('  npm run run-mission -- <TEST_ID>');
  process.exit(1);
}

const testDirs = fs
  .readdirSync(PATHS.runs)
  .filter((d) => fs.statSync(path.join(PATHS.runs, d)).isDirectory())
  .filter((d) => !onlyTest || d === onlyTest);

let created = 0;
let merged = 0;
let fromFindings = 0;
let passed = 0;

for (const testId of testDirs) {
  const mission = loadMission(testId);
  const testRunsDir = path.join(PATHS.runs, testId);

  const runs = fs
    .readdirSync(testRunsDir)
    .filter((d) => fs.existsSync(path.join(testRunsDir, d, 'result.json')))
    // A replay is the same run seen twice; it would double every occurrence
    // count for no new information.
    .filter((d) => !d.endsWith('-replay'))
    .sort();

  for (const run of runs) {
    const result = JSON.parse(
      fs.readFileSync(path.join(testRunsDir, run, 'result.json'), 'utf8'),
    ) as ExecutionResult;

    if (mission) {
      const candidate = fromExecution(mission, result, baseUrl);
      if (!candidate) {
        passed += 1;
      } else {
        const { isNew } = upsert(candidate);
        isNew ? (created += 1) : (merged += 1);
      }
    } else if (result.status !== 'PASS') {
      console.warn(`! ${testId}: no mission file found, so its failures cannot be written up properly.`);
    }

    // Findings never belonged to the mission's verdict, and they do not belong
    // to its defect either — they get their own reports.
    for (const finding of result.incidental_findings ?? []) {
      const candidate = fromFinding(finding, {
        url: result.replayable_trace?.steps?.find((s) => s.url)?.url ?? baseUrl,
        build: result.build,
        run_id: result.run_id,
        feature: result.feature ?? mission?.feature,
      });
      const { isNew } = upsert(candidate);
      if (isNew) fromFindings += 1;
    }
  }
}

// Re-render every report so the markdown matches the merged JSON.
for (const d of listDefects()) writeReport(d);

const all = listDefects();
const candidates = all.filter((d) => d.status === 'candidate');

console.log(`Scanned ${testDirs.length} test(s).`);
console.log('');
console.log(`  new defect reports        ${created}`);
console.log(`  repeats merged            ${merged}`);
console.log(`  from exploration findings ${fromFindings}`);
console.log(`  passing runs ignored      ${passed}`);
console.log('');
console.log(`${all.length} report(s) in ${rel(PATHS.defects)}, ${candidates.length} awaiting Gate 2.`);

if (candidates.length) {
  console.log('');
  console.log('Waiting on you:');
  for (const d of candidates.slice(0, 8)) {
    console.log(`  ${d.fingerprint}  ${d.severity.padEnd(8)} ${d.title}`);
  }
  if (candidates.length > 8) console.log(`  ... and ${candidates.length - 8} more`);
  console.log('');
  console.log(`  npm run defects -- --show ${candidates[0]?.fingerprint}`);
  console.log('');
  console.log('Nothing has been filed anywhere. Each report is written to be pasted into a');
  console.log('ticket once you agree it is real.');
}
