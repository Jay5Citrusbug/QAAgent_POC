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
import { buildHistory, renderHistory } from '../src/history.js';
import { ledgerPath, loadLedger, renderLedger, thinkingPhase } from '../src/clarifications.js';
import { buildCoverage, loadExclusions } from '../src/coverage.js';
import { listIntents, readIntentFile } from '../src/intents.js';
import { readMissionFile } from '../src/validate.js';

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
const intentSchema = readIfPresent(path.join(PATHS.schemas, 'test-intent.schema.json'));

/**
 * [R3] Questions already asked, and their answers.
 *
 * Without this the agent re-raises the same gap on every run, which trains the
 * reader to skim the gap list — and the gap list is the most valuable thing it
 * produces. Answers are authoritative: they ARE the requirement now.
 */
const ledgerFile = ledgerPath(featureName);
const ledgerSection = renderLedger(loadLedger(featureName));

/**
 * Which half of the job this pack is for — see `thinkingPhase`.
 *
 * `--generate` forces the second half, for the case where the questions were
 * settled somewhere this cannot see (a call, a thread) and re-asking would
 * just be ceremony. It is deliberately explicit rather than inferred.
 */
const phase = process.argv.includes('--generate')
  ? ({ phase: 'generate' as const, open: [], reason: 'Forced with --generate.' })
  : thinkingPhase(featureName);
const analysisTemplate = readIfPresent(path.join(PATHS.thinking, 'ANALYSIS_TEMPLATE.md'));
const coverageChecklist = readIfPresent(path.join(PATHS.thinking, 'COVERAGE_CHECKLIST.md'));
const observed = readIfPresent(
  path.join(PATHS.knowledge, 'observed', `${featureName ?? 'default'}.md`),
);

// Recall from earlier runs, so each analysis builds on the last instead of
// starting from zero every time.
const idPrefix = arg('prefix');
const history = renderHistory(buildHistory(idPrefix));

/**
 * [R3] Pick the example that matches the contract being asked for.
 *
 * A worked example does more for schema-valid output than another page of
 * rules — which cuts both ways. Showing a bound mission to an agent that must
 * produce a UI-free intent teaches it exactly the shape we are trying to stop
 * it writing.
 */
function pickIntentExample(): string | undefined {
  for (const dir of [PATHS.intentsApproved, PATHS.intentsDraft]) {
    if (!fs.existsSync(dir)) continue;
    const found = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()[0];
    if (found) return path.join(dir, found);
  }
  return undefined;
}

const exampleFile = observed ? pickExample(idPrefix) : pickIntentExample();
const example = exampleFile ? fs.readFileSync(exampleFile, 'utf8').trim() : undefined;

/**
 * A worked example does more for schema-valid output than another page of
 * rules. Prefer one from THIS feature — an example from another product
 * teaches the agent that product's vocabulary, which is how a fresh project
 * ends up with missions about somebody else's checkout flow.
 *
 * Order: an approved mission sharing this feature's id prefix, then any
 * approved mission, then the neutral reference example.
 */
function pickExample(prefix?: string): string | undefined {
  const approved = fs.existsSync(PATHS.missionsApproved)
    ? fs.readdirSync(PATHS.missionsApproved).filter((f) => f.endsWith('.json')).sort()
    : [];

  const neutral = path.join(PATHS.thinking, 'EXAMPLE_MISSION.json');

  if (prefix) {
    // An explicit prefix means this is its own feature. If it has no approved
    // mission yet, show the neutral reference rather than another product's —
    // borrowing a real mission would teach this feature that product's
    // vocabulary, which is how a fresh project ends up with missions about
    // somebody else's checkout.
    const sameFeature = approved.find((f) => f.toUpperCase().startsWith(`${prefix.toUpperCase()}-`));
    if (sameFeature) return path.join(PATHS.missionsApproved, sameFeature);
    return fs.existsSync(neutral) ? neutral : undefined;
  }

  if (approved[0]) return path.join(PATHS.missionsApproved, approved[0]);
  return fs.existsSync(neutral) ? neutral : undefined;
}

