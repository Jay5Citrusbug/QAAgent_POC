import type { CoverageCategory, TestIntent, TestMission } from './types.js';

/**
 * Coverage against the QA checklist.
 *
 * The purpose is not to produce a reassuring percentage. It is to make the
 * *absences* visible: a mission set that never considered security reads
 * identically to one where security was considered and ruled out, and that
 * ambiguity is where bugs escape.
 *
 * So every category is always listed, including the ones with nothing in them,
 * and the ones the executor cannot run are called out rather than quietly
 * counted as covered.
 */

export type Capability = 'automated' | 'partial' | 'manual';

export interface CategoryInfo {
  key: CoverageCategory;
  label: string;
  capability: Capability;
  /** Why it is limited — shown so nobody has to guess what "partial" means. */
  limit?: string;
}

export const CATEGORIES: CategoryInfo[] = [
  { key: 'requirement_based', label: 'Requirement-based', capability: 'automated' },
  { key: 'functional', label: 'Functional', capability: 'automated' },
  { key: 'negative', label: 'Negative', capability: 'automated' },
  { key: 'input_validation', label: 'Input validation', capability: 'automated' },
  { key: 'navigation', label: 'Navigation & flow', capability: 'automated' },
  {
    key: 'edge_case',
    label: 'Edge cases',
    capability: 'partial',
    limit: 'Long input and odd states yes; network loss and session expiry are not simulatable today.',
  },
  {
    key: 'ui_ux',
    label: 'UI / UX',
    capability: 'partial',
    limit: 'Structure and presence only. A white icon on a white background passes every DOM check there is.',
  },
  {
    key: 'data_integrity',
    label: 'Data integrity',
    capability: 'partial',
    limit: 'UI-visible state only — the executor cannot read the database to confirm what was actually stored.',
  },
  {
    key: 'error_handling',
    label: 'Error handling',
    capability: 'partial',
    limit: 'Error messages the UI already shows can be checked; inducing a server failure cannot.',
  },
  {
    key: 'security',
    label: 'Security',
    capability: 'partial',
    limit: 'Direct-URL access control is testable; session expiry and token handling largely are not.',
  },
  { key: 'api', label: 'API', capability: 'manual', limit: 'No HTTP client in the executor.' },
  {
    key: 'integration',
    label: 'Integration',
    capability: 'manual',
    limit: 'Needs API and UI compared in one assertion.',
  },
  {
    key: 'compatibility',
    label: 'Cross-browser',
    capability: 'manual',
    limit: 'POC-1 runs Chromium only.',
  },
  {
    key: 'responsive',
    label: 'Responsive / device',
    capability: 'manual',
    limit: 'No viewport matrix yet.',
  },
];

export interface CoverageRow {
  info: CategoryInfo;
  missions: string[];
  manualMissions: string[];
  /**
   * [R4] Approved intents in this category that are not yet bound to a mission.
   *
   * Deliberately a separate column rather than added to the mission count. An
   * intent is coverage that has been *designed*; until it is bound and run it
   * has proven nothing. Merging the two would let a feature with twenty intents
   * and no missions report full coverage, which is precisely the dishonesty
   * this report exists to prevent.
   */
  plannedIntents: string[];
}

export interface CoverageReport {
  rows: CoverageRow[];
  uncategorised: string[];
  totalMissions: number;
  totalIntents: number;
  /** Categories with no mission at all, split by whether that is fixable now. */
  gapsAutomatable: CategoryInfo[];
  gapsManualOnly: CategoryInfo[];
  /** Categories with nothing executable, but where an intent is already waiting. */
  gapsPlanned: CategoryInfo[];
}

