/**
 * Build the team's test case sheet (from intents, so it exists pre-build)
 * and the Markdown catalog of missions (once missions exist).
 *
 * This is deliberately derived from the JSON source of truth: humans read the
 * catalog, while the executor continues to consume validated missions.
 *
 *   npm run test-cases
 *   npm run test-cases -- --feature ecommerce
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, rel } from '../src/config.js';
import { buildSheets } from '../src/test-case-sheet.js';
import { readMissionFile } from '../src/validate.js';
import type { TestMission } from '../src/types.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function missionFiles(dir: string): { file: string; approved: boolean }[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ file: path.join(dir, file), approved: dir === PATHS.missionsApproved }));
}

function featureOf(mission: TestMission): string {
  const locator = mission.requirement_ref?.locator ?? '';
  const named = locator.match(/^input\/feature-([^/]+)\//);
  return named?.[1] ?? (mission.feature.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'default');
}

function kindOf(mission: TestMission): string {
  if (mission.coverage?.execution_mode === 'manual') return 'manual';
  if (mission.expected_outcome === 'blocked') return 'negative';
  const text = `${mission.test_objective} ${mission.requirement_ref?.quote ?? ''}`.toLowerCase();
  if (/refresh|repeat|empty|boundary|quantity|state|counter/.test(text)) return 'boundary/state';
  if (/navigate|route|link|destination/.test(text)) return 'navigation';
  if (/explor|visual|responsive|cross-browser/.test(text)) return 'exploratory';
  return 'positive';
}

function render(feature: string, missions: { mission: TestMission; approved: boolean }[]): string {
  const lines = [
    `# Test Case Catalog - ${feature}`,
    '',
    `Generated ${new Date().toISOString()}.`,
    '',
    'This is a reading view generated from the mission JSON files. The JSON files remain the execution source of truth.',
    '',
    `**Total:** ${missions.length}  `,
    `**Draft:** ${missions.filter((item) => !item.approved).length}  `,
    `**Approved:** ${missions.filter((item) => item.approved).length}`,
    '',
    '| ID | Priority | Module | Coverage | Kind | Mode | Status | Objective |',
    '|---|---|---|---|---|---|---|---|',
  ];

  for (const { mission, approved } of missions) {
    const escape = (value: string) => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    lines.push(
      `| ${mission.test_id} | ${mission.priority} | ${escape(mission.module)} | ${mission.coverage?.category ?? '—'} | ${kindOf(mission)} | ${mission.coverage?.execution_mode ?? 'automated'} | ${approved ? 'approved' : 'draft'} | ${escape(mission.test_objective)} |`,
    );
  }

  lines.push('', '## Detailed Cases', '');
  for (const { mission, approved } of missions) {
    lines.push(
      `### ${mission.test_id} - ${mission.test_objective}`,
      '',
      `- **Status:** ${approved ? 'approved' : 'draft'}`,
      `- **Priority:** ${mission.priority}`,
      `- **Module:** ${mission.module}`,
      `- **Capability:** ${mission.capability}`,
      `- **Coverage:** ${mission.coverage?.category ?? '—'} (${mission.coverage?.execution_mode ?? 'automated'})`,
      `- **Scenario kind:** ${kindOf(mission)}`,
      `- **Requirement:** ${mission.requirement_ref?.locator ?? 'not linked'}`,
      `- **Expected outcome:** ${mission.expected_outcome}`,
      '',
      '**Preconditions**',
      '',
      ...(mission.preconditions.length ? mission.preconditions.map((item) => `- ${item}`) : ['- None']),
      '',
      '**Actions**',
      '',
      ...mission.actions.map((action, index) => `${index + 1}. ${action.instruction}`),
      '',
      '**Assertions**',
      '',
      ...mission.assertions.map((assertion) => `- **${assertion.id}:** ${assertion.statement}`),
      '',
      '---',
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

const requestedFeature = arg('feature');
const grouped = new Map<string, { mission: TestMission; approved: boolean }[]>();
for (const entry of [...missionFiles(PATHS.missionsDraft), ...missionFiles(PATHS.missionsApproved)]) {
  try {
    const mission = readMissionFile(entry.file);
    const feature = featureOf(mission);
    if (requestedFeature && feature !== requestedFeature) continue;
    grouped.set(feature, [...(grouped.get(feature) ?? []), { mission, approved: entry.approved }]);
  } catch {
    // validate reports malformed mission files; the catalog only includes readable cases.
  }
}

// The team's sheet comes from intents, so it exists before the build does.
const sheets = buildSheets(requestedFeature);
for (const s of sheets) {
  const kept = s.carried ? `, kept human columns on ${s.carried}` : '';
  console.log(`Test case sheet:   ${rel(s.file)} (${s.total} cases: ${s.approved} approved, ${s.draft} draft${kept})`);
}

if (grouped.size === 0) {
  if (sheets.length === 0) {
    console.error('No readable intents or missions found.');
    process.exit(1);
  }
  process.exit(0); // Pre-build: no missions yet, and none expected.
}

fs.mkdirSync(PATHS.reports, { recursive: true });
for (const [feature, missions] of grouped) {
  const output = path.join(PATHS.reports, `test-cases-${feature}.md`);
  fs.writeFileSync(output, render(feature, missions.sort((a, b) => a.mission.test_id.localeCompare(b.mission.test_id))), 'utf8');
  console.log(`Test case catalog: ${rel(output)} (${missions.length} cases)`);
}
