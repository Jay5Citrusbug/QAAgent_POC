import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';
import type { Change } from './build-diff.js';
import type { ProbeReport } from './probe.js';
import type { SweepOutcome } from './sweeps.js';

/**
 * Exploration findings, in a form the defect pipeline can read.
 *
 * `npm run explore` used to produce a markdown report and nothing else, which
 * meant every sweep offender and every probe observation died in a file. Since
 * finding bugs nobody wrote a test case for is the entire justification for
 * §7b, a finding with no route to a ticket is the feature not working.
 *
 * The split is deliberate and stays: **exploration produces observations, the
 * defect pipeline produces candidates, a human produces defects.** Explore does
 * not write into reports/defects/ itself — it writes what it saw, and
 * `npm run defects -- --from-exploration` decides what is worth writing up.
 *
 * The shape matches `ExecutionResult.incidental_findings` on purpose, so a
 * finding noticed during a mission and one noticed by a standalone sweep travel
 * the same path and deduplicate against each other. The same broken image seen
 * both ways is one defect, not two.
 */

export interface ExplorationFinding {
  kind: string;
  severity: 'high' | 'medium' | 'low';
  summary: string;
  detail?: string;
  url?: string;
  count: number;
}

export interface ExplorationReport {
  feature: string;
  build: string;
  generated_at: string;
  findings: ExplorationFinding[];
}

/**
 * Sweep offenders become findings; unverified results never do.
 *
 * "Unverified" means the sweep could not decide — a lazy image that had not
 * loaded, a link that timed out. Raising those as defects is exactly the
 * crying-wolf that gets a check muted, and a muted check is worse than no check.
 */
const SWEEP_SEVERITY: Record<string, ExplorationFinding['severity']> = {
  'images load': 'medium',
  'controls named': 'low',
  'fields labelled': 'low',
  'names unique': 'low',
  'links answer': 'high',
};

const SWEEP_KIND: Record<string, string> = {
  'images load': 'broken_image',
  'controls named': 'unlabelled_control',
  'fields labelled': 'unlabelled_field',
  'names unique': 'duplicate_accessible_name',
  'links answer': 'dead_link',
};

/**
 * How each offender reads as a defect title.
 *
 * The sweep name is internal vocabulary. "names unique: a 'cart'" is precise
 * and unreadable; a developer scanning a backlog needs a sentence that says
 * what is wrong. The title is the only part of a ticket most people read, so it
 * carries the whole message or the ticket gets skipped.
 */
const SWEEP_PHRASE: Record<string, (what: string) => string> = {
  'images load': (w) => `Image does not load: ${w}`,
  'controls named': (w) => `Control has no accessible name: ${w}`,
  'fields labelled': (w) => `Form field is not labelled: ${w}`,
  'names unique': (w) => `More than one control is named ${w}`,
  'links answer': (w) => `Link does not resolve: ${w}`,
};

export function findingsFromSweeps(
  url: string,
  results: { kind: string; outcome: SweepOutcome }[],
): ExplorationFinding[] {
  const out: ExplorationFinding[] = [];
  for (const { kind, outcome } of results) {
    for (const offender of outcome.offenders) {
      out.push({
        kind: SWEEP_KIND[kind] ?? 'sweep_offender',
        severity: SWEEP_SEVERITY[kind] ?? 'low',
        summary: (SWEEP_PHRASE[kind] ?? ((w: string) => `${kind}: ${w}`))(offender.what),
        detail: offender.detail,
        url,
        count: 1,
      });
    }
  }
  return out;
}

/**
 * Only the probe observations flagged notable.
 *
 * The rest are the literal truth about what happened and say nothing about
 * whether it was right — "the field accepted 300 characters" is not a defect
 * until someone who knows the product says so. Turning all of them into
 * candidates would bury the ones that matter under the ones that do not, which
 * is the same as not reporting any of them.
 */
export function findingsFromProbe(report: ProbeReport): ExplorationFinding[] {
  return report.observations
    .filter((o) => o.notable)
    .map((o) => ({
      kind: 'input_unvalidated',
      severity: 'medium' as const,
      summary: `"${o.input}" — ${o.trial}: ${o.observed}`,
      detail:
        'The field was given something it should arguably refuse and the page said nothing. ' +
        'Either validation is missing or it exists and communicates nothing — both are worth a look, ' +
        'and neither is confirmed until someone who knows the product decides.',
      url: report.url,
      count: 1,
    }));
}

/**
 * Almost nothing in a build diff is a defect.
 *
 * A removed control is usually a deliberate redesign, a renamed one usually a
 * copy change. Raising those as defects would flood the queue with every
 * intentional change the team made this sprint, and a queue full of noise stops
 * being read — which costs more than reporting nothing.
 *
 * One change is unambiguous: an image that loaded in the previous build and
 * does not load in this one. Nobody intends that. The rest stay in the
 * exploration report, where a human reads them as changes rather than faults.
 */
export function findingsFromDiff(changes: Change[]): ExplorationFinding[] {
  return changes
    .filter((c) => c.kind === 'image_broke')
    .map((c) => ({
      kind: 'image_regressed',
      severity: 'high' as const,
      summary: `Regression since the last build — ${c.summary}`,
      detail: c.detail,
      url: c.url,
      count: 1,
    }));
}

export function saveExploration(report: ExplorationReport): string {
  const dir = path.join(PATHS.reports, 'exploration');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = report.generated_at.replace(/[-:]/g, '').replace(/\..*$/, '');
  const file = path.join(dir, `${report.feature}-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return file;
}

export function listExplorations(feature?: string): ExplorationReport[] {
  const dir = path.join(PATHS.reports, 'exploration');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as ExplorationReport)
    .filter((r) => !feature || r.feature === feature);
}
