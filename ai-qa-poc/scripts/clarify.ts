/**
 * The clarification ledger — read it, answer it, add to it.
 *
 *   npm run clarify                                  # every question, and what it blocks
 *   npm run clarify -- --feature login               # a named feature's ledger
 *   npm run clarify -- --open                        # only what is still unanswered
 *   npm run clarify -- --add "What happens on the 6th failed attempt?" --why "LG-004 asserts lockout the requirement never states"
 *   npm run clarify -- --answer Q-1 --text "Locked for 15 minutes." --by "jay.r"
 *   npm run clarify -- --answer Q-2 --text "Assume 15 minutes until Product confirms." --by "jay.r" --assumed
 *
 * Answering here rather than by hand-editing the YAML is not ceremony: it
 * stamps who and when, and it is the only place that re-checks which approved
 * intents were resting on the answer that just changed. An answer revised
 * quietly is how a suite ends up testing a rule nobody agreed to.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { PATHS, rel } from '../src/config.js';
import {
  describe,
  hashAnswer,
  ledgerPath,
  loadLedger,
  nextId,
  type Clarification,
} from '../src/clarifications.js';
import { listIntents, readIntentFile } from '../src/intents.js';
import type { TestIntent } from '../src/types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const feature = arg('feature');
const file = ledgerPath(feature);

/** Every intent, draft or approved, that declares a dependency. */
function dependants(): Map<string, TestIntent[]> {
  const map = new Map<string, TestIntent[]>();
  const files = [...listIntents(PATHS.intentsDraft), ...listIntents(PATHS.intentsApproved)];
  for (const f of files) {
    let intent: TestIntent;
    try {
      intent = readIntentFile(f);
    } catch {
      continue; // A malformed intent is validate's problem, not this tool's.
    }
    if (feature && intent.feature !== feature) continue;
    for (const id of intent.depends_on_clarifications ?? []) {
      map.set(id, [...(map.get(id) ?? []), intent]);
    }
  }
  return map;
}

// --- Add a question ---------------------------------------------------------

if (has('add')) {
  const question = arg('add');
  if (!question) {
    console.error('Usage: npm run clarify -- --add "<question>" [--why "<why it matters>"]');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  // parseDocument rather than parse: a hand-written ledger carries comments,
  // and a tool that silently eats a colleague's note is a tool people stop
  // using.
  const doc = fs.existsSync(file)
    ? YAML.parseDocument(fs.readFileSync(file, 'utf8'))
    : YAML.parseDocument(`feature: ${feature ?? 'default'}\nquestions: []\n`);

  const ledger = loadLedger(feature);
  const id = nextId(ledger);
  const entry: Clarification = {
    id,
    question,
    ...(arg('why') ? { why: arg('why') } : {}),
    status: 'open',
    answer: null,
    raised_at: new Date().toISOString().slice(0, 10),
  };

  const questions = doc.get('questions');
  if (YAML.isSeq(questions)) questions.add(entry);
  else doc.set('questions', [entry]);

  fs.writeFileSync(file, doc.toString(), 'utf8');
  console.log(`Added ${id} to ${rel(file)}`);
  console.log(`  ${question}`);
  console.log('');
  console.log('An intent that depends on this cannot be approved until it is answered.');
  console.log(`Declare it in the intent as: "depends_on_clarifications": ["${id}"]`);
  process.exit(0);
}

// --- Answer a question ------------------------------------------------------

if (has('answer')) {
  const id = arg('answer');
  const text = arg('text');
  const by = arg('by');
  const isAssumption = has('assumed');

  if (!id || !text) {
    console.error('Usage: npm run clarify -- --answer <Q-n> --text "<answer>" --by "<name>" [--assumed]');
    process.exit(1);
  }
  if (!by) {
    console.error('Refusing to answer anonymously. Pass --by "<your name>".');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`No ledger at ${rel(file)}. Add a question first with --add.`);
    process.exit(1);
  }

  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  const questions = doc.get('questions');
  if (!YAML.isSeq(questions)) {
    console.error(`${rel(file)} has no questions list.`);
    process.exit(1);
  }

  const node = questions.items.find((item) => YAML.isMap(item) && item.get('id') === id);
  if (!node || !YAML.isMap(node)) {
    console.error(`No question ${id} in ${rel(file)}.`);
    process.exit(1);
  }

  const previous = node.get('answer') as string | null;
  node.set('answer', text);
  node.set('status', isAssumption ? 'assumed' : 'answered');
  node.set('answered_by', by);
  node.set('answered_at', new Date().toISOString());
  fs.writeFileSync(file, doc.toString(), 'utf8');

  console.log(`${id} → ${isAssumption ? 'assumed' : 'answered'} by ${by}`);
  if (isAssumption) {
    console.log('');
    console.log('Recorded as an ASSUMPTION, not a confirmation. Intents depending on it');
    console.log('will be stamped assumption: true, and that rides into the run report so');
    console.log('nobody reads a guess as an agreed requirement.');
  }

  // The part that cannot be done by editing the file: tell the human which
  // already-approved intents were resting on the previous answer.
  if (previous && previous !== text) {
    const affected = (dependants().get(id) ?? []).filter((i) => i.approval);
    if (affected.length) {
      const now = hashAnswer({ id, question: '', status: 'answered', answer: text });
      console.log('');
      console.log(`! The answer changed, and ${affected.length} APPROVED intent(s) rest on it:`);
      for (const i of affected) {
        const recorded = i.approval?.clarification_hashes?.[id];
        const stale = recorded !== undefined && recorded !== now;
        console.log(`    ${i.test_id}${stale ? '  ← STALE, re-review at Gate 2' : ''}`);
      }
      console.log('');
      console.log('They are still in intents/approved/ and their approval stamps still look');
      console.log('valid. That is precisely the problem — re-read them.');
    }
  }

  process.exit(0);
}

