import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ROOT } from './config.js';
import { listDefects, type DefectCandidate } from './defect.js';
import { latestResult } from './healing.js';
import { loadFeedback } from './intent-approval.js';
import { isApproved, listIntents, readIntentFile } from './intents.js';
import type { ExecutionResult, TestIntent } from './types.js';
import { normalise, requirementSections } from './verify.js';

/**
 * The team's test case sheet, built from intents — so it exists before the
 * build does, which is when Gate 2 needs it.
 *
 * The column set is the team's, not ours, and is kept verbatim (including
 * "Verfied") so the sheet pastes into the existing workbook without remapping.
 *
 * Some columns belong to people: the Dev columns, the cross-browser tick and
 * QA Comment. Regenerating the sheet must never wipe them, so they are read
 * back from the previous sheet by Test Case ID and carried over. The rest is
 * derived and is rewritten on every build — edit the intent, not the cell.
 */

export const COLUMNS = [
  'Test Case ID',
  'Module',
  'FE/BE?',
  'Test Case Title',
  'Pre-Conditions',
  'Test Steps',
  'Test Data',
  'Expected Result',
  'Actual Result',
  'Dev Status',
  'Dev Date Executed',
  'Dev Notes',
  'QA Status',
  'cross browser Verfied ?',
  'QA Comment',
  // Added for formal sign-off. After the team's columns so the workbook's
  // existing column positions do not move.
  'Gate 2 Decision',
  'Requirement / AC Ref',
  'Priority',
  'Test Type',
  'Automation Status',
  'Approved By',
  'Approved Date',
  'Build / Environment',
  'Defect ID',
  'Evidence',
] as const;

type Column = (typeof COLUMNS)[number];
export type Row = Record<Column, string>;

/** Columns a person fills in. Carried across regenerations, never derived. */
const HUMAN: Column[] = ['Dev Status', 'Dev Date Executed', 'Dev Notes', 'cross browser Verfied ?', 'QA Comment', 'Gate 2 Decision'];

/**
 * The cells that ARE the test case. If a reviewer changes one of these in the
 * sheet, approving the row would approve text that is not in the test case
 * file — so `approve-sheet` compares them before it approves anything.
 */
export const CONTENT_COLUMNS = ['Module', 'FE/BE?', 'Test Case Title', 'Pre-Conditions', 'Test Steps', 'Test Data', 'Expected Result'] as const;

export function contentCells(intent: TestIntent): Record<(typeof CONTENT_COLUMNS)[number], string> {
  const pre = [`Actor: ${intent.actor}`, ...intent.preconditions];
  const data = (intent.test_data ?? []).map((d) => `${d.name}: ${d.description}`);
  const expected = intent.outcomes.map((o) => o.statement);
  if (intent.expected_outcome === 'blocked') expected.unshift('The system refuses the action.');
  return {
    Module: intent.module ?? intent.capability.split('.')[0] ?? '',
    'FE/BE?': layerOf(intent),
    'Test Case Title': intent.test_objective,
    'Pre-Conditions': numbered(pre),
    'Test Steps': numbered(intent.steps.map((s) => s.actor_intent)),
    'Test Data': data.length ? data.join('\n') : 'N/A',
    'Expected Result': numbered(expected),
  };
}

const TEST_TYPE: Record<string, string> = {
  negative: 'Negative',
  input_validation: 'Negative',
  edge_case: 'Boundary',
  security: 'Security',
  navigation: 'Navigation',
  data_integrity: 'Data integrity',
  error_handling: 'Error handling',
  ui_ux: 'UI/UX',
  api: 'API',
  integration: 'Integration',
  compatibility: 'Compatibility',
  responsive: 'Responsive',
  accessibility: 'Accessibility',
  performance: 'Performance',
};

function testTypeOf(intent: TestIntent): string {
  if (intent.expected_outcome === 'blocked') return 'Negative';
  return TEST_TYPE[intent.coverage.category] ?? 'Positive';
}

/**
 * The acceptance criterion the quote sits under, by the same matching
 * `npm run verify` uses — so the sheet and the traceability report agree.
 * `npm run story` writes AC headings as "PROJ-123 AC-2 — ...", so the part
 * before the dash is the reference people search Jira for.
 */
