import type { Page } from '@playwright/test';

/**
 * Page performance — measured in the browser, the way users experience it.
 *
 * The numbers are Google's Core Web Vitals plus two classics:
 *
 *   TTFB  time to first byte: how long the server took to start answering
 *   LCP   largest contentful paint: when the main content appeared
 *   CLS   cumulative layout shift: how much the page jumped while loading
 *   load  the load event: everything on the page finished loading
 *
 * Thresholds are Google's published "good / needs improvement / poor" lines,
 * overridable per environment (STAGE is often slower than production, and a
 * team may decide to judge it more leniently).
 *
 * Honest limits: this measures the last full page load, not route changes
 * inside a single-page app; and a metric the engine does not support (CLS in
 * WebKit and Firefox) is "not measured" there, never reported as zero.
 */

export interface PageMetrics {
  url: string;
  ttfb_ms?: number;
  lcp_ms?: number;
  cls?: number;
  load_ms?: number;
  dom_content_loaded_ms?: number;
}

export const PERF_LIMITS = {
  ttfb_ms: Number(process.env.PERF_TTFB_MS ?? 800),
  lcp_ms: Number(process.env.PERF_LCP_MS ?? 2_500),
  cls: Number(process.env.PERF_CLS ?? 0.1),
  load_ms: Number(process.env.PERF_LOAD_MS ?? 5_000),
};

/** Google's "poor" lines: past these the finding is medium, not low. */
const POOR = { ttfb_ms: 1_800, lcp_ms: 4_000, cls: 0.25, load_ms: 10_000 };

export async function readMetrics(page: Page): Promise<PageMetrics> {
  await page.evaluate('window.__name = window.__name || ((f) => f)');
  // LCP and layout shifts are only observable through PerformanceObserver with
  // buffered: true; a short wait lets the buffered entries arrive.
  const m = await page.evaluate(
    () =>
      new Promise<{ ttfb?: number; lcp?: number; cls?: number; load?: number; dcl?: number }>((resolve) => {
        const out: { ttfb?: number; lcp?: number; cls?: number; load?: number; dcl?: number } = {};
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        if (nav) {
          out.ttfb = nav.responseStart;
          if (nav.domContentLoadedEventEnd > 0) out.dcl = nav.domContentLoadedEventEnd;
          if (nav.loadEventEnd > 0) out.load = nav.loadEventEnd;
        }
        // observe() silently ignores a type the engine does not support, so ask
        // first: an unsupported metric is "not measured", never a perfect 0.
        const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes ?? [];
        if (supported.includes('largest-contentful-paint')) {
          new PerformanceObserver((list) => {
            const entries = list.getEntries();
            const last = entries[entries.length - 1];
            if (last) out.lcp = last.startTime;
          }).observe({ type: 'largest-contentful-paint', buffered: true });
        }
        if (supported.includes('layout-shift')) {
          let cls = 0;
          out.cls = 0; // supported and nothing shifted: a genuine zero
          new PerformanceObserver((list) => {
            for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
              if (!e.hadRecentInput) cls += e.value;
            }
            out.cls = Math.round(cls * 1000) / 1000;
          }).observe({ type: 'layout-shift', buffered: true });
        }
        setTimeout(() => resolve(out), 100);
      }),
  );
  const round = (n?: number) => (n === undefined ? undefined : Math.round(n));
  return {
    url: page.url(),
    ...(m.ttfb !== undefined ? { ttfb_ms: round(m.ttfb) } : {}),
    ...(m.lcp !== undefined ? { lcp_ms: round(m.lcp) } : {}),
    ...(m.cls !== undefined ? { cls: m.cls } : {}),
    ...(m.load !== undefined ? { load_ms: round(m.load) } : {}),
    ...(m.dcl !== undefined ? { dom_content_loaded_ms: round(m.dcl) } : {}),
  };
}

const LABEL = { ttfb_ms: 'Server response (TTFB)', lcp_ms: 'Main content (LCP)', cls: 'Layout shift (CLS)', load_ms: 'Full page load' };
const show = (k: keyof typeof PERF_LIMITS, v: number) => (k === 'cls' ? v.toFixed(3) : `${(v / 1000).toFixed(2)}s`);

/** Metrics over the limits, as findings; one per metric per page. */
export function performanceFindings(m: PageMetrics) {
  const path = (() => {
    try {
      return new URL(m.url).pathname;
    } catch {
      return m.url;
    }
  })();
  const out = [];
  for (const k of Object.keys(PERF_LIMITS) as (keyof typeof PERF_LIMITS)[]) {
    const v = m[k];
    if (v === undefined || v <= PERF_LIMITS[k]) continue;
    out.push({
      key: `perf:${k}:${path}`,
      kind: 'slow_page' as const,
      severity: v > POOR[k] ? ('medium' as const) : ('low' as const),
      summary: `${LABEL[k]} ${show(k, v)} on ${path} (limit ${show(k, PERF_LIMITS[k])})`,
      detail: `${v > POOR[k] ? 'Poor' : 'Needs improvement'} by Core Web Vitals thresholds. Measured: ${(Object.keys(LABEL) as (keyof typeof LABEL)[])
        .filter((x) => m[x] !== undefined)
        .map((x) => `${LABEL[x]} ${show(x, m[x] as number)}`)
        .join(', ')}.`,
      url: m.url,
    });
  }
  return out;
}

/** Compare against a test's own budget. Returns the breaches and what was not measurable. */
export function checkBudget(m: PageMetrics, budget: Partial<typeof PERF_LIMITS>): { breaches: string[]; unmeasured: string[] } {
  const breaches: string[] = [];
  const unmeasured: string[] = [];
  for (const k of Object.keys(budget) as (keyof typeof PERF_LIMITS)[]) {
    const limit = budget[k];
    if (limit === undefined) continue;
    const v = m[k];
    if (v === undefined) unmeasured.push(LABEL[k]);
    else if (v > limit) breaches.push(`${LABEL[k]} ${show(k, v)} > ${show(k, limit)}`);
  }
  return { breaches, unmeasured };
}

export function describeMetrics(m: PageMetrics): string {
  return (Object.keys(LABEL) as (keyof typeof LABEL)[])
    .filter((k) => m[k] !== undefined)
    .map((k) => `${LABEL[k]} ${show(k, m[k] as number)}`)
    .join(' · ');
}
