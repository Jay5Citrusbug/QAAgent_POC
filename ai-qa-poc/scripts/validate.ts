/**
 * Validate and lint missions.
 *
 *   npm run validate                 # every mission in draft/ and approved/
 *   npm run validate -- SM-001       # one mission by id
 *
 * Schema errors are fatal. Lint warnings are not — they are the things a human
 * should see at Gate 1 before approving.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/config.js';
import { isApproved, lintMission, readMissionFile, validateMission } from '../src/validate.js';
import type { TestMission } from '../src/types.js';

function collect(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dir, f));
}

const filter = process.argv[2];
const files = [...collect(PATHS.missionsDraft), ...collect(PATHS.missionsApproved)].filter(
  (f) => !filter || path.basename(f, '.json') === filter,
);

if (files.length === 0) {
  console.error(filter ? `No mission named ${filter}.` : 'No missions found.');
  process.exit(1);
}

let failures = 0;
let warnings = 0;

for (const file of files) {
  const where = path.relative(PATHS.root, file).split(path.sep).join('/');
  let mission: TestMission;
  try {
    mission = readMissionFile(file);
  } catch (err) {
    console.error(`✗ ${where}: not valid JSON — ${String(err)}`);
    failures += 1;
    continue;
  }

  const { valid, errors } = validateMission(mission);
  if (!valid) {
    console.error(`✗ ${where}`);
    for (const e of errors) console.error(`    ${e}`);
    failures += 1;
    continue;
  }

  const lint = lintMission(mission);
  const approved = isApproved(mission);
  const inApprovedDir = file.startsWith(PATHS.missionsApproved);

  console.log(`✓ ${where}${approved ? '  [approved]' : '  [draft]'}`);

  if (inApprovedDir && !approved) {
    console.error('    ✗ in approved/ but has no approval block — the executor will refuse it.');
    failures += 1;
  }

  for (const w of lint) {
    console.warn(`    ! ${w}`);
    warnings += 1;
  }
}

console.log('');
console.log(`${files.length} mission(s), ${failures} invalid, ${warnings} warning(s).`);
if (warnings > 0 && failures === 0) {
  console.log('Warnings are for the human at Gate 1 to judge — they do not block execution.');
}
process.exit(failures > 0 ? 1 : 0);