if (!requirement) {
  console.warn(`! ${rel(path.join(feature.requirementDir, 'requirement.md'))} is empty or missing — the pack will be thin.\n`);
}

const today = new Date().toISOString().slice(0, 10);

const ledgerBlock = ledgerSection ? '---\n\n' + ledgerSection + '\n' : '';

/**
 * The coverage mandate, repeated in every phase.
 *
 * Asking the agent to "consider every category" as prose produced a set that
 * silently had no primary mission for input_validation, edge_case,
 * error_handling or security — and the omission was invisible until someone
 * audited it by hand afterwards. Naming the categories inline, and requiring a
 * verdict on each one, is what makes the omission impossible to leave implicit.
 */
/**
 * What is actually uncovered right now, computed from disk.
 *
 * The mandate tells the agent to cover every category. This tells it which ones
 * are *currently* missing, so the instruction is specific rather than a
 * principle it can satisfy in its own estimation. Without it, "work through
 * every category" produced a set with four categories silently empty and nobody
 * noticed until it was audited by hand.
 */
function collectMissions(dir: string) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readMissionFile(path.join(dir, f)));
}

const coverageState = (() => {
  const missions = [...collectMissions(PATHS.missionsDraft), ...collectMissions(PATHS.missionsApproved)];
  const intents = [...listIntents(PATHS.intentsDraft), ...listIntents(PATHS.intentsApproved)].map(readIntentFile);
  const report = buildCoverage(missions, intents);
  const excluded = new Set(loadExclusions(featureName).map((e) => e.category.toLowerCase()));
  const open = report.gapsAutomatable.filter(
    (g) => !excluded.has(g.key.toLowerCase()) && !excluded.has(g.label.toLowerCase()),
  );
  if (open.length === 0) {
    return 'Every automatable category currently has at least one intent or mission, or is recorded as not applicable in coverage-exclusions.yaml. Keep it that way.';
  }
  return [
    'These automatable categories have **nothing** covering them right now:',
    '',
    ...open.map((g) => '* `' + g.key + '` — ' + g.label),
    '',
    'Each needs an intent whose PRIMARY `coverage.category` is that category, or a',
    'human-recorded exclusion. Do not leave any of them unmentioned.',
  ].join('\n');
})();

const COVERAGE_MANDATE = [
  '## Coverage is mandatory, and it is checked',
  '',
  'Work through **every** category in the checklist above and give each one a',
  'verdict. There are only three acceptable verdicts per category:',
  '',
  '1. **Covered** — name the intent(s) that cover it as their PRIMARY',
  '   `coverage.category`. A category listed only as a `secondary_categories`',
  '   entry does NOT count as covered; the report counts primary categories only.',
  '2. **Applies, cannot be automated** — write the intent anyway with',
  '   `execution_mode: "manual"` and a `manual_reason` naming the missing',
  '   capability, so a human schedules it instead of it being forgotten.',
  '3. **Does not apply** — say so explicitly, with the reason, in section 4 of',
  '   the analysis. "This feature has no authentication, so `security` does not',
  '   apply" is a finding. Silence is not.',
  '',
  'A category you simply did not mention is the failure mode here. `npm run',
  'coverage -- --check` fails the build on exactly that, so an unmentioned',
  'category will be caught — write the verdict rather than leaving it implicit.',
  '',
  'Cover the **end-to-end flow**, not only individual screens: the path a real',
  'user takes from arriving to completing the feature\'s main job, including what',
  'happens when they get something wrong along the way.',
  '',
  '### Current state, read from disk just now',
  '',
  coverageState,
].join('\n');

/**
 * [R5] Two phases, never both in one pass.
 *
 * See `thinkingPhase` for why. In short: raising a question and then writing
 * the intents that depend on it in the same breath puts the question in front
 * of a human after the work, and forces a regenerate once they answer.
 */