export function acRef(locator: string, quote: string | undefined, texts: Map<string, string>): string {
  const file = path.join(ROOT, locator);
  if (!texts.has(file)) texts.set(file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const q = quote ? normalise(quote) : '';
  if (q) {
    const hits = requirementSections(texts.get(file) ?? '').filter((s) =>
      normalise(`${s.heading}\n${s.body}`).includes(q),
    );
    const deepest = hits.sort((a, b) => b.level - a.level)[0];
    if (deepest) return deepest.heading.split(' — ')[0]!;
  }
  return locator;
}

function requirementRefOf(intent: TestIntent, texts: Map<string, string>): string {
  const ref = intent.requirement_ref;
  return ref ? acRef(ref.locator, ref.quote, texts) : 'NOT LINKED';
}

/** Confirmed tickets first, then candidates still waiting on Gate 3. Rejected ones are not defects. */
function defectIdsOf(testId: string, defects: DefectCandidate[]): string {
  return defects
    .filter((d) => d.test_id === testId && d.status !== 'rejected' && d.status !== 'duplicate')
    .map((d) => (d.human_review?.ticket ? String(d.human_review.ticket) : `${d.fingerprint} (pending review)`))
    .join('\n');
}

const STATUS_LABEL: Record<ExecutionResult['status'], string> = {
  PASS: 'Pass',
  FAIL: 'Fail',
  BLOCKED: 'Blocked',
  INCONCLUSIVE: 'Inconclusive',
};

export function featureSlug(intent: TestIntent): string {
  const named = intent.requirement_ref?.locator.match(/^input\/feature-([^/]+)\//);
  return named?.[1] ?? (intent.feature.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'default');
}

/** FE unless the case lives below the UI. An explicit `layer` always wins. */
function layerOf(intent: TestIntent): string {
  if (intent.layer) return intent.layer;
  const cats = [intent.coverage.category, ...(intent.coverage.secondary_categories ?? [])];
  return cats.includes('api') || cats.includes('integration') ? 'BE' : 'FE';
}

const numbered = (items: string[]): string => items.map((s, i) => `${i + 1}. ${s}`).join('\n');

interface Context {
  texts: Map<string, string>;
  defects: DefectCandidate[];
  feature: string;
  /** Test ids with an open Gate 2 rework request. */
  rework: Set<string>;
}

export type CaseState = 'draft' | 'approved' | 'rejected';

function toRow(intent: TestIntent, state: CaseState, ctx: Context): Row {
  const approved = state === 'approved';
  const latest = approved ? latestResult(intent.test_id) : undefined;
  const run = latest?.result;
  const manual = intent.coverage.execution_mode === 'manual';

  let actual = '';
  let qaStatus = approved
    ? 'Not Run'
    : state === 'rejected'
      ? 'Rejected at Gate 2'
      : ctx.rework.has(intent.test_id)
        ? 'Rework requested'
        : 'Draft - awaiting approval';
  if (run) {
    qaStatus = STATUS_LABEL[run.status];
    actual = [
      run.actual.join('\n'),
      run.ai_analysis?.likely_cause && run.status !== 'PASS' ? `Proposed cause: ${run.ai_analysis.likely_cause}` : '',
      run.run_id ? `Run: ${run.run_id}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return {
    'Test Case ID': intent.test_id,
    ...contentCells(intent),
    'Actual Result': actual,
    'Dev Status': '',
    'Dev Date Executed': '',
    'Dev Notes': '',
    'QA Status': qaStatus,
    'cross browser Verfied ?': run ? 'No (Chromium only)' : '',
    'QA Comment': manual ? `Manual: ${intent.coverage.manual_reason ?? 'not executable by the agent'}` : '',
    'Gate 2 Decision': '',
    'Requirement / AC Ref': requirementRefOf(intent, ctx.texts),
    Priority: intent.priority,
    'Test Type': testTypeOf(intent),
    'Automation Status': manual ? 'Manual' : intent.coverage.execution_mode === 'assisted' ? 'Assisted' : 'Automated',
    'Approved By': approved ? (intent.approval?.approved_by ?? '') : '',
    'Approved Date': approved ? (intent.approval?.approved_at ?? '').slice(0, 10) : '',
    'Build / Environment': run ? [run.build, run.environment].filter(Boolean).join(' / ') : '',
    'Defect ID': defectIdsOf(intent.test_id, ctx.defects),
    Evidence: latest
      ? [path.relative(ROOT, latest.dir), `reports/EXECUTION-REPORT-${ctx.feature}.html`].join('\n')
      : '',
  };
}

// --- CSV --------------------------------------------------------------------

function cell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** RFC 4180, enough to read back a sheet Excel has saved. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f !== ''));
}

/** What people typed into the previous sheet, by Test Case ID. */
function previousHumanCells(file: string): Map<string, Partial<Row>> {
  const out = new Map<string, Partial<Row>>();
  if (!fs.existsSync(file)) return out;
  const [header, ...rows] = parseCsv(fs.readFileSync(file, 'utf8'));
  if (!header) return out;
  const idCol = header.indexOf('Test Case ID');
  if (idCol === -1) return out;
  for (const r of rows) {
    const kept: Partial<Row> = {};
    for (const col of HUMAN) {
      const at = header.indexOf(col);
      if (at !== -1 && r[at]) kept[col] = r[at];
    }
    if (r[idCol]) out.set(r[idCol], kept);
  }
  return out;
}

export function sheetPath(feature: string): string {
  return path.join(PATHS.reports, `TEST-CASES-${feature}.csv`);
}

export interface SheetSummary {
  feature: string;
  file: string;
  total: number;
  draft: number;
  approved: number;
  rejected: number;
  carried: number;
}

/** Read a feature's sheet back as rows keyed by column name. */
export function readSheet(feature: string): { file: string; rows: Record<string, string>[] } | undefined {
  const file = sheetPath(feature);
  if (!fs.existsSync(file)) return undefined;
  const [header, ...rows] = parseCsv(fs.readFileSync(file, 'utf8'));
  if (!header) return { file, rows: [] };
  return { file, rows: rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))) };
}

/**
 * Build one sheet per feature from every draft, approved and rejected intent.
 * Rejected cases stay listed: the sheet is the Gate 2 record, and a case that
 * vanished from it would look like one nobody reviewed.
 */
export function buildSheets(onlyFeature?: string): SheetSummary[] {
  const byFeature = new Map<string, { intent: TestIntent; state: CaseState }[]>();
  const sources = [
    ...listIntents(PATHS.intentsDraft).map((f) => ({ f, state: 'draft' as CaseState })),
    ...listIntents(PATHS.intentsApproved).map((f) => ({ f, state: 'approved' as CaseState })),
    ...listIntents(PATHS.intentsRejected).map((f) => ({ f, state: 'rejected' as CaseState })),
  ];
  for (const { f, state } of sources) {
    let intent: TestIntent;
    try {
      intent = readIntentFile(f);
    } catch {
      continue; // validate reports malformed intents; the sheet shows readable ones.
    }
    const feature = featureSlug(intent);
    if (onlyFeature && feature !== onlyFeature) continue;
    const real: CaseState = state === 'approved' && !isApproved(intent) ? 'draft' : state;
    byFeature.set(feature, [...(byFeature.get(feature) ?? []), { intent, state: real }]);
  }

  fs.mkdirSync(PATHS.reports, { recursive: true });
  const defects = listDefects();
  const summaries: SheetSummary[] = [];
  for (const [feature, entries] of byFeature) {
    const file = sheetPath(feature);
    const previous = previousHumanCells(file);
    const rework = new Set(loadFeedback(feature).filter((r) => r.status === 'open').map((r) => r.test_id));
    const ctx: Context = { texts: new Map(), defects, feature, rework };
    let carried = 0;
    const rows = entries
      .sort((a, b) => a.intent.test_id.localeCompare(b.intent.test_id))
      .map(({ intent, state }) => {
        const row = toRow(intent, state, ctx);
        const kept = { ...previous.get(intent.test_id) };
        // A decision only means something on a draft still waiting for one.
        if (state !== 'draft' || rework.has(intent.test_id)) delete kept['Gate 2 Decision'];
        if (Object.keys(kept).length) {
          Object.assign(row, kept);
          carried++;
        }
        return row;
      });
    const lines = [COLUMNS.map(cell).join(','), ...rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(','))];
    // BOM so Excel opens it as UTF-8; CRLF between records, LF inside cells.
    fs.writeFileSync(file, `﻿${lines.join('\r\n')}\r\n`, 'utf8');
    summaries.push({
      feature,
      file,
      total: rows.length,
      draft: entries.filter((e) => e.state === 'draft').length,
      approved: entries.filter((e) => e.state === 'approved').length,
      rejected: entries.filter((e) => e.state === 'rejected').length,
      carried,
    });
  }
  return summaries;
}
