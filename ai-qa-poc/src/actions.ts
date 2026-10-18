import fs from 'node:fs';
import { expireSession } from './security.js';
import { readPath } from './api-checks.js';
import { saveValue, unfilledSaved } from './interpolate.js';
import type { NetworkLog } from './step-evidence.js';
import { describeFault, type FaultInjector } from './faults.js';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { PATHS } from './config.js';
import { resolveTarget, type Resolved } from './discovery.js';
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
  /**
   * Called with the element just before it is used — the executor screenshots
   * it outlined, so the report shows WHICH control the step acted on.
   */
  onResolved?: (resolved: Resolved, stepIndex: number) => Promise<string | undefined>;
  /** Present for every mission; fail_requests adds to it. */
  faults?: FaultInjector;
  /** The mission's API traffic; api_request records into it. */
  network?: NetworkLog;
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
    const path = interpolateValue(action.url ?? '/', ctx.runId) as string;
    const missing = unfilledSaved(path);
    if (missing.length) throw new Error(`Step ${index} opens ${path}, but no earlier api_request saved ${missing.map((n) => `{saved.${n}}`).join(', ')}.`);
    const target = new URL(path, ctx.baseUrl).toString();
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

  if (action.action === 'fail_requests') {
    if (!ctx.faults || !action.request?.url_contains || !action.failure) {
      throw new Error(`Step ${index} (fail_requests) needs request.url_contains and failure.`);
    }
    const spec = {
      request: action.request,
      failure: action.failure,
      ...(action.status !== undefined ? { status: action.status } : {}),
      ...(action.delay_ms !== undefined ? { delay_ms: action.delay_ms } : {}),
    };
    await ctx.faults.add(spec);
    step.resolved_locator = `fault: ${describeFault(spec)}`;
    step.resolution_strategy = 'none';
    step.duration_ms = Date.now() - started;
    return { step, trace: { action: 'fail_requests', value: JSON.stringify(spec) } };
  }

  if (action.action === 'expire_session') {
    await expireSession(ctx.page);
    step.resolved_locator = 'session ended: cookies and web storage cleared';
    step.resolution_strategy = 'none';
    step.duration_ms = Date.now() - started;
    return { step, trace: { action: 'expire_session' } };
  }

  if (action.action === 'api_request') {
    return { step: await apiRequest(ctx, action, index, step, started) };
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
    smart: 'full',
    intent: action.instruction,
  });

  step.resolved_locator = resolved.description;
  step.resolution_strategy = resolved.strategy;
  step.resolution_confidence = resolved.confidence;
  if (resolved.note) step.resolution_note = resolved.note;
  if (resolved.suggested) step.resolved_as = resolved.suggested;
  const shot = await ctx.onResolved?.(resolved, index);
  if (shot) step.target_screenshot = shot;

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

/** Fill {run_id} / {saved.x} inside every string of a JSON body. */
function fillBody(body: unknown, runId: string): unknown {
  if (typeof body === 'string') return interpolateValue(body, runId);
  if (Array.isArray(body)) return body.map((v) => fillBody(v, runId));
  if (body && typeof body === 'object') {
    return Object.fromEntries(Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, fillBody(v, runId)]));
  }
  return body;
}

/**
 * Call an endpoint directly, as the logged-in browser session (its cookies).
 *
 * Two jobs: setting state up faster and more reliably than clicking through
 * it, and reading a record back to prove the UI really stored it. The call is
 * recorded with the page's own traffic, so api_response and api_no_errors see
 * it, and API health judges it like any other.
 *
 * A 4xx/5xx does not throw here: whether that is wrong is for an assertion to
 * say (a negative test expects one). A value to save that is not in the
 * response does throw, because every later step depending on it would fail
 * for a reason that has nothing to do with the product.
 */
async function apiRequest(ctx: ActionContext, action: MissionAction, index: number, step: StepRecord, started: number): Promise<StepRecord> {
  const path = interpolateValue(action.url ?? '', ctx.runId) as string;
  const missing = unfilledSaved(path);
  if (!path || missing.length) {
    throw new Error(
      !path
        ? `Step ${index} (api_request) has no url.`
        : `Step ${index} calls ${path}, but no earlier api_request saved ${missing.map((n) => `{saved.${n}}`).join(', ')}.`,
    );
  }
  const method = (action.method ?? 'GET').toUpperCase();
  const url = new URL(path, ctx.baseUrl).toString();
  const data = action.body === undefined ? undefined : fillBody(action.body, ctx.runId);
  const t0 = Date.now();
  let status: number | null = null;
  let text: string | undefined;
  let contentType: string | undefined;
  let failure: string | undefined;
  try {
    const res = await ctx.page.request.fetch(url, {
      method,
      ...(data !== undefined ? { data } : {}),
      failOnStatusCode: false,
      timeout: ctx.actionTimeoutMs,
    });
    status = res.status();
    contentType = res.headers()['content-type']?.split(';')[0]?.trim();
    text = await res.text().catch(() => undefined);
  } catch (err) {
    failure = err instanceof Error ? err.message.split('\n')[0] : String(err);
  }
  ctx.network?.record(
    {
      at: new Date().toISOString(),
      method,
      url,
      status,
      resource: 'api_request',
      duration_ms: Date.now() - t0,
      ...(data !== undefined ? { request_body: JSON.stringify(data) } : {}),
      ...(contentType ? { content_type: contentType } : {}),
      ...(failure ? { failure } : {}),
    },
    text,
  );
  if (failure) throw new Error(`Step ${index}: ${method} ${path} got no response (${failure}).`);

  const saved: string[] = [];
  if (action.save?.length) {
    let json: unknown;
    try {
      json = text === undefined ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    for (const s of action.save) {
      const got = json === undefined ? { found: false as const } : readPath(json, s.json_path);
      if (!got.found || got.value === null || typeof got.value === 'object') {
        throw new Error(`Step ${index}: ${method} ${path} → ${status}, and its response has no value at ${s.json_path} to save as "${s.as}".`);
      }
      saveValue(ctx.runId, s.as, String(got.value));
      saved.push(`${s.as}=${String(got.value)}`);
    }
  }
  step.resolved_locator = `${method} ${path} → ${status}${saved.length ? ` (saved ${saved.join(', ')})` : ''}`;
  step.resolution_strategy = 'none';
  step.duration_ms = Date.now() - started;
  return step;
}
