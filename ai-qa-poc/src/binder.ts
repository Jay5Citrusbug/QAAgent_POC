import type { Capture } from './captures.js';
import type { ControlFact, PageReality } from './inspector.js';
import { hashIntent } from './intents.js';
import {
  describesWholeForm,
  fieldMentionedIn,
  formFieldsOn,
  leavesOneEmpty,
  valueFor,
  wantsInvalidValue,
} from './form-fill.js';
import type {
  ActionType,
  AppContext,
  AssertionCheck,
  CheckType,
  Observable,
  TestIntent,
  TargetSpec,
  TestMission,
} from './types.js';

/**
 * Phase 2a — binding an approved intent to the page that actually shipped.
 *
 * An intent says "submit credentials for an account that is locked". A mission
 * says which control that means. This turns the first into the second, once per
 * build, **before any mission runs**.
 *
 * ## Why this cannot silently succeed
 *
 * The intent contract forbids naming controls — that is the entire point of
 * §5a. So a deterministic binder has very little to go on: it can infer that
 * "submit" wants a button and "supply the email address" wants a textbox, and
 * it can match what is left against the real accessible names. It cannot know
 * what error message the product is supposed to show, because nobody wrote that
 * down anywhere a machine can read.
 *
 * The wrong response to that is to guess and produce a mission that looks
 * complete. A mission asserting an invented message either fails against
 * correct behaviour, or — far worse — passes against a bug because the check it
 * settled on was too weak to notice. This codebase has already been bitten by
 * the second one twice.
 *
 * So the binder is built to **fail loudly and usefully**: every binding it
 * cannot settle becomes an exception carrying the candidate controls actually
 * present on the page. The human is picking from a list, not authoring from
 * scratch, and the mission is not approvable until they do.
 *
 * ## Where a model plugs in
 *
 * `bindStep` and `bindOutcome` are exactly the seam — the same seam
 * `resolveTarget` leaves in discovery.ts. A model reading the intent plus the
 * candidate list would resolve most of today's exceptions; until one is wired
 * in, those exceptions are the honest output rather than a hidden guess.
 */

export type ExceptionKind =
  | 'no_candidate'
  | 'ambiguous'
  | 'approximated'
  | 'value_unknown'
  | 'unsupported_step'
  | 'role_unresolved'
  | 'data_unprovisioned'
  /** An API outcome whose endpoint nothing states — chosen from a run's network.json. */
  | 'api_endpoint_unknown';

export interface BindingException {
  kind: ExceptionKind;
  /** Which step or outcome, e.g. "S2" or "O1". */
  where: string;
  summary: string;
  /** What the page actually offers, so the human chooses rather than invents. */
  candidates?: string[];
  /** What a human must decide. Phrased as the question, not as an error. */
  asks?: string;
}

export interface BindOutcome {
  intent: TestIntent;
  mission?: TestMission;
  exceptions: BindingException[];
  confidence: 'high' | 'medium' | 'low';
}

export interface Reconciliation {
  feature: string;
  bound_against: { build: string; captured_at: string; urls: string[] };
  clean: BindOutcome[];
  needs_review: BindOutcome[];
  unbindable: BindOutcome[];
  /** Controls on the page that no intent mentions. The coverage holes. */
  uncovered: { url: string; control: ControlFact }[];
}

// --- Small text helpers ------------------------------------------------------

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

function similarity(a: string, b: string): number {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (!x || !y) return 0;
  if (x.includes(y) || y.includes(x)) return 0.9;
  const longest = Math.max(x.length, y.length);
  return 1 - distance(x, y) / longest;
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'with', 'that', 'is', 'are', 'as', 'at',
  'in', 'on', 'by', 'it', 'its', 'their', 'this', 'these', 'from', 'into', 'not', 'no',
  'user', 'actor', 'visitor', 'account', 'page', 'screen', 'application', 'app', 'still',
]);

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

// --- Verb inference ----------------------------------------------------------

/**
 * What kind of interaction a step is describing.
 *
 * Ordered most-specific first: "sign in with valid credentials" is a fill-then-
 * submit, not merely a click, and matching "submit" before "sign in" would lose
 * the fields entirely.
 */
const VERBS: { test: RegExp; action: ActionType; wants: string[] }[] = [
  // A download is a click whose result is a file; binding it as a plain click
  // would never notice that the file was empty or never came.
  { test: /\b(download|export)\b/i, action: 'download', wants: ['button', 'link'] },

  // Arriving somewhere. Matched first because "go to the cart and add an item"
  // is a navigation followed by an action, not one ambiguous blob.
  { test: /\b(arrive at|land on|visit|navigate)\b/i, action: 'navigate', wants: [] },

  // Authentication reads like a click but is a fill-then-submit; matching it as
  // a click would lose the credential fields entirely.
  { test: /\b(sign in|log in|sign-in|login|authenticate)\b/i, action: 'fill', wants: ['textbox'] },

  { test: /\b(search for|look up)\b/i, action: 'fill', wants: ['textbox', 'searchbox'] },
  { test: /\b(enter|typ(e|ing)|fill|supply|provid(e|ing)|input|complete|populate)\b/i, action: 'fill', wants: ['textbox'] },

  /**
   * "field" is the giveaway, whatever the verb.
   *
   * "complete every required checkout field, leaving one empty" was matched
   * by the submit family on the word *checkout* — a noun here, naming which
   * form the fields belong to — and so a form-filling step bound to a click
   * on the Proceed to Checkout button. The mission then submitted an
   * untouched form and its assertion passed, so a test that exercised
   * nothing reported green. Anything that talks about fields is data entry.
   */
  { test: /\bfields?\b/i, action: 'fill', wants: ['textbox'] },

  // Catalogue verbs. "narrow the catalogue to Electronics" was previously
  // unmatched, which reported a missing control when the control was right
  // there — a false finding, and the most expensive kind of wrong here.
  { test: /\b(filter|narrow|restrict|limit|refine)\b/i, action: 'click', wants: ['button', 'link', 'checkbox'] },

  { test: /\b(add|put|place)\b.*\b(cart|basket|bag|order)\b/i, action: 'click', wants: ['button'] },
  { test: /\b(remove|delete|discard|clear)\b/i, action: 'click', wants: ['button', 'link'] },
  { test: /\b(open|view|go to|show|display|reveal)\b/i, action: 'click', wants: ['link', 'button', 'tab'] },

  // Explicit action verbs are matched BEFORE the submit family: a word like
  // "checkout" is usually a noun naming a destination ("follow the header entry
  // for checkout"), not the act of submitting. Matching the noun first made the
  // binder search buttons only and miss the Checkout *link* — a large share of
  // the no_candidate exceptions traced back to this single ordering.
  { test: /\b(click|press|tap|activate|follow)\b/i, action: 'click', wants: ['button', 'link'] },
  { test: /\b(submit|send|confirm|save|place the order)\b/i, action: 'click', wants: ['button'] },
  // Finishing a form by what it makes: "create the account", "register", "sign up".
  { test: /\b(create|register|sign up|join|subscribe)\b/i, action: 'click', wants: ['button'] },

  /**
   * Words that name a destination as readily as an action.
   *
   * "move to checkout" was matched here and searched buttons only, so it
   * hunted the cart's Proceed to Checkout button while standing on a page
   * that has a Checkout link in its header — and reported BLOCKED on a test
   * that was only ever about the header being present. Which of the two is
   * meant is settled by scoring against the page, where "move to checkout"
   * matches the link "Checkout" more closely than the longer button, and
   * "proceed from the cart to checkout" matches the button more closely
   * than the link. Listing both roles lets that comparison happen at all.
   */
  { test: /\b(continue|proceed|apply|checkout|check out)\b/i, action: 'click', wants: ['button', 'link'] },
  { test: /\b(choose|select|pick)\b/i, action: 'select', wants: ['combobox', 'listbox'] },
  { test: /\b(tick|check|enable|opt in|opting)\b/i, action: 'check', wants: ['checkbox'] },
  { test: /\b(upload|attach)\b/i, action: 'upload', wants: ['button'] },
];

/** Steps no browser action can express. Better named than silently dropped. */
const UNSUPPORTED: { test: RegExp; why: string }[] = [
  {
    test: /\b(close the browser|restart the browser|reopen the browser|new browser session)\b/i,
    why: 'needs a fresh browser context mid-mission, which the executor cannot do inside one run',
  },
  { test: /\b(wait (a|an|\d+) (day|week|month|hour))\b/i, why: 'needs a clock the test controls' },
  { test: /\b(check the (email|inbox)|receive an email|click the link in)\b/i, why: 'needs an email client' },
  { test: /\b(database|back ?end record|directly in the db)\b/i, why: 'no database access' },
];

