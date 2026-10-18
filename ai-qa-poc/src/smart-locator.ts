import type { Locator, Page } from '@playwright/test';
import { z } from 'zod';
import { aiAvailable, askStructured } from './ai-client.js';
import type { Confidence, ResolutionStrategy, TargetSpec } from './types.js';

/**
 * What the executor tries once the exact descriptor found nothing.
 *
 * Test cases are written before the application exists, so the words in a
 * test case and the words on the shipped page drift apart: the requirement
 * says "Log in", the developer wrote "Sign In", the designer made it
 * "SIGN IN →". A tester reads all three as the same button. This module
 * lets the executor do the same, in three tiers of rising risk:
 *
 *   1. fuzzy     same words, ignoring case, spacing, hyphens and decoration
 *   2. synonym   a known equivalent phrase ("log in" ↔ "sign in")
 *   3. ai        Claude picks from the controls actually on the page
 *
 * The rule that has always governed resolution still holds: never silently
 * pick. Every tier records what it did and why; tiers 1–2 only accept a single
 * visible match; tier 3 must give a reason and a confidence, and a low-confidence
 * answer is refused. The report then shows the element that was chosen,
 * highlighted, so a human can see at a glance whether it was the right one.
 */

export interface SmartMatch {
  locator: Locator;
  all: Locator;
  count: number;
  strategy: ResolutionStrategy;
  confidence: Confidence;
  description: string;
  /** Plain-language account of the decision, shown in the report. */
  note: string;
}

// --- tier 1: tolerant wording ------------------------------------------------

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "Sign in" → /^\W*sign[\s\-_]*in\W*$/i — the same words and nothing else. */
export function tolerantPattern(name: string): RegExp | undefined {
  const t = tokens(name);
  if (t.length === 0) return undefined;
  return new RegExp(`^[^\\p{L}\\p{N}]*${t.map(escapeRe).join('[\\s\\-_./]*')}[^\\p{L}\\p{N}]*$`, 'iu');
}

// --- tier 2: equivalent phrases ----------------------------------------------

/**
 * Phrases a user treats as interchangeable. Deliberately conservative: every
 * group here is one a tester would accept without asking. "Save" is not
 * "Submit"; "Account" alone is not "Profile".
 */
export const SYNONYM_GROUPS: string[][] = [
  ['sign in', 'log in', 'login', 'signin', 'log on', 'logon'],
  ['sign out', 'log out', 'logout', 'signout', 'log off'],
  ['sign up', 'register', 'create account', 'create an account', 'signup'],
  ['forgot password', 'forgot your password', 'reset password', 'forgotten password'],
  ['add to cart', 'add to basket', 'add to bag'],
  ['cart', 'basket', 'shopping cart', 'shopping bag'],
  ['checkout', 'check out', 'proceed to checkout'],
  ['submit', 'send'],
  ['search', 'find'],
  ['next', 'continue', 'proceed'],
  ['back', 'previous', 'go back'],
  ['cancel', 'dismiss'],
  ['close', 'dismiss'],
  ['delete', 'remove'],
  ['edit', 'modify'],
  ['email', 'e-mail', 'email address', 'e-mail address'],
  ['password', 'passcode'],
  ['username', 'user name', 'user id', 'login id'],
  ['home', 'homepage', 'home page'],
  ['settings', 'preferences'],
  ['my account', 'profile', 'my profile'],
];

/** Every alternative wording of `name`, substituting whole phrases only. */
export function synonymNames(name: string): string[] {
  const norm = ` ${tokens(name).join(' ')} `;
  const out = new Set<string>();
  for (const group of SYNONYM_GROUPS) {
    for (const phrase of group) {
      const p = ` ${tokens(phrase).join(' ')} `;
      if (!norm.includes(p)) continue;
      for (const alt of group) {
        if (alt === phrase) continue;
        out.add(norm.replace(p, ` ${alt} `).trim());
      }
    }
  }
  out.delete(tokens(name).join(' '));
  return [...out];
}

// --- shared: build and test candidate locators --------------------------------

type Scope = Page | Locator;

/**
 * Candidate locators for `name`. Descriptions are written for the report —
 * "label ≈ "e-mail address"" rather than the regex, which nobody can read.
 */
function locatorsFor(scope: Scope, t: TargetSpec, name: string): { loc: Locator; desc: string }[] {
  const re = tolerantPattern(name);
  if (!re) return [];
  const shown = `≈ "${name}"`;
  const out: { loc: Locator; desc: string }[] = [];
  if (t.role) {
    out.push({
      loc: scope.getByRole(t.role as Parameters<Page['getByRole']>[0], { name: re }),
      desc: `${t.role} ${shown}`,
    });
  }
  if (t.label || (!t.role && !t.placeholder && !t.text)) {
    out.push({ loc: scope.getByLabel(re), desc: `label ${shown}` });
  }
  if (t.placeholder) out.push({ loc: scope.getByPlaceholder(re), desc: `placeholder ${shown}` });
  if (t.text || !t.role) out.push({ loc: scope.getByText(re), desc: `text ${shown}` });
  // A button described by role is often written as a link, and vice versa.
  if (t.role === 'button' || t.role === 'link') {
    const other = t.role === 'button' ? 'link' : 'button';
    out.push({ loc: scope.getByRole(other, { name: re }), desc: `${other} ${shown}` });
  }
  return out;
}

