/**
 * Phase 4 — bring a Jira story in as the requirement.
 *
 *   npm run story -- --feature login --jira PROJ-123                 # live, needs JIRA_* env
 *   npm run story -- --feature login --jira PROJ-123 PROJ-124 --with-comments
 *   npm run story -- --feature login --from exports/PROJ-123.json    # JSON export
 *   npm run story -- --feature login --from exports/sprint.xml       # Jira "Export → XML"
 *   npm run story -- --feature login --from story.txt                # text copied from the ticket
 *   npm run story -- --feature login --text "PROJ-9 Login ..."       # or pipe text on stdin
 *   ... --prefix LG      test-id prefix when the feature is new
 *   ... --dry-run        show the requirement, write nothing
 *
 * Creates the feature if it does not exist (pre-build — no URL needed), keeps
 * the raw ticket under input/feature-<name>/tickets/ so what the tests were
 * written from stays auditable, and writes requirement.md with one heading per
 * acceptance criterion.
 *
 * Re-importing a ticket replaces only that ticket's block. If tests were
 * already approved against the old text, `npm run verify` flags them for a
 * re-read — the requirement moved, so the tests may no longer test what it says.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { featurePaths, PATHS, rel } from '../src/config.js';
import { listIntents, readIntentFile } from '../src/intents.js';
import {
  fetchIssue,
  fromJsonExport,
  fromPlainText,
  fromXmlExport,
  jiraConfig,
  mergeIntoRequirement,
  renderTicket,
  type Ticket,
} from '../src/jira.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : undefined;
}
function args(name: string): string[] {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return [];
  const out: string[] = [];
  for (let j = i + 1; j < process.argv.length && !process.argv[j]!.startsWith('--'); j += 1) out.push(process.argv[j]!);
  return out;
}
const has = (n: string) => process.argv.includes(`--${n}`);

const feature = arg('feature');
const prefix = arg('prefix');
const keys = args('jira');
const from = arg('from');
const text = arg('text');
const dryRun = has('dry-run');
const withComments = has('with-comments');

if (!feature || !/^[a-z0-9][a-z0-9-]{0,30}$/i.test(feature)) {
  console.error('Usage: npm run story -- --feature <name> (--jira KEY [KEY...] | --from <file> | --text "<ticket text>") [--prefix XX] [--with-comments] [--dry-run]');
  process.exit(1);
}

// --- read the ticket(s) -------------------------------------------------------

const tickets: Ticket[] = [];
const raws: { key: string; ext: string; body: string }[] = [];

if (keys.length) {
  const cfg = jiraConfig();
  if ('missing' in cfg) {
    console.error(`Live Jira import needs ${cfg.missing} in the environment (or .env).`);
    console.error('No credentials? Export the ticket instead and use --from, or paste it with --text.');
    process.exit(1);
  }
  for (const key of keys) {
    try {
      const { ticket, raw } = await fetchIssue(cfg, key);
      tickets.push(ticket);
      raws.push({ key: ticket.key, ext: 'json', body: JSON.stringify(raw, null, 2) });
    } catch (err) {
      console.error(`✗ ${key}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
} else if (from) {
  if (!fs.existsSync(from)) {
    console.error(`No such file: ${from}`);
    process.exit(1);
  }
  const body = fs.readFileSync(from, 'utf8');
  const ext = path.extname(from).toLowerCase();
  const src = path.basename(from);
  if (ext === '.json') tickets.push(...fromJsonExport(JSON.parse(body), src, process.env.JIRA_AC_FIELD));
  else if (ext === '.xml' || /^\s*<\?xml|<rss/i.test(body)) tickets.push(...fromXmlExport(body, src));
  else tickets.push(fromPlainText(body, src, path.basename(from, ext).match(/[A-Z][A-Z0-9]+-\d+/)?.[0]));
  for (const t of tickets) raws.push({ key: t.key, ext: ext.replace('.', '') || 'txt', body });
} else {
  const body = text ?? (process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8'));
  if (!body.trim()) {
    console.error('Give a ticket with --jira, --from or --text (or pipe the text on stdin).');
    process.exit(1);
  }
  const t = fromPlainText(body, 'pasted text');
  tickets.push(t);
  raws.push({ key: t.key, ext: 'txt', body });
}

if (tickets.length === 0) {
  console.error('No tickets were found in that input.');
  process.exit(1);
}

// --- render -----------------------------------------------------------------

const paths = featurePaths(feature);
const reqFile = path.join(paths.requirementDir, 'requirement.md');
const title = feature.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

let requirement = fs.existsSync(reqFile) ? fs.readFileSync(reqFile, 'utf8') : '';
const before = requirement;
for (const t of tickets) requirement = mergeIntoRequirement(requirement, t, renderTicket(t, { withComments }), title);

if (dryRun) {
  console.log(requirement);
  process.exit(0);
}

// --- write --------------------------------------------------------------------

if (!fs.existsSync(paths.requirementDir)) {
  // Pre-build: a story arrives long before any URL does.
  execFileSync(
    process.execPath,
    [path.join(PATHS.root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(PATHS.root, 'scripts', 'new-feature.ts'), '--name', feature, ...(prefix ? ['--prefix', prefix] : [])],
    { stdio: 'ignore' },
  );
  console.log(`Created feature "${feature}" (pre-build — no URL needed yet).`);
  requirement = '';
  for (const t of tickets) requirement = mergeIntoRequirement(requirement, t, renderTicket(t, { withComments }), title);
}

fs.writeFileSync(reqFile, requirement.endsWith('\n') ? requirement : `${requirement}\n`, 'utf8');
const ticketDir = path.join(paths.requirementDir, 'tickets');
fs.mkdirSync(ticketDir, { recursive: true });
for (const r of raws) fs.writeFileSync(path.join(ticketDir, `${r.key}.${r.ext}`), r.body, 'utf8');

// --- report ---------------------------------------------------------------------

console.log('');
console.log(`Requirement: ${rel(reqFile)}`);
for (const t of tickets) {
  console.log(`  ${t.key} — ${t.summary}`);
  console.log(`    ${t.acceptance.length} acceptance criteria${t.acceptance.length ? '' : '  ⚠ none on the ticket — the Thinking Agent will ask instead of assuming'}`);
  if (t.links?.length || t.subtasks?.length) console.log(`    ${(t.links?.length ?? 0) + (t.subtasks?.length ?? 0)} related ticket(s) listed`);
}
console.log(`  raw ticket(s) kept in ${rel(ticketDir)}/`);

const approved = listIntents(PATHS.intentsApproved).map(readIntentFile).filter((i) => i.feature === feature);
if (before && before !== requirement && approved.length) {
  console.log('');
  console.log(`⚠ The requirement changed and ${approved.length} approved test case(s) were written against the old text.`);
  console.log(`  npm run verify -- --feature ${feature}     shows which ones to re-read`);
}

console.log('');
console.log('Next:');
console.log(`  1. npm run thinker -- --feature ${feature}${prefix ? ` --prefix ${prefix}` : ''}           Thinker Agent: analyse, raise questions`);
console.log(`  2. npm run clarify -- --feature ${feature} ...                 answer them`);
console.log(`     npm run approve-analysis -- --feature ${feature} --by "<you>"   Gate 1`);
console.log(`  3. npm run test-case-agent -- --feature ${feature}${prefix ? ` --prefix ${prefix}` : ''}   Test Case Agent: write the test cases`);
console.log(`  4. npm run verify -- --feature ${feature}, then Gate 2 in reports/TEST-CASES-${feature}.csv`);
console.log('');
console.log('Or in Claude Code chat: /thinker, /test-cases, /execute, /qa-status');
