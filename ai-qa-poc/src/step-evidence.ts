import path from 'node:path';
import type { Locator, Page, Request, Response } from '@playwright/test';
import { rel } from './config.js';
import type { Evidence } from './evidence.js';

/**
 * Evidence for every step of every test — passes included.
 *
 * The previous policy captured a screenshot only on failure. That is the right
 * economy for a mature suite, and the wrong one while nobody yet trusts the
 * agent: a PASS with no evidence is exactly the result a reviewer cannot check,
 * and a false PASS is the failure that erodes trust fastest. So in `full`
 * evidence mode (the default) each step records:
 *
 *   - the element about to be used, outlined in red — which control was it?
 *   - the page after the step — what happened?
 *   - the URL it ended on
 *
 * and each test records its API traffic, so a failure can be traced to the
 * request behind it.
 */

const OUTLINE = '3px solid #e5484d';

/** Screenshot with `locator` outlined. Never throws — evidence must not fail a test. */
export async function captureHighlighted(
  page: Page,
  locator: Locator,
  ev: Evidence,
  name: string,
): Promise<string | undefined> {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
    const prev = await locator.evaluate(
      (el, outline) => {
        const h = el as HTMLElement;
        const before = { outline: h.style.outline, offset: h.style.outlineOffset };
        h.style.outline = outline;
        h.style.outlineOffset = '2px';
        return before;
      },
      OUTLINE,
      { timeout: 2_000 },
    );
    const file = await capture(page, ev, name);
    await locator
      .evaluate(
        (el, before) => {
          const h = el as HTMLElement;
          h.style.outline = before.outline;
          h.style.outlineOffset = before.offset;
        },
        prev,
        { timeout: 2_000 },
      )
      .catch(() => undefined);
    return file;
  } catch {
    return capture(page, ev, name);
  }
}

/** Viewport screenshot as JPEG — a fraction of the size of a full-page PNG. */
export async function capture(page: Page, ev: Evidence, name: string): Promise<string | undefined> {
  if (page.isClosed()) return undefined;
  const file = path.join(ev.dir, `${name}.jpg`);
  try {
    await page.screenshot({ path: file, type: 'jpeg', quality: 70, timeout: 5_000 });
    ev.add(file);
    return rel(file);
  } catch {
    return undefined;
  }
}

// --- API traffic ---------------------------------------------------------------

export interface NetworkEntry {
  at: string;
  method: string;
  url: string;
  status: number | null;
  duration_ms?: number;
  resource: string;
  request_body?: string;
  response_body?: string;
  /** True when response_body was cut at MAX_BODY. Checks read the full body instead. */
  response_truncated?: boolean;
  content_type?: string;
  failure?: string;
  /** Answered by an injected fault, not by the server. */
  injected?: boolean;
}

const SECRET_KEYS = /pass(word)?|token|secret|authori[sz]ation|api[-_]?key|cookie|session|otp|cvv|card/i;
const MAX_BODY = 4_000;
/** What API checks may read. Big enough for real payloads, small enough to hold. */
const MAX_CHECKED_BODY = 500_000;
const MAX_ENTRIES = 300;

/** Mask values of secret-looking keys in JSON or form bodies. */
function redact(body: string | null | undefined, limit = MAX_BODY): string | undefined {
  if (!body) return undefined;
  let out = body;
  try {
    const parsed = JSON.parse(body) as unknown;
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, SECRET_KEYS.test(k) ? '***' : walk(val)]),
        );
      }
      return v;
    };
    out = JSON.stringify(walk(parsed));
  } catch {
    out = body.replace(/([?&]?[\w.-]*(?:pass(?:word)?|token|secret|key)[\w.-]*=)[^&\s]*/gi, '$1***');
  }
  return out.length > limit ? `${out.slice(0, limit)}… (truncated)` : out;
}

/**
 * Records XHR/fetch calls while attached. Documents, images and scripts are
 * left out: they are noise for "why did this fail", and the observer already
 * reports broken resources separately.
 */
