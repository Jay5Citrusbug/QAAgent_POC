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
  | 'responsive'
  /** WCAG A/AA, checked by axe-core (src/a11y.ts). */
  | 'accessibility'
  /** Page speed: TTFB, LCP, CLS, load (src/performance.ts). */
  | 'performance';
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
  | 'verify'
  /** Make matching API calls fail for the rest of the mission (src/faults.ts). */
  | 'fail_requests'
  /** Call an API endpoint directly, with the browser session's cookies. */
  | 'api_request'
  /** End the session as a timeout would: cookies and web storage cleared. */
  | 'expire_session'
  /** Move to another tab: value "new" (default: the latest one opened), "original", or a URL fragment. */
  | 'switch_tab'
  /** Close the current tab and go back to the original one. */
  | 'close_tab'
  /** Click the target and keep the file it downloads. */
  | 'download'
  /** Drag the target onto `to`. */
  | 'drag'
  /** Scroll the target into view, or the page to value "bottom" / "top" (infinite lists). */
  | 'scroll'
  /** Arm how the NEXT alert/confirm/prompt is answered: `dialog` accept (default) or dismiss; value = prompt text. */
  | 'handle_dialog';

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
  | 'all_controls_have_accessible_name'
  /**
   * API checks, read from the XHR/fetch traffic the page made during the
   * mission. No element involved: they see what the UI hides — a 500 behind a
   * friendly message, a 200 carrying the wrong value.
   */
  | 'api_response'
  /** Sweep: no API call during the mission failed (5xx or no response; 4xx too with value "4xx"). */
  | 'api_no_errors'
  /**
   * Integration: what an element shows agrees with a field of an API response
   * (needs target + request + json_path). Numbers compare as numbers.
   */
  | 'ui_matches_api'
  /**
   * Sweep: the page lays out soundly at the current screen size — no sideways
   * scroll, nothing cut off or covered, tap targets big enough on touch widths.
   */
  | 'layout_sound'
  /**
   * The page (or the target region) has no WCAG A/AA violations at or above
   * `value` impact: minor, moderate, serious (default) or critical.
   */
  | 'accessible'
  /** The page looks like its approved visual baseline (within VISUAL_TOLERANCE). */
  | 'looks_like_baseline'
  /** The page loaded within `budget` (TTFB, LCP, CLS, load). */
  | 'performance_budget'
  /** An alert/confirm/prompt appeared during the mission; value = text it must contain. */
  | 'dialog_shown'
  /** A file was downloaded and is not empty; value = text its name must contain. */
  | 'file_downloaded';

export type ResolutionStrategy =
  | 'cache'
  | 'test_id'
  | 'role_name'
  | 'label'
  | 'placeholder'
  | 'text'
  | 'selector'
  /** Same words, ignoring case, spacing and punctuation. */
  | 'fuzzy'
  /** An equivalent phrase ("log in" for "sign in"). */
  | 'synonym'
  /** Chosen by the model from the visible controls — always flagged for review. */
  | 'ai'
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
  /** The element is inside an iframe: the frame's name, a fragment of its URL, or a CSS selector for the <iframe>. */
  frame?: string;
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
  /** fail_requests: which calls to fail, and how. */
  request?: { method?: string; url_contains: string };
  failure?: 'server_error' | 'not_found' | 'timeout' | 'offline' | 'slow';
  status?: number;
  delay_ms?: number;
  /** api_request: HTTP method (url is the path, relative to base_url). */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** api_request: JSON body. Strings inside support {run_id} and {saved.<name>}. */
  body?: unknown;
  /** api_request: keep response fields for later steps as {saved.<as>}. */
  save?: { json_path: string; as: string }[];
  /** drag: where to drop the target. */
  to?: TargetSpec;
  /** handle_dialog: accept (default) or dismiss the next dialog. */
  dialog?: 'accept' | 'dismiss';
}

export interface AssertionCheck {
  type: CheckType;
  target?: TargetSpec;
  value?: string | number;
  attribute?: string;
  /** api_response: which call. The most recent match is the one checked. */
  request?: { method?: string; url_contains: string };
  /** api_response: an exact code (201) or a class ("2xx", "4xx"). */
  status?: number | string;
  /** api_response: text the response body must contain. */
  body_contains?: string;
  /** api_response: a field in the JSON body ("order.status", "items[0].qty", "items.length"), compared with `value`. */
  json_path?: string;
  /** performance_budget: limits for this page; any omitted metric is not checked. */
  budget?: { ttfb_ms?: number; lcp_ms?: number; cls?: number; load_ms?: number };
}