/**
 * Exactly one visible match, or nothing. Ambiguity is never resolved here.
 *
 * No waiting: these tiers run only after the exact tier has already waited for
 * the page, so what is there now is what there is. Waiting per candidate made
 * a single synonym lookup take over ten seconds.
 */
async function single(loc: Locator, _timeoutMs: number): Promise<{ loc: Locator; count: number } | undefined> {
  const visible = loc.filter({ visible: true });
  const n = await visible.count();
  return n === 1 ? { loc: visible.first(), count: 1 } : undefined;
}

function wanted(t: TargetSpec): string | undefined {
  return t.name ?? t.label ?? t.placeholder ?? t.text;
}

export async function fuzzyMatch(scope: Scope, t: TargetSpec, timeoutMs: number): Promise<SmartMatch | undefined> {
  const name = wanted(t);
  if (!name) return undefined;
  for (const { loc, desc } of locatorsFor(scope, t, name)) {
    const hit = await single(loc, timeoutMs);
    if (hit) {
      return {
        locator: hit.loc,
        all: loc,
        count: hit.count,
        strategy: 'fuzzy',
        confidence: 'MEDIUM',
        description: desc,
        note: `Exact name "${name}" not found; matched the same words ignoring case, spacing and punctuation.`,
      };
    }
  }
  return undefined;
}

export async function synonymMatch(scope: Scope, t: TargetSpec, timeoutMs: number): Promise<SmartMatch | undefined> {
  const name = wanted(t);
  if (!name) return undefined;
  for (const alt of synonymNames(name)) {
    for (const { loc, desc } of locatorsFor(scope, t, alt)) {
      const hit = await single(loc, timeoutMs);
      if (hit) {
        return {
          locator: hit.loc,
          all: loc,
          count: hit.count,
          strategy: 'synonym',
          confidence: 'MEDIUM',
          description: desc,
          note: `"${name}" not found; matched the equivalent wording "${alt}".`,
        };
      }
    }
  }
  return undefined;
}

// --- tier 3: Claude chooses from what is actually there ------------------------

interface PageControl {
  i: number;
  tag: string;
  role: string;
  name: string;
  type: string;
  region: string;
  disabled: boolean;
}

const MARK = 'data-qa-candidate';

/** Every visible interactive control, tagged so the chosen one can be addressed. */
async function listControls(page: Page): Promise<PageControl[]> {
  return page.evaluate((mark: string) => {
    // No named inner functions here — tsx rewrites them with a helper that
    // does not exist in page context.
    for (const el of Array.from(document.querySelectorAll(`[${mark}]`))) el.removeAttribute(mark);
    const selector =
      'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="combobox"], [role="switch"], [contenteditable="true"]';
    const out: { i: number; tag: string; role: string; name: string; type: string; region: string; disabled: boolean }[] = [];
    let i = 0;
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') continue;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      let role = el.getAttribute('role') ?? '';
      if (!role) {
        if (tag === 'a') role = 'link';
        else if (tag === 'button' || ['submit', 'button', 'reset'].includes(type)) role = 'button';
        else if (tag === 'select') role = 'combobox';
        else if (tag === 'textarea') role = 'textbox';
        else if (type === 'checkbox') role = 'checkbox';
        else if (type === 'radio') role = 'radio';
        else if (tag === 'input') role = type === 'password' ? 'password field' : 'textbox';
        else role = tag;
      }
      let name = el.getAttribute('aria-label') ?? '';
      const labelledBy = el.getAttribute('aria-labelledby');
      if (!name && labelledBy) name = document.getElementById(labelledBy)?.textContent ?? '';
      const id = el.getAttribute('id');
      if (!name && id) name = document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent ?? '';
      if (!name) name = el.closest('label')?.textContent ?? '';
      if (!name) name = el.getAttribute('placeholder') ?? '';
      if (!name && tag === 'input') name = (el as HTMLInputElement).value ?? '';
      if (!name) name = (el as HTMLElement).innerText ?? el.textContent ?? '';
      if (!name) name = el.getAttribute('title') ?? el.querySelector('img')?.getAttribute('alt') ?? '';
      const region =
        el.closest('header, nav, main, footer, aside, form, dialog, [role="dialog"]')?.tagName.toLowerCase() ?? 'page';
      el.setAttribute(mark, String(i));
      out.push({
        i,
        tag,
        role,
        name: name.replace(/\s+/g, ' ').trim().slice(0, 80),
        type,
        region,
        disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
      });
      i += 1;
      if (i >= 200) break;
    }
    return out;
  }, MARK);
}

