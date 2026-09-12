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
