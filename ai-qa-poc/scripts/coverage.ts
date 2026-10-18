/**
 * Coverage report against the QA checklist.
 *
 *   npm run coverage                  # every mission
 *   npm run coverage -- --prefix EC   # one feature's missions
 *
 * Shows which checklist areas a mission set touches and, more importantly,
 * which it does not. A feature whose missions never mention security looks
 * exactly like one where security was considered and ruled out — this makes
 * that difference visible before a release decision depends on it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/config.js';
import { buildCoverage, loadExclusions, renderCoverage } from '../src/coverage.js';
import { readMissionFile } from '../src/validate.js';
import { listIntents, readIntentFile } from '../src/intents.js';
import type { TestIntent, TestMission } from '../src/types.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const prefix = flag('prefix')?.toUpperCase();
/** Exclusions are per feature, so --check needs to know which one. */
const featureName = flag('feature');

function collect(dir: string): TestMission[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !prefix || f.toUpperCase().startsWith(`${prefix}-`))
    .map((f) => readMissionFile(path.join(dir, f)));
}

const missions = [...collect(PATHS.missionsDraft), ...collect(PATHS.missionsApproved)];

/**
 * [R4] Approved intents count too — as planned coverage, in their own column.
 *
 * Before this, a feature could have ten approved intents and score zero, which
 * made the gap list say "nothing covers security" when in fact somebody had
 * designed exactly that and it was waiting on a build. Both errors matter, and
 * they are different errors: one is nobody thought of it, the other is nobody
 * has run it yet.
 */
/**
 * [R5] Drafts count too, when asked for.
 *
 * Approved-only is right for "what does this feature actually cover" — a draft
 * has proven nothing. It is exactly wrong while the intents are being written,
 * which is the moment a missing category is cheap to fix. `--drafts` includes
 * them so the author can audit their own set before asking anyone to review it.
 */
const includeDrafts = process.argv.includes('--drafts') || process.argv.includes('--check');

const intents: TestIntent[] = [
  ...listIntents(PATHS.intentsApproved),
  ...(includeDrafts ? listIntents(PATHS.intentsDraft) : []),
]
  .map(readIntentFile)
  .filter((i) => !prefix || i.test_id.toUpperCase().startsWith(`${prefix}-`));

if (missions.length === 0 && intents.length === 0) {
  console.error(prefix ? `No missions or intents with prefix ${prefix}-.` : 'No missions or intents found.');
  process.exit(1);
}

const report = buildCoverage(missions, intents);

console.log('');
if (prefix) console.log(`Feature prefix: ${prefix}-`);
if (includeDrafts) console.log('Including draft intents (--drafts).');
console.log(renderCoverage(report));
console.log('');

/**
 * `--check` — the gate.
 *
 * A reminder in a document is a rule that quietly stops happening. This fails
 * with a non-zero exit when a category the executor CAN run has nothing
 * covering it, so "did you check coverage?" stops being a question anyone has
 * to remember to ask.
 *
 * Deliberately narrow: it only fails on categories that are automatable and
 * empty. A category that genuinely does not apply is not something a tool can
 * judge — that verdict belongs in the analysis, in a human's words, and
 * `gapsManualOnly` is reported rather than failed for the same reason.
 */
if (process.argv.includes('--check')) {
  const minimumCases = 25;
  const byRequirement = new Map<string, number>();
  for (const mission of missions) {
    const locator = mission.requirement_ref?.locator ?? '(unlinked requirement)';
    const feature = /^input\/feature-([^/]+)\//.exec(locator)?.[1] ?? locator;
    byRequirement.set(feature, (byRequirement.get(feature) ?? 0) + 1);
  }
  const shallow = [...byRequirement.entries()].filter(([, count]) => count < minimumCases);
  if (shallow.length > 0) {
    console.error(`✗ Test-case depth gate: every requirement needs at least ${minimumCases} meaningful missions.`);
    for (const [requirement, count] of shallow) console.error(`  - ${requirement}: ${count} mission(s)`);
    console.error('  Add distinct positive, negative, boundary, state, navigation, exploratory, or manual cases.');
    process.exit(1);
  }

  /**
   * A category is settled when it is either covered, or explicitly excluded
   * with a written reason. Anything else is silence, and silence is the thing
   * this gate exists to catch.
   */
  const excluded = loadExclusions(featureName);
  const excludedLabels = new Set(excluded.map((e) => e.category.toLowerCase()));
  const unaddressed = report.gapsAutomatable.filter(
    (g) => !excludedLabels.has(g.key.toLowerCase()) && !excludedLabels.has(g.label.toLowerCase()),
  );

  if (excluded.length > 0) {
    console.log('Recorded as not applicable to this feature:');
    for (const e of excluded) console.log(`  - ${e.category}: ${e.reason}`);
    console.log('');
  }

  if (unaddressed.length === 0) {
    console.log('✓ Every automatable category has at least one intent or mission.');
    if (report.gapsManualOnly.length > 0) {
      console.log('');
      console.log('Still needing a human (reported, not failed):');
      for (const g of report.gapsManualOnly) console.log(`  - ${g.label}: ${g.limit ?? ''}`);
    }
    process.exit(0);
  }

  console.error(`✗ ${unaddressed.length} automatable category(s) have nothing covering them:`);
  console.error('');
  for (const g of unaddressed) console.error(`  - ${g.label}`);
  console.error('');
  console.error('Each one needs a verdict, not silence — either an intent whose PRIMARY');
  console.error('coverage.category is that category, or an explicit "does not apply,');
  console.error('because ..." in section 4 of the analysis. A category listed only as a');
  console.error('secondary_categories entry does not count: the report counts primaries.');
  process.exit(1);
}