export function buildCoverage(missions: TestMission[], intents: TestIntent[] = []): CoverageReport {
  const rows: CoverageRow[] = CATEGORIES.map((info) => ({
    info,
    missions: [],
    manualMissions: [],
    plannedIntents: [],
  }));
  const byKey = new Map(rows.map((r) => [r.info.key, r]));
  const uncategorised: string[] = [];

  for (const m of missions) {
    const category = m.coverage?.category;
    const row = category ? byKey.get(category) : undefined;
    if (!row) {
      uncategorised.push(m.test_id);
      continue;
    }
    if (m.coverage?.execution_mode === 'manual') row.manualMissions.push(m.test_id);
    else row.missions.push(m.test_id);
  }

  // An intent whose mission already exists is not "planned" any more — it is
  // counted above, and listing it twice would inflate the picture.
  const bound = new Set(missions.map((m) => m.test_id));
  for (const i of intents) {
    if (bound.has(i.test_id)) continue;
    const row = i.coverage?.category ? byKey.get(i.coverage.category) : undefined;
    if (!row) {
      uncategorised.push(i.test_id);
      continue;
    }
    row.plannedIntents.push(i.test_id);
  }

  const empty = rows.filter((r) => r.missions.length === 0 && r.manualMissions.length === 0);

  return {
    rows,
    uncategorised,
    totalMissions: missions.length,
    totalIntents: intents.length,
    gapsAutomatable: empty
      .filter((r) => r.info.capability !== 'manual' && r.plannedIntents.length === 0)
      .map((r) => r.info),
    gapsManualOnly: empty.filter((r) => r.info.capability === 'manual').map((r) => r.info),
    gapsPlanned: empty.filter((r) => r.plannedIntents.length > 0).map((r) => r.info),
  };
}

const MARK: Record<Capability, string> = {
  automated: 'automated',
  partial: 'partial   ',
  manual: 'manual    ',
};

export function renderCoverage(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push(
    `Coverage across ${report.totalMissions} mission(s)` +
      (report.totalIntents ? ` and ${report.totalIntents} approved intent(s)` : ''),
  );
  lines.push('');
  lines.push('  category              executable   missions / +intents');
  lines.push('  ' + '-'.repeat(62));

  for (const row of report.rows) {
    const ids = [
      ...row.missions,
      ...row.manualMissions.map((id) => `${id}*`),
      ...row.plannedIntents.map((id) => `+${id}`),
    ];
    const cell = ids.length ? ids.join(', ') : '— none —';
    lines.push(
      `  ${row.info.label.padEnd(21)} ${MARK[row.info.capability]}  ${cell}`,
    );
  }

  lines.push('');
  lines.push('  * = mission marked manual: a human runs it, the executor cannot.');
  if (report.totalIntents) {
    lines.push('  + = approved intent, not yet bound to a mission: designed, but it has proven nothing.');
  }

  if (report.uncategorised.length) {
    lines.push('');
    lines.push(`Uncategorised missions (no coverage.category): ${report.uncategorised.join(', ')}`);
    lines.push('  These count toward nothing. Add a category so the gaps below are honest.');
  }

  if (report.gapsAutomatable.length) {
    lines.push('');
    lines.push('GAPS WORTH CLOSING NOW — these categories are automatable and have no mission:');
    for (const g of report.gapsAutomatable) {
      lines.push(`  - ${g.label}${g.limit ? `  (${g.capability}: ${g.limit})` : ''}`);
    }
  }

  if (report.gapsPlanned.length) {
    lines.push('');
    lines.push('DESIGNED BUT NOT RUNNING — an intent covers these, but nothing executable does:');
    for (const g of report.gapsPlanned) {
      lines.push(`  - ${g.label}`);
    }
    lines.push('  Bind them against the build:  npm run bind -- --feature <feature> --write');
  }

  if (report.gapsManualOnly.length) {
    lines.push('');
    lines.push('GAPS NEEDING A HUMAN — the executor cannot cover these at all:');
    for (const g of report.gapsManualOnly) {
      lines.push(`  - ${g.label}: ${g.limit ?? ''}`);
    }
    lines.push('  Schedule these as manual work, or they simply do not happen.');
  }

  if (!report.gapsAutomatable.length && !report.gapsManualOnly.length && !report.gapsPlanned.length) {
    lines.push('');
    lines.push('Every category has at least one mission.');
  }

  lines.push('');
  lines.push(
    'A category with missions is not the same as a category well covered — this counts presence, not depth.',
  );

  return lines.join('\n');
}
