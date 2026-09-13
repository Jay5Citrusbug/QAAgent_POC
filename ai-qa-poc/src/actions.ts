import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { PATHS } from './config.js';
import { resolveTarget } from './discovery.js';
import { FIRST_OPTION } from './form-fill.js';
import { interpolate as interpolateValue } from './interpolate.js';
import type { LocatorCache } from './locator-cache.js';
import type { MissionAction, StepRecord, TestMission, TraceStep } from './types.js';

export class MissingTestDataError extends Error {
  readonly kind = 'missing_test_data';
}

export class NavigationError extends Error {
  readonly kind = 'navigation_error';
}

export interface ActionContext {
  page: Page;
  cache: LocatorCache;
  mission: TestMission;
  baseUrl: string;
  runId: string;
  actionTimeoutMs: number;
  maxDiscoveryAttempts: number;
}

export { interpolate } from './interpolate.js';

function resolveFixture(mission: TestMission, dataRef: string): string {
  const entry = mission.test_data?.find((d) => d.name === dataRef);
  if (!entry) {
    throw new MissingTestDataError(`Action references test data "${dataRef}" which the mission does not define.`);
  }
  const file = path.resolve(PATHS.root, entry.path);
  if (!fs.existsSync(file)) {
    // Explicitly test data, not a product defect. The distinction matters —
    // see the classifier.
    throw new MissingTestDataError(`Test data "${dataRef}" is missing on disk at ${entry.path}.`);
  }
  return file;
}

export interface ActionOutcome {
  step: StepRecord;
  trace?: TraceStep;
}

/** Execute one action. Throws on failure; the executor decides what that means. */
export async function performAction(
  ctx: ActionContext,
  action: MissionAction,
  index: number,
): Promise<ActionOutcome> {
  const started = Date.now();
  const step: StepRecord = {
    index,
    action: action.action,
    instruction: action.instruction,
    outcome: 'OK',
  };

  const value = interpolateValue(action.value, ctx.runId);
  const timeout = ctx.actionTimeoutMs;

  // Actions that need no element.
  if (action.action === 'navigate') {
    const target = new URL(action.url ?? '/', ctx.baseUrl).toString();
    try {
      await ctx.page.goto(target, { timeout, waitUntil: 'domcontentloaded' });
    } catch (err) {
      throw new NavigationError(`Could not open ${target}: ${String(err)}`);
    }
    step.resolved_locator = target;
    step.resolution_strategy = 'none';
    step.duration_ms = Date.now() - started;
    return { step, trace: { action: 'navigate', url: target } };
  }

  if (action.action === 'wait_for_state') {
    await ctx.page.waitForLoadState(action.state ?? 'load', { timeout });
    step.duration_ms = Date.now() - started;
    return { step, trace: { action: 'wait_for_state', value: action.state ?? 'load' } };
  }

  if (action.action === 'press' && !action.target) {
    await ctx.page.keyboard.press(value ?? 'Enter');
    step.duration_ms = Date.now() - started;
    return { step, trace: { action: 'press', value: value ?? 'Enter' } };
  }

  // Everything else needs an element, resolved semantically.
  if (!action.target) {
    throw new Error(`Action ${index} (${action.action}) has no target.`);
  }

  const resolved = await resolveTarget(ctx.page, action.target, ctx.cache, {
    timeoutMs: timeout,
    maxAttempts: ctx.maxDiscoveryAttempts,
    runId: ctx.runId,
  });

  step.resolved_locator = resolved.description;
  step.resolution_strategy = resolved.strategy;
  step.resolution_confidence = resolved.confidence;

  const { locator } = resolved;

  switch (action.action) {
    case 'click':
      await locator.click({ timeout });
      break;
    case 'fill':
      await locator.fill(value ?? '', { timeout });
      break;
    case 'type':
      await locator.pressSequentially(value ?? '', { timeout });
      break;
    case 'select':
      /**
       * `{first_option}` means "whichever option this dropdown actually
       * offers first". Dependent dropdowns — a state list that is empty until
       * a country is chosen — cannot be named at bind time, because at capture
       * time they genuinely have no options. Reading them here, after the
       * fields they depend on have been filled, is the only place the answer
       * exists. It stays deterministic: first real option, every run.
       */
      if (value === FIRST_OPTION) {
        const options = await locator.locator('option').all();
        let picked: string | undefined;
        for (const option of options) {
          const v = await option.getAttribute('value');
          if (v) {
            picked = v;
            break;
          }
        }
        if (picked === undefined) throw new Error('the dropdown offers no selectable option');
        await locator.selectOption(picked, { timeout });
      } else {
        await locator.selectOption(value ?? '', { timeout });
      }
      break;
    case 'check':
      await locator.check({ timeout });
      break;
    case 'hover':
      await locator.hover({ timeout });
      break;
    case 'press':
      await locator.press(value ?? 'Enter', { timeout });
      break;
    case 'upload': {
      const file = resolveFixture(ctx.mission, action.data_ref as string);
      await locator.setInputFiles(file, { timeout });
      step.instruction = `${action.instruction} (${path.basename(file)})`;
      break;
    }
    case 'verify':
      // Handled by the executor: it owns the assertion map.
      break;
    default:
      throw new Error(`Unsupported action type: ${String(action.action)}`);
  }

  step.duration_ms = Date.now() - started;

  return {
    step,
    trace: {
      action: action.action,
      locator: resolved.description,
      ...(value !== undefined ? { value } : {}),
      ...(action.target.capability_key ? { capability_key: action.target.capability_key } : {}),
    },
  };
}
