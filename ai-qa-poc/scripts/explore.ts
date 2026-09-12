/**
 * The Explorer — phase 2c. Bug-hunting that no test case describes.
 *
 *   npm run explore -- --feature login
 *   npm run explore -- --url https://example.com/signin
 *   npm run explore -- --feature ecommerce --no-probe
 *
 * Three modes, per VISION §7b:
 *
 *   sweeps      one property across every element — images, labels, duplicate
 *               names, dead links. Keeps covering elements nobody wrote a
 *               mission for next week.
 *   probe       a small fixed matrix of awkward input per field. Reports what
 *               the application did; grades nothing.
 *   build diff  what changed since the last capture. Regression detection with
 *               zero test cases.
 *
 * Everything this produces is an **observation, not a defect**. Nothing here
 * can pass or fail a test, and nothing here is a verdict. A human decides what
 * any of it means — and `npm run defects` is where the confirmed ones become
 * paste-ready reports.
 *
 * The probe runs in its own browser context, always. It mutates the page, and
 * sharing a session with a mission would break the mission and manufacture a
 * failure that looks real.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadAppContext, PATHS, rel, RUNTIME } from '../src/config.js';
import { capturePair } from '../src/captures.js';
import { diffCaptures, renderDiff } from '../src/build-diff.js';
import { probePage, renderProbe, type ProbeReport } from '../src/probe.js';
import {
  findingsFromDiff,
  findingsFromProbe,
  findingsFromSweeps,
  saveExploration,
  type ExplorationFinding,
} from '../src/exploration.js';
import {
  describeSweep,
  sweepAccessibleNames,
  sweepDeadLinks,
  sweepDuplicateNames,
  sweepFieldLabels,
  sweepImages,
  type SweepOutcome,
} from '../src/sweeps.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const featureName = flag('feature');
const explicitUrl = flag('url');

let urls: string[] = [];
if (explicitUrl) {
  urls = [explicitUrl];
} else {
  let ctx;
  try {
    ctx = loadAppContext(featureName);
  } catch {
    console.error('No application context, and no --url given. Nothing to explore.');
    process.exit(1);
  }
  const base = ctx.application.base_url;
  if (base.includes('example.com')) {
    console.error(`base_url is still the placeholder ${base}. Pass --url, or set a real one.`);
    process.exit(1);
  }
  const paths = Object.values(ctx.pages ?? {})
    .map((p) => p.path)
    .filter((p) => p && !p.includes(':'));
  urls = (paths.length ? paths : ['/']).map((p) => new URL(p, base).toString());
}

console.log(`Exploring ${urls.length} page(s) — observations only, nothing is graded.`);
console.log('');

interface PageSweeps {
  url: string;
  results: { kind: string; outcome: SweepOutcome }[];
}

const sweepResults: PageSweeps[] = [];
const probeResults: ProbeReport[] = [];

const browser = await chromium.launch({ headless: !RUNTIME.headed });

try {
  // --- Sweeps: read-only, so one context is fine ---------------------------
  const sweepContext = await browser.newContext();
  for (const url of urls) {
    const page = await sweepContext.newPage();
    process.stdout.write(`  sweeping ${url} ... `);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const body = page.locator('body');
      const results = [
        { kind: 'images load', outcome: await sweepImages(body) },
        { kind: 'controls named', outcome: await sweepAccessibleNames(body) },
        { kind: 'fields labelled', outcome: await sweepFieldLabels(body) },
        { kind: 'names unique', outcome: await sweepDuplicateNames(body) },
        { kind: 'links answer', outcome: await sweepDeadLinks(page, body) },
      ];
      sweepResults.push({ url, results });
      const offenders = results.reduce((n, r) => n + r.outcome.offenders.length, 0);
      console.log(offenders ? `${offenders} thing(s) to look at` : 'clean');
    } catch (err) {
      console.log(`failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
    await page.close();
  }
  await sweepContext.close();

  // --- Probe: its own context, because it mutates the page -----------------
  if (!has('no-probe')) {
    console.log('');
    const probeContext = await browser.newContext();
    for (const url of urls) {
      const page = await probeContext.newPage();
      process.stdout.write(`  probing  ${url} ... `);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const report = await probePage(page);
        probeResults.push(report);
        console.log(
          `${report.inputs.length} field(s), ${report.observations.length} observation(s)` +
            (report.skipped.length ? `, ${report.skipped.length} skipped` : ''),
        );
      } catch (err) {
        console.log(`failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      }
      await page.close();
    }
    await probeContext.close();
  }
} finally {
  await browser.close();
}

// --- Build diff: no browser needed, it compares kept captures --------------

const { current, previous } = capturePair(featureName);
const diff = current && previous ? diffCaptures(previous, current) : undefined;

// --- Report -----------------------------------------------------------------

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
const lines: string[] = [];

lines.push(`# Exploration — ${featureName ?? 'default'}`);
lines.push('');
lines.push(`Build \`${RUNTIME.build}\`, ${new Date().toISOString()}`);
lines.push('');
lines.push(
  '> **Observations, not defects.** Nothing in this report has been graded, and none',
  '> of it changes any test result. It is what a tester would notice while walking',
  '> the page — the judgement is still a human\'s.',
  '',
);

let offenderTotal = 0;
lines.push('## Sweeps', '');
if (sweepResults.length === 0) {
  lines.push('_Nothing could be swept._', '');
}
for (const page of sweepResults) {
  lines.push(`### ${page.url}`, '');
  for (const { kind, outcome } of page.results) {
    offenderTotal += outcome.offenders.length;
    const head = `**${kind}** — ${outcome.checked} checked, ${outcome.offenders.length} to look at`;
    lines.push(outcome.unverified.length ? `${head}, ${outcome.unverified.length} unverified` : head);
    for (const o of outcome.offenders) lines.push(`  * ${o.what} — ${o.detail}`);
    for (const u of outcome.unverified) lines.push(`  * _(unverified)_ ${u.what} — ${u.detail}`);
    lines.push('');
  }
}

const probeSection = renderProbe(probeResults);
if (probeSection) lines.push(probeSection, '');

if (diff) {
  lines.push(renderDiff(diff).replace(/^# Build diff/, '## Build diff'), '');
} else {
  lines.push(
    '## Build diff',
    '',
    'Only one capture exists for this feature, so there is nothing to compare against yet.',
    'Run `npm run inspect` again after the next build and this section fills in.',
    '',
  );
}

fs.mkdirSync(PATHS.reports, { recursive: true });
const outFile = path.join(PATHS.reports, `exploration-${featureName ?? 'default'}-${stamp}.md`);
fs.writeFileSync(outFile, `${lines.join('\n')}\n`, 'utf8');

/**
 * The machine-readable half.
 *
 * Without this the markdown above was the only output, so every sweep offender
 * and every probe note died in a file nobody could act on — which made the
 * whole point of §7b (finding bugs no test case describes) stop at "and then
 * somebody reads it". The defect pipeline picks these up with
 * `npm run defects -- --from-exploration`.
 */
const findings: ExplorationFinding[] = [
  ...sweepResults.flatMap((p) => findingsFromSweeps(p.url, p.results)),
  ...probeResults.flatMap(findingsFromProbe),
  ...(diff ? findingsFromDiff(diff.changes) : []),
];

const findingsFile = saveExploration({
  feature: featureName ?? 'default',
  build: RUNTIME.build,
  generated_at: new Date().toISOString(),
  findings,
});

console.log('');
console.log(`Exploration report: ${rel(outFile)}`);
console.log('');
console.log(`  Sweep findings   ${offenderTotal}`);
console.log(`  Probe notes      ${probeResults.reduce((n, r) => n + r.observations.length, 0)}`);
console.log(`  Build changes    ${diff ? diff.changes.length : 'no baseline yet'}`);
console.log(`  Actionable       ${findings.length} (in ${rel(findingsFile)})`);
console.log('');
console.log('None of this is a defect until a human says so. Write the actionable ones up:');
console.log('  npm run defects -- --from-exploration');
console.log('  npm run defects -- --list');
