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
  return value.replaceAll('{run_id}', runId);
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
