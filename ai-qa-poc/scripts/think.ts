/**
 * Assemble the Thinking Agent prompt pack.
 *
 *   npm run think                          # write the pack and print where it went
 *   npm run think -- --feature ecommerce   # a second feature, kept separate from the default
 *   npm run think -- --copy                # also copy it to the clipboard
 *   npm run think -- --stdout              # print the pack itself
 *
 * POC-1 has no LLM API integration by design, so this does not call a model.
 * It solves the problem that actually blocks using the Thinking Agent: the
 * prompt references a JSON schema by file path, and a chat model cannot open
 * a file path. Without the schema and a worked example inlined, the model
 * returns plausible JSON that fails `npm run validate`.
 *
 * Paste the pack into Claude (claude-opus-5 by default — see
 * agent/thinking/config.yaml), then save what comes back:
 *   the analysis → thinking/analysis/<feature>-<date>.md
 *   each mission → missions/draft/<TEST_ID>.json
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { featurePaths, loadThinkingConfig, PATHS, rel } from '../src/config.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const featureName = arg('feature');
const feature = featurePaths(featureName);

function readIfPresent(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : undefined;
}

function section(title: string, body: string | undefined, fence?: string): string {
  if (!body) return `## ${title}\n\n_(not provided)_\n`;
  return fence ? `## ${title}\n\n\`\`\`${fence}\n${body}\n\`\`\`\n` : `## ${title}\n\n${body}\n`;
}

const cfg = loadThinkingConfig();

const systemPrompt = readIfPresent(path.join(PATHS.thinking, 'SYSTEM_PROMPT.md'));
if (!systemPrompt) {
  console.error('Missing agent/thinking/SYSTEM_PROMPT.md — nothing to assemble.');
  process.exit(1);
}

const appContext = readIfPresent(feature.appContextFile);
if (featureName && !fs.existsSync(feature.appContextFile)) {
  console.warn(
    `! No knowledge/application-context-${featureName}.yaml — the pack will have no application context.\n`,
  );
}
const requirement = readIfPresent(path.join(feature.requirementDir, 'requirement.md'));
const documentation = readIfPresent(feature.documentationFile);
const existingTests = readIfPresent(feature.existingTestsFile);
const schema = readIfPresent(path.join(PATHS.schemas, 'test-mission.schema.json'));
const analysisTemplate = readIfPresent(path.join(PATHS.thinking, 'ANALYSIS_TEMPLATE.md'));

// A worked example does more for schema-valid output than another page of rules.
// Prefer a real approved mission; fall back to the draft.
const exampleFile = [
  path.join(PATHS.missionsApproved, 'SM-001.json'),
  path.join(PATHS.missionsDraft, 'SM-001.json'),
].find((f) => fs.existsSync(f));
const example = exampleFile ? fs.readFileSync(exampleFile, 'utf8').trim() : undefined;

if (!requirement) {
  console.warn(`! ${rel(path.join(feature.requirementDir, 'requirement.md'))} is empty or missing — the pack will be thin.\n`);
}

const today = new Date().toISOString().slice(0, 10);

const pack = `# QA Thinking Agent — prompt pack

Generated ${new Date().toISOString()} by \`npm run think\`.

**Run this with \`${cfg.model}\` at effort \`${cfg.effort}\`.** Requirement analysis
is the task of finding what *is not stated*, which is where reasoning depth
actually pays — do not downgrade the model to save ${cfg.cost_note ?? 'a few cents'}.

---

${systemPrompt}

---

# Inputs

${section('Application context', appContext, 'yaml')}
${section('Requirement under test', requirement)}
${section('Supporting documentation', documentation)}
${section('Existing coverage', existingTests)}

---

# The mission contract — authoritative

Every mission you produce must validate against this JSON Schema exactly. It is
reproduced here in full because you cannot open files; do not work from memory
of a similar schema.

\`\`\`json
${schema ?? '(schema missing)'}
\`\`\`

${
  example
    ? `---

# Worked example — a complete, valid mission

This is a real mission from this repository (\`${rel(exampleFile as string)}\`).
Match this shape.

\`\`\`json
${example}
\`\`\`
`
    : ''
}
---

# Analysis format

Produce the analysis in exactly this structure so it can be committed verbatim
to \`thinking/analysis/${featureName ?? '<feature>'}-${today}.md\`:

${analysisTemplate ?? '(template missing)'}

---

# Your task

1. **Analyse the requirement** in the structure above. Gaps are questions for
   the requirement author — never blanks you fill in with something plausible.

2. **Produce draft missions** as separate JSON objects, each one labelled with
   the filename it should be saved as (\`missions/draft/<TEST_ID>.json\`).

Rules that decide whether your output is usable:

* Every assertion needs both a human \`statement\` and a machine-checkable \`check\`.
* Targets are semantic (\`role\` + \`name\`, \`label\`, \`placeholder\`, \`text\`) — never CSS.
  You cannot see the DOM, so a guessed selector is a fabricated fact.
* \`expected_outcome: "blocked"\` for negative missions, and mark the step the
  application should refuse with \`tolerate_failure: true\`.
* Anything that creates data needs \`{run_id}\` in its \`naming_pattern\`.
* Fill \`requirement_ref\` with the file path and the sentence the mission comes from.
* Set a \`budget\`.

Then stop. A human decides what gets approved — you are not the gate.
`;

fs.mkdirSync(PATHS.thinkingPrompts, { recursive: true });
const outFile = path.join(
  PATHS.thinkingPrompts,
  featureName ? `prompt-${featureName}-${today}.md` : `prompt-${today}.md`,
);
fs.writeFileSync(outFile, pack, 'utf8');

if (process.argv.includes('--stdout')) {
  console.log(pack);
  process.exit(0);
}

// Rough only — 4 chars per token is a serviceable approximation and this is a
// budgeting hint, not an invoice.
const approxTokens = Math.round(pack.length / 4);
const approxCost = ((approxTokens / 1_000_000) * 5).toFixed(3);

console.log(`Prompt pack written: ${rel(outFile)}`);
console.log('');
console.log(`  Model            ${cfg.model} (effort ${cfg.effort})`);
console.log(`  Size             ~${approxTokens.toLocaleString()} tokens in (~$${approxCost} input)`);
console.log(`  Schema inlined   ${schema ? 'yes' : 'NO — missions will not validate'}`);
console.log(`  Worked example   ${example ? `yes (${path.basename(exampleFile as string)})` : 'no'}`);
console.log('');

if (process.argv.includes('--copy')) {
  try {
    execFileSync('clip', { input: pack });
    console.log('Copied to clipboard.');
    console.log('');
  } catch {
    console.log('(Could not reach the clipboard — open the file above instead.)');
    console.log('');
  }
}

console.log('Next:');
console.log(`  1. Paste the pack into ${cfg.model}.`);
console.log(`  2. Save the analysis  → thinking/analysis/${featureName ?? '<feature>'}-${today}.md`);
console.log('  3. Save each mission  → missions/draft/<TEST_ID>.json');
console.log('  4. npm run validate');
console.log('  5. npm run approve -- <TEST_ID> --by "<your name>" --minutes <n>');
