import fs from 'node:fs';
import path from 'node:path';
import { PATHS, rel } from './config.js';
import { isApproved, missionInFeature, readMissionFile, validateMission } from './validate.js';
import { verify } from './verify.js';
import type { ExecutionResult, TargetSpec, TestMission } from './types.js';

/**
 * Phase 5 — keep the test cases in step with the application that shipped.
 *
 * Test cases are written before the UI exists, so some of them will describe
 * it slightly wrong. The executor already copes (fuzzy, synonym and AI
 * matching), but coping is not the same as being right: a test that only
 * passes through a synonym is marked "review" on every run, forever, and each
 * of those runs costs a human a look.
 *
 * So after a run, this reads the evidence and proposes updates:
 *
 *   locator      a step found its element only by a fallback tier — update the
 *                test to the element's real name, so the next run matches exactly
 *   expectation  a check failed only because the text differs — MAY be an
 *                intentional wording change, MAY be a defect; needs a person who
 *                knows which, and is refused outright when the requirement itself
 *                states the expected text
 *   rebind       the intent was edited after the test was generated from it
 *   reapprove    the requirement changed under an approved test
 *
 * Nothing is changed until a person applies a proposal by id. Applying
 * re-stamps the approval with that person's name and appends a change_log
 * entry, so the audit trail says who changed what, when, on what evidence.
 */

export type ProposalKind = 'locator' | 'expectation' | 'rebind' | 'reapprove';

export interface ProposalTarget {
  kind: 'action' | 'assertion';
  /** Action index (0-based) or assertion id. */
  index?: number;
  id?: string;
  field: 'target' | 'value';
}

export interface Proposal {
  id: string;
  test_id: string;
  kind: ProposalKind;
  summary: string;
  reason: string;
  target?: ProposalTarget;
  before?: unknown;
  after?: unknown;
  /** Screenshot of the element or check the proposal is based on. */
  evidence?: string;
  /** Run the evidence came from. */
  run?: string;
  run_status?: string;
  /** Can `--apply` perform it? Rebind/reapprove are commands for a person to run. */
  applicable: boolean;
  /** Requires --confirmed-with: it changes what the test expects, not where it looks. */
  needs_confirmation?: boolean;
  command?: string;
  confidence: 'recommended' | 'check-evidence' | 'needs-owner';
}

export interface HealingReport {
  feature: string;
  generated_at: string;
  proposals: Proposal[];
}

const DESCRIPTOR_KEYS = ['role', 'name', 'label', 'placeholder', 'text', 'exact', 'test_id', 'selector'] as const;

function missionFiles(feature?: string): { file: string; mission: TestMission }[] {
  const out: { file: string; mission: TestMission }[] = [];
  for (const dir of [PATHS.missionsApproved, PATHS.missionsDraft]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      try {
        const m = readMissionFile(path.join(dir, f));
        if (missionInFeature(m, feature) && !out.some((o) => o.mission.test_id === m.test_id)) out.push({ file: path.join(dir, f), mission: m });
      } catch {
        /* validate reports malformed files */
      }
    }
  }
  return out;
}

/** The most recent first-pass (non-replay) result for a mission. */
export function latestResult(testId: string): { result: ExecutionResult; dir: string } | undefined {
  const dir = path.join(PATHS.runs, testId);
  if (!fs.existsSync(dir)) return undefined;
  const runs = fs
    .readdirSync(dir)
    .filter((d) => !d.endsWith('-replay') && fs.existsSync(path.join(dir, d, 'result.json')))
    .sort();
  const last = runs[runs.length - 1];
  if (!last) return undefined;
  try {
    return { result: JSON.parse(fs.readFileSync(path.join(dir, last, 'result.json'), 'utf8')) as ExecutionResult, dir: path.join(dir, last) };
  } catch {
    return undefined;
  }
}

function withDescriptor(target: TargetSpec, d: Partial<TargetSpec>): TargetSpec {
  const next: TargetSpec = { ...target };
  for (const k of DESCRIPTOR_KEYS) delete next[k];
  return { ...next, ...d };
}

