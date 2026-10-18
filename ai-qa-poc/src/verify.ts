import fs from 'node:fs';
import path from 'node:path';
import { featurePaths, loadAppContext, PATHS, RUNTIME } from './config.js';
import { hashAnswer, loadLedger, type Ledger } from './clarifications.js';
import { latestCapture } from './captures.js';
import {
  approvalBlockers,
  hashIntent,
  isApproved as isIntentApproved,
  lintIntent,
  listIntents,
  readIntentFile,
  validateIntent,
} from './intents.js';
import { checkRequirementDrift, hashFile, localeFilePath } from './requirement-hash.js';
import { isApproved as isMissionApproved, missionInFeature, readMissionFile, validateMission } from './validate.js';
import type { AppContext, TestIntent, TestMission } from './types.js';

/**
 * Pre-execution verification — check the test cases before anything runs them.
 *
 * Test cases are written before the application exists: the requirement is all
 * there is, so nobody can look at a page first. That is correct, but it means
 * every test case carries assumptions nothing has checked yet. This is the
 * checkpoint that checks them, in two modes chosen by what exists:
 *
 *   pre-build   No front-end URL yet. The test cases are checked against the
 *               only source of truth there is — the requirement. Does each one
 *               cite a sentence that actually exists? Is every requirement
 *               section covered by at least one? Does any rest on an open
 *               question, or on an answer edited after approval?
 *
 *   live        A URL exists. Everything above, plus: is the environment up,
 *               was the capture taken from this environment and after the
 *               intents were approved, does every approved intent have an
 *               approved mission, has an intent changed since it was bound,
 *               does each mission's starting page load, is its role signed in?
 *
 * A `block` issue holds that test back from execution; a `warn` does not. A
 * held test is not a failed test — it is one that would have produced a result
 * nobody could trust, found before a browser run was paid for.
 */

export type Severity = 'block' | 'warn';

export interface VerifyIssue {
  /** Absent for feature-level issues (environment down, uncovered section). */
  test_id?: string;
  severity: Severity;
  check: string;
  message: string;
  fix?: string;
}

export interface VerifyReport {
  feature: string;
  mode: 'pre-build' | 'live';
  generated_at: string;
  base_url?: string;
  intents_checked: number;
  missions_checked: number;
  /** Requirement sections and the intents that cite them. */
  traceability: { section: string; intents: string[] }[];
  issues: VerifyIssue[];
  /** Approved missions cleared to execute. Live mode only. */
  ready: string[];
  /** Test ids with at least one blocking issue. */
  held: string[];
}

export interface VerifyOptions {
  feature?: string;
  /** Force pre-build mode even when a URL is configured. */
  offline?: boolean;
  /** Skip network calls (reachability, start pages) but keep the other live checks. */
  noNetwork?: boolean;
}

// --- helpers ----------------------------------------------------------------

/** Placeholder hosts written by `new-feature` when no --url was given. */
export function hasRealUrl(ctx: AppContext): boolean {
  const url = ctx.application.base_url ?? '';
  return /^https?:\/\//i.test(url) && !url.includes('example.com');
}

/** Compare prose loosely: markdown punctuation, quotes and whitespace are noise. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*_`>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Section {
  heading: string;
  body: string;
  level: number;
}

/**
 * Requirement sections a test case could cite.
 *
 * Headings the template itself writes for gaps and notes are left out: nobody
 * owes a test case for "Known gaps in this requirement".
 */
export function requirementSections(text: string): Section[] {
  const out: Section[] = [];
  let current: Section | undefined;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^(#{2,3})\s+(.*)$/.exec(line);
    if (m) {
      current = { heading: (m[2] ?? '').trim(), body: '', level: m[1]!.length };
      out.push(current);
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  return out.filter(
    (s) => s.body.trim().length > 0 && !/known gaps|open questions|notes?$|out of scope|glossary/i.test(s.heading),
  );
}

function featureIntents(feature: string): { intent: TestIntent; file: string; approvedDir: boolean }[] {
  const out: { intent: TestIntent; file: string; approvedDir: boolean }[] = [];
  for (const [dir, approvedDir] of [
    [PATHS.intentsDraft, false],
    [PATHS.intentsApproved, true],
  ] as const) {
    for (const file of listIntents(dir)) {
      try {
        const intent = readIntentFile(file);
        if (intent.feature === feature) out.push({ intent, file, approvedDir });
      } catch {
        out.push({ intent: { test_id: path.basename(file, '.json') } as TestIntent, file, approvedDir });
      }
    }
  }
  return out;
}

function approvedMissions(): { mission: TestMission; file: string }[] {
  if (!fs.existsSync(PATHS.missionsApproved)) return [];
  return fs
    .readdirSync(PATHS.missionsApproved)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const file = path.join(PATHS.missionsApproved, f);
      return { mission: readMissionFile(file), file };
    });
}

