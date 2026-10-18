import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';
import type { CheckType, ExecutionResult, TargetSpec, TestMission, TraceStep } from './types.js';

/**
 * Phase 8 — a validated mission becomes a permanent Playwright test.
 *
 * VISION §9 is the argument: AI reasoning is worth paying for on a feature that
 * is new, changing, or unknown. It is waste on a stable critical workflow that
 * has passed the same way for weeks. The long-term model is hybrid, and this is
 * the step that moves a flow from one side to the other.
 *
 * §10a is why it is cheap: the replayable trace already records the locators
 * that actually resolved, so this is a codegen step rather than re-authoring
 * every test by hand. That was the whole reason the trace exists.
 *
 * ## What this deliberately does not do
 *
 * **It does not decide.** A mission passing twice is not a reason to freeze it;
 * only a human knows whether a flow is stable or merely untouched this week.
 * `--list` proposes, `--promote` requires a name.
 *
 * **It does not delete the mission.** The generated spec and the mission test
 * the same thing by different means, and the mission stays the source of truth
 * — it carries the requirement link, the human sentence for each assertion, and
 * the approval record. A generated spec that outlives its mission is an
 * untraceable test, which §17 criterion 8 exists to prevent.
 *
 * ## The honest trade-off
 *
 * A generated spec is a **snapshot of locators that worked on one build**. It
 * runs in milliseconds and needs no model, and it breaks the moment the page
 * changes — which is the point of a regression test, and also its maintenance
 * cost. When one breaks, the question is whether the product regressed or the
 * page moved, and the mission is what answers it: re-run the mission, and if it
 * passes, re-promote.
 */

