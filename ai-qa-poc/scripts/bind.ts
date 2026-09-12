/**
 * Phase 2a — bind approved intents to the build that actually shipped.
 *
 *   npm run bind -- --feature login
 *   npm run bind -- --feature login --write       # also write missions/draft/
 *
 * Reads every approved intent for the feature plus the most recent page
 * capture, and produces two things:
 *
 *   1. draft missions, for the intents that bound cleanly enough
 *   2. a reconciliation report — the three-column answer a QA Lead produces by
 *      hand on first receipt of a build, which takes them about an hour
 *
 * Dry by default. `--write` is the flag that touches missions/draft/, because
 * overwriting somebody's edited draft mission silently is the kind of thing you
 * only forgive a tool once.
 *
 * Run `npm run inspect` first — this binds against a capture, not a live page,
 * so that the binding is reproducible and so the reconciliation can be re-read
 * later against the exact page it was made from.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadAppContext, PATHS, rel } from '../src/config.js';
import { latestCapture } from '../src/captures.js';
import { bindIntent, findUncovered, type BindOutcome } from '../src/binder.js';
import { listIntents, readIntentFile, isApproved } from '../src/intents.js';
import { validateMission } from '../src/validate.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const featureName = flag('feature');

const capture = latestCapture(featureName);
if (!capture) {
  console.error(`No page capture for ${featureName ?? 'the default feature'}.`);
  console.error('');
  console.error('Binding needs to see the page. Capture it first:');
  console.error(`  npm run inspect -- --feature ${featureName ?? '<feature>'}`);
  console.error('');
  console.error('This is the whole point of the intent/mission split: until a front end');
  console.error('exists there is nothing to bind to, and a mission written now would have');
  console.error('an invented target in every step.');
  process.exit(1);
}

let ctx;
try {
  ctx = loadAppContext(featureName);
} catch {
  console.error('No application context — cannot resolve roles or modules.');
  process.exit(1);
}

const intents = listIntents(PATHS.intentsApproved)
  .map(readIntentFile)
  .filter((i) => (featureName ? i.feature === featureName : true))
  .filter((i) => {
    if (isApproved(i)) return true;
    console.warn(`! ${i.test_id} is in intents/approved/ without an approval block — skipping.`);
    return false;
  });

if (intents.length === 0) {
  console.error(`No approved intents for ${featureName ?? 'the default feature'}.`);
  console.error('  npm run approve-intent -- <TEST_ID> --by "<your name>"');
  process.exit(1);
}

console.log(`Binding ${intents.length} intent(s) against build ${capture.build} (${capture.captured_at})`);
console.log(`Pages: ${capture.pages.map((p) => p.url).join(', ')}`);
console.log('');

const outcomes: BindOutcome[] = intents.map((i) => bindIntent(i, capture, ctx));
const uncovered = findUncovered(intents, capture);

const clean = outcomes.filter((o) => o.mission && o.exceptions.length === 0);
const needsReview = outcomes.filter((o) => o.mission && o.exceptions.length > 0);
const unbindable = outcomes.filter((o) => !o.mission);

// --- Write the drafts -------------------------------------------------------

let written = 0;
let skipped = 0;

if (has('write')) {
  fs.mkdirSync(PATHS.missionsDraft, { recursive: true });
  for (const o of [...clean, ...needsReview]) {
    const mission = o.mission!;
    const dest = path.join(PATHS.missionsDraft, `${mission.test_id}.json`);
    const approvedAlready = path.join(PATHS.missionsApproved, `${mission.test_id}.json`);

    if (fs.existsSync(approvedAlready)) {
      console.warn(`! ${mission.test_id} is already approved — not overwriting. Re-approve deliberately if the page changed.`);
      skipped += 1;
      continue;
    }
    if (fs.existsSync(dest) && !has('force')) {
      console.warn(`! missions/draft/${mission.test_id}.json exists — left alone. Pass --force to replace it.`);
      skipped += 1;
      continue;
    }

    const { valid, errors } = validateMission(mission);
    if (!valid) {
      // A binder producing a schema-invalid mission is a bug in the binder, not
      // something to write out and let a human puzzle over.
      console.error(`✗ ${mission.test_id}: the binder produced an invalid mission — not written.`);
      for (const e of errors) console.error(`    ${e}`);
      skipped += 1;
      continue;
    }

    fs.writeFileSync(dest, `${JSON.stringify(mission, null, 2)}\n`, 'utf8');
    written += 1;
  }
}

// --- Reconciliation report --------------------------------------------------

const lines: string[] = [];
lines.push(`# Reconciliation — ${featureName ?? 'default'}`);
lines.push('');
lines.push(`Build \`${capture.build}\`, captured ${capture.captured_at}`);
lines.push(`${intents.length} approved intent(s) against ${capture.pages.length} page(s).`);
lines.push('');
lines.push(
  '| | Count |',
  '|---|---|',
  `| Bound cleanly | ${clean.length} |`,
  `| Bound, needs review | ${needsReview.length} |`,
  `| Could not bind | ${unbindable.length} |`,
  `| Controls no intent covers | ${uncovered.length} |`,
  '',
);

if (clean.length) {
  lines.push('## Bound cleanly', '', 'Ready to execute. Nothing here needs a human.', '');
  for (const o of clean) lines.push(`* **${o.intent.test_id}** — ${o.intent.test_objective}`);
  lines.push('');
}

if (needsReview.length) {
  lines.push('## Bound, but needs review', '');
  lines.push(
    'A mission exists for each of these, but the binder had to leave something open.',
    'These are the only bindings Gate 1.5 looks at — reviewing the clean ones too',
    'would be a rubber stamp.',
    '',
  );
  for (const o of needsReview) {
    lines.push(`### ${o.intent.test_id} — ${o.intent.test_objective}`);
    lines.push('');
    lines.push(`Confidence: **${o.confidence}**${o.intent.assumption ? ' · rests on an assumed clarification' : ''}`);
    lines.push('');
    for (const e of o.exceptions) {
      lines.push(`* **${e.where}** (${e.kind}) — ${e.summary}`);
      if (e.candidates?.length) {
        lines.push(`  * on the page: ${e.candidates.map((c) => `\`${c}\``).join(', ')}`);
      }
      if (e.asks) lines.push(`  * **${e.asks}**`);
    }
    lines.push('');
  }
}

if (unbindable.length) {
  lines.push('## Could not bind', '');
  lines.push(
    'No mission was produced for these. That is a finding in itself, and it arrived',
    'before a single browser run was paid for.',
    '',
  );
  for (const o of unbindable) {
    lines.push(`### ${o.intent.test_id} — ${o.intent.test_objective}`);
    lines.push('');
    for (const e of o.exceptions) {
      lines.push(`* **${e.where}** (${e.kind}) — ${e.summary}`);
      if (e.candidates?.length) lines.push(`  * on the page: ${e.candidates.map((c) => `\`${c}\``).join(', ')}`);
      if (e.asks) lines.push(`  * **${e.asks}**`);
    }
    lines.push('');
  }
}

lines.push('## Controls no intent covers', '');
if (uncovered.length === 0) {
  lines.push('Every interactive control on the captured pages is mentioned by some intent.', '');
} else {
  lines.push(
    'Nobody wrote a case for these. Not necessarily a problem — but nobody has decided',
    'that yet, and that decision is the point of this list.',
    '',
  );
  const byUrl = new Map<string, string[]>();
  for (const u of uncovered) {
    byUrl.set(u.url, [...(byUrl.get(u.url) ?? []), `${u.control.role} "${u.control.name}"`]);
  }
  for (const [url, controls] of byUrl) {
    lines.push(`**${url}**`, '');
    for (const c of controls) lines.push(`* ${c}`);
    lines.push('');
  }
}

fs.mkdirSync(PATHS.reports, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
const reportFile = path.join(PATHS.reports, `reconciliation-${featureName ?? 'default'}-${stamp}.md`);
fs.writeFileSync(reportFile, `${lines.join('\n')}\n`, 'utf8');

// --- Console summary --------------------------------------------------------

console.log(`  bound cleanly        ${clean.length}`);
console.log(`  bound, needs review  ${needsReview.length}`);
console.log(`  could not bind       ${unbindable.length}`);
console.log(`  uncovered controls   ${uncovered.length}`);
console.log('');
console.log(`Reconciliation: ${rel(reportFile)}`);

/**
 * The same reconciliation as data.
 *
 * The markdown is for a human at Gate 1.5. The binding exception rate is one
 * of the numbers that decides whether Gate 1.5 earns its place at all (§15),
 * and a number that only exists inside prose cannot be trended across six
 * requirements.
 */
