import type { Locator } from '@playwright/test';

/**
 * Property sweeps.
 *
 * A normal assertion checks one named element. A sweep checks one *property*
 * across every element that has it — every image loads, every control has a
 * label — so it catches a whole class of defect without anyone predicting each
 * instance.
 *
 * This is the answer to "the test suite only finds what someone thought to
 * look for". A per-element mission for the logo missed the broken logo because
 * it used the wrong check; a sweep would have caught it, plus every other
 * broken image on the page, from one mission nobody had to write per element.
 *
 * The hard requirement here is **no false positives**. A sweep that cries wolf
 * gets muted, and a muted check is worse than no check at all. So anything
 * genuinely undecidable is reported as unverified rather than failed.
 */

export interface Offender {
  what: string;
  detail: string;
}

export interface SweepOutcome {
  offenders: Offender[];
  /** Elements that could not be judged either way — reported, never failed. */
  unverified: Offender[];
  checked: number;
}

/**
 * Every <img> that finished loading has real pixels.
 *
 * `complete && naturalWidth === 0` is the precise signal: the browser finished
 * the attempt and got nothing. A lazy image that has not loaded yet has
 * `complete === false`, so it is counted as unverified rather than broken —
 * which is why scrolling state cannot produce a phantom failure here.
 */
export async function sweepImages(scope: Locator): Promise<SweepOutcome> {
  return scope.evaluate((root: Element) => {
    const imgs = Array.from(root.querySelectorAll('img')) as HTMLImageElement[];
    const offenders: { what: string; detail: string }[] = [];
    const unverified: { what: string; detail: string }[] = [];

    for (const img of imgs) {
      const src = img.currentSrc || img.getAttribute('src') || '(no src)';
      const label = img.getAttribute('alt')?.trim() || img.className || '<img>';

      // Hidden images are not part of what the user sees; judging them
      // produces noise about markup that never renders.
      const style = window.getComputedStyle(img);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      if (!img.getAttribute('src') && !img.currentSrc) {
        offenders.push({ what: label, detail: 'image element has no src at all' });
        continue;
      }
      if (!img.complete) {
        unverified.push({ what: label, detail: `still loading (lazy or slow): ${src}` });
        continue;
      }
      if (img.naturalWidth === 0) {
        offenders.push({ what: label, detail: `failed to load (naturalWidth=0): ${src}` });
      }
    }

    return { offenders, unverified, checked: imgs.length };
  });
}

/**
 * Every interactive control exposes an accessible name.
 *
 * Deliberately conservative — it resolves `<label for>`, wrapping labels,
 * aria-label, aria-labelledby, title, and the alt text of a single child image
 * before calling anything unlabelled, because each of those is a legitimate way
 * to name a control and flagging them would be wrong.
 */
export async function sweepAccessibleNames(scope: Locator): Promise<SweepOutcome> {
  // NOTE: everything below runs inside the browser. Do not introduce named
  // inner functions here — the TypeScript loader rewrites them with a `__name`
  // helper that does not exist in page context, and the sweep dies with
  // "ReferenceError: __name is not defined". Keep the logic inline.
  return scope.evaluate((root: Element) => {
    const selector =
      'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"]';
    const controls = Array.from(root.querySelectorAll(selector)) as HTMLElement[];
    const offenders: { what: string; detail: string }[] = [];
    const unverified: { what: string; detail: string }[] = [];

    for (const el of controls) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;

      // Resolve the accessible name the same way assistive tech would, trying
      // every legitimate mechanism before calling a control unlabelled.
      let name = '';

      const aria = el.getAttribute('aria-label');
      if (aria && aria.trim()) name = aria.trim();

      if (!name) {
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const parts: string[] = [];
          for (const id of labelledBy.split(/\s+/)) {
            const ref = el.ownerDocument.getElementById(id);
            const t = ref && ref.textContent ? ref.textContent.trim() : '';
            if (t) parts.push(t);
          }
          if (parts.length) name = parts.join(' ');
        }
      }

      if (!name) {
        const id = el.getAttribute('id');
        if (id) {
          // Compare htmlFor directly: no selector string, so no escaping
          // of exotic ids is needed and nothing can be mis-quoted.
          const labels = Array.from(el.ownerDocument.querySelectorAll('label'));
          for (const lb of labels) {
            const htmlFor = (lb as HTMLLabelElement).htmlFor;
            if (htmlFor === id && lb.textContent && lb.textContent.trim()) {
              name = lb.textContent.trim();
              break;
            }
          }
        }
      }

      if (!name) {
        const wrapping = el.closest('label');
        if (wrapping && wrapping.textContent && wrapping.textContent.trim()) {
          name = wrapping.textContent.trim();
        }
      }

      if (!name) {
        const title = el.getAttribute('title');
        if (title && title.trim()) name = title.trim();
      }

      if (!name && el.textContent && el.textContent.trim()) name = el.textContent.trim();

      if (!name) {
        // An icon-only control is still named if its image carries alt text.
        const img = el.querySelector('img[alt]');
        const alt = img ? img.getAttribute('alt') : null;
        if (alt && alt.trim()) name = alt.trim();
      }

      if (!name) {
        const input = el as HTMLInputElement;
        if (input.type === 'submit' && input.value && input.value.trim()) name = input.value.trim();
      }

      if (!name) {
        const placeholder = el.getAttribute('placeholder');
        if (placeholder && placeholder.trim()) name = placeholder.trim();
      }

      if (name) continue;

      const tag = el.tagName.toLowerCase();
      const href = el.getAttribute('href');
      const cls = (el.getAttribute('class') || '').slice(0, 60);
      const hasIcon = Boolean(el.querySelector('svg, img, i'));

      const bits: string[] = [];
      if (href) bits.push('href="' + href + '"');
      bits.push(hasIcon ? 'icon-only' : 'no content');
      if (cls) bits.push('class="' + cls + '"');

      offenders.push({ what: '<' + tag + '>', detail: bits.join(' - ') });
    }

    return { offenders, unverified, checked: controls.length };
  });
}

export function describeSweep(kind: string, outcome: SweepOutcome): string {
  const parts = [`${outcome.checked} checked`, `${outcome.offenders.length} failing`];
  if (outcome.unverified.length) parts.push(`${outcome.unverified.length} unverified`);
  const head = `${kind}: ${parts.join(', ')}`;
  if (!outcome.offenders.length) return head;
  const list = outcome.offenders.map((o) => `    - ${o.what} — ${o.detail}`).join('\n');
  return `${head}\n${list}`;
}
