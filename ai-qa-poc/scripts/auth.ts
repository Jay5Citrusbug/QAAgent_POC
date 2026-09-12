/**
 * Record a signed-in session for a role, so missions never log in through the UI.
 *
 *   npm run auth -- --role admin --feature ecommerce     # opens a browser; you sign in
 *   npm run auth -- --list                               # what is seeded, and how stale
 *   npm run auth -- --check --feature ecommerce          # do the roles in context have sessions?
 *   npm run auth -- --forget --role admin                # delete one
 *
 * The executor has always read `.auth/<ref>.json` and refused to run without
 * it (VISION §16). Nothing ever produced one, so every mission for an
 * authenticated role failed on a missing file — a documented mechanism with no
 * way to satisfy it, which is worse than an undocumented gap because it looks
 * finished.
 *
 * ## Why you sign in by hand
 *
 * This opens a real browser, navigates to the application, and waits while a
 * human signs in. It does not script the login, and that is deliberate:
 *
 * * **No credential ever enters this repository.** Not in a mission, not in a
 *   config file, not in an environment variable this reads. You type it into
 *   the application, exactly as a user would.
 * * **SSO, MFA and CAPTCHA just work**, because a person is handling them. A
 *   scripted login breaks the first time security is tightened, and it breaks
 *   in a way that looks like a product defect.
 * * It takes thirty seconds, once per role, per expiry.
 *
 * The saved file contains cookies and local storage for the signed-in session.
 * That is as sensitive as the password: `.auth/` is gitignored, and it should
 * stay that way. Anyone with this file is signed in as that role.
 *
 * ## About the login feature itself
 *
 * A mission that *tests* signing in must run anonymously — `auth.strategy:
 * "anonymous"` — or it would start already signed in and prove nothing. Seeded
 * sessions are for the twenty missions that need to be past the login page, not
 * for the four that are about it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadAppContext, PATHS, rel } from '../src/config.js';

/**
 * A flag's value, or undefined when it has none.
 *
 * The `-- undefined : argv[i + 1]` version most of these scripts use reads the
 * *next flag* as a value: `--forget --role admin` resolved `--forget` to the
 * string "--role" and then reported "no session recorded for --role". Any flag
 * that can be used both as a switch and with a value hits this.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const featureName = arg('feature');

function statePath(ref: string): string {
  return path.join(PATHS.auth, `${ref.toLowerCase()}.json`);
}

function ageOf(file: string): { days: number; when: string } {
  const stat = fs.statSync(file);
  return {
    days: Math.floor((Date.now() - stat.mtimeMs) / 86_400_000),
    when: stat.mtime.toISOString().slice(0, 16).replace('T', ' '),
  };
}

/**
 * Sessions expire, and a stale one fails in the least helpful way available:
 * the run starts, lands on a login page it was not expecting, and reports a
 * missing control. That reads as a product defect. Flagging age here is much
 * cheaper than diagnosing it there.
 */
const STALE_DAYS = 7;

function describe(ref: string): string {
  const file = statePath(ref);
  if (!fs.existsSync(file)) return `${ref.padEnd(12)} — not seeded`;
  const { days, when } = ageOf(file);
  const flag = days >= STALE_DAYS ? `  ← ${days}d old, probably expired` : '';
  return `${ref.padEnd(12)} — recorded ${when}${flag}`;
}

// --- List -------------------------------------------------------------------

if (has('list')) {
  if (!fs.existsSync(PATHS.auth)) {
    console.log('No sessions recorded yet.');
    console.log('  npm run auth -- --role <role> --feature <feature>');
    process.exit(0);
  }
  const refs = fs
    .readdirSync(PATHS.auth)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.basename(f, '.json'));

  if (refs.length === 0) {
    console.log('No sessions recorded yet.');
    process.exit(0);
  }

  console.log(`Sessions in ${rel(PATHS.auth)}:`);
  console.log('');
  for (const ref of refs.sort()) console.log(`  ${describe(ref)}`);
  console.log('');
  console.log('These are live credentials in effect. They are gitignored and must stay so.');
  process.exit(0);
}

// --- Check against the roles a feature actually declares ---------------------

if (has('check')) {
  let ctx;
  try {
    ctx = loadAppContext(featureName);
  } catch {
    console.error('No application context — nothing to check against.');
    process.exit(1);
  }

  const roles = ctx.roles ?? [];
  if (roles.length === 0) {
    console.log('No roles declared in the application context. Nothing needs seeding.');
    process.exit(0);
  }

  console.log(`Roles declared for ${featureName ?? 'the default feature'}:`);
  console.log('');

  let missing = 0;
  let stale = 0;
  for (const role of roles) {
    /**
     * A role with no `storage_state_ref` is anonymous by declaration, not by
     * oversight. Reporting "not seeded" for the Guest role on a storefront with
     * no sign-in is a warning that can never be actioned, and warnings that
     * cannot be actioned are how people learn to ignore the output.
     */
    if (!role.storage_state_ref) {
      console.log(`  ${role.name.padEnd(10)} → anonymous (no storage_state_ref declared — nothing to seed)`);
      continue;
    }
    const ref = role.storage_state_ref;
    const file = statePath(ref);
    if (!fs.existsSync(file)) missing += 1;
    else if (ageOf(file).days >= STALE_DAYS) stale += 1;
    console.log(`  ${role.name.padEnd(10)} → ${describe(ref)}`);
  }

  console.log('');
  if (missing === 0 && stale === 0) {
    console.log('Every role that needs a session has a recent one.');
  } else {
    if (missing) console.log(`${missing} role(s) cannot run any authenticated mission yet.`);
    if (stale) console.log(`${stale} session(s) are old enough to have expired — re-record before trusting a run.`);
    console.log(`  npm run auth -- --role <role>${featureName ? ` --feature ${featureName}` : ''}`);
  }
  process.exit(missing > 0 ? 1 : 0);
}

