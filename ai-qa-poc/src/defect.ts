import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, rel, RUNTIME } from './config.js';
import type { ExecutionResult, TestMission } from './types.js';

/**
 * From a failure to something you can hand a developer.
 *
 * The gap this closes is mundane and expensive: a run produces a status, an
 * error string and a folder of artifacts, and somebody still has to sit down
 * and write the ticket. That takes ten minutes per defect, every defect, and it
 * is the step most likely to be skipped when the sprint is tight — which is how
 * real bugs end up as a line in a report nobody actions.
 *
 * Three things decide whether the output is trusted (VISION §13b):
 *
 *  1. **Deduplicate by fingerprint.** Forty runs against one real bug must
 *     produce one report with fresh evidence appended. Forty tickets gets the
 *     system switched off in week two, and rightly.
 *
 *  2. **Reproduction steps come from the replayable trace, not the mission.**
 *     The mission says what we meant to do; the trace says what actually
 *     happened, including the locator that actually resolved. Only one of those
 *     reproduces the bug on someone else's machine.
 *
 *  3. **Nothing is filed automatically.** Everything here is a *candidate*
 *     until a human confirms it at Gate 2. §13a is the reason: the agent that
 *     just failed is the least reliable narrator of why.
 */

export type DefectSeverity = 'blocker' | 'critical' | 'major' | 'minor' | 'trivial';

export interface EvidenceRef {
  kind: 'screenshot' | 'trace' | 'log' | 'snapshot' | 'other';
  path: string;
  note?: string;
}

export interface DefectCandidate {
  fingerprint: string;
  title: string;
  source: 'mission' | 'exploration';
  status: 'candidate' | 'confirmed' | 'rejected' | 'duplicate';
  severity: DefectSeverity;
  test_id?: string;
  requirement_ref?: Record<string, unknown>;
  environment: {
    url: string;
    build?: string;
    browser?: string;
    role?: string;
    run_id?: string;
    observed_at?: string;
  };
  summary: string;
  preconditions?: string[];
  steps_to_reproduce: string[];
  expected: string;
  actual: string;
  evidence?: EvidenceRef[];
  classification?: {
    failure_classification?: string;
    confidence?: string;
    rationale?: string[];
  };
  rests_on_assumption?: boolean;
  first_seen: string;
  last_seen?: string;
  occurrences: number;
  seen_in_builds?: string[];
  human_review?: Record<string, unknown>;
}

// --- Fingerprinting ---------------------------------------------------------

/**
 * Strip everything run-specific from a message so the same bug hashes the same
 * way twice.
 *
 * Without this, a run id or a timestamp in the error text makes every run a new
 * defect — which looks exactly like deduplication being broken, because it is.
 */
