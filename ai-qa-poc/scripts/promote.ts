/**
 * Phase 8 — turn a mission that has proved itself into a permanent Playwright test.
 *
 *   npm run promote                                     # what is eligible, and what is not
 *   npm run promote -- --promote EC-001 --by "jay.r"    # generate the spec
 *   npm run promote -- --promote EC-001 --by "jay.r" --dry-run
 *   npm run promote -- --min-passes 3                   # stricter bar
 *
 * Then run the generated suite with `npm run regression` — no model, no
 * discovery, milliseconds instead of seconds.
 *
 * VISION §9: AI reasoning earns its cost on a feature that is new or changing.
 * On a stable critical workflow it is waste. This is the step that moves a flow
 * across, and §10a is why it is cheap rather than a re-authoring exercise: the
 * replayable trace already knows which locators actually resolved.
 *
 * A name is required, because "this flow is stable" is a judgement about the
 * product roadmap and this has no access to that. Passing twice means it passed
 * twice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, rel } from '../src/config.js';
import { assess, generateSpec, runsFor, specPath } from '../src/promote.js';
import { readMissionFile } from '../src/validate.js';
import type { TestMission } from '../src/types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const minPasses = Number(arg('min-passes') ?? 2);

function approvedMissions(): TestMission[] {
  if (!fs.existsSync(PATHS.missionsApproved)) return [];
  return fs
    .readdirSync(PATHS.missionsApproved)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readMissionFile(path.join(PATHS.missionsApproved, f)));
}

const missions = approvedMissions();
if (missions.length === 0) {
  console.error('No approved missions. Nothing can be promoted.');
  process.exit(1);
}

const assessed = missions.map((m) => assess(m, minPasses));

// --- Promote ----------------------------------------------------------------

const target = arg('promote');
if (target) {
  const by = arg('by');
  if (!by) {
    console.error('Refusing to promote anonymously. Pass --by "<your name>".');
    console.error('');
    console.error('Freezing a flow is a judgement about whether it is stable or merely');
    console.error('untouched this week, and only a person knows which.');
    process.exit(1);
  }

  const candidate = assessed.find((a) => a.test_id === target);
  if (!candidate) {
    console.error(`No approved mission ${target}.`);
    process.exit(1);
  }

  if (!candidate.eligible && !has('force')) {
    console.error(`${target} is not eligible: ${candidate.reason}.`);
    console.error('');
    console.error('A generated spec freezes whatever the mission did on the run it came from.');
    console.error('Freezing an unstable one bakes in the flakiness and calls it a regression test.');
    console.error('Pass --force only if you know why this is an exception.');
    process.exit(1);
  }

  const runs = runsFor(target);
  const source = [...runs].reverse().find((r) => r.status === 'PASS');
  if (!source) {
    console.error(`${target} has no passing run to generate from.`);
    process.exit(1);
  }

  const spec = generateSpec(candidate.mission, source, by);
  const dest = specPath(target);

  if (has('dry-run')) {
    console.log(`Would write ${rel(dest)}:`);
    console.log('');
    console.log(spec);
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const existed = fs.existsSync(dest);
  fs.writeFileSync(dest, spec, 'utf8');

  console.log(`${existed ? 'Regenerated' : 'Promoted'} ${target} → ${rel(dest)}`);
  console.log('');
  console.log(`  from run     ${source.run_id ?? 'unknown'}`);
  console.log(`  assertions   ${candidate.mission.assertions.length}`);
  console.log(`  trace steps  ${source.replayable_trace?.steps?.length ?? 0}`);
  console.log('');
  console.log('The mission stays where it is. It carries the requirement link and the');
  console.log('approval record, and it is what tells you, when this spec later breaks,');
  console.log('whether the product regressed or the page simply moved.');
  console.log('');
  console.log('Run it:  npm run regression');
  process.exit(0);
}

// --- List -------------------------------------------------------------------

const eligible = assessed.filter((a) => a.eligible);
const not = assessed.filter((a) => !a.eligible);

console.log(`Promotion bar: every recorded run passed, and at least ${minPasses} of them.`);
console.log('');

if (eligible.length) {
  console.log('Eligible:');
  for (const a of eligible) {
    const promoted = fs.existsSync(specPath(a.test_id)) ? '  [already generated]' : '';
    console.log(`  ${a.test_id.padEnd(8)} ${a.reason}${promoted}`);
    console.log(`           ${a.mission.test_objective}`);
  }
  console.log('');
  console.log(`  npm run promote -- --promote ${eligible[0]?.test_id} --by "<your name>"`);
} else {
  console.log('Nothing is eligible yet.');
}

if (not.length) {
  console.log('');
  console.log('Not eligible:');
  for (const a of not) console.log(`  ${a.test_id.padEnd(8)} ${a.reason}`);
}

console.log('');
console.log('Promoting is not a tidy-up. A mission still under active development should');
console.log('stay a mission — the AI path is what handles a page that is still changing,');
console.log('and a generated spec breaks on every change by design.');
