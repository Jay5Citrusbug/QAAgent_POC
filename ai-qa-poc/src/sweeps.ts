import type { Locator, Page } from '@playwright/test';

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

/**
 * Every form field is programmatically labelled.
 *
 * Distinct from `sweepAccessibleNames`, which covers controls generally. A
 * placeholder is the common shortcut here and it is not a label: it disappears
 * the moment the user types, so anyone who looks away loses what the field was
 * for. It is accepted as a name by the control sweep and rejected here, and
 * that difference is the point.
 */
export async function sweepFieldLabels(scope: Locator): Promise<SweepOutcome> {
  // Runs in page context — no named inner functions, see the note above.
  return scope.evaluate((root: Element) => {
    const fields = Array.from(
      root.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea'),
    ) as HTMLElement[];
    const offenders: { what: string; detail: string }[] = [];
    const unverified: { what: string; detail: string }[] = [];

    for (const el of fields) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;

      let labelled = false;

      const aria = el.getAttribute('aria-label');
      if (aria && aria.trim()) labelled = true;

      if (!labelled && el.getAttribute('aria-labelledby')) {
        for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/)) {
          const ref = el.ownerDocument.getElementById(id);
          if (ref && ref.textContent && ref.textContent.trim()) {
            labelled = true;
            break;
          }
        }
      }

      if (!labelled) {
        const id = el.getAttribute('id');
        if (id) {
          const labels = Array.from(el.ownerDocument.querySelectorAll('label'));
          for (const lb of labels) {
            if ((lb as HTMLLabelElement).htmlFor === id && lb.textContent && lb.textContent.trim()) {
              labelled = true;
              break;
            }
          }
        }
      }

      if (!labelled) {
        const wrapping = el.closest('label');
        if (wrapping && wrapping.textContent && wrapping.textContent.trim()) labelled = true;
      }

      if (labelled) continue;

      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || tag;
      const placeholder = el.getAttribute('placeholder');
      const name = el.getAttribute('name') || el.getAttribute('id') || '(no name)';

      offenders.push({
        what: '<' + tag + ' type="' + type + '"> ' + name,
        detail: placeholder
          ? 'only a placeholder ("' + placeholder + '") — it vanishes on typing, so it is not a label'
          : 'no label, aria-label, aria-labelledby or wrapping <label>',
      });
    }

    return { offenders, unverified, checked: fields.length };
  });
}

/**
 * No two controls share an accessible name.
 *
 * This is a testability defect as much as a usability one: a duplicated name
 * is exactly what makes `discovery.ts` refuse to resolve a target, so every
 * duplicate introduced today is a binding that stops working tomorrow. Catching
 * it here means it surfaces as one line in a report rather than as a mystery
 * BLOCKED result in a run.
 */
export async function sweepDuplicateNames(scope: Locator): Promise<SweepOutcome> {
  return scope.evaluate((root: Element) => {
    const selector = 'button, a[href], [role="button"], [role="link"], [role="tab"]';
    const controls = Array.from(root.querySelectorAll(selector)) as HTMLElement[];
    const seen = new Map<string, number>();
    const offenders: { what: string; detail: string }[] = [];
    const unverified: { what: string; detail: string }[] = [];

    for (const el of controls) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;

      const aria = el.getAttribute('aria-label');
      const text = aria && aria.trim() ? aria.trim() : (el.textContent || '').trim();
      if (!text) continue; // The unlabelled sweep owns this case.

      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      const key = role + '\u0000' + text.toLowerCase();
      seen.set(key, (seen.get(key) || 0) + 1);
    }

    for (const entry of Array.from(seen.entries())) {
      const key = entry[0];
      const count = entry[1];
      if (count < 2) continue;
      const parts = key.split('\u0000');
      offenders.push({
        what: parts[0] + ' "' + parts[1] + '"',
        detail:
          count +
          ' elements share this name, so a target naming it cannot resolve without a "within" scope',
      });
    }

    return { offenders, unverified, checked: controls.length };
  });
}

/**
 * Every link points somewhere that answers.
 *
 * The one sweep here that touches the network, so it is the one most able to
 * waste time and annoy a server. Bounded accordingly: same-origin only, unique
 * URLs only, capped, and a HEAD request rather than a fetch of the body.
 *
 * Anything that is not a clear 4xx/5xx is reported as unverified rather than
 * failed. A timeout is about the network between us and the page; calling it a
 * broken link would be the kind of false positive that gets a sweep muted.
 */
export async function sweepDeadLinks(page: Page, scope: Locator, cap = 40): Promise<SweepOutcome> {
  const hrefs: string[] = await scope.evaluate((root: Element) => {
    const links = Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    const out: string[] = [];
    for (const a of links) {
      const raw = a.getAttribute('href') || '';
      if (!raw || raw.startsWith('#') || /^(mailto|tel|javascript):/i.test(raw)) continue;
      out.push(a.href); // resolved absolute
    }
    return out;
  });

  const origin = new URL(page.url()).origin;
  const unique = Array.from(new Set(hrefs)).filter((h) => {
    try {
      return new URL(h).origin === origin;
    } catch {
      return false;
    }
  });

  const offenders: Offender[] = [];
  const unverified: Offender[] = [];
  const chosen = unique.slice(0, cap);

  for (const url of chosen) {
    try {
      const res = await page.request.head(url, { timeout: 8000, failOnStatusCode: false });
      const status = res.status();
      if (status >= 400) {
        offenders.push({ what: url, detail: `HTTP ${status}` });
      }
    } catch (err) {
      unverified.push({
        what: url,
        detail: `no answer (${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — network, not necessarily the link`,
      });
    }
  }

  if (unique.length > chosen.length) {
    unverified.push({
      what: `${unique.length - chosen.length} more link(s)`,
      detail: `beyond the per-page cap of ${cap}`,
    });
  }

  return { offenders, unverified, checked: chosen.length };
}

export function describeSweep(kind: string, outcome: SweepOutcome): string {
  const parts = [`${outcome.checked} checked`, `${outcome.offenders.length} failing`];
  if (outcome.unverified.length) parts.push(`${outcome.unverified.length} unverified`);
  const head = `${kind}: ${parts.join(', ')}`;
  if (!outcome.offenders.length) return head;
  const list = outcome.offenders.map((o) => `    - ${o.what} — ${o.detail}`).join('\n');
  return `${head}\n${list}`;
}
