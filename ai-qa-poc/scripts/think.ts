/**
 * Assemble the Thinker Agent prompt pack.
 *
 *   npm run think                          # write the pack and print where it went
 *   npm run think -- --feature ecommerce   # a second feature, kept separate from the default
 *   npm run think -- --copy                # also copy it to the clipboard
 *   npm run think -- --stdout              # print the pack itself
 *   npm run think -- --feature login --run # run the Thinker Agent headless
 *
 * The pack inlines everything the model needs — schema, worked example,
 * templates — because a model cannot open a file path. Without them it
 * returns plausible JSON that fails `npm run validate`.
 *
 * --run sends the pack to Claude Code headless on the Claude subscription and
 * saves what comes back. Which half of the job it does is decided from disk:
 *
 *   analyse    no analysis yet → write it, add its questions to the ledger, stop
 *   blocked    questions open  → list them, no model call
 *   approval   Gate 1 pending  → say how to approve, no model call
 *   generate   Gate 1 approved → write draft intents and the test case sheet
 *
 * Without --run, paste the pack into Claude by hand; the artifacts are the same.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { featurePaths, loadThinkingConfig, PATHS, rel } from '../src/config.js';
import { buildHistory, renderHistory } from '../src/history.js';
import { ledgerPath, loadLedger, renderLedger } from '../src/clarifications.js';
import { thinkingStage } from '../src/analysis-gate.js';
import { runAnalyse, runGenerate } from '../src/thinking-run.js';
import { loadFeedback } from '../src/intent-approval.js';
import { listDefects } from '../src/defect.js';
import { featureOfDefect } from '../src/regression.js';
import type { TestIntent } from '../src/types.js';
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
/** The exact path every `requirement_ref.locator` must carry — verify and the sheet key on it. */
const requirementLocator = rel(path.join(feature.requirementDir, 'requirement.md')).replace(/\\/g, '/');
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
 * Which half of the job this pack is for — see `thinkingStage`.
 *
 * There is no way to force the generate half any more. Questions settled
 * somewhere this cannot see (a call, a thread) are recorded with
 * `npm run clarify -- --answer`, and the analysis is approved at Gate 1;
 * generating past either would write test cases against a guess.
 */
const stage = thinkingStage(featureName);
const label = featureName ?? 'default';

/**
 * The two agents that share this script. `--agent` makes each one do only its
 * own job: the Thinker Agent analyses and asks; the Test Case Agent writes test
 * cases, and only once Gate 1 is approved. Without `--agent`, the stage on
 * disk decides, as before.
 */
const agent = arg('agent');
const AGENT_NAME = { thinker: 'Thinker Agent', 'test-case': 'Test Case Agent' } as const;
if (agent && !(agent in AGENT_NAME)) {
  console.error(`Unknown --agent "${agent}". Use thinker or test-case.`);
  process.exit(1);
}
if (agent === 'thinker' && stage.stage === 'generate') {
  console.log(`Thinker Agent: the analysis for ${label} is done and approved at Gate 1 (${stage.reason}).`);
  console.log(`Next is the Test Case Agent: npm run test-case-agent -- --feature ${label}`);
  console.log('To re-analyse a changed story, edit the requirement: Gate 1 goes stale and the Thinker Agent runs again.');
  process.exit(0);
}
if (agent === 'test-case' && stage.stage !== 'generate') {
  const why =
    stage.stage === 'analyse'
      ? 'there is no analysis yet. Run the Thinker Agent first.'
      : stage.stage === 'blocked'
        ? `${stage.open.length} question(s) are still open. Answer them, then approve the analysis (Gate 1).`
        : `Gate 1 is not approved: ${stage.reason}`;
  console.log(`Test Case Agent cannot start for ${label}: ${why}`);
  process.exit(0);
}
if (process.argv.includes('--generate')) {
  console.warn('! --generate is gone: Gate 1 decides. Record answers with `npm run clarify`, then `npm run approve-analysis`.\n');
}
if (stage.stage === 'approval') {
  console.log(`Gate 1 — the analysis for ${label} is waiting for a person.`);
  console.log(`  ${stage.reason}`);
  console.log('');
  console.log('Read the analysis, then approve it:');
  console.log(`  npm run approve-analysis -- --feature ${label} --by "<your name>" --minutes <n>`);
  console.log('');
  console.log('Test cases are generated only after that.');
  process.exit(0);
}
if (stage.stage === 'blocked' && process.argv.includes('--run')) {
  console.log(`${stage.open.length} question(s) for ${label} are still open — nothing to run until they are answered.`);
  console.log('');
  stage.open.forEach((q, i) => console.log(`  ${i + 1}. [${q.id}] ${q.question}`));
  console.log('');
  console.log(`Answer: npm run clarify -- --feature ${label} --answer <Q-n> --text "..." --by "<your name>"`);
  process.exit(0);
}
const phase = { phase: stage.stage as 'analyse' | 'blocked' | 'generate', open: stage.open, reason: stage.reason };
const analysisTemplate = readIfPresent(path.join(PATHS.thinking, 'ANALYSIS_TEMPLATE.md'));
const coverageChecklist = readIfPresent(path.join(PATHS.thinking, 'COVERAGE_CHECKLIST.md'));
const generationGuide = readIfPresent(path.join(PATHS.thinking, 'TEST_GENERATION_GUIDE.md'));
const observed = readIfPresent(
  path.join(PATHS.knowledge, 'observed', `${featureName ?? 'default'}.md`),
);