/**
 * One sentence, several actions.
 *
 * "add two products to the cart and proceed to checkout" is three things to do,
 * and the binder binds one control per step. It matched the last clause, so the
 * mission proceeded to a checkout it had never put anything into — and the
 * checkout page with an empty cart shows no form at all, which is why every
 * downstream field binding then had nothing to attach to.
 *
 * Splitting is deliberately narrow. "and" joins clauses ("... and proceed to
 * checkout") but it also joins nouns ("Wireless Headphones and Smart Watch"),
 * and splitting the latter would invent a step out of half a product name. So a
 * clause only splits where what follows "and" begins with something that reads
 * as an instruction. Anything else stays one step, which is the safe direction:
 * an unsplit compound step reports one exception, while a wrongly split one
 * silently does the wrong thing.
 */
function splitCompoundSteps(steps: TestIntent['steps']): TestIntent['steps'] {
  const LEADING_VERB =
    /^(add|remove|delete|open|view|go|proceed|continue|submit|place|apply|filter|narrow|choose|select|enter|type|fill|supply|provide|complete|populate|click|press|tap|follow|reach|attempt|confirm|save|search|check|reload|refresh)\b/i;

  const out: TestIntent['steps'] = [];
  for (const step of steps) {
    // An API step is one call, and a simulated event one event, whatever the sentence says.
    if (step.api || step.simulate) {
      out.push(step);
      continue;
    }
    const parts = step.actor_intent
      .split(/\s+and\s+then\s+|\s+and\s+|\s*,\s*then\s+|\s*;\s*/i)
      .map((x) => x.trim())
      .filter(Boolean);

    // Rebuild, re-joining any fragment that is not itself an instruction.
    const clauses: string[] = [];
    for (const part of parts) {
      if (clauses.length === 0 || LEADING_VERB.test(part)) clauses.push(part);
      else clauses[clauses.length - 1] += ` and ${part}`;
    }

    if (clauses.length <= 1) {
      out.push(step);
      continue;
    }
    for (const clause of clauses) out.push({ ...step, actor_intent: clause });
  }
  return out;
}

/**
 * Keep the mission on the page the next control lives on.
 *
 * Binding searches every captured page and state at once, which is what lets a
 * step find the checkout form. It also means the chosen control routinely lives
 * somewhere the mission is not: "proceed from the cart to checkout" resolves to
 * the Proceed to Checkout button, which is on /cart, while the mission is still
 * on / where it just added something. Nothing navigated in between, so
 * execution reported "nothing matched Proceed to Checkout" — BLOCKED, which
 * reads like a broken tool rather than a mission missing a step.
 *
 * The capture knows which page each candidate came from, so the move can be
 * inserted. **How** it moves matters more than it looks: a fresh `navigate` is a
 * full page load, and a cart held in client-side state does not survive one. A
 * mission that added an item and then navigated to /cart arrived at an empty
 * cart and failed on a product that works correctly.
 *
 * So the move is made the way a shopper makes it — by clicking the header entry
 * for the destination, which is a route change inside the page the mission is
 * already standing on. Navigation is the fallback for a destination nothing
 * links to, and it is only safe as an opening move.
 */
function moveTo(
  actions: TestMission['actions'],
  currentUrl: { at: string },
  destination: string,
  pages: PageReality[],
): void {
  let path: string;
  try {
    path = new URL(destination).pathname;
  } catch {
    return;
  }
  if (path === currentUrl.at) return;

  /**
   * The header entry for this destination, if the site has one.
   *
   * Matched on the destination's own path segment against the accessible names
   * of links in the nav or header — "/cart" against the link "Cart" — so no
   * list of site sections is hard-coded anywhere.
   */
  const segment = path.replace(/^\/+|\/+$/g, '').split('/').pop() ?? '';
  const linkName = segment
    ? pages
        .flatMap((pg) => pg.controls)
        .find(
          (c) =>
            c.role === 'link' &&
            c.regions.some((r) => r === 'nav' || r === 'header') &&
            c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === segment.toLowerCase().replace(/[^a-z0-9]/g, ''),
        )?.name
    : undefined;

  if (linkName) {
    actions.push({
      action: 'click',
      instruction: `Follow the header entry for ${linkName}, keeping the page the mission is on`,
      target: {
        description: `the header entry for ${linkName}`,
        role: 'link',
        name: linkName,
        within: { description: 'the header navigation', role: 'navigation' },
      },
    });
  } else {
    actions.push({
      action: 'navigate',
      instruction: `Go to ${path}, where the next control is`,
      url: path,
    });
  }
  currentUrl.at = path;
}

// --- Candidate matching ------------------------------------------------------

interface Candidate {
  control: ControlFact;
  url: string;
  score: number;
}

/**
 * Which page region the wording points at.
 *
 * The capture already records whether a control lives in the nav, the footer or
 * the main area, and the requirement's own vocabulary distinguishes "the header
 * navigation" from "the footer quick links". Ignoring that made every mention of
 * Cart, Products or Checkout ambiguous, because each appears in both nav and
 * footer — 21 ambiguous exceptions that the capture had the information to
 * resolve all along.
 */
function regionHint(text: string): string | undefined {
  const t = text.toLowerCase();
  if (/\b(header|top nav|navigation bar|nav bar|top of the page)\b/.test(t)) return 'nav';
  if (/\bfooter\b/.test(t)) return 'footer';
  return undefined;
}

/** Wording that is about a picture rather than a control. */
function wantsImage(text: string): boolean {
  return /\b(image|images|logo|picture|photo|thumbnail|banner image)\b/i.test(text);
}

/**
 * Images are candidates too.
 *
 * `findCandidates` only ever searched `page.controls`, so any outcome about a
 * logo or product image could never bind — the capture knows the image exists
 * and even knows it is broken, and the binder could not see it.
 */
export interface ImageCandidate {
  url: string;
  alt: string;
  src: string;
  loaded: boolean;
}

function findImages(text: string, pages: PageReality[]): ImageCandidate[] {
  const words = contentWords(text);
  const out: ImageCandidate[] = [];
  for (const page of pages) {
    for (const img of page.images) {
      const alt = (img.alt ?? '').toLowerCase();
      const named = alt && (text.toLowerCase().includes(alt) || contentWords(alt).some((w) => words.includes(w)));
      // A bare "every image" sweep matches all of them; a named one matches by alt.
      if (named || /\b(every|all)\b.*\bimages?\b/i.test(text)) {
        out.push({ url: page.url, alt: img.alt ?? '', src: img.src, loaded: img.loaded });
      }
    }
  }
  return out;
}

