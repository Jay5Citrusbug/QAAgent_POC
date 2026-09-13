import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import YAML from 'yaml';
import type { AppContext } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');

export const PATHS = {
  root: ROOT,
  schemas: path.join(ROOT, 'schemas'),
  knowledge: path.join(ROOT, 'knowledge'),
  appContext: path.join(ROOT, 'knowledge', 'application-context.yaml'),
  locatorCache: path.join(ROOT, 'knowledge', 'locator-cache.json'),
  missionsDraft: path.join(ROOT, 'missions', 'draft'),
  missionsApproved: path.join(ROOT, 'missions', 'approved'),
  /**
   * [R3] Test intents — written before the application exists, so they live
   * beside the missions rather than inside them. Gate 1 moves draft →
   * approved here; the binding phase (Agent 2a) reads approved/ and writes
   * missions/draft/.
   */
  intentsDraft: path.join(ROOT, 'intents', 'draft'),
  intentsApproved: path.join(ROOT, 'intents', 'approved'),
  thinking: path.join(ROOT, 'agent', 'thinking'),
  thinkingConfig: path.join(ROOT, 'agent', 'thinking', 'config.yaml'),
  /** Generated prompt packs — rebuildable, so gitignored. */
  thinkingPrompts: path.join(ROOT, 'thinking', 'prompts'),
  /** Committed analysis — the gaps found are often worth more than the missions. */
  thinkingAnalysis: path.join(ROOT, 'thinking', 'analysis'),
  /**
   * [R4] Structured page captures, one per inspection, never overwritten.
   * knowledge/observed/<feature>.md is for reading; this is the kept series
   * a build diff compares against. Without it there is nothing to diff.
   */
  captures: path.join(ROOT, 'knowledge', 'captures'),
  /** Paste-ready defect reports, one file per fingerprint. */
  defects: path.join(ROOT, 'reports', 'defects'),
  runs: path.join(ROOT, 'runs'),
  reports: path.join(ROOT, 'reports'),
  fixtures: path.join(ROOT, 'fixtures'),
  auth: path.join(ROOT, '.auth'),
} as const;

/** Minimal .env reader — no dependency, and it never logs a value. */
function loadDotEnv(): void {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

/**
 * Resolve the input/knowledge paths for a named feature.
 *
 * POC-1 is deliberately single-feature (VISION section 14), but a second
 * feature was added to test the Thinking Agent without disturbing the first —
 * so a feature name selects `input/feature-<name>/` and
 * `knowledge/application-context-<name>.yaml` instead of the defaults. This is
 * intentionally minimal: it is not general multi-project support, only enough
 * to keep two features from overwriting each other's inputs.
 */
export function featurePaths(feature?: string): {
  requirementDir: string;
  documentationFile: string;
  existingTestsFile: string;
  appContextFile: string;
} {
  const dirName = feature ? `feature-${feature}` : 'feature';
  const requirementDir = path.join(ROOT, 'input', dirName);
  const appContextFile = feature
    ? path.join(PATHS.knowledge, `application-context-${feature}.yaml`)
    : PATHS.appContext;
  return {
    requirementDir,
    documentationFile: path.join(requirementDir, 'documentation.md'),
    existingTestsFile: path.join(requirementDir, 'existing-tests.md'),
    appContextFile,
  };
}

export function loadAppContext(feature?: string): AppContext {
  const file = feature ? featurePaths(feature).appContextFile : PATHS.appContext;
  const ctx = YAML.parse(fs.readFileSync(file, 'utf8')) as AppContext;
  // BASE_URL from the environment wins, so a real STAGE host never has to be
  // committed to the context file.
  const override = process.env.BASE_URL;
  if (override) ctx.application.base_url = override;
  return ctx;
}

export interface ThinkingConfig {
  model: string;
  effort: string;
  cost_note?: string;
  output?: { analysis?: string; prompts?: string; missions?: string };
}

/**
 * The Thinking Agent's model, as a committed decision rather than whatever tab
 * happened to be open. THINKING_MODEL overrides it for one run.
 */
export function loadThinkingConfig(): ThinkingConfig {
  const fallback: ThinkingConfig = { model: 'claude-opus-5', effort: 'high' };
  if (!fs.existsSync(PATHS.thinkingConfig)) return fallback;
  const parsed = YAML.parse(fs.readFileSync(PATHS.thinkingConfig, 'utf8')) as Partial<ThinkingConfig>;
  return {
    ...fallback,
    ...parsed,
    model: process.env.THINKING_MODEL ?? parsed.model ?? fallback.model,
    effort: process.env.THINKING_EFFORT ?? parsed.effort ?? fallback.effort,
  };
}

/**
 * Flags are read from argv as well as the environment, because
 * `HEADED=false cmd` is bash syntax that PowerShell rejects outright — and
 * this project runs on Windows. `--headless` works the same everywhere.
 */
const argvHas = (flag: string): boolean => process.argv.includes(`--${flag}`);

function argvValue(flag: string): string | undefined {
  const i = process.argv.indexOf(`--${flag}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

export const RUNTIME = {
  /** Headed by default: for a POC, watching it work is most of the value. */
  headed: argvHas('headless') ? false : argvHas('headed') ? true : process.env.HEADED !== 'false',
  slowMo: Number(argvValue('slow-mo') ?? process.env.SLOW_MO ?? 0),
  build: process.env.BUILD ?? 'unknown',
  /**
   * Give every mission its own untouched browser instead of reusing the one the
   * previous mission left open.
   *
   * Reuse is the default because it is both much faster and more faithful — a
   * shopper adds an item and clicks through to the cart in the window already
   * open, rather than reopening the site. The cost is that state carries over,
   * so this flag exists for the moment a result looks like it might belong to
   * the test before it.
   */
  freshState: argvHas('fresh-state') || process.env.FRESH_STATE === 'true',
  /** Kept for the eventual second browser; POC-1 is Chromium only. */
  browser: 'chromium' as const,
};

/** Path relative to the project root, for evidence listings. */
export function rel(p: string): string {
  return path.relative(ROOT, p).split(path.sep).join('/');
}
