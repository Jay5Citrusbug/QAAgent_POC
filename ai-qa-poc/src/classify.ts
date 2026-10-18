import type { Confidence, ExecutionResult, FailureClassification, TestMission } from './types.js';

/**
 * The classifier pass.
 *
 * Deliberately separate from the executor. An agent that just failed is the
 * least reliable narrator of why it failed: self-classification is what lets
 * AGENT_EXECUTION_FAILURE quietly mask a real product defect, and it is exactly
 * what POC success criterion 9 asks us to keep honest.
 *
 * In POC-1 this is a deterministic rule set rather than a model — there is no
 * LLM integration yet, and rules are auditable, free, and good enough for the
 * failure kinds the executor can distinguish. When a model does take this over,
 * it takes over *this function*, and the human review at Gate 3 does not change.
 *
 * Whatever this returns is a *proposal*. The human at Gate 3 decides.
 */
export interface Classification {
  failure_classification: FailureClassification | null;
  confidence: Confidence;
  rationale: string[];
}

export function classify(result: ExecutionResult, mission: TestMission): Classification {
  const rationale: string[] = [];
  const kind = result.failure_kind ?? 'none';

  if (result.status === 'PASS') {
    return {
      failure_classification: null,
      confidence: allCriticalAssertionsRan(result) ? 'HIGH' : 'MEDIUM',
      rationale: ['All critical assertions were verified against the live page.'],
    };
  }

  // Environment and setup problems first. These are the ones most often
  // misreported as bugs, and misreporting them burns the QA team's trust
  // faster than anything else.
  if (kind === 'auth_missing') {
    return {
      failure_classification: 'ENVIRONMENT_FAILURE',
      confidence: 'HIGH',
      rationale: [
        'No seeded session was available for the mission role, so the run never reached the product.',
      ],
    };
  }

  if (kind === 'navigation_error') {
    return {
      failure_classification: 'ENVIRONMENT_FAILURE',
      confidence: 'HIGH',
      rationale: [
        'The target page could not be opened. The application was not reachable in a testable state.',
        'This is never reported as a product defect.',
      ],
    };
  }

  if (kind === 'missing_test_data') {
    return {
      failure_classification: 'TEST_DATA_FAILURE',
      confidence: 'HIGH',
      rationale: ['A fixture the mission depends on was missing or undefined.'],
    };
  }

  if (kind === 'budget_exceeded') {
    return {
      failure_classification: 'INCONCLUSIVE',
      confidence: 'HIGH',
      rationale: [
        `The run hit its budget (${result.budget_usage?.steps_used ?? '?'}/${result.budget_usage?.max_steps ?? '?'} steps).`,
        'Running out of budget says nothing about the product.',
      ],
    };
  }

  if (kind === 'target_ambiguous') {
    return {
      failure_classification: 'AGENT_EXECUTION_FAILURE',
      confidence: 'MEDIUM',
      rationale: [
        'Several elements matched the mission descriptor, so the agent stopped rather than choose one.',
        'Usually the mission needs a more specific target or a `within` scope — but check the page first: a duplicated control can itself be the defect.',
      ],
    };
  }

  if (kind === 'target_not_found') {
    // The honest ambiguity in the whole system. A missing button is either a
    // stale mission or a broken feature, and the agent cannot tell which.
    return {
      failure_classification: 'AGENT_EXECUTION_FAILURE',
      confidence: 'LOW',
      rationale: [
        'An element the mission expects could not be identified on the live page.',
        'This is genuinely ambiguous: either the mission descriptor is stale, or the control is missing — which would be a product defect.',
        'Low confidence is deliberate. A human should look at the failure snapshot before this is dismissed as an agent problem.',
      ],
    };
  }

  if (result.status === 'INCONCLUSIVE') {
    const diverged = result.replay?.agrees_with_first_run === false;
    return {
      failure_classification: 'INCONCLUSIVE',
      confidence: diverged ? 'HIGH' : 'MEDIUM',
      rationale: diverged
        ? [
            `The two runs disagreed (${result.replay?.note ?? 'replay diverged'}).`,
            'Reported as INCONCLUSIVE rather than FAIL: a false defect costs more human QA time than reporting nothing.',
          ]
        : [
            'At least one critical assertion could not be turned into a real expectation, so neither PASS nor FAIL can be justified.',
          ],
    };
  }

  if (kind === 'assertion_failed' || result.status === 'FAIL') {
    const actionsClean = result.steps_executed.every(
      (s) => s.outcome === 'OK' || s.outcome === 'TOLERATED_FAILURE' || s.outcome === 'SKIPPED',
    );
    const replayAgreed = result.replay?.agrees_with_first_run === true;
    const failed = (result.assertion_results ?? []).filter((a) => a.critical && !a.passed);

    rationale.push(
      `The flow completed and ${failed.length} critical assertion(s) did not hold: ${failed
        .map((a) => a.id)
        .join(', ')}.`,
    );
    if (actionsClean) {
      rationale.push('Every action the agent performed succeeded, so the failure is in the outcome, not the operation.');
    }
    if (replayAgreed) rationale.push('A deterministic replay failed the same way.');

    if (mission.expected_outcome === 'blocked') {
      rationale.push(
        'This is a negative mission: the application was expected to refuse, and the assertion verifying the refusal did not hold.',
      );
    }

    /**
     * An assertion that failed because its element was never found is much
     * weaker evidence of a product defect than one that found the element and
     * read the wrong value.
     *
     * "Not found" has three very different causes that look identical here:
     * the feature is broken (a real defect), the descriptor is wrong (a test
     * defect), or the element was never specified in the requirement at all
     * (an invented expectation). Calling that PRODUCT_DEFECT with HIGH
     * confidence manufactures false defects — which cost more QA time than
     * reporting nothing, and teach the team to distrust every result.
     */
    const notFound = failed.filter((a) => /not found|could not identify/i.test(a.error ?? ''));
    const allNotFound = failed.length > 0 && notFound.length === failed.length;

    let confidence: Confidence = 'MEDIUM';
    if (actionsClean && replayAgreed) confidence = 'HIGH';
    else if (!actionsClean) confidence = 'LOW';

    if (allNotFound) {
      // Downgrade hard: the element was never located, so we cannot say the
      // product misbehaved rather than the mission describing it wrongly.
      confidence = replayAgreed ? 'MEDIUM' : 'LOW';
      rationale.push(
        `Every failing assertion failed because its element could not be found, not because it held the wrong value. ` +
          `That is equally consistent with a stale or invented target descriptor as with a real defect — ` +
          `check the failure snapshot before treating this as a product bug.`,
      );
      return { failure_classification: 'INCONCLUSIVE', confidence, rationale };
    }

    return { failure_classification: 'PRODUCT_DEFECT', confidence, rationale };
  }

  if (kind === 'action_error') {
    return {
      failure_classification: 'AGENT_EXECUTION_FAILURE',
      confidence: 'LOW',
      rationale: [
        'An action raised an error that is not clearly an environment, data, or discovery problem.',
        'Low confidence: read the trace before accepting this.',
      ],
    };
  }

  return {
    failure_classification: 'INCONCLUSIVE',
    confidence: 'LOW',
    rationale: ['The failure did not match any known pattern. A human should look at the evidence.'],
  };
}

function allCriticalAssertionsRan(result: ExecutionResult): boolean {
  const criticals = (result.assertion_results ?? []).filter((a) => a.critical);
  return criticals.length > 0 && criticals.every((a) => a.evaluable !== false);
}

/** Apply a proposed classification to a result, recording that it came from the classifier. */
export function applyClassification(result: ExecutionResult, mission: TestMission): ExecutionResult {
  const c = classify(result, mission);
  return {
    ...result,
    failure_classification: c.failure_classification,
    classification_source: c.failure_classification === null ? 'none' : 'classifier',
    classification_rationale: c.rationale,
    confidence: c.confidence,
  };
}