function findCandidates(text: string, pages: PageReality[], wantRoles: string[]): Candidate[] {
  const words = contentWords(text);
  const region = regionHint(text);
  const out: Candidate[] = [];

  for (const page of pages) {
    for (const control of page.controls) {
      if (wantRoles.length && !wantRoles.includes(control.role)) continue;
      // Honour a region the wording names, when the control records regions.
      if (region && control.regions.length > 0 && !control.regions.includes(region)) continue;

      const name = control.name.toLowerCase();
      if (!name) continue;

      // Direct mention wins outright: the intent said "Remember me" and the
      // page has a checkbox called exactly that.
      let score = 0;
      if (text.toLowerCase().includes(name)) {
        score = 0.95;
      } else {
        const nameWords = contentWords(control.name);
        const shared = nameWords.filter((w) => words.includes(w)).length;
        if (shared > 0) score = 0.5 + 0.4 * (shared / Math.max(nameWords.length, 1));
        else score = Math.max(...words.map((w) => similarity(w, name)), 0) * 0.6;
      }

      if (score > 0.45) out.push({ control, url: page.url, score });
    }
  }

  /**
   * Rank, then deduplicate.
   *
   * Two controls can both be named in one sentence — "Only products belonging
   * to Electronics remain listed" mentions both `Products` and `Electronics`,
   * and a plain score sort put the wrong one first purely by page order. Two
   * tie-breaks fix it, in this order:
   *
   *  1. **Prefer the unambiguous one.** A name matching eight elements is a
   *     target `discovery.ts` will refuse to resolve anyway, so ranking it
   *     first only produces an exception a better candidate would have avoided.
   *  2. **Prefer the more specific name.** "Electronics" says more about this
   *     sentence than "Products" does, and the longer of two matched names is
   *     a serviceable proxy for that.
   *
   * The same control can appear on several captured pages; the list is
   * deduplicated by role and name afterwards so a human is not asked to choose
   * between a thing and itself.
   */
  const ranked = out.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.02) return b.score - a.score;
    if (a.control.count !== b.control.count) return a.control.count - b.control.count;
    return b.control.name.length - a.control.name.length;
  });

  const seen = new Set<string>();
  return ranked.filter((c) => {
    const k = `${c.control.role}\u0000${c.control.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function describeCandidate(c: Candidate): string {
  const where = c.control.regions.length ? ` (in ${c.control.regions.join(', ')})` : '';
  const many = c.control.count > 1 ? `, ${c.control.count} on the page` : '';
  return `${c.control.role} "${c.control.name}"${where}${many}`;
}

// --- Observable → check ------------------------------------------------------

/**
 * How each observable would be checked, and whether the binder can finish it.
 *
 * `needsValue` is the honest half: the intent says the user is *told* the
 * account is locked, and no machine-readable artefact anywhere says what that
 * message reads. Binding it to a bare visibility check would produce an
 * assertion that passes on a blank alert box — so it becomes an exception with
 * a question attached instead.
 */
/**
 * The expected value, when the outcome already states it.
 *
 * `value_unknown` was the single largest exception category — and most of them
 * were not unknown at all. An outcome like:
 *
 *   The footer description reads exactly "…for testing purpose".
 *   The catalogue entry leads to /products.
 *
 * carries the expected value in plain sight; the binder just never looked. It
 * still refuses when there is genuinely nothing to extract, which is the case
 * that deserves a human.
 *
 * Quotes are checked before paths so a quoted string containing a slash is not
 * mistaken for a URL.
 */
function expectedValueFrom(statement: string, checkType: CheckType): string | undefined {
  if (checkType === 'url_contains') {
    // "destination /." — the site root, which the path pattern below cannot
    // express because it requires a character after the slash.
    if (/destination\s+\/\.?(\s|$)/.test(statement)) return '/';
    // A path the statement names outright: /products, /cart/, /checkout
    const path = statement.match(/(?:^|\s)(\/[a-z0-9][a-z0-9\-/]*)/i)?.[1];
    if (path) return path.replace(/\/$/, '') || '/';
    // A full URL, reduced to its path.
    const url = statement.match(/https?:\/\/[^\s"')]+/i)?.[0];
    if (url) {
      try {
        const p = new URL(url).pathname;
        return p === '/' ? '/' : p.replace(/\/$/, '');
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  // Values that are unambiguous literals wherever they appear — an email or a
  // phone number in a statement IS the expected text, quoted or not.
  /**
   * Trim sentence punctuation off a literal.
   *
   * "The footer shows the contact email qa.citrusbug@gmail.com." captured the
   * full stop as part of the address and then asserted it, so a page carrying
   * the correct email failed and was reported as a defect at high confidence.
   * A literal at the end of a sentence is the common case, not the exception.
   */
  const trimLiteral = (v: string) => v.replace(/[.,;:!?)\]}'"]+$/, '');

  const email = statement.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
  if (email) return trimLiteral(email);
  const phone = statement.match(/\+?\d[\d\s().-]{7,}\d/)?.[0];
  if (phone) return trimLiteral(phone.trim());

  // Straight or curly quotes — the exact text the product should show.
  const quoted =
    statement.match(/"([^"]{2,})"/)?.[1] ??
    statement.match(/“([^”]{2,})”/)?.[1] ??
    statement.match(/'([^']{3,})'/)?.[1];
  return quoted?.trim();
}

/** The landmark role a region name corresponds to, for `within` scoping. */
/**
 * Product names the capture saw, so a step naming one can be scoped to its card.
 *
 * "Add to Cart" appears once per product — eight identical buttons with nothing
 * in the capture linking a button to the product it belongs to. The capture
 * cannot express that, but the mission contract can: `within` a container
 * carrying the product's name, resolved live by discovery.ts. The scope is a
 * proposal the run either resolves or fails honestly on; it is not a guess
 * about what the button is called.
 */
function productNames(pages: PageReality[]): string[] {
  const names = new Set<string>();
  for (const page of pages) {
    for (const h of page.headings) {
      if (h.level >= 3 && h.text.trim().length > 2) names.add(h.text.trim());
    }
  }
  return [...names];
}

function productMentionedIn(text: string, pages: PageReality[]): string | undefined {
  const lower = text.toLowerCase();
  return productNames(pages)
    .filter((n) => lower.includes(n.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
}

const LANDMARK_FOR_REGION: Record<string, string> = { nav: 'navigation', footer: 'contentinfo', main: 'main' };

/**
 * Build the target for a control, scoping it when the wording names a region.
 *
 * The capture aggregates identical controls: `Products` in the nav and in the
 * footer arrive as ONE record with count 2 and regions ['nav','footer']. So a
 * region filter cannot separate them — but the mission schema has `within`
 * exactly for this, and `discovery.ts` resolves it at run time. Scoping is the
 * honest answer: the ambiguity is real, and the wording already says which one
 * is meant.
 */
function targetFor(description: string, control: ControlFact, region?: string): TargetSpec {
  const target: TargetSpec = { description, role: control.role, name: control.name };
  const landmark = region ? LANDMARK_FOR_REGION[region] : undefined;
  if (landmark && control.count > 1) {
    target.within = { description: `the ${region} region`, role: landmark };
  }
  return target;
}

/** A count the statement states outright: "exactly three products", "8 products". */
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function statedCount(statement: string): number | undefined {
  /**
   * "the counter reports two items" is one element showing the number 2 — a
   * value, not a cardinality. Counting elements there found 1 and reported a
   * defect. Phrasing that describes something *displaying* a number is a text
   * comparison, never a count.
   */
  if (/\b(reports?|shows?|reads?|displays?)\b/i.test(statement)) return undefined;
  const digits = statement.match(/\b(?:exactly\s+)?(\d+)\s+(?:products?|items?|results?|entries)\b/i);
  if (digits?.[1]) return Number(digits[1]);
  const words = statement.match(/\b(?:exactly\s+)?(zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:products?|items?|results?|entries)\b/i);
  const w = words?.[1]?.toLowerCase();
  return w !== undefined ? NUMBER_WORDS[w] : undefined;
}

const CHECK_FOR: Record<Observable, { type: CheckType; needsValue: boolean; approximate: boolean }> = {
  message_shown: { type: 'text_contains', needsValue: true, approximate: false },
  navigation: { type: 'url_contains', needsValue: true, approximate: false },
  state_change: { type: 'visible', needsValue: false, approximate: true },
  element_present: { type: 'visible', needsValue: false, approximate: false },
  element_absent: { type: 'not_visible', needsValue: false, approximate: false },
  value_equals: { type: 'text_equals', needsValue: true, approximate: false },
  data_persisted: { type: 'visible', needsValue: false, approximate: true },
  access_denied: { type: 'not_visible', needsValue: false, approximate: true },
  // Bound by apiCheckFrom() below, never by page candidates.
  api_response: { type: 'api_response', needsValue: false, approximate: false },
  // Bound below: the element from page candidates, the call and field from the statement.
  ui_matches_api: { type: 'ui_matches_api', needsValue: false, approximate: false },
};

/**
 * "POST /api/orders" → method + path for an api_request step. Path parameters
 * ({id}, :id) become {saved.id}: filled from an earlier step's saved value.
 */
export function apiCallFrom(endpoint: string): { method: NonNullable<TestMission['actions'][number]['method']>; url: string } | undefined {
  const m = endpoint.trim().match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/i);
  if (!m) return undefined;
  const url = m[2]!.replace(/\{([A-Za-z0-9_]+)\}/g, '{saved.$1}').replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{saved.$1}');
  return { method: m[1]!.toUpperCase() as 'GET', url };
}

/** The JSON field an outcome names, written in backticks: `items.length`, `order.total`. */
function jsonPathFrom(statement: string): string | undefined {
  return statement.match(/`([A-Za-z_$][\w$]*(?:\[\d+\])?(?:\.[A-Za-z_$][\w$]*(?:\[\d+\])?)*)`/)?.[1];
}

/**
 * An API outcome, bound from what its statement names.
 *
 *   "POST /api/cart returns 201"             → request + status
 *   "the GET /api/orders/{id} call succeeds" → request + status 2xx
 *
 * The endpoint usually is NOT in a story, and a static page capture cannot
 * show it. Guessing one would assert against a call that may not exist, so a
 * missing endpoint becomes an exception for Gate 2.5 — answered from the
 * network.json of a first run, which lists every call the page really made.
 */
/** A fault endpoint nobody has chosen yet. Matches no real call, and lint flags it. */
export const UNSET_ENDPOINT = 'SET-AT-GATE-2.5';

export function apiCheckFrom(statement: string): AssertionCheck | undefined {
  const method = statement.match(/\b(GET|POST|PUT|PATCH|DELETE)\b/)?.[1];
  const path = statement.match(/(?:^|[\s"'`(])(\/[a-z0-9_\-.{}:]+(?:\/[a-z0-9_\-.{}:]*)*)/i)?.[1];
  if (!path) return undefined;
  // /api/orders/{id} → /api/orders/ : the static prefix is what every real call shares.
  const url = path.replace(/[{:].*$/, '');
  const status =
    statement.match(/(?:status|returns?|respond(?:s|ed)?(?:\s+with)?|code|HTTP)\s*(?:code\s*)?([1-5]\d\d|[1-5]xx)\b/i)?.[1] ??
    (/\b(succeed|succeeds|successful|successfully|ok)\b/i.test(statement) ? '2xx' : undefined);
  return {
    type: 'api_response',
    request: { ...(method ? { method } : {}), url_contains: url },
    ...(status ? { status: /xx$/i.test(status) ? status.toLowerCase() : Number(status) } : {}),
  };
}