const taskSection =
  phase.phase === 'generate'
    ? [
        '# Your task — write the intents',
        '',
        'The analysis is done and every question it raised has been answered. The',
        'answers above are part of the requirement now; treat them exactly as you',
        'would treat a sentence in `requirement.md`.',
        '',
        '**Produce draft test intents** as separate JSON objects, each labelled with',
        'the filename it should be saved as (`intents/draft/<TEST_ID>.json`).',
        '',
        'Rules that decide whether your output is usable:',
        '',
        '* **An intent names no UI.** No role, no accessible name, no selector, no',
        '  "click the button in the top right". Write what the actor is trying to',
        '  achieve. If you cannot say it without naming a control, it is a binding',
        '  detail and it belongs to binding time, not to you.',
        '* Every outcome needs a human `statement` and an `observable` saying what kind',
        '  of evidence would settle it.',
        '* A `blocked` intent must assert **what the user is told**, not only that',
        '  nothing happened. "Not signed in" is equally true of a correct refusal and',
        '  of a crash.',
        '* If you find a NEW gap at this stage — something the analysis missed — stop',
        '  and raise it rather than writing an intent that guesses. A late question is',
        '  cheaper than a wrong test.',
        '* Say in `test_data` what **state** the data must be in, and how it is',
        '  provisioned. `unknown` is an honest and useful answer.',
        '* Mark data `disposable` when the test consumes it.',
        '* Fill `requirement_ref` with the file path and the sentence it comes from.',
        '* Tag every intent with `coverage.category`, and mark anything the browser',
        '  agent cannot run as `execution_mode: "manual"` with a reason.',
        '* Use `not_verifiable_yet` for what the intent *should* check but nothing can.',
        '',
        COVERAGE_MANDATE,
        '',
        'Then stop. A human decides what gets approved — you are not the gate.',
      ].join('\n')
    : [
        '# Your task — analyse and ask. Do NOT write any intents yet.',
        '',
        phase.phase === 'blocked'
          ? `**${phase.open.length} question(s) from the last analysis are still unanswered.** Until a human answers them, generating intents would bake a guess into each one. List what is still open and stop.`
          : 'This is the first half of the job. You are reading the requirement to find what it does **not** say — not to produce tests yet.',
        '',
        '1. **Analyse the requirement** in the structure given above, and save it to',
        `   \`thinking/analysis/${featureName ?? '<feature>'}-${today}.md\`.`,
        '',
        '2. **Ask your questions.** Put every gap where the requirement is silent or',
        '   ambiguous under its own heading, in the ledger format below, so a human can',
        '   paste them straight into `clarifications.yaml`:',
        '',
        '   ```yaml',
        '   - id: Q-<next>',
        '     question: >-',
        '       ...',
        '     why: >-',
        '       which test is stuck, or what breaks if we guess',
        '     status: open',
        '     answer: null',
        '   ```',
        '',
        '   Do not repeat a question the ledger above already carries.',
        '',
        '3. **Write no intents. Not one** — not even with',
        '   `depends_on_clarifications` declared. An earlier version of this prompt',
        '   told you to write them anyway and declare the dependency; that was wrong.',
        '   It puts the question in front of the human *after* the work that depends',
        '   on it, and every dependent intent has to be rewritten once they answer.',
        '',
        '**Ask the questions in the chat as well**, as a short numbered list, so the',
        'human can answer without opening a file. That conversation is the point of',
        'this phase.',
        '',
        COVERAGE_MANDATE,
        '',
        'Once the answers are recorded, `npm run think` switches to the generate',
        'phase on its own and asks for the intents.',
      ].join('\n');

/**
 * [R3] Which contracts the agent is held to on this run.
 *
 * Intents always. Missions only when the application has actually been
 * observed — without a capture, every target in a mission would be invented,
 * which is not a risk to warn about but a thing that cannot be done.
 */
