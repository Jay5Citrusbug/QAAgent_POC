import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { PATHS } from './config.js';
import { blocking, resolveDependencies, type Ledger } from './clarifications.js';
import type { TestIntent } from './types.js';
import type { ValidationOutcome } from './validate.js';

/**
 * Test intents — the UI-free half of the two-phase test (VISION section 5a).
 *
 * Kept separate from validate.ts on purpose. That module knows about targets,
 * checks and Playwright expectations; this one must not, because the whole
 * value of an intent is that it cannot express a locator. Sharing a module
 * would put the vocabulary one import away from creeping back in.
 */

let intentValidator: ValidateFunction | undefined;

function format(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
}

export function validateIntent(data: unknown): ValidationOutcome {
  if (!intentValidator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = JSON.parse(
      fs.readFileSync(path.join(PATHS.schemas, 'test-intent.schema.json'), 'utf8'),
    );
    intentValidator = ajv.compile(schema);
  }
  const valid = intentValidator(data) as boolean;
  return { valid, errors: valid ? [] : format(intentValidator.errors) };
}

export function readIntentFile(file: string): TestIntent {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as TestIntent;
}

export function isApproved(i: TestIntent): boolean {
  return Boolean(i.approval?.approved_by && i.approval?.approved_at);
}

export function listIntents(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * Does "and" join two actions or outcomes ("signs in and sees the dashboard"),
 * rather than two nouns ("email and password", "mobile and tablet sizes")?
 *
 * Only the first is two tests wearing one coat. Flagging every "and" fired on
 * most generated titles, and a warning that fires on everything is read by
 * nobody — so it looks for a verb in the few words after the "and".
 */
const CLAUSE_VERBS = new Set(
  'is are was be shows show shown displays displayed sees see receives gets returns redirects navigates lands appears remains stays updates persists saves sends creates deletes adds removes logs signs submits clears resets keeps can cannot must should will does'.split(' '),
);

export function joinsTwoClauses(objective: string): boolean {
  const words = objective.toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  return words.some((w, at) => w === 'and' && words.slice(at + 1, at + 5).some((n) => CLAUSE_VERBS.has(n)));
}

/**
 * Words that mean the author was thinking about a screen rather than about the
 * product. The schema already makes a `target` unrepresentable, but nothing
 * stops someone writing "click the blue Sign In button at the top right" into
 * `actor_intent` — which reintroduces exactly the coupling the split exists to
 * remove, only now invisible to every tool.
 *
 * A warning rather than an error: "button" sometimes genuinely is the product's
 * own vocabulary, and a linter that cries wolf gets ignored, which costs more
 * than the occasional false positive.
 */
const UI_VOCABULARY = [
  'click',
  'button',
  'checkbox',
  'dropdown',
  'textbox',
  'text box',
  'input field',
  'css',
  'xpath',
  'selector',
  'aria-',
  'data-testid',
  'top right',
  'top-right',
  'bottom left',
  'bottom-left',
  'hamburger',
  'modal',
  'placeholder',
  'scroll down',
  'tab key',
];

/** The observables a `blocked` intent should normally be asserting. */
const REFUSAL_OBSERVABLES = new Set(['message_shown', 'access_denied', 'element_absent', 'state_change']);

/**
 * Semantic checks the schema cannot express. Warnings, for the human at Gate 2.
 */
export function lintIntent(i: TestIntent, ledger?: Ledger): string[] {
  const warnings: string[] = [];

  if (!i.requirement_ref) {
    warnings.push(
      'No requirement_ref: results from this intent will not trace back to a requirement (success criterion 8).',
    );
  }

  // The intent is leaking UI vocabulary — see UI_VOCABULARY above.
  for (const step of i.steps) {
    const said = step.actor_intent.toLowerCase();
    const leaked = UI_VOCABULARY.filter((w) => said.includes(w));
    if (leaked.length) {
      warnings.push(
        `Step ${step.id}: describes the interface, not the intent (${leaked.map((w) => `"${w}"`).join(', ')}). ` +
          'Say what the actor is trying to achieve; where to click is decided at binding time, against the page that actually ships.',
      );
    }
  }
  for (const o of i.outcomes) {
    const said = o.statement.toLowerCase();
    const leaked = UI_VOCABULARY.filter((w) => said.includes(w));
    if (leaked.length) {
      warnings.push(
        `Outcome ${o.id}: describes the interface, not the observable result (${leaked.map((w) => `"${w}"`).join(', ')}).`,
      );
    }
  }

  /**
   * A negative intent whose outcomes only say what did NOT happen.
   *
   * "The user is not signed in" is satisfied by a blank white screen, a 500,
   * and a correctly-worded error alike. Unless something also asserts what the
   * user was TOLD, the test passes against a crash — which is the same false
   * pass the mission linter already guards against, one phase earlier.
   */
  if (i.expected_outcome === 'blocked') {
    const saysWhatHappened = i.outcomes.some((o) => REFUSAL_OBSERVABLES.has(o.observable));
    if (!saysWhatHappened) {
      warnings.push(
        'expected_outcome is "blocked" but no outcome says what the user is actually told or shown. ' +
          '"It did not work" is equally true of a correct refusal and of a crash — add an outcome for the refusal itself.',
      );
    }
  }

  // Data the test needs but nobody can supply. The login case: half a login
  // suite needs accounts in states that do not exist on STAGE.
  for (const d of i.test_data ?? []) {
    if (!d.provisioning || d.provisioning === 'unknown') {
      warnings.push(
        `test_data "${d.name}": provisioning is unknown, so this intent has no confirmed way to run. ` +
          'Decide this before Gate 2 — an approved test that cannot be executed reads as the system failing.',
      );
    }
    if (d.disposable && d.provisioning === 'seeded') {
      warnings.push(
        `test_data "${d.name}": marked disposable but provisioned as a seeded fixture. ` +
          'A test that consumes the account (a lockout test does) poisons it for every later run — it needs a fresh instance, not cleanup.',
      );
    }
  }

  const dataNames = new Set((i.test_data ?? []).map((d) => d.name));
  for (const step of i.steps) {
    if (step.data_ref && !dataNames.has(step.data_ref)) {
      warnings.push(`Step ${step.id}: data_ref "${step.data_ref}" has no matching test_data entry.`);
    }
  }

  if (joinsTwoClauses(i.test_objective)) {
    warnings.push('test_objective joins two actions or outcomes with "and" — this may really be two intents.');
  }

  if (!i.coverage?.category) {
    warnings.push('No coverage.category: this intent counts toward nothing in the coverage report.');
  }
  if (i.coverage?.execution_mode === 'manual' && !i.coverage.manual_reason) {
    warnings.push(
      'execution_mode is "manual" but no manual_reason is given — say which capability is missing, or it will not get scheduled.',
    );
  }

  if (ledger) {
    const deps = resolveDependencies(i.depends_on_clarifications, ledger);
    for (const d of deps) {
      if (d.state === 'assumed') {
        warnings.push(
          `${d.id} is answered by assumption, not confirmation. This intent tests a rule nobody has agreed to yet.`,
        );
      }
    }
  }

  return warnings;
}

/**
 * Gate 2's hard condition, separate from the lint warnings above.
 *
 * Everything lintIntent returns is a judgement call for a human. This is not:
 * an intent resting on an unanswered question asserts behaviour nobody has
 * stated, and approving it converts a guess into something the system will
 * later report as a product defect. Refusing is the entire point of the ledger.
 */
export function approvalBlockers(i: TestIntent, ledger: Ledger): string[] {
  return blocking(resolveDependencies(i.depends_on_clarifications, ledger)).map((d) =>
    d.state === 'missing'
      ? `${d.id} is referenced by this intent but does not exist in ${path.basename(ledger.file)}.`
      : `${d.id} is still open: "${d.question.question}"`,
  );
}

/**
 * Hash of what an intent asserts, ignoring its approval stamp.
 *
 * Recorded on the mission at bind time. If the intent is edited afterwards the
 * mission is still testing the old version — schema-valid, approved, and wrong.
 */
export function hashIntent(intent: TestIntent): string {
  const { approval: _approval, ...rest } = intent;
  return `sha256:${crypto.createHash('sha256').update(stable(rest), 'utf8').digest('hex').slice(0, 32)}`;
}

/** Key-order-independent JSON, so reformatting a file is not mistaken for an edit. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export type { TestIntent };