export interface MissionAssertion {
  id: string;
  /** What the human reads at Gate 2. */
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
  /** Data-driven: the mission runs once per row (see Example). */
  examples?: Example[];
  /** Browser engine for this mission (compatibility). The run's --browser overrides it. Default chromium. */
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** Screen size for this mission: mobile, tablet, desktop, or exact. Default desktop. */
  viewport?: 'mobile' | 'tablet' | 'desktop' | { width: number; height: number };
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
  execution_policy?: {
    state?: 'reuse' | 'fresh_page' | 'fresh_context' | 'read_only';
  };
  rerun_policy?: { replay_on_failure?: boolean; on_divergence?: 'INCONCLUSIVE' };
  /** [R4] Provenance from phase 2a. Absent on hand-written missions. */
  binding?: {
    intent_ref: string;
    /** Hash of the intent at bind time; verify holds the mission if it moved. */
    intent_hash?: string;
    bound_at: string;
    bound_against?: { build?: string; captured_at?: string; url?: string };
    confidence: 'high' | 'medium' | 'low';
    exceptions?: { kind: string; where: string; summary: string; resolved_by?: string; resolution?: string }[];
    rests_on_assumption?: boolean;
  };
  approval?: {
    approved_by: string;
    approved_at: string;
    edits_made?: boolean;
    review_minutes?: number;
  };
  /** Changes made after first approval, each re-approved (npm run heal). */
  change_log?: { at: string; by: string; proposal?: string; kind?: string; change: string; reason: string; evidence?: string }[];
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
  /** Why a fallback tier chose this element. */
  resolution_note?: string;
  /** The element's real descriptor when a fallback tier found it — input to `npm run heal`. */
  resolved_as?: Partial<TargetSpec>;
  /** The element about to be acted on, outlined in red — evidence of WHICH control was used. */
  target_screenshot?: string;
  /** The page after the step. */
  screenshot?: string;
  url?: string;
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
  /** The value the check compared against, verbatim. */
  expected_value?: string;
  /** How a text check was satisfied: exact, after normalising, or by AI judging the meaning. */
  match?: 'exact' | 'normalised' | 'semantic';
  /** The model's reasoning when match is semantic. */
  match_note?: string;
  resolution_strategy?: ResolutionStrategy;
  resolution_note?: string;
  resolved_as?: Partial<TargetSpec>;
  /** The page when the check was evaluated, the checked element outlined. */
  screenshot?: string;
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
  /** The data-driven row this result is for. */
  example?: string;
  /** Every page the mission passed through, with what the page-level checks measured. */
  pages?: { url: string; performance?: { url: string; ttfb_ms?: number; lcp_ms?: number; cls?: number; load_ms?: number; dom_content_loaded_ms?: number }; visual?: 'no_baseline' | 'same' | 'changed' }[];
  /** Page performance at the end of the mission (src/performance.ts). */
  performance?: { url: string; ttfb_ms?: number; lcp_ms?: number; cls?: number; load_ms?: number; dom_content_loaded_ms?: number };
  /** Engine and version the mission ran in, e.g. "Firefox 140.0". */
  browser?: string;
  /** The screen size the mission ran at, e.g. "mobile (390×844)". */
  viewport?: string;
  /** Screenshot compared with the approved baseline (src/visual.ts). */
  visual?: {
    status: 'no_baseline' | 'same' | 'changed';
    diff_ratio?: number;
    baseline?: string;
    current: string;
    diff?: string;
    size_changed?: string;
    changed_pixels?: number;
    region?: { x: number; y: number; width: number; height: number };
  };
  session?: {
    fresh: boolean;
    inherited_from?: string;
    state_policy: 'reuse' | 'fresh_page' | 'fresh_context' | 'read_only';
    reset_reason?: string;
  };
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
  ai_analysis?: {
    status: 'available' | 'skipped' | 'failed';
    model?: string;
    summary?: string;
    likely_cause?: 'product_defect' | 'test_or_binding_problem' | 'environment_problem' | 'inconclusive';
    confidence?: Confidence;
    evidence?: string[];
    follow_up?: string[];
    error?: string;
  };
  /**
   * Screen recording. With a reused browser one video can span several tests,
   * so `offset_ms` is where this test starts inside it.
   */
  video?: { path: string; offset_ms: number; shared_with?: string[] };
  /** API traffic the page made during this test (XHR/fetch), with failures counted. */
  network?: { path: string; total: number; failed: number };
  /**
   * How far the verdict rests on exact, deterministic evidence.
   *   verified   every element and check matched exactly
   *   review     a fallback tier or AI judgement was involved — look at those steps
   *   weak       the verdict is not PASS/FAIL, or evidence is missing
   */
  evidence_trust?: 'verified' | 'review' | 'weak';
  trust_reasons?: string[];
  failure_classification: FailureClassification | null;
  classification_source?: 'classifier' | 'human' | 'none';
  classification_rationale?: string[];
  human_review?: Record<string, unknown>;
  confidence: Confidence;
  notes: string[];
}

/**
 * [R3] The UI-free half of the two-phase test — VISION section 5a.
 *
 * Mirrors schemas/test-intent.schema.json. Note what is absent and must stay
 * absent: there is no TargetSpec, no action enum, no CheckType. An intent that
 * could name a control would be a mission with fields missing, and the whole
 * point is that it is a different kind of thing.
 */
export type Observable =
  | 'message_shown'
  | 'navigation'
  | 'state_change'
  | 'element_present'
  | 'element_absent'
  | 'value_equals'
  | 'data_persisted'
  | 'access_denied'
  /** Settled by an API call the action makes: its status, or a field in its response. */
  | 'api_response'
  /** What the UI shows agrees with what the API returned. */
  | 'ui_matches_api';

