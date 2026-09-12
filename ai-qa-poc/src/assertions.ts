import { expect, type Page } from '@playwright/test';
import { interpolate } from './actions.js';
import { resolveTarget, TargetAmbiguousError, TargetNotFoundError } from './discovery.js';
import type { LocatorCache } from './locator-cache.js';
import { describeSweep, sweepAccessibleNames, sweepImages } from './sweeps.js';
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

    /**
     * Sweeps run over every matching element, so they need no single target.
     * An optional `within` scopes them to one region of the page.
     */
    if (check.type === 'all_images_loaded' || check.type === 'all_controls_have_accessible_name') {
      // A whole-page sweep scopes to <body>; `within` narrows it to a region.
      let scope = ctx.page.locator('body');
      if (check.target) {
        const resolvedScope = await resolveTarget(ctx.page, check.target, ctx.cache, {
          timeoutMs: ctx.timeoutMs,
          maxAttempts: ctx.maxDiscoveryAttempts,
          runId: ctx.runId,
        });
        scope = resolvedScope.locator;
      }

      const outcome =
        check.type === 'all_images_loaded'
          ? await sweepImages(scope)
          : await sweepAccessibleNames(scope);

      // A tolerance lets a team adopt a sweep on a page with known debt
      // without muting it entirely — the count is visible and must be chosen.
      const allowed = expected === undefined ? 0 : Number(expected);
      result.observed = describeSweep(check.type, outcome);
      result.passed = outcome.offenders.length <= allowed;
      if (!result.passed) {
        result.error =
          `${outcome.offenders.length} element(s) failed "${check.type}" (tolerance ${allowed}):\n` +
          outcome.offenders.map((o) => `  - ${o.what}: ${o.detail}`).join('\n');
      }
      if (outcome.checked === 0) {
        // Nothing to examine is not a pass: it usually means the scope was
        // wrong, and silently passing would hide that.
        result.evaluable = false;
        result.passed = false;
        result.error = `No elements found to sweep for "${check.type}" — check the scope.`;
      }
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

      case 'image_loaded': {
        /**
         * A broken image is still "visible": the <img> element exists, takes
         * up space, and is not hidden — so toBeVisible() passes while the
         * browser draws a broken-image placeholder.
         *
         * This is not hypothetical. A generated mission asserted the brand
         * logo "is visible and rendered (not a broken image placeholder)"
         * using a visible check, and reported PASS against
         * src="/broken-logo.png", which 404s.
         *
         * naturalWidth is the only honest signal: it is 0 until the image
         * actually decodes.
         */
        const state = await locator.evaluate((el) => {
          const img = el as HTMLImageElement;
          if (img.tagName !== 'IMG') return { isImage: false, complete: false, naturalWidth: 0, src: '' };
          return { isImage: true, complete: img.complete, naturalWidth: img.naturalWidth, src: img.currentSrc || img.src };
        });

        if (!state.isImage) {
          result.evaluable = false;
          result.error = 'image_loaded was used on an element that is not an <img>.';
          break;
        }

        result.observed = `naturalWidth=${state.naturalWidth}, src=${state.src}`;
        result.passed = state.complete && state.naturalWidth > 0;
        if (!result.passed) {
          result.error = `Image did not load (naturalWidth=${state.naturalWidth}). The element is present but the image data is missing — a broken-image placeholder. src: ${state.src}`;
        }
        break;
      }

      case 'has_accessible_name': {
        /**
         * Icon-only controls routinely ship with no label: the element is
         * visible, clickable and completely unusable to a screen reader.
         * A visible check cannot see that.
         */
        const name = await locator.evaluate((el) => {
          const aria = el.getAttribute('aria-label')?.trim();
          if (aria) return aria;
          const labelledBy = el.getAttribute('aria-labelledby');
          if (labelledBy) {
            const ref = el.ownerDocument.getElementById(labelledBy);
            if (ref?.textContent?.trim()) return ref.textContent.trim();
          }
          const title = el.getAttribute('title')?.trim();
          if (title) return title;
          const alt = el.getAttribute('alt')?.trim();
          if (alt) return alt;
          return el.textContent?.trim() ?? '';
        });

        result.observed = name ? `accessible name: "${name}"` : 'no accessible name';
        if (expected !== undefined) {
          result.passed = name.toLowerCase() === expected.toLowerCase();
          if (!result.passed) result.error = `Accessible name was "${name}", expected "${expected}".`;
        } else {
          result.passed = name.length > 0;
          if (!result.passed) result.error = 'Element exposes no accessible name — unusable to assistive tech.';
        }
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
