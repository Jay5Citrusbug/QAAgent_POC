import type { Capture } from './captures.js';
import type { ControlFact, PageReality } from './inspector.js';
import type {
  ActionType,
  AppContext,
  CheckType,
  Observable,
  TestIntent,
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
  | 'data_unprovisioned';

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
  // Arriving somewhere. Matched first because "go to the cart and add an item"
  // is a navigation followed by an action, not one ambiguous blob.
  { test: /\b(arrive at|land on|visit|navigate)\b/i, action: 'navigate', wants: [] },

  // Authentication reads like a click but is a fill-then-submit; matching it as
  // a click would lose the credential fields entirely.
  { test: /\b(sign in|log in|sign-in|login|authenticate)\b/i, action: 'fill', wants: ['textbox'] },

  { test: /\b(search for|look up)\b/i, action: 'fill', wants: ['textbox', 'searchbox'] },
  { test: /\b(enter|typ(e|ing)|fill|supply|provid(e|ing)|input)\b/i, action: 'fill', wants: ['textbox'] },

  // Catalogue verbs. "narrow the catalogue to Electronics" was previously
  // unmatched, which reported a missing control when the control was right
  // there — a false finding, and the most expensive kind of wrong here.
  { test: /\b(filter|narrow|restrict|limit|refine)\b/i, action: 'click', wants: ['button', 'link', 'checkbox'] },

  { test: /\b(add|put|place)\b.*\b(cart|basket|bag|order)\b/i, action: 'click', wants: ['button'] },
  { test: /\b(remove|delete|discard|clear)\b/i, action: 'click', wants: ['button', 'link'] },
  { test: /\b(open|view|go to|show|display|reveal)\b/i, action: 'click', wants: ['link', 'button', 'tab'] },

  { test: /\b(submit|send|confirm|save|continue|proceed|apply|checkout|check out)\b/i, action: 'click', wants: ['button'] },
  { test: /\b(choose|select|pick)\b/i, action: 'select', wants: ['combobox', 'listbox'] },
  { test: /\b(tick|check|enable|opt in|opting)\b/i, action: 'check', wants: ['checkbox'] },
  { test: /\b(upload|attach)\b/i, action: 'upload', wants: ['button'] },
  { test: /\b(click|press|tap|activate|follow)\b/i, action: 'click', wants: ['button', 'link'] },
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

// --- Candidate matching ------------------------------------------------------

interface Candidate {
  control: ControlFact;
  url: string;
  score: number;
}

function findCandidates(text: string, pages: PageReality[], wantRoles: string[]): Candidate[] {
  const words = contentWords(text);
  const out: Candidate[] = [];

  for (const page of pages) {
    for (const control of page.controls) {
      if (wantRoles.length && !wantRoles.includes(control.role)) continue;

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
const CHECK_FOR: Record<Observable, { type: CheckType; needsValue: boolean; approximate: boolean }> = {
  message_shown: { type: 'text_contains', needsValue: true, approximate: false },
  navigation: { type: 'url_contains', needsValue: true, approximate: false },
  state_change: { type: 'visible', needsValue: false, approximate: true },
  element_present: { type: 'visible', needsValue: false, approximate: false },
  element_absent: { type: 'not_visible', needsValue: false, approximate: false },
  value_equals: { type: 'text_equals', needsValue: true, approximate: false },
  data_persisted: { type: 'visible', needsValue: false, approximate: true },
  access_denied: { type: 'not_visible', needsValue: false, approximate: true },
};

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
  const pages = capture.pages;

  const { role, exception: roleException } = resolveRole(intent, ctx);
  if (roleException) exceptions.push(roleException);

  // Data the intent needs but nobody has confirmed how to supply. Caught at
  // Gate 1 as a warning; here it becomes a hard reason the mission cannot run.
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
  const startPage = pages[0];

  if (startPage) {
    actions.push({
      action: 'navigate',
      instruction: `Open ${startPage.url}`,
      url: new URL(startPage.url).pathname,
    });
  }

  for (const step of intent.steps) {
    const text = step.actor_intent;

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

    if (tooClose || best.control.count > 1) {
      exceptions.push({
        kind: 'ambiguous',
        where: step.id,
        summary: `"${text}" could mean more than one thing on this page.`,
        candidates: candidates.slice(0, 5).map(describeCandidate),
        asks: 'Which one? Picking the wrong control here is how a test passes for the wrong reason.',
      });
      continue;
    }

    actions.push({
      action: verb.action,
      instruction: text,
      target: {
        description: text,
        role: best.control.role,
        name: best.control.name,
      },
      ...(verb.action === 'fill' || verb.action === 'type' ? { value: '{run_id}' } : {}),
      ...(intent.expected_outcome === 'blocked' && step.id === intent.steps[intent.steps.length - 1]?.id
        ? { tolerate_failure: true }
        : {}),
    });

    if (verb.action === 'fill') {
      exceptions.push({
        kind: 'value_unknown',
        where: step.id,
        summary: `"${text}" fills a field, but the intent does not say with what.`,
        asks: 'What value should go in? A placeholder {run_id} was written in so the mission validates — it is almost certainly not what you want.',
      });
    }
  }

  // --- Outcomes → assertions -----------------------------------------------

  const assertions: TestMission['assertions'] = [];

  for (const outcome of intent.outcomes) {
    const plan = CHECK_FOR[outcome.observable];
    const candidates = findCandidates(outcome.statement, pages, []);

    if (plan.needsValue) {
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
        target: { description: outcome.statement, role: best.control.role, name: best.control.name },
      },
      ...(outcome.critical === false ? { critical: false } : {}),
    });
  }

  // --- Assemble -------------------------------------------------------------

  const confidence: BindOutcome['confidence'] =
    exceptions.length === 0 ? 'high' : exceptions.some((e) => e.kind === 'no_candidate' || e.kind === 'unsupported_step') ? 'low' : 'medium';

  // A mission with no assertion cannot prove anything, and a mission with no
  // action cannot do anything. Either way there is nothing to approve.
  if (assertions.length === 0 || actions.length <= 1) {
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
