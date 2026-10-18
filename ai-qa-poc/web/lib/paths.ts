import fs from 'node:fs';
import path from 'node:path';

/**
 * The web app lives at ai-qa-poc/web/ and reads/writes the parent project.
 *
 * Deliberately no duplicated copies of the system prompt, the schema, or the
 * application context: the frontend is a different way to drive the same
 * Thinking Agent, not a second one. If SYSTEM_PROMPT.md changes, the UI picks
 * it up on the next run with no code change.
 */
export const PROJECT_ROOT = path.resolve(process.cwd(), '..');

export const P = {
  root: PROJECT_ROOT,
  systemPrompt: path.join(PROJECT_ROOT, 'agent', 'thinking', 'SYSTEM_PROMPT.md'),
  analysisTemplate: path.join(PROJECT_ROOT, 'agent', 'thinking', 'ANALYSIS_TEMPLATE.md'),
  thinkingConfig: path.join(PROJECT_ROOT, 'agent', 'thinking', 'config.yaml'),
  missionSchema: path.join(PROJECT_ROOT, 'schemas', 'test-mission.schema.json'),
  knowledge: path.join(PROJECT_ROOT, 'knowledge'),
  missionsDraft: path.join(PROJECT_ROOT, 'missions', 'draft'),
  missionsApproved: path.join(PROJECT_ROOT, 'missions', 'approved'),
  analysisDir: path.join(PROJECT_ROOT, 'thinking', 'analysis'),
  runs: path.join(PROJECT_ROOT, 'runs'),
  reports: path.join(PROJECT_ROOT, 'reports'),
  defects: path.join(PROJECT_ROOT, 'reports', 'defects'),
} as const;

export function readIfPresent(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

/** Application context files, so the UI can offer a feature picker. */
export function listFeatures(): { id: string; label: string; contextFile: string }[] {
  if (!fs.existsSync(P.knowledge)) return [];
  const out: { id: string; label: string; contextFile: string }[] = [];
  for (const f of fs.readdirSync(P.knowledge)) {
    const m = /^application-context(?:-(.+))?\.yaml$/.exec(f);
    if (!m) continue;
    const id = m[1] ?? 'default';
    out.push({ id, label: id === 'default' ? 'Default (WorkPod)' : id, contextFile: path.join(P.knowledge, f) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Guard every write: a test_id becomes a filename, and it arrives from model
 * output. Anything but the documented id shape is refused rather than
 * sanitised — a silently renamed mission is worse than a rejected one.
 */
export function assertSafeTestId(testId: string): void {
  if (!/^[A-Z]{2,4}-[0-9]{3}$/.test(testId)) {
    throw new Error(`Refusing to write "${testId}": test_id must look like EC-001.`);
  }
}

export function assertSafeSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/i.test(slug)) {
    throw new Error(`Refusing to write "${slug}": use letters, digits and hyphens only.`);
  }
}
