/**
 * Gate 2 — human approval of a test intent (one case).
 *
 * For a whole reviewed sheet, use `npm run approve-sheet`; both run the same
 * checks (src/intent-approval.ts).
 *
 *   npm run approve-intent -- LG-004 --by "jay.r" --minutes 3 --edited
 *
 * Moves intents/draft/LG-004.json to intents/approved/LG-004.json and stamps
 * the approval. Same mechanism as mission approval: a file move plus a git
 * commit, no tooling to build, a real audit trail.
 *
 * What this gate does that the mission gate cannot: it refuses an intent whose
 * expected behaviour rests on a question nobody has answered. VISION's first
 * hard rule for the Thinking Agent — never invent expected behaviour, report
 * the gap — was previously enforced by nothing at all. An intent asserting an
 * invented rule does not merely fail to help; it produces a confident false
 * defect, and a false defect costs more human QA time than reporting nothing.
 *
 * --minutes is not bureaucracy. The entire argument for splitting intent from
 * mission is that reviewing business intent should cost LESS than reviewing
 * locator descriptors. If this number is not smaller than the mission review
 * time in docs/BASELINE.md, the split is not paying for itself and should go.
 */
import { rel } from '../src/config.js';
import { approveIntent } from '../src/intent-approval.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const testId = process.argv[2];
if (!testId || testId.startsWith('--')) {
  console.error('Usage: npm run approve-intent -- <TEST_ID> --by "<name>" [--minutes <n>] [--edited]');
  process.exit(1);
}

const by = arg('by');
if (!by) {
  console.error('Refusing to approve anonymously. Pass --by "<your name>".');
  process.exit(1);
}

const minutes = arg('minutes');
const outcome = approveIntent(testId, by, {
  ...(minutes !== undefined ? { minutes: Number(minutes) } : {}),
  edited: process.argv.includes('--edited'),
});

if (!outcome.ok) {
  console.error(`${testId} cannot be approved:`);
  for (const r of outcome.reasons) console.error(`  ✗ ${r}`);
  if (outcome.hint) {
    console.error('');
    console.error('This intent asserts behaviour nobody has stated yet. Approving it would turn');
    console.error('a guess into something the system later reports as a product defect.');
    console.error(`  ${outcome.hint}`);
  }
  process.exit(1);
}

for (const w of outcome.warnings) console.warn(`  ! ${w}`);
for (const n of outcome.notes) console.log(n);
console.log('');
console.log(`Approved intent ${testId} — ${by} at ${outcome.intent.approval?.approved_at}`);
console.log(`  ${rel(outcome.from)} → ${rel(outcome.to)}`);
console.log('');
console.log('This intent is now waiting on a front-end URL. When the build lands, the');
console.log('Execution Agent binds it to the real page in one pass before any mission');
console.log('runs, and a human reviews only the bindings it could not settle cleanly.');