export interface IntentStep {
  id: string;
  actor_intent: string;
  data_ref?: string;
  note?: string;
  /**
   * A step done through the API rather than the UI: setting data up, or
   * reading a record back to prove it was stored. Bound to an api_request.
   */
  /** Something that happens TO the user rather than by them. Bound to a step. */
  simulate?: 'session_expired';
  api?: {
    /** "POST /api/orders". {name} placeholders are filled from earlier saved values. */
    endpoint: string;
    body?: Record<string, unknown>;
    save?: { json_path: string; as: string }[];
  };
}

export interface IntentOutcome {
  id: string;
  statement: string;
  observable: Observable;
  critical?: boolean;
  note?: string;
}

export interface IntentTestData {
  name: string;
  description: string;
  provisioning?: 'seeded' | 'created_by_test' | 'manual' | 'unknown';
  disposable?: boolean;
}

/**
 * One row of a data-driven test: the values for {data.<name>}, and what must
 * happen for them. A boundary table ("7 characters: refused, 8: accepted, 64:
 * accepted, 65: refused") is one test case with four rows, not four test cases.
 */
export interface Example {
  /** Short and specific: "min-1: 7 chars", "max: 64 chars", "empty". */
  name: string;
  data: Record<string, string>;
  /** Overrides the test's expected_outcome for this row. */
  expected_outcome?: 'succeeds' | 'blocked';
  /** Intents: the outcome ids that apply to this row. Missions: the assertion ids. Omitted: all. */
  outcome_ids?: string[];
  assertion_ids?: string[];
  /** Which technique and partition this row comes from, for the reviewer. */
  note?: string;
}

export interface TestIntent {
  test_id: string;
  requirement_ref?: {
    source: 'DOC' | 'TICKET' | 'CHAT_TRANSCRIPT' | 'VERBAL';
    locator: string;
    content_hash?: string;
    quote?: string;
  };
  depends_on_clarifications?: string[];
  feature: string;
  module?: string;
  /** The sheet's 'FE/BE?' column. Derived from coverage when omitted. */
  layer?: 'FE' | 'BE' | 'FE+BE';
  capability: string;
  priority: Priority;
  actor: string;
  test_objective: string;
  expected_outcome: 'succeeds' | 'blocked';
  preconditions: string[];
  test_data?: IntentTestData[];
  coverage: {
    category: CoverageCategory;
    secondary_categories?: string[];
    execution_mode?: 'automated' | 'manual' | 'assisted';
    manual_reason?: string;
  };
  steps: IntentStep[];
  outcomes: IntentOutcome[];
  /** Data-driven: one run per row; {data.<name>} in steps and outcomes. */
  examples?: Example[];
  /** A regression test guarding a defect confirmed at Gate 3; it traces to that defect, not to a requirement sentence. */
  regression_for?: { fingerprint: string; title: string; ticket?: string };
  /**
   * A backend failure this test simulates — the error_handling case. Bound to
   * a `fail_requests` step that runs before the page opens.
   */
  /** compatibility: the engine this test is about (webkit = Safari's). Bound onto the mission. */
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** responsive: the screen size this test is about. Bound onto the mission. */
  viewport?: 'mobile' | 'tablet' | 'desktop';
  fault?: {
    kind: 'server_error' | 'not_found' | 'timeout' | 'offline' | 'slow';
    /** "POST /api/cart" when the requirement names it; otherwise chosen at Gate 2.5. */
    endpoint?: string;
    description: string;
  };
  not_verifiable_yet?: string[];
  assumption?: boolean;
  approval?: {
    approved_by: string;
    approved_at: string;
    edits_made?: boolean;
    review_minutes?: number;
    clarification_hashes?: Record<string, string>;
  };
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
  roles?: {
    name: string;
    storage_state_ref?: string;
    description?: string;
    /** Renew the saved session when older than this (default 720 = 12 h). */
    session_max_age_minutes?: number;
    /** Opt-in scripted sign-in. Names ENV VARIABLES for the credentials, never values. */
    login?: {
      url: string;
      username_env: string;
      password_env: string;
      username_label?: string;
      password_label?: string;
      submit?: string;
      success_url_contains?: string;
    };
    /** Token for api_request steps: from an env variable, or where the app keeps it. */
    api_auth?: {
      header?: string;
      /** Default "Bearer"; "" sends the raw token. */
      scheme?: string;
      token_env?: string;
      /** "localStorage:<key>", "sessionStorage:<key>" or "cookie:<name>". */
      from_storage?: string;
    };
  }[];
  /**
   * Who may open which page. `npm run access-matrix` tries every role against
   * every path and reports leaks (opened, should not) and refusals (refused,
   * should not). A role not listed in `allow` must be refused.
   */
  access?: { path: string; allow: string[]; note?: string }[];
  /** How this application refuses access, when the defaults do not recognise it. */
  access_denied?: { redirect_contains?: string[]; text?: string[] };
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
