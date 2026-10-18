import { expect, type Locator, type Page } from '@playwright/test';
import { evaluateApiCheck, evaluateUiMatchesApi } from './api-checks.js';
import { sweepLayout } from './layout.js';
import { atLeast, runAxe, type Impact } from './a11y.js';
import { capturePage, compareWithBaseline, describeChange, viewportKey } from './visual.js';
import { checkBudget, describeMetrics, readMetrics } from './performance.js';
import type { NetworkLog } from './step-evidence.js';
import { z } from 'zod';
import { aiAvailable, askStructured } from './ai-client.js';
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
  /** Screenshot the checked element, outlined. Returns the evidence path. */
  onResolved?: (locator: Locator, assertionId: string) => Promise<string | undefined>;
  /** The mission's XHR/fetch traffic, for API checks. */
  network?: NetworkLog;
  /** For looks_like_baseline: whose baseline, and where to keep the diff. */
  visual?: { testId: string; evidenceDir: string };
}

// --- tolerant text comparison ------------------------------------------------

/** Case, whitespace, quotes and trailing punctuation are presentation, not meaning. */
function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const SameMeaning = z.object({
  same_meaning: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string(),
});

const SEMANTIC_SYSTEM = `You judge one assertion in an automated functional test.
Decide whether the text observed on the page communicates the same thing the test expected.
Same meaning = a differently worded message about the same condition, with every specific fact intact
(names, numbers, amounts, fields, statuses, the success/failure direction).
NOT the same: a different field or entity ("Invalid email" vs "Invalid password"), a different number or amount,
the opposite outcome, a generic message where a specific one was expected, or extra facts that change the meaning.
When unsure, answer false. A false PASS is worse than a false FAIL.`;

interface TextOutcome {
  passed: boolean;
  observed: string;
  match?: 'exact' | 'normalised' | 'semantic';
  note?: string;
  error?: string;
}

/**
 * Poll the element's text until it matches exactly or after normalising, then
 * — only if neither held by the deadline — ask whether it means the same.
 */
