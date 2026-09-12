/**
 * File what the model gave back.
 *
 *   npm run import -- --from response.md --feature ecommerce
 *   npm run import -- --from response.md --feature ecommerce --dry-run
 *
 * Takes the reply from a Claude conversation — claude.ai, Claude Code, any
 * seat you already pay for — and puts it where it belongs: the analysis into
 * thinking/analysis/, each mission into missions/draft/, validated on the way
 * in.
 *
 * This exists so the no-extra-cost path is not the awkward one. The API-backed
 * web UI bills per token on top of a subscription you already have; pasting
 * into a seat you are already paying for costs nothing, and the only thing
 * that made it worse was having to hand-file the output. Now you do not.
 *
 * Nothing here is overwritten without being told: an id that already exists is
 * reported and skipped unless --overwrite is given.
 */
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { PATHS, rel } from '../src/config.js';
import { lintMission } from '../src/validate.js';
import type { TestMission } from '../src/types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const from = arg('from');
const featureName = arg('feature');
const dryRun = has('dry-run');
const overwrite = has('overwrite');

if (!from) {
  console.error('Usage: npm run import -- --from <file> [--feature <name>] [--dry-run] [--overwrite]');
  console.error('  Save the model\'s whole reply to a file, then point --from at it.');
  process.exit(1);
}
if (!fs.existsSync(from)) {
  console.error(`No such file: ${from}`);
  process.exit(1);
}

const raw = fs.readFileSync(from, 'utf8');

/**
 * Pull every JSON object out of the reply, whether fenced or bare.
 *
 * Models wrap JSON in ``` fences most of the time but not always, and a reply
 * usually mixes prose, one analysis and several missions. Brace matching is
 * more forgiving than trying to pin down one exact shape.
 */
function extractJsonObjects(text: string): unknown[] {
  const found: unknown[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const slice = text.slice(i, j + 1);
          try {
            const parsed = JSON.parse(slice);
            const key = JSON.stringify(parsed);
            if (!seen.has(key)) {
              seen.add(key);
              found.push(parsed);
            }
          } catch {
            /* not valid JSON — keep scanning */
          }
          i = j; // continue after this object rather than inside it
          break;
        }
      }
    }
  }
  return found;
}

const objects = extractJsonObjects(raw);
const missions = objects.filter(
  (o): o is TestMission =>
    typeof o === 'object' && o !== null && 'test_id' in o && 'test_objective' in o,
);

// The analysis is the markdown left over once the JSON is removed — usually
// everything from the first heading onward.
const withoutJson = raw.replace(/```(?:json)?[\s\S]*?```/g, '').trim();
const analysisMatch = /(^|\n)(#{1,2} .*)$/s.exec(withoutJson);
const analysis = analysisMatch ? withoutJson.slice(analysisMatch.index).trim() : '';

console.log(`Read ${rel(path.resolve(from))}`);
console.log(`  ${missions.length} mission(s) found`);
console.log(`  analysis: ${analysis ? `${analysis.length} chars` : 'none detected'}`);
console.log('');

if (missions.length === 0 && !analysis) {
  console.error('Nothing usable found. Is this the model\'s full reply?');
  process.exit(1);
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(
  JSON.parse(fs.readFileSync(path.join(PATHS.schemas, 'test-mission.schema.json'), 'utf8')),
);

let written = 0;
let skipped = 0;

for (const mission of missions) {
  const testId = String(mission.test_id ?? '');
  if (!/^[A-Z]{2,4}-[0-9]{3}$/.test(testId)) {
    console.log(`  ✗ "${testId}" — not a valid test id, skipped.`);
    skipped += 1;
    continue;
  }

  if (!validate(mission)) {
    console.log(`  ✗ ${testId} — does not match the mission schema:`);
    for (const e of (validate.errors ?? []).slice(0, 4)) {
      console.log(`      ${e.instancePath || '/'} ${e.message ?? ''}`);
    }
    skipped += 1;
    continue;
  }

  const draft = path.join(PATHS.missionsDraft, `${testId}.json`);
  const approved = path.join(PATHS.missionsApproved, `${testId}.json`);
  const clash = fs.existsSync(draft) ? draft : fs.existsSync(approved) ? approved : undefined;
  if (clash && !overwrite) {
    // Overwriting an approved mission has destroyed real work before. Never
    // silently, and never without being asked.
    console.log(`  ! ${testId} — already exists at ${rel(clash)}, skipped. Use --overwrite to replace it.`);
    skipped += 1;
    continue;
  }

  const warnings = lintMission(mission);
  if (!dryRun) {
    fs.mkdirSync(PATHS.missionsDraft, { recursive: true });
    fs.writeFileSync(draft, `${JSON.stringify(mission, null, 2)}\n`, 'utf8');
  }
  console.log(`  ✓ ${testId} → ${rel(draft)}${dryRun ? '  (dry run)' : ''}`);
  for (const w of warnings) console.log(`      ! ${w}`);
  written += 1;
}

if (analysis) {
  const slug = featureName ?? 'analysis';
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(PATHS.thinkingAnalysis, `${slug}-${today}.md`);
  if (!dryRun) {
    fs.mkdirSync(PATHS.thinkingAnalysis, { recursive: true });
    fs.writeFileSync(file, analysis, 'utf8');
  }
  console.log('');
  console.log(`  ✓ analysis → ${rel(file)}${dryRun ? '  (dry run)' : ''}`);
}

console.log('');
console.log(`${written} written, ${skipped} skipped.${dryRun ? '  Nothing was actually saved (--dry-run).' : ''}`);
if (written > 0 && !dryRun) {
  console.log('');
  console.log('Next:  npm run validate');
  console.log(`       npm run approve -- <TEST_ID> --by "<your name>" --minutes <n>`);
}