const reconciliation = {
  feature: featureName ?? 'default',
  generated_at: new Date().toISOString(),
  bound_against: { build: capture.build, captured_at: capture.captured_at },
  intents_total: intents.length,
  clean: clean.map((o) => o.intent.test_id),
  needs_review: needsReview.map((o) => ({
    test_id: o.intent.test_id,
    confidence: o.confidence,
    exceptions: o.exceptions.map((e) => ({ kind: e.kind, where: e.where })),
  })),
  unbindable: unbindable.map((o) => ({
    test_id: o.intent.test_id,
    exceptions: o.exceptions.map((e) => ({ kind: e.kind, where: e.where })),
  })),
  uncovered_controls: uncovered.map((u) => ({ url: u.url, role: u.control.role, name: u.control.name })),
};

const reconDir = path.join(PATHS.reports, 'reconciliation');
fs.mkdirSync(reconDir, { recursive: true });
fs.writeFileSync(
  path.join(reconDir, `${featureName ?? 'default'}-${stamp}.json`),
  `${JSON.stringify(reconciliation, null, 2)}
`,
  'utf8',
);

if (has('write')) {
  console.log(`Missions written: ${written}${skipped ? `, ${skipped} skipped` : ''} → missions/draft/`);
} else {
  console.log('');
  console.log('Nothing was written. Re-run with --write to create the draft missions.');
}

if (needsReview.length || unbindable.length) {
  console.log('');
  console.log('Gate 1.5 reviews the exceptions only:');
  console.log(`  npm run approve -- <TEST_ID> --by "<your name>" --reviewed`);
  console.log('');
  console.log('Read the reconciliation first — it lists what the page actually offers for');
  console.log('each thing the binder could not settle, so you are choosing, not guessing.');
}