// Recall from earlier runs, so each analysis builds on the last instead of
// starting from zero every time.
const idPrefix = arg('prefix');
const history = renderHistory(buildHistory(idPrefix));

/**
 * What Gate 3 taught us about this feature. Confirmed defects say where the
 * bugs live: test deeper there (neighbouring inputs, the same flow from another
 * role, the same rule elsewhere). Rejected ones say what the product does on
 * purpose: never assert those again. Without this, every analysis starts as if
 * no one had ever tested the feature.
 */
const lessons = (() => {
  const mine = listDefects().filter((d) => featureOfDefect(d) === (featureName ?? 'default'));
  const confirmed = mine.filter((d) => d.status === 'confirmed');
  const rejected = mine.filter((d) => d.status === 'rejected');
  if (!confirmed.length && !rejected.length) return '';
  const strip = (t: string) => t.replace(/^\[[^\]]+\]\s*/, '');
  return [
    '# What review has taught us about this feature',
    '',
    ...(confirmed.length
      ? [
          `**Confirmed defects (${confirmed.length}).** Bugs cluster: design extra cases around each of these (the same rule with other inputs, the same flow for other roles and screen sizes, the neighbouring steps). Each already has a regression test; do not duplicate it.`,
          '',
          ...confirmed.map((d) => `* [${d.severity}] ${strip(d.title)}${d.human_review?.ticket ? ` (${String(d.human_review.ticket)})` : ''}`),
          '',
        ]
      : []),
    ...(rejected.length
      ? [
          `**Rejected as not a defect (${rejected.length}).** The product does these on purpose, or they were noise. Never write an outcome that asserts the opposite.`,
          '',
          ...rejected.map((d) => `* ${strip(d.title)}${d.human_review?.note ? ` — ${String(d.human_review.note)}` : ''}`),
          '',
        ]
      : []),
  ].join('\n');
})();

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
 * What Gate 2 already decided, so a second generation builds on it instead of
 * starting over: cases that exist (do not duplicate), cases a reviewer sent
 * back with a change request (rewrite exactly those), and cases a reviewer
 * rejected (do not propose again).
 */
const existingCases = [
  ...listIntents(PATHS.intentsDraft).map((f) => ({ f, state: 'draft' })),
  ...listIntents(PATHS.intentsApproved).map((f) => ({ f, state: 'approved' })),
  ...listIntents(PATHS.intentsRejected).map((f) => ({ f, state: 'rejected' })),
]
  .map(({ f, state }) => ({ intent: readIntentFile(f) as TestIntent & { rejection?: { reason?: string } }, state }))
  .filter(({ intent }) => !featureName || intent.feature === featureName);
const openRework = loadFeedback(featureName).filter((r) => r.status === 'open');
const reworkIds = new Set(openRework.map((r) => r.test_id));

