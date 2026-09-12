import type { Locator, Page } from '@playwright/test';
import { interpolateTarget } from './interpolate.js';
import { describeNearMisses, findNearMisses, readControls } from './near-miss.js';
import type { LocatorCache } from './locator-cache.js';
import type { Confidence, LocatorCacheEntry, ResolutionStrategy, TargetSpec } from './types.js';

/**
 * Element resolution.
 *
 * Two rules govern everything here:
 *
 *  1. Semantic first. Role and accessible name, then label, placeholder, text,
 *     test id. A raw selector only when the mission explicitly supplies one,
 *     and it is recorded as low confidence. Never a coordinate.
 *
 *  2. Never silently pick. If nothing matches, or several things match and the
 *     mission did not say expect_multiple, we stop and report. Clicking a
 *     plausible-looking neighbour manufactures a result that looks real and is
 *     not — which is the worst failure mode this system has.
 *
 * Note on the LLM boundary: POC-1 has no LLM integration, so "semantic
 * discovery" is deterministic matching of the mission's descriptor against the
 * live accessibility tree. `resolveTarget` is exactly where a model-driven
 * resolver plugs in later, and `describeCandidates` already produces the
 * accessibility context such a resolver would need.
 */

export class TargetNotFoundError extends Error {
  readonly kind = 'target_not_found';
  constructor(
    readonly target: TargetSpec,
    readonly attempted: string[],
    readonly snapshot?: string,
    /**
     * What the page actually offers instead. "Not found" alone cannot
     * distinguish a broken feature from a renamed control from a mission
     * describing something that never existed — and those need different
     * responses. This is the look a human takes before giving up.
     */
    readonly nearMisses?: string,
  ) {
    super(
      `Could not identify "${target.description}". Tried: ${attempted.join(', ') || 'nothing'}. ` +
        (nearMisses ? `${nearMisses} ` : '') +
        `Reporting rather than guessing.`,
    );
  }
}

export class TargetAmbiguousError extends Error {
  readonly kind = 'target_ambiguous';
  constructor(
    readonly target: TargetSpec,
    readonly count: number,
    readonly strategy: ResolutionStrategy,
  ) {
    super(
      `"${target.description}" matched ${count} elements via ${strategy}. ` +
        `The mission did not set expect_multiple, so the agent will not choose one.`,
    );
  }
}

export interface Resolved {
  /** The single element to act on — narrowed by nth, or the first match. */
  locator: Locator;
  /**
   * The unnarrowed matching set. A `count` assertion must measure this; the
   * narrowed locator above would always report 1.
   */
  all: Locator;
  /** How many elements matched at resolution time. */
  count: number;
  strategy: ResolutionStrategy;
  confidence: Confidence;
  /** Human-readable form of the locator, for the trace and the step log. */
  description: string;
  /** What to write back to the cache. */
  descriptor: Partial<LocatorCacheEntry>;
}

type Candidate = {
  strategy: ResolutionStrategy;
  locator: Locator;
  description: string;
  confidence: Confidence;
  descriptor: Partial<LocatorCacheEntry>;
};

function quote(s: string): string {
  return `'${s.replace(/'/g, "\\'")}'`;
}

/** Build the ordered list of strategies to try for a target. */
function candidatesFor(scope: Page | Locator, t: TargetSpec): Candidate[] {
  const out: Candidate[] = [];

  if (t.test_id) {
    out.push({
      strategy: 'test_id',
      locator: scope.getByTestId(t.test_id),
      description: `getByTestId(${quote(t.test_id)})`,
      confidence: 'HIGH',
      descriptor: { test_id: t.test_id },
    });
  }

  if (t.role && t.name) {
    out.push({
      strategy: 'role_name',
      locator: scope.getByRole(t.role as Parameters<Page['getByRole']>[0], {
        name: t.name,
        exact: t.exact ?? false,
      }),
      description: `getByRole(${quote(t.role)}, { name: ${quote(t.name)}${t.exact ? ', exact: true' : ''} })`,
      confidence: 'HIGH',
      descriptor: { role: t.role, name: t.name },
    });
  } else if (t.role) {
    // Role alone is frequently ambiguous; it is tried, but honestly labelled.
    out.push({
      strategy: 'role_name',
      locator: scope.getByRole(t.role as Parameters<Page['getByRole']>[0]),
      description: `getByRole(${quote(t.role)})`,
      confidence: 'MEDIUM',
      descriptor: { role: t.role },
    });
  }

  if (t.label) {
    out.push({
      strategy: 'label',
      locator: scope.getByLabel(t.label, { exact: t.exact ?? false }),
      description: `getByLabel(${quote(t.label)})`,
      confidence: 'HIGH',
      descriptor: { label: t.label },
    });
  }

  if (t.placeholder) {
    out.push({
      strategy: 'placeholder',
      locator: scope.getByPlaceholder(t.placeholder, { exact: t.exact ?? false }),
      description: `getByPlaceholder(${quote(t.placeholder)})`,
      confidence: 'MEDIUM',
      descriptor: { placeholder: t.placeholder },
    });
  }

  if (t.text) {
    out.push({
      strategy: 'text',
      locator: scope.getByText(t.text, { exact: t.exact ?? false }),
      description: `getByText(${quote(t.text)})`,
      confidence: 'MEDIUM',
      descriptor: { text: t.text },
    });
  }

  if (t.selector) {
    // Deliberately last and deliberately LOW: a raw selector is a fact about
    // today's DOM, not about the product.
    out.push({
      strategy: 'selector',
      locator: scope.locator(t.selector),
      description: `locator(${quote(t.selector)})`,
      confidence: 'LOW',
      descriptor: { selector: t.selector },
    });
  }

  return out;
}