export interface Eligibility {
  test_id: string;
  mission: TestMission;
  runs: number;
  passes: number;
  eligible: boolean;
  reason: string;
  latest?: ExecutionResult;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Non-replay runs for one mission, oldest first. */
export function runsFor(testId: string): ExecutionResult[] {
  const dir = path.join(PATHS.runs, testId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => !d.endsWith('-replay'))
    .sort()
    .map((d) => readJson<ExecutionResult>(path.join(dir, d, 'result.json')))
    .filter((r): r is ExecutionResult => Boolean(r));
}

/**
 * Is this mission stable enough to be worth freezing?
 *
 * Every recorded run must have passed, not merely the most recent. A mission
 * that failed, was fixed, and has passed twice since is a different thing from
 * one that has always passed — the first needs a human to say the fix is real,
 * and this cannot tell them apart, so it refuses both and says why.
 */
export function assess(mission: TestMission, minPasses: number): Eligibility {
  const runs = runsFor(mission.test_id);
  const passes = runs.filter((r) => r.status === 'PASS').length;
  const latest = runs[runs.length - 1];
  const base = { test_id: mission.test_id, mission, runs: runs.length, passes, latest };

  if (runs.length === 0) {
    return { ...base, eligible: false, reason: 'never run' };
  }
  if (passes !== runs.length) {
    const other = runs.filter((r) => r.status !== 'PASS').map((r) => r.status);
    return {
      ...base,
      eligible: false,
      reason: `not every run passed (${other.join(', ')}) — freezing this would freeze whatever it does on a bad day`,
    };
  }
  if (passes < minPasses) {
    return { ...base, eligible: false, reason: `${passes} pass(es), needs ${minPasses}` };
  }
  if (!mission.approval) {
    return { ...base, eligible: false, reason: 'not approved at Gate 2.5' };
  }
  return { ...base, eligible: true, reason: `${passes} consecutive passes` };
}

// --- Locator codegen --------------------------------------------------------

const q = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * A target descriptor as real Playwright.
 *
 * Mirrors the strategy order in discovery.ts — test id, role and name, label,
 * placeholder, text, then a raw selector — so the generated spec looks for the
 * element the same way the mission did. Diverging here would produce a spec
 * that passes while the mission fails, or the reverse, and then neither can be
 * trusted to explain the other.
 */
export function locatorFor(target: TargetSpec): string {
  const parts: string[] = [];

  if (target.test_id) {
    parts.push(`getByTestId(${q(target.test_id)})`);
  } else if (target.role && target.name) {
    const opts = target.exact ? `, { name: ${q(target.name)}, exact: true }` : `, { name: ${q(target.name)} }`;
    parts.push(`getByRole(${q(target.role)}${opts})`);
  } else if (target.role) {
    parts.push(`getByRole(${q(target.role)})`);
  } else if (target.label) {
    parts.push(`getByLabel(${q(target.label)})`);
  } else if (target.placeholder) {
    parts.push(`getByPlaceholder(${q(target.placeholder)})`);
  } else if (target.text) {
    parts.push(`getByText(${q(target.text)})`);
  } else if (target.selector) {
    parts.push(`locator(${q(target.selector)})`);
  } else {
    return `page.locator('body') /* TODO: mission target had nothing to resolve by */`;
  }

  const root = target.within ? locatorFor(target.within) : 'page';
  let expr = `${root}.${parts[0]}`;

  if (typeof target.nth === 'number') expr += `.nth(${target.nth})`;
  else if (target.expect_multiple) expr += `.first()`;

  return expr;
}

/** Sweep checks reuse the real implementation rather than a copy of it. */
const SWEEPS: Partial<Record<CheckType, string>> = {
  all_images_loaded: 'sweepImages',
  all_controls_have_accessible_name: 'sweepAccessibleNames',
};

function expectationFor(
  id: string,
  statement: string,
  check: NonNullable<TestMission['assertions'][number]['check']>,
): string[] {
  const L: string[] = [];
  L.push(`    // ${id}: ${statement}`);

  const sweep = SWEEPS[check.type];
  if (sweep) {
    L.push(`    const ${id.toLowerCase()} = await ${sweep}(page.locator('body'));`);
    L.push(
      `    expect(${id.toLowerCase()}.offenders, ` +
        `${q(`${statement} (offenders are listed in the failure message)`)}).toEqual([]);`,
    );
    return L;
  }

  if (check.type === 'url_contains') {
    L.push(`    await expect(page).toHaveURL(new RegExp(${q(String(check.value ?? ''))}));`);
    return L;
  }

  if (!check.target) {
    L.push(`    // SKIPPED: check type "${check.type}" needs a target and the mission has none.`);
    return L;
  }

  const loc = locatorFor(check.target);

  switch (check.type) {
    case 'visible':
      L.push(`    await expect(${loc}).toBeVisible();`);
      break;
    case 'not_visible':
      L.push(`    await expect(${loc}).toBeHidden();`);
      break;
    case 'enabled':
      L.push(`    await expect(${loc}).toBeEnabled();`);
      break;
    case 'disabled':
      L.push(`    await expect(${loc}).toBeDisabled();`);
      break;
    case 'text_equals':
      L.push(`    await expect(${loc}).toHaveText(${q(String(check.value ?? ''))});`);
      break;
    case 'text_contains':
      L.push(`    await expect(${loc}).toContainText(${q(String(check.value ?? ''))});`);
      break;
    case 'count':
      L.push(`    await expect(${loc}).toHaveCount(${Number(check.value ?? 0)});`);
      break;
    case 'attribute_equals':
      L.push(
        `    await expect(${loc}).toHaveAttribute(${q(check.attribute ?? '')}, ${q(String(check.value ?? ''))});`,
      );
      break;
    case 'image_loaded':
      // A broken <img> is still "visible" — this is the distinction that
      // produced a false pass before image_loaded existed. Keep it exact.
      L.push(`    await expect(${loc}).toBeVisible();`);
      L.push(`    expect(await ${loc}.evaluate((el) => (el as HTMLImageElement).naturalWidth > 0)).toBe(true);`);
      break;
    case 'has_accessible_name':
      L.push(`    const ${id.toLowerCase()}Name = await ${loc}.getAttribute('aria-label')`);
      L.push(`      ?? (await ${loc}.textContent());`);
      L.push(`    expect((${id.toLowerCase()}Name ?? '').trim(), ${q(statement)}).not.toBe('');`);
      break;
    default:
      L.push(`    // SKIPPED: no codegen for check type "${check.type}".`);
  }

  return L;
}

// --- Action codegen ---------------------------------------------------------

/**
 * Actions come from the trace, not the mission.
 *
 * The mission says what we meant to do; the trace records the locator that
 * actually resolved on a run that passed. Generating from the mission would
 * re-do the discovery the trace already did, and could resolve differently.
 */
function actionsFrom(trace: TraceStep[], mission: TestMission): string[] {
  const L: string[] = [];

  if (trace.length === 0) {
    L.push(`    // The trace recorded no steps. Falling back to the mission's own actions.`);
    for (const a of mission.actions) {
      if (a.action === 'navigate' && a.url) L.push(`    await page.goto(${q(a.url)});`);
      else if (a.target) L.push(`    await ${locatorFor(a.target)}.click(); // ${a.instruction}`);
    }
    return L;
  }

  for (const step of trace) {
    switch (step.action) {
      case 'navigate':
        L.push(`    await page.goto(${q(step.url ?? '/')});`);
        break;
      case 'click':
        L.push(`    await page.locator(${q(step.locator ?? 'body')}).click();`);
        break;
      case 'fill':
      case 'type':
        L.push(`    await page.locator(${q(step.locator ?? 'body')}).fill(${q(step.value ?? '')});`);
        break;
      case 'check':
        L.push(`    await page.locator(${q(step.locator ?? 'body')}).check();`);
        break;
      case 'select':
        L.push(`    await page.locator(${q(step.locator ?? 'body')}).selectOption(${q(step.value ?? '')});`);
        break;
      case 'press':
        L.push(`    await page.locator(${q(step.locator ?? 'body')}).press(${q(step.value ?? 'Enter')});`);
        break;
      case 'hover':
        L.push(`    await page.locator(${q(step.locator ?? 'body')}).hover();`);
        break;
      case 'upload':
        L.push(`    await page.locator(${q(step.locator ?? 'body')}).setInputFiles(${q(step.value ?? '')});`);
        break;
      case 'wait_for_state':
        L.push(`    await page.waitForLoadState(${q(step.value ?? 'load')});`);
        break;
      case 'verify':
        // Mid-flow verification is emitted with the rest of the assertions, so
        // emitting it here as well would run the same check twice.
        break;
      default:
        // Named, not skipped silently: a spec that quietly drops a step passes
        // for the wrong reason, which is the failure this codebase guards
        // against everywhere else.
        L.push(`    // NOT TRANSLATED: trace action "${step.action}" has no codegen.`);
        L.push(`    // This spec does less than the mission did. Check whether that matters.`);
    }
  }

  return L;
}

// --- The spec ---------------------------------------------------------------

export function generateSpec(mission: TestMission, result: ExecutionResult, promotedBy: string): string {
  const trace = result.replayable_trace?.steps ?? [];
  // Import only the sweeps this spec actually calls. An unused import is noise
  // in a file people are told not to edit by hand.
  const sweepImports = Array.from(
    new Set(
      mission.assertions.map((a) => SWEEPS[a.check.type]).filter((s): s is string => Boolean(s)),
    ),
  ).sort();

  const L: string[] = [];

  L.push(`/**`);
  L.push(` * ${mission.test_id} — ${mission.test_objective}`);
  L.push(` *`);
  L.push(` * GENERATED from an approved mission that passed consistently. Do not edit by`);
  L.push(` * hand: re-run \`npm run promote -- --promote ${mission.test_id}\` and this file is`);
  L.push(` * rewritten. The mission remains the source of truth — it carries the`);
  L.push(` * requirement link, the human sentence for each assertion, and the approval.`);
  L.push(` *`);
  L.push(` *   mission      missions/approved/${mission.test_id}.json`);
  if (mission.requirement_ref?.locator) {
    L.push(` *   requirement  ${mission.requirement_ref.locator}`);
  }
  L.push(` *   promoted by  ${promotedBy} on ${new Date().toISOString().slice(0, 10)}`);
  L.push(` *   from run     ${result.run_id ?? 'unknown'} (build ${result.build ?? 'unknown'})`);
  L.push(` *`);
  L.push(` * These locators are a snapshot of what resolved on that build. When this test`);
  L.push(` * breaks, it has done its job — but decide which thing broke before fixing it:`);
  L.push(` * re-run the mission, and if the mission still passes, the page moved and this`);
  L.push(` * file should be regenerated rather than patched.`);
  L.push(` */`);
  L.push(`import { expect, test } from '@playwright/test';`);
  if (sweepImports.length) {
    L.push(`import { ${sweepImports.join(', ')} } from '../../src/sweeps.js';`);
  }  L.push('');

  const title = `${mission.test_id} — ${mission.test_objective.replace(/'/g, "\\'")}`;
  L.push(`test(${q(title)}, async ({ page }) => {`);

  if (mission.preconditions.length) {
    L.push(`  // Preconditions assumed by this test:`);
    for (const p of mission.preconditions) L.push(`  //   - ${p}`);
    L.push('');
  }

  L.push(`  await test.step('actions', async () => {`);
  L.push(...actionsFrom(trace, mission));
  L.push(`  });`);
  L.push('');

  L.push(`  await test.step('assertions', async () => {`);
  for (const a of mission.assertions) {
    L.push(...expectationFor(a.id, a.statement, a.check));
  }
  L.push(`  });`);
  L.push(`});`);
  L.push('');

  return L.join('\n');
}

export function specPath(testId: string): string {
  return path.join(PATHS.root, 'tests', 'generated', `${testId.toLowerCase()}.spec.ts`);
}
