/**
 * TypeScript mirrors of the two JSON schemas.
 *
 * The schemas in schemas/ are authoritative — they are what the Thinking Agent
 * is held to and what `npm run validate` enforces. These types exist so the
 * executor is type-safe against the same contract. If you change one, change
 * both.
 */

export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

/** QA checklist areas — see agent/thinking/COVERAGE_CHECKLIST.md. */
export type CoverageCategory =
  | 'requirement_based'
  | 'functional'
  | 'negative'
  | 'input_validation'
  | 'navigation'
  | 'edge_case'
  | 'ui_ux'
  | 'data_integrity'
  | 'error_handling'
  | 'security'
  | 'api'
  | 'integration'
  | 'compatibility'
  | 'responsive';
export type Status = 'PASS' | 'FAIL' | 'BLOCKED' | 'INCONCLUSIVE';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type FailureClassification =
  | 'PRODUCT_DEFECT'
  | 'AGENT_EXECUTION_FAILURE'
  | 'ENVIRONMENT_FAILURE'
  | 'TEST_DATA_FAILURE'
  | 'INCONCLUSIVE';

export type ActionType =
  | 'navigate'
  | 'click'
  | 'fill'
  | 'type'
  | 'select'
  | 'check'
  | 'upload'
  | 'hover'
  | 'press'
  | 'wait_for_state'
  | 'verify';

export type CheckType =
  | 'visible'
  | 'not_visible'
  | 'text_equals'
  | 'text_contains'
  | 'enabled'
  | 'disabled'
  | 'count'
  | 'url_contains'
  | 'attribute_equals'
  /** The image actually decoded. A broken <img> is still "visible". */
  | 'image_loaded'
  /** The element exposes a non-empty accessible name (icon-only controls). */
  | 'has_accessible_name'
  /**
   * Sweeps: check a property across EVERY matching element rather than one
   * named element. Catches a whole bug class without predicting each instance.
   */
  | 'all_images_loaded'
  | 'all_controls_have_accessible_name';

export type ResolutionStrategy =
  | 'cache'
  | 'test_id'
  | 'role_name'
  | 'label'
  | 'placeholder'
  | 'text'
  | 'selector'
  | 'none';

/** A semantic element descriptor. Meaning, not CSS — and never a coordinate. */
export interface TargetSpec {
  description: string;
  capability_key?: string;
  role?: string;
  name?: string;
  exact?: boolean;
  label?: string;
  placeholder?: string;
  text?: string;
  test_id?: string;
  selector?: string;
  within?: TargetSpec;
  nth?: number;
  /** Without this, several matches is an error — the agent never picks one silently. */
  expect_multiple?: boolean;
}

export interface MissionAction {
  action: ActionType;
  instruction: string;
  target?: TargetSpec;
  value?: string;
  data_ref?: string;
  url?: string;
  state?: 'load' | 'domcontentloaded' | 'networkidle';
  assertion_ref?: string;
  /** For `blocked` missions: this step may legitimately fail. */
  tolerate_failure?: boolean;
}

export interface AssertionCheck {
  type: CheckType;
  target?: TargetSpec;
  value?: string | number;
  attribute?: string;
}

export interface MissionAssertion {
  id: string;
  /** What the human reads at Gate 1. */
  statement: string;
  /** What becomes a real Playwright expectation. */
  check: AssertionCheck;
  critical?: boolean;
}

export interface TestMission {
  test_id: string;
  requirement_ref?: {
    source: 'DOC' | 'TICKET' | 'CHAT_TRANSCRIPT' | 'VERBAL';
    locator: string;
    content_hash?: string;
    quote?: string;
  };
  feature: string;
  module: string;
  capability: string;
  priority: Priority;
  role: string;
  environment: 'STAGE';
  auth?: { strategy: 'storage_state' | 'anonymous'; storage_state_ref?: string };
  starting_context: { page: string; location?: string; url_hint?: string };
  preconditions: string[];
  test_objective: string;
  coverage?: {
    category: CoverageCategory;
    secondary_categories?: string[];
    execution_mode?: 'automated' | 'manual' | 'assisted';
    manual_reason?: string;
  };
  expected_outcome: 'succeeds' | 'blocked';
  test_data?: { name: string; path: string; note?: string }[];
  data_policy: {
    creates_artifacts: boolean;
    naming_pattern?: string;
    cleanup?: 'none' | 'best_effort' | 'required';
    cleanup_instruction?: string;
  };
  actions: MissionAction[];
  assertions: MissionAssertion[];
  evidence_policy?: {
    screenshot?: 'on_failure' | 'on_assertion' | 'always' | 'never';
    trace?: 'retain_on_failure' | 'always' | 'never';
    console?: boolean;
    network?: boolean;
    snapshot_on_failure?: boolean;
  };
  budget: {
    max_steps: number;
    timeout_ms: number;
    action_timeout_ms?: number;
    max_discovery_attempts?: number;
  };
  rerun_policy?: { replay_on_failure?: boolean; on_divergence?: 'INCONCLUSIVE' };
  approval?: {
    approved_by: string;
    approved_at: string;
    edits_made?: boolean;
    review_minutes?: number;
  };
}

