import { chromium, type Page } from '@playwright/test';
import { readPage, type PageReality } from './inspector.js';
import type { TestIntent } from './types.js';

/**
 * Capture the states a user actually reaches, not just the pages they land on.
 *
 * `npm run inspect` opens each page in the application context and records what
 * is there. That is a snapshot of every page in its *initial* state, and a
 * large class of UI simply does not exist in that state:
 *
 *   - the checkout form, which only renders once the cart has something in it
 *   - a validation message, which only appears after a bad submit
 *   - a filtered product grid, which only exists after a filter is applied
 *
 * On the first real requirement this was the single biggest reason approved
 * tests never ran: the capture of `/checkout` contained the words "Your cart is
 * empty" and no form at all, so every checkout test looked for controls the
 * system had never seen and was correctly told they do not exist.
 *
 * ## Why this needs no new configuration
 *
 * The flows are already written down. An intent's steps say "add a product to
 * the cart", "proceed to checkout" — that IS the path to the checkout form. So
 * rather than asking a QA Lead to hand-author capture scenarios per feature
 * (which would be per-feature work, in a second vocabulary, kept in step by
 * hand), this walks the steps the intents already describe and records what
 * appears along the way.
 *
 * A new requirement therefore gets flow capture for free: write intents as
 * normal, and the states those intents need become visible to binding.
 *
 * ## Deliberately best-effort
 *
 * A step that resolves to nothing is stepped over, and a click that throws ends
 * that walk. Whatever states were reached before that point are still captured
 * and are still strictly more than a default-state snapshot. It never fails the
 * inspection, because a flow that cannot be walked is exactly the situation
 * this is trying to improve, and refusing to record the first two steps because
 * the third failed would throw away the evidence.
 *
 * Nothing here asserts anything. It observes.
 */

export interface CapturedState {
  /** Which intent's steps produced it, for traceability. */
  from: string;
  /** How far along that intent's steps this state is. */
  afterStep: string;
  /** The step text, so a human reading the capture knows what was done. */
  did: string;
  page: PageReality;
}

/** Verbs that change what is on screen — worth capturing after. */
const STATE_CHANGING = /\b(add|open|go to|proceed|submit|place|apply|filter|narrow|choose|select|complete|reload|refresh|search)\b/i;

/**
 * What kind of move a step describes — not which control it means.
 *
 * Only the shape of the action is read here (navigate, reload, click, or
 * nothing worth capturing). Which control to click is settled against the page
 * itself in bestControlFor, because the page knows its own vocabulary and this
 * sentence does not.
 */
function intentionOf(text: string): { kind: 'click' | 'navigate' | 'reload' | 'skip' } {
  const t = text.toLowerCase();
  if (/\b(reload|refresh)\b/.test(t)) return { kind: 'reload' };
  if (/\b(arrive|land on|visit|go straight to)\b/.test(t)) return { kind: 'navigate' };
  if (!STATE_CHANGING.test(t)) return { kind: 'skip' };
  return { kind: 'click' };
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'with', 'that', 'is', 'are', 'as', 'at',
  'in', 'on', 'by', 'it', 'its', 'this', 'these', 'from', 'into', 'then', 'their',
  'shopper', 'user', 'actor', 'anonymous', 'page', 'product', 'products', 'first', 'second',
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Which control on the page best matches what the step describes.
 *
 * Guessing a name from the wording went wrong in the obvious way: "add the
 * product to the cart" produced the hint "cart", which matched the Cart *link*
 * and navigated away instead of adding anything — so every flow ended one step
 * in, having silently done the wrong thing.
 *
 * Scoring the step against the accessible names actually on the page is both
 * more reliable and domain-neutral: nothing here knows what a cart is. A step
 * mentioning "add" and "cart" scores "Add to Cart" above "Cart" because it
 * shares more of the sentence, and the same logic works for any product's
 * vocabulary.
 */
async function bestControlFor(page: Page, text: string): Promise<{ role: string; name: string } | undefined> {
  const wanted = words(text);
  if (wanted.length === 0) return undefined;

  const controls = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll('button, a[href], [role="button"], [role="link"], [role="tab"]'),
    ) as HTMLElement[];
    const out: { role: string; name: string }[] = [];
    for (const el of nodes) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const aria = el.getAttribute('aria-label');
      const name = (aria && aria.trim()) || (el.textContent || '').trim();
      if (!name || name.length > 80) continue;
      const tag = el.tagName.toLowerCase();
      out.push({ role: el.getAttribute('role') || (tag === 'a' ? 'link' : 'button'), name });
    }
    return out;
  });

  let best: { role: string; name: string } | undefined;
  let bestScore = 0;
  for (const c of controls) {
    const nameWords = words(c.name);
    if (nameWords.length === 0) continue;
    const shared = nameWords.filter((w) => wanted.includes(w)).length;
    // Fraction of the control's own name that the step mentions, so a short
    // exact match ("Cart") does not beat a fuller one ("Add to Cart").
    const score = shared / nameWords.length + shared * 0.1;
    if (shared > 0 && score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= 0.5 ? best : undefined;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(350);
}

/**
 * Walk one intent's steps, recording the page after each state change.
 */
async function walkIntent(
  page: Page,
  intent: TestIntent,
  baseUrl: string,
): Promise<CapturedState[]> {
  const states: CapturedState[] = [];

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);

  for (const step of intent.steps) {
    const intention = intentionOf(step.actor_intent);
    if (intention.kind === 'skip') continue;

    try {
      if (intention.kind === 'navigate') {
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      } else if (intention.kind === 'reload') {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
      } else {
        const control = await bestControlFor(page, step.actor_intent);
        if (!control) continue; // nothing on this page answers to that step
        await page
          .getByRole(control.role as 'button', { name: control.name, exact: true })
          .first()
          .click({ timeout: 8000 });
      }

      await settle(page);
      states.push({
        from: intent.test_id,
        afterStep: step.id,
        did: step.actor_intent,
        page: await readPage(page, page.url()),
      });
    } catch {
      // This walk goes no further. What it already reached still counts.
      break;
    }
  }

  return states;
}

/**
 * Deduplicate by what the state actually contains.
 *
 * Many intents share a prefix ("add a product, open the cart"), so the same
 * state is reached repeatedly. Keeping one copy of each distinct state keeps
 * the capture small and keeps the binder from scoring the same control twice.
 */
function signatureOf(p: PageReality): string {
  return [
    p.url,
    p.controls.map((c) => `${c.role}:${c.name}:${c.count}`).sort().join('|'),
    p.headings.map((h) => h.text).sort().join('|'),
  ].join('::');
}

export async function captureFlows(
  intents: TestIntent[],
  baseUrl: string,
  options: { headless?: boolean; maxIntents?: number } = {},
): Promise<CapturedState[]> {
  if (intents.length === 0) return [];

  const browser = await chromium.launch({ headless: options.headless ?? true });
  const out: CapturedState[] = [];
  const seen = new Set<string>();

  try {
    // Longest flows first: they reach the deepest states, and shorter flows
    // that share a prefix then add nothing new and are skipped by the dedupe.
    const ordered = [...intents].sort((a, b) => b.steps.length - a.steps.length);

    for (const intent of ordered.slice(0, options.maxIntents ?? 12)) {
      // A fresh context each time, so one flow's cart never leaks into the next.
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();

      const states = await walkIntent(page, intent, baseUrl);
      for (const state of states) {
        const sig = signatureOf(state.page);
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(state);
      }

      await context.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  return out;
}