const Pick = z.object({
  index: z.number().int().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string(),
});

const SYSTEM = `You locate one UI control for an automated functional test.
You are given what the test step wants and the list of visible controls on the page.
Pick the single control a careful human tester would use for this step.
Rules:
- Equivalent wording counts ("Log in" = "Sign in", "Basket" = "Cart"; case and punctuation do not matter).
- A control that does something different is NOT a match, however similar the words ("Sign up" is not "Sign in"; "Save draft" is not "Submit").
- If two controls fit equally, or none fits, return index null. Refusing is correct; guessing produces false test results.
- confidence "high" only when there is exactly one clear match.`;

export async function aiMatch(
  page: Page,
  t: TargetSpec,
  intent: string | undefined,
): Promise<SmartMatch | { refused: string } | undefined> {
  if (!aiAvailable()) return undefined;
  const controls = await listControls(page);
  if (controls.length === 0) return { refused: 'no visible controls on the page' };

  const prompt = [
    `Page: ${await page.title()} (${page.url()})`,
    `Test step: ${intent ?? '(not given)'}`,
    `Wanted control: ${t.description}`,
    `Descriptor hints: ${JSON.stringify({ role: t.role, name: t.name, label: t.label, placeholder: t.placeholder, text: t.text })}`,
    '',
    'Visible controls (index | role | name | region | disabled):',
    ...controls.map((c) => `${c.i} | ${c.role}${c.type ? `[${c.type}]` : ''} | ${c.name || '(no name)'} | ${c.region}${c.disabled ? ' | disabled' : ''}`),
  ].join('\n');

  const answer = await askStructured(Pick, SYSTEM, prompt);
  if (!answer.ok) return { refused: `AI resolver unavailable: ${answer.error}` };
  const { index, confidence, reason } = answer.value;
  if (index === null || !controls.some((c) => c.i === index)) {
    return { refused: `AI found no matching control: ${reason}` };
  }
  if (confidence === 'low') return { refused: `AI match too uncertain to act on: ${reason}` };

  const chosen = controls.find((c) => c.i === index)!;
  const loc = page.locator(`[${MARK}="${index}"]`);
  if ((await loc.count()) !== 1) return { refused: 'the chosen control disappeared before it could be used' };

  return {
    locator: loc,
    all: loc,
    count: 1,
    strategy: 'ai',
    // Never HIGH: a model's choice is weaker evidence than an exact match.
    confidence: confidence === 'high' ? 'MEDIUM' : 'LOW',
    description: `AI (${answer.model}) chose ${chosen.role} "${chosen.name}" in ${chosen.region}`,
    note: `No exact, fuzzy or synonym match for "${t.description}". ${answer.model} chose ${chosen.role} "${chosen.name}" (${confidence} confidence): ${reason}`,
  };
}

// --- what the element really is, for healing the test case ---------------------

/**
 * The exact descriptor a fallback-matched element SHOULD have had.
 *
 * When "Log in" was found as "SIGN IN →" by synonym, the test case is out of
 * date, not wrong. Recording the element's real role and name lets
 * `npm run heal` propose updating the test so the next run matches exactly —
 * and is reported `verified` instead of `review`.
 */
export async function describeElement(locator: Locator): Promise<Partial<TargetSpec> | undefined> {
  try {
    const d = await locator.evaluate((el) => {
      const h = el as HTMLInputElement;
      const id = el.getAttribute('id');
      let label = '';
      if (h.labels && h.labels.length) label = h.labels[0]!.innerText;
      else if (id) label = document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent ?? '';
      return {
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute('type') ?? '').toLowerCase(),
        role: el.getAttribute('role') ?? '',
        aria: el.getAttribute('aria-label') ?? '',
        label: label.replace(/\s+/g, ' ').trim(),
        placeholder: el.getAttribute('placeholder') ?? '',
        text: ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim(),
        value: h.value ?? '',
      };
    }, undefined, { timeout: 2_000 });
    const implicit =
      d.role ||
      (d.tag === 'a' ? 'link'
        : d.tag === 'button' || ['submit', 'button', 'reset'].includes(d.type) ? 'button'
        : d.tag === 'select' ? 'combobox'
        : d.type === 'checkbox' ? 'checkbox'
        : d.type === 'radio' ? 'radio'
        : d.tag === 'textarea' || (d.tag === 'input' && d.type !== 'password') ? 'textbox'
        : '');
    const isField = ['input', 'textarea', 'select'].includes(d.tag);
    if (isField && d.label) return { label: d.label };
    if (d.aria && implicit) return { role: implicit, name: d.aria };
    const name = d.text || (['submit', 'button'].includes(d.type) ? d.value : '');
    if (implicit && name && !isField) return { role: implicit, name: name.slice(0, 80) };
    if (d.placeholder) return { placeholder: d.placeholder };
    if (d.text) return { text: d.text.slice(0, 80) };
    return undefined;
  } catch {
    return undefined;
  }
}
