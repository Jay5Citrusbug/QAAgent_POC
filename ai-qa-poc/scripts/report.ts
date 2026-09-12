/**
 * Rebuild the Markdown report from results already on disk.
 *
 *   npm run report                # latest run of every test id
 *   npm run report -- SM-001      # one test id
 *
 * Useful after a human edits `human_review` on a result at Gate 2 — the report
 * regenerates without re-running anything against STAGE.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, rel } from '../src/config.js';
import { writeReport } from '../src/report.js';
import type { ExecutionResult } from '../src/types.js';

const filter = process.argv[2];

if (!fs.existsSync(PATHS.runs)) {
  console.error('No runs/ directory yet — nothing to report on.');
  process.exit(1);
}

const results: ExecutionResult[] = [];

for (const testId of fs.readdirSync(PATHS.runs).sort()) {
  if (filter && testId !== filter) continue;
  const testDir = path.join(PATHS.runs, testId);
  if (!fs.statSync(testDir).isDirectory()) continue;

  // Newest run wins; replay directories are suffixed and skipped here because
  // the replay outcome is already summarised on the parent result.
  const runs = fs
    .readdirSync(testDir)
    .filter((d) => !d.endsWith('-replay'))
    .filter((d) => fs.existsSync(path.join(testDir, d, 'result.json')))
    .sort();

  const latest = runs.at(-1);
  if (!latest) continue;

  const file = path.join(testDir, latest, 'result.json');
  results.push(JSON.parse(fs.readFileSync(file, 'utf8')) as ExecutionResult);
}

if (results.length === 0) {
  console.error(filter ? `No results for ${filter}.` : 'No results found.');
  process.exit(1);
}

const out = writeReport(results);
console.log(`Report: ${rel(out)}  (${results.length} result(s))`);
