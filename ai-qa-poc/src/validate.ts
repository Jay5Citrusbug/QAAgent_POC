import fs from 'node:fs';
import path from 'node:path';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { PATHS } from './config.js';
import { joinsTwoClauses } from './intents.js';
import type { ExecutionResult, TestMission } from './types.js';

function compile(schemaFile: string): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(path.join(PATHS.schemas, schemaFile), 'utf8'));
  return ajv.compile(schema);
}

let missionValidator: ValidateFunction | undefined;
let resultValidator: ValidateFunction | undefined;

function format(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
}

export interface ValidationOutcome {
  valid: boolean;
  errors: string[];
}

export function validateMission(data: unknown): ValidationOutcome {
  missionValidator ??= compile('test-mission.schema.json');
  const valid = missionValidator(data) as boolean;
  return { valid, errors: valid ? [] : format(missionValidator.errors) };
}

export function validateResult(data: unknown): ValidationOutcome {
  resultValidator ??= compile('execution-result.schema.json');
  const valid = resultValidator(data) as boolean;
  return { valid, errors: valid ? [] : format(resultValidator.errors) };
}

/**
 * Semantic checks the JSON schema cannot express — the mission is well-formed
 * but still wrong. Returned as warnings so a human sees them at Gate 2.
 */
export function lintMission(m: TestMission): string[] {
  const warnings: string[] = [];

  if (!m.requirement_ref) {
    warnings.push(
      'No requirement_ref: this result will not be traceable back to a requirement (success criterion 8).',
    );
  }

  if (m.data_policy.creates_artifacts && !m.data_policy.naming_pattern?.includes('{run_id}')) {
    warnings.push(
      'creates_artifacts is true but naming_pattern has no {run_id}: re-runs will collide and orphans will be unidentifiable.',
    );
  }

  for (const a of m.assertions) {
    if (a.check.type === 'api_response') {
      if (!a.check.request?.url_contains) {
        warnings.push(`Assertion ${a.id}: api_response has no request.url_contains — it cannot know which call to check (INCONCLUSIVE until settled).`);
      }
      if (a.check.json_path && a.check.value === undefined) {
        warnings.push(`Assertion ${a.id}: json_path "${a.check.json_path}" has no value to compare with — it only checks that the field exists.`);
      }
      if (a.check.status === undefined && !a.check.json_path && a.check.body_contains === undefined) {
        warnings.push(`Assertion ${a.id}: api_response checks only that the call was made — add status, json_path or body_contains.`);
      }
      continue;
    }
    if (a.check.type === 'api_no_errors' || a.check.type === 'layout_sound' || a.check.type === 'accessible' || a.check.type === 'looks_like_baseline' || a.check.type === 'performance_budget' || a.check.type === 'dialog_shown' || a.check.type === 'file_downloaded') continue;
    if (a.check.type === 'ui_matches_api' && (!a.check.request?.url_contains || !a.check.json_path)) {
      warnings.push(`Assertion ${a.id}: ui_matches_api needs request.url_contains and json_path — which call and which field to compare with.`);
    }
    const needsTarget = a.check.type !== 'url_contains';
    if (needsTarget && !a.check.target) {
      warnings.push(`Assertion ${a.id}: check type "${a.check.type}" needs a target.`);
    }
    const needsValue = ['text_equals', 'text_contains', 'count', 'url_contains', 'attribute_equals'];
    if (needsValue.includes(a.check.type) && a.check.value === undefined) {
      warnings.push(`Assertion ${a.id}: check type "${a.check.type}" needs a value.`);
    }
    if (a.check.type === 'attribute_equals' && !a.check.attribute) {
      warnings.push(`Assertion ${a.id}: attribute_equals needs an attribute name.`);
    }

    /**
     * Circular assertion: the element is located BY the same text the check
     * then verifies, so the check is guaranteed to hold and can never fail.
     *
     * This is not hypothetical. A generated mission asserted "the nav link
     * reads 'Home', not 'Hoem'" by locating role=link name="Home" and checking
     * its text equalled "Home". The misspelled nav link simply never matched,
     * the correctly-spelled footer link did, and the run reported PASS while
     * the bug it existed to catch went untested. A false pass is the worst
     * outcome this system can produce — it retires a real test while looking
     * like coverage.
     *
     * The fix is to locate by something other than the text under test — a
     * scope (`within`), a role, a test id — and assert the text separately.
     */
    if (a.check.type === 'text_equals' || a.check.type === 'text_contains') {
      const locatedBy = [a.check.target?.name, a.check.target?.text].filter(Boolean).map(String);
      const expected = a.check.value === undefined ? undefined : String(a.check.value);
      if (expected !== undefined && locatedBy.some((v) => v.toLowerCase() === expected.toLowerCase())) {
        warnings.push(
          `Assertion ${a.id}: CIRCULAR — the element is found by the text "${expected}" and then checked for that same text, ` +
            `so it can never fail. Locate it another way (a "within" scope, a role, a test id) and assert the text separately.`,
        );
      }
    }

    /**
     * The statement promises something the check cannot actually detect.
     *
     * This is the failure mode behind both false passes found so far. A
     * mission asserted the logo "is visible and rendered (not a broken image
     * placeholder)" with a `visible` check — but a broken <img> IS visible,
     * so it passed against a 404ing image. The human reading Gate 2 sees the
     * promise in the statement and assumes the check delivers it.
     */
    const says = a.statement.toLowerCase();
    const t = a.check.type;

    if (/broken|placeholder|loads?\b|renders?\b|displays? correctly/.test(says) && t === 'visible') {
      warnings.push(
        `Assertion ${a.id}: the statement promises the image actually loaded, but a "visible" check cannot detect that — ` +
          `a broken image is still visible. Use check type "image_loaded".`,
      );
    }

    if (/accessible name|screen reader|aria-label|labell?ed/.test(says) && (t === 'visible' || t === 'enabled')) {
      warnings.push(
        `Assertion ${a.id}: the statement is about an accessible name, but "${t}" does not check one. ` +
          `Use check type "has_accessible_name".`,
      );
    }

    if (/\bnot\b.*\b(empty|blank|missing)\b/.test(says) && t === 'visible') {
      warnings.push(
        `Assertion ${a.id}: the statement claims something is not empty/blank, but "visible" only checks the element is rendered. ` +
          `Pick a check that inspects content.`,
      );
    }

    // An assertion about one region that could match an identical element
    // elsewhere grades whichever it happens to find first. Targeting the
    // landmark itself (role=contentinfo for a footer, navigation for a nav)
    // already scopes it, so only warn when nothing pins it down.
    const LANDMARK_FOR: Record<string, string> = {
      nav: 'navigation',
      navigation: 'navigation',
      menu: 'navigation',
      header: 'banner',
      footer: 'contentinfo',
      sidebar: 'complementary',
    };
    const statement = a.statement.toLowerCase();
    const region = Object.keys(LANDMARK_FOR).find((r) => statement.includes(r));
    const target = a.check.target;
    if (region && target) {
      const landmark = LANDMARK_FOR[region];
      const scoped =
        Boolean(target.within) ||
        Boolean(target.test_id) ||
        target.role === landmark ||
        target.within?.role === landmark;
      if (!scoped) {
        warnings.push(
          `Assertion ${a.id}: mentions the ${region} but its target is not scoped to it ` +
            `(no "within", no test id, and the target's own role is not "${landmark}"), ` +
            `so a matching element in another region would be graded instead.`,
        );
      }
    }
  }

  for (const [i, action] of m.actions.entries()) {
    if (action.action === 'fail_requests') {
      if (!action.request?.url_contains || !action.failure) {
        warnings.push(`Action ${i + 1} (fail_requests): needs request.url_contains and failure.`);
      } else if (action.request.url_contains === 'SET-AT-GATE-2.5') {
        warnings.push(`Action ${i + 1} (fail_requests): the endpoint to fail was never chosen — the fault will hit nothing and the test proves nothing.`);
      }
      if (m.actions.slice(0, i).some((a) => a.action !== 'fail_requests' && a.action !== 'navigate')) {
        warnings.push(`Action ${i + 1} (fail_requests): comes after the user already acted — calls made before it were not failed.`);
      }
    }
    if (action.action === 'api_request' && !action.url) {
      warnings.push(`Action ${i + 1} (api_request): needs a url (the path, relative to base_url).`);
    }
    if ((action.action === 'api_request' || action.action === 'navigate') && /\{saved\.(\w+)\}/.test(`${action.url ?? ''}${JSON.stringify(action.body ?? '')}`)) {
      const used = [...`${action.url ?? ''}${JSON.stringify(action.body ?? '')}`.matchAll(/\{saved\.(\w+)\}/g)].map((x) => x[1]);
      const savedBefore = new Set(m.actions.slice(0, i).flatMap((x) => x.save?.map((sv) => sv.as) ?? []));
      for (const name of used) if (!savedBefore.has(name!)) warnings.push(`Action ${i + 1} (${action.action}): uses {saved.${name}}, which no earlier step saves.`);
    }
    if (action.action === 'drag' && !action.to) warnings.push(`Action ${i + 1} (drag): needs "to", where to drop it.`);
    const needsTarget: string[] = ['click', 'fill', 'type', 'select', 'check', 'upload', 'hover', 'download', 'drag'];
    if (needsTarget.includes(action.action) && !action.target) {
      warnings.push(`Action ${i + 1} (${action.action}): needs a target.`);
    }
    if (action.action === 'upload' && !action.data_ref) {
      warnings.push(`Action ${i + 1} (upload): needs a data_ref naming a test_data entry.`);
    }
    if (action.target?.selector && !action.target.role && !action.target.name) {
      warnings.push(
        `Action ${i + 1}: uses a raw selector with no semantic fallback — it will break on the next UI change.`,
      );
    }
    if (action.tolerate_failure && m.expected_outcome !== 'blocked') {
      warnings.push(
        `Action ${i + 1}: tolerate_failure on a mission whose expected_outcome is "succeeds" — probably a mistake.`,
      );
    }
  }

  const refs = new Set((m.test_data ?? []).map((d) => d.name));
  for (const [i, action] of m.actions.entries()) {
    if (action.data_ref && !refs.has(action.data_ref)) {
      warnings.push(`Action ${i + 1}: data_ref "${action.data_ref}" has no matching test_data entry.`);
    }
  }

  if (m.expected_outcome === 'blocked' && !m.actions.some((a) => a.tolerate_failure)) {
    warnings.push(
      'expected_outcome is "blocked" but no action is marked tolerate_failure — the step the app should refuse will be reported as an execution failure.',
    );
  }

  if (!m.coverage?.category) {
    warnings.push(
      'No coverage.category: this mission counts toward nothing in the coverage report, which makes the gap list dishonest.',
    );
  }

  // A ui_ux mission that promises a visual judgement cannot deliver one.
  if (m.coverage?.category === 'ui_ux' && m.coverage.execution_mode !== 'manual') {
    const looksy = m.assertions.filter((a) =>
      /align|spacing|overlap|colou?r|contrast|font|looks|appearance|layout|centred|centered/i.test(a.statement),
    );
    if (looksy.length) {
      warnings.push(
        `Assertion${looksy.length > 1 ? 's' : ''} ${looksy.map((a) => a.id).join(', ')}: ` +
          'promises a visual judgement that DOM assertions cannot make (a white icon on a white background passes every check there is). ' +
          'Check structure/content instead, or set coverage.execution_mode to "manual".',
      );
    }
  }

  if (m.coverage?.execution_mode === 'manual' && !m.coverage.manual_reason) {
    warnings.push(
      'execution_mode is "manual" but no manual_reason is given — say which capability is missing, or it will not get scheduled.',
    );
  }

  if (joinsTwoClauses(m.test_objective)) {
    warnings.push('test_objective joins two actions or outcomes with "and" — this may really be two missions.');
  }

  return warnings;
}

export function readMissionFile(file: string): TestMission {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as TestMission;
}

/**
 * Does this mission belong to `feature` (the key used by --feature)?
 *
 * Bound missions carry the key itself; hand-written ones often carry a
 * descriptive label ("E-commerce header") but cite a requirement under
 * input/feature-<key>/. Either counts. With no feature given, everything does —
 * which is what a bare `npm run run-mission` has always meant.
 */
export function missionInFeature(m: TestMission, feature?: string): boolean {
  if (!feature) return true;
  if (m.feature === feature) return true;
  const locator = m.requirement_ref?.locator?.replace(/\\/g, '/') ?? '';
  return locator.includes(`feature-${feature}/`);
}

export function isApproved(m: TestMission): boolean {
  return Boolean(m.approval?.approved_by && m.approval?.approved_at);
}

export type { ExecutionResult, TestMission };
