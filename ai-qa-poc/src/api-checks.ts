import type { NetworkEntry, NetworkLog } from './step-evidence.js';
import type { AssertionCheck, AssertionResult } from './types.js';

/**
 * API checks — assertions on the XHR/fetch traffic a mission's actions caused.
 *
 * The UI is a narrow window onto the backend. A cart can show "Added!" while
 * the API answered 500 and saved nothing; a profile page can show the old name
 * because the PUT returned 200 with the old record. Element checks cannot see
 * either. These read the calls themselves.
 *
 * Same rules as every other check here:
 *
 *  - PASS needs the evidence. No matching call at all is a FAIL ("the action
 *    never reached the backend") — not a pass by absence.
 *  - What cannot be decided is INCONCLUSIVE, never FAIL: a body cut short, a
 *    field the page redacted, a response that is not JSON.
 */

export const API_SLOW_MS = Number(process.env.API_SLOW_MS ?? 3_000);

function matches(entry: NetworkEntry, spec: NonNullable<AssertionCheck['request']>): boolean {
  if (spec.method && entry.method.toUpperCase() !== spec.method.toUpperCase()) return false;
  return entry.url.includes(spec.url_contains);
}

function describe(spec: NonNullable<AssertionCheck['request']>): string {
  return `${spec.method ? `${spec.method.toUpperCase()} ` : ''}…${spec.url_contains}`;
}

function statusOk(actual: number | null, expected: number | string): boolean {
  if (actual === null) return false;
  const want = String(expected).trim().toLowerCase();
  if (/^[1-5]xx$/.test(want)) return Math.floor(actual / 100) === Number(want[0]);
  return actual === Number(want);
}

/**
 * Read one field out of a parsed JSON body.
 *
 *   order.status · items[0].qty · items.length · data.user.email
 *
 * Returns `missing` rather than undefined so "the field holds null" and "the
 * field is not there" stay distinguishable.
 */
export function readPath(root: unknown, path: string): { found: true; value: unknown } | { found: false } {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = root;
  for (const p of parts) {
    if (p === 'length' && (Array.isArray(cur) || typeof cur === 'string')) {
      cur = cur.length;
      continue;
    }
    if (cur === null || typeof cur !== 'object' || !(p in (cur as Record<string, unknown>))) return { found: false };
    cur = (cur as Record<string, unknown>)[p];
  }
  return { found: true, value: cur };
}

