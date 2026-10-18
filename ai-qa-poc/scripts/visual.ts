/**
 * Visual baselines — list them, and approve the latest screenshot as the
 * baseline a test is compared with from now on.
 *
 *   npm run visual -- --list
 *   npm run visual -- --approve LG-001 LG-002 --by "jay.r"     # every screen size those tests ran at
 *   npm run visual -- --approve LG-001 --size 390x844 --by "jay.r"
 *   npm run visual -- --approve-new --by "jay.r"                # every test that has no baseline yet
 *
 * Approving is a person saying "this is how it should look". It is never done
 * automatically: a baseline adopted silently would make the first broken build
 * the standard every later one is held to.
 */
import { listBaselines, approveBaseline } from '../src/visual.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function idsAfter(flag: string): string[] {
  const i = process.argv.indexOf(`--${flag}`);
  if (i === -1) return [];
  const out: string[] = [];
  for (const t of process.argv.slice(i + 1)) {
    if (t.startsWith('--')) break;
    out.push(t);
  }
  return out;
}

const all = listBaselines();

if (has('list') || process.argv.length <= 2) {
  if (!all.length) {
    console.log('No screenshots yet. Every test run saves one per test and screen size.');
    process.exit(0);
  }
  console.log('Test        Size        Baseline');
  for (const b of all) {
    const state = b.hasBaseline
      ? `approved by ${b.approved?.approved_by ?? '?'} on ${b.approved?.approved_at.slice(0, 10) ?? '?'}`
      : 'NONE — candidate waiting for approval';
    console.log(`${b.testId.padEnd(11)} ${b.viewport.padEnd(11)} ${state}`);
  }
  console.log('');
  console.log('Approve: npm run visual -- --approve <TEST_ID ...> --by "<name>"   (or --approve-new)');
  process.exit(0);
}

const by = arg('by');
if (!by) {
  console.error('Refusing to approve anonymously. Pass --by "<your name>".');
  process.exit(1);
}

const size = arg('size');
const ids = idsAfter('approve');
const targets = has('approve-new')
  ? all.filter((b) => !b.hasBaseline && b.hasCandidate)
  : all.filter((b) => ids.includes(b.testId) && b.hasCandidate && (!size || b.viewport === size));

if (!targets.length) {
  console.error(has('approve-new') ? 'Every test with a screenshot already has a baseline.' : `No screenshots for ${ids.join(', ') || '(no ids given)'}${size ? ` at ${size}` : ''}. Run the tests first.`);
  process.exit(1);
}

for (const t of targets) {
  const file = approveBaseline(t.testId, t.viewport, by);
  console.log(`✓ ${t.testId} at ${t.viewport} → ${file}`);
}
console.log('');
console.log('From the next run, these tests are compared with what you just approved.');
