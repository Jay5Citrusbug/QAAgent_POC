import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';
import { loadLedger } from './clarifications.js';
import { approvalBlockers, listIntents, readIntentFile } from './intents.js';
import { analysisGate } from './analysis-gate.js';
import { loadFeedback } from './intent-approval.js';
import { listDefects } from './defect.js';
import { readMissionFile } from './validate.js';
import type { ExecutionResult, TestIntent, TestMission } from './types.js';

/**
 * The numbers §15 says decide whether this works.
 *
 * One requirement produces an anecdote. Five or six produce a shape, and the
 * shape is the deliverable — so every measure here is per feature, and the
 * comparison across features is the point rather than any single row.
 *
 * Two rules govern what this will print:
 *
 *  1. **Nothing is invented.** A measure with no data says so. A dash is a
 *     useful answer; a plausible-looking zero is not, and a metrics report that
 *     quietly fabricates its gaps is worse than no report because decisions get
 *     made on it.
 *
 *  2. **Nothing is scored.** There is no overall health percentage, no green
 *     tick. Those invite reading the colour instead of the number, and every
 *     number here needs interpreting against the failure conditions §15 states
 *     in advance.
 */

export interface FeatureMetrics {
  feature: string;

  // Requirement analysis — the cheapest defects this system finds.
  questionsTotal: number;
  questionsOpen: number;
  questionsAnswered: number;
  questionsAssumed: number;

  // Gate 1 — the analysis itself, approved before any test case is written.
  gate1State: 'approved' | 'stale' | 'missing';
  gate1Minutes: number[];

  // Gate 2.
  intentsApproved: number;
  intentsBlocked: number;
  intentsRestingOnAssumption: number;
  /** Rejected at Gate 2: cases the agent should not have proposed. */
  intentsRejected: number;
  /** Rework requests ever raised: cases the agent got wrong first time. */
  reworkRequests: number;
  gate2Minutes: number[];

  // Gate 2.5 — phase 2a.
  bindingRun: boolean;
  boundClean: number;
  boundNeedsReview: number;
  unbindable: number;
  uncoveredControls: number;
  exceptionsByKind: Record<string, number>;

  // Execution.
  runs: Record<'PASS' | 'FAIL' | 'BLOCKED' | 'INCONCLUSIVE', number>;

  // Gate 3 — and the §13a disagreement rate.
  defectsTotal: number;
  defectsConfirmed: number;
  defectsRejected: number;
  defectsPending: number;
  gate3Minutes: number[];
  agreement: Agreement;
}

/**
 * Agent 3 against the human.
 *
 * §13a calls this "a quality metric worth watching" and §13b makes a future
 * decision — whether defects may ever be filed without a human — conditional on
 * it. Both were written with nothing computing it, so it needs to be collecting
 * from the first requirement rather than reconstructed later.
 *
 * The two errors are not equivalent and are never merged into one percentage:
 *
 * * A **false positive** (classifier said PRODUCT_DEFECT, human disagreed)
 *   wastes review time and erodes trust in the queue.
 * * A **false negative** (classifier blamed the agent or the environment, human
 *   confirmed a real defect) is the one that ships bugs, because a result
 *   classified AGENT_EXECUTION_FAILURE is the one nobody looks at twice.
 */
export interface Agreement {
  judged: number;
  agreed: number;
  falsePositives: number;
  falseNegatives: number;
  /** Undefined rather than 0 when nothing has been judged — see rule 1. */
  rate?: number;
}

const EMPTY_RUNS = { PASS: 0, FAIL: 0, BLOCKED: 0, INCONCLUSIVE: 0 } as const;

/**
 * Which requirement an artifact belongs to.
 *
 * Not `mission.feature`, which turned out to be a free-text label: the existing
 * missions use it for things like "Global Navigation" and "Hero Carousel", so
 * grouping on it invented thirteen features out of three. `requirement_ref`
 * already carries the answer on every intent and every mission — the path under
 * `input/` *is* the requirement — and using it means no new field and no
 * mapping table to keep in step.
 *
 * Something with no `requirement_ref` is genuinely unattributable, and says so.
 * `npm run validate` already warns about that, for the same underlying reason:
 * a result that cannot be traced to a requirement is not much of a result.
 */