// --- The bind ----------------------------------------------------------------

/**
 * How this role gets a session, decided from the application context.
 *
 * The executor defaults a missing `auth` block to `storage_state`, so a bound
 * mission without one demands a seeded session for every role — including roles
 * on applications that have no login at all. The first mission the binder ever
 * produced had exactly this bug: a storefront with no sign-in, a Guest role, and
 * a mission that would have failed with "no seeded session" and looked like an
 * environment problem.
 *
 * The convention is already established by the context files: a role with a
 * `storage_state_ref` authenticates, a role without one is anonymous. Read it
 * rather than guessing from the role's name — "Guest" is anonymous on one
 * product and a seeded limited account on another.
 */
function resolveAuth(role: string, ctx: AppContext): TestMission['auth'] {
  const declared = (ctx.roles ?? []).find((r) => r.name.toLowerCase() === role.toLowerCase());
  const ref = declared?.storage_state_ref;
  return ref ? { strategy: 'storage_state', storage_state_ref: ref } : { strategy: 'anonymous' };
}

function resolveRole(intent: TestIntent, ctx: AppContext): { role: string; exception?: BindingException } {
  const roles = (ctx.roles ?? []).map((r) => r.name);
  const actor = intent.actor.toLowerCase();

  const exact = roles.find((r) => actor.includes(r.toLowerCase()));
  if (exact) return { role: exact };

  // Stems, not whole words: "browsing anonymously" and "an anonymous shopper"
  // mean the same thing, and `\banonymous\b` matches only the second. That kind
  // of near-miss reports a role as unresolvable when the mapping is obvious,
  // which trains people to skim the exception list.
  if (/unauthenticat|anonymous|anonymously|signed.out|logged.out|guest|visitor|shopper|public/.test(actor)) {
    const anon = roles.find((r) => /guest|anonymous|visitor|public/i.test(r));
    if (anon) return { role: anon };
  }

  const fallback = roles[0] ?? 'Admin';
  return {
    role: fallback,
    exception: {
      kind: 'role_unresolved',
      where: 'role',
      summary: `The intent's actor is "${intent.actor}", which matches no role in application-context.yaml.`,
      candidates: roles.length ? roles : ['(no roles defined)'],
      asks: `Which role should this run as? Defaulted to "${fallback}", which may be wrong — a test running as the wrong role can pass for the wrong reason.`,
    },
  };
}

