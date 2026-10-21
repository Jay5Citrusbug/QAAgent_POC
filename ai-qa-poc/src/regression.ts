import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { featurePaths, PATHS, rel } from './config.js';
import type { DefectCandidate } from './defect.js';
import { listIntents, readIntentFile } from './intents.js';
import type { CoverageCategory, Observable, Priority, TestIntent } from './types.js';

/**
 * Confirmed defects become permanent tests.
 *
 * A bug a person confirmed at Gate 3 must never come back unnoticed. Two cases:
 *
 *  - A test case caught it. That test now guards the fix: it joins the
 *    feature's regression list, and `--regression` re-runs exactly that list
 *    (bug-fix verification, or a fast pre-release pass).
 *  - Nothing caught it on purpose (exploration, an automatic check, the access
 *    matrix). A draft regression test case is proposed from the defect's own
 *    steps. It goes through Gate 2 like any other: proposed, never approved here.
 */

export interface RegressionEntry {
  test_id: string;
  fingerprint: string;
  title: string;
  ticket?: string;
  added_at: string;
}

export function featureOfDefect(d: DefectCandidate): string | undefined {
  const locator = String(d.requirement_ref?.locator ?? '');
  return locator.match(/input\/feature-([^/]+)\//)?.[1] ?? d.title.match(/^\[([^\]]+)\]/)?.[1];
}

export function registryPath(feature: string): string {
  return path.join(featurePaths(feature).requirementDir, 'regression.yaml');
}

export function loadRegistry(feature: string): RegressionEntry[] {
  const file = registryPath(feature);
  if (!fs.existsSync(file)) return [];
  return ((YAML.parse(fs.readFileSync(file, 'utf8')) as { tests?: RegressionEntry[] } | null)?.tests ?? []);
}

/** Every test on any feature's regression list (or one feature's). */
export function regressionTestIds(feature?: string): Set<string> {
  const root = path.join(PATHS.root, 'input');
  const features = feature
    ? [feature]
    : fs.existsSync(root)
      ? fs.readdirSync(root).filter((d) => d.startsWith('feature-')).map((d) => d.slice('feature-'.length))
      : [];
  return new Set(features.flatMap((f) => loadRegistry(f).map((e) => e.test_id)));
}

function addToRegistry(feature: string, entry: RegressionEntry): void {
  const all = loadRegistry(feature).filter((e) => !(e.test_id === entry.test_id && e.fingerprint === entry.fingerprint));
  all.push(entry);
  const file = registryPath(feature);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# Tests guarding confirmed defects. Run them: npm run execution-agent -- --regression\n${YAML.stringify({ tests: all })}`, 'utf8');
}

/** What kind of problem a defect is, read from how its title is worded. */
function shapeOf(d: DefectCandidate): { category: CoverageCategory; statement: string; observable: Observable } {
  const t = `${d.title} ${d.summary}`;
  const page = (() => {
    try {
      return new URL(d.environment.url).pathname;
    } catch {
      return 'the page';
    }
  })();
  if (/Accessibility/i.test(t)) return { category: 'accessibility', statement: `The ${page} page is accessible (WCAG AA): ${d.summary.replace(/^Accessibility \(\w+\): /, '').split(' — ')[0]}`, observable: 'element_present' };
  if (/scrolls sideways|cut off|covered|tap target/i.test(t)) return { category: 'responsive', statement: `The ${page} page lays out soundly at this screen size`, observable: 'element_present' };
  if (/Looks different from the approved baseline/i.test(t)) return { category: 'ui_ux', statement: `The ${page} page looks as approved`, observable: 'element_present' };
  if (/can open .* which only/i.test(t)) return { category: 'security', statement: d.expected || `${d.summary.split(' can open ')[0]} is refused ${page}`, observable: 'access_denied' };
  if (/cookie|header|in the URL|mixed content/i.test(t)) return { category: 'security', statement: d.expected || d.summary, observable: 'element_present' };
  if (/Server response|Main content|Layout shift|Full page load/i.test(t)) return { category: 'performance', statement: d.expected || d.summary, observable: 'element_present' };
  if (/API|returned \d{3}|JSON/i.test(t)) return { category: 'api', statement: d.expected || d.summary, observable: 'api_response' };
  return { category: 'functional', statement: d.expected || `The problem no longer occurs: ${d.summary}`, observable: 'element_present' };
}

function nextId(feature: string): string {
  const mine = [PATHS.intentsDraft, PATHS.intentsApproved, PATHS.intentsRejected]
    .flatMap((dir) => listIntents(dir))
    .map((f) => {
      try {
        return readIntentFile(f);
      } catch {
        return undefined;
      }
    })
    .filter((i): i is TestIntent => Boolean(i && i.feature === feature));
  // Missions count too: a feature may have bound tests before any new intent.
  const missionIds = [PATHS.missionsDraft, PATHS.missionsApproved]
    .filter((dir) => fs.existsSync(dir))
    .flatMap((dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8')) as { test_id: string; feature: string };
      } catch {
        return undefined;
      }
    })
    .filter((m): m is { test_id: string; feature: string } => Boolean(m && m.feature === feature))
    .map((m) => m.test_id);
  const ids = [...mine.map((i) => i.test_id), ...missionIds];
  const prefix = ids[0]?.split('-')[0] ?? (feature.replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase() || 'RG');
  const used = ids.filter((id) => id.startsWith(`${prefix}-`)).map((id) => Number(id.split('-')[1]));
  return `${prefix}-${String(Math.max(0, ...used) + 1).padStart(3, '0')}`;
}

