/**
 * The numbers that decide whether this works.
 *
 *   npm run metrics                      # every feature
 *   npm run metrics -- --feature login   # one
 *   npm run metrics -- --write           # also save a dated copy to reports/
 *
 * VISION §15 lists what gets measured across the requirement set, and §17 names
 * the KPI. This computes everything that can be computed from what is already
 * on disk, and says plainly what cannot.
 *
 * Run it after each requirement rather than once at the end. The measures that
 * matter are trends — Gate 2 review minutes falling, the false-defect rate not
 * rising — and a trend reconstructed afterwards from whatever survived is not
 * the same thing as one that was watched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, rel } from '../src/config.js';
import { buildMetrics, renderMetrics } from '../src/metrics.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const all = buildMetrics(arg('feature'));

if (all.length === 0) {
  console.error(arg('feature') ? `Nothing recorded for "${arg('feature')}".` : 'No features found.');
  console.error('Start with:  npm run new-feature -- --name <name> --url <url> --prefix <XX>');
  process.exit(1);
}

const report = renderMetrics(all);
console.log(report);

if (has('write')) {
  fs.mkdirSync(PATHS.reports, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const file = path.join(PATHS.reports, `metrics-${stamp}.md`);
  fs.writeFileSync(file, `${report}\n`, 'utf8');
  console.log('');
  console.log(`Saved ${rel(file)}`);
  console.log('');
  console.log('Keep the dated copies. The comparison between requirement one and requirement');
  console.log('six is the deliverable — a single snapshot at the end proves much less.');
}
