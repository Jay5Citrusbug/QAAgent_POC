/**
 * Where a feature is in the pipeline, and what happens next.
 *
 *   npm run status -- --feature login
 *   npm run status                      # every feature
 *
 * Read-only. One answer to "where are we with X?" — the question asked most
 * in chat — instead of five commands to piece it together.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadAppContext, PATHS, rel } from '../src/config.js';
import { analysisGate, thinkingStage } from '../src/analysis-gate.js';
import { loadLedger } from '../src/clarifications.js';
import { listDefects } from '../src/defect.js';
import { latestResult } from '../src/healing.js';
import { loadFeedback } from '../src/intent-approval.js';
import { isApproved as isIntentApproved, listIntents, readIntentFile } from '../src/intents.js';
import { featureSlug, sheetPath } from '../src/test-case-sheet.js';
import { isApproved as isMissionApproved, missionInFeature, readMissionFile } from '../src/validate.js';
import { hasRealUrl } from '../src/verify.js';
import type { TestMission } from '../src/types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function features(): string[] {
  const dir = path.join(PATHS.root, 'input');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => d.startsWith('feature-')).map((d) => d.slice('feature-'.length)).sort();
}

function intentsIn(dir: string, feature: string) {
  return listIntents(dir)
    .map((f) => {
      try {
        return readIntentFile(f);
      } catch {
        return undefined;
      }
    })
    .filter((i) => i && (i.feature === feature || featureSlug(i) === feature)) as ReturnType<typeof readIntentFile>[];
}

function missionsIn(dir: string, feature: string): TestMission[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return readMissionFile(path.join(dir, f));
      } catch {
        return undefined;
      }
    })
    .filter((m): m is TestMission => Boolean(m && missionInFeature(m, feature)));
}

function report(feature: string): void {
  const stage = thinkingStage(feature);
  const gate1 = analysisGate(feature);
  const ledger = loadLedger(feature);
  const open = ledger.questions.filter((q) => q.status === 'open');
  const requirement = path.join(PATHS.root, 'input', `feature-${feature}`, 'requirement.md');
  const acs = fs.existsSync(requirement) ? (fs.readFileSync(requirement, 'utf8').match(/^#{2,3} .*\bAC-\d+/gm) ?? []).length : 0;

  const drafts = intentsIn(PATHS.intentsDraft, feature);
  const approved = intentsIn(PATHS.intentsApproved, feature).filter(isIntentApproved);
  const rejected = intentsIn(PATHS.intentsRejected, feature);
  const rework = loadFeedback(feature).filter((r) => r.status === 'open');

  const missionDrafts = missionsIn(PATHS.missionsDraft, feature);
  const missionsApproved = missionsIn(PATHS.missionsApproved, feature).filter(isMissionApproved);
  const runs = { PASS: 0, FAIL: 0, BLOCKED: 0, INCONCLUSIVE: 0, 'not run': 0 } as Record<string, number>;
  for (const m of missionsApproved) {
    const status = latestResult(m.test_id)?.result.status ?? 'not run';
    runs[status] = (runs[status] ?? 0) + 1;
  }

  const ids = new Set([...drafts, ...approved, ...rejected].map((i) => i.test_id));
  const defects = listDefects().filter((d) => (d.test_id ? ids.has(d.test_id) : d.title.startsWith(`[${feature}]`)));
  const toReview = defects.filter((d) => d.status === 'candidate').length;
  const toPost = defects.filter((d) => d.status === 'confirmed' && !d.human_review?.ticket).length;

  let url = false;
  try {
    url = hasRealUrl(loadAppContext(feature));
  } catch {
    /* no context yet */
  }

  const line = (k: string, v: string) => console.log(`  ${k.padEnd(18)} ${v}`);
  console.log(`■ ${feature}`);
  line('Story', fs.existsSync(requirement) ? `${rel(requirement)} (${acs} acceptance criteria)` : 'not imported');
  line('Questions', `${ledger.questions.length} total, ${open.length} open`);
  line('Gate 1 (analysis)', gate1.state === 'missing' ? 'not approved' : `${gate1.state} — ${gate1.approval.approved_by}`);
  line('Test cases', `${drafts.length} draft · ${approved.length} approved · ${rejected.length} rejected · ${rework.length} rework open`);
  if (fs.existsSync(sheetPath(feature))) line('Sheet', rel(sheetPath(feature)));
  line('Build URL', url ? 'set' : 'not set (Stage 3 waits for it)');
  if (missionDrafts.length || missionsApproved.length) {
    line('Missions', `${missionDrafts.length} awaiting Gate 2.5 · ${missionsApproved.length} approved`);
    line('Last results', Object.entries(runs).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(' · ') || '—');
  }
  if (defects.length) line('Defects', `${toReview} to review · ${toPost} confirmed, not in Jira · ${defects.length} total`);

  // The single next thing to do. Order is the pipeline order.
  let next: string;
  if (!fs.existsSync(requirement)) next = 'Import the story (Thinker Agent): npm run story -- --feature <name> --prefix <XX> --from <file>';
  else if (stage.stage === 'analyse') next = 'Thinker Agent: run the analysis';
  else if (stage.stage === 'blocked') next = `Answer ${open.length} open question(s), then approve the analysis (Gate 1)`;
  else if (stage.stage === 'approval') next = `Gate 1: approve the analysis${gate1.state === 'stale' ? ` (stale: ${gate1.reasons.join(' ')})` : ''}`;
  else if (drafts.length === 0 && approved.length === 0) next = 'Test Case Agent: generate the test cases';
  else if (rework.length) next = `Test Case Agent: apply ${rework.length} rework request(s)`;
  else if (drafts.length) next = `Gate 2: review ${drafts.length} draft test case(s)`;
  else if (!url) next = 'Waiting for the build: set BASE_URL, then Execution Agent';
  else if (missionsApproved.length === 0 && missionDrafts.length === 0) next = 'Execution Agent: inspect and bind the approved test cases';
  else if (missionDrafts.length) next = `Gate 2.5: approve ${missionDrafts.length} bound mission(s)`;
  else if (runs['not run']) next = 'Execution Agent: run the tests';
  else if (toReview) next = `Gate 3: review ${toReview} defect(s) in reports/DEFECT-REVIEW.html`;
  else if (toPost) next = `Post ${toPost} confirmed defect(s) to Jira, then record the keys`;
  else next = 'Nothing waiting. Re-run the Execution Agent on the next build.';
  line('NEXT', next);
  console.log('');
}

const only = arg('feature');
const list = only ? [only] : features();
if (!list.length) {
  console.log('No features yet. Start with the Thinker Agent: import a story.');
  process.exit(0);
}
for (const f of list) report(f);
