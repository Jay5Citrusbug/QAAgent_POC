/**
 * Gate 1 — a person approves the requirement analysis.
 *
 *   npm run approve-analysis -- --feature login --by "jay.r" --minutes 12
 *   npm run approve-analysis -- --feature login --by "jay.r" --minutes 15 --edited
 *   npm run approve-analysis -- --feature login --status
 *
 * Refuses while any clarification is open: approving an analysis whose
 * questions are unanswered approves a guess. Test case generation
 * (`npm run think -- --run`) refuses until this has been done, and again
 * whenever the analysis, requirement or answers change afterwards.
 *
 * --minutes and --edited feed docs/BASELINE.md, as they do at Gate 2. If
 * reviewing the analysis costs as much as writing it would have, the agent is
 * not saving anyone time.
 */
import { rel } from '../src/config.js';
import { analysisGate, approvalPath, approveAnalysis, latestAnalysis } from '../src/analysis-gate.js';
import { loadLedger } from '../src/clarifications.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const feature = arg('feature');
const label = feature ?? 'default';
const analysis = latestAnalysis(feature);

if (has('status')) {
  const gate = analysisGate(feature);
  console.log(`Gate 1 for ${label}: ${gate.state.toUpperCase()}`);
  if (gate.state !== 'missing') console.log(`  approved by ${gate.approval.approved_by} at ${gate.approval.approved_at}`);
  for (const r of gate.reasons) console.log(`  - ${r}`);
  process.exit(gate.state === 'approved' ? 0 : 1);
}

const by = arg('by');
if (!by) {
  console.error('Refusing to approve anonymously. Pass --by "<your name>".');
  process.exit(1);
}
if (!analysis) {
  console.error(`No analysis for ${label} yet. Run the Thinker Agent: npm run thinker -- --feature ${label}`);
  process.exit(1);
}

const open = loadLedger(feature).questions.filter((q) => q.status === 'open');
if (open.length) {
  console.error(`Refusing: ${open.length} question(s) are still open. Approving now would approve a guess.`);
  for (const q of open) console.error(`  ${q.id}  ${q.question}`);
  console.error('');
  console.error(`Answer them: npm run clarify -- --feature ${label} --answer <Q-n> --text "..." --by "${by}"`);
  process.exit(1);
}

const minutes = arg('minutes');
const approval = approveAnalysis(feature, by, {
  ...(minutes !== undefined ? { minutes: Number(minutes) } : {}),
  edited: has('edited'),
});

console.log(`Gate 1 approved: ${approval.analysis_file}`);
console.log(`  by ${approval.approved_by} at ${approval.approved_at}`);
console.log(`  recorded in ${rel(approvalPath(feature))}`);
console.log('');
console.log('Next — the Test Case Agent writes the test cases from the approved analysis:');
console.log(`  npm run test-case-agent -- --feature ${label}`);