function show(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Wait for the call to arrive: the action that triggers it may still be in flight. */
async function waitFor(network: NetworkLog, spec: NonNullable<AssertionCheck['request']>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hits = network.list().filter((e) => matches(e, spec));
    if (hits.length || Date.now() >= deadline) {
      await network.settle(Math.max(0, Math.min(3_000, deadline - Date.now())));
      return hits;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function evaluateApiCheck(
  check: AssertionCheck,
  network: NetworkLog | undefined,
  result: AssertionResult,
  opts: { timeoutMs: number; expected?: string },
): Promise<AssertionResult> {
  if (!network) {
    result.evaluable = false;
    result.error = 'API traffic was not recorded for this run, so the API check could not be made.';
    return result;
  }

  if (check.type === 'api_no_errors') {
    await network.settle();
    const include4xx = String(check.value ?? '').toLowerCase() === '4xx';
    // A failure the test injected on purpose is not an API error.
    const real = network.list().filter((e) => !e.injected);
    const scoped = check.request ? real.filter((e) => matches(e, check.request!)) : real;
    const bad = scoped.filter((e) => e.status === null || e.status >= 500 || (include4xx && e.status >= 400));
    result.observed = `${scoped.length} API call(s), ${bad.length} failed`;
    result.passed = bad.length === 0;
    if (scoped.length === 0) {
      // Nothing to judge is not a pass: the scope was probably wrong.
      result.evaluable = false;
      result.error = `No API calls${check.request ? ` matching ${describe(check.request)}` : ''} were made during the mission.`;
    } else if (!result.passed) {
      result.error = `API call(s) failed:\n${bad.map((e) => `  - ${e.method} ${e.url} → ${e.status ?? e.failure}`).join('\n')}`;
    }
    return result;
  }

  // api_response
  if (!check.request?.url_contains) {
    result.evaluable = false;
    result.error = 'api_response needs request.url_contains — which call to check. Settle it at Gate 2.5.';
    return result;
  }
  const hits = await waitFor(network, check.request, opts.timeoutMs);
  if (!hits.length) {
    result.observed = 'no matching call';
    result.error = `No ${describe(check.request)} call was made. The action never reached the backend, or the endpoint is different.`;
    return result;
  }
  const entry = hits[hits.length - 1]!;
  const parts: string[] = [`${entry.method} ${entry.url} → ${entry.status ?? entry.failure}`];
  const problems: string[] = [];
  let undecidable: string | undefined;

  if (check.status !== undefined && !statusOk(entry.status, check.status)) {
    problems.push(`status ${entry.status ?? 'none'} (expected ${check.status})`);
  }

  const body = network.body(entry);
  if (check.body_contains !== undefined) {
    if (body === undefined) undecidable = 'the response had no readable body';
    else if (!body.includes(check.body_contains)) problems.push(`body does not contain "${check.body_contains}"`);
  }

  if (check.json_path) {
    let parsed: unknown;
    try {
      parsed = body === undefined ? undefined : JSON.parse(body);
    } catch {
      undecidable = `the response is not JSON${entry.response_truncated ? ' (or was too large to read whole)' : ''}`;
    }
    if (parsed !== undefined) {
      const got = readPath(parsed, check.json_path);
      if (!got.found) problems.push(`field ${check.json_path} is not in the response`);
      else if (got.value === '***') undecidable = `field ${check.json_path} is a secret and was masked in the recording`;
      else {
        parts.push(`${check.json_path} = ${show(got.value)}`);
        if (opts.expected !== undefined && show(got.value) !== opts.expected) {
          problems.push(`${check.json_path} is ${show(got.value)} (expected ${opts.expected})`);
        }
      }
    }
  }

  result.observed = parts.join('; ');
  if (opts.expected !== undefined) result.expected_value = opts.expected;
  if (problems.length) {
    result.passed = false;
    result.error = `API check did not hold: ${problems.join('; ')}.`;
  } else if (undecidable) {
    result.evaluable = false;
    result.passed = false;
    result.error = `API check could not be decided: ${undecidable}.`;
  } else {
    result.passed = true;
  }
  return result;
}

// --- Automatic API health: findings nobody wrote a test for ---------------------

export interface ApiFinding {
  key: string;
  kind: 'api_error_in_success' | 'api_invalid_json' | 'slow_api';
  severity: 'high' | 'medium' | 'low';
  summary: string;
  detail: string;
  url: string;
}

/**
 * Error envelopes that a 2xx should not carry. Deliberately narrow: a
 * validation response with `success: false` behind a 200 is how some APIs
 * report a refused form, so this is a finding for a human — never a FAIL.
 */
function errorEnvelope(json: unknown): string | undefined {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined;
  const o = json as Record<string, unknown>;
  if (o.error !== undefined && o.error !== null && o.error !== '' && o.error !== false) return `"error": ${show(o.error).slice(0, 160)}`;
  if (Array.isArray(o.errors) && o.errors.length) return `"errors": ${show(o.errors).slice(0, 160)}`;
  if (o.success === false) return '"success": false';
  if (typeof o.status === 'string' && /^(error|fail|failed|failure)$/i.test(o.status)) return `"status": "${o.status}"`;
  return undefined;
}

/**
 * Problems in the traffic itself, found without any test asking. HTTP 4xx/5xx
 * and dropped requests are already reported by the observer; these are the
 * ones a status code does not reveal.
 */
export function apiHealthFindings(network: NetworkLog): ApiFinding[] {
  const out: ApiFinding[] = [];
  for (const e of network.list()) {
    if (e.injected) continue;
    const path = (() => {
      try {
        return new URL(e.url).pathname;
      } catch {
        return e.url;
      }
    })();
    const body = network.body(e);
    if (e.status !== null && e.status >= 200 && e.status < 300 && e.content_type?.includes('json') && body !== undefined) {
      let json: unknown;
      let parsed = true;
      try {
        json = JSON.parse(body);
      } catch {
        parsed = false;
      }
      if (!parsed && !e.response_truncated) {
        out.push({
          key: `api_json:${e.method}:${path}`,
          kind: 'api_invalid_json',
          severity: 'medium',
          summary: `${e.method} ${path} says JSON but the body does not parse`,
          detail: body.slice(0, 300),
          url: e.url,
        });
      }
      const envelope = parsed ? errorEnvelope(json) : undefined;
      if (envelope) {
        out.push({
          key: `api_envelope:${e.method}:${path}`,
          kind: 'api_error_in_success',
          severity: 'medium',
          summary: `${e.method} ${path} returned ${e.status} but its body reports an error (${envelope})`,
          detail: 'A success status with an error in the body is how backend failures hide behind a UI that looks fine. Check whether the page told the user.',
          url: e.url,
        });
      }
    }
    if (e.duration_ms !== undefined && e.duration_ms > API_SLOW_MS) {
      out.push({
        key: `api_slow:${e.method}:${path}`,
        kind: 'slow_api',
        severity: 'low',
        summary: `${e.method} ${path} took ${(e.duration_ms / 1000).toFixed(1)}s (limit ${(API_SLOW_MS / 1000).toFixed(1)}s)`,
        detail: 'Set API_SLOW_MS to change the limit.',
        url: e.url,
      });
    }
  }
  return out;
}

// --- Integration: the UI and the API agree -----------------------------------------

/** Every number written in a piece of UI text: "1,299.00" → 1299, "Qty: 2" → 2. */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)]
    .map((m) => Number(m[0].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Does what the element shows agree with a field of an API response?
 *
 * Numbers compare as numbers, so "$1,299.00" agrees with 1299 and "Qty: 2"
 * with 2 — formatting is the UI's business. Text agrees when the element
 * contains it. Objects and lists cannot be compared to a sentence, so they are
 * undecidable rather than failed: point json_path at the field itself
 * (items.length, order.total), not at the container.
 */
export async function evaluateUiMatchesApi(
  check: AssertionCheck,
  uiText: string,
  network: NetworkLog | undefined,
  result: AssertionResult,
  opts: { timeoutMs: number },
): Promise<AssertionResult> {
  if (!network) {
    result.evaluable = false;
    result.error = 'API traffic was not recorded for this run, so the UI could not be compared with it.';
    return result;
  }
  if (!check.request?.url_contains || !check.json_path) {
    result.evaluable = false;
    result.error = 'ui_matches_api needs request.url_contains and json_path — which call, and which field. Settle it at Gate 2.5.';
    return result;
  }
  const hits = await waitFor(network, check.request, opts.timeoutMs);
  const entry = hits[hits.length - 1];
  if (!entry) {
    result.observed = `UI "${uiText}"; no matching call`;
    result.error = `No ${describe(check.request)} call was made, so there is nothing to compare the UI with.`;
    return result;
  }
  const body = network.body(entry);
  let json: unknown;
  try {
    json = body === undefined ? undefined : JSON.parse(body);
  } catch {
    json = undefined;
  }
  const got = json === undefined ? undefined : readPath(json, check.json_path);
  if (!got || !got.found) {
    result.evaluable = json !== undefined ? true : false;
    result.observed = `UI "${uiText}"; ${entry.method} ${entry.url} → ${entry.status}`;
    result.error =
      json === undefined
        ? `The ${describe(check.request)} response is not readable JSON, so it cannot be compared.`
        : `The ${describe(check.request)} response has no field ${check.json_path}.`;
    return result;
  }
  const apiValue = got.value;
  result.observed = `UI "${uiText}" vs API ${check.json_path} = ${show(apiValue)}`;
  result.expected_value = show(apiValue);

  if (apiValue === '***') {
    result.evaluable = false;
    result.error = `API field ${check.json_path} is a secret and was masked in the recording, so it cannot be compared.`;
    return result;
  }
  const asNumber = typeof apiValue === 'number' ? apiValue : typeof apiValue === 'string' && /^-?\d+(\.\d+)?$/.test(apiValue.trim()) ? Number(apiValue) : undefined;
  if (asNumber !== undefined) {
    const shown = numbersIn(uiText);
    result.passed = shown.some((n) => Math.abs(n - asNumber) < 1e-9);
    if (!result.passed) {
      result.error = shown.length
        ? `The UI shows ${shown.join(', ')} but the API says ${asNumber}.`
        : `The UI shows no number at all ("${uiText}") but the API says ${asNumber}.`;
    }
    return result;
  }
  if (typeof apiValue === 'string' || typeof apiValue === 'boolean') {
    const want = String(apiValue);
    result.passed = norm(uiText).includes(norm(want));
    if (!result.passed) result.error = `The UI shows "${uiText}" but the API says "${want}".`;
    return result;
  }
  result.evaluable = false;
  result.error = `API field ${check.json_path} is ${Array.isArray(apiValue) ? 'a list' : apiValue === null ? 'null' : 'an object'}; point json_path at a single value (e.g. ${check.json_path}.length).`;
  return result;
}
