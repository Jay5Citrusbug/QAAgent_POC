import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { Locator, Page } from '@playwright/test';

/**
 * Accessibility — WCAG rules, checked by axe-core in the running page.
 *
 * axe is the engine most accessibility audits use: it knows contrast ratios,
 * ARIA roles, landmark structure, form labelling and some ninety other rules,
 * and it is deliberately conservative — a rule it cannot decide is reported as
 * "incomplete", never as a violation. That matches this codebase's own rule:
 * no false positives, because a check that cries wolf gets muted.
 *
 * Scope: WCAG 2.0/2.1/2.2, levels A and AA. What axe cannot judge — keyboard
 * traps, focus order that makes sense, captions that say the right thing —
 * still needs a person.
 */

const require = createRequire(import.meta.url);
let axeSource: string | undefined;

function source(): string {
  axeSource ??= fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  return axeSource;
}

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export type Impact = 'minor' | 'moderate' | 'serious' | 'critical';
const RANK: Record<Impact, number> = { minor: 0, moderate: 1, serious: 2, critical: 3 };

export function atLeast(impact: string | null | undefined, floor: Impact): boolean {
  return impact !== null && impact !== undefined && impact in RANK && RANK[impact as Impact] >= RANK[floor];
}

export interface Violation {
  rule: string;
  impact: Impact;
  help: string;
  helpUrl: string;
  /** CSS paths of the offending elements, and axe's one-line fix summary for each. */
  nodes: { target: string; summary: string }[];
}

async function inject(page: Page): Promise<void> {
  const present = await page.evaluate('typeof window.axe !== "undefined"').catch(() => false);
  if (!present) await page.addScriptTag({ content: source() });
}

/** Run the WCAG A/AA rules on the page, or inside one element. */
export async function runAxe(page: Page, scope?: Locator): Promise<Violation[]> {
  await inject(page);
  // Same no-op helper as the layout sweep: tsx may wrap inner functions in __name().
  await page.evaluate('window.__name = window.__name || ((f) => f)');
  const options = { runOnly: { type: 'tag', values: WCAG_TAGS }, resultTypes: ['violations'] };
  // Everything below runs in the page, so it may only use what it is given.
  return (scope ?? page.locator('html')).evaluate(
    (root, opts) =>
      (window as unknown as { axe: { run(r: unknown, o: unknown): Promise<{ violations: unknown[] }> } }).axe
        .run(root, opts)
        .then((r) =>
          (r.violations as { id: string; impact: string; help: string; helpUrl: string; nodes: { target: unknown[]; failureSummary?: string }[] }[]).map((v) => ({
            rule: v.id,
            impact: v.impact,
            help: v.help,
            helpUrl: v.helpUrl,
            nodes: v.nodes.slice(0, 10).map((n) => ({
              target: n.target.map(String).join(' '),
              summary: (n.failureSummary ?? '').replace(/^Fix (any|all) of the following:\s*/i, '').split('\n')[0]?.trim() ?? '',
            })),
          })),
        ),
    options,
  ) as Promise<Violation[]>;
}

/**
 * Rules the observer already reports as `unlabelled_control` — it sweeps
 * buttons and links only. Raising those a second time under an axe name would
 * put one bug on the list twice. Form-field labelling (label, select-name, …)
 * is NOT covered by the observer, so axe keeps reporting it.
 */
const ALREADY_OBSERVED = new Set(['button-name', 'link-name']);

/** Violations as findings for the observer, one per rule per page. */
export function a11yFindings(violations: Violation[], url: string) {
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  return violations
    .filter((v) => atLeast(v.impact, 'moderate') && !ALREADY_OBSERVED.has(v.rule))
    .map((v) => ({
      key: `a11y:${v.rule}:${path}`,
      kind: 'a11y_violation' as const,
      severity: atLeast(v.impact, 'serious') ? ('medium' as const) : ('low' as const),
      summary: `Accessibility (${v.impact}): ${v.help} — ${v.nodes.length} element(s) on ${path}`,
      detail: `${v.nodes.map((n) => `${n.target}: ${n.summary}`).join('\n')}\nRule ${v.rule}: ${v.helpUrl}`,
      url,
    }));
}
