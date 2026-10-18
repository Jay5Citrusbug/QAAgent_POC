/**
 * Gate 2 — decisions on named test cases, for when review happens in chat
 * rather than in the sheet.
 *
 *   npm run decide -- --by "jay.r" --approve LG-001 LG-002 LG-005..LG-009 --minutes 10
 *   npm run decide -- --by "jay.r" --reject LG-003 --reason "Duplicate of LG-002"
 *   npm run decide -- --by "jay.r" --rework LG-004 --request "Use 3 failed attempts, not 5"
 *
 * One decision kind per call. Every approval runs the same checks as the
 * sheet and `approve-intent` (src/intent-approval.ts); reject needs a reason
 * and rework needs a request, for the same reasons as in the sheet. The sheet
 * is rebuilt afterwards so it always shows the current state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, rel } from '../src/config.js';
import { approveIntent, feedbackPath, rejectIntent, requestRework } from '../src/intent-approval.js';
import { readIntentFile } from '../src/intents.js';
import { buildSheets, featureSlug } from '../src/test-case-sheet.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Ids after a flag, up to the next flag. "LG-001..LG-004" expands to the range. */
function idsAfter(flag: string): string[] {
  const i = process.argv.indexOf(`--${flag}`);
  if (i === -1) return [];
  const out: string[] = [];
  for (const token of process.argv.slice(i + 1)) {
    if (token.startsWith('--')) break;
    for (const part of token.split(',').map((s) => s.trim()).filter(Boolean)) {
      const range = /^([A-Z]{2,4})-(\d{3})\.\.(?:([A-Z]{2,4})-)?(\d{3})$/.exec(part);
      if (range) {
        const [, prefix, from, , to] = range;
        for (let n = Number(from); n <= Number(to); n++) out.push(`${prefix}-${String(n).padStart(3, '0')}`);
      } else out.push(part);
    }
  }
  return out;
}

const by = arg('by');
const approve = idsAfter('approve');
const reject = idsAfter('reject');
const rework = idsAfter('rework');
const kinds = [approve, reject, rework].filter((l) => l.length).length;

if (!by || kinds !== 1) {
  console.error('Usage (one decision kind per call):');
  console.error('  npm run decide -- --by "<name>" --approve LG-001 LG-002 LG-005..LG-009 [--minutes N]');
  console.error('  npm run decide -- --by "<name>" --reject LG-003 --reason "<why>"');
  console.error('  npm run decide -- --by "<name>" --rework LG-004 --request "<what to change>"');
  process.exit(1);
}

const draftFile = (id: string) => path.join(PATHS.intentsDraft, `${id}.json`);
const features = new Set<string>();
const done: string[] = [];
const refused: { id: string; reasons: string[] }[] = [];

function featureOf(id: string): string | undefined {
  const file = draftFile(id);
  if (!fs.existsSync(file)) return undefined;
  const intent = readIntentFile(file);
  features.add(featureSlug(intent));
  return intent.feature;
}

if (approve.length) {
  const minutes = arg('minutes');
  const share = minutes !== undefined ? Math.round((Number(minutes) / approve.length) * 10) / 10 : undefined;
  for (const id of approve) {
    featureOf(id);
    const outcome = approveIntent(id, by, share !== undefined ? { minutes: share } : {});
    if (outcome.ok) done.push(id);
    else refused.push({ id, reasons: [...outcome.reasons, ...(outcome.hint ? [outcome.hint] : [])] });
  }
}

if (reject.length) {
  const reason = arg('reason');
  if (!reason) {
    console.error('Reject needs --reason "<why>" — the next generation reads it so the case is not proposed again.');
    process.exit(1);
  }
  for (const id of reject) {
    featureOf(id);
    const r = rejectIntent(id, by, reason);
    if (r.ok) done.push(id);
    else refused.push({ id, reasons: [r.reason] });
  }
}

let reworkFeature: string | undefined;
if (rework.length) {
  const request = arg('request');
  if (!request) {
    console.error('Rework needs --request "<what to change>".');
    process.exit(1);
  }
  for (const id of rework) {
    const feature = featureOf(id);
    if (!feature) {
      refused.push({ id, reasons: ['Not a draft (already approved or rejected, or no such id).'] });
      continue;
    }
    requestRework(feature, id, request, by);
    reworkFeature = feature;
    done.push(id);
  }
}

const verb = approve.length ? 'Approved' : reject.length ? 'Rejected' : 'Rework requested';
console.log(`${verb}: ${done.length ? done.join(', ') : 'none'}`);
for (const r of refused) {
  console.log(`  ✗ ${r.id}`);
  for (const reason of r.reasons) console.log(`      ${reason}`);
}
for (const feature of features) {
  const [s] = buildSheets(feature);
  if (s) console.log(`Sheet rebuilt: ${rel(s.file)} — ${s.approved} approved, ${s.draft} draft, ${s.rejected} rejected`);
}
if (reworkFeature && done.length) {
  console.log(`Rework saved to ${rel(feedbackPath(reworkFeature))}. Apply it: npm run test-case-agent -- --feature ${reworkFeature}`);
}
process.exit(refused.length ? 1 : 0);
