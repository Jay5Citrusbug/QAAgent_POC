import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';
import type { ExecutionResult, TestMission } from './types.js';

/**
 * What happened last time.
 *
 * Until now the pipeline ran one way: requirement in, missions out, results to
 * disk, and nothing ever read them back. Every analysis started from zero. A
 * tester who had been on the product a year would never work that way — they
 * remember which mission has been failing for a fortnight, that the logo has
 * been broken since Tuesday, and that "Add to Cart" appears eight times so it
 * always needs scoping.
 *
 * This assembles that memory from what is already on disk. No model involved:
 * it is recall, not reasoning.
 */

export interface MissionHistory {
  testId: string;
  objective: string;
  category?: string;
  lastStatus?: string;
  lastClassification?: string | null;
  runs: number;
  consecutiveNonPass: number;
  approved: boolean;
}

export interface KnownFinding {
  summary: string;
  detail?: string;
  severity: string;
  seenInRuns: number;
}

export interface UnstableTarget {
  key: string;
  description?: string;
  hits: number;
  misses: number;
}

export interface History {
  missions: MissionHistory[];
  findings: KnownFinding[];
  unstableTargets: UnstableTarget[];
  suspectMissions: MissionHistory[];
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Results for one test id, oldest first, replays excluded. */
function resultsFor(testId: string): ExecutionResult[] {
  const dir = path.join(PATHS.runs, testId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => !d.endsWith('-replay'))
    .sort()
    .map((d) => readJson<ExecutionResult>(path.join(dir, d, 'result.json')))
    .filter((r): r is ExecutionResult => Boolean(r));
}

export function buildHistory(prefix?: string): History {
  const missions: MissionHistory[] = [];

  for (const [dir, approved] of [
    [PATHS.missionsApproved, true],
    [PATHS.missionsDraft, false],
  ] as const) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const testId = file.replace(/\.json$/, '');
      if (prefix && !testId.startsWith(`${prefix}-`)) continue;
      const mission = readJson<TestMission>(path.join(dir, file));
      if (!mission) continue;

      const results = resultsFor(testId);
      const last = results[results.length - 1];

      // How long has this been unhappy? A mission failing every run for a week
      // is usually a bad mission, not a week-long outage.
      let streak = 0;
      for (let i = results.length - 1; i >= 0; i -= 1) {
        if (results[i]?.status === 'PASS') break;
        streak += 1;
      }

      missions.push({
        testId,
        objective: mission.test_objective,
        category: mission.coverage?.category,
        lastStatus: last?.status,
        lastClassification: last?.failure_classification ?? null,
        runs: results.length,
        consecutiveNonPass: streak,
        approved,
      });
    }
  }

  // Findings already observed, so the agent neither re-reports them as news
  // nor writes a mission asserting the broken thing works.
  const findingMap = new Map<string, KnownFinding>();
  if (fs.existsSync(PATHS.runs)) {
    for (const testId of fs.readdirSync(PATHS.runs)) {
      if (prefix && !testId.startsWith(`${prefix}-`)) continue;
      for (const r of resultsFor(testId)) {
        for (const f of r.incidental_findings ?? []) {
          const key = /https?:\/\/[^\s)'"]+/.exec(f.detail ?? '')?.[0] ?? `${f.summary}|${f.detail ?? ''}`;
          const existing = findingMap.get(key);
          if (existing) existing.seenInRuns += 1;
          else
            findingMap.set(key, {
              summary: f.summary,
              detail: f.detail,
              severity: f.severity,
              seenInRuns: 1,
            });
        }
      }
    }
  }

  // Locator cache entries that miss more than they hit: a renamed control.
  const unstableTargets: UnstableTarget[] = [];
  const cache = readJson<{ entries: Record<string, { description?: string; hits?: number; misses?: number }> }>(
    PATHS.locatorCache,
  );
  for (const [key, entry] of Object.entries(cache?.entries ?? {})) {
    const hits = entry.hits ?? 0;
    const misses = entry.misses ?? 0;
    if (misses > 0 && misses >= hits) {
      unstableTargets.push({ key, description: entry.description, hits, misses });
    }
  }

  return {
    missions: missions.sort((a, b) => a.testId.localeCompare(b.testId)),
    findings: [...findingMap.values()].sort((a, b) => b.seenInRuns - a.seenInRuns),
    unstableTargets,
    // Two or more consecutive non-PASS runs: worth questioning the mission
    // itself before reporting the product again.
    suspectMissions: missions.filter((m) => m.consecutiveNonPass >= 2),
  };
}

export function renderHistory(h: History): string {
  if (h.missions.length === 0 && h.findings.length === 0) return '';

  const out: string[] = [];
  out.push('# What previous runs already established');
  out.push('');
  out.push(
    'Recall from earlier runs. Use it so this analysis adds to what is known ' +
      'instead of repeating it.',
  );
  out.push('');

  if (h.missions.length) {
    out.push('## Missions that already exist for this feature');
    out.push('');
    out.push('Do not propose a duplicate. Propose a replacement only if you can say what was wrong with the original.');
    out.push('');
    out.push('| Test | Category | Last result | Runs | Objective |');
    out.push('|---|---|---|---:|---|');
    for (const m of h.missions) {
      const status = m.lastStatus
        ? `${m.lastStatus}${m.lastClassification ? ` / ${m.lastClassification}` : ''}`
        : 'never run';
      out.push(
        `| ${m.testId}${m.approved ? '' : ' _(draft)_'} | ${m.category ?? '—'} | ${status} | ${m.runs} | ${m.objective} |`,
      );
    }
    out.push('');
  }

  if (h.suspectMissions.length) {
    out.push('## Missions failing repeatedly — suspect the mission first');
    out.push('');
    out.push(
      'These have not passed for several consecutive runs. A product defect usually gets fixed or filed; ' +
        'a mission that keeps failing is more often asserting something that was never true. ' +
        'Check each against the observed application state before assuming the product is broken.',
    );
    out.push('');
    for (const m of h.suspectMissions) {
      out.push(`- **${m.testId}** — ${m.consecutiveNonPass} consecutive non-PASS runs — ${m.objective}`);
    }
    out.push('');
  }

  if (h.findings.length) {
    out.push('## Problems already known on this application');
    out.push('');
    out.push(
      'Observed during earlier runs and not yet fixed. Two consequences: do not present these as new ' +
        'discoveries, and do not write a mission that depends on the broken thing working.',
    );
    out.push('');
    for (const f of h.findings.slice(0, 15)) {
      out.push(`- [${f.severity.toUpperCase()}] ${f.summary}${f.detail ? ` — ${f.detail.slice(0, 110)}` : ''} _(seen in ${f.seenInRuns} run(s))_`);
    }
    out.push('');
  }

  if (h.unstableTargets.length) {
    out.push('## Targets that keep going stale');
    out.push('');
    out.push('These cached locators miss at least as often as they hit — usually a renamed or restructured control.');
    out.push('');
    for (const t of h.unstableTargets) {
      out.push(`- \`${t.key}\`${t.description ? ` (${t.description})` : ''} — ${t.hits} hit(s), ${t.misses} miss(es)`);
    }
    out.push('');
  }

  return out.join('\n');
}
