/**
 * What this run needs from a human before it can be complete.
 *
 *   npm run preflight -- --feature ecommerce
 *
 * Everything the pipeline cannot decide for itself, collected in one place and
 * phrased as a question rather than an error code. Run it before executing, so
 * the answers arrive before the work that depends on them rather than after.
 *
 * It exists because the information was already there and scattered: open
 * questions in the clarification ledger, `value_unknown` exceptions buried in a
 * reconciliation report, unseeded roles discoverable only by running and
 * failing. Nobody assembles four artifacts to find out what to type next, so in
 * practice the answers arrived late — after intents had been written against
 * guesses, or after a run had already reported BLOCKED.
 *
 * Exit code is 0 when nothing is needed and 1 when something is, so it can gate
 * a pipeline as well as inform a person.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadAppContext, PATHS, rel } from '../src/config.js';
import { loadLedger } from '../src/clarifications.js';
import { listIntents, readIntentFile } from '../src/intents.js';
import { latestCapture } from '../src/captures.js';
import type { TestIntent } from '../src/types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : undefined;
}

const featureName = arg('feature');
const label = featureName ?? 'the default feature';

interface Ask {
  heading: string;
  why: string;
  items: string[];
  how?: string;
}

const asks: Ask[] = [];

// --- 1. Environment ---------------------------------------------------------

let ctx;
try {
  ctx = loadAppContext(featureName);
} catch {
  console.error(`No application context for ${label}.`);
  console.error(`  npm run new-feature -- --name <name> --url <url> --prefix <XX>`);
  process.exit(1);
}

if (ctx.application.base_url.includes('example.com')) {
  asks.push({
    heading: 'A real environment URL',
    why: `The application context still points at the placeholder ${ctx.application.base_url}, so nothing can run.`,
    items: [`Set a real base_url in knowledge/application-context-${featureName ?? 'default'}.yaml, or BASE_URL in .env`],
  });
}

if (!latestCapture(featureName)) {
  asks.push({
    heading: 'A look at the running application',
    why: 'Missions are bound against a capture of the real page. Without one there is nothing to bind to.',
    items: ['No page capture exists yet for this feature.'],
    how: `npm run inspect -- --feature ${featureName ?? '<feature>'}`,
  });
}

// --- 2. Unanswered questions ------------------------------------------------

const ledger = loadLedger(featureName);
const open = ledger.questions.filter((q) => q.status === 'open');
if (open.length > 0) {
  asks.push({
    heading: `${open.length} unanswered question(s) about the requirement`,
    why: 'Any test resting on one of these cannot pass Gate 2 — it would be asserting a rule nobody agreed to.',
    items: open.map((q) => `${q.id} — ${q.question.replace(/\s+/g, ' ').trim()}`),
    how: `npm run clarify -- --feature ${featureName ?? '<feature>'} --answer <Q-n> --text "..." --by "<you>"`,
  });
}

const assumed = ledger.questions.filter((q) => q.status === 'assumed');
if (assumed.length > 0) {
  asks.push({
    heading: `${assumed.length} answer(s) are assumptions, not confirmations`,
    why: 'These run, but a failure may mean the assumption was wrong rather than the product. Worth confirming with whoever owns the requirement.',
    items: assumed.map((q) => `${q.id} — ${q.question.replace(/\s+/g, ' ').trim()}`),
  });
}

// --- 3. Values the requirement never states ---------------------------------

/**
 * `value_unknown` is the binder saying "this outcome needs an exact expected
 * value and the requirement does not contain one". That is a question for a
 * human, not a bug — and it is the single most common reason a test cannot run.
 */
