import { expect, type Page } from '@playwright/test';
import { interpolate } from './actions.js';
import { resolveTarget, TargetAmbiguousError, TargetNotFoundError } from './discovery.js';
import type { LocatorCache } from './locator-cache.js';
import type { AssertionResult, MissionAssertion } from './types.js';

/**
 * Assertion evaluation.
 *
 * This is the part that keeps PASS honest. Each mission assertion carries a
 * human `statement` and a machine-checkable `check`; only the `check` decides
 * the outcome, so pass/fail is a real Playwright expectation rather than a
 * model's opinion of a sentence.
 *
 * Two outcomes are deliberately distinct:
 *   - passed: false            → the check ran and the expectation did not hold
 *   - evaluable: false         → the check could not be run at all
 *
 * The second must never be reported as PASS, and must never be reported as a
 * product defect either. It becomes INCONCLUSIVE.
 */

export interface AssertContext {
  page: Page;
  cache: LocatorCache;
  runId: string;
  timeoutMs: number;
  maxDiscoveryAttempts: number;
}

export async function evaluateAssertion(
  ctx: AssertContext,
  assertion: MissionAssertion,
): Promise<AssertionResult> {
  const critical = assertion.critical ?? true;
  const result: AssertionResult = {
    id: assertion.id,
    statement: assertion.statement,
    check_type: assertion.check.type,
    passed: false,
    critical,
    evaluable: true,
  };

  const { check } = assertion;
  const expected = interpolate(
    check.value === undefined ? undefined : String(check.value),
    ctx.runId,
  );

  try {
    // url_contains is the one check that needs no element.
    if (check.type === 'url_contains') {
      const url = ctx.page.url();
      result.observed = url;
      result.passed = expected !== undefined && url.includes(expected);
      if (!result.passed) result.error = `URL "${url}" does not contain "${expected}".`;
      return result;
    }

    if (!check.target) {
      result.evaluable = false;
      result.error = `Check type "${check.type}" needs a target and the mission did not provide one.`;
      return result;
    }

    // not_visible is special: the element legitimately may not exist, so a
    // failure to resolve it is the assertion passing, not an execution error.
    if (check.type === 'not_visible') {
      try {
        const resolved = await resolveTarget(ctx.page, check.target, ctx.cache, {
          timeoutMs: Math.min(ctx.timeoutMs, 5_000),
          maxAttempts: ctx.maxDiscoveryAttempts,
          runId: ctx.runId,
        });
        // toBeHidden auto-retries. A single isVisible() read races any UI that
        // takes a moment to settle, and would report a defect that is really
        // just the executor being faster than the animation.
        await expect(resolved.locator).toBeHidden({ timeout: ctx.timeoutMs });
        result.observed = 'element is present but not visible';
        result.passed = true;
      } catch (err) {
        if (err instanceof TargetNotFoundError) {
          // The element is simply not there, which is what the assertion wants.
          result.observed = 'element not present';
          result.passed = true;
        } else if (err instanceof TargetAmbiguousError) {
          throw err;
        } else {
          result.passed = false;
          result.observed = 'element is still visible';
          result.error = `"${check.target.description}" is visible but should not be.`;
        }
      }
      return result;
    }

    const resolved = await resolveTarget(ctx.page, check.target, ctx.cache, {
      timeoutMs: ctx.timeoutMs,
      maxAttempts: ctx.maxDiscoveryAttempts,
      // A count check is about how many things match, so several matches is the
      // measurement rather than an error.
      allowMultiple: check.type === 'count',
      runId: ctx.runId,
    });
    const locator = resolved.locator;

    switch (check.type) {
      case 'visible':
        await expect(locator).toBeVisible({ timeout: ctx.timeoutMs });
        result.observed = 'element is visible';
        result.passed = true;
        break;

      case 'enabled':
        await expect(locator).toBeEnabled({ timeout: ctx.timeoutMs });
        result.observed = 'element is enabled';
        result.passed = true;
        break;

      case 'disabled':
        await expect(locator).toBeDisabled({ timeout: ctx.timeoutMs });
        result.observed = 'element is disabled';
        result.passed = true;
        break;

      case 'text_equals':
        if (expected === undefined) {
          result.evaluable = false;
          result.error = 'text_equals needs an expected value.';
          break;
        }
        await expect(locator).toHaveText(expected, { timeout: ctx.timeoutMs });
        result.observed = (await locator.textContent())?.trim() ?? '';
        result.passed = true;
        break;

      case 'text_contains':
        if (expected === undefined) {
          result.evaluable = false;
          result.error = 'text_contains needs an expected value.';
          break;
        }
        await expect(locator).toContainText(expected, { timeout: ctx.timeoutMs });
        result.observed = (await locator.textContent())?.trim() ?? '';
        result.passed = true;
        break;

      case 'count': {
        if (expected === undefined) {
          result.evaluable = false;
          result.error = 'count needs an expected value.';
          break;
        }
        // Count applies to the whole matching set, never the narrowed first().
        const actual = await resolved.all.count();
        result.observed = String(actual);
        result.passed = actual === Number(expected);
        if (!result.passed) result.error = `Expected ${expected} matches, found ${actual}.`;
        break;
      }

      case 'attribute_equals': {
        if (!check.attribute || expected === undefined) {
          result.evaluable = false;
          result.error = 'attribute_equals needs both an attribute and an expected value.';
          break;
        }
        const actual = await locator.getAttribute(check.attribute);
        result.observed = `${check.attribute}="${actual ?? ''}"`;
        result.passed = actual === expected;
        if (!result.passed) {
          result.error = `Attribute ${check.attribute} was "${actual ?? ''}", expected "${expected}".`;
        }
        break;
      }

      default: {
        result.evaluable = false;
        result.error = `Unsupported check type: ${String(check.type)}`;
      }
    }
  } catch (err) {
    if (err instanceof TargetNotFoundError) {
      // The element the assertion is about is simply not there. That IS the
      // assertion failing — it is not an agent malfunction.
      result.passed = false;
      result.observed = 'element not found on the page';
      result.error = err.message;
    } else if (err instanceof TargetAmbiguousError) {
      // We genuinely do not know which element to judge. Not a failure of the
      // product; we refuse to call it either way.
      result.evaluable = false;
      result.observed = 'multiple matching elements';
      result.error = err.message;
    } else {
      result.passed = false;
      result.error = err instanceof Error ? err.message : String(err);
      result.observed ??= 'expectation did not hold';
    }
  }

  return result;
}

/** Unevaluable criticals mean we cannot honestly call the run either way. */
export function summarise(results: AssertionResult[]): {
  allCriticalPassed: boolean;
  anyUnevaluableCritical: boolean;
  failedCritical: AssertionResult[];
} {
  const criticals = results.filter((r) => r.critical);
  return {
    allCriticalPassed: criticals.every((r) => r.passed && r.evaluable !== false),
    anyUnevaluableCritical: criticals.some((r) => r.evaluable === false),
    failedCritical: criticals.filter((r) => !r.passed && r.evaluable !== false),
  };
}