const PRIORITY: Record<DefectCandidate['severity'], Priority> = { blocker: 'P0', critical: 'P0', major: 'P1', minor: 'P2', trivial: 'P3' };

/**
 * Called when a person confirms a defect. Returns what was done, for the
 * command to tell them.
 */
export function onConfirmed(d: DefectCandidate): string[] {
  const feature = featureOfDefect(d);
  if (!feature) return ['No feature could be read from this defect, so no regression test was set up.'];
  const ticket = d.human_review?.ticket ? String(d.human_review.ticket) : undefined;

  if (d.test_id) {
    addToRegistry(feature, { test_id: d.test_id, fingerprint: d.fingerprint, title: d.title, ...(ticket ? { ticket } : {}), added_at: new Date().toISOString() });
    return [
      `${d.test_id} caught this defect, so it now guards the fix: added to ${rel(registryPath(feature))}.`,
      `Re-check the fix later with: npm run execution-agent -- --feature ${feature} --regression`,
    ];
  }

  const id = nextId(feature);
  const shape = shapeOf(d);
  const steps = d.steps_to_reproduce.map((s) => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
  const intent: TestIntent & { regression_for: { fingerprint: string; title: string; ticket?: string } } = {
    test_id: id,
    requirement_ref: { source: 'DOC', locator: rel(path.join(PATHS.defects, `${d.fingerprint}.json`)), quote: d.expected || d.summary },
    feature,
    layer: shape.category === 'api' ? 'BE' : 'FE',
    capability: `Regression.${d.fingerprint.slice(0, 8)}`,
    priority: PRIORITY[d.severity],
    actor: d.environment.role ? `a ${d.environment.role}` : 'a user',
    test_objective: `Regression: ${d.title.replace(/^\[[^\]]+\]\s*/, '')}`.slice(0, 160),
    expected_outcome: 'succeeds',
    preconditions: d.preconditions ?? [],
    coverage: { category: shape.category },
    steps: (steps.length ? steps : [`Open ${d.environment.url}`]).map((s, i) => ({ id: `S${i + 1}`, actor_intent: s })),
    outcomes: [{ id: 'O1', statement: shape.statement, observable: shape.observable }],
    regression_for: { fingerprint: d.fingerprint, title: d.title, ...(ticket ? { ticket } : {}) },
  };
  fs.mkdirSync(PATHS.intentsDraft, { recursive: true });
  const file = path.join(PATHS.intentsDraft, `${id}.json`);
  fs.writeFileSync(file, `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
  return [
    `No test case covered this defect, so a regression test case was proposed: ${rel(file)}`,
    `It is a draft: review it at Gate 2 like any other (npm run decide -- --by "<you>" --approve ${id}).`,
  ];
}