const reconDir = path.join(PATHS.reports, 'reconciliation');
if (fs.existsSync(reconDir)) {
  const files = fs
    .readdirSync(reconDir)
    .filter((f) => f.startsWith(`${featureName ?? 'default'}-`) && f.endsWith('.json'))
    .sort();
  const last = files[files.length - 1];
  if (last) {
    const recon = JSON.parse(fs.readFileSync(path.join(reconDir, last), 'utf8')) as {
      unbindable?: { test_id: string; exceptions?: { kind: string; where: string; summary?: string }[] }[];
      needs_review?: { test_id: string; exceptions?: { kind: string; where: string; summary?: string }[] }[];
    };
    /**
     * The question, not just its address.
     *
     * This listed "EC-024 O1" and stopped, which tells a reader which line to
     * go and look up but nothing they can actually answer. The binder already
     * wrote a one-line summary naming what it could not settle, so print that:
     * the point of this command is that somebody can reply to it directly.
     */
    const needValue: string[] = [];
    for (const entry of [...(recon.unbindable ?? []), ...(recon.needs_review ?? [])]) {
      for (const e of entry.exceptions ?? []) {
        if (e.kind !== 'value_unknown') continue;
        const what = e.summary?.replace(/\s+/g, ' ').trim();
        needValue.push(what ? `${entry.test_id} ${e.where} — ${what}` : `${entry.test_id} ${e.where}`);
      }
    }
    /**
     * Outcomes phrased as something that does NOT happen.
     *
     * "The order is not placed" has no element to point at: the binder's best
     * match was a spinner that is invisible on every page at almost every
     * instant, so the check would have passed whatever the product did. These
     * need rewording by whoever owns the requirement, and that is a question,
     * not a defect — so it belongs here rather than buried in reconciliation.
     */
    const needObservable: string[] = [];
    for (const entry of recon.unbindable ?? []) {
      for (const e of entry.exceptions ?? []) {
        if (e.kind !== 'no_candidate' || !/^O\d/.test(e.where)) continue;
        const what = e.summary?.replace(/\s+/g, ' ').trim();
        needObservable.push(what ? `${entry.test_id} ${e.where} — ${what}` : `${entry.test_id} ${e.where}`);
      }
    }
    if (needObservable.length > 0) {
      asks.push({
        heading: `${needObservable.length} outcome(s) describe something invisible`,
        why:
          'These say what should NOT happen, and nothing on the page corresponds to that. A check ' +
          'written against the closest match would pass no matter how the product behaved.',
        items: needObservable.slice(0, 20),
        how: 'Reword the outcome as what the shopper SEES when it holds — an error message, a page they stay on — and re-bind.',
      });
    }

    if (needValue.length > 0) {
      asks.push({
        heading: `${needValue.length} check(s) need an exact expected value`,
        why:
          'The outcome says what should happen but not precisely enough to check — usually the exact wording of a message, or the path a link should reach. Guessing it would grade the product against a rule nobody chose.',
        items: needValue.slice(0, 20),
        how: 'Add the exact text or path to the outcome statement in the intent, then re-bind. The reconciliation report lists what the page currently offers for each.',
      });
    }
  }
}

// --- 4. Test data nobody has provisioned ------------------------------------

const intents: TestIntent[] = listIntents(PATHS.intentsApproved)
  .map(readIntentFile)
  .filter((i) => !featureName || i.feature === featureName);

const unprovisioned: string[] = [];
for (const i of intents) {
  for (const d of i.test_data ?? []) {
    if (!d.provisioning || d.provisioning === 'unknown') {
      unprovisioned.push(`${i.test_id} — "${d.name}": ${d.description}`);
    }
  }
}
if (unprovisioned.length > 0) {
  asks.push({
    heading: `${unprovisioned.length} test(s) need data that nobody has confirmed exists`,
    why: 'An approved test that cannot be given its data will report BLOCKED, which reads like the system failing rather than a missing fixture.',
    items: unprovisioned,
  });
}

// --- 5. Roles with no seeded session ----------------------------------------

const needSession: string[] = [];
for (const role of ctx.roles ?? []) {
  if (!role.storage_state_ref) continue; // anonymous by declaration
  const file = path.join(PATHS.auth, `${role.storage_state_ref.toLowerCase()}.json`);
  if (!fs.existsSync(file)) needSession.push(role.name);
}
if (needSession.length > 0) {
  asks.push({
    heading: `${needSession.length} role(s) have no signed-in session`,
    why: 'Missions for these roles cannot start. No credential is ever stored here — you sign in yourself and only the session is kept.',
    items: needSession,
    how: `npm run auth -- --role <role> --feature ${featureName ?? '<feature>'}`,
  });
}

// --- Report -----------------------------------------------------------------

console.log('');
console.log(`Preflight — ${label}`);
console.log('');

if (asks.length === 0) {
  console.log('Nothing needed. Everything this run depends on is already answered or seeded.');
  console.log('');
  console.log(`  npm run bind -- --feature ${featureName ?? '<feature>'} --write`);
  console.log(`  npm run run-mission -- --feature ${featureName ?? '<feature>'}`);
  console.log('');
  process.exit(0);
}

console.log(`${asks.length} thing(s) need you before this run is complete.`);
console.log('');

let n = 0;
for (const ask of asks) {
  n += 1;
  console.log(`${n}. ${ask.heading}`);
  console.log(`   ${ask.why}`);
  console.log('');
  for (const item of ask.items) console.log(`     - ${item}`);
  if (ask.items.length >= 20) console.log('     ... (truncated)');
  if (ask.how) {
    console.log('');
    console.log(`   ${ask.how}`);
  }
  console.log('');
}

console.log('None of this blocks you from running what is already bound — it is what');
console.log('stands between this run and covering everything that was approved.');
process.exit(1);