async function probeUrl(url: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
      // No keep-alive: an open socket at process.exit() aborts Node on Windows.
      headers: { connection: 'close' },
    });
    await res.body?.cancel();
    return { ok: res.status < 400, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- pre-build: test cases against the requirement ---------------------------

function checkIntents(feature: string, ledger: Ledger, issues: VerifyIssue[]) {
  const paths = featurePaths(feature);
  const requirementFile = path.join(paths.requirementDir, 'requirement.md');
  const requirementText = fs.existsSync(requirementFile) ? fs.readFileSync(requirementFile, 'utf8') : '';
  const docText = fs.existsSync(paths.documentationFile) ? fs.readFileSync(paths.documentationFile, 'utf8') : '';
  const answers = ledger.questions.map((q) => q.answer ?? '').join('\n');

  const sections = requirementSections(requirementText);
  const traceability = sections.map((s) => ({ section: s.heading, intents: [] as string[] }));

  const entries = featureIntents(feature);
  const seenObjectives = new Map<string, string>();

  for (const { intent, approvedDir } of entries) {
    const id = intent.test_id;
    const push = (severity: Severity, check: string, message: string, fix?: string) =>
      issues.push({ test_id: id, severity, check, message, ...(fix ? { fix } : {}) });

    const { valid, errors } = validateIntent(intent);
    if (!valid) {
      push('block', 'schema', `Does not match the intent schema: ${errors.slice(0, 3).join('; ')}`, 'npm run validate');
      continue;
    }

    if (approvedDir && !isIntentApproved(intent)) {
      push('block', 'approval', 'In intents/approved/ without an approval block.', `npm run approve-intent -- ${id} --by "<you>"`);
    }

    // Traceability: the cited sentence must exist. A test case citing a
    // sentence the requirement does not contain is testing a rule nobody wrote.
    const ref = intent.requirement_ref;
    if (!ref) {
      push('block', 'traceability', 'No requirement_ref — nothing ties this test case to the requirement.', 'Add requirement_ref with the locator and the exact sentence.');
    } else {
      const file = localeFilePath(ref.locator);
      if (ref.source === 'DOC' && !file) {
        push('block', 'traceability', `requirement_ref.locator "${ref.locator}" is not a file in this repository.`);
      }
      if (!ref.quote) {
        push('warn', 'traceability', 'requirement_ref has no quote, so the cited sentence cannot be verified.');
      } else {
        const q = normalise(ref.quote);
        const cited = file ? normalise(fs.readFileSync(file, 'utf8')) : '';
        const found = [cited, normalise(requirementText), normalise(docText), normalise(answers)].some((t) => t.includes(q));
        if (!found) {
          push(
            'block',
            'traceability',
            `The quoted sentence is not in the requirement, documentation or clarification answers: "${ref.quote.slice(0, 120)}"`,
            'Quote the requirement verbatim. If the behaviour is not written down anywhere, it is a gap to raise, not a test to write.',
          );
        } else {
          for (const [i, s] of sections.entries()) {
            if (normalise(`${s.heading}\n${s.body}`).includes(q)) traceability[i]!.intents.push(id);
          }
        }
      }

      // Requirement edited since approval.
      if (isIntentApproved(intent) && file && ref.content_hash && hashFile(file) !== ref.content_hash) {
        push('warn', 'requirement_drift', `${ref.locator} has changed since this intent was approved.`, 'Re-read it and re-approve if it still holds.');
      }
    }

    // Open or broken clarification dependencies.
    for (const b of approvalBlockers(intent, ledger)) push('block', 'clarification', b);

    // An answer edited after approval silently changes what the test proves.
    const pinned = intent.approval?.clarification_hashes ?? {};
    for (const [qid, recorded] of Object.entries(pinned)) {
      const q = ledger.questions.find((x) => x.id === qid);
      if (q && hashAnswer(q) !== recorded) {
        push('block', 'clarification', `The answer to ${qid} was changed after this intent was approved.`, `Re-read ${qid} and re-approve.`);
      }
    }

    // Duplicates that differ only in wording.
    const key = `${normalise(intent.test_objective)}|${intent.expected_outcome}`;
    const twin = seenObjectives.get(key);
    if (twin) push('warn', 'duplicate', `Same objective and expected outcome as ${twin}.`);
    else seenObjectives.set(key, id);

    // An automated intent must say something checkable happens.
    if (intent.coverage?.execution_mode !== 'manual' && !intent.outcomes.some((o) => o.critical !== false)) {
      push('block', 'observability', 'No critical outcome — nothing could make this test pass or fail.');
    }

    for (const w of lintIntent(intent, ledger)) push('warn', 'lint', w);
  }

  // A story heading is covered when any of its acceptance criteria is: nobody
  // owes a separate test for the overview paragraph of a covered story.
  sections.forEach((sec, i) => {
    if (traceability[i]!.intents.length) return;
    for (let j = i + 1; j < sections.length && sections[j]!.level > sec.level; j += 1) {
      for (const id of traceability[j]!.intents) {
        if (!traceability[i]!.intents.includes(id)) traceability[i]!.intents.push(id);
      }
    }
  });

  for (const t of traceability) {
    if (t.intents.length === 0) {
      issues.push({
        severity: 'warn',
        check: 'requirement_coverage',
        message: `Requirement section "${t.section}" is not cited by any test case.`,
        fix: 'Write a test case for it, or record why it needs none.',
      });
    }
  }

  return { traceability, count: entries.length };
}

// --- live: test cases against the application that shipped -------------------

async function checkLive(
  feature: string,
  ctx: AppContext,
  issues: VerifyIssue[],
  noNetwork: boolean,
): Promise<{ missions: { mission: TestMission; file: string }[] }> {
  const baseUrl = ctx.application.base_url;

  if (!noNetwork) {
    const probe = await probeUrl(baseUrl);
    if (!probe.ok) {
      issues.push({
        severity: 'block',
        check: 'environment',
        message: `${baseUrl} is not reachable (${probe.status ?? probe.error}). Every mission would report BLOCKED.`,
        fix: 'Check the URL and that the environment is up, then re-run verify.',
      });
    }
  }

  const intents = featureIntents(feature)
    .filter((e) => e.approvedDir && isIntentApproved(e.intent))
    .map((e) => e.intent);
  const byId = new Map(intents.map((i) => [i.test_id, i]));

  // The capture is what missions were bound against. If it is older than the
  // intents, or from another environment, the bindings describe a different page.
  const capture = latestCapture(feature);
  if (!capture) {
    // A warning, not a block: unbound intents are already held one by one
    // below, and hand-written missions never needed a capture.
    issues.push({
      severity: 'warn',
      check: 'capture',
      message: 'No page capture exists, so no intent can have been bound to the real application yet.',
      fix: `npm run inspect -- --feature ${feature}`,
    });
  } else {
    if (capture.base_url && capture.base_url.replace(/\/$/, '') !== baseUrl.replace(/\/$/, '')) {
      issues.push({
        severity: 'warn',
        check: 'capture',
        message: `The latest capture was taken from ${capture.base_url}, not ${baseUrl}.`,
        fix: `npm run inspect -- --feature ${feature}  then  npm run bind -- --feature ${feature} --write`,
      });
    }
    const newest = intents.map((i) => i.approval?.approved_at ?? '').sort().pop();
    if (newest && newest > capture.captured_at) {
      issues.push({
        severity: 'warn',
        check: 'capture',
        message: `Intents were approved after the latest capture (${capture.captured_at}); newer intents may not be bound.`,
        fix: `npm run bind -- --feature ${feature} --write`,
      });
    }
    if (RUNTIME.build !== 'unknown' && capture.build !== RUNTIME.build) {
      issues.push({
        severity: 'warn',
        check: 'capture',
        message: `Capture is of build ${capture.build}, but BUILD is ${RUNTIME.build}. The page may have changed since binding.`,
        fix: `npm run inspect -- --feature ${feature}`,
      });
    }
  }

  const missions = approvedMissions().filter(({ mission }) => missionInFeature(mission, feature === 'default' ? undefined : feature));
  const missionIds = new Set(missions.map((m) => m.mission.binding?.intent_ref ?? m.mission.test_id));

  // Approved intents with nothing to run.
  for (const i of intents) {
    if (i.coverage?.execution_mode === 'manual') continue;
    if (!missionIds.has(i.test_id)) {
      issues.push({
        test_id: i.test_id,
        severity: 'block',
        check: 'binding',
        message: 'Approved intent has no approved mission, so it cannot execute.',
        fix: `npm run bind -- --feature ${feature} --write  then  npm run approve -- ${i.test_id} --by "<you>"`,
      });
    }
  }

  const startPages = new Map<string, Promise<{ ok: boolean; status?: number; error?: string }>>();

  for (const { mission } of missions) {
    const id = mission.test_id;
    const push = (severity: Severity, check: string, message: string, fix?: string) =>
      issues.push({ test_id: id, severity, check, message, ...(fix ? { fix } : {}) });

    const { valid, errors } = validateMission(mission);
    if (!valid) push('block', 'schema', `Does not match the mission schema: ${errors.slice(0, 3).join('; ')}`);
    if (!isMissionApproved(mission)) push('block', 'approval', 'No approval block.');

    // The intent moved after binding.
    const b = mission.binding;
    if (b) {
      const intent = byId.get(b.intent_ref);
      if (!intent) {
        push('block', 'binding', `Bound from intent ${b.intent_ref}, which is no longer approved.`);
      } else if (b.intent_hash && b.intent_hash !== hashIntent(intent)) {
        push('block', 'binding', `Intent ${b.intent_ref} was edited after this mission was bound — the mission tests the old version.`, `npm run bind -- --feature ${feature} --write --force`);
      } else if (!b.intent_hash && intent.approval?.approved_at && intent.approval.approved_at > b.bound_at) {
        push('warn', 'binding', `Intent ${b.intent_ref} was re-approved after this mission was bound.`, 'Re-bind to be sure the mission matches it.');
      }
      if (capture && b.bound_against?.captured_at && b.bound_against.captured_at < capture.captured_at) {
        push('warn', 'binding', 'Bound against an older capture than the latest one. Controls may have moved.', `npm run bind -- --feature ${feature} --write --force`);
      }
      if (b.confidence === 'low') push('warn', 'binding', 'Binding confidence is low — watch this one at Gate 3.');
    }

    const drift = checkRequirementDrift(mission);
    if (drift.state === 'drifted') push('warn', 'requirement_drift', `${drift.locator} has changed since approval.`);

    // Role without a session would start BLOCKED.
    const ref = mission.auth?.strategy === 'storage_state' ? mission.auth.storage_state_ref : undefined;
    if (ref && !fs.existsSync(path.join(PATHS.auth, `${ref.toLowerCase()}.json`))) {
      push('block', 'session', `Role ${mission.role} has no signed-in session (.auth/${ref.toLowerCase()}.json).`, `npm run auth -- --role ${mission.role} --feature ${feature}`);
    }

    // The starting page must at least exist.
    if (!noNetwork && mission.starting_context.url_hint) {
      const url = new URL(mission.starting_context.url_hint, baseUrl).toString();
      if (!startPages.has(url)) startPages.set(url, probeUrl(url));
      const res = await startPages.get(url)!;
      if (!res.ok) {
        const auth = res.status === 401 || res.status === 403;
        push(auth ? 'warn' : 'block', 'start_page', `Starting page ${url} returned ${res.status ?? res.error}.`);
      }
    }
  }

  return { missions };
}

// --- entry point ------------------------------------------------------------

export async function verify(opts: VerifyOptions = {}): Promise<VerifyReport> {
  const feature = opts.feature ?? 'default';
  const ctx = loadAppContext(opts.feature);
  const ledger = loadLedger(opts.feature);
  const live = !opts.offline && hasRealUrl(ctx);

  const issues: VerifyIssue[] = [];
  const { traceability, count } = checkIntents(feature, ledger, issues);

  let missions: { mission: TestMission; file: string }[] = [];
  if (live) ({ missions } = await checkLive(feature, ctx, issues, Boolean(opts.noNetwork)));

  const envDown = issues.some((i) => !i.test_id && i.severity === 'block');
  const held = new Set(issues.filter((i) => i.test_id && i.severity === 'block').map((i) => i.test_id as string));
  const ready = envDown
    ? []
    : missions
        .map((m) => m.mission.test_id)
        // A mission is held if it, or the intent it was bound from, is blocked.
        .filter((id) => {
          const intentRef = missions.find((m) => m.mission.test_id === id)?.mission.binding?.intent_ref;
          return !held.has(id) && !(intentRef && held.has(intentRef));
        });

  return {
    feature,
    mode: live ? 'live' : 'pre-build',
    generated_at: new Date().toISOString(),
    ...(live ? { base_url: ctx.application.base_url } : {}),
    intents_checked: count,
    missions_checked: missions.length,
    traceability,
    issues,
    ready,
    held: [...held].sort(),
  };
}

export function renderVerification(r: VerifyReport): string {
  const L: string[] = [];
  const blocks = r.issues.filter((i) => i.severity === 'block');
  const warns = r.issues.filter((i) => i.severity === 'warn');

  L.push(`# Pre-execution verification — ${r.feature}`, '');
  L.push(`Generated ${r.generated_at} · mode **${r.mode}**${r.base_url ? ` · ${r.base_url}` : ''}`, '');
  L.push(
    r.mode === 'pre-build'
      ? 'No front-end URL yet, so the test cases were checked against the requirement: every cited sentence must exist, every requirement section must be cited, and nothing may rest on an open question.'
      : 'Checked against the requirement and against the running application before any mission executes.',
    '',
  );
  L.push('| | Count |', '|---|---:|');
  L.push(`| Intents checked | ${r.intents_checked} |`);
  if (r.mode === 'live') L.push(`| Approved missions checked | ${r.missions_checked} |`, `| **Cleared to execute** | **${r.ready.length}** |`);
  L.push(`| **Held back** | **${r.held.length}** |`, `| Blocking issues | ${blocks.length} |`, `| Warnings | ${warns.length} |`, '');

  const feature = r.issues.filter((i) => !i.test_id);
  if (feature.length) {
    L.push('## Feature-level', '');
    for (const i of feature) L.push(`* **${i.severity.toUpperCase()}** · ${i.check} — ${i.message}${i.fix ? `  \n  → \`${i.fix}\`` : ''}`);
    L.push('');
  }

  if (blocks.some((i) => i.test_id)) {
    L.push('## Held back — fix before execution', '');
    L.push('| Test | Check | Problem | Fix |', '|---|---|---|---|');
    for (const i of blocks.filter((x) => x.test_id)) L.push(`| ${i.test_id} | ${i.check} | ${esc(i.message)} | ${esc(i.fix ?? '')} |`);
    L.push('');
  }

  if (warns.some((i) => i.test_id)) {
    L.push('## Warnings — will run, worth a look', '');
    L.push('| Test | Check | Note |', '|---|---|---|');
    for (const i of warns.filter((x) => x.test_id)) L.push(`| ${i.test_id} | ${i.check} | ${esc(i.message)} |`);
    L.push('');
  }

  if (r.traceability.length) {
    L.push('## Requirement traceability', '');
    L.push('| Requirement section | Test cases |', '|---|---|');
    for (const t of r.traceability) L.push(`| ${esc(t.section)} | ${t.intents.length ? t.intents.join(', ') : '**none**'} |`);
    L.push('');
  }

  if (r.mode === 'live' && r.ready.length) L.push('## Cleared to execute', '', r.ready.join(', '), '');
  return L.join('\n');
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function writeVerification(r: VerifyReport): { md: string; json: string } {
  fs.mkdirSync(PATHS.reports, { recursive: true });
  const md = path.join(PATHS.reports, `VERIFICATION-${r.feature}.md`);
  const json = path.join(PATHS.reports, `verification-${r.feature}.json`);
  fs.writeFileSync(md, `${renderVerification(r)}\n`, 'utf8');
  fs.writeFileSync(json, `${JSON.stringify(r, null, 2)}\n`, 'utf8');
  return { md, json };
}
