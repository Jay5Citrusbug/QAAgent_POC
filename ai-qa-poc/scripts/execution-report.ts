/**
 * Rebuild the execution report from results already on disk.
 *
 *   npm run execution-report -- --feature ecommerce
 *
 * The same report `npm run run-mission` writes automatically at the end of
 * every run. This regenerates it without touching the application — useful
 * after a human confirms or rejects a defect at Gate 3, since those decisions
 * change what the report says.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/config.js';
import { writeFinalReport } from '../src/final-report.js';
import type { ExecutionResult } from '../src/types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : undefined;
}

if (!fs.existsSync(PATHS.runs)) {
  console.error('No runs/ directory — nothing to report on yet.');
  process.exit(1);
}

/** Latest non-replay result per test id: a replay is the same run seen twice. */
const results: ExecutionResult[] = [];
for (const testId of fs.readdirSync(PATHS.runs).sort()) {
  const dir = path.join(PATHS.runs, testId);
  if (!fs.statSync(dir).isDirectory()) continue;
  const latest = fs
    .readdirSync(dir)
    .filter((d) => !d.endsWith('-replay'))
    .filter((d) => fs.existsSync(path.join(dir, d, 'result.json')))
    .sort()
    .at(-1);
  if (!latest) continue;
  results.push(JSON.parse(fs.readFileSync(path.join(dir, latest, 'result.json'), 'utf8')) as ExecutionResult);
}

if (results.length === 0) {
  console.error('No results found. Run some missions first: npm run run-mission');
  process.exit(1);
}

const file = writeFinalReport({ feature: arg('feature'), results });
console.log(`Execution report: ${file}`);
console.log(`  ${results.length} result(s) included.`);
