import fs from 'node:fs';
import path from 'node:path';
import { chromium, firefox, webkit, type Browser } from '@playwright/test';
import { PATHS, rel, RUNTIME } from './config.js';
import type { AppContext } from './types.js';

/**
 * The access matrix — every role against every protected page.
 *
 * Broken access control is the most common serious web vulnerability (OWASP
 * Top 10, A01), and it is rarely tested systematically: a tester checks that
 * an admin can open the admin page, not that a guest cannot. This does both,
 * for every role and every listed path, from the rules written down once in
 * the application context.
 *
 * Each cell is opened in a fresh browser context with that role's seeded
 * session (or none, for an anonymous role), so nothing leaks between cells.
 */

export type Verdict = 'allowed' | 'denied';

export interface Cell {
  role: string;
  path: string;
  expected: Verdict;
  actual: Verdict | 'blocked';
  /** Why the page was judged allowed or denied, in plain words. */
  evidence: string;
  screenshot?: string;
}

const DENIAL_TEXT = /\b(access denied|not authori[sz]ed|unauthori[sz]ed|forbidden|permission denied|you do not have (access|permission)|sign in to continue|please (sign|log) ?in)\b/i;
const LOGIN_PATH = /\/(login|log-in|signin|sign-in|auth|account\/login)\b/i;

function judge(
  requested: string,
  status: number | undefined,
  finalUrl: string,
  text: string,
  rules: AppContext['access_denied'],
): { verdict: Verdict; evidence: string } {
  if (status === 401 || status === 403) return { verdict: 'denied', evidence: `HTTP ${status}` };
  if (status === 404) return { verdict: 'denied', evidence: 'HTTP 404 (hidden)' };
  const finalPath = (() => {
    try {
      return new URL(finalUrl).pathname;
    } catch {
      return finalUrl;
    }
  })();
  const redirected = finalPath.replace(/\/$/, '') !== requested.replace(/\/$/, '');
  const custom = rules?.redirect_contains?.find((r) => finalUrl.includes(r));
  if (redirected && (custom || LOGIN_PATH.test(finalPath))) return { verdict: 'denied', evidence: `redirected to ${finalPath}` };
  const customText = rules?.text?.find((t) => text.toLowerCase().includes(t.toLowerCase()));
  if (customText) return { verdict: 'denied', evidence: `page says "${customText}"` };
  const said = text.match(DENIAL_TEXT)?.[0];
  if (said) return { verdict: 'denied', evidence: `page says "${said}"` };
  if (redirected) return { verdict: 'denied', evidence: `redirected away to ${finalPath}` };
  return { verdict: 'allowed', evidence: `opened (HTTP ${status ?? '?'}) and showed the page` };
}

export async function runAccessMatrix(ctx: AppContext, feature: string): Promise<Cell[]> {
  const rules = ctx.access ?? [];
  const roles = ctx.roles ?? [{ name: 'Guest' }];
  const engine = { chromium, firefox, webkit }[RUNTIME.browser ?? 'chromium'];
  const shotDir = path.join(PATHS.runs, '_access', feature);
  fs.mkdirSync(shotDir, { recursive: true });
  const cells: Cell[] = [];
  let browser: Browser | undefined;
  try {
    browser = await engine.launch({ headless: !RUNTIME.headed });
    for (const role of roles) {
      const ref = role.storage_state_ref;
      const file = ref ? path.join(PATHS.auth, `${ref}.json`) : undefined;
      if (file && !fs.existsSync(file)) {
        for (const r of rules) {
          cells.push({
            role: role.name,
            path: r.path,
            expected: r.allow.includes(role.name) ? 'allowed' : 'denied',
            actual: 'blocked',
            evidence: `no seeded session at ${rel(file)}: npm run auth -- --role ${role.name} --feature ${feature}`,
          });
        }
        continue;
      }
      for (const r of rules) {
        // A fresh context per cell: one cell's redirects or cookies never colour the next.
        const context = await browser.newContext({ ...(file ? { storageState: file } : {}), viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const expected: Verdict = r.allow.includes(role.name) ? 'allowed' : 'denied';
        try {
          const res = await page.goto(new URL(r.path, ctx.application.base_url).toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
          const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 5_000);
          const { verdict, evidence } = judge(r.path, res?.status(), page.url(), text, ctx.access_denied);
          const cell: Cell = { role: role.name, path: r.path, expected, actual: verdict, evidence };
          if (verdict !== expected) {
            const shot = path.join(shotDir, `${role.name}-${r.path.replace(/[^a-z0-9]+/gi, '_')}.png`.toLowerCase());
            await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
            if (fs.existsSync(shot)) cell.screenshot = rel(shot);
          }
          cells.push(cell);
        } catch (err) {
          cells.push({ role: role.name, path: r.path, expected, actual: 'blocked', evidence: `could not open: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` });
        } finally {
          await context.close().catch(() => undefined);
        }
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
  }
  return cells;
}

export function renderMatrix(feature: string, ctx: AppContext, cells: Cell[]): string {
  const roles = [...new Set(cells.map((c) => c.role))];
  const paths = [...new Set(cells.map((c) => c.path))];
  const mark = (c: Cell | undefined) =>
    !c ? '—' : c.actual === 'blocked' ? '⚠ not run' : c.actual === c.expected ? (c.actual === 'allowed' ? '✅ allowed' : '✅ denied') : c.actual === 'allowed' ? '❌ **LEAK**' : '❌ **refused**';
  const leaks = cells.filter((c) => c.actual === 'allowed' && c.expected === 'denied');
  const refused = cells.filter((c) => c.actual === 'denied' && c.expected === 'allowed');
  const blocked = cells.filter((c) => c.actual === 'blocked');
  const L = [
    `# Access matrix — ${feature}`,
    '',
    `${ctx.application.base_url} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `**${leaks.length} leak(s)** (a role opened a page it must not) · **${refused.length} wrongly refused** · ${blocked.length} not run`,
    '',
    `| Page | ${roles.join(' | ')} |`,
    `|---|${roles.map(() => '---').join('|')}|`,
    ...paths.map((p) => `| \`${p}\` | ${roles.map((r) => mark(cells.find((c) => c.role === r && c.path === p))).join(' | ')} |`),
    '',
  ];
  const detail = [...leaks, ...refused, ...blocked];
  if (detail.length) {
    L.push('## Details', '');
    for (const c of detail) {
      L.push(`- **${c.role} → \`${c.path}\`**: expected ${c.expected}, got ${c.actual}: ${c.evidence}${c.screenshot ? ` ([screenshot](../${c.screenshot}))` : ''}`);
    }
    L.push('');
  }
  L.push('Rules come from `access:` in the application context. A role not listed in `allow` must be refused.', '');
  return L.join('\n');
}
