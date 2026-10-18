import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';
import type { TestMission } from './types.js';

/**
 * Requirement drift detection.
 *
 * A mission is approved against a requirement as it read on that day. If the
 * requirement is later edited and the mission is not, the mission silently
 * stops testing what it claims to test — and the approval stamp still looks
 * valid. Nothing else in the system can catch that: the mission is still
 * schema-valid, still in approved/, still passes.
 *
 * So `content_hash` is filled in at approval time and checked before each run.
 */

/** `input/feature/requirement.md#r-1--create-a-workpod` → the file path only. */
export function localeFilePath(locator: string): string | undefined {
  const withoutFragment = locator.split('#')[0];
  if (!withoutFragment) return undefined;
  // Only local files can be hashed. Ticket ids and URLs cannot.
  if (/^[a-z]+:\/\//i.test(withoutFragment)) return undefined;
  const resolved = path.resolve(PATHS.root, withoutFragment);
  if (!resolved.startsWith(PATHS.root)) return undefined;
  return fs.existsSync(resolved) ? resolved : undefined;
}

export function hashFile(file: string): string {
  // Normalise line endings so a Windows/Unix checkout difference is not
  // mistaken for a requirement change.
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)}`;
}

/** The hash of the requirement this mission points at, when it is a local file. */
export function hashRequirement(mission: TestMission): string | undefined {
  const locator = mission.requirement_ref?.locator;
  if (!locator) return undefined;
  const file = localeFilePath(locator);
  return file ? hashFile(file) : undefined;
}

export type DriftVerdict =
  | { state: 'match' }
  | { state: 'no_requirement_ref' }
  | { state: 'not_hashable'; locator: string }
  | { state: 'not_recorded' }
  | { state: 'drifted'; recorded: string; current: string; locator: string };

/**
 * Compare the recorded hash against the requirement on disk right now.
 *
 * Deliberately returns a verdict rather than throwing: drift is a fact for a
 * human to weigh, not an error. Some edits are typo fixes; some invalidate the
 * whole mission. Only a person can tell which.
 */
export function checkRequirementDrift(mission: TestMission): DriftVerdict {
  const ref = mission.requirement_ref;
  if (!ref?.locator) return { state: 'no_requirement_ref' };

  const file = localeFilePath(ref.locator);
  if (!file) return { state: 'not_hashable', locator: ref.locator };

  if (!ref.content_hash) return { state: 'not_recorded' };

  const current = hashFile(file);
  return current === ref.content_hash
    ? { state: 'match' }
    : { state: 'drifted', recorded: ref.content_hash, current, locator: ref.locator };
}

/** One line for a log or a report. */
export function describeDrift(verdict: DriftVerdict): string | undefined {
  switch (verdict.state) {
    case 'drifted':
      return (
        `The requirement at ${verdict.locator} has changed since this mission was approved ` +
        `(recorded ${verdict.recorded}, now ${verdict.current}). The mission may no longer test what it claims. ` +
        `Re-read it at Gate 2 and re-approve.`
      );
    case 'not_recorded':
      return 'No content_hash recorded, so a change to the requirement since approval cannot be detected.';
    case 'not_hashable':
      return `Requirement ${verdict.locator} is not a local file, so drift cannot be detected automatically.`;
    case 'no_requirement_ref':
      return 'No requirement_ref: this result cannot be traced back to a requirement.';
    case 'match':
      return undefined;
  }
}
