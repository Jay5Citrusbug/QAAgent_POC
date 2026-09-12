import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';
import type { ExecutionResult, Status } from './types.js';

/**
 * The Markdown summary a human reads at Gate 2.
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

  lines.push('## Gate 2');
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