async function checkText(
  locator: Locator,
  expected: string,
  mode: 'equals' | 'contains',
  timeoutMs: number,
  statement: string,
): Promise<TextOutcome> {
  const deadline = Date.now() + timeoutMs;
  let observed = '';
  for (;;) {
    observed = squash((await locator.innerText({ timeout: 2_000 }).catch(() => locator.textContent())) ?? '');
    const exact = mode === 'equals' ? observed === squash(expected) : observed.includes(squash(expected));
    if (exact) return { passed: true, observed, match: 'exact' };
    const loose = mode === 'equals' ? normText(observed) === normText(expected) : normText(observed).includes(normText(expected));
    if (loose) {
      return { passed: true, observed, match: 'normalised', note: 'Matched after ignoring case, spacing and punctuation.' };
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const mismatch = `Expected text ${mode === 'equals' ? '' : 'containing '}"${expected}", found "${observed}".`;
  if (!observed || !aiAvailable() || process.env.SEMANTIC_ASSERTIONS === 'off') {
    return { passed: false, observed, error: mismatch };
  }
  const answer = await askStructured(
    SameMeaning,
    SEMANTIC_SYSTEM,
    `Assertion: ${statement}
Expected text: ${expected}
Observed text: ${observed}`,
  );
  if (!answer.ok) return { passed: false, observed, error: `${mismatch} (semantic check unavailable: ${answer.error})` };
  const { same_meaning, confidence, reason } = answer.value;
  if (same_meaning && confidence === 'high') {
    return { passed: true, observed, match: 'semantic', note: `${answer.model} judged the wording equivalent: ${reason}` };
  }
  return { passed: false, observed, error: `${mismatch} ${answer.model}: not the same meaning (${confidence}) — ${reason}` };
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
  /** The element the check examined, screenshotted once the verdict is in. */
  let checked: Locator | undefined;
  const expected = interpolate(
    check.value === undefined ? undefined : String(check.value),
    ctx.runId,
  );

  try {
    // API checks read the traffic, not the page.
    if (check.type === 'api_response' || check.type === 'api_no_errors') {
      return await evaluateApiCheck(check, ctx.network, result, { timeoutMs: ctx.timeoutMs, expected });
    }

    // Performance budget for the page as it last loaded.
    if (check.type === 'performance_budget') {
      if (!check.budget || !Object.keys(check.budget).length) {
        result.evaluable = false;
        result.error = 'performance_budget needs a budget: ttfb_ms, lcp_ms, cls and/or load_ms.';
        return result;
      }
      const m = await readMetrics(ctx.page);
      const { breaches, unmeasured } = checkBudget(m, check.budget);
      result.observed = describeMetrics(m) || 'no timings available';
      result.passed = breaches.length === 0 && unmeasured.length === 0;
      if (breaches.length) result.error = `Over budget: ${breaches.join('; ')}.`;
      else if (unmeasured.length) {
        // A budget this engine cannot measure is not met, and not failed either.
        result.evaluable = false;
        result.error = `Not measurable in this browser: ${unmeasured.join(', ')}.`;
      }
      return result;
    }

    // Looks like the approved baseline: a hard visual check for pages that must not drift.
    if (check.type === 'looks_like_baseline') {
      if (!ctx.visual) {
        result.evaluable = false;
        result.error = 'Visual comparison is not available in this run.';
        return result;
      }
      const vr = compareWithBaseline(await capturePage(ctx.page), ctx.visual.testId, viewportKey(ctx.page), ctx.visual.evidenceDir);
      if (vr.status === 'no_baseline') {
        result.evaluable = false;
        result.observed = 'no approved baseline yet';
        result.error = `Nothing to compare with: approve a baseline first (npm run visual -- --approve ${ctx.visual.testId} --by "<name>").`;
        return result;
      }
      result.observed = describeChange(vr);
      result.passed = vr.status === 'same';
      if (!result.passed) result.error = `The page looks different from its approved baseline: ${describeChange(vr)}. Diff (changes in red): ${vr.diff}`;
      return result;
    }

    // Layout is a property of the whole page at its current size.
    if (check.type === 'layout_sound') {
      const outcome = await sweepLayout(ctx.page);
      const allowed = expected === undefined ? 0 : Number(expected);
      result.observed = `${outcome.viewport.width}×${outcome.viewport.height}: ${outcome.checked} element(s) checked, ${outcome.offenders.length} layout problem(s)`;
      result.passed = outcome.offenders.length <= allowed;
      if (!result.passed) {
        result.error =
          `${outcome.offenders.length} layout problem(s) at ${outcome.viewport.width}px (tolerance ${allowed}):\n` +
          outcome.offenders.map((o) => `  - ${o.what}: ${o.detail}`).join('\n');
      }
      return result;
    }

    // Accessibility: axe over the page, or over the target region.
    if (check.type === 'accessible') {
      const floor = (['minor', 'moderate', 'serious', 'critical'].includes(String(expected)) ? expected : 'serious') as Impact;
      let scope: Locator | undefined;
      if (check.target) {
        scope = (await resolveTarget(ctx.page, check.target, ctx.cache, { timeoutMs: ctx.timeoutMs, maxAttempts: ctx.maxDiscoveryAttempts, runId: ctx.runId })).locator;
      }
      const all = await runAxe(ctx.page, scope);
      const failing = all.filter((v) => atLeast(v.impact, floor));
      result.observed = `${all.length} WCAG A/AA rule(s) broken, ${failing.length} at ${floor} or worse`;
      result.passed = failing.length === 0;
      if (!result.passed) {
        result.error =
          `Accessibility violations (${floor} or worse):\n` +
          failing.map((v) => `  - [${v.impact}] ${v.help} (${v.rule}): ${v.nodes.map((n) => n.target).slice(0, 3).join(', ')}`).join('\n');
      }
      return result;
    }

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
          // "Not found" is the answer here; a tolerant match would find
          // something else and report it as still visible.
          smart: 'off',
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
      // Counting needs the whole exact set; fallbacks only ever return one element.
      // Never AI for a check: a model's guess must not be able to make a test pass.
      smart: check.type === 'count' ? 'off' : 'no_ai',
    });
    const locator = resolved.locator;
    result.resolution_strategy = resolved.strategy;
    if (resolved.note) result.resolution_note = resolved.note;
    if (resolved.suggested) result.resolved_as = resolved.suggested;
    if (expected !== undefined) result.expected_value = expected;
    checked = locator;

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
        {
          const t = await checkText(locator, expected, 'equals', ctx.timeoutMs, assertion.statement);
          Object.assign(result, { passed: t.passed, observed: t.observed });
          if (t.match) result.match = t.match;
          if (t.note) result.match_note = t.note;
          if (t.error) result.error = t.error;
        }
        break;

      case 'text_contains':
        if (expected === undefined) {
          result.evaluable = false;
          result.error = 'text_contains needs an expected value.';
          break;
        }
        {
          const t = await checkText(locator, expected, 'contains', ctx.timeoutMs, assertion.statement);
          Object.assign(result, { passed: t.passed, observed: t.observed });
          if (t.match) result.match = t.match;
          if (t.note) result.match_note = t.note;
          if (t.error) result.error = t.error;
        }
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

      case 'ui_matches_api': {
        // A form field shows its value, not its text.
        const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
        const shown = ['input', 'textarea', 'select'].includes(tag)
          ? await locator.inputValue({ timeout: ctx.timeoutMs })
          : (await locator.innerText({ timeout: ctx.timeoutMs })).trim();
        await evaluateUiMatchesApi(check, shown, ctx.network, result, { timeoutMs: ctx.timeoutMs });
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

  if (checked && ctx.onResolved) {
    const shot = await ctx.onResolved(checked, assertion.id);
    if (shot) result.screenshot = shot;
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
