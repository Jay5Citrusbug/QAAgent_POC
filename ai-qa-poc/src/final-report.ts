import fs from 'node:fs';
import path from 'node:path';
import { PATHS, rel } from './config.js';
import { listDefects, renderDefect, type DefectCandidate } from './defect.js';
import { listIntents, readIntentFile } from './intents.js';
import { missionInFeature, readMissionFile } from './validate.js';
import type { ExecutionResult, TestIntent, TestMission } from './types.js';
import type { VerifyReport } from './verify.js';

/**
 * The report a human reads once a run is over, and the only artifact that has
 * to be honest about what did **not** happen.
 *
 * `npm run report` summarises the missions that ran. `npm run defects` writes
 * up each bug. Neither answers the question a QA Lead actually asks — *did we
 * test what we said we would?* — and after the first real run the answer was
 * no: 29 intents were approved, 3 became missions, 26 never executed at all.
 * Every existing artifact reported happily on the 3 and said nothing about the
 * 26, which is exactly how a suite comes to look more complete than it is.
 *
 * So this leads with the shortfall, then the results, then every defect in full
 * bug format with reproduction steps and evidence paths. It is generated
 * automatically at the end of every run, because a report somebody has to
 * remember to ask for is a report that stops being written.
 */

export interface FinalReportInput {
  feature?: string;
  results: ExecutionResult[];
  /** Pre-execution verification for this run; its held tests explain themselves. */
  verification?: VerifyReport;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function collectMissions(): TestMission[] {
  const out: TestMission[] = [];
  for (const dir of [PATHS.missionsApproved, PATHS.missionsDraft]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        out.push(readMissionFile(path.join(dir, f)));
      } catch {
        /* validate reports malformed files; this one just skips them */
      }
    }
  }
  return out;
}

/** The most recent reconciliation, which knows why an intent never bound. */
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

const STATUS_ORDER = ['FAIL', 'BLOCKED', 'INCONCLUSIVE', 'PASS'] as const;