// --- List -------------------------------------------------------------------

const ledger = loadLedger(feature);

if (ledger.questions.length === 0) {
  console.log(`No clarifications recorded for ${feature ?? 'the default feature'}.`);
  console.log(`  (ledger would live at ${rel(file)})`);
  console.log('');
  console.log('That is not necessarily good news. A requirement with no open questions');
  console.log('is either unusually complete or has not been read closely enough.');
  process.exit(0);
}

const deps = dependants();
const onlyOpen = has('open');
const shown = onlyOpen ? ledger.questions.filter((q) => q.status === 'open') : ledger.questions;

console.log(rel(file));
console.log('');

for (const q of shown) {
  console.log(describe(q));
  if (q.why) console.log(`      why: ${q.why}`);
  if (q.answer) console.log(`      answer: ${q.answer}`);
  const blocked = deps.get(q.id) ?? [];
  if (blocked.length) {
    const names = blocked.map((i) => i.test_id).join(', ');
    console.log(`      ${q.status === 'open' ? 'BLOCKS' : 'used by'}: ${names}`);
  }
  console.log('');
}

const open = ledger.questions.filter((q) => q.status === 'open');
const assumedCount = ledger.questions.filter((q) => q.status === 'assumed').length;

console.log(
  `${ledger.questions.length} question(s): ${open.length} open, ` +
    `${ledger.questions.length - open.length - assumedCount} answered, ${assumedCount} assumed.`,
);

if (open.length) {
  const blockedIntents = new Set(open.flatMap((q) => (deps.get(q.id) ?? []).map((i) => i.test_id)));
  if (blockedIntents.size) {
    console.log('');
    console.log(
      `${blockedIntents.size} intent(s) cannot pass Gate 2 until these are answered: ` +
        `${[...blockedIntents].sort().join(', ')}`,
    );
  }
  console.log('');
  console.log('Answer one:');
  console.log(`  npm run clarify --${feature ? ` --feature ${feature}` : ''} --answer ${open[0]?.id} --text "..." --by "your name"`);
}
