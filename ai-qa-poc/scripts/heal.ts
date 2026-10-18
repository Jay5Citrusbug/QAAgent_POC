/**
 * Phase 5 — propose (and, on your say-so, apply) test case updates.
 *
 *   npm run heal -- --feature login                                   # propose
 *   npm run heal -- --feature login --apply H-1 H-3 --by "jay.r"      # apply locator updates
 *   npm run heal -- --feature login --apply H-4 --by "jay.r" --confirmed-with "PO: Priya"
 *   npm run heal -- --feature login --apply all-locators --by "jay.r"
 *
 * Reads the latest run of every test in the feature. Proposes:
 *   - locator updates where a step only worked through fuzzy/synonym/AI matching
 *   - expectation updates where the page's text differs (needs the requirement
 *     owner; refused when the requirement itself states the expected text)
 *   - regenerate / re-read instructions for tests that went stale
 *
 * Writes reports/HEALING-<feature>.md. Applying re-stamps the approval with
 * your name and records the change on the mission's change_log.
 */
import fs from 'node:fs';
import { applyProposals, buildProposals, healingJsonPath, writeHealing, type HealingReport } from '../src/healing.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : undefined;
}
function args(name: string): string[] {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return [];
  const out: string[] = [];
  for (let j = i + 1; j < process.argv.length && !process.argv[j]!.startsWith('--'); j += 1) out.push(process.argv[j]!);
  return out;
}

const feature = arg('feature');
const toApply = args('apply');

if (toApply.length) {
  const by = arg('by');
  if (!by) {
    console.error('Applying a change is an approval — say who is approving it: --by "<your name>"');
    process.exit(1);
  }
  const file = healingJsonPath(feature);
  if (!fs.existsSync(file)) {
    console.error(`No healing report yet. Run: npm run heal -- --feature ${feature ?? '<feature>'}`);
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(file, 'utf8')) as HealingReport;
  const ids = toApply.includes('all-locators')
    ? report.proposals.filter((p) => p.kind === 'locator' && p.applicable).map((p) => p.id)
    : toApply;
  const confirmedWith = arg('confirmed-with');
  const outcomes = applyProposals(report, ids, { by, ...(confirmedWith ? { confirmedWith } : {}) });
  for (const o of outcomes) console.log(`${o.ok ? '✓' : '✗'} ${o.id}  ${o.message}`);
  const applied = outcomes.filter((o) => o.ok).length;
  console.log('');
  console.log(`${applied} applied, ${outcomes.length - applied} not.`);
  if (applied) {
    console.log('Re-run to confirm the updated tests now match exactly:');
    console.log(`  npm run run-mission -- --feature ${feature ?? '<feature>'}`);
  }
  process.exitCode = outcomes.some((o) => !o.ok) ? 1 : 0;
} else {
  const report = await buildProposals(feature);
  const md = writeHealing(report);
  const by = (k: string) => report.proposals.filter((p) => p.kind === k).length;
  console.log('');
  console.log(`Test case updates — ${report.feature}`);
  console.log(`  locator      ${by('locator')}   where a test looks for an element`);
  console.log(`  expectation  ${by('expectation')}   what a test expects to see — needs the requirement owner`);
  console.log(`  rebind       ${by('rebind')}   generated from an intent that changed since`);
  console.log(`  reapprove    ${by('reapprove')}   requirement changed under an approved test`);
  console.log('');
  for (const p of report.proposals.slice(0, 20)) console.log(`  ${p.id.padEnd(5)} ${p.test_id}  ${p.summary}`);
  if (report.proposals.length > 20) console.log(`  ... ${report.proposals.length - 20} more`);
  console.log('');
  console.log(`Report: ${md}   (proposals only — nothing changed)`);
  if (report.proposals.some((p) => p.applicable)) {
    console.log(`Apply: npm run heal -- --feature ${report.feature} --apply <H-n ...> --by "<you>"`);
  }
}
