import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';
import type { ExecutionResult, Status } from './types.js';

/**
 * The Markdown summary a human reads at Gate 3.
 *
 * It is written for someone deciding whether to trust the run, so it leads with
 * what is not trustworthy: BLOCKED and INCONCLUSIVE come before failures, and
 * every failure shows its evidence paths and the classifier's reasoning rather
 * than just a verdict.
 */
export function buildReport(results: ExecutionResult[]): string {
  const counts: Record<Status, number> = { PASS: 0, FAIL: 0, BLOCKED: 0, INCONCLUSIVE: 0 };
  for (const r of results) counts[r.status] += 1;

  const first = results[0];
  const lines: string[] = [];

  lines.push('# Smoke Execution Report');
  lines.push('');
  lines.push(`* **Feature:** ${first?.feature ?? '—'}`);
  lines.push(`* **Environment:** ${first?.environment ?? '—'}`);
  lines.push(`* **Build:** ${first?.build ?? 'unknown'}`);
  lines.push(`* **Generated:** ${new Date().toISOString()}`);
  lines.push('');
  lines.push('| Total | PASS | FAIL | BLOCKED | INCONCLUSIVE |');
  lines.push('|---:|---:|---:|---:|---:|');
  lines.push(
    `| ${results.length} | ${counts.PASS} | ${counts.FAIL} | ${counts.BLOCKED} | ${counts.INCONCLUSIVE} |`,
  );
  lines.push('');

  // The headline is deliberately about trust, not about green counts.
  const untrustworthy = counts.BLOCKED + counts.INCONCLUSIVE;
  if (counts.FAIL === 0 && untrustworthy === 0 && results.length > 0) {
    lines.push('All missions passed with every critical assertion verified.');
  } else if (untrustworthy > 0) {
    lines.push(
      `> **${untrustworthy} mission(s) produced no usable verdict.** Treat this run as incomplete, ` +
        `not as a clean smoke result.`,
    );
  }
  lines.push('');

  const findingCount = results.reduce((n, r) => n + (r.incidental_findings?.length ?? 0), 0);
  if (findingCount > 0) {
    lines.push(
      `> **${findingCount} incidental finding(s)** were observed that no test case covers — see the section below. ` +
        `A run can be all-green and still have left these behind.`,
    );
    lines.push('');
  }

  lines.push('## Results');
  lines.push('');
  lines.push('| Test | Status | Classification | Confidence | Objective |');
  lines.push('|---|---|---|---|---|');
  for (const r of results) {
    lines.push(
      `| ${r.test_id} | ${r.status} | ${r.failure_classification ?? '—'} | ${r.confidence} | ${escapePipes(r.test_objective ?? r.feature ?? '')} |`,
    );
  }
  lines.push('');

  const needsAttention = results.filter((r) => r.status !== 'PASS');

  if (needsAttention.length > 0) {
    lines.push('## Needs human review');
    lines.push('');
    // BLOCKED/INCONCLUSIVE first: a reviewer should know what the run could not
    // tell them before reading what it claims to have found.
    const order: Status[] = ['BLOCKED', 'INCONCLUSIVE', 'FAIL'];
    const sorted = [...needsAttention].sort(
      (a, b) => order.indexOf(a.status) - order.indexOf(b.status),
    );

    for (const r of sorted) {
      lines.push(`### ${r.test_id} — ${r.status}`);
      lines.push('');
      if (r.requirement_ref) {
        const ref = r.requirement_ref as { locator?: string; quote?: string };
        lines.push(`**Requirement:** ${ref.locator ?? '—'}`);
        if (ref.quote) lines.push(`> ${ref.quote}`);
        lines.push('');
      }

      lines.push('**Expected**');
      lines.push('');
      for (const e of r.expected) lines.push(`* ${e}`);
      lines.push('');

      lines.push('**Actual**');
      lines.push('');
      for (const a of r.actual) lines.push(`* ${a}`);
      lines.push('');

      lines.push(
        `**Proposed classification:** ${r.failure_classification ?? '—'} ` +
          `(confidence ${r.confidence}, source: ${r.classification_source ?? 'none'})`,
      );
      lines.push('');
      if (r.classification_rationale?.length) {
        for (const why of r.classification_rationale) lines.push(`* ${why}`);
        lines.push('');
      }
      lines.push(
        '_This classification is a proposal. A human decides whether it is a defect; nothing here files one._',
      );
      lines.push('');

      if (r.replay?.attempted) {
        lines.push(`**Replay:** ${r.replay.note ?? ''}`);
        lines.push('');
      }

      const failedSteps = r.steps_executed.filter(
        (s) => s.outcome === 'FAILED' || s.outcome === 'TOLERATED_FAILURE',
      );
      if (failedSteps.length > 0) {
        lines.push('**Where it stopped**');
        lines.push('');
        for (const s of failedSteps) {
          lines.push(`* Step ${s.index} (${s.action}): ${s.instruction} — ${s.error ?? s.outcome}`);
        }
        lines.push('');
      }

      lines.push('**Evidence**');
      lines.push('');
      for (const e of r.evidence) lines.push(`* \`${e}\``);
      lines.push('');

      if (r.notes.length > 0) {
        lines.push('**Notes**');
        lines.push('');
        for (const n of r.notes) lines.push(`* ${n}`);
        lines.push('');
      }

      if (r.ai_analysis?.status === 'available') {
        lines.push('**AI execution analysis**');
        lines.push('');
        lines.push(`* **Likely cause:** ${r.ai_analysis.likely_cause ?? 'inconclusive'} (confidence ${r.ai_analysis.confidence ?? 'LOW'})`);
        if (r.ai_analysis.summary) lines.push(`* ${r.ai_analysis.summary}`);
        for (const fact of r.ai_analysis.evidence ?? []) lines.push(`* Evidence: ${fact}`);
        for (const check of r.ai_analysis.follow_up ?? []) lines.push(`* Follow-up: ${check}`);
        lines.push('');
        lines.push('_AI analysis is advisory. The deterministic result and human Gate 3 decision remain authoritative._');
        lines.push('');
      }
    }
  }

  const leftovers = results.flatMap((r) => r.artifacts_left_behind ?? []);
  if (leftovers.length > 0) {
    lines.push('## Left on STAGE');
    lines.push('');
    lines.push(
      'Cleanup is manual in POC-1. These are safe to delete — a name from a failed run may not exist at all:',
    );
    lines.push('');
    for (const a of leftovers) lines.push(`* ${a}`);
    lines.push('');
  }

  /**
   * Incidental findings get their own section, aggregated across every
   * mission. These are problems nobody wrote a test for — the report would be
   * dishonest without them, and dishonest in the worst direction: it would
   * read as "all green" while the page was throwing exceptions.
   */
  const findingMap = new Map<string, { f: NonNullable<ExecutionResult['incidental_findings']>[number]; seenIn: Set<string> }>();
  // Specificity decides which wording survives a merge: "image failed to load"
  // tells a human more than the console echo of the same 404.
  const SPECIFICITY: Record<string, number> = {
    page_exception: 0,
    broken_image: 1,
    http_error: 2,
    request_failed: 3,
    console_error: 4,
    unlabelled_control: 5,
  };
  for (const r of results) {
    for (const f of r.incidental_findings ?? []) {
      // Key on the resource when there is one, so the same broken file
      // reported by different missions and different signals collapses to a
      // single row. Ten rows for one missing PNG is how a findings list
      // becomes something people scroll past.
      const url = /https?:\/\/[^\s)'"]+/.exec(f.detail ?? '')?.[0];
      const key = url ?? `${f.kind}|${f.summary}|${f.detail ?? ''}`;
      const entry = findingMap.get(key);
      if (entry) {
        entry.f.count += f.count;
        entry.seenIn.add(r.test_id);
        if ((SPECIFICITY[f.kind] ?? 9) < (SPECIFICITY[entry.f.kind] ?? 9)) {
          entry.f.kind = f.kind;
          entry.f.summary = f.summary;
          entry.f.detail = f.detail;
        }
      } else {
        findingMap.set(key, { f: { ...f }, seenIn: new Set([r.test_id]) });
      }
    }
  }

  if (findingMap.size > 0) {
    const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const all = [...findingMap.values()].sort(
      (a, b) => (order[a.f.severity] ?? 3) - (order[b.f.severity] ?? 3),
    );

    lines.push('## Incidental findings — not part of any test case');
    lines.push('');
    lines.push(
      `${all.length} problem(s) were observed while running the missions above. **None of them changed any mission's result** — ` +
        'a mission answers the one question it was given. These are what the run noticed along the way, the way a tester ' +
        'notices a broken image while checking something else.',
    );
    lines.push('');
    lines.push('| Severity | What | Where | Seen in | Times |');
    lines.push('|---|---|---|---|---|');
    for (const { f, seenIn } of all) {
      const what = escapePipes(`${f.summary}${f.detail ? ` — ${f.detail}` : ''}`);
      lines.push(
        `| ${f.severity.toUpperCase()} | ${what} | ${escapePipes(f.url ?? '')} | ${[...seenIn].join(', ')} | ${f.count} |`,
      );
    }
    lines.push('');
    lines.push(
      '_Each of these is a candidate bug for a human to confirm. Nothing here has been filed._',
    );
    lines.push('');
  }

  lines.push('## Gate 3');
  lines.push('');
  lines.push('Nothing in this report is a confirmed defect, and no defect has been filed.');
  lines.push('');
  lines.push('For each row above, a human QA decides: confirmed defect, accepted failure, or retry.');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|').slice(0, 120);
}

export function writeReport(results: ExecutionResult[], name?: string): string {
  fs.mkdirSync(PATHS.reports, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const file = path.join(PATHS.reports, name ?? `smoke-${stamp}.md`);
  fs.writeFileSync(file, buildReport(results), 'utf8');
  return file;
}
