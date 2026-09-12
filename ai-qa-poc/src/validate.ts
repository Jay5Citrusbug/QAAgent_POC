import fs from 'node:fs';
import path from 'node:path';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { PATHS } from './config.js';
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
 * but still wrong. Returned as warnings so a human sees them at Gate 1.
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
  }

  for (const [i, action] of m.actions.entries()) {
    const needsTarget: string[] = ['click', 'fill', 'type', 'select', 'check', 'upload', 'hover'];
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

  if (/\band\b/i.test(m.test_objective)) {
    warnings.push('test_objective contains "and" — this may really be two missions.');
  }

  return warnings;
}

export function readMissionFile(file: string): TestMission {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as TestMission;
}

export function isApproved(m: TestMission): boolean {
  return Boolean(m.approval?.approved_by && m.approval?.approved_at);
}

export type { ExecutionResult, TestMission };