export function bindIntent(intent: TestIntent, capture: Capture, ctx: AppContext): BindOutcome {
  const exceptions: BindingException[] = [];

  /**
   * A manual intent is never bound, and never becomes a runnable mission.
   *
   * EC-012 said "the active filter is shown in a different colour", was marked
   * `execution_mode: manual` for exactly that reason, and the binder bound it
   * anyway to a plain visibility check. It then PASSED — against a page where
   * the colour could have been anything. A green result that proves nothing is
   * the worst outcome this system can produce, and it came from ignoring a flag
   * the author had already set correctly.
   */
  if (intent.coverage?.execution_mode === 'manual') {
    return {
      intent,
      exceptions: [
        {
          kind: 'unsupported_step',
          where: 'coverage',
          summary: `Marked execution_mode: "manual" — ${intent.coverage.manual_reason ?? 'the executor cannot check this'}.`,
          asks: "This is a human's job. It is deliberately not bound, so it cannot produce a misleading pass.",
        },
      ],
      confidence: 'low',
    };
  }

  /**
   * Bind against every state the capture holds, not only initial page loads.
   *
   * `capture.pages` is each URL as it first renders. `capture.states` is what
   * was reached by walking the flows the intents describe — the checkout form
   * with its fields, a filtered grid, a cart with contents. Searching only the
   * former is why every checkout test reported "nothing on the page looks like
   * this": the form genuinely was not in the data, because nobody had put
   * anything in the cart when the snapshot was taken.
   *
   * Initial pages come first so a control present in both is attributed to the
   * plain page, which is the simpler thing for a human to reason about.
   */
  const pages = [...capture.pages, ...(capture.states ?? []).map((s) => s.page)];

  /**
   * Which controls are stable page furniture, as opposed to things that only
   * exist for a moment part-way through a flow.
   *
   * Flow capture is what made the checkout form visible to binding, but it
   * also recorded a button reading "Placing Order..." — a spinner label that
   * exists for a fraction of a second after a submit. An outcome saying "the
   * order is not placed" then scored that label highest on word overlap and
   * became a check that it was not visible, which is true on every page in
   * the application at almost every instant. The test would have passed
   * whether validation worked or not.
   *
   * A control seen only in a mid-flow state is not evidence of anything by
   * its absence, so it is disqualified from absence checks below.
   */
  const stableControls = new Set(
    capture.pages.flatMap((pg) => pg.controls.map((c) => `${c.role}:${c.name}`)),
  );

  const { role, exception: roleException } = resolveRole(intent, ctx);
  if (roleException) exceptions.push(roleException);

  // Data the intent needs but nobody has confirmed how to supply. Caught at
  // Gate 2 as a warning; here it becomes a hard reason the mission cannot run.
  for (const d of intent.test_data ?? []) {
    if (!d.provisioning || d.provisioning === 'unknown') {
      exceptions.push({
        kind: 'data_unprovisioned',
        where: `test_data:${d.name}`,
        summary: `"${d.name}" (${d.description}) has no confirmed way to exist on this environment.`,
        asks: 'Seed it, have the test create it, or accept this as a manual test. It cannot run as automation until then.',
      });
    }
  }

  // --- Steps → actions ------------------------------------------------------

  const actions: TestMission['actions'] = [];
  /**
   * Start on the page the intent is about, not simply the first one captured.
   *
   * Every mission began at the home page, so an intent about the catalogue
   * search or the cart looked for controls that live on another page and
   * reported them missing. The capture holds all four pages; picking the right
   * one is just reading the intent's own words.
   */
  const intentText = [
    intent.test_objective,
    ...intent.steps.map((x) => x.actor_intent),
    ...intent.outcomes.map((x) => x.statement),
    ...intent.preconditions,
  ]
    .join(' ')
    .toLowerCase();

  /**
   * Only a real page can be opened directly — never a mid-flow state.
   *
   * Flow states carry the URL they were reached at, so a checkout state and the
   * checkout page look alike here. Opening the state is not possible: it exists
   * because someone filled a cart first. Restricting the choice to `capture.pages`
   * keeps "where does this mission start" answerable by a plain navigation.
   */
  const pageFor = (needle: RegExp) => capture.pages.find((pg) => needle.test(new URL(pg.url).pathname));

  /**
   * A mission starts where its FIRST step happens, not where its subject lives.
   *
   * Reading the whole intent for a destination put EC-019 — "add two products
   * to the cart, then check the checkout summary matches" — straight onto
   * /checkout, where the cart is empty, there is no Add to Cart button and no
   * form. It reported BLOCKED, which reads like the tooling failing when the
   * mission had simply been started in the wrong place.
   *
   * The first step says where to begin, in the author's own words, and an
   * intent that opens with "arrive at the storefront home page" is not asking
   * to be dropped at the end of the journey. Only when the opening step names
   * no place does the rest of the intent get consulted.
   */
  const openingText = (intent.steps[0]?.actor_intent ?? '').toLowerCase();
  const opensSomewhereNamed =
    /\b(home|storefront|landing|catalogue|catalog|products?|cart|checkout)\b/.test(openingText);
  const locatingText = opensSomewhereNamed ? openingText : intentText;

  const startPage =
    (/\b(home|storefront|landing)\b/.test(locatingText) && pageFor(/^\/$/)) ||
    (/\bcheckout\b/.test(locatingText) && pageFor(/^\/checkout/)) ||
    (/\bcart\b/.test(locatingText) && !/\badd\b/.test(locatingText) && pageFor(/^\/cart/)) ||
    (/\b(catalogue page|products page|search|sort)\b/.test(locatingText) && pageFor(/^\/products/)) ||
    capture.pages[0];

  const currentUrl = { at: startPage ? new URL(startPage.url).pathname : '/' };

  /**
   * A simulated backend failure goes in FIRST, before the page opens: calls a
   * page makes while loading are exactly the ones a later step would be too
   * late to intercept.
   */
  if (intent.fault) {
    const fromEndpoint = intent.fault.endpoint ? apiCheckFrom(` ${intent.fault.endpoint}`) : undefined;
    if (!fromEndpoint?.request) {
      exceptions.push({
        kind: 'api_endpoint_unknown',
        where: 'fault',
        summary: `The fault "${intent.fault.description}" needs the API call to fail, and nothing states which one.`,
        candidates: [],
        asks: `Pick the call from network.json of a first run and set request.url_contains (and method) on the fail_requests step, replacing ${UNSET_ENDPOINT}.`,
      });
    }
    actions.push({
      action: 'fail_requests',
      instruction: `Simulate: ${intent.fault.description}`,
      request: fromEndpoint?.request ?? { url_contains: UNSET_ENDPOINT },
      failure: intent.fault.kind,
    });
    if (!startPage) actions.push({ action: 'navigate', instruction: 'Open the application', url: '/' });
  }

  if (startPage) {
    actions.push({
      action: 'navigate',
      instruction: `Open ${startPage.url}`,
      url: new URL(startPage.url).pathname,
    });
  }

  // A data-driven intent: a row expected to be refused lets the final step fail.
  const anyRowRefused = (intent.examples ?? []).some((e) => e.expected_outcome === 'blocked');

  // Steps that belong right AFTER the action bound for the current step.
  let pendingAfter: TestMission['actions'] = [];
  for (const step of splitCompoundSteps(intent.steps)) {
    const text = step.actor_intent;
    // "Enter {data.password} as the password": the row's value is what gets typed.
    const dataToken = text.match(/\{data\.[A-Za-z0-9_]+\}/)?.[0];
    actions.push(...pendingAfter);
    pendingAfter = [];

    // "...opens in a new tab / window / pop-up": follow it there afterwards.
    if (/\b(new (tab|window)|pop-?up)\b/i.test(text)) {
      pendingAfter.push({ action: 'switch_tab', instruction: 'Continue in the tab that opened', value: 'new' });
    }

    // Scrolling the page itself, e.g. to load more of an infinite list.
    if (/\bscroll(s|ing)?\b.*\b(bottom|end|down|load more)\b|\binfinite (scroll|list)\b/i.test(text)) {
      actions.push({ action: 'scroll', instruction: text, value: 'bottom' });
      continue;
    }

    // Declining a confirmation happens DURING the click before it, so the answer
    // has to be armed before that click, not after.
    if (/\b(cancel|dismiss|decline|reject)\b.*\b(confirmation|dialog|prompt|alert)\b/i.test(text)) {
      const lastClick = [...actions].reverse().findIndex((a) => a.action === 'click');
      const at = lastClick === -1 ? actions.length : actions.length - 1 - lastClick;
      actions.splice(at, 0, { action: 'handle_dialog', instruction: text, dialog: 'dismiss' });
      continue;
    }
    if (/\b(confirm|accept|ok)\b.*\b(confirmation|dialog|prompt|alert)\b/i.test(text)) {
      // Accepting is the default answer; nothing to bind, but say so in the mission.
      actions.push({ action: 'handle_dialog', instruction: text, dialog: 'accept' });
      continue;
    }

    if (step.simulate === 'session_expired') {
      actions.push({ action: 'expire_session', instruction: text });
      continue;
    }

    if (step.api) {
      const call = apiCallFrom(step.api.endpoint);
      if (!call) {
        exceptions.push({
          kind: 'unsupported_step',
          where: step.id,
          summary: `API step "${step.api.endpoint}" is not "METHOD /path".`,
          asks: 'Write the endpoint as e.g. "POST /api/orders".',
        });
        continue;
      }
      actions.push({
        action: 'api_request',
        instruction: text,
        method: call.method,
        url: call.url,
        ...(step.api.body ? { body: step.api.body } : {}),
        ...(step.api.save?.length ? { save: step.api.save } : {}),
      });
      continue;
    }

    const blocked = UNSUPPORTED.find((u) => u.test.test(text));
    if (blocked) {
      exceptions.push({
        kind: 'unsupported_step',
        where: step.id,
        summary: `"${text}" — ${blocked.why}.`,
        asks: 'Drop this step, replace it with something the browser can do, or mark the whole intent as a manual test.',
      });
      continue;
    }

    const verb = VERBS.find((v) => v.test.test(text));
    if (!verb) {
      exceptions.push({
        kind: 'no_candidate',
        where: step.id,
        summary: `Could not tell what kind of interaction "${text}" describes.`,
        asks: 'What does the actor actually do here — click, fill, select, or navigate?',
      });
      continue;
    }

    if (verb.action === 'navigate') {
      // Already handled by the opening navigate; a second one would just
      // reload the page the mission is standing on.
      continue;
    }

    /**
     * A step about form fields is bound against the form, not against whichever
     * single textbox scored highest.
     *
     * This is the one case where an intent legitimately means several controls
     * at once. Treating "complete every required checkout field except one" as
     * one control filled it with a placeholder, submitted an otherwise empty
     * form, and reported PASS — a test that exercised nothing, presented as
     * evidence that validation works.
     *
     * See form-fill.ts for how a field's purpose and value are decided; both
     * come from the markup and the intent's own words, with no model involved.
     */
    if (verb.action === 'fill') {
      const fields = formFieldsOn(pages, startPage ? new URL(startPage.url).pathname : undefined);

      if (fields.length > 0 && describesWholeForm(text)) {
        const omitLast = leavesOneEmpty(text);
        const toFill = omitLast ? fields.slice(0, -1) : fields;
        const skipped = omitLast ? fields[fields.length - 1] : undefined;

        if (toFill.length === 0) {
          exceptions.push({
            kind: 'no_candidate',
            where: step.id,
            summary: `"${text}" describes filling a form, but only one field was found — leaving one empty would leave nothing filled.`,
            asks: 'Is this the right page, and does the form really have the fields the intent assumes?',
          });
          continue;
        }

        moveTo(actions, currentUrl, toFill[0]!.url, pages);

        for (const f of toFill) {
          actions.push({
            action: f.isChoice ? 'select' : 'fill',
            instruction: `${text} — ${f.control.field?.attr || f.control.name}`,
            target: {
              description: `the ${f.control.field?.attr || f.purpose} field`,
              role: f.control.role,
              name: f.control.name,
            },
            value: valueFor(f.purpose, false),
          });
        }

        exceptions.push({
          kind: 'approximated',
          where: step.id,
          summary:
            `"${text}" was expanded into ${toFill.length} field(s): ` +
            `${toFill.map((f) => f.control.field?.attr || f.purpose).join(', ')}` +
            (skipped ? `, leaving "${skipped.control.field?.attr || skipped.purpose}" empty` : '') +
            '. Values are fixed per field type, so every run types the same thing.',
          asks:
            (skipped
              ? `Is "${skipped.control.field?.attr || skipped.purpose}" the field this test should leave empty? Any required field would do, and the binder took the last one. `
              : '') + 'If a particular value matters to this test, state it in the step and it will be used instead.',
        });
        continue;
      }

      const named = fields.length > 0 ? fieldMentionedIn(text, fields) : undefined;
      if (named) {
        const invalid = wantsInvalidValue(text);
        moveTo(actions, currentUrl, named.url, pages);
        actions.push({
          action: named.isChoice ? 'select' : 'fill',
          instruction: text,
          target: {
            description: `the ${named.control.field?.attr || named.purpose} field`,
            role: named.control.role,
            name: named.control.name,
          },
          // A data-driven row's value wins over the generic one for this kind of field.
          value: dataToken ?? valueFor(named.purpose, invalid),
        });
        if (invalid && !dataToken) {
          exceptions.push({
            kind: 'approximated',
            where: step.id,
            summary: `"${text}" was bound to the ${named.control.field?.attr || named.purpose} field with the fixed invalid value "${valueFor(named.purpose, true)}".`,
            asks: 'Is that wrong in the way this test means? If a specific bad value matters, put it in the step.',
          });
        }
        continue;
      }
    }

    const candidates = findCandidates(text, pages, verb.wants);

    if (candidates.length === 0) {
      exceptions.push({
        kind: 'no_candidate',
        where: step.id,
        summary: `Nothing on the page looks like what "${text}" needs (expected a ${verb.wants.join(' or ')}).`,
        candidates: pages
          .flatMap((p) => p.controls.filter((c) => verb.wants.includes(c.role)))
          .slice(0, 10)
          .map((c) => `${c.role} "${c.name}"`),
        asks:
          'Is this feature missing from the build, was the control renamed, or does the step describe ' +
          'something that was never going to exist? Those need three different responses.',
      });
      continue;
    }

    const best = candidates[0] as Candidate;
    const runnerUp = candidates[1];
    const tooClose = runnerUp && best.score - runnerUp.score < 0.15;
    const region = regionHint(text);
    // A duplicated control the wording has already located ("the header entry
    // for the cart") is not ambiguous — it is scoped. Refusing it would be the
    // binder ignoring information the author supplied.
    const scopable = Boolean(region && LANDMARK_FOR_REGION[region] && best.control.regions.includes(region));
    const product = productMentionedIn(text, pages);

    if (!scopable && !product && (tooClose || best.control.count > 1)) {
      exceptions.push({
        kind: 'ambiguous',
        where: step.id,
        summary: `"${text}" could mean more than one thing on this page.`,
        candidates: candidates.slice(0, 5).map(describeCandidate),
        asks: 'Which one? Picking the wrong control here is how a test passes for the wrong reason.',
      });
      continue;
    }

    moveTo(actions, currentUrl, best.url, pages);

    actions.push({
      action: verb.action,
      instruction: text,
      target: product
        ? {
            /**
             * Position, not text. Scoping `within` a container matching the
             * product name matched two nested elements (the card and its
             * heading) and discovery rightly refused to choose. The capture
             * lists product headings in DOM order, so the nth repeated control
             * is the one belonging to the nth product — deterministic, and it
             * needs nothing the capture does not already record.
             */
            description: `${text} (${product})`,
            role: best.control.role,
            name: best.control.name,
            nth: Math.max(0, productNames(pages).indexOf(product)),
            expect_multiple: true,
          }
        : targetFor(text, best.control, region),
      ...(verb.action === 'fill' || verb.action === 'type' ? { value: dataToken ?? '{run_id}' } : {}),
      ...((intent.expected_outcome === 'blocked' || anyRowRefused) && step.id === intent.steps[intent.steps.length - 1]?.id
        ? { tolerate_failure: true }
        : {}),
    });

    if (verb.action === 'fill' && !dataToken) {
      exceptions.push({
        kind: 'value_unknown',
        where: step.id,
        summary: `"${text}" fills a field, but the intent does not say with what.`,
        asks: 'What value should go in? A placeholder {run_id} was written in so the mission validates — it is almost certainly not what you want.',
      });
    }
  }

  actions.push(...pendingAfter);

  // --- Outcomes → assertions -----------------------------------------------

  const assertions: TestMission['assertions'] = [];

  for (const outcome of intent.outcomes) {
    /**
     * A layout outcome is about the whole page at this size, never one element:
     * "the checkout page lays out soundly on a phone". Binding it to the best
     * matching control would check that one control is visible, which is true
     * of a page that scrolls sideways with its Pay button under a banner.
     */
    if (/\b(lays? out|layout|sideways|horizontal scroll|cut off|overlap|tap targets?)\b/i.test(outcome.statement)) {
      assertions.push({
        id: outcome.id.replace(/^O/, 'A'),
        statement: outcome.statement,
        check: { type: 'layout_sound' },
        ...(outcome.critical === false ? { critical: false } : {}),
      });
      continue;
    }

    // A dialog the application raised: "a confirmation asks 'Delete this order?'".
    if (/\b(dialog|confirmation|alert|prompt)\b/i.test(outcome.statement) && /\b(asks?|says?|shows?|appears?|warns?|is shown|pops? up)\b/i.test(outcome.statement)) {
      const said = outcome.statement.match(/["“']([^"”']{3,})["”']/)?.[1];
      assertions.push({
        id: outcome.id.replace(/^O/, 'A'),
        statement: outcome.statement,
        check: { type: 'dialog_shown', ...(said ? { value: said } : {}) },
        ...(outcome.critical === false ? { critical: false } : {}),
      });
      continue;
    }

    // A file arrives: "the invoice PDF is downloaded", "orders.csv is downloaded".
    if (/\b(download(ed|s)?|exported)\b/i.test(outcome.statement) && /\b(file|pdf|csv|xlsx?|zip|invoice|report|export)\b/i.test(outcome.statement)) {
      const name =
        outcome.statement.match(/\b([\w-]+\.(pdf|csv|xlsx?|zip|txt|json|docx?))\b/i)?.[1] ??
        outcome.statement.match(/\b(pdf|csv|xlsx?|zip)\b/i)?.[1]?.toLowerCase();
      assertions.push({
        id: outcome.id.replace(/^O/, 'A'),
        statement: outcome.statement,
        check: { type: 'file_downloaded', ...(name ? { value: name } : {}) },
        ...(outcome.critical === false ? { critical: false } : {}),
      });
      continue;
    }

    // "Looks as approved" is a screenshot against the person-approved baseline.
    if (/\blooks? (as approved|the same|unchanged|as before)\b|\bvisually (unchanged|identical)\b/i.test(outcome.statement)) {
      assertions.push({
        id: outcome.id.replace(/^O/, 'A'),
        statement: outcome.statement,
        check: { type: 'looks_like_baseline' },
        ...(outcome.critical === false ? { critical: false } : {}),
      });
      continue;
    }

    // "The page loads within 3 seconds" / "the main content appears within 2.5s".
    const timing = outcome.statement.match(/\bwithin\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i);
    if (timing && /\b(load|loads|loaded|appear|appears|render|renders|display|displays|shown|visible|ready)\b/i.test(outcome.statement)) {
      const ms = Math.round(Number(timing[1]) * (/^m/i.test(timing[2]!) ? 1 : 1000));
      const content = /\b(appear|appears|render|renders|display|displays|shown|visible|content)\b/i.test(outcome.statement);
      assertions.push({
        id: outcome.id.replace(/^O/, 'A'),
        statement: outcome.statement,
        check: { type: 'performance_budget', budget: content ? { lcp_ms: ms } : { load_ms: ms } },
        ...(outcome.critical === false ? { critical: false } : {}),
      });
      continue;
    }

    // Accessibility is a property of the page (or a named region), checked by axe.
    if (/\b(accessib\w*|screen[- ]reader|wcag|contrast)\b/i.test(outcome.statement)) {
      const region = regionHint(outcome.statement);
      const landmark = region ? LANDMARK_FOR_REGION[region] : undefined;
      assertions.push({
        id: outcome.id.replace(/^O/, 'A'),
        statement: outcome.statement,
        check: {
          type: 'accessible',
          ...(landmark ? { target: { description: `the ${region} region`, role: landmark } } : {}),
        },
        ...(outcome.critical === false ? { critical: false } : {}),
      });
      continue;
    }

    if (outcome.observable === 'api_response') {
      const check = apiCheckFrom(outcome.statement);
      if (!check) {
        exceptions.push({
          kind: 'api_endpoint_unknown',
          where: outcome.id,
          summary: `"${outcome.statement}" is settled by an API call, and nothing states which one.`,
          candidates: [],
          asks: 'Which call carries this? Run the mission once, pick the method and URL from network.json in its evidence folder, and set check.request (and status or json_path) on this assertion.',
        });
        continue;
      }
      if (check.status === undefined) {
        exceptions.push({
          kind: 'approximated',
          where: outcome.id,
          summary: `"${outcome.statement}" is bound to the ${check.request!.method ?? ''} ${check.request!.url_contains} call, but only checks that it was made.`,
          candidates: [],
          asks: 'Which status code or response field proves the outcome? Add check.status, or check.json_path with check.value.',
        });
      }
      assertions.push({
        id: outcome.id.replace(/^O/, 'A'),
        statement: outcome.statement,
        check,
        ...(outcome.critical === false ? { critical: false } : {}),
      });
      continue;
    }

    let plan = CHECK_FOR[outcome.observable];
    /**
     * "exactly three products are listed" is a count, not a text comparison.
     * Mapping it to text_equals asked for an exact string the statement never
     * contained, which is why so many countable outcomes reported value_unknown.
     */
    const count = statedCount(outcome.statement);
    if (count !== undefined && (plan.type === 'text_equals' || plan.type === 'visible')) {
      plan = { type: 'count', needsValue: false, approximate: false };
    }
    const candidates = findCandidates(outcome.statement, pages, []);

    if (outcome.observable === 'ui_matches_api') {
      const call = apiCheckFrom(outcome.statement);
      const path = jsonPathFrom(outcome.statement);
      if (!call?.request || !path) {
        exceptions.push({
          kind: call?.request ? 'value_unknown' : 'api_endpoint_unknown',
          where: outcome.id,
          summary: `"${outcome.statement}" compares the UI with an API field, but ${call?.request ? 'not which field' : 'not which call'}.`,
          candidates: candidates.slice(0, 5).map(describeCandidate),
          asks: 'Name the call and the field in the outcome, e.g. "the cart badge matches `items.length` from GET /api/cart", or set check.request and check.json_path here.',
        });
        continue;
      }
      const region = regionHint(outcome.statement);
      const best = candidates[0];
      const unambiguous = best && (candidates.length === 1 || (candidates[1] && candidates[1].score < best.score));
      if (!unambiguous) {
        exceptions.push({
          kind: 'approximated',
          where: outcome.id,
          summary: `"${outcome.statement}" is compared against the page's ${region ?? 'main'} region, because no single element on the page clearly shows the value.`,
          candidates: candidates.slice(0, 5).map(describeCandidate),
          asks: 'Which element shows the value? A whole region also contains other numbers, so it can agree by accident.',
        });
      }
      assertions.push({
        id: outcome.id.replace(/^O/, 'A'),
        statement: outcome.statement,
        check: {
          type: 'ui_matches_api',
          target: unambiguous
            ? targetFor(outcome.statement, best.control, region)
            : { description: `the ${region ?? 'main'} region`, role: (region && LANDMARK_FOR_REGION[region]) || 'main' },
          request: { ...(call.request.method ? { method: call.request.method } : {}), url_contains: call.request.url_contains },
          json_path: path,
        },
        ...(outcome.critical === false ? { critical: false } : {}),
      });
      continue;
    }

    const stated = plan.needsValue ? expectedValueFrom(outcome.statement, plan.type) : undefined;

    if (plan.needsValue && !stated) {
      exceptions.push({
        kind: 'value_unknown',
        where: outcome.id,
        summary: `"${outcome.statement}" needs an exact ${
          plan.type === 'url_contains' ? 'URL fragment' : 'expected text'
        }, and nothing in the requirement states one.`,
        candidates: candidates.slice(0, 5).map(describeCandidate),
        asks:
          plan.type === 'url_contains'
            ? 'What path should the user end up on?'
            : 'What exactly does the product say here? Binding this to a bare visibility check would pass against an empty alert box.',
      });
      continue;
    }

    /**
     * Not every outcome is about something you click.
     *
     * The binder searched `page.controls` and nothing else, so an assertion
     * about a paragraph of footer text or a logo reported "nothing on the page
     * corresponds to this" — while the capture held the text and the image all
     * along, in `textSample`, `headings` and `images`. Most acceptance criteria
     * are about what a user *reads*, not what they press, so this was the single
     * largest reason intents never became missions.
     *
     * Two kinds of evidence resolve without any control:
     *
     *  - an **image**, checked with `image_loaded` (a broken image is still
     *    "visible", which is why a plain visibility check cannot stand in)
     *  - **text**, checked with `text_contains` scoped to a landmark
     *
     * Crucially these bind even when the page does NOT currently match. An
     * assertion that refuses to exist unless the product already passes is
     * worthless — EC-006 exists precisely to catch "perpose" where the
     * requirement says "purpose", and requiring the expected text to be present
     * before binding would have skipped the one check that finds it.
     */
    const imageEvidence = wantsImage(outcome.statement) ? findImages(outcome.statement, pages) : [];
    if (imageEvidence.length > 0 && plan.type !== 'count') {
      const img = imageEvidence[0]!;
      assertions.push({
        id: outcome.id.replace(/^O/, 'A'),
        statement: outcome.statement,
        check: {
          type: 'image_loaded',
          target: img.alt
            ? { description: `the image "${img.alt}"`, role: 'img', name: img.alt }
            : { description: 'the image', selector: `img[src*="${img.src.split('/').pop()}"]` },
        },
        ...(outcome.critical === false ? { critical: false } : {}),
      });
      continue;
    }

    const expectedText =
      plan.type === 'text_equals' || plan.type === 'text_contains'
        ? stated
        : expectedValueFrom(outcome.statement, 'text_contains');

    if (expectedText && plan.type !== 'count' && plan.type !== 'url_contains') {
      const region = regionHint(outcome.statement);
      const landmark = region ? LANDMARK_FOR_REGION[region] : undefined;
      if (!landmark) {
        exceptions.push({
          kind: 'approximated',
          where: outcome.id,
          summary: `"${outcome.statement}" was checked against the page's main region, because the wording does not say which part of the page the text belongs to.`,
          asks: 'If this text lives somewhere specific (the header, the footer), say so in the outcome and the check will be scoped to it.',
        });
      }
      assertions.push({
        id: outcome.id.replace(/^O/, 'A'),
        statement: outcome.statement,
        check: {
          type: 'text_contains',
          target: { description: `the ${region ?? 'main'} region`, role: landmark ?? 'main' },
          value: expectedText,
        },
        ...(outcome.critical === false ? { critical: false } : {}),
      });
      continue;
    }

    if (candidates.length === 0) {
      exceptions.push({
        kind: 'no_candidate',
        where: outcome.id,
        summary: `Nothing on the page corresponds to "${outcome.statement}".`,
        asks: 'Is the thing this asserts about missing from the build, or is the outcome describing something the UI never shows?',
      });
      continue;
    }

    const best = candidates[0] as Candidate;

    /**
     * A count check must target the thing being counted.
     *
     * "exactly three products are listed" bound to the *Electronics button* —
     * one element — and reported "expected 3, found 1" as a PRODUCT_DEFECT with
     * high confidence. The product cards are not in the capture as a countable
     * control, so there is nothing honest to bind this to, and binding it to
     * whatever scored highest manufactures a defect out of a modelling gap.
     *
     * A repeated control (capture count > 1) can plausibly be the counted set.
     * Anything else is refused and handed to a human.
     */
    /**
     * You cannot count eight of something the page only ever had two of.
     *
     * Requiring merely "more than one" was far too weak: "Eight products are
     * listed" bound to the nav link named *Products* — two of them — and
     * reported a PRODUCT_DEFECT at high confidence because it found 2 instead
     * of 8. The candidate has to be numerous enough to plausibly BE the counted
     * set, which also still permits a filter test (8 captured, 3 expected after
     * filtering) where the count legitimately shrinks at run time.
     */
    if (plan.type === 'count' && count !== undefined && best.control.count < count) {
      exceptions.push({
        kind: 'no_candidate',
        where: outcome.id,
        summary: `"${outcome.statement}" expects ${count}, but the closest match ("${best.control.name}") occurs only ${best.control.count} time(s) on the captured page — so it is not the thing being counted.`,
        candidates: candidates.slice(0, 5).map(describeCandidate),
        asks:
          'What single element represents one of the things being counted? The capture records controls, not repeated content blocks, so a "product card" has no name to count yet.',
      });
      continue;
    }

    if (plan.type === 'count' && best.control.count <= 1) {
      exceptions.push({
        kind: 'no_candidate',
        where: outcome.id,
        summary: `"${outcome.statement}" counts something the capture does not expose as a countable element — the closest match ("${best.control.name}") occurs once, so counting it would compare against the wrong thing.`,
        candidates: candidates.slice(0, 5).map(describeCandidate),
        asks:
          'What on the page represents one of the things being counted? Until that is nameable, ' +
          'this check would report a defect whenever the binding is wrong rather than when the product is.',
      });
      continue;
    }

    /**
     * A URL check needs no element at all — binding it to whatever control
     * happened to score highest would make the assertion depend on something
     * irrelevant to what it claims.
     */
    if (plan.type === 'url_contains' && stated) {
      assertions.push({
        id: outcome.id.replace(/^O/, 'A'),
        statement: outcome.statement,
        check: { type: 'url_contains', value: stated },
        ...(outcome.critical === false ? { critical: false } : {}),
      });
      continue;
    }

    /**
     * Absence only means something about a thing that would otherwise be there.
     * See stableControls above for how a spinner label turned an assertion into
     * a tautology.
     */
    if (
      (plan.type === 'not_visible' || plan.approximate) &&
      !stableControls.has(`${best.control.role}:${best.control.name}`)
    ) {
      exceptions.push({
        kind: 'no_candidate',
        where: outcome.id,
        summary:
          `"${outcome.statement}" has no stable thing on the page to check. The closest match, ` +
          `"${best.control.name}", appears only part-way through a flow — a spinner, a transient banner — so a ` +
          `${plan.type} check on it would hold whatever the product did.`,
        candidates: candidates.slice(0, 5).map(describeCandidate),
        asks:
          'What is on the page when this outcome holds, and what is on it when the outcome fails? ' +
          'An outcome phrased as what the user SEES on failure binds; one phrased as what does not happen cannot.',
      });
      continue;
    }

    if (plan.approximate) {
      exceptions.push({
        kind: 'approximated',
        where: outcome.id,
        summary: `"${outcome.statement}" was bound to a ${plan.type} check on ${describeCandidate(best)} — the closest thing available, not a faithful check.`,
        candidates: candidates.slice(0, 5).map(describeCandidate),
        asks: `Does a ${plan.type} check on that element really prove this outcome? If not, say what would.`,
      });
    }

    assertions.push({
      id: outcome.id.replace(/^O/, 'A'),
      statement: outcome.statement,
      check: {
        type: plan.type,
        target: targetFor(outcome.statement, best.control, regionHint(outcome.statement)),
        ...(plan.type === 'count' && count !== undefined
          ? { value: count }
          : stated
            ? { value: stated }
            : {}),
      },
      ...(outcome.critical === false ? { critical: false } : {}),
    });
  }

  /**
   * Check a URL assertion when the page is actually there.
   *
   * Assertions are evaluated at the end of the flow. For a mission that visits
   * four destinations in turn, that means every "leads to /products" check runs
   * while the browser is sitting on the LAST page — so three of four fail and
   * the classifier calls it a PRODUCT_DEFECT with high confidence. That is a
   * confident false defect, the exact outcome this system exists to prevent,
   * and it is the mission's shape at fault rather than the product.
   *
   * The contract already has the answer: a `verify` action with an
   * `assertion_ref` evaluates one assertion mid-flow. Each URL assertion is
   * paired with the step it belongs to by word overlap, and checked right after
   * that step runs.
   */
  const urlAssertions = assertions.filter((a) => a.check.type === 'url_contains');
  if (urlAssertions.length > 1) {
    const clickIndexes = actions
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a.action === 'click');

    const used = new Set<number>();
    for (const assertion of urlAssertions) {
      const words = contentWords(assertion.statement);
      let bestIdx = -1;
      let bestScore = 0;
      for (const { a, i } of clickIndexes) {
        if (used.has(i)) continue;
        const shared = contentWords(a.instruction).filter((w) => words.includes(w)).length;
        if (shared > bestScore) {
          bestScore = shared;
          bestIdx = i;
        }
      }
      if (bestIdx === -1 || bestScore === 0) continue;
      used.add(bestIdx);
      actions.splice(
        actions.findIndex((a) => a === actions[bestIdx]) + 1,
        0,
        {
          action: 'verify',
          instruction: `Check, while still on the page it just opened: ${assertion.statement}`,
          assertion_ref: assertion.id,
        },
      );
    }

    if (used.size > 0) {
      exceptions.push({
        kind: 'approximated',
        where: 'flow',
        summary: `${used.size} URL check(s) were moved to run immediately after the navigation they describe, paired by wording.`,
        asks: 'Confirm each check is paired with the right step — the pairing is by word overlap, not by anything the intent stated.',
      });
    }
  }

  // --- Assemble -------------------------------------------------------------

  const confidence: BindOutcome['confidence'] =
    exceptions.length === 0 ? 'high' : exceptions.some((e) => e.kind === 'no_candidate' || e.kind === 'unsupported_step') ? 'low' : 'medium';

  /**
   * A mission with no assertion cannot prove anything, so there is nothing to
   * approve. But a mission with only a navigate action is perfectly valid:
   * "open the storefront and verify eight products are listed" does exactly one
   * thing and then checks. Requiring a second action rejected that whole class —
   * and rejected it *silently*, with no exception recorded, so three intents
   * appeared in the reconciliation with a blank reason and no way to tell why.
   *
   * Whatever is refused from here on says so out loud.
   */
  if (assertions.length === 0) {
    exceptions.push({
      kind: 'no_candidate',
      where: 'outcomes',
      summary:
        'None of this intent’s outcomes could be bound to a check, so the mission would assert nothing.',
      asks:
        'Each exception above names what could not be resolved. Settle those, or mark the intent manual if the executor genuinely cannot verify it.',
    });
    return { intent, exceptions, confidence: 'low' };
  }

  const mission: TestMission = {
    test_id: intent.test_id,
    ...(intent.requirement_ref ? { requirement_ref: { ...intent.requirement_ref } } : {}),
    feature: intent.feature,
    module: intent.module ?? intent.capability.split('.')[0] ?? intent.feature,
    capability: intent.capability,
    priority: intent.priority,
    role,
    auth: resolveAuth(role, ctx),
    environment: 'STAGE',
    ...(intent.viewport ? { viewport: intent.viewport } : {}),
    ...(intent.browser ? { browser: intent.browser } : {}),
    ...(intent.examples?.length
      ? {
          examples: intent.examples.map((e) => {
            const { outcome_ids, ...row } = e;
            const ids = (outcome_ids ?? []).map((o) => o.replace(/^O/, 'A')).filter((a) => assertions.some((x) => x.id === a));
            return { ...row, ...(ids.length ? { assertion_ids: ids } : {}) };
          }),
        }
      : {}),
    starting_context: {
      page: startPage ? new URL(startPage.url).pathname : '/',
      ...(startPage ? { url_hint: new URL(startPage.url).pathname } : {}),
    },
    preconditions: [
      ...intent.preconditions,
      ...(intent.test_data ?? []).map((d) => `${d.description} (${d.provisioning ?? 'unknown'})`),
    ],
    test_objective: intent.test_objective,
    ...(intent.coverage ? { coverage: intent.coverage } : {}),
    expected_outcome: intent.expected_outcome,
    data_policy: {
      creates_artifacts: (intent.test_data ?? []).some((d) => d.provisioning === 'created_by_test'),
      naming_pattern: 'AI QA {run_id}',
      cleanup: (intent.test_data ?? []).some((d) => d.disposable) ? 'none' : 'best_effort',
      ...((intent.test_data ?? []).some((d) => d.disposable)
        ? {
            cleanup_instruction:
              'This mission consumes its data (a disposable account cannot be reused). It needs a fresh instance per run, not teardown.',
          }
        : {}),
    },
    actions,
    assertions,
    evidence_policy: {
      screenshot: 'on_failure',
      trace: 'retain_on_failure',
      console: true,
      network: true,
      snapshot_on_failure: true,
    },
    budget: { max_steps: Math.max(10, actions.length * 3), timeout_ms: 120_000, max_discovery_attempts: 3 },
    rerun_policy: { replay_on_failure: true, on_divergence: 'INCONCLUSIVE' },
    binding: {
      intent_ref: intent.test_id,
      intent_hash: hashIntent(intent),
      bound_at: new Date().toISOString(),
      bound_against: { build: capture.build, captured_at: capture.captured_at, url: startPage?.url ?? '' },
      confidence,
      exceptions: exceptions.map((e) => ({ kind: e.kind, where: e.where, summary: e.summary })),
      ...(intent.assumption ? { rests_on_assumption: true } : {}),
    },
  };

  return { intent, mission, exceptions, confidence };
}

/**
 * Controls nobody wrote an intent for.
 *
 * The third column of the reconciliation, and the one no existing process
 * produces. A page offering "Sign in with Google" that no intent mentions is
 * not a failure of any test — it is a question nobody has asked.
 */
export function findUncovered(
  intents: TestIntent[],
  capture: Capture,
): { url: string; control: ControlFact }[] {
  const mentioned = new Set<string>();
  for (const intent of intents) {
    const text = [
      intent.test_objective,
      ...intent.steps.map((s) => s.actor_intent),
      ...intent.outcomes.map((o) => o.statement),
      ...intent.preconditions,
    ]
      .join(' ')
      .toLowerCase();
    for (const w of contentWords(text)) mentioned.add(w);
  }

  const interactive = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'switch']);
  const out: { url: string; control: ControlFact }[] = [];

  for (const page of capture.pages) {
    for (const control of page.controls) {
      if (!interactive.has(control.role) || !control.name) continue;
      const words = contentWords(control.name);
      if (words.length === 0) continue;
      const covered = words.some((w) => mentioned.has(w));
      if (!covered) out.push({ url: page.url, control });
    }
  }

  return out;
}