// eslint-disable-next-line no-control-regex -- matching ANSI escapes requires them
const ANSI = /\[[0-9;]*m/g;

function normalise(text: string): string {
  return text
    // Playwright colourises its expectation failures when it thinks a terminal
    // is attached and does not when it does not. The same assertion failing the
    // same way in two runs therefore produced two fingerprints and two reports
    // for one defect — invisible in the rendered output, since the escapes do
    // not print.
    .replace(ANSI, '')
    .toLowerCase()
    .replace(/\b[0-9a-f]{8,}\b/g, '<hex>')
    .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z?\b/g, '<time>')
    .replace(/\b\d+\s*ms\b/g, '<ms>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/https?:\/\/[^\s)"']+/g, (u) => {
      try {
        return new URL(u).pathname;
      } catch {
        return '<url>';
      }
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

export function fingerprint(parts: (string | undefined)[]): string {
  const material = parts.filter(Boolean).map((p) => normalise(String(p))).join('|');
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
}

// --- Severity ---------------------------------------------------------------

/**
 * A proposal, never a verdict.
 *
 * Deliberately conservative: a P0 mission failing is critical, but nothing here
 * ever proposes `blocker`. Calling something a blocker is a release decision,
 * and this has no idea what is shipping tomorrow.
 */
function proposeSeverity(mission: TestMission, result: ExecutionResult): DefectSeverity {
  if (result.status === 'BLOCKED' || result.status === 'INCONCLUSIVE') return 'minor';
  const critical = (result.assertion_results ?? []).some((a) => !a.passed && a.critical);
  if (mission.priority === 'P0') return critical ? 'critical' : 'major';
  if (mission.priority === 'P1') return critical ? 'major' : 'minor';
  return 'minor';
}

// --- Reproduction -----------------------------------------------------------

/**
 * Reproduction steps from the trace.
 *
 * Falls back to the executed steps, and then to the mission, each of which is
 * one step further from what actually happened. The fallback is flagged in the
 * rendered report rather than silently used, because "these steps are what we
 * intended, not what ran" changes how much a developer should trust them.
 */
function reproductionSteps(mission: TestMission, result: ExecutionResult): string[] {
  const trace = result.replayable_trace?.steps ?? [];

  if (trace.length > 0) {
    return trace.map((s, i) => {
      const bits: string[] = [`${i + 1}. ${s.action}`];
      if (s.url) bits.push(`→ ${s.url}`);
      if (s.locator) bits.push(`on \`${s.locator}\``);
      if (s.value !== undefined && s.value !== '') bits.push(`with "${s.value}"`);
      return bits.join(' ');
    });
  }

  const executed = (result.steps_executed ?? []).filter((s) => s.outcome !== 'SKIPPED');
  if (executed.length > 0) {
    return executed.map(
      (s, i) =>
        `${i + 1}. ${s.instruction}${s.resolved_locator ? ` (resolved to \`${s.resolved_locator}\`)` : ''}` +
        `${s.outcome === 'FAILED' ? '  ← failed here' : ''}`,
    );
  }

  return mission.actions.map((a, i) => `${i + 1}. ${a.instruction}`);
}

function classifyEvidence(p: string): EvidenceRef['kind'] {
  if (/\.png$|\.jpe?g$/i.test(p)) return 'screenshot';
  if (/trace.*\.zip$/i.test(p)) return 'trace';
  if (/\.log$/i.test(p)) return 'log';
  if (/snapshot.*\.ya?ml$/i.test(p)) return 'snapshot';
  return 'other';
}

// --- Building from a run ----------------------------------------------------

export function fromExecution(
  mission: TestMission,
  result: ExecutionResult,
  baseUrl?: string,
): DefectCandidate | undefined {
  // A pass is not a defect, and a BLOCKED run usually means the environment or
  // the test data, not the product. Raising those as bugs is how a developer
  // learns to ignore this queue.
  if (result.status === 'PASS') return undefined;

  const failed = (result.assertion_results ?? []).filter((a) => !a.passed);
  const firstFailed = failed[0];
  const failedStep = (result.steps_executed ?? []).find((s) => s.outcome === 'FAILED');

  const now = new Date().toISOString();
  const what = firstFailed?.statement ?? failedStep?.instruction ?? mission.test_objective;

  const title = `[${mission.feature}] ${what.replace(/\.$/, '')}`;

  return {
    fingerprint: fingerprint([
      mission.test_id,
      firstFailed?.id ?? failedStep?.index?.toString(),
      result.failure_kind,
      firstFailed?.error ?? failedStep?.error ?? result.actual.join(' '),
    ]),
    title: title.length > 120 ? `${title.slice(0, 117)}...` : title,
    source: 'mission',
    status: 'candidate',
    severity: proposeSeverity(mission, result),
    test_id: mission.test_id,
    ...(mission.requirement_ref ? { requirement_ref: mission.requirement_ref } : {}),
    environment: {
      url: result.replayable_trace?.steps?.find((s) => s.url)?.url ?? baseUrl ?? mission.starting_context.page,
      build: result.build ?? RUNTIME.build,
      browser: RUNTIME.browser,
      role: mission.role,
      run_id: result.run_id,
      observed_at: result.finished_at ?? now,
    },
    summary:
      `${mission.test_objective} ` +
      (result.status === 'FAIL'
        ? 'The application did not behave as the requirement describes.'
        : `The run ended ${result.status} rather than passing.`) +
      (result.replay?.attempted
        ? result.replay.agrees_with_first_run
          ? ' A deterministic replay reproduced it identically, so this is not flakiness.'
          : ' A replay DISAGREED with the first run — treat this as unconfirmed until it reproduces.'
        : ''),
    preconditions: mission.preconditions,
    steps_to_reproduce: reproductionSteps(mission, result),
    expected: result.expected.join('\n') || mission.test_objective,
    /**
     * Prefer what the assertion actually observed.
     *
     * `result.actual` is often the terse one-liner ("A1: expectation did not
     * hold"), which tells a developer nothing they can act on. The assertion's
     * own `observed`/`error` carries the values that differed — and a defect
     * report whose Actual section does not say what was actually there is the
     * one that comes back as "cannot reproduce".
     */
    actual: [firstFailed?.observed, firstFailed?.error, failedStep?.error]
      .filter((t): t is string => Boolean(t && t.trim()))
      .filter((t, i, all) => all.indexOf(t) === i)
      .join('\n\n') ||
      result.actual.join('\n') ||
      'No detail recorded.',
    evidence: (result.evidence ?? []).map((p) => ({ kind: classifyEvidence(p), path: p })),
    classification: {
      ...(result.failure_classification ? { failure_classification: result.failure_classification } : {}),
      ...(result.confidence ? { confidence: result.confidence } : {}),
      ...(result.classification_rationale?.length ? { rationale: result.classification_rationale } : {}),
    },
    ...(mission.binding?.rests_on_assumption ? { rests_on_assumption: true } : {}),
    first_seen: now,
    last_seen: now,
    occurrences: 1,
    seen_in_builds: [result.build ?? RUNTIME.build],
  };
}

/**
 * Findings nobody wrote a test for.
 *
 * These arrive from ambient observation and sweeps (§7b) and they are the ones
 * a scripted suite structurally cannot find. They carry no reproduction steps
 * beyond "open the page", and pretending otherwise would be padding.
 */
/**
 * What makes a finding *this* finding.
 *
 * Fingerprinting on (kind, summary, page url) looked right and was badly wrong:
 * one broken logo in the site header produced three separate defect reports —
 * one per page it appeared on, plus another from the mission that walked past
 * it, because the two code paths word the summary differently. Six requirements
 * across a dozen pages each would have buried the queue in copies of a handful
 * of real problems.
 *
 * The identity of a broken image is the image. The identity of a dead link is
 * the link. Neither is the page you happened to be standing on when you noticed,
 * and neither is the sentence the code used to describe it. So when a finding
 * names a resource, that resource *is* the identity — which also makes the same
 * defect seen by a sweep and by ambient observation collapse into one report,
 * as it should.
 *
 * The exception is input validation, where the page genuinely is part of the
 * identity: an "Email" field on the sign-up form and an "Email" field on the
 * profile form are different fields with different rules.
 */
function findingIdentity(
  finding: NonNullable<ExecutionResult['incidental_findings']>[number],
  url: string,
): (string | undefined)[] {
  const resource = `${finding.detail ?? ''} ${finding.summary}`.match(/https?:\/\/[^\s)"']+/)?.[0];
  if (resource) return [finding.kind, resource];
  if (finding.kind === 'input_unvalidated') return [finding.kind, finding.summary, url];
  // No resource named: identify by the element itself, not by where it was
  // seen. A nav control missing its label is one defect, not one per page.
  return [finding.kind, finding.summary, finding.detail];
}

export function fromFinding(
  finding: NonNullable<ExecutionResult['incidental_findings']>[number],
  context: { url?: string; build?: string; run_id?: string; feature?: string },
): DefectCandidate {
  const now = new Date().toISOString();
  const url = finding.url ?? context.url ?? '(unknown page)';

  return {
    fingerprint: fingerprint(findingIdentity(finding, url)),
    title: `[${context.feature ?? 'exploration'}] ${finding.summary}`.slice(0, 120),
    source: 'exploration',
    status: 'candidate',
    severity: finding.severity === 'high' ? 'major' : finding.severity === 'medium' ? 'minor' : 'trivial',
    environment: {
      url,
      build: context.build ?? RUNTIME.build,
      browser: RUNTIME.browser,
      run_id: context.run_id,
      observed_at: now,
    },
    summary:
      `${finding.summary}\n\n` +
      'Nobody wrote a test case for this. It was noticed while walking the page during ' +
      'another test, which is the only reason it is here at all.' +
      (finding.count > 1 ? ` Seen ${finding.count} times in one run.` : ''),
    steps_to_reproduce: [`1. Open ${url}`, '2. Observe the behaviour described above.'],
    expected: 'Not stated by any requirement — this is an observation, and someone who knows the product must decide whether it is a defect.',
    actual: finding.detail ?? finding.summary,
    first_seen: now,
    last_seen: now,
    occurrences: 1,
    seen_in_builds: [context.build ?? RUNTIME.build],
  };
}

// --- Store, with deduplication ---------------------------------------------

export interface MergeResult {
  candidate: DefectCandidate;
  isNew: boolean;
}

function storePath(fp: string): string {
  return path.join(PATHS.defects, `${fp}.json`);
}

/**
 * Save, merging into an existing report when the fingerprint matches.
 *
 * A repeat is not a new defect. It is the same defect with one more sighting
 * and possibly better evidence, and a human who already triaged it should not
 * be asked again.
 */
export function upsert(candidate: DefectCandidate): MergeResult {
  fs.mkdirSync(PATHS.defects, { recursive: true });
  const file = storePath(candidate.fingerprint);

  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
    return { candidate, isNew: true };
  }

  const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as DefectCandidate;
  const merged: DefectCandidate = {
    ...existing,
    last_seen: candidate.last_seen ?? candidate.first_seen,
    occurrences: existing.occurrences + 1,
    seen_in_builds: Array.from(new Set([...(existing.seen_in_builds ?? []), ...(candidate.seen_in_builds ?? [])])),
    // Newer evidence is better evidence — it is from the run the reader just did.
    evidence: candidate.evidence?.length ? candidate.evidence : existing.evidence,
    environment: { ...existing.environment, ...candidate.environment },
    // A human decision is never overwritten by a machine seeing it again.
    ...(existing.human_review ? { human_review: existing.human_review, status: existing.status } : {}),
  };

  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return { candidate: merged, isNew: false };
}

export function listDefects(): DefectCandidate[] {
  if (!fs.existsSync(PATHS.defects)) return [];
  return fs
    .readdirSync(PATHS.defects)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(PATHS.defects, f), 'utf8')) as DefectCandidate)
    .sort((a, b) => (b.last_seen ?? b.first_seen).localeCompare(a.last_seen ?? a.first_seen));
}

// --- Rendering --------------------------------------------------------------

const SEVERITY_NOTE: Record<DefectSeverity, string> = {
  blocker: 'Nothing else can proceed.',
  critical: 'A P0 scenario does not work.',
  major: 'A required behaviour is wrong.',
  minor: 'Works, but not as described.',
  trivial: 'Cosmetic or low impact.',
};

/**
 * The report a human pastes into the tracker.
 *
 * Written so it can be handed to a developer unedited: what broke, where, how
 * to see it yourself, and what should have happened instead. The honesty
 * markers stay in — an unconfirmed replay or an assumed requirement changes how
 * a developer should read the whole thing, and burying that to make the ticket
 * look tidier would be the wrong trade.
 */
export function renderDefect(d: DefectCandidate): string {
  const L: string[] = [];

  L.push(`# ${d.title}`);
  L.push('');

  if (d.status === 'candidate') {
    L.push('> **Not yet confirmed.** Produced automatically from a test run and waiting on a');
    L.push('> human at Gate 2. Read it before it goes to anyone.');
    L.push('');
  }

  if (d.rests_on_assumption) {
    L.push('> ⚠ **This test asserted an assumed rule, not a confirmed one.** The expected');
    L.push('> behaviour below came from an assumption recorded in the clarification ledger.');
    L.push('> Check the assumption before raising this as a defect — the product may be right.');
    L.push('');
  }

  if (d.source === 'exploration') {
    L.push('> Found by exploration, not by a test case. No requirement covers it, so whether');
    L.push('> it is a defect is a product judgement.');
    L.push('');
  }

  L.push('| | |');
  L.push('|---|---|');
  L.push(`| **Severity** | ${d.severity} — ${SEVERITY_NOTE[d.severity]} |`);
  if (d.test_id) L.push(`| **Test** | ${d.test_id} |`);
  L.push(`| **Environment** | ${d.environment.url} |`);
  if (d.environment.build) L.push(`| **Build** | ${d.environment.build} |`);
  if (d.environment.browser) L.push(`| **Browser** | ${d.environment.browser} |`);
  if (d.environment.role) L.push(`| **Role** | ${d.environment.role} |`);
  if (d.environment.observed_at) L.push(`| **Observed** | ${d.environment.observed_at} |`);
  if (d.occurrences > 1) {
    L.push(`| **Seen** | ${d.occurrences} times, builds: ${(d.seen_in_builds ?? []).join(', ')} |`);
  }
  if (d.requirement_ref?.locator) {
    L.push(`| **Requirement** | ${String(d.requirement_ref.locator)} |`);
  }
  L.push('');

  L.push('## Summary', '', d.summary, '');

  if (d.requirement_ref?.quote) {
    L.push('## What the requirement says', '', `> ${String(d.requirement_ref.quote)}`, '');
  }

  if (d.preconditions?.length) {
    L.push('## Preconditions', '');
    for (const p of d.preconditions) L.push(`* ${p}`);
    L.push('');
  }

  L.push('## Steps to reproduce', '');
  for (const s of d.steps_to_reproduce) L.push(s);
  L.push('');

  L.push('## Expected', '', d.expected, '');
  L.push('## Actual', '', '```', d.actual, '```', '');

  if (d.evidence?.length) {
    L.push('## Evidence', '');
    for (const e of d.evidence) {
      const hint =
        e.kind === 'trace'
          ? ' — open with `npx playwright show-trace <path>`; it replays the run without re-running it'
          : '';
      L.push(`* **${e.kind}** \`${e.path}\`${hint}`);
    }
    L.push('');
  }

  if (d.classification?.failure_classification) {
    L.push('## Automated classification', '');
    L.push(
      `\`${d.classification.failure_classification}\`` +
        (d.classification.confidence ? ` (confidence ${d.classification.confidence})` : ''),
    );
    L.push('');
    for (const r of d.classification.rationale ?? []) L.push(`* ${r}`);
    L.push('');
    L.push(
      '_Proposed by the classifier, which did not run the test — deliberately, because an_',
      '_agent that just failed is the least reliable narrator of why. A human decides._',
      '',
    );
  }

  L.push('---', '');
  L.push(`_Fingerprint \`${d.fingerprint}\` — a repeat of this defect updates this report rather than raising another._`);
  L.push('');

  return L.join('\n');
}

/** Write the paste-ready markdown next to the JSON. */
export function writeReport(d: DefectCandidate): string {
  fs.mkdirSync(PATHS.defects, { recursive: true });
  const file = path.join(PATHS.defects, `${d.fingerprint}.md`);
  fs.writeFileSync(file, renderDefect(d), 'utf8');
  return rel(file);
}
