import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { PATHS, rel } from './config.js';
import type { TestMission } from './types.js';

/**
 * One browser, reused across the missions of a run.
 *
 * Every mission used to launch Chromium, open a context, open a page, do three
 * or four things and close all of it again. Sixteen missions meant sixteen cold
 * starts, which is most of the wall-clock time of a run and is why watching one
 * looks like the home page opening over and over rather than a suite making
 * progress.
 *
 * It was also wrong, not merely slow. This application keeps the cart in the
 * page, so a mission that added an item and then re-opened the cart URL found
 * it empty and failed a feature that works. Reusing the page is what a person
 * does: add the item, then click through to the cart in the window already
 * open.
 *
 * ## The tradeoff, stated plainly
 *
 * Shared state between tests is test pollution, and test pollution is how a
 * suite starts reporting on the leftovers of the previous test. Two things keep
 * that honest here:
 *
 *  - a mission whose preconditions ask for a clean start gets one, always
 *  - every result records whether it ran on a fresh page or an inherited one,
 *    so a surprising outcome can be checked against what came before it
 *
 * `--fresh-state` on the runner turns reuse off entirely, which is the setting
 * to reach for when a result looks like it might be somebody else's leftovers.
 */

/** Preconditions that only hold in a browser nobody has used yet. */
const WANTS_CLEAN = [
  /\bstarts?\s+empty\b/i,
  /\bempty\s+(cart|basket|bag)\b/i,
  /\bnothing\s+(in|has been)\b/i,
  /\bno\s+(items?|products?)\s+(in|have)\b/i,
  /\b(clean|fresh|new)\s+(session|browser|state|visit)\b/i,
  /\bfirst[- ]time\b/i,
  /\b(logged|signed)\s+out\b/i,
  /\bnot\s+(logged|signed)\s+in\b/i,
];

export function needsCleanState(mission: TestMission): boolean {
  const text = [...(mission.preconditions ?? []), mission.starting_context?.page ?? ''].join(' ');
  return WANTS_CLEAN.some((r) => r.test(text));
}

/**
 * What makes two missions able to share a context at all.
 *
 * A signed-in context cannot be handed to a mission that must be anonymous, and
 * two roles must never see each other's session, so the key covers both.
 */
function authKey(mission: TestMission): string {
  const strategy = mission.auth?.strategy ?? 'storage_state';
  if (strategy !== 'storage_state') return 'anonymous';
  return `storage:${mission.auth?.storage_state_ref ?? mission.role.toLowerCase()}`;
}

export class AuthMissingError extends Error {
  readonly kind = 'auth_missing';
}

export class BrowserLaunchError extends Error {
  readonly kind = 'browser_launch';
}

export interface Lease {
  page: Page;
  context: BrowserContext;
  /** False when this mission got the page a previous mission left behind. */
  fresh: boolean;
  /** Named so a result can say where it started, e.g. "EC-016". */
  inheritedFrom?: string;
  resetReason?: string;
}

export type SessionStatePolicy = 'reuse' | 'fresh_page' | 'fresh_context' | 'read_only';

export class BrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private key?: string;
  private lastMission?: string;

  constructor(
    private readonly options: { headless: boolean; slowMo?: number; alwaysFresh?: boolean },
  ) {}

  private async launch(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    try {
      this.browser = await chromium.launch({
        headless: this.options.headless,
        ...(this.options.slowMo ? { slowMo: this.options.slowMo } : {}),
      });
    } catch (err) {
      throw new BrowserLaunchError(
        `Chromium would not start: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}. ` +
          'Run "npm run browsers".',
      );
    }
    return this.browser;
  }

  /**
   * A page for this mission — the one already open where that is allowed.
   *
   * `log` is the mission's own log, so the report says which of its steps ran
   * on inherited state. That line is the difference between a reused context
   * being an optimisation and it being a hidden variable.
   */
  async lease(mission: TestMission, log: (line: string) => void, forceFreshContext = false): Promise<Lease> {
    const browser = await this.launch();
    const key = authKey(mission);
    const policy: SessionStatePolicy = mission.execution_policy?.state ?? 'reuse';

    const why = forceFreshContext
      ? 'deterministic replay requested a fresh context'
      : this.options.alwaysFresh
      ? 'the run was started with --fresh-state'
      : policy === 'fresh_context'
        ? 'the mission requests a fresh context'
      : policy === 'fresh_page' && this.page && this.context
        ? 'the mission requests a fresh page'
      : needsCleanState(mission)
        ? 'this mission’s preconditions ask for a clean start'
        : this.key !== key
          ? 'the previous mission ran as a different role'
          : !this.page || this.page.isClosed()
            ? 'no usable page was left open'
            : undefined;

    if (!why && this.page && this.context) {
      log(`Reusing the browser from ${this.lastMission ?? 'the previous mission'} — nothing here needs a clean start.`);
      const lease: Lease = { page: this.page, context: this.context, fresh: false };
      if (this.lastMission !== undefined) lease.inheritedFrom = this.lastMission;
      this.lastMission = mission.test_id;
      return lease;
    }

    const keepContext = !forceFreshContext && policy === 'fresh_page' && this.context;
    if (keepContext) {
      await this.page?.close().catch(() => undefined);
      this.page = undefined;
    } else {
      await this.disposeContext();
    }
    log(`${keepContext ? 'Fresh page' : 'Fresh browser context'} — ${why}.`);

    const opts: Parameters<Browser['newContext']>[0] = { viewport: { width: 1440, height: 900 } };
    const strategy = mission.auth?.strategy ?? 'storage_state';
    if (strategy === 'storage_state') {
      const ref = mission.auth?.storage_state_ref ?? mission.role.toLowerCase();
      const file = path.join(PATHS.auth, `${ref}.json`);
      if (!fs.existsSync(file)) {
        throw new AuthMissingError(
          `No seeded session for role "${mission.role}" at ${rel(file)}. ` +
            'Seed it out-of-band (see README, "Authentication") — the agent never logs in through the UI per mission.',
        );
      }
      opts.storageState = file;
      log(`Using seeded session ${rel(file)} for role ${mission.role}.`);
    } else {
      log('Running anonymous (no seeded session).');
    }

    this.context ??= await browser.newContext(opts);
    this.page = await this.context.newPage();
    this.key = key;
    this.lastMission = mission.test_id;
    return { page: this.page, context: this.context, fresh: true, resetReason: why };
  }

  /**
   * Throw away the shared page after a mission that ruined it.
   *
   * A run that ended in a fatal error may have left the page mid-navigation or
   * showing a crash screen, and handing that to the next mission would report
   * this mission's failure again under another name.
   */
  async discard(): Promise<void> {
    await this.disposeContext();
  }

  private async disposeContext(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.context = undefined;
    this.page = undefined;
    this.key = undefined;
    this.lastMission = undefined;
  }

  async close(): Promise<void> {
    await this.disposeContext();
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
  }
}