export function buildFinalReport(input: FinalReportInput): string {
  const feature = input.feature ?? 'default';
  const results = input.results;
  const intents = listIntents(PATHS.intentsApproved)
    .map(readIntentFile)
    .filter((i) => i.feature === feature) as TestIntent[];
  const missions = collectMissions().filter((m) => missionInFeature(m, input.feature));
  const defects = listDefects();
  const recon = latestReconciliation(feature);

  const ranIds = new Set(results.map((r) => r.test_id));
  const neverRan = intents.filter((i) => !ranIds.has(i.test_id));

  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, INCONCLUSIVE: 0 } as Record<string, number>;
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;

  const L: string[] = [];
  const now = new Date().toISOString();

  L.push(`# Execution report — ${feature}`);
  L.push('');
  L.push(`Generated ${now}${results[0]?.build ? ` · build \`${results[0].build}\`` : ''}`);
  L.push('');

  // --- 1. The shortfall, first --------------------------------------------
  L.push('## 1. Did we test what we said we would?');
  L.push('');
  L.push('| | Count |');
  L.push('|---|---:|');
  L.push(`| Intents approved at Gate 2 | ${intents.length} |`);
  L.push(`| Became executable missions | ${missions.length} |`);
  if (input.verification) {
    const envDown = input.verification.issues.some((v) => v.severity === 'block' && !v.test_id);
    const heldCount = envDown ? neverRan.length : neverRan.filter((i) => input.verification!.held.includes(i.test_id)).length;
    L.push(`| Held back by pre-execution verification | ${heldCount} |`);
  }
  L.push(`| Actually executed | ${results.length} |`);
  L.push(`| **Never executed** | **${neverRan.length}** |`);
  L.push('');

  if (neverRan.length > 0) {
    const pct = Math.round((neverRan.length / Math.max(intents.length, 1)) * 100);
    L.push(
      `> **${neverRan.length} of ${intents.length} approved tests (${pct}%) did not run at all.** ` +
        'Everything below describes only the ones that did. Read this section before ' +
        'treating any pass rate below as a statement about the product.',
    );
    L.push('');
    L.push('These were approved, so a human agreed they were worth running. They did not');
    L.push('run because binding them to the live page failed, or because pre-execution');
    L.push('verification held them back — a gap in the tooling, the environment or how the');
    L.push('intent was written, not evidence about the application.');
    L.push('');
    L.push('| Test | Objective | Why it never ran |');
    L.push('|---|---|---|');
    for (const i of neverRan) {
      const entry = ((recon?.unbindable as { test_id: string; exceptions?: { kind: string }[] }[]) ?? []).find(
        (u) => u.test_id === i.test_id,
      );
      const kinds = entry?.exceptions?.map((e) => e.kind) ?? [];
      const heldBy = input.verification?.issues.find((v) => v.severity === 'block' && v.test_id === i.test_id);
      const envBlock = input.verification?.issues.find((v) => v.severity === 'block' && !v.test_id);
      const why = heldBy
        ? `held by verification: ${heldBy.check} — ${heldBy.message}`
        : envBlock
          ? `held by verification: ${envBlock.check} — ${envBlock.message}`
          : kinds.length
            ? `could not bind: ${Array.from(new Set(kinds)).join(', ')}`
            : 'no mission was produced';
      L.push(`| ${i.test_id} | ${escapePipes(i.test_objective)} | ${escapePipes(why)} |`);
    }
    L.push('');
  }

  // --- 2. What the executed ones said -------------------------------------
  L.push('## 2. Results of what did run');
  L.push('');
  if (results.length === 0) {
    L.push('_Nothing executed._');
    L.push('');
  } else {
    L.push(`| PASS | FAIL | BLOCKED | INCONCLUSIVE |`);
    L.push('|---:|---:|---:|---:|');
    L.push(`| ${counts.PASS ?? 0} | ${counts.FAIL ?? 0} | ${counts.BLOCKED ?? 0} | ${counts.INCONCLUSIVE ?? 0} |`);
    L.push('');
    L.push('| Test | Status | Classification | Confidence | Objective |');
    L.push('|---|---|---|---|---|');
    const sorted = [...results].sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.status as (typeof STATUS_ORDER)[number]) -
        STATUS_ORDER.indexOf(b.status as (typeof STATUS_ORDER)[number]),
    );
    for (const r of sorted) {
      L.push(
        `| ${r.test_id} | ${r.status} | ${r.failure_classification ?? '—'} | ${r.confidence} | ${escapePipes(r.test_objective ?? '')} |`,
      );
    }
    L.push('');
    L.push('A `BLOCKED` or `AGENT_EXECUTION_FAILURE` result says something went wrong with');
    L.push('the test, not with the product. Do not count those against the application.');
    L.push('');
  }

  // --- 3. Defects, in full bug format -------------------------------------
  const pending = defects.filter((d) => d.status === 'candidate');
  const confirmed = defects.filter((d) => d.status === 'confirmed');
  const rejected = defects.filter((d) => d.status === 'rejected');

  L.push('## 3. Defects');
  L.push('');
  L.push(`${defects.length} distinct candidate(s) — ${confirmed.length} confirmed, ${rejected.length} rejected, ${pending.length} awaiting Gate 3.`);
  L.push('');
  L.push('Nothing here has been filed anywhere. Each is written to be pasted into a');
  L.push('tracker once a human confirms it is real.');
  L.push('');

  if (defects.length > 0) {
    L.push('| Severity | Source | Seen | Title | Fingerprint |');
    L.push('|---|---|---:|---|---|');
    const rank = { blocker: 0, critical: 1, major: 2, minor: 3, trivial: 4 } as Record<string, number>;
    const ordered = [...defects].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
    for (const d of ordered) {
      L.push(
        `| ${d.severity} | ${d.source} | ${d.occurrences} | ${escapePipes(d.title)} | \`${d.fingerprint}\` |`,
      );
    }
    L.push('');

    L.push('---');
    L.push('');
    L.push('### Full reports');
    L.push('');
    L.push('Each of the following is complete enough to hand to a developer unedited —');
    L.push('reproduction steps come from the recorded trace of what actually happened,');
    L.push('not from what the test intended to do.');
    L.push('');
    for (const d of ordered) {
      L.push(renderDefect(d).replace(/^# /, '#### '));
      L.push('');
      L.push('---');
      L.push('');
    }
  }

  // --- 4. Evidence index ---------------------------------------------------
  L.push('## 4. Evidence');
  L.push('');
  if (results.length === 0) {
    L.push('_No runs, so no evidence._');
  } else {
    L.push('Every artifact from this run, by test. Open a `trace.zip` with');
    L.push('`npx playwright show-trace <path>` to replay the run without re-running it.');
    L.push('');
    for (const r of results) {
      L.push(`**${r.test_id}** — ${r.status}${r.run_id ? ` · run \`${r.run_id}\`` : ''}`);
      L.push('');
      if (!r.evidence?.length) {
        L.push('* _no evidence captured (the run passed, or failed before anything could be saved)_');
      } else {
        for (const e of r.evidence) L.push(`* \`${e}\``);
      }
      L.push('');
    }
  }

  // --- 5. What a human still has to do ------------------------------------
  L.push('## 5. Outstanding');
  L.push('');
  if (pending.length > 0) {
    L.push(`* **${pending.length} defect candidate(s) awaiting Gate 3.** Confirm or reject each:`);
    L.push('  ```');
    L.push(`  npm run defects -- --show <fingerprint>`);
    L.push(`  npm run defects -- --confirm <fingerprint> --by "<name>" --ticket <KEY>`);
    L.push('  ```');
  }
  if (neverRan.length > 0) {
    L.push(`* **${neverRan.length} approved test(s) still have no coverage of the product**, because they never ran.`);
    L.push('  Until they do, this feature is less tested than the intent count suggests.');
  }
  const assumed = intents.filter((i) => i.assumption);
  if (assumed.length > 0) {
    L.push(
      `* **${assumed.length} test(s) rest on an assumption** rather than a confirmed requirement ` +
        `(${assumed.map((i) => i.test_id).join(', ')}). A failure in any of them may mean the ` +
        'assumption was wrong rather than the product.',
    );
  }
  L.push('');

  return L.join('\n');
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|');
}

/**
 * One file per feature, rewritten in place — never a new timestamped file.
 *
 * A dated file per run meant a directory of near-identical reports where the
 * current one was whichever had the longest name, and the answer to "what is
 * the state of this feature" depended on picking the right file. There is only
 * ever one current answer, so there is only ever one file. The run history it
 * used to imply is kept properly in `runs/`, which is where it belongs.
 */
export function writeFinalReport(input: FinalReportInput): string {
  fs.mkdirSync(PATHS.reports, { recursive: true });
  const file = path.join(PATHS.reports, `EXECUTION-REPORT-${input.feature ?? 'default'}.md`);
  fs.writeFileSync(file, `${buildFinalReport(input)}\n`, 'utf8');
  return rel(file);
}
