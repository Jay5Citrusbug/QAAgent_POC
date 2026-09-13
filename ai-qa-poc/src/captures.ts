import fs from 'node:fs';
import path from 'node:path';
import { PATHS, RUNTIME } from './config.js';
import type { PageReality } from './inspector.js';

/**
 * Versioned page captures.
 *
 * `npm run inspect` has always written `knowledge/observed/<feature>.md` for
 * the Thinking Agent to read, and always overwritten it. That is right for the
 * prompt pack — the agent wants what is true now, not a history — but it means
 * the previous build's reality is destroyed the moment a new one is captured.
 *
 * Build diff (VISION §7b) needs the opposite: a kept series. "The 'Remember me'
 * checkbox is gone" is only sayable if something remembers that it was there.
 * So the structured capture is kept alongside the rendered markdown, one file
 * per inspection, and nothing is ever overwritten.
 *
 * These are cheap — a few KB of JSON per build — and they are the only record
 * of what a page looked like before someone changed it.
 */

export interface Capture {
  feature: string;
  captured_at: string;
  build: string;
  base_url?: string;
  pages: PageReality[];
  /**
   * States reached partway through a flow — the checkout form, a filtered grid,
   * a cart with something in it. `pages` only ever holds the initial state of
   * each URL, and a large class of UI does not exist until someone has acted.
   */
  states?: { from: string; afterStep: string; did: string; page: PageReality }[];
}

export function captureDir(feature?: string): string {
  return path.join(PATHS.captures, feature ?? 'default');
}

/** Sortable, human-readable, filename-safe. */
function stamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

export function saveCapture(
  pages: PageReality[],
  feature?: string,
  baseUrl?: string,
  states?: Capture['states'],
): string {
  const capture: Capture = {
    feature: feature ?? 'default',
    captured_at: new Date().toISOString(),
    build: RUNTIME.build,
    ...(baseUrl ? { base_url: baseUrl } : {}),
    pages,
    ...(states && states.length ? { states } : {}),
  };

  const dir = captureDir(feature);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp(capture.captured_at)}-${capture.build}.json`);
  fs.writeFileSync(file, `${JSON.stringify(capture, null, 2)}\n`, 'utf8');
  return file;
}

/** Oldest first, so the last entry is always the most recent. */
export function listCaptures(feature?: string): string[] {
  const dir = captureDir(feature);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join(dir, f));
}

export function readCapture(file: string): Capture {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Capture;
}

export function latestCapture(feature?: string): Capture | undefined {
  const files = listCaptures(feature);
  const last = files[files.length - 1];
  return last ? readCapture(last) : undefined;
}

/**
 * The two captures a build diff compares: the most recent, and the one before.
 *
 * Returns undefined for `previous` on the first ever capture — which is not an
 * error, just nothing to say yet.
 */
export function capturePair(feature?: string): { current?: Capture; previous?: Capture } {
  const files = listCaptures(feature);
  return {
    current: files.length >= 1 ? readCapture(files[files.length - 1] as string) : undefined,
    previous: files.length >= 2 ? readCapture(files[files.length - 2] as string) : undefined,
  };
}