export class NetworkLog {
  private readonly entries: NetworkEntry[] = [];
  private readonly started = new Map<Request, number>();
  private readonly pending: Promise<void>[] = [];
  /**
   * Full (redacted) response bodies, kept in memory for API checks and never
   * written to disk. The evidence file keeps the short version; a check that
   * read only that would fail on any field past the first 4 KB.
   */
  private readonly bodies = new Map<NetworkEntry, string>();

  private onRequest = (req: Request) => {
    if (this.relevant(req)) this.started.set(req, Date.now());
  };

  private onResponse = (res: Response) => {
    const req = res.request();
    if (!this.relevant(req) || this.entries.length >= MAX_ENTRIES) return;
    const start = this.started.get(req);
    const entry: NetworkEntry = {
      at: new Date().toISOString(),
      method: req.method(),
      url: req.url(),
      status: res.status(),
      resource: req.resourceType(),
      ...(this.planned(req.method(), req.url()) ? { injected: true } : {}),
      ...(start ? { duration_ms: Date.now() - start } : {}),
      ...(req.postData() ? { request_body: redact(req.postData()) } : {}),
    };
    this.entries.push(entry);
    const type = res.headers()['content-type'] ?? '';
    if (type) entry.content_type = type.split(';')[0]!.trim();
    if (/json|text|xml/.test(type)) {
      this.pending.push(
        res
          .text()
          .then((t) => {
            entry.response_body = redact(t);
            if (t.length > MAX_BODY) entry.response_truncated = true;
            const full = redact(t, MAX_CHECKED_BODY);
            if (full !== undefined) this.bodies.set(entry, full);
          })
          .catch(() => undefined),
      );
    }
  };

  private onFailed = (req: Request) => {
    if (!this.relevant(req) || this.entries.length >= MAX_ENTRIES) return;
    this.entries.push({
      at: new Date().toISOString(),
      method: req.method(),
      url: req.url(),
      status: null,
      resource: req.resourceType(),
      ...(this.planned(req.method(), req.url()) ? { injected: true } : {}),
      failure: req.failure()?.errorText ?? 'request failed',
    });
  };

  private planned: (method: string, url: string) => boolean = () => false;

  constructor(private readonly page: Page) {}

  /** Mark calls answered by fault injection, so health checks skip them. */
  markPlanned(isPlanned: (method: string, url: string) => boolean): void {
    this.planned = isPlanned;
  }

  private relevant(req: Request): boolean {
    const t = req.resourceType();
    return t === 'xhr' || t === 'fetch';
  }

  start(): void {
    this.page.on('request', this.onRequest);
    this.page.on('response', this.onResponse);
    this.page.on('requestfailed', this.onFailed);
  }

  async stop(): Promise<void> {
    this.page.off('request', this.onRequest);
    this.page.off('response', this.onResponse);
    this.page.off('requestfailed', this.onFailed);
    await Promise.race([Promise.all(this.pending), new Promise((r) => setTimeout(r, 3_000))]);
  }

  list(): NetworkEntry[] {
    return this.entries;
  }

  /**
   * Record a call the test made itself (an api_request step), so API checks
   * and API health treat it exactly like one the page made.
   */
  record(call: Omit<NetworkEntry, 'response_body' | 'response_truncated' | 'request_body'> & { request_body?: string }, body?: string): NetworkEntry {
    const entry: NetworkEntry = {
      ...call,
      ...(call.request_body ? { request_body: redact(call.request_body) } : {}),
      ...(body !== undefined ? { response_body: redact(body) } : {}),
      ...(body !== undefined && body.length > MAX_BODY ? { response_truncated: true } : {}),
    };
    if (this.entries.length < MAX_ENTRIES) this.entries.push(entry);
    if (body !== undefined) {
      const full = redact(body, MAX_CHECKED_BODY);
      if (full !== undefined) this.bodies.set(entry, full);
    }
    return entry;
  }

  /** The full redacted body for checks; falls back to the stored one. */
  body(entry: NetworkEntry): string | undefined {
    return this.bodies.get(entry) ?? entry.response_body;
  }

  /** Wait for in-flight bodies, so a check does not read a response half-arrived. */
  async settle(timeoutMs = 3_000): Promise<void> {
    await Promise.race([Promise.all(this.pending), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  get failed(): number {
    return this.entries.filter((e) => e.status === null || e.status >= 400).length;
  }
}
