/**
 * Start testing a new application or feature.
 *
 *   npm run new-feature -- --name billing --prefix BL                          # front-end not built yet
 *   npm run new-feature -- --name billing --url https://stage.acme.io --prefix BL
 *
 * --url is optional. Test cases are usually written before the front-end
 * exists, so a feature can start from the requirement alone: the Thinking
 * Agent writes UI-free intents, `npm run verify` checks them against the
 * requirement, and binding to real pages waits until a URL is set.
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
  console.error('Usage: npm run new-feature -- --name <feature> [--url <base-url>] [--prefix XX]');
  console.error('  --name   letters, digits and hyphens, e.g. "billing"');
  process.exit(1);
}
if (url && !/^https?:\/\//i.test(url)) {
  console.error('--url must start with http:// or https://');
  process.exit(1);
}
/**
 * No URL means pre-build. The placeholder is the one every other command
 * already recognises (run-mission, preflight, verify), so nothing can mistake
 * it for a real environment and send a browser at it.
 */
const PLACEHOLDER_URL = 'https://stage.example.com';
const preBuild = !url;
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
    `Recorded by the Thinking Agent at Gate 2, as questions for the author.\n` +
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
    (preBuild
      ? `  # Pre-build: no front-end yet. Replace with the real STAGE URL when it exists\n` +
        `  # (or set BASE_URL); until then only requirement-level verification runs.\n`
      : '') +
    `  base_url: ${url ?? PLACEHOLDER_URL}\n` +
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
if (preBuild) {
  console.log('');
  console.log('  No --url: starting pre-build. Everything up to Gate 2 works without a front-end.');
  console.log(`  2. npm run thinker -- --feature ${name}${prefix ? ` --prefix ${prefix}` : ''}          Thinker Agent: analyse, ask questions`);
  console.log(`  3. npm run clarify -- --feature ${name} ...  →  npm run approve-analysis -- --feature ${name} --by "<you>"   Gate 1`);
  console.log(`  4. npm run test-case-agent -- --feature ${name}${prefix ? ` --prefix ${prefix}` : ''}  Test Case Agent: write the test cases`);
  console.log(`  5. npm run validate  →  npm run verify -- --feature ${name}   check them against the requirement`);
  console.log(`  6. Gate 2: Gate 2 Decision column in reports/TEST-CASES-${name}.csv  →  npm run approve-sheet -- --feature ${name} --by "<you>"`);
  console.log('');
  console.log('  When the front-end exists:');
  console.log(`  7. set base_url in ${rel(feature.appContextFile)} (or BASE_URL)`);
  console.log(`  8. npm run inspect -- --feature ${name}  →  npm run bind -- --feature ${name} --write`);
  console.log(`  9. npm run verify -- --feature ${name}     live checks, before anything executes`);
  console.log(` 10. npm run execution-agent -- --feature ${name}`);
} else {
  console.log(`  2. npm run inspect -- --feature ${name}`);
  console.log(`     Looks at the live application, so missions are written about what is actually there.`);
  console.log(`  3. npm run think -- --feature ${name}${prefix ? ` --prefix ${prefix}` : ''} --copy`);
  console.log(`  4. npm run validate  →  npm run verify -- --feature ${name}  →  npm run approve -- ${prefix || 'XX'}-001 --by "<you>"`);
  console.log(`  5. npm run run-mission -- --feature ${name}`);
}
if (!prefix) {
  console.log('');
  console.log('No --prefix given. Pick one (2-4 letters) before generating, or this');
  console.log("feature's test ids may collide with another's and overwrite real work.");
}
