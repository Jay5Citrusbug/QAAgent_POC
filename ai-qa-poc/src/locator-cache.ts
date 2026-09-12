import fs from 'node:fs';
import { PATHS } from './config.js';
import type { LocatorCacheEntry, LocatorCacheFile, ResolutionStrategy } from './types.js';

/**
 * The locator cache.
 *
 * Written by the executor after a successful resolution, not hand-maintained —
 * so the system gets faster on its own instead of depending on someone
 * remembering to update a file. A stale entry is never fatal: a miss falls
 * through to live discovery and the entry is re-recorded.
 *
 * Deleting this file is always safe. The only cost is one slower run.
 */
export class LocatorCache {
  private data: LocatorCacheFile;
  private dirty = false;

  constructor(private readonly file: string = PATHS.locatorCache) {
    this.data = fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, 'utf8')) as LocatorCacheFile)
      : { entries: {} };
    this.data.entries ??= {};
  }

  get(key: string): LocatorCacheEntry | undefined {
    return this.data.entries[key];
  }

  hit(key: string): void {
    const entry = this.data.entries[key];
    if (!entry) return;
    entry.hits = (entry.hits ?? 0) + 1;
    entry.last_confirmed = new Date().toISOString();
    this.dirty = true;
  }

  /**
   * A cached entry no longer matched. Recorded rather than deleted: repeated
   * misses on one key are the signature of a renamed control, which is worth a
   * human look.
   */
  miss(key: string): void {
    const entry = this.data.entries[key];
    if (!entry) return;
    entry.misses = (entry.misses ?? 0) + 1;
    this.dirty = true;
  }

  /** Record what live discovery found, so the next run skips the search. */
  record(
    key: string,
    strategy: ResolutionStrategy,
    descriptor: Partial<LocatorCacheEntry>,
    description?: string,
  ): void {
    if (strategy === 'cache' || strategy === 'none') return;
    const existing = this.data.entries[key];
    this.data.entries[key] = {
      description: description ?? existing?.description,
      strategy,
      hits: existing?.hits ?? 0,
      misses: existing?.misses ?? 0,
      last_confirmed: new Date().toISOString(),
      ...descriptor,
    };
    this.dirty = true;
  }

  /**
   * Only ever called after a PASS. Caching locators from a failed run would
   * bake in whatever went wrong.
   */
  save(): void {
    if (!this.dirty) return;
    fs.writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    this.dirty = false;
  }

  /** Keys whose misses outnumber their hits — candidates for human review. */
  suspectKeys(): string[] {
    return Object.entries(this.data.entries)
      .filter(([, e]) => (e.misses ?? 0) > (e.hits ?? 0) && (e.misses ?? 0) > 0)
      .map(([k]) => k);
  }
}