const gate2Lines: string[] = existingCases.length
  ? [
      '',
      '## Gate 2 so far — build on it',
      '',
      'These test cases already exist. Do not duplicate them and do not reuse their ids;',
      'new cases continue the numbering after the highest id below.',
      '',
      ...existingCases.map(({ intent, state }) =>
        `* \`${intent.test_id}\` [${reworkIds.has(intent.test_id) ? 'REWORK' : state}] ${intent.test_objective}${
          state === 'rejected' && intent.rejection?.reason ? ` — rejected: ${intent.rejection.reason}` : ''
        }`,
      ),
      '',
      ...(openRework.length
        ? [
            '### Rework requested by the reviewer — rewrite exactly these',
            '',
            'Return each one rewritten, with the **same test_id**, applying the request. Change',
            'nothing the request does not ask for. If a request contradicts the requirement or an',
            'answered clarification, do not apply it: raise it as a new question instead.',
            '',
            ...openRework.flatMap((r) => {
              const current = existingCases.find((c) => c.intent.test_id === r.test_id)?.intent;
              return [
                `#### ${r.test_id} — requested by ${r.requested_by}`,
                '',
                ...r.request.split('\n').map((l) => `> ${l}`),
                '',
                ...(current ? ['```json', JSON.stringify(current, null, 2), '```', ''] : []),
              ];
            }),
          ]
        : []),
      'Rejected cases are listed so you do not propose them again, in any wording.',
    ]
  : [];

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
        ...(featureName ? [`* Set \`"feature": "${featureName}"\` on every intent, exactly. It is the key every tool selects by, not a display name.`] : []),
        `* Fill \`requirement_ref\` with \`"locator": "${requirementLocator}"\` (exactly this path) and the sentence it comes from,`,
        '  copied **verbatim**. `npm run verify` holds back any intent whose quote is not',
        '  in the requirement, documentation or a clarification answer.',
        '* Tag every intent with `coverage.category`, and mark anything the browser',
        '  agent cannot run as `execution_mode: "manual"` with a reason.',
        '* Use `not_verifiable_yet` for what the intent *should* check but nothing can.',
        ...gate2Lines,
        '* Before declaring the run complete, ensure every checklist category has',
        '  a primary intent or mission, or an explicit not-applicable decision in',
        '  the analysis. Then run `npm run coverage -- --check --drafts` and repair',
        '  every reported gap. Do not ask for approval while this gate fails.',
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
        'Once the answers are recorded and a person approves this analysis (Gate 1),',
        '`npm run think` switches to the generate phase and asks for the intents.',
        'Write the analysis for that reader: they approve your gaps, risk ranking,',
        'smoke set and not-applicable decisions, and every test case inherits them.',
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

const pack = `# QA Thinker Agent — prompt pack

Generated ${new Date().toISOString()} by \`npm run think\`.

**Run this with \`${cfg.model}\` at effort \`${cfg.effort}\`.** Requirement analysis
is the task of finding what *is not stated*, which is where reasoning depth
actually pays — do not downgrade the model to save ${cfg.cost_note ?? 'a few cents'}.

---

${systemPrompt}

---

# Inputs

${section('Application context', appContext, 'yaml')}
${section(`Requirement under test — \`${requirementLocator}\``, requirement)}
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

## Observed application state — pre-build

_Not captured._ The front-end has not been built yet, or its URL is not known, so
there is nothing to look at. **That is the expected state for this phase, not a
problem to work around.** Work from the requirement alone:

* Describe what the actor achieves and what must be observably true — never where
  it happens on a screen. Nobody knows the screens yet, including you.
* Copy \`requirement_ref.quote\` **verbatim** from the requirement, documentation or
  a clarification answer. \`npm run verify\` holds back any test whose quote cannot
  be found there — a paraphrase is indistinguishable from an invented rule.
* Every requirement section should be cited by at least one test case; verify
  reports the ones nobody cites.

Once a URL exists, the Execution Agent captures the real pages, binds each approved
intent to them, and \`npm run verify\` re-checks everything before a single test runs.
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
` : ''}${lessons ? `---

${lessons}
` : ''}
---

# Coverage checklist — work through every category

${coverageChecklist ?? '(checklist missing)'}

---

# Thorough test generation guide — required

${generationGuide ?? '(generation guide missing)'}

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

