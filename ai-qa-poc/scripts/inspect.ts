/**
 * Look at the application before writing tests about it.
 *
 *   npm run inspect -- --feature ecommerce
 *   npm run inspect -- --feature ecommerce --pages / /cart /products
 *
 * Writes knowledge/observed/<feature>.md, which `npm run think` then folds
 * into the prompt pack automatically.
 *
 * This exists because the Thinking Agent was writing missions from requirement
 * prose alone and inventing UI: a cart count badge that does not exist, an
 * aria-pressed attribute never used on the page. A tester opens the app first.
 * Now so does the agent.
 *
 * Re-run it whenever the application changes — a stale observation is worse
 * than none, because it is believed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadAppContext, PATHS, rel } from '../src/config.js';
import { inspectPage, renderReality, type PageReality } from '../src/inspector.js';
import { capturePair, saveCapture } from '../src/captures.js';
import { captureFlows } from '../src/flow-capture.js';
import { listIntents, readIntentFile } from '../src/intents.js';
import { diffCaptures, renderDiff } from '../src/build-diff.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function flagList(name: string): string[] {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return [];
  const out: string[] = [];
  for (let j = i + 1; j < process.argv.length; j += 1) {
    const v = process.argv[j];
    if (!v || v.startsWith('--')) break;
    out.push(v);
  }
  return out;
}

const featureName = flag('feature');

let ctx;
try {
  ctx = loadAppContext(featureName);
} catch {
  console.error(
    featureName
      ? `No knowledge/application-context-${featureName}.yaml — cannot work out what to inspect.`
      : 'No knowledge/application-context.yaml found.',
  );
  process.exit(1);
}

const baseUrl = ctx.application.base_url;
if (baseUrl.includes('example.com')) {
  console.error(`base_url is still the placeholder ${baseUrl}. Set a real one before inspecting.`);
  process.exit(1);
}

// Pages come from the flag, else from the context's declared pages, else "/".
const explicit = flagList('pages');
const fromContext = Object.values(ctx.pages ?? {})
  .map((p) => p.path)
  .filter((p) => p && !p.includes(':')); // skip templated paths like /workpods/:id
const paths = explicit.length ? explicit : fromContext.length ? fromContext : ['/'];

console.log(`Application : ${ctx.application.name}`);
console.log(`Base URL    : ${baseUrl}`);
console.log(`Pages       : ${paths.join(', ')}`);
console.log('');

const results: PageReality[] = [];
for (const p of paths) {
  const url = new URL(p, baseUrl).toString();
  process.stdout.write(`  inspecting ${url} ... `);
  try {
    const reality = await inspectPage(url);
    results.push(reality);
    const broken = reality.images.filter((i) => !i.loaded).length;
    console.log(
      `${reality.controls.length} control names, ${reality.images.length} images` +
        `${broken ? ` (${broken} BROKEN)` : ''}, ${reality.ambiguous.length} ambiguous`,
    );
  } catch (err) {
    console.log(`failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

if (results.length === 0) {
  console.error('\nNothing could be inspected — is the site reachable?');
  process.exit(1);
}

const dir = path.join(PATHS.knowledge, 'observed');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${featureName ?? 'default'}.md`);
fs.writeFileSync(file, renderReality(results), 'utf8');

console.log('');
console.log(`Observed state written: ${rel(file)}`);

// [R4] Keep the structured capture too. The markdown above is overwritten
// every run because the prompt pack wants what is true now; the capture is
// never overwritten, because a build diff needs the page as it was.
/**
 * Walk the flows the approved intents describe, and capture what appears.
 *
 * The pages above are every URL in its initial state. That is not what a user
 * sees for most of a session — the checkout form, a filtered grid and a cart
 * with contents all exist only after somebody has acted, and binding against a
 * snapshot that never contained them is why a whole class of approved tests
 * could never run. The intents already describe those paths, so no new
 * configuration is needed: a new requirement gets this for free.
 *
 * Skipped with --no-flows when only a quick look at the pages is wanted.
 */
let flowStates: Awaited<ReturnType<typeof captureFlows>> = [];
if (!process.argv.includes('--no-flows')) {
  const intents = listIntents(PATHS.intentsApproved)
    .map(readIntentFile)
    .filter((i) => (featureName ? i.feature === featureName : true));

  if (intents.length > 0) {
    console.log('');
    process.stdout.write(`  walking ${Math.min(intents.length, 12)} approved flow(s) ... `);
    flowStates = await captureFlows(intents, baseUrl, { headless: true });
    console.log(`${flowStates.length} distinct state(s) reached`);
    for (const s of flowStates.slice(0, 8)) {
      console.log(`    ${s.from} ${s.afterStep}: ${new URL(s.page.url).pathname} — ${s.page.controls.length} control name(s)`);
    }
  }
}

const captureFile = saveCapture(results, featureName, baseUrl, flowStates);
console.log(`Capture kept        : ${rel(captureFile)}`);

const { current, previous } = capturePair(featureName);
if (current && previous) {
  const diff = diffCaptures(previous, current);
  const diffFile = path.join(PATHS.reports, `build-diff-${featureName ?? "default"}-${Date.now()}.md`);
  fs.mkdirSync(PATHS.reports, { recursive: true });
  fs.writeFileSync(diffFile, renderDiff(diff), "utf8");
  const notable = diff.changes.filter((c) => c.notable).length;
  console.log(`Build diff written  : ${rel(diffFile)}`);
  if (diff.changes.length === 0) {
    console.log("  nothing structural changed since the last capture.");
  } else {
    console.log(`  ${diff.changes.length} change(s) since the last capture, ${notable} worth reading first.`);
    for (const c of diff.changes.filter((x) => x.notable).slice(0, 5)) console.log(`    - ${c.summary}`);
  }
} else {
  console.log("No earlier capture to diff against — this one becomes the baseline.");
}

const totalAmbiguous = results.reduce((n, r) => n + r.ambiguous.length, 0);
const totalBroken = results.reduce((n, r) => n + r.images.filter((i) => !i.loaded).length, 0);
if (totalAmbiguous) {
  console.log(`  ${totalAmbiguous} ambiguous control name(s) — missions targeting these must scope with "within".`);
}
if (totalBroken) {
  console.log(`  ${totalBroken} image(s) already failing to load — worth a look before writing any test.`);
}
console.log('');
console.log('Next:  npm run think -- --feature ' + (featureName ?? '<feature>'));
console.log('       The pack now includes what is actually on the page.');
