import type { Page, Request, Route } from '@playwright/test';

/**
 * Fault injection — make chosen API calls fail, on purpose, inside a test.
 *
 * Error handling is where users lose data and trust, and it is the part a
 * tester can least easily reach: nobody can make STAGE return a 500 on demand.
 * The browser can. A route intercepts the matching XHR/fetch call and answers
 * it with the failure, so the test can check what the user is told — and that
 * the page does not hang, double-submit or claim success.
 *
 * Rules:
 *
 *  - Faults last for one mission. The page is reused by the next one, so every
 *    route is removed when the mission ends, pass or fail.
 *  - An injected failure is not a finding. The observer and API health skip
 *    calls this module answered; otherwise every planned 500 would be filed as
 *    a defect.
 *  - Only API calls are touched (XHR/fetch). Documents, scripts and images load
 *    normally, so a fault never breaks the page itself by accident.
 */

export type FaultKind = 'server_error' | 'not_found' | 'timeout' | 'offline' | 'slow';

export interface FaultSpec {
  request: { method?: string; url_contains: string };
  failure: FaultKind;
  /** server_error / not_found: the status to answer with (default 500 / 404). */
  status?: number;
  /** timeout: how long to hold the call before dropping it (default 15 s). slow: how long to delay it (default 5 s). */
  delay_ms?: number;
}

const MAX_HOLD_MS = 60_000;

export function describeFault(f: FaultSpec): string {
  const call = `${f.request.method ? `${f.request.method.toUpperCase()} ` : ''}…${f.request.url_contains}`;
  switch (f.failure) {
    case 'server_error':
      return `${call} answers ${f.status ?? 500}`;
    case 'not_found':
      return `${call} answers ${f.status ?? 404}`;
    case 'timeout':
      return `${call} hangs for ${((f.delay_ms ?? 15_000) / 1000).toFixed(0)}s, then times out`;
    case 'offline':
      return `${call} fails as if the network were down`;
    case 'slow':
      return `${call} is delayed ${((f.delay_ms ?? 5_000) / 1000).toFixed(0)}s`;
  }
}

export class FaultInjector {
  private readonly routes: { matcher: (url: URL) => boolean; handler: (route: Route, req: Request) => Promise<void> }[] = [];
  /** method + url of every call this injector answered. */
  private readonly answered = new Set<string>();
  /** Calls being held (timeout / slow), released early if the mission ends. */
  private readonly holds = new Map<ReturnType<typeof setTimeout>, () => void>();

  constructor(private readonly page: Page) {}

  get active(): boolean {
    return this.routes.length > 0;
  }

  /** Was this call answered by an injected fault rather than the server? */
  isInjected(method: string, url: string): boolean {
    return this.answered.has(`${method.toUpperCase()} ${url}`);
  }

  private hold(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.holds.delete(t);
        resolve();
      }, Math.min(ms, MAX_HOLD_MS));
      this.holds.set(t, resolve);
    });
  }

  async add(spec: FaultSpec): Promise<void> {
    const matcher = (url: URL) => url.href.includes(spec.request.url_contains);
    const handler = async (route: Route, req: Request) => {
      const api = req.resourceType() === 'xhr' || req.resourceType() === 'fetch';
      const methodOk = !spec.request.method || req.method().toUpperCase() === spec.request.method.toUpperCase();
      if (!api || !methodOk) {
        await route.fallback();
        return;
      }
      this.answered.add(`${req.method().toUpperCase()} ${req.url()}`);
      try {
        switch (spec.failure) {
          case 'server_error':
          case 'not_found':
            await route.fulfill({
              status: spec.status ?? (spec.failure === 'not_found' ? 404 : 500),
              contentType: 'application/json',
              body: JSON.stringify({ error: 'Injected by the QA Execution Agent' }),
            });
            return;
          case 'offline':
            await route.abort('internetdisconnected');
            return;
          case 'timeout':
            await this.hold(spec.delay_ms ?? 15_000);
            await route.abort('timedout');
            return;
          case 'slow':
            await this.hold(spec.delay_ms ?? 5_000);
            await route.continue();
            return;
        }
      } catch {
        // The page navigated away or closed mid-hold: nothing left to answer.
      }
    };
    this.routes.push({ matcher, handler });
    await this.page.route(matcher, handler);
  }

  /** Remove every fault. Safe to call more than once, and on a closed page. */
  async clear(): Promise<void> {
    for (const [t, release] of this.holds) {
      clearTimeout(t);
      release();
    }
    this.holds.clear();
    for (const r of this.routes.splice(0)) {
      try {
        await this.page.unroute(r.matcher, r.handler);
      } catch {
        /* page already closed */
      }
    }
  }
}
