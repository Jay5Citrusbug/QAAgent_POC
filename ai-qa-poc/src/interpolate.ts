import type { TargetSpec } from './types.js';

/**
 * Substitute run-scoped placeholders.
 *
 * `{run_id}` is the important one. Without it, forty runs of a creation test
 * leave forty identically named records on STAGE and a polluted starting state
 * for every later mission.
 *
 * This lives in its own module because both the action layer and the discovery
 * layer need it, and a mission that interpolates the value it types but not the
 * name it later looks for will fail hunting a literal "{run_id}".
 */
export function interpolate(value: string | undefined, runId: string): string | undefined {
  if (value === undefined) return undefined;
  let out = value.replaceAll('{run_id}', runId);
  const saved = SAVED.get(runId);
  if (saved && out.includes('{saved.')) {
    out = out.replace(/\{saved\.([A-Za-z0-9_]+)\}/g, (whole, name: string) => saved.get(name) ?? whole);
  }
  return out;
}

/**
 * Values an `api_request` step saved from a response, per run: the id of the
 * order it created, the token of the invite it sent. `{saved.<name>}` anywhere
 * `{run_id}` works — a URL, a typed value, an element name, an expected value —
 * so a test can create through the API and check through the UI, or the
 * reverse. Scoped to one run id, so a replay saves its own.
 */
const SAVED = new Map<string, Map<string, string>>();

export function saveValue(runId: string, name: string, value: string): void {
  if (!SAVED.has(runId)) SAVED.set(runId, new Map());
  SAVED.get(runId)!.set(name, value);
}

export function forgetSaved(runId: string): void {
  SAVED.delete(runId);
}

/** Placeholders still unfilled after interpolation: a step used a value nobody saved. */
export function unfilledSaved(text: string): string[] {
  return [...text.matchAll(/\{saved\.([A-Za-z0-9_]+)\}/g)].map((m) => m[1]!);
}

/** Interpolate every human-authored string in a target, including nested scopes. */
export function interpolateTarget(target: TargetSpec, runId: string): TargetSpec {
  return {
    ...target,
    description: interpolate(target.description, runId) as string,
    ...(target.name !== undefined ? { name: interpolate(target.name, runId) } : {}),
    ...(target.label !== undefined ? { label: interpolate(target.label, runId) } : {}),
    ...(target.placeholder !== undefined
      ? { placeholder: interpolate(target.placeholder, runId) }
      : {}),
    ...(target.text !== undefined ? { text: interpolate(target.text, runId) } : {}),
    ...(target.within ? { within: interpolateTarget(target.within, runId) } : {}),
  };
}