function show(t: Partial<TargetSpec> | undefined): string {
  if (!t) return '—';
  if (t.role && t.name) return `${t.role} "${t.name}"`;
  if (t.label) return `label "${t.label}"`;
  if (t.placeholder) return `placeholder "${t.placeholder}"`;
  if (t.text) return `text "${t.text}"`;
  if (t.role) return `any ${t.role}`;
  return JSON.stringify(t);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export async function buildProposals(feature?: string): Promise<HealingReport> {
  const proposals: Omit<Proposal, 'id'>[] = [];

  for (const { mission } of missionFiles(feature)) {
    const latest = latestResult(mission.test_id);
    if (!latest) continue;
    const { result } = latest;
    const runRef = rel(latest.dir);
    const quote = (mission.requirement_ref?.quote ?? '').toString();

    // --- locators: steps that only worked through a fallback tier ---------------
    for (const step of result.steps_executed) {
      if (!step.resolved_as || !['fuzzy', 'synonym', 'ai'].includes(step.resolution_strategy ?? '')) continue;
      if (step.outcome !== 'OK' && step.outcome !== 'TOLERATED_FAILURE') continue;
      const index = step.index - 1;
      const action = mission.actions[index];
      // The mission may have been edited since the run; only heal what still lines up.
      if (!action?.target || !step.instruction.startsWith(action.instruction)) continue;
      const after = withDescriptor(action.target, step.resolved_as);
      if (show(after) === show(action.target)) continue;
      const passed = result.status === 'PASS';
      proposals.push({
        test_id: mission.test_id,
        kind: 'locator',
        summary: `Step ${step.index} ("${action.instruction}"): look for ${show(step.resolved_as)} instead of ${show(action.target)}`,
        reason: `${step.resolution_note ?? `Found by ${step.resolution_strategy}.`} Updating the test lets the next run match exactly, so it is reported "verified" rather than "review".`,
        target: { kind: 'action', index, field: 'target' },
        before: action.target,
        after,
        ...(step.target_screenshot ? { evidence: step.target_screenshot } : {}),
        run: runRef,
        run_status: result.status,
        applicable: true,
        confidence: passed && step.resolution_strategy !== 'ai' ? 'recommended' : 'check-evidence',
      });
    }

    for (const a of result.assertion_results ?? []) {
      const assertion = mission.assertions.find((x) => x.id === a.id);
      if (!assertion) continue;

      // --- check targets found by a fallback tier -------------------------------
      if (a.resolved_as && assertion.check.target && ['fuzzy', 'synonym'].includes(a.resolution_strategy ?? '')) {
        const after = withDescriptor(assertion.check.target, a.resolved_as);
        if (show(after) !== show(assertion.check.target)) {
          proposals.push({
            test_id: mission.test_id,
            kind: 'locator',
            summary: `Check ${a.id}: examine ${show(a.resolved_as)} instead of ${show(assertion.check.target)}`,
            reason: `${a.resolution_note ?? 'Found by a fallback tier.'} Updating it makes the check exact.`,
            target: { kind: 'assertion', id: a.id, field: 'target' },
            before: assertion.check.target,
            after,
            ...(a.screenshot ? { evidence: a.screenshot } : {}),
            run: runRef,
            run_status: result.status,
            applicable: true,
            confidence: a.passed ? 'recommended' : 'check-evidence',
          });
        }
      }

      // --- expectations: the text on the page differs from the test -------------
      const textCheck = assertion.check.type === 'text_equals' || assertion.check.type === 'text_contains';
      const expected = assertion.check.value === undefined ? undefined : String(assertion.check.value);
      if (!textCheck || expected === undefined || !a.observed) continue;
      // Only when the flow itself completed: a check that failed because the run
      // broke earlier says nothing about the wording.
      const flowCompleted = !result.steps_executed.some((s) => s.outcome === 'FAILED' || s.outcome === 'SKIPPED');
      const failedOnText = !a.passed && a.evaluable !== false && flowCompleted;
      const passedOnMeaning = a.passed && a.match === 'semantic';
      if (!failedOnText && !passedOnMeaning) continue;

      // If the requirement itself states the expected text, the page is wrong,
      // not the test. That is a defect to raise, never an update to apply.
      const statedByRequirement = Boolean(quote) && norm(quote).includes(norm(expected));
      proposals.push({
        test_id: mission.test_id,
        kind: 'expectation',
        summary: `Check ${a.id}: page says "${a.observed}", test expects "${expected}"`,
        reason: statedByRequirement
          ? `The requirement itself states "${expected}", so the page is out of line with the requirement. Treat this as a defect; updating the test would hide it.`
          : passedOnMeaning
            ? `It passed on meaning (${a.match_note ?? 'AI judged it equivalent'}). If this wording is the intended final copy, updating the test makes the check exact.`
            : 'Either a defect, or the wording was changed on purpose. Only the requirement owner can say which — confirm with them before applying, and name them with --confirmed-with.',
        target: { kind: 'assertion', id: a.id, field: 'value' },
        before: expected,
        after: assertion.check.type === 'text_contains' ? a.observed : a.observed,
        ...(a.screenshot ? { evidence: a.screenshot } : {}),
        run: runRef,
        run_status: result.status,
        applicable: !statedByRequirement,
        needs_confirmation: true,
        confidence: 'needs-owner',
      });
    }
  }

  // --- stale tests, from the same checks `run-mission` gates on ---------------------
  try {
    const v = await verify({ feature, noNetwork: true });
    for (const issue of v.issues) {
      if (!issue.test_id) continue;
      if (issue.check === 'binding' && /edited after|re-approved after|older capture/.test(issue.message)) {
        proposals.push({
          test_id: issue.test_id,
          kind: 'rebind',
          summary: `${issue.test_id}: regenerate from its intent`,
          reason: issue.message,
          applicable: false,
          command: issue.fix ?? `npm run bind -- --feature ${feature ?? '<feature>'} --write --force`,
          confidence: 'recommended',
        });
      }
      if (issue.check === 'requirement_drift') {
        proposals.push({
          test_id: issue.test_id,
          kind: 'reapprove',
          summary: `${issue.test_id}: the requirement changed since approval`,
          reason: `${issue.message} Re-read the test against the new text; re-approve if it still holds, edit it if not.`,
          applicable: false,
          command: `npm run approve -- ${issue.test_id} --by "<you>" --edited`,
          confidence: 'needs-owner',
        });
      }
    }
  } catch {
    /* verify needs an application context; healing still works without it */
  }

  return {
    feature: feature ?? 'default',
    generated_at: new Date().toISOString(),
    proposals: proposals.map((p, i) => ({ id: `H-${i + 1}`, ...p })),
  };
}

// --- apply --------------------------------------------------------------------------

export interface ApplyOutcome {
  id: string;
  ok: boolean;
  message: string;
}

function readAt(m: TestMission, t: ProposalTarget): unknown {
  if (t.kind === 'action') return m.actions[t.index ?? -1]?.target;
  const a = m.assertions.find((x) => x.id === t.id);
  return t.field === 'target' ? a?.check.target : a?.check.value;
}

function writeAt(m: TestMission, t: ProposalTarget, value: unknown): void {
  if (t.kind === 'action') {
    m.actions[t.index!]!.target = value as TargetSpec;
    return;
  }
  const a = m.assertions.find((x) => x.id === t.id)!;
  if (t.field === 'target') a.check.target = value as TargetSpec;
  else a.check.value = value as string;
}

export function applyProposals(
  report: HealingReport,
  ids: string[],
  opts: { by: string; confirmedWith?: string },
): ApplyOutcome[] {
  const out: ApplyOutcome[] = [];
  const files = new Map(missionFiles(report.feature === 'default' ? undefined : report.feature).map((x) => [x.mission.test_id, x.file]));

  for (const id of ids) {
    const p = report.proposals.find((x) => x.id === id);
    if (!p) {
      out.push({ id, ok: false, message: 'no such proposal in the latest healing report' });
      continue;
    }
    if (!p.applicable || !p.target) {
      out.push({ id, ok: false, message: p.command ? `not applied automatically — run: ${p.command}` : `not applicable: ${p.reason}` });
      continue;
    }
    if (p.needs_confirmation && !opts.confirmedWith) {
      out.push({ id, ok: false, message: 'changes what the test expects — add --confirmed-with "<requirement owner>"' });
      continue;
    }
    const file = files.get(p.test_id);
    if (!file) {
      out.push({ id, ok: false, message: `mission ${p.test_id} not found` });
      continue;
    }
    const mission = readMissionFile(file);
    // Refuse to apply onto a mission that moved since the proposal was made.
    if (JSON.stringify(readAt(mission, p.target)) !== JSON.stringify(p.before)) {
      out.push({ id, ok: false, message: 'the mission changed since this proposal was made — re-run `npm run heal`' });
      continue;
    }
    writeAt(mission, p.target, p.after);
    const now = new Date().toISOString();
    mission.change_log = [
      ...(mission.change_log ?? []),
      {
        at: now,
        by: opts.by,
        proposal: p.id,
        kind: p.kind,
        change: p.summary,
        reason: p.needs_confirmation ? `${p.reason} Confirmed with ${opts.confirmedWith}.` : p.reason,
        ...(p.evidence ? { evidence: p.evidence } : {}),
      },
    ];
    // Applying a change is an approval of the changed mission, by this person.
    if (isApproved(mission)) {
      mission.approval = { ...mission.approval!, approved_by: opts.by, approved_at: now, edits_made: true };
    }
    const { valid, errors } = validateMission(mission);
    if (!valid) {
      out.push({ id, ok: false, message: `the change would make the mission invalid: ${errors.slice(0, 2).join('; ')}` });
      continue;
    }
    fs.writeFileSync(file, `${JSON.stringify(mission, null, 2)}\n`, 'utf8');
    out.push({ id, ok: true, message: `${p.test_id} updated — ${p.summary}` });
  }
  return out;
}

// --- files ------------------------------------------------------------------------------

export function healingJsonPath(feature?: string): string {
  return path.join(PATHS.reports, `healing-${feature ?? 'default'}.json`);
}

export function renderHealing(r: HealingReport): string {
  const L: string[] = [`# Test case updates — ${r.feature}`, '', `Generated ${r.generated_at}`, ''];
  if (r.proposals.length === 0) {
    L.push('Nothing to update. Every element was found by its exact name and every check matched.', '');
    return L.join('\n');
  }
  L.push(
    'Proposals only — nothing has changed. Apply by id:',
    '',
    '```',
    `npm run heal -- --feature ${r.feature} --apply H-1 H-2 --by "<you>"`,
    `npm run heal -- --feature ${r.feature} --apply H-5 --by "<you>" --confirmed-with "<requirement owner>"   # expectation changes`,
    '```',
    '',
  );
  const groups: [ProposalKind, string][] = [
    ['locator', 'Where the test looks — safe to apply after glancing at the screenshot'],
    ['expectation', 'What the test expects — needs the requirement owner'],
    ['rebind', 'Out of date — regenerate'],
    ['reapprove', 'Requirement changed — re-read'],
  ];
  for (const [kind, title] of groups) {
    const ps = r.proposals.filter((p) => p.kind === kind);
    if (!ps.length) continue;
    L.push(`## ${title}`, '');
    for (const p of ps) {
      L.push(`### ${p.id} · ${p.test_id} · ${p.confidence}${p.applicable ? '' : ' · not auto-applicable'}`, '', p.summary, '', `_${p.reason}_`, '');
      if (p.evidence) L.push(`Evidence: [${path.basename(p.evidence)}](../${p.evidence})`, '');
      if (p.command) L.push('```', p.command, '```', '');
    }
  }
  return L.join('\n');
}

export function writeHealing(r: HealingReport): string {
  fs.mkdirSync(PATHS.reports, { recursive: true });
  fs.writeFileSync(healingJsonPath(r.feature === 'default' ? undefined : r.feature), `${JSON.stringify(r, null, 2)}\n`, 'utf8');
  const md = path.join(PATHS.reports, `HEALING-${r.feature}.md`);
  fs.writeFileSync(md, `${renderHealing(r)}\n`, 'utf8');
  return rel(md);
}
