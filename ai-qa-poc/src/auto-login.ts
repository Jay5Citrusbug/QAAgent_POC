import fs from 'node:fs';
import path from 'node:path';
import { chromium, firefox, webkit, type Page } from '@playwright/test';
import { PATHS, rel, RUNTIME } from './config.js';
import type { AppContext } from './types.js';

/**
 * Sessions per role: kept fresh without anyone signing in by hand, when a role
 * opts in.
 *
 * The default stays the manual one (`npm run auth`): a person signs in once,
 * and SSO, MFA and CAPTCHA just work. A role can additionally declare a
 * scripted login. Its configuration names ENVIRONMENT VARIABLES, never values:
 * the credentials live only in the gitignored .env or the CI secret store, are
 * typed into the login form, and are never written to a log, a result or a
 * report.
 *
 *   roles:
 *     - name: Customer
 *       storage_state_ref: customer
 *       session_max_age_minutes: 240
 *       login:
 *         url: /login
 *         username_env: STAGE_CUSTOMER_USER
 *         password_env: STAGE_CUSTOMER_PASSWORD
 *
 * A session older than `session_max_age_minutes` (default 12 hours), or
 * missing, is renewed before the test. A session the server already threw away
 * is caught when a test lands on a sign-in page, and renewed once.
 */

export type Role = NonNullable<AppContext['roles']>[number];

/** Where a page lands when the server wants a sign-in. */
export const SIGN_IN_PAGE = /\/(login|log-in|signin|sign-in|auth|sso|account\/login)\b/i;

export function sessionFile(ref: string): string {
  return path.join(PATHS.auth, `${ref}.json`);
}

/** Missing, or older than the role allows: worth renewing before the test. */
export function sessionStale(role: Role, ref: string): 'missing' | 'stale' | undefined {
  const file = sessionFile(ref);
  if (!fs.existsSync(file)) return 'missing';
  const maxAge = (role.session_max_age_minutes ?? 12 * 60) * 60_000;
  return Date.now() - fs.statSync(file).mtimeMs > maxAge ? 'stale' : undefined;
}

/**
 * Sign in through the login form with credentials from the environment, and
 * save the session. Returns the saved file; throws with a reason a person can
 * act on (never the credentials themselves).
 */
export async function scriptedLogin(ctx: AppContext, role: Role, ref: string, log: (line: string) => void): Promise<string> {
  const cfg = role.login;
  if (!cfg) throw new Error(`Role ${role.name} has no login: configuration; sign in by hand with npm run auth -- --role ${role.name}.`);
  const user = process.env[cfg.username_env];
  const pass = process.env[cfg.password_env];
  if (!user || !pass) {
    throw new Error(`Set ${cfg.username_env} and ${cfg.password_env} in .env (never in a committed file) to let ${role.name} sign in automatically.`);
  }
  const engine = { chromium, firefox, webkit }[RUNTIME.browser ?? 'chromium'];
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const loginUrl = new URL(cfg.url, ctx.application.base_url).toString();
    log(`Signing in as ${role.name} (scripted, credentials from ${cfg.username_env} / ${cfg.password_env})`);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await fieldFor(page, cfg.username_label, /e-?mail|user ?name|login|user/i).fill(user);
    await fieldFor(page, cfg.password_label, /password|passcode/i).fill(pass);
    const submit = cfg.submit
      ? page.getByRole('button', { name: cfg.submit })
      : page.getByRole('button', { name: /sign in|log ?in|continue|submit/i });
    await submit.first().click({ timeout: 10_000 });
    // Signed in = left the sign-in page (or reached the configured URL).
    await page.waitForURL(
      (u) => (cfg.success_url_contains ? u.toString().includes(cfg.success_url_contains) : !SIGN_IN_PAGE.test(u.pathname)),
      { timeout: 20_000 },
    ).catch(() => {
      throw new Error(`Scripted sign-in for ${role.name} did not leave ${new URL(page.url()).pathname}: wrong credentials, MFA/CAPTCHA, or a different form. Use npm run auth for this role.`);
    });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    fs.mkdirSync(PATHS.auth, { recursive: true });
    const file = sessionFile(ref);
    await context.storageState({ path: file });
    log(`Session for ${role.name} saved to ${rel(file)}`);
    return file;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function fieldFor(page: Page, label: string | undefined, fallback: RegExp) {
  if (label) return page.getByLabel(label, { exact: false }).first();
  return page.getByLabel(fallback).or(page.getByPlaceholder(fallback)).first();
}

/**
 * Headers for an api_request, from the role's `api_auth`: a token from the
 * environment, or read from where the app itself keeps it after sign-in
 * (`localStorage:<key>`, `sessionStorage:<key>`, `cookie:<name>`).
 */
export async function apiAuthHeaders(role: Role | undefined, page: Page): Promise<Record<string, string>> {
  const cfg = role?.api_auth;
  if (!cfg) return {};
  let token: string | undefined;
  if (cfg.token_env) token = process.env[cfg.token_env];
  else if (cfg.from_storage) {
    const [where, key] = cfg.from_storage.split(':', 2) as [string, string];
    if (where === 'cookie') {
      token = (await page.context().cookies()).find((c) => c.name === key)?.value;
    } else if (where === 'localStorage' || where === 'sessionStorage') {
      token = (await page.evaluate(([w, k]) => (w === 'localStorage' ? localStorage : sessionStorage).getItem(k), [where, key] as const)) ?? undefined;
    }
  }
  if (!token) return {};
  const scheme = cfg.scheme === undefined ? 'Bearer' : cfg.scheme;
  return { [cfg.header ?? 'Authorization']: scheme ? `${scheme} ${token}` : token };
}
