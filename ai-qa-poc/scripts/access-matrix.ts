/**
 * Try every role against every protected page.
 *
 *   npm run access-matrix -- --feature login
 *
 * Reads `access:` from knowledge/application-context-<feature>.yaml:
 *
 *   access:
 *     - path: /admin
 *       allow: [Admin]
 *     - path: /account
 *       allow: [Customer, Admin]
 *
 * Writes reports/ACCESS-MATRIX-<feature>.md, and turns every leak and every
 * wrong refusal into a defect candidate for Gate 3 (reports/DEFECT-REVIEW.html).
 * Nothing is confirmed automatically.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadAppContext, PATHS, rel } from '../src/config.js';
import { renderMatrix, runAccessMatrix } from '../src/access.js';
import { fromFinding, upsert, writeReport } from '../src/defect.js';
import { writeDefectReview } from '../src/defect-review.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const feature = arg('feature');
if (!feature) {
  console.error('Usage: npm run access-matrix -- --feature <name>');
  process.exit(1);
}
const ctx = loadAppContext(feature);
if (!ctx.access?.length) {
  console.error(`No access rules in knowledge/application-context-${feature}.yaml. Add an "access:" list (see the header of this script).`);
  process.exit(1);
}

const cells = await runAccessMatrix(ctx, feature);
fs.mkdirSync(PATHS.reports, { recursive: true });
const file = path.join(PATHS.reports, `ACCESS-MATRIX-${feature}.md`);
fs.writeFileSync(file, renderMatrix(feature, ctx, cells), 'utf8');

let defects = 0;
for (const c of cells) {
  if (c.actual === 'blocked' || c.actual === c.expected) continue;
  const leak = c.actual === 'allowed';
  const candidate = fromFinding(
    {
      kind: leak ? 'access_leak' : 'access_refused',
      severity: leak ? 'high' : 'medium',
      summary: leak ? `${c.role} can open ${c.path}, which only ${(ctx.access.find((r) => r.path === c.path)?.allow ?? []).join(', ') || 'nobody'} may open` : `${c.role} is refused ${c.path}, which it should be able to open`,
      detail: `${c.evidence}${c.screenshot ? `\nScreenshot: ${c.screenshot}` : ''}`,
      url: new URL(c.path, ctx.application.base_url).toString(),
      count: 1,
    },
    { url: new URL(c.path, ctx.application.base_url).toString(), feature, build: ctx.application.build },
  );
  upsert(candidate);
  writeReport(candidate);
  defects++;
}
const review = writeDefectReview();

const leaks = cells.filter((c) => c.actual === 'allowed' && c.expected === 'denied').length;
const refused = cells.filter((c) => c.actual === 'denied' && c.expected === 'allowed').length;
const blocked = cells.filter((c) => c.actual === 'blocked').length;
console.log(`Access matrix: ${rel(file)}`);
console.log(`  ${cells.length} cell(s): ${leaks} leak(s), ${refused} wrongly refused, ${blocked} not run`);
if (defects) console.log(`  ${defects} defect candidate(s) → ${review.file} (Gate 3)`);
process.exit(leaks || refused ? 1 : 0);