if (process.argv.includes('--run')) {
  const started = Date.now();
  const minutes = () => ((Date.now() - started) / 60_000).toFixed(1);
  console.log(`${phase.phase === 'generate' ? 'Test Case Agent — writing test cases' : 'Thinker Agent — analysing, finding gaps'} for ${label}`);
  console.log(`  ${cfg.model} at effort ${cfg.effort}, via Claude Code on the subscription`);
  console.log(`  prompt pack ${rel(outFile)} (~${Math.round(pack.length / 4).toLocaleString()} tokens)`);
  console.log('  This takes several minutes at high effort. Nothing is printed until it finishes.');
  console.log('');
  try {
    if (phase.phase === 'generate') {
      const r = await runGenerate(featureName, pack, cfg, {
        overwrite: process.argv.includes('--overwrite'),
        requirementLocator,
        rework: reworkIds,
      });
      console.log(`Done in ${minutes()} min (${r.model}).`);
      console.log('');
      console.log(`  Draft test cases written  ${r.written.length}${r.written.length ? `  (${r.written.join(', ')})` : ''}`);
      if (r.reworked.length) console.log(`  Rework applied            ${r.reworked.join(', ')}`);
      const missed = [...reworkIds].filter((id) => !r.reworked.includes(id));
      if (missed.length) console.log(`  ! Rework NOT returned for ${missed.join(', ')} — still open; run again or edit by hand`);
      if (r.relocated) console.log(`  ! ${r.relocated} requirement_ref locator(s) named no real file — set to ${requirementLocator}`);
      for (const s of r.skipped) console.log(`  ! skipped ${s.id}: ${s.reason}`);
      for (const b of r.invalid) {
        console.log(`  ✗ ${b.id} failed the schema even after one repair — not saved:`);
        for (const e of b.errors.slice(0, 5)) console.log(`      ${e}`);
      }
      for (const w of r.warnings) for (const msg of w.warnings) console.log(`  ⚠ ${w.id}: ${msg}`);
      console.log(`  Coverage audit            ${rel(r.auditFile)}`);
      for (const s of r.sheets) console.log(`  Test case sheet           ${rel(s.file)} (${s.total} cases)`);
      console.log(`  Raw response              ${rel(r.rawFile)}`);
      if (r.questions.length) {
        console.log('');
        console.log(`It found ${r.questions.length} NEW gap(s) while writing — added to ${rel(ledgerFile)}:`);
        r.questions.forEach((q, i) => console.log(`  ${i + 1}. [${q.id}] ${q.question}`));
        console.log('Gate 1 is now stale until they are answered and the analysis is re-approved.');
      }
      console.log('');
      console.log('Next — Gate 2, test case review:');
      console.log(`  npm run verify -- --feature ${label}`);
      console.log('  npm run coverage -- --check --drafts');
      console.log('  fill the Gate 2 Decision column in the sheet above, then:');
      console.log(`  npm run approve-sheet -- --feature ${label} --by "<your name>" --minutes <n>`);
      console.log('  (or decide in chat: /test-cases, or npm run decide)');
    } else {
      const r = await runAnalyse(featureName, pack, cfg, { requirementLocator });
      console.log(`Done in ${minutes()} min (${r.model}).`);
      console.log('');
      console.log(`  Analysis      ${rel(r.analysisFile)}`);
      console.log(`  Raw response  ${rel(r.rawFile)}`);
      console.log('');
      if (r.questions.length) {
        console.log(`Questions for the requirement owner — added to ${rel(ledgerFile)}:`);
        console.log('');
        r.questions.forEach((q, i) => {
          console.log(`  ${i + 1}. [${q.id}] ${q.question}`);
          if (q.why) console.log(`     why: ${q.why}`);
        });
        console.log('');
        console.log('Next: answer each one, then approve the analysis (Gate 1):');
        console.log(`  npm run clarify -- --feature ${label} --answer <Q-n> --text "..." --by "<your name>"`);
      } else {
        console.log('No open questions. Next: read the analysis and approve it (Gate 1):');
      }
      console.log(`  npm run approve-analysis -- --feature ${label} --by "<your name>" --minutes <n>`);
    }
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  The prompt pack is still at ${rel(outFile)} — it can be pasted into Claude by hand.`);
    process.exit(1);
  }
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
console.log(`  Generation guide ${generationGuide ? 'yes (thorough coverage)' : 'NO — shallow generation risk'}`);
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
console.log(`  ${observed ? 6 : 5}. npm run validate  &&  npm run verify -- --feature ${featureName ?? '<feature>'}`);
console.log(
  `  ${observed ? 7 : 6}. npm run coverage -- --check --drafts`,
);
console.log(
  `  ${observed ? 8 : 7}. npm run test-cases`,
);
console.log(
  `  ${observed ? 9 : 8}. npm run approve-sheet -- --feature ${featureName ?? '<feature>'} --by "<your name>" --minutes <n>`,
);
console.log('');

if (!observed) {
  console.log('No page capture for this feature (pre-build), so the pack asks for intents only.');
  console.log('That is the correct output before a front-end exists — a mission written');
  console.log('now would have an invented target in every step. When the build lands:');
  console.log(`  npm run inspect -- --feature ${featureName ?? '<feature>'} --url <URL>`);
  console.log('');
}
