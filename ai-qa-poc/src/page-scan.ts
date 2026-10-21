import type { Page } from '@playwright/test';
import { a11yFindings, runAxe } from './a11y.js';
import type { Evidence } from './evidence.js';
import { layoutFindings, sweepLayout } from './layout.js';
import type { Observer } from './observer.js';
import { performanceFindings, readMetrics, type PageMetrics } from './performance.js';
import { capturePage, compareWithBaseline, describeChange, visualKey, type VisualResult } from './visual.js';

/**
 * Page-level checks on EVERY page a test passes through, not only the last.
 *
 * A checkout test walks cart → address → payment → confirmation. Checking
 * layout, accessibility, speed and looks only where it ends meant the three
 * pages in the middle — where the money is taken — were never looked at.
 *
 * Each page is scanned once, on first arrival (its load is what performance
 * measures). The page the test ends on is scanned again for layout and
 * accessibility, because the state a flow ends in (a filled cart, an error
 * shown) is often the one that breaks.
 */

function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

export interface ScannedPage {
  url: string;
  performance?: PageMetrics;
  visual?: VisualResult;
}

export class PageScanner {
  private readonly seen = new Set<string>();
  readonly pages: ScannedPage[] = [];

  constructor(
    private readonly observer: Observer,
    private readonly ev: Evidence,
    private readonly testId: string,
    private readonly opts: { visual: boolean; a11y: boolean; perf: boolean },
  ) {}

  /** Scan the page if this test has not seen it yet. `final` re-checks layout and accessibility. */
  async scan(page: Page, final = false): Promise<void> {
    if (page.isClosed()) return;
    const url = page.url();
    if (!/^https?:/i.test(url)) return;
    const key = pageKey(url);
    const first = !this.seen.has(key);
    if (!first && !final) return;
    this.seen.add(key);
    await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => undefined);

    const entry: ScannedPage = { url };
    const safe = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        this.ev.log(`  ${what} skipped on ${key}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      }
    };

    await safe('layout check', async () => {
      for (const f of layoutFindings(await sweepLayout(page), url)) this.observer.add(f);
    });
    if (this.opts.a11y) {
      await safe('accessibility scan', async () => {
        for (const f of a11yFindings(await runAxe(page), url)) this.observer.add(f);
      });
    }
    if (first && this.opts.perf) {
      await safe('performance', async () => {
        entry.performance = await readMetrics(page);
        for (const f of performanceFindings(entry.performance)) this.observer.add(f);
      });
    }
    if (first && this.opts.visual) {
      await safe('visual comparison', async () => {
        const key2 = visualKey(page);
        const vr = compareWithBaseline(await capturePage(page), this.testId, key2, this.ev.dir, key2);
        entry.visual = vr;
        for (const f of [vr.current, vr.diff].filter(Boolean)) this.ev.add(f as string);
        if (vr.status === 'changed') {
          this.observer.add({
            key: `visual:${this.testId}:${key2}`,
            kind: 'visual_change',
            severity: 'medium',
            summary: `Looks different from the approved baseline (${new URL(url).pathname}): ${describeChange(vr)}`,
            detail: `Diff (changes in red): ${vr.diff}\nIf the change is intended: npm run visual -- --approve ${this.testId} --by "<name>"`,
            url,
          });
        } else if (vr.status === 'no_baseline') {
          this.ev.log(`  Visual: no approved baseline for ${new URL(url).pathname} yet — candidate saved.`);
        }
      });
    }
    if (first) this.pages.push(entry);
    else {
      const existing = this.pages.find((p) => pageKey(p.url) === key);
      if (existing) existing.url = url;
    }
  }
}
