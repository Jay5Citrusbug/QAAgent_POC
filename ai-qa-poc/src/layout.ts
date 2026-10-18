import type { Page } from '@playwright/test';
import type { SweepOutcome } from './sweeps.js';

/**
 * Responsive layout — screen sizes, and the bugs that only appear at one.
 *
 * DOM assertions pass at any width: the button exists, its name is right. What
 * breaks on a phone is geometry — the page scrolls sideways, a control hangs
 * off the edge, a banner sits on top of the Pay button, a link is too small to
 * hit with a thumb. Those are measurable from the rendered page, so they are
 * measured, not left to whoever happens to test on a phone.
 *
 * Same rule as every sweep: no false positives. A carousel scrolls sideways on
 * purpose, an inline text link is not a tap target, a hidden menu is not cut
 * off. Each of those is excluded explicitly.
 */

export type ViewportPreset = 'mobile' | 'tablet' | 'desktop';
export type ViewportSpec = ViewportPreset | { width: number; height: number };

export const VIEWPORTS: Record<ViewportPreset, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 }, // iPhone 14 class
  tablet: { width: 820, height: 1180 }, // iPad Air class
  desktop: { width: 1440, height: 900 }, // the default every run used until now
};

export function viewportSize(spec: ViewportSpec): { width: number; height: number } {
  return typeof spec === 'string' ? VIEWPORTS[spec] : spec;
}

export function describeViewport(spec: ViewportSpec): string {
  const { width, height } = viewportSize(spec);
  return typeof spec === 'string' ? `${spec} (${width}×${height})` : `${width}×${height}`;
}

/** Below this width, tap-target size is checked: it is a touch layout. */
const NARROW = 768;
/** WCAG 2.2 SC 2.5.8 minimum target size. */
const MIN_TARGET = 24;

export type LayoutProblem = 'page_overflow' | 'control_offscreen' | 'control_covered' | 'small_tap_target';

export interface LayoutOutcome extends SweepOutcome {
  /** The offenders again, with their problem kind, for findings. */
  problems: { kind: LayoutProblem; what: string; detail: string }[];
  viewport: { width: number; height: number };
}

export async function sweepLayout(page: Page): Promise<LayoutOutcome> {
  // tsx/esbuild wraps named inner functions in __name(...) for stack traces.
  // That helper exists in Node, not in the page, so give the page a no-op one.
  // A string is evaluated as-is, so this line is never rewritten itself.
  await page.evaluate('window.__name = window.__name || ((f) => f)');
  const raw = await page.evaluate(
    ({ narrowBelow, minTarget }) => {
      const doc = document.documentElement;
      const vw = doc.clientWidth;
      const vh = window.innerHeight;
      const problems: { kind: string; what: string; detail: string }[] = [];

      const label = (el: Element): string => {
        const name =
          el.getAttribute('aria-label') ||
          (el as HTMLElement).innerText?.trim().split('\n')[0]?.slice(0, 40) ||
          el.getAttribute('title') ||
          el.getAttribute('name') ||
          el.getAttribute('placeholder') ||
          '';
        return `${el.tagName.toLowerCase()}${name ? ` "${name}"` : ''}`;
      };
      const shown = (el: Element): boolean => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 && r.width > 0 && r.height > 0;
      };
      /** Inside something that scrolls sideways on purpose (carousel, table wrapper). */
      const inScroller = (el: Element): boolean => {
        for (let p = el.parentElement; p && p !== doc; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (/(auto|scroll|hidden|clip)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) return true;
        }
        return false;
      };

      // 1. The page scrolls sideways.
      const overflow = doc.scrollWidth - vw;
      if (overflow > 2) {
        // Name the elements that start the overflow, not every descendant of them.
        const culprits = Array.from(document.body.querySelectorAll('*'))
          .filter((el) => shown(el) && !inScroller(el))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            const pr = el.parentElement?.getBoundingClientRect();
            return r.right > vw + 2 && (!pr || pr.right <= vw + 2);
          })
          .slice(0, 3)
          .map((el) => `${label(el)} (${Math.round(el.getBoundingClientRect().width)}px wide)`);
        problems.push({
          kind: 'page_overflow',
          what: 'page',
          detail: `the page is ${doc.scrollWidth}px wide in a ${vw}px screen, so it scrolls sideways${culprits.length ? `; widest: ${culprits.join(', ')}` : ''}`,
        });
      }

      const controls = Array.from(
        document.querySelectorAll(
          'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [role=switch]',
        ),
      )
        .filter(shown)
        .slice(0, 400);

      for (const el of controls) {
        const r = el.getBoundingClientRect();
        const name = label(el);

        // 2. A control hangs off the left or right edge.
        if ((r.right > vw + 2 || r.left < -2) && !inScroller(el)) {
          problems.push({ kind: 'control_offscreen', what: name, detail: `cut off at the screen edge (x ${Math.round(r.left)}–${Math.round(r.right)}, screen ${vw}px)` });
          continue;
        }

        // 3. Something else sits on top of it. Only judged when it is on screen.
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cy > 0 && cy < vh && cx > 0 && cx < vw) {
          const top = document.elementFromPoint(cx, cy);
          if (top && top !== el && !el.contains(top) && !top.contains(el)) {
            // A <label> over its own input is how custom checkboxes are built.
            const ownLabel = top.tagName === 'LABEL' && ((top as HTMLLabelElement).control === el || top.contains(el));
            if (!ownLabel) problems.push({ kind: 'control_covered', what: name, detail: `covered by ${label(top)}, so a tap lands on that instead` });
          }
        }

        // 4. Too small to hit with a finger (touch layouts only).
        if (vw < narrowBelow) {
          const inlineTextLink = el.tagName === 'A' && getComputedStyle(el).display === 'inline';
          if (!inlineTextLink && (r.width < minTarget || r.height < minTarget)) {
            problems.push({ kind: 'small_tap_target', what: name, detail: `${Math.round(r.width)}×${Math.round(r.height)}px, below the ${minTarget}×${minTarget}px minimum` });
          }
        }
      }

      return { problems, checked: controls.length, vw, vh };
    },
    { narrowBelow: NARROW, minTarget: MIN_TARGET },
  );

  const problems = raw.problems as LayoutOutcome['problems'];
  return {
    problems,
    offenders: problems.map((p) => ({ what: p.what, detail: p.detail })),
    unverified: [],
    checked: raw.checked + 1, // the page itself is always checked for overflow
    viewport: { width: raw.vw, height: raw.vh },
  };
}

const KIND_LABEL: Record<LayoutProblem, string> = {
  page_overflow: 'Page scrolls sideways',
  control_offscreen: 'Control cut off at the screen edge',
  control_covered: 'Control covered by another element',
  small_tap_target: 'Tap target too small',
};

/** Layout problems as findings for the observer, one per problem and element. */
export function layoutFindings(outcome: LayoutOutcome, url: string) {
  const size = `${outcome.viewport.width}px wide`;
  return outcome.problems.map((p) => ({
    key: `layout:${p.kind}:${outcome.viewport.width}:${p.what}`,
    kind: p.kind === 'page_overflow' ? ('layout_overflow' as const) : p.kind,
    severity: p.kind === 'small_tap_target' ? ('low' as const) : ('medium' as const),
    summary: `${KIND_LABEL[p.kind]} at ${size}: ${p.what}`,
    detail: p.detail,
    url,
  }));
}
