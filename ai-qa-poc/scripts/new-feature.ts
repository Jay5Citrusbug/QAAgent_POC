/**
 * Start testing a new application or feature.
 *
 *   npm run new-feature -- --name billing --url https://stage.example.com --prefix BL
 *
 * Creates the input files and an application context for a feature that does
 * not exist yet, then tells you the three commands that follow.
 *
 * This exists to keep the system honest about being general. Everything in
 * src/ is domain-neutral — no product name, no role, no URL — and the way to
 * keep it that way is to make adding a domain a single command rather than a
 * copy of somebody else's folder with the words changed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { featurePaths, PATHS, rel } from '../src/config.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const name = arg('name');
const url = arg('url');
const prefix = (arg('prefix') ?? '').toUpperCase();

if (!name || !/^[a-z0-9][a-z0-9-]{0,30}$/i.test(name)) {
  console.error('Usage: npm run new-feature -- --name <feature> --url <base-url> [--prefix XX]');
  console.error('  --name   letters, digits and hyphens, e.g. "billing"');
  process.exit(1);
}
if (!url || !/^https?:\/\//i.test(url)) {
  console.error('A --url is required, and it must start with http:// or https://');
  console.error('Without it the agent cannot look at the application, and missions get written blind.');
  process.exit(1);
}
if (prefix && !/^[A-Z]{2,4}$/.test(prefix)) {
  console.error('--prefix must be 2-4 letters, e.g. BL. It keeps this feature\'s test ids out of another\'s.');
  process.exit(1);
}

const feature = featurePaths(name);
if (fs.existsSync(feature.requirementDir)) {
  console.error(`${rel(feature.requirementDir)} already exists — refusing to overwrite an existing feature.`);
  process.exit(1);
}

fs.mkdirSync(feature.requirementDir, { recursive: true });

const title = name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

fs.writeFileSync(
  path.join(feature.requirementDir, 'requirement.md'),
  `# Requirement — ${title}\n\n` +
    `> Replace this with the real requirement. Everything downstream depends on it:\n` +
    `> missions cite it, approval pins a hash of it, and a run warns if it changes\n` +
    `> afterwards. Keep it committed so results trace back to something durable.\n\n` +
    `## R-1 — <first capability>\n\n` +
    `<What the user can do, and what should happen.>\n\n` +
    `## Known gaps in this requirement\n\n` +
    `Recorded by the Thinking Agent at Gate 1, as questions for the author.\n` +
    `Anything the requirement does not state belongs here rather than being\n` +
    `guessed at in a mission.\n`,
  'utf8',
);

fs.writeFileSync(
  feature.documentationFile,
  `# Supporting documentation — ${title}\n\n` +
    `Whatever exists: specs, design notes, API docs, release notes.\n\n` +
    `Anything not stated here or in requirement.md is a **gap** to report, never\n` +
    `a blank to fill with something plausible.\n`,
  'utf8',
);

fs.writeFileSync(
  feature.existingTestsFile,
  `# Existing test coverage — ${title}\n\n` +
    `## Existing automated coverage\n\nNone yet.\n\n` +
    `## Existing manual coverage\n\n| Scenario | Covered by | Frequency |\n|---|---|---|\n| | | |\n\n` +
    `## Instruction to the Thinking Agent\n\n` +
    `Do not duplicate existing automated coverage. Do replace repetitive manual\n` +
    `smoke — that is the point. Flag anything here that looks stale.\n`,
  'utf8',
);

fs.writeFileSync(
  feature.appContextFile,
  `# Application context for the Execution Agent — ${title}.\n` +
    `#\n` +
    `# Not a DOM map. Just enough for the agent to start in the right place.\n` +
    `# The QA Lead owns this file; it is reviewed whenever a mission fails as\n` +
    `# ENVIRONMENT_FAILURE or the agent cannot find a named module.\n\n` +
    `application:\n` +
    `  name: ${title}\n` +
    `  environment: STAGE\n` +
    `  base_url: ${url}\n` +
    `  starting_page: /\n` +
    `  build: unknown\n\n` +
    `pages:\n` +
    `  home:\n` +
    `    path: /\n` +
    `    description: Landing page.\n\n` +
    `modules:\n` +
    `  - name: <Module>\n` +
    `    capabilities:\n` +
    `      - <Module>.<Capability>\n\n` +
    `roles:\n` +
    `  - name: Guest\n` +
    `    description: >\n` +
    `      Anonymous visitor. Add authenticated roles with a storage_state_ref\n` +
    `      once a session has been seeded for them.\n\n` +
    `global_testing_rules:\n` +
    `  - Never test outside the module named in the mission.\n` +
    `  - Never invent expected behaviour the requirement does not state.\n` +
    `  - Never mark PASS because an action succeeded; verify every critical assertion.\n` +
    `  - Prefer role and accessible name over CSS; never use coordinates.\n\n` +
    `data_hygiene:\n` +
    `  artifact_prefix: "QA"\n` +
    `  cleanup: manual\n` +
    `  note: >\n` +
    `    Every artifact created carries the prefix and a run id, so orphans stay\n` +
    `    identifiable and re-runs never collide.\n`,
  'utf8',
);

console.log(`Created feature "${name}"`);
console.log('');
console.log(`  ${rel(path.join(feature.requirementDir, 'requirement.md'))}`);
console.log(`  ${rel(feature.documentationFile)}`);
console.log(`  ${rel(feature.existingTestsFile)}`);
console.log(`  ${rel(feature.appContextFile)}`);
console.log('');
console.log('Next:');
console.log(`  1. Write the real requirement into ${rel(path.join(feature.requirementDir, 'requirement.md'))}`);
console.log(`  2. npm run inspect -- --feature ${name}`);
console.log(`     Looks at the live application, so missions are written about what is actually there.`);
console.log(`  3. npm run think -- --feature ${name}${prefix ? ` --prefix ${prefix}` : ''} --copy`);
console.log(`  4. npm run validate  →  npm run approve -- ${prefix || 'XX'}-001 --by "<you>"`);
console.log(`  5. npm run run-mission -- --feature ${name}`);
if (!prefix) {
  console.log('');
  console.log('No --prefix given. Pick one (2-4 letters) before generating, or this');
  console.log("feature's test ids may collide with another's and overwrite real work.");
}