function featureFromLocator(locator?: string): string | undefined {
  if (!locator) return undefined;
  const named = locator.match(/^input\/feature-([^/]+)\//);
  if (named?.[1]) return named[1];
  if (locator.startsWith('input/feature/')) return 'default';
  return undefined;
}

const UNASSIGNED = '(no requirement_ref)';

function featureOfIntent(i: TestIntent): string {
  return featureFromLocator(i.requirement_ref?.locator) ?? i.feature ?? UNASSIGNED;
}

function featureOfMission(m: TestMission): string {
  return featureFromLocator(m.requirement_ref?.locator) ?? UNASSIGNED;
}

/** Features that actually exist as an input directory, plus anything orphaned. */
function featuresOnDisk(): string[] {
  const dir = path.join(PATHS.root, 'input');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => d === 'feature' || d.startsWith('feature-'))
    .map((d) => (d === 'feature' ? 'default' : d.replace(/^feature-/, '')))
    .sort();
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** The most recent reconciliation for a feature, if binding has ever run. */
function latestReconciliation(feature: string): Record<string, unknown> | undefined {
  const dir = path.join(PATHS.reports, 'reconciliation');
  if (!fs.existsSync(dir)) return undefined;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${feature}-`) && f.endsWith('.json'))
    .sort();
  const last = files[files.length - 1];
  return last ? readJson(path.join(dir, last)) : undefined;
}

function collectMissions(): TestMission[] {
  const out: TestMission[] = [];
  for (const dir of [PATHS.missionsDraft, PATHS.missionsApproved]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        out.push(readMissionFile(path.join(dir, f)));
      } catch {
        // A malformed mission is validate's problem to report, not this one's.
      }
    }
  }
  return out;
}

function collectResults(): ExecutionResult[] {
  if (!fs.existsSync(PATHS.runs)) return [];
  const out: ExecutionResult[] = [];
  for (const testId of fs.readdirSync(PATHS.runs)) {
    const dir = path.join(PATHS.runs, testId);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const run of fs.readdirSync(dir)) {
      // A replay is the same run seen twice; counting it would double every
      // failure and halve the apparent pass rate.
      if (run.endsWith('-replay')) continue;
      const file = path.join(dir, run, 'result.json');
      if (!fs.existsSync(file)) continue;
      const result = readJson<ExecutionResult>(file);
      if (result) out.push(result);
    }
  }
  return out;
}

/**
 * Did Agent 3 and the human reach the same conclusion?
 *
 * Only defects a human has actually judged count. A pending candidate is not
 * an agreement, and counting it as one would make the rate look better the
 * less anyone reviewed — exactly backwards.
 */
export function agreementFrom(defects: ReturnType<typeof listDefects>): Agreement {
  let judged = 0;
  let agreed = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const d of defects) {
    if (d.status !== 'confirmed' && d.status !== 'rejected') continue;
    // Exploration findings have no classifier proposal to agree or disagree
    // with — nothing classified them, because no requirement was involved.
    if (d.source !== 'mission') continue;

    const proposed = d.classification?.failure_classification;
    if (!proposed) continue;

    judged += 1;
    const saidDefect = proposed === 'PRODUCT_DEFECT';
    const isDefect = d.status === 'confirmed';

    if (saidDefect === isDefect) agreed += 1;
    else if (saidDefect) falsePositives += 1;
    else falseNegatives += 1;
  }

  return {
    judged,
    agreed,
    falsePositives,
    falseNegatives,
    rate: judged === 0 ? undefined : agreed / judged,
  };
}

export function buildMetrics(onlyFeature?: string): FeatureMetrics[] {
  const intents = listIntents(PATHS.intentsApproved).map(readIntentFile);
  const draftIntents = listIntents(PATHS.intentsDraft).map(readIntentFile);
  const rejectedIntents = listIntents(PATHS.intentsRejected).map(readIntentFile);
  const missions = collectMissions();
  const results = collectResults();
  const defects = listDefects();

  // Every requirement that exists, plus any orphan bucket that has members —
  // a feature with no intents yet still belongs in the table as a row of
  // dashes, because "nothing has happened here" is a fact worth seeing.
  const orphaned = [...intents, ...draftIntents].some((i) => featureOfIntent(i) === UNASSIGNED) ||
    missions.some((m) => featureOfMission(m) === UNASSIGNED);

  const features = [...featuresOnDisk(), ...(orphaned ? [UNASSIGNED] : [])]
    .filter((f) => !onlyFeature || f === onlyFeature)
    .sort();

  /** Which feature a run belongs to, via the mission or intent it came from. */
  const featureByTestId = new Map<string, string>();
  for (const i of [...intents, ...draftIntents]) featureByTestId.set(i.test_id, featureOfIntent(i));
  for (const m of missions) featureByTestId.set(m.test_id, featureOfMission(m));

  return features.map((feature) => {
    // The orphan bucket has no ledger of its own.
    const ledger = feature === UNASSIGNED ? { file: '', questions: [] } : loadLedger(feature);
    const mine = intents.filter((i) => featureOfIntent(i) === feature);
    const myDrafts = draftIntents.filter((i) => featureOfIntent(i) === feature);
    const myMissions = missions.filter((m) => featureOfMission(m) === feature);

    const recon = latestReconciliation(feature);
    const gate1 = feature === UNASSIGNED ? undefined : analysisGate(feature);

    const exceptionsByKind: Record<string, number> = {};
    for (const m of myMissions) {
      for (const e of m.binding?.exceptions ?? []) {
        exceptionsByKind[e.kind] = (exceptionsByKind[e.kind] ?? 0) + 1;
      }
    }

    const runs = { ...EMPTY_RUNS } as Record<keyof typeof EMPTY_RUNS, number>;
    for (const r of results) {
      if ((featureByTestId.get(r.test_id) ?? UNASSIGNED) !== feature) continue;
      if (r.status in runs) runs[r.status as keyof typeof EMPTY_RUNS] += 1;
    }

    /**
     * Mission defects attribute through their test id. Exploration defects have
     * no test id at all — they were found by walking a page, not by running a
     * requirement — so they attribute by the feature the explorer was pointed
     * at, which is recorded in the report they came from.
     */
    const myDefects = defects.filter((d) => {
      if (d.test_id) return (featureByTestId.get(d.test_id) ?? UNASSIGNED) === feature;
      return d.title.startsWith(`[${feature}]`);
    });

    return {
      feature,
      questionsTotal: ledger.questions.length,
      questionsOpen: ledger.questions.filter((q) => q.status === 'open').length,
      questionsAnswered: ledger.questions.filter((q) => q.status === 'answered').length,
      questionsAssumed: ledger.questions.filter((q) => q.status === 'assumed').length,

      gate1State: gate1?.state ?? 'missing',
      gate1Minutes: gate1 && gate1.state !== 'missing' && typeof gate1.approval.review_minutes === 'number' ? [gate1.approval.review_minutes] : [],

      intentsApproved: mine.length,
      intentsBlocked: myDrafts.filter((i) => approvalBlockers(i, ledger).length > 0).length,
      intentsRestingOnAssumption: mine.filter((i) => i.assumption).length,
      intentsRejected: rejectedIntents.filter((i) => featureOfIntent(i) === feature).length,
      reworkRequests: feature === UNASSIGNED ? 0 : loadFeedback(feature).length,
      gate2Minutes: mine
        .map((i) => i.approval?.review_minutes)
        .filter((n): n is number => typeof n === 'number'),

      bindingRun: Boolean(recon),
      boundClean: (recon?.clean as unknown[] | undefined)?.length ?? 0,
      boundNeedsReview: (recon?.needs_review as unknown[] | undefined)?.length ?? 0,
      unbindable: (recon?.unbindable as unknown[] | undefined)?.length ?? 0,
      uncoveredControls: (recon?.uncovered_controls as unknown[] | undefined)?.length ?? 0,
      exceptionsByKind,

      runs,

      defectsTotal: myDefects.length,
      defectsConfirmed: myDefects.filter((d) => d.status === 'confirmed').length,
      defectsRejected: myDefects.filter((d) => d.status === 'rejected').length,
      defectsPending: myDefects.filter((d) => d.status === 'candidate').length,
      gate3Minutes: myDefects
        .map((d) => d.human_review?.review_minutes)
        .filter((n): n is number => typeof n === 'number'),
      agreement: agreementFrom(myDefects),
    };
  });
}

// --- Rendering --------------------------------------------------------------

const DASH = '—';

function mean(values: number[]): string {
  if (values.length === 0) return DASH;
  return (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);
}

function pct(part: number, whole: number): string {
  if (whole === 0) return DASH;
  return `${Math.round((part / whole) * 100)}%`;
}

export function renderMetrics(all: FeatureMetrics[]): string {
  const L: string[] = [];

  L.push('# Measurement across the requirement set');
  L.push('');
  L.push(`${all.length} feature(s), ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  L.push('');
  L.push(
    '> A dash means **not measured yet**, not zero. Nothing here is scored or',
    '> rolled into a health percentage — every number needs reading against the',
    '> failure conditions in VISION §15, and a colour would invite skipping that.',
    '',
  );

  // --- Requirement analysis -------------------------------------------------
  L.push('## Requirement analysis');
  L.push('');
  L.push('Gaps found at story time. The cheapest defect this system produces: one closed');
  L.push('here costs a conversation, the same one at UAT costs a release.');
  L.push('');
  L.push('| Feature | Questions | Open | Answered | Assumed | Gate 1 | Analysis review min |');
  L.push('|---|---|---|---|---|---|---|');
  for (const m of all) {
    L.push(
      `| ${m.feature} | ${m.questionsTotal || DASH} | ${m.questionsOpen} | ${m.questionsAnswered} | ${m.questionsAssumed} | ${m.gate1State} | ${mean(m.gate1Minutes)} |`,
    );
  }
  L.push('');

  // --- Gate 2 ---------------------------------------------------------------
  L.push('## Gate 2 — test design');
  L.push('');
  L.push('Review minutes is the number most likely to kill this quietly. It must **fall**');
  L.push('across features; if the twentieth intent costs what the first did, the system is');
  L.push('generating work rather than absorbing it.');
  L.push('');
  L.push('Rejected and rework count what the reviewer had to correct. Both should fall as');
  L.push('the agent learns a product; if they do not, review is doing the design work.');
  L.push('');
  L.push('| Feature | Approved | Blocked on questions | On an assumption | Rejected | Rework requests | Avg review min |');
  L.push('|---|---|---|---|---|---|---|');
  for (const m of all) {
    L.push(
      `| ${m.feature} | ${m.intentsApproved} | ${m.intentsBlocked} | ${m.intentsRestingOnAssumption} | ${m.intentsRejected} | ${m.reworkRequests} | ${mean(m.gate2Minutes)} |`,
    );
  }
  L.push('');

  // --- Gate 2.5 -------------------------------------------------------------
  L.push('## Gate 2.5 — binding');
  L.push('');
  L.push('The exception rate decides whether this gate earns its place. Near 0% and it is');
  L.push('theatre that should merge into Gate 2; near 100% and the binder is not pulling');
  L.push('its weight. The number decides, not an opinion.');
  L.push('');
  L.push('| Feature | Clean | Needs review | Could not bind | Exception rate | Uncovered controls |');
  L.push('|---|---|---|---|---|---|');
  for (const m of all) {
    if (!m.bindingRun) {
      L.push(`| ${m.feature} | ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${DASH} |`);
      continue;
    }
    const total = m.boundClean + m.boundNeedsReview + m.unbindable;
    L.push(
      `| ${m.feature} | ${m.boundClean} | ${m.boundNeedsReview} | ${m.unbindable} | ` +
        `${pct(m.boundNeedsReview + m.unbindable, total)} | ${m.uncoveredControls} |`,
    );
  }
  L.push('');

  const allKinds = new Set(all.flatMap((m) => Object.keys(m.exceptionsByKind)));
  if (allKinds.size) {
    L.push('Why the binder could not settle a binding:');
    L.push('');
    for (const kind of Array.from(allKinds).sort()) {
      const total = all.reduce((n, m) => n + (m.exceptionsByKind[kind] ?? 0), 0);
      L.push(`* \`${kind}\` — ${total}`);
    }
    L.push('');
    L.push('This is the list that says where a model behind the binder would pay for itself.');
    L.push('');
  }

  // --- Execution ------------------------------------------------------------
  L.push('## Execution');
  L.push('');
  L.push('| Feature | PASS | FAIL | BLOCKED | INCONCLUSIVE |');
  L.push('|---|---|---|---|---|');
  for (const m of all) {
    const total = Object.values(m.runs).reduce((a, b) => a + b, 0);
    if (total === 0) {
      L.push(`| ${m.feature} | ${DASH} | ${DASH} | ${DASH} | ${DASH} |`);
      continue;
    }
    L.push(`| ${m.feature} | ${m.runs.PASS} | ${m.runs.FAIL} | ${m.runs.BLOCKED} | ${m.runs.INCONCLUSIVE} |`);
  }
  L.push('');
  L.push('An INCONCLUSIVE rate of zero is suspicious rather than excellent: it means the');
  L.push('system never declined to guess, and it is supposed to.');
  L.push('');

  // --- Gate 3 and agreement -------------------------------------------------
  L.push('## Gate 3 — defects, and the classifier');
  L.push('');
  L.push('| Feature | Reports | Confirmed | Rejected | Pending | False-defect rate | Avg review min |');
  L.push('|---|---|---|---|---|---|---|');
  for (const m of all) {
    const judged = m.defectsConfirmed + m.defectsRejected;
    L.push(
      `| ${m.feature} | ${m.defectsTotal} | ${m.defectsConfirmed} | ${m.defectsRejected} | ` +
        `${m.defectsPending} | ${judged ? pct(m.defectsRejected, judged) : DASH} | ${mean(m.gate3Minutes)} |`,
    );
  }
  L.push('');
  L.push('The false-defect rate is what decides whether anyone keeps reading the reports.');
  L.push('It must not rise across features.');
  L.push('');

  L.push('### Agent 3 against the human');
  L.push('');
  L.push('VISION §13a calls this a quality metric worth watching, and §13b makes filing a');
  L.push('defect without a human conditional on it. The two errors are never merged into');
  L.push('one number, because they cost completely different things.');
  L.push('');
  L.push('| Feature | Judged | Agreed | Agreement | False positive | False negative |');
  L.push('|---|---|---|---|---|---|');
  for (const m of all) {
    const a = m.agreement;
    L.push(
      `| ${m.feature} | ${a.judged || DASH} | ${a.judged ? a.agreed : DASH} | ` +
        `${a.rate === undefined ? DASH : `${Math.round(a.rate * 100)}%`} | ` +
        `${a.judged ? a.falsePositives : DASH} | ${a.judged ? a.falseNegatives : DASH} |`,
    );
  }
  L.push('');
  L.push('* **False positive** — the classifier said PRODUCT_DEFECT, the human disagreed.');
  L.push('  Costs review time and erodes trust in the queue.');
  L.push('* **False negative** — the classifier blamed the agent or the environment, and the');
  L.push('  human confirmed a real defect. This is the expensive one: a result classified');
  L.push('  `AGENT_EXECUTION_FAILURE` is the one nobody looks at twice, so this is how a bug ships.');
  L.push('');

  const totalJudged = all.reduce((n, m) => n + m.agreement.judged, 0);
  if (totalJudged === 0) {
    L.push('Nothing has been judged at Gate 3 yet, so there is no agreement rate. That is the');
    L.push('honest state, not a zero — confirm or reject some candidates and it fills in:');
    L.push('');
    L.push('```text');
    L.push('npm run defects -- --list');
    L.push('npm run defects -- --confirm <fingerprint> --by "<name>" --minutes <n>');
    L.push('```');
    L.push('');
  }

  // --- What is still not measured ------------------------------------------
  L.push('## Not measured here');
  L.push('');
  L.push('* **The manual baseline** — [docs/BASELINE.md](../docs/BASELINE.md). Without it the');
  L.push('  KPI in §17 cannot be computed at all, because there is nothing to compare against.');
  L.push('* **Gaps that changed the requirement.** The ledger records the answer, not whether');
  L.push('  the requirement was edited because of it. That needs a human to say so.');
  L.push('');

  return L.join('\n');
}
