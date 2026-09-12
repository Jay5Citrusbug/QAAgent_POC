import type { Page } from '@playwright/test';
import type { TargetSpec } from './types.js';

/**
 * What a tester does when a control isn't where they expected.
 *
 * The executor used to say "could not identify X" and stop. That is true and
 * useless: it cannot tell you whether the feature is broken, the control was
 * renamed, or the mission described something that never existed — and those
 * three need completely different responses.
 *
 * A human, at that moment, looks at the page. If they were hunting "Add to
 * Cart" and the page says "Buy Now", they know instantly. This does the same
 * thing: list what is actually there, ranked by how close it is to what was
 * wanted.
 *
 * Deliberately no model involved. Most of the value is in simply *looking*,
 * and a deterministic answer costs nothing and never hallucinates a control.
 */

export interface Candidate {
  role: string;
  name: string;
  similarity: number;
  region: string;
}

/** Levenshtein distance, iterative, small strings only. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = curr;
  }
  return prev[b.length] ?? 0;
}

/**
 * Blend edit distance with word overlap. "Add to Cart" vs "Add to Basket"
 * shares two words but edits badly; "Cart" vs "Carts" edits well but shares
 * none. Either signal alone misses obvious renames.
 */
export function similarity(a: string, b: string): number {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (!x || !y) return 0;
  if (x === y) return 1;

  const edit = 1 - distance(x, y) / Math.max(x.length, y.length);

  const wordsA = new Set(x.split(/\W+/).filter(Boolean));
  const wordsB = new Set(y.split(/\W+/).filter(Boolean));
  const shared = [...wordsA].filter((w) => wordsB.has(w)).length;
  const overlap = shared === 0 ? 0 : (2 * shared) / (wordsA.size + wordsB.size);

  const containment = x.includes(y) || y.includes(x) ? 0.75 : 0;

  return Math.max(edit, overlap, containment);
}

/** Every interactive control currently on the page, with its accessible name. */
export async function readControls(page: Page): Promise<{ role: string; name: string; region: string }[]> {
  try {
    // No named inner functions in here — the loader rewrites them with a
    // `__name` helper that does not exist in page context.
    return await page.locator('body').evaluate((root: Element) => {
      const out: { role: string; name: string; region: string }[] = [];
      const selector =
        'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"]';

      for (const el of Array.from(root.querySelectorAll(selector))) {
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (el.getAttribute('aria-hidden') === 'true') continue;

        const tag = el.tagName.toLowerCase();
        let role = el.getAttribute('role') || '';
        if (!role) {
          if (tag === 'a') role = 'link';
          else if (tag === 'button') role = 'button';
          else if (tag === 'select') role = 'combobox';
          else if (tag === 'textarea') role = 'textbox';
          else if (tag === 'input') {
            const t = (el as HTMLInputElement).type;
            role = t === 'checkbox' ? 'checkbox' : t === 'radio' ? 'radio' : t === 'submit' ? 'button' : 'textbox';
          }
        }

        let name = el.getAttribute('aria-label') || '';
        if (!name) name = el.getAttribute('title') || '';
        if (!name) name = (el.textContent || '').trim();
        if (!name) {
          const img = el.querySelector('img[alt]');
          name = img ? img.getAttribute('alt') || '' : '';
        }
        if (!name) name = el.getAttribute('placeholder') || '';
        name = name.replace(/\s+/g, ' ').trim().slice(0, 60);

        const region = el.closest('nav')
          ? 'nav'
          : el.closest('footer')
            ? 'footer'
            : el.closest('header')
              ? 'header'
              : el.closest('main')
                ? 'main'
                : 'page';

        out.push({ role, name, region });
      }
      return out;
    });
  } catch {
    return [];
  }
}

/**
 * Rank what is on the page against what the mission wanted.
 *
 * Same-role candidates are preferred, but a strong name match in another role
 * is still surfaced — a control changing from <button> to <a> is a common
 * refactor and exactly the kind of rename worth spotting.
 */
export async function findNearMisses(page: Page, target: TargetSpec, limit = 4): Promise<Candidate[]> {
  const wanted = (target.name ?? target.text ?? target.label ?? target.description ?? '').trim();
  if (!wanted) return [];

  const controls = await readControls(page);
  const seen = new Set<string>();
  const scored: Candidate[] = [];

  for (const c of controls) {
    if (!c.name) continue;
    const key = `${c.role}|${c.name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const base = similarity(wanted, c.name);
    // A role match is corroboration, not proof; weight it rather than filter on it.
    const score = target.role && c.role === target.role ? Math.min(1, base + 0.1) : base;
    if (score < 0.34) continue;
    scored.push({ role: c.role, name: c.name, similarity: Number(score.toFixed(2)), region: c.region });
  }

  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

export function describeNearMisses(target: TargetSpec, candidates: Candidate[], totalControls: number): string {
  const wanted = target.name ?? target.text ?? target.label ?? target.description;
  if (candidates.length === 0) {
    return (
      `Nothing on the page resembles "${wanted}". ` +
      `${totalControls} interactive control(s) were present, none a plausible match — ` +
      `so this is more likely a missing feature or a wrong page than a renamed control.`
    );
  }
  const list = candidates
    .map((c) => `${c.role} "${c.name}" in ${c.region} (${Math.round(c.similarity * 100)}% similar)`)
    .join('; ');
  const top = candidates[0];
  const strong = top && top.similarity >= 0.6;
  return (
    `Nothing matched "${wanted}", but the page does have: ${list}. ` +
    (strong
      ? `"${top?.name}" is close enough that this looks like a rename — check before treating it as a defect.`
      : `None is a confident match, so treat this as a real absence until a human confirms otherwise.`)
  );
}