export interface StepRecord {
  index: number;
  action: string;
  instruction: string;
  outcome: 'OK' | 'FAILED' | 'SKIPPED' | 'TOLERATED_FAILURE';
  resolved_locator?: string;
  resolution_strategy?: ResolutionStrategy;
  resolution_confidence?: Confidence;
  duration_ms?: number;
  error?: string;
}

export interface AssertionResult {
  id: string;
  statement: string;
  check_type?: string;
  passed: boolean;
  critical: boolean;
  observed?: string;
  error?: string;
  /** False when the check could not become a real expectation → INCONCLUSIVE, never PASS. */
  evaluable?: boolean;
}

export interface TraceStep {
  action: string;
  locator?: string;
  value?: string;
  url?: string;
  capability_key?: string;
}

export interface ExecutionResult {
  test_id: string;
  run_id?: string;
  requirement_ref?: Record<string, unknown>;
  feature?: string;
  module?: string;
  /** Carried forward so a report is readable without opening the mission. */
  test_objective?: string;
  environment?: string;
  role?: string;
  build?: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  status: Status;
  /** What kind of thing stopped the run. Input to the classifier, not a verdict. */
  failure_kind?: FailureKind;
  steps_executed: StepRecord[];
  expected: string[];
  actual: string[];
  assertion_results?: AssertionResult[];
  evidence: string[];
  replayable_trace?: { steps: TraceStep[] };
  replay?: {
    attempted?: boolean;
    status?: Status;
    agrees_with_first_run?: boolean;
    note?: string;
  };
  budget_usage?: {
    steps_used?: number;
    max_steps?: number;
    elapsed_ms?: number;
    timeout_ms?: number;
    exceeded?: boolean;
  };
  artifacts_left_behind?: string[];
  /**
   * Things noticed during the run that the mission never asked about.
   * Deliberately separate from assertion results: these never change
   * PASS/FAIL, they are their own bug list.
   */
  incidental_findings?: {
    kind: string;
    severity: string;
    summary: string;
    detail?: string;
    url?: string;
    count: number;
    first_seen_step?: number;
  }[];
  failure_classification: FailureClassification | null;
  classification_source?: 'classifier' | 'human' | 'none';
  classification_rationale?: string[];
  human_review?: Record<string, unknown>;
  confidence: Confidence;
  notes: string[];
}

/** Cache of elements resolved successfully before. Written, not hand-maintained. */
export interface LocatorCacheEntry {
  description?: string;
  strategy: ResolutionStrategy;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  test_id?: string;
  selector?: string;
  hits?: number;
  misses?: number;
  last_confirmed?: string | null;
}

export interface LocatorCacheFile {
  $comment?: string;
  entries: Record<string, LocatorCacheEntry>;
}

export interface AppContext {
  application: {
    name: string;
    environment: string;
    base_url: string;
    starting_page?: string;
    build?: string;
  };
  pages?: Record<string, { path: string; description?: string }>;
  modules?: { name: string; capabilities?: string[] }[];
  roles?: { name: string; storage_state_ref?: string; description?: string }[];
  global_testing_rules?: string[];
  data_hygiene?: { artifact_prefix?: string; cleanup?: string; note?: string };
}

/**
 * Why a run stopped, used by the classifier. The executor records the kind; it
 * does not draw the conclusion.
 */
export type FailureKind =
  | 'none'
  | 'assertion_failed'
  | 'assertion_unevaluable'
  | 'target_not_found'
  | 'target_ambiguous'
  | 'action_error'
  | 'navigation_error'
  | 'precondition_unmet'
  | 'budget_exceeded'
  | 'missing_test_data'
  | 'auth_missing';