// --- Forget -----------------------------------------------------------------

if (has('forget')) {
  const role = arg('forget') ?? arg('role');
  if (!role) {
    console.error('Usage: npm run auth -- --forget --role <role>');
    process.exit(1);
  }
  const file = statePath(role);
  if (!fs.existsSync(file)) {
    console.error(`No session recorded for "${role}".`);
    process.exit(1);
  }
  fs.rmSync(file);
  console.log(`Removed ${rel(file)}. That role cannot run authenticated missions until re-recorded.`);
  process.exit(0);
}

// --- Record -----------------------------------------------------------------

const role = arg('role');
if (!role) {
  console.error('Usage: npm run auth -- --role <role> [--feature <feature>] [--url <sign-in url>]');
  console.error('       npm run auth -- --list');
  console.error('       npm run auth -- --check --feature <feature>');
  process.exit(1);
}

let startUrl = arg('url');
if (!startUrl) {
  let ctx;
  try {
    ctx = loadAppContext(featureName);
  } catch {
    console.error('No application context and no --url given — nowhere to send you to sign in.');
    process.exit(1);
  }
  const base = ctx.application.base_url;
  if (base.includes('example.com')) {
    console.error(`base_url is still the placeholder ${base}. Pass --url, or set a real one.`);
    process.exit(1);
  }
  startUrl = new URL(ctx.application.starting_page ?? '/', base).toString();

  // Warn when the role is not one the context knows about: a session saved
  // under a name no mission references is invisible work.
  const known = (ctx.roles ?? []).map((r) => r.storage_state_ref ?? r.name.toLowerCase());
  if (known.length && !known.includes(role.toLowerCase())) {
    console.warn(`! "${role}" is not a role in this feature's context (${known.join(', ')}).`);
    console.warn('  Recording it anyway, but no mission will look for it under that name.');
    console.warn('');
  }
}

const file = statePath(role);
if (fs.existsSync(file) && !has('force')) {
  const { days, when } = ageOf(file);
  console.error(`A session for "${role}" already exists, recorded ${when} (${days}d ago).`);
  console.error('Pass --force to replace it.');
  process.exit(1);
}

console.log(`Recording a session for role "${role}".`);
console.log('');
console.log(`  1. A browser will open at ${startUrl}`);
console.log('  2. Sign in as this role — SSO, MFA, whatever the application asks for.');
console.log('  3. When you are signed in and on a normal page, come back here and press Enter.');
console.log('');
console.log('No credential is typed here, read from here, or stored here. You sign in to the');
console.log('application directly; only the resulting session is saved.');
console.log('');

// Headed, always. The entire point is that a person is driving.
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

try {
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
} catch (err) {
  console.error(`Could not open ${startUrl}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  await browser.close();
  process.exit(1);
}

process.stdout.write('Press Enter once you are signed in... ');
await new Promise<void>((resolve) => {
  process.stdin.resume();
  process.stdin.once('data', () => {
    process.stdin.pause();
    resolve();
  });
});
console.log('');

const state = await context.storageState();

/**
 * Refuse to save a session that contains nothing.
 *
 * Pressing Enter too early writes an empty state file, and an empty state file
 * is the worst possible outcome: the executor finds it, uses it, lands on a
 * login page, and reports that it could not find a control. That reads as a
 * product defect and costs an hour to trace back to here.
 */
const cookieCount = state.cookies.length;
const originCount = state.origins.length;

if (cookieCount === 0 && originCount === 0) {
  console.error('Nothing was stored — no cookies, no local storage.');
  console.error('');
  console.error('That usually means the sign-in had not completed. Nothing has been saved:');
  console.error('an empty session file would be used by the executor, land on a login page,');
  console.error('and report a missing control — which reads as a product defect.');
  await browser.close();
  process.exit(1);
}

fs.mkdirSync(PATHS.auth, { recursive: true });
fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
await browser.close();

console.log(`Saved ${rel(file)} — ${cookieCount} cookie(s), ${originCount} origin(s).`);
console.log('');
console.log('Missions with this role can now run:');
console.log(`  "auth": { "strategy": "storage_state", "storage_state_ref": "${role.toLowerCase()}" }`);
console.log('');
console.log(`This file signs anyone in as ${role}. It is gitignored — keep it that way, and`);
console.log(`re-record it when it expires (npm run auth -- --list shows the age).`);
