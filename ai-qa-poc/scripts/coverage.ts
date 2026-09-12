/**
 * Coverage report against the QA checklist.
 *
 *   npm run coverage                  # every mission
 *   npm run coverage -- --prefix EC   # one feature's missions
 *
 * Shows which checklist areas a mission set touches and, more importantly,
 * which it does not. A feature whose missions never mention security looks
 * exactly like one where security was considered and ruled out — this makes
 * that difference visible before a release decision depends on it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/config.js';
import { buildCoverage, renderCoverage } from '../src/coverage.js';
import { readMissionFile } from '../src/validate.js';
import type { TestMission } from '../src/types.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const prefix = flag('prefix')?.toUpperCase();

function collect(dir: string): TestMission[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !prefix || f.toUpperCase().startsWith(`${prefix}-`))
    .map((f) => readMissionFile(path.join(dir, f)));
}

const missions = [...collect(PATHS.missionsDraft), ...collect(PATHS.missionsApproved)];

if (missions.length === 0) {
  console.error(prefix ? `No missions with prefix ${prefix}-.` : 'No missions found.');
  process.exit(1);
}

console.log('');
if (prefix) console.log(`Feature prefix: ${prefix}-`);
console.log(renderCoverage(buildCoverage(missions)));
console.log('');
