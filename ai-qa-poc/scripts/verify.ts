/**
 * Verify the test cases before anything executes them.
 *
 *   npm run verify -- --feature ecommerce              # mode chosen automatically
 *   npm run verify -- --feature ecommerce --offline    # requirement checks only
 *   npm run verify -- --feature ecommerce --no-network # live checks, no HTTP calls
 *
 * Test cases are written before the front-end exists, so no one could look at
 * a page when writing them. This is where they are checked:
 *
 *   pre-build  (no real URL yet)  against the requirement — cited sentences
 *              exist, every requirement section is covered, nothing rests on an
 *              open question or on an answer edited after approval.
 *   live       (URL configured)   all of the above, plus against the running
 *              app — environment up, capture current, every approved intent
 *              bound and approved, no intent edited since binding, starting
 *              pages load, roles signed in.
 *
 * Writes reports/VERIFICATION-<feature>.md and verification-<feature>.json.
 * `npm run run-mission` runs the same checks itself and holds back anything
 * that fails them, so this command is for seeing the answer before a run.
 *
 * Exit code is 1 when anything is held back.
 */
import { rel } from '../src/config.js';
import { verify, writeVerification } from '../src/verify.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : undefined;
}

const feature = arg('feature');
const report = await verify({
  feature,
  offline: process.argv.includes('--offline'),
  noNetwork: process.argv.includes('--no-network'),
});
const { md } = writeVerification(report);

const blocks = report.issues.filter((i) => i.severity === 'block');
const warns = report.issues.filter((i) => i.severity === 'warn');

console.log('');
console.log(`Verification — ${report.feature}  (${report.mode})`);
console.log('');
if (report.mode === 'pre-build') {
  console.log('  No front-end URL yet: test cases checked against the requirement only.');
} else {
  console.log(`  Base URL          ${report.base_url}`);
}
console.log(`  Intents checked   ${report.intents_checked}`);
if (report.mode === 'live') {
  console.log(`  Missions checked  ${report.missions_checked}`);
  console.log(`  Cleared to run    ${report.ready.length}`);
}
console.log(`  Held back         ${report.held.length}`);
console.log(`  Blocking issues   ${blocks.length}`);
console.log(`  Warnings          ${warns.length}`);
console.log('');

for (const i of blocks.slice(0, 25)) {
  console.log(`  ✗ ${i.test_id ?? '(feature)'}  ${i.check}: ${i.message}`);
  if (i.fix) console.log(`      → ${i.fix}`);
}
if (blocks.length > 25) console.log(`  ... ${blocks.length - 25} more in the report`);
if (blocks.length) console.log('');

const uncovered = report.traceability.filter((t) => t.intents.length === 0);
if (uncovered.length) {
  console.log(`  ${uncovered.length} requirement section(s) no test case cites:`);
  for (const t of uncovered) console.log(`    - ${t.section}`);
  console.log('');
}

console.log(`Report: ${rel(md)}`);
console.log('');

if (report.mode === 'pre-build' && blocks.length === 0) {
  console.log('Test cases are consistent with the requirement. When a URL exists:');
  console.log(`  1. set base_url in knowledge/application-context-${report.feature}.yaml (or BASE_URL)`);
  console.log(`  2. npm run inspect -- --feature ${report.feature}`);
  console.log(`  3. npm run bind -- --feature ${report.feature} --write`);
  console.log(`  4. npm run verify -- --feature ${report.feature}      (live checks)`);
  console.log('');
}

// exitCode rather than exit(): lets pending sockets close cleanly first.
process.exitCode = blocks.length ? 1 : 0;
