import fs from 'node:fs';
import path from 'node:path';
import type { ConsoleMessage, Page } from '@playwright/test';
import { interpolate, MissingTestDataError, NavigationError, performAction } from './actions.js';
import { evaluateAssertion, summarise } from './assertions.js';
import { loadAppContext, PATHS, rel, RUNTIME } from './config.js';
import { AuthMissingError, BrowserLaunchError, BrowserSession, type Lease } from './browser-session.js';
import { describeCandidates, TargetAmbiguousError, TargetNotFoundError } from './discovery.js';
import { Evidence, newRunId } from './evidence.js';
import { LocatorCache } from './locator-cache.js';
import { Observer } from './observer.js';
import type {
  AssertionResult,
  ExecutionResult,
  FailureKind,
  Status,
  StepRecord,
  TestMission,
  TraceStep,
} from './types.js';

/**
 * The Execution Agent.
 *
 * It consumes an approved mission and operates the browser. It does not decide
 * what the product should do, and it does not decide why a failure happened —
 * classification is a separate pass, because an agent that just failed is the
 * least reliable narrator of why it failed.
 */

class BudgetExceededError extends Error {
  readonly kind = 'budget_exceeded';
}

/**
 * Both are raised by the shared BrowserSession now — a missing seeded session
 * and a browser that will not start are properties of the session, not of any
 * one mission. Re-exported names would be two classes with one meaning, and an
 * `instanceof` check against the wrong one silently misclassifies the failure.
 */

interface Attempt {
  status: Status;
  steps: StepRecord[];
  assertions: AssertionResult[];
  trace: TraceStep[];
  failureKind: FailureKind;
  notes: string[];
  stepsUsed: number;
  elapsedMs: number;
  budgetExceeded: boolean;
}

export interface RunOptions {
  /** Second pass after a failure: same mission, no re-discovery surprises, cache untouched. */
  isReplay?: boolean;
  runId?: string;
  evidence?: Evidence;
  /**
   * Which application context to run against, e.g. "ecommerce". Without it the
   * default context is used — which would point a second app's missions at the
   * first app's base_url and fail in a way that looks like a product defect.
   */
  feature?: string;
}