const contracts = [
  '---',
  '',
  '# The intent contract — authoritative, and your primary output',
  '',
  'A **test intent** says what is being tested and what must be observably true.',
  'It says nothing about where to click, because before the application is built',
  'nobody knows — and a guessed control is a fabricated fact that survives into',
  'execution looking like a real test.',
  '',
  'There is deliberately no target, no action enum and no selector in this schema.',
  'You are not being asked to resist naming a button; the contract cannot express one.',
  '',
  '```json',
  intentSchema ?? '(intent schema missing)',
  '```',
  '',
  ...(observed
    ? [
        '---',
        '',
        '# The mission contract — authoritative',
        '',
        'The application is running and its real page is captured above, so you may',
        'also produce bound missions directly. Each must validate against this schema',
        'exactly. Do not work from memory of a similar schema.',
        '',
        '```json',
        schema ?? '(schema missing)',
        '```',
        '',
      ]
    : [
        '---',
        '',
        '# Missions: not yours to write on this run',
        '',
        'No page capture exists, so the application cannot be observed. Under those',
        'conditions a mission is unwriteable rather than merely risky — every target in',
        'it would be invented. Produce intents only. When a front-end URL exists, the',
        'Execution Agent binds them to the real page in one pass before running anything.',
        '',
      ]),
].join('\n');

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
${
  observed
    ? `---

${observed}

**Use the observed state above in preference to any assumption.** It was captured
from the running application. If a control you were about to target is not listed,
it does not exist — report that as a gap rather than writing a mission against it.
`
    : `---

## Observed application state

_Not captured._ Run \`npm run inspect -- --feature ${featureName ?? '<feature>'}\` first.
Without it you are describing a page you have never seen, which is how missions end up
asserting UI that does not exist.
`
}

${ledgerBlock}${contracts}
${
  example
    ? `---

# Worked example — a complete, valid ${observed ? 'mission' : 'intent'}

This is a real ${observed ? 'mission' : 'intent'} from this repository
(\`${rel(exampleFile as string)}\`). Match this shape.

\`\`\`json
${example}
\`\`\`
`
    : ''
}
${history ? `---

${history}
` : ''}
---

# Coverage checklist — work through every category

${coverageChecklist ?? '(checklist missing)'}

---

# Analysis format

Produce the analysis in exactly this structure so it can be committed verbatim
to \`thinking/analysis/${featureName ?? '<feature>'}-${today}.md\`:

${analysisTemplate ?? '(template missing)'}

---

${taskSection}
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
console.log(
  `  Phase            ${
    phase.phase === 'generate' ? 'GENERATE — write the intents' : 'ANALYSE & ASK — no intents yet'
  }`,
);
console.log(`                   ${phase.reason}`);
console.log(`  Size             ~${approxTokens.toLocaleString()} tokens in (~$${approxCost} input)`);
console.log(`  Contract         ${observed ? 'intents + missions (page observed)' : 'intents only (no page capture)'}`);
console.log(`  Schema inlined   ${intentSchema ? 'yes' : 'NO — intents will not validate'}`);
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
console.log(`  2. Save the analysis        → thinking/analysis/${featureName ?? 'default'}-${today}.md`);
console.log('  3. Append any new questions → ' + rel(ledgerFile));
console.log('  4. Save each intent         → intents/draft/<TEST_ID>.json');
if (observed) console.log('  5. Save each mission        → missions/draft/<TEST_ID>.json');
console.log(`  ${observed ? 6 : 5}. npm run validate`);
console.log(
  `  ${observed ? 7 : 6}. npm run approve-intent -- <TEST_ID> --by "<your name>" --minutes <n>`,
);
console.log('');

if (!observed) {
  console.log('No page capture for this feature, so the pack asks for intents only.');
  console.log('That is the correct output before a front-end exists — a mission written');
  console.log('now would have an invented target in every step. When the build lands:');
  console.log(`  npm run inspect -- --feature ${featureName ?? '<feature>'} --url <URL>`);
  console.log('');
}