/** Turn a cache entry back into a candidate. */
function candidateFromCache(scope: Page | Locator, entry: LocatorCacheEntry): Candidate | undefined {
  const t: TargetSpec = {
    description: entry.description ?? 'cached element',
    role: entry.role,
    name: entry.name,
    label: entry.label,
    placeholder: entry.placeholder,
    text: entry.text,
    test_id: entry.test_id,
    selector: entry.selector,
  };
  const [first] = candidatesFor(scope, t);
  if (!first) return undefined;
  return { ...first, strategy: 'cache', confidence: 'HIGH' };
}

async function countWithin(locator: Locator, timeoutMs: number): Promise<number> {
  try {
    await locator.first().waitFor({ state: 'attached', timeout: timeoutMs });
  } catch {
    return 0;
  }
  return locator.count();
}

/**
 * Resolve a semantic target against the live page.
 *
 * Order: cache → test id → role+name → label → placeholder → text → selector.
 * A cache hit that no longer matches records a miss and falls through; the
 * cache is an accelerator, never an authority.
 */
export async function resolveTarget(
  page: Page,
  rawTarget: TargetSpec,
  cache: LocatorCache,
  opts: {
    timeoutMs: number;
    maxAttempts: number;
    /** Set by a `count` assertion, which is *about* the size of the matching set. */
    allowMultiple?: boolean;
    /** Substituted into the descriptor, so a target can name what a step created. */
    runId?: string;
  },
): Promise<Resolved> {
  // Interpolate here rather than at each call site: a mission that substitutes
  // the value it types but not the name it later looks for would spend its
  // whole budget hunting a literal "{run_id}".
  const target = opts.runId ? interpolateTarget(rawTarget, opts.runId) : rawTarget;

  // Scope first, so "the button inside the dialog that just opened" does not
  // match a stale control elsewhere on the page. The scope itself must still be
  // unambiguous, whatever the caller allows for the target.
  let scope: Page | Locator = page;
  if (target.within) {
    const parent = await resolveTarget(page, target.within, cache, {
      ...opts,
      allowMultiple: false,
    });
    scope = parent.locator;
  }

  const attempted: string[] = [];
  const ordered: Candidate[] = [];

  if (target.capability_key) {
    const entry = cache.get(target.capability_key);
    if (entry) {
      const cached = candidateFromCache(scope, entry);
      if (cached) ordered.push(cached);
    }
  }
  ordered.push(...candidatesFor(scope, target));

  let attempts = 0;
  for (const candidate of ordered) {
    if (attempts >= opts.maxAttempts) break;
    attempts += 1;
    attempted.push(`${candidate.strategy}:${candidate.description}`);

    const count = await countWithin(candidate.locator, opts.timeoutMs);

    if (count === 0) {
      if (candidate.strategy === 'cache' && target.capability_key) {
        cache.miss(target.capability_key);
      }
      continue;
    }

    if (count > 1 && !target.expect_multiple && !opts.allowMultiple) {
      // Not an error we can paper over. Reporting an ambiguous match is far
      // cheaper than acting on the wrong element.
      throw new TargetAmbiguousError(target, count, candidate.strategy);
    }

    const locator =
      target.nth !== undefined ? candidate.locator.nth(target.nth) : candidate.locator.first();

    if (candidate.strategy === 'cache' && target.capability_key) {
      cache.hit(target.capability_key);
    } else if (target.capability_key) {
      cache.record(
        target.capability_key,
        candidate.strategy,
        candidate.descriptor,
        target.description,
      );
    }

    return {
      locator,
      all: candidate.locator,
      count,
      strategy: candidate.strategy,
      confidence: candidate.confidence,
      description: candidate.description,
      descriptor: candidate.descriptor,
    };
  }

  // Before giving up, look at what IS there. Costs one page evaluation on a
  // path that has already failed, and turns a dead end into a lead.
  const [candidates, allControls] = await Promise.all([
    findNearMisses(page, target),
    readControls(page),
  ]);
  throw new TargetNotFoundError(
    target,
    attempted,
    await describeCandidates(page, target),
    describeNearMisses(target, candidates, allControls.length),
  );
}

/**
 * A *targeted* accessibility snapshot, captured only when something has already
 * gone wrong. Full-page dumps on every step are exactly the cost VISION §11 is
 * trying to avoid, so this is diagnostic, not routine.
 */
export async function describeCandidates(page: Page, target?: TargetSpec): Promise<string> {
  try {
    const snapshot = await page.locator('body').ariaSnapshot({ timeout: 5_000 });
    if (!target?.role && !target?.name) return truncate(snapshot, 6_000);

    // Keep the lines plausibly related to what we were looking for.
    const needle = (target.name ?? target.role ?? '').toLowerCase();
    const lines = snapshot.split('\n');
    const relevant = lines.filter((l) => l.toLowerCase().includes(needle));
    const body = relevant.length > 0 ? relevant.join('\n') : snapshot;
    return truncate(body, 6_000);
  } catch {
    return '(accessibility snapshot unavailable)';
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… (truncated)`;
}