async function runAttempt(
  mission: TestMission,
  page: Page,
  cache: LocatorCache,
  ev: Evidence,
  runId: string,
  baseUrl: string,
  isReplay: boolean,
  observer?: Observer,
): Promise<Attempt> {
  const startedAt = Date.now();
  const steps: StepRecord[] = [];
  const trace: TraceStep[] = [];
  const notes: string[] = [];
  let failureKind: FailureKind = 'none';
  let budgetExceeded = false;

  const actionTimeout = mission.budget.action_timeout_ms ?? 15_000;
  const maxAttempts = mission.budget.max_discovery_attempts ?? 3;

  const assertionById = new Map(mission.assertions.map((a) => [a.id, a]));
  const assertions: AssertionResult[] = [];
  const evaluatedIds = new Set<string>();

  const assertCtx = {
    page,
    cache,
    runId,
    timeoutMs: actionTimeout,
    maxDiscoveryAttempts: maxAttempts,
  };

  const actionCtx = {
    page,
    cache,
    mission,
    baseUrl,
    runId,
    actionTimeoutMs: actionTimeout,
    maxDiscoveryAttempts: maxAttempts,
  };

  // Landing page, if the mission gave a hint. Keeps the agent out of the rest
  // of the application.
  if (mission.starting_context.url_hint) {
    const url = new URL(mission.starting_context.url_hint, baseUrl).toString();
    ev.log(`Opening starting context: ${url}`);
    try {
      await page.goto(url, { timeout: actionTimeout, waitUntil: 'domcontentloaded' });
    } catch (err) {
      throw new NavigationError(`Could not open starting context ${url}: ${String(err)}`);
    }
  }

  let stepsUsed = 0;

  for (const [i, action] of mission.actions.entries()) {
    const elapsed = Date.now() - startedAt;

    if (stepsUsed >= mission.budget.max_steps || elapsed > mission.budget.timeout_ms) {
      budgetExceeded = true;
      failureKind = 'budget_exceeded';
      notes.push(
        `Budget exhausted after ${stepsUsed} steps / ${elapsed}ms. Remaining actions were not attempted. ` +
          `A budget overrun says nothing about the product.`,
      );
      for (const remaining of mission.actions.slice(i)) {
        steps.push({
          index: steps.length + 1,
          action: remaining.action,
          instruction: remaining.instruction,
          outcome: 'SKIPPED',
        });
      }
      break;
    }

    stepsUsed += 1;
    observer?.setStep(i + 1);
    ev.log(`Step ${i + 1}/${mission.actions.length}: ${action.action} — ${action.instruction}`);

    // `verify` is evaluated here because the executor owns the assertion map.
    if (action.action === 'verify') {
      const target = action.assertion_ref ? assertionById.get(action.assertion_ref) : undefined;
      if (!target) {
        steps.push({
          index: steps.length + 1,
          action: 'verify',
          instruction: action.instruction,
          outcome: 'FAILED',
          error: `verify references unknown assertion "${action.assertion_ref ?? ''}"`,
        });
        failureKind = 'assertion_unevaluable';
        break;
      }
      const res = await evaluateAssertion(assertCtx, target);
      assertions.push(res);
      evaluatedIds.add(res.id);
      steps.push({
        index: steps.length + 1,
        action: 'verify',
        instruction: action.instruction,
        outcome: res.passed ? 'OK' : 'FAILED',
        error: res.error,
      });
      ev.log(`  ${res.passed ? 'assertion held' : 'assertion did not hold'}: ${res.statement}`);
      if (!res.passed && (res.critical ?? true)) {
        failureKind = res.evaluable === false ? 'assertion_unevaluable' : 'assertion_failed';
        break;
      }
      continue;
    }

    try {
      const { step, trace: traceStep } = await performAction(actionCtx, action, steps.length + 1);
      steps.push(step);
      if (traceStep) trace.push(traceStep);
      if (step.resolved_locator) {
        ev.log(`  resolved via ${step.resolution_strategy}: ${step.resolved_locator}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (action.tolerate_failure && mission.expected_outcome === 'blocked') {
        // The application was supposed to refuse this. Not fatal — the
        // assertions still decide whether the refusal was correct and visible.
        steps.push({
          index: steps.length + 1,
          action: action.action,
          instruction: action.instruction,
          outcome: 'TOLERATED_FAILURE',
          error: message,
        });
        ev.log(`  step failed as the mission expects (tolerate_failure): ${message}`);
        continue;
      }

      steps.push({
        index: steps.length + 1,
        action: action.action,
        instruction: action.instruction,
        outcome: 'FAILED',
        error: message,
      });

      failureKind =
        err instanceof TargetNotFoundError
          ? 'target_not_found'
          : err instanceof TargetAmbiguousError
            ? 'target_ambiguous'
            : err instanceof NavigationError
              ? 'navigation_error'
              : err instanceof MissingTestDataError
                ? 'missing_test_data'
                : 'action_error';

      ev.log(`  step failed (${failureKind}): ${message}`);
      break;
    }
  }

  // Assertions not already evaluated mid-flow. Skipped entirely if the run
  // never got far enough — asserting against a half-executed flow produces
  // confident nonsense.
  const flowCompleted = failureKind === 'none';
  if (flowCompleted) {
    for (const assertion of mission.assertions) {
      if (evaluatedIds.has(assertion.id)) continue;
      const res = await evaluateAssertion(assertCtx, assertion);
      assertions.push(res);
      ev.log(`Assertion ${res.id}: ${res.passed ? 'held' : 'did not hold'} — ${res.statement}`);
    }
  } else {
    for (const assertion of mission.assertions) {
      if (evaluatedIds.has(assertion.id)) continue;
      assertions.push({
        id: assertion.id,
        statement: assertion.statement,
        check_type: assertion.check.type,
        passed: false,
        critical: assertion.critical ?? true,
        evaluable: false,
        observed: 'not evaluated — the flow did not reach this point',
      });
    }
  }

  const summary = summarise(assertions);

  let status: Status;
  if (budgetExceeded) {
    status = 'BLOCKED';
  } else if (
    failureKind === 'target_not_found' ||
    failureKind === 'target_ambiguous' ||
    failureKind === 'navigation_error' ||
    failureKind === 'missing_test_data'
  ) {
    status = 'BLOCKED';
  } else if (failureKind === 'assertion_unevaluable' || summary.anyUnevaluableCritical) {
    status = 'INCONCLUSIVE';
    notes.push(
      'At least one critical assertion could not be evaluated. An unevaluable check is never a PASS, and never a defect either.',
    );
  } else if (summary.allCriticalPassed && failureKind === 'none') {
    status = 'PASS';
  } else {
    status = 'FAIL';
  }

  if (isReplay) notes.push('This was the deterministic replay pass.');

  return {
    status,
    steps,
    assertions,
    trace,
    failureKind,
    notes,
    stepsUsed,
    elapsedMs: Date.now() - startedAt,
    budgetExceeded,
  };
}

/**
 * The browser shared by every mission in this process.
 *
 * Created on first use and closed by `closeBrowserSession()` when the run ends.
 * A single mission run on its own still works: it gets the session, uses it,
 * and the caller closes it afterwards.
 */
let session: BrowserSession | undefined;

function activeSession(): BrowserSession {
  session ??= new BrowserSession({
    headless: !RUNTIME.headed,
    ...(RUNTIME.slowMo ? { slowMo: RUNTIME.slowMo } : {}),
    alwaysFresh: RUNTIME.freshState ?? false,
  });
  return session;
}

/** Ends the run. Always call this, or Chromium outlives the process. */
export async function closeBrowserSession(): Promise<void> {
  await session?.close();
  session = undefined;
}

export async function runMission(
  mission: TestMission,
  options: RunOptions = {},
): Promise<ExecutionResult> {
  const ctx = loadAppContext(options.feature);
  const baseUrl = ctx.application.base_url;
  const runId = options.runId ?? newRunId();
  const ev = options.evidence ?? new Evidence(mission.test_id, runId);
  const cache = new LocatorCache();
  const startedAt = new Date();

  ev.log(`=== ${mission.test_id} — ${mission.test_objective}`);
  ev.log(`Environment ${mission.environment} | base_url ${baseUrl} | role ${mission.role}`);
  ev.log(`Run id ${runId}`);
  if (mission.data_policy.creates_artifacts) {
    const name = interpolate(mission.data_policy.naming_pattern ?? '', runId);
    ev.log(`This mission creates artifacts on STAGE, named: ${name}`);
  }
  for (const p of mission.preconditions) ev.log(`Precondition (assumed): ${p}`);

  const evidencePolicy = mission.evidence_policy ?? {};
  const wantTrace = evidencePolicy.trace ?? 'retain_on_failure';

  let lease: Lease | undefined;
  let page: Page | undefined;
  let attempt: Attempt | undefined;
  let observer: Observer | undefined;
  let replay: ExecutionResult['replay'];
  let fatal: { kind: FailureKind; message: string } | undefined;
  let consoleLog: ((msg: ConsoleMessage) => void) | undefined;

  try {
    lease = await activeSession().lease(mission, (line) => ev.log(line), options.isReplay ?? false);
    page = lease.page;

    if (wantTrace !== 'never') {
      await lease.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }

    if (evidencePolicy.console !== false) {
      consoleLog = (msg: ConsoleMessage) => {
        if (msg.type() === 'error') ev.log(`  [console error] ${msg.text()}`);
      };
      page.on('console', consoleLog);
    }

    // Watch the whole run for problems the mission never asked about. This
    // never influences PASS/FAIL — it is a separate bug list, the way an
    // experienced tester notices a broken logo while testing the cart.
    observer = new Observer(page);
    observer.start();

    attempt = await runAttempt(mission, page, cache, ev, runId, baseUrl, options.isReplay ?? false, observer);

    await observer.sweepPage();

    // Evidence on failure. Cheap on the happy path, thorough when it matters.
    const failed = attempt.status !== 'PASS';
    if (failed) {
      if (evidencePolicy.screenshot !== 'never') await ev.screenshot(page, 'failure');
      if (evidencePolicy.snapshot_on_failure !== false) {
        ev.writeText('failure-snapshot.yaml', await describeCandidates(page));
      }
    } else if (evidencePolicy.screenshot === 'always' || evidencePolicy.screenshot === 'on_assertion') {
      await ev.screenshot(page, 'final');
    }

    if (wantTrace !== 'never') {
      await lease.context.tracing.stop({ path: ev.tracePath });
      if (wantTrace === 'always' || failed) ev.registerTraceIfPresent();
      else ev.discardTrace();
    }
  } catch (err) {
    const kind: FailureKind =
      err instanceof AuthMissingError
        ? 'auth_missing'
        : err instanceof NavigationError || err instanceof BrowserLaunchError
          ? 'navigation_error'
          : err instanceof BudgetExceededError
            ? 'budget_exceeded'
            : 'action_error';
    fatal = { kind, message: err instanceof Error ? err.message : String(err) };
    ev.log(`Run could not proceed (${kind}): ${fatal.message}`);
  } finally {
    /**
     * Let go of this mission's listeners, but leave the page open: the next
     * mission inherits it unless it asked for a clean start. A mission that
     * died fatally is the exception — its page may be mid-navigation or showing
     * a crash screen, and passing that on would report this failure twice.
     */
    observer?.stop();
    if (consoleLog && page && !page.isClosed()) page.off('console', consoleLog);
    if (fatal) await activeSession().discard();
  }

  // One deterministic replay before we are willing to say FAIL. A single FAIL
  // from an agentic run is weak evidence, and weak evidence is what destroys
  // the trust this whole approach depends on.
  const wantReplay = mission.rerun_policy?.replay_on_failure ?? true;
  if (!options.isReplay && wantReplay && attempt && attempt.status === 'FAIL') {
    ev.log('First run failed. Replaying once to check the result is stable.');
    const second = await runMission(mission, {
      isReplay: true,
      feature: options.feature,
      runId: `${runId}-replay`,
      evidence: new Evidence(mission.test_id, `${runId}-replay`),
    });
    const agrees = second.status === 'FAIL';
    replay = {
      attempted: true,
      status: second.status,
      agrees_with_first_run: agrees,
      note: agrees
        ? 'Both runs failed the same way.'
        : `Replay returned ${second.status} where the first run returned FAIL.`,
    };
    if (!agrees) {
      attempt.status = 'INCONCLUSIVE';
      attempt.notes.push(
        `The two runs disagreed (FAIL then ${second.status}), so this is reported as INCONCLUSIVE rather than FAIL. ` +
          `A false defect costs more human QA time than reporting nothing.`,
      );
    }
    for (const f of second.evidence) ev.add(path.resolve(PATHS.root, f));
    // Do not let replay mutations become inherited state for the next mission.
    await activeSession().discard();
  }

  const finishedAt = new Date();
  const notes = [...(attempt?.notes ?? [])];
  const artifacts: string[] = [];

  if (mission.data_policy.creates_artifacts) {
    const name = interpolate(mission.data_policy.naming_pattern ?? '', runId) ?? runId;
    const reachedSubmission = attempt?.status === 'PASS' || attempt?.status === 'FAIL';
    if (reachedSubmission) {
      artifacts.push(name);
      // On a failure we genuinely do not know whether the record was created —
      // that is often the very thing that failed. Say so rather than asserting
      // a leftover that may not exist.
      const certainty =
        attempt?.status === 'PASS'
          ? `Created on STAGE: "${name}".`
          : `May have created "${name}" on STAGE — the run failed, so whether it exists is unconfirmed.`;
      notes.push(
        `${certainty} Cleanup is ${mission.data_policy.cleanup ?? 'best_effort'} and manual in POC-1.`,
      );
    }
  }

  if (fatal) {
    notes.push(fatal.message);
  }

  const cacheSuspects = cache.suspectKeys();
  if (cacheSuspects.length > 0) {
    notes.push(
      `Locator cache entries missing more often than hitting (likely renamed controls): ${cacheSuspects.join(', ')}.`,
    );
  }

  // Only learn from a clean run. Caching locators from a failed run bakes in
  // whatever went wrong.
  if (attempt?.status === 'PASS') cache.save();

  const status: Status = fatal ? 'BLOCKED' : (attempt?.status ?? 'BLOCKED');

  const result: ExecutionResult = {
    test_id: mission.test_id,
    run_id: runId,
    requirement_ref: mission.requirement_ref as Record<string, unknown> | undefined,
    feature: mission.feature,
    module: mission.module,
    test_objective: mission.test_objective,
    environment: mission.environment,
    role: mission.role,
    session: {
      fresh: lease?.fresh ?? true,
      ...(lease?.inheritedFrom ? { inherited_from: lease.inheritedFrom } : {}),
      state_policy: mission.execution_policy?.state ?? 'reuse',
      ...(lease?.resetReason ? { reset_reason: lease.resetReason } : {}),
    },
    build: RUNTIME.build,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    status,
    // Carried forward so the classifier reasons from what actually happened
    // rather than from prose. The executor records the kind; it does not draw
    // the conclusion.
    failure_kind: attempt?.failureKind ?? fatal?.kind ?? 'none',
    steps_executed: attempt?.steps ?? [],
    expected: mission.assertions.map((a) => a.statement),
    actual: (attempt?.assertions ?? []).map(
      (a) => `${a.id}: ${a.observed ?? a.error ?? 'not observed'}`,
    ),
    assertion_results: attempt?.assertions ?? [],
    evidence: ev.list(),
    replayable_trace: { steps: attempt?.trace ?? [] },
    replay,
    budget_usage: {
      steps_used: attempt?.stepsUsed ?? 0,
      max_steps: mission.budget.max_steps,
      elapsed_ms: attempt?.elapsedMs ?? finishedAt.getTime() - startedAt.getTime(),
      timeout_ms: mission.budget.timeout_ms,
      exceeded: attempt?.budgetExceeded ?? false,
    },
    artifacts_left_behind: artifacts,
    // Separate from assertion_results on purpose: these are things nobody
    // asked about, and folding them into the mission's verdict would make
    // both the verdict and the findings less trustworthy.
    incidental_findings: observer?.list() ?? [],
    // Filled in by the classifier pass — never here.
    failure_classification: null,
    classification_source: 'none',
    confidence: 'LOW',
    notes,
  };

  // The trace is written for every run, pass or fail: it feeds the locator
  // cache, enables the replay, and is what turns a validated flow into a
  // permanent Playwright test later without re-authoring it.
  ev.writeJson('replayable-trace.json', result.replayable_trace);

  return result;
}
