import type { ConsoleMessage, Page, Request, Response } from '@playwright/test';

/**
 * Ambient observation.
 *
 * A mission verifies what it was told to verify. An experienced QA does more
 * than that: while testing the cart they notice the logo is broken, that the
 * console is throwing, that a request 404'd. Nobody wrote a test case for any
 * of it — they noticed because they were looking at the application rather
 * than only at their script.
 *
 * This watches every run for that class of thing. Two rules make it useful:
 *
 *  1. **Findings never change a mission's PASS/FAIL.** The mission asked one
 *     question and deserves one answer. A broken image spotted during a cart
 *     test is not a cart-test failure — mixing them makes both untrustworthy.
 *
 *  2. **Findings are reported separately**, as their own bug list. That is the
 *     difference between "the test passed" and "the test passed, and here are
 *     four things wrong with the page it walked through".
 */

export type FindingKind =
  | 'console_error'
  | 'page_exception'
  | 'http_error'
  | 'request_failed'
  | 'broken_image'
  | 'unlabelled_control';

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  summary: string;
  detail?: string;
  /** Where it was seen, so a human can get back to it. */
  url?: string;
  /** How many times this exact finding occurred during the run. */
  count: number;
  first_seen_step?: number;
}

/** Noise that says nothing about the product under test. */
const IGNORED_PATTERNS = [
  /favicon\.ico/i,
  /\[HMR\]/i,
  /React DevTools/i,
  /Download the React DevTools/i,
  /webpack-hmr/i,
  /chrome-extension:/i,
];

function isNoise(text: string): boolean {
  return IGNORED_PATTERNS.some((re) => re.test(text));
}

function severityForStatus(status: number): Severity {
  if (status >= 500) return 'high';
  if (status === 404) return 'medium';
  return 'low';
}

export class Observer {
  private readonly findings = new Map<string, Finding>();
  private currentStep = 0;

  constructor(private readonly page: Page) {}

  /** Lets a finding be attributed to the step that was running when it fired. */
  setStep(step: number): void {
    this.currentStep = step;
  }

  private record(
    key: string,
    kind: FindingKind,
    severity: Severity,
    summary: string,
    detail?: string,
    url?: string,
  ): void {
    const existing = this.findings.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.findings.set(key, {
      kind,
      severity,
      summary,
      detail,
      url,
      count: 1,
      first_seen_step: this.currentStep || undefined,
    });
  }

  /**
   * Handlers are kept so they can be detached again.
   *
   * A run reuses one page across missions, so an Observer that attached and
   * never let go would leave the previous mission's listener recording into a
   * finished findings list — and the page would accumulate one more listener
   * per mission until Playwright started warning about the leak.
   */
  private readonly attached: { event: string; handler: (arg: never) => void }[] = [];

  private listen<T>(event: string, handler: (arg: T) => void): void {
    this.attached.push({ event, handler: handler as (arg: never) => void });
    (this.page as unknown as { on(e: string, h: (a: T) => void): void }).on(event, handler);
  }

  /** Detach everything this observer attached. Safe to call more than once. */
  stop(): void {
    for (const { event, handler } of this.attached) {
      (this.page as unknown as { off(e: string, h: (a: never) => void): void }).off(event, handler);
    }
    this.attached.length = 0;
  }

  start(): void {
    this.listen('console', (msg: ConsoleMessage) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (isNoise(text)) return;
      // The browser logs "Failed to load resource" for every 4xx/5xx, but it
      // does not say which resource. The response listener already captured
      // the same failure *with* the URL, so this row would add a vaguer
      // duplicate of something already reported precisely.
      if (/failed to load resource/i.test(text)) return;
      this.record(`console:${text.slice(0, 160)}`, 'console_error', 'medium', 'Console error', text, this.page.url());
    });

    this.listen('pageerror', (err: Error) => {
      const text = err.message;
      if (isNoise(text)) return;
      // An uncaught exception is the strongest passive signal there is:
      // something genuinely threw in the running application.
      this.record(`pageerror:${text.slice(0, 160)}`, 'page_exception', 'high', 'Uncaught page exception', text, this.page.url());
    });

    this.listen('response', (response: Response) => {
      const status = response.status();
      if (status < 400) return;
      const url = response.url();
      if (isNoise(url)) return;
      this.record(
        `http:${status}:${url}`,
        'http_error',
        severityForStatus(status),
        `HTTP ${status} — ${response.request().resourceType()}`,
        url,
        this.page.url(),
      );
    });

    this.listen('requestfailed', (request: Request) => {
      const url = request.url();
      if (isNoise(url)) return;
      const reason = request.failure()?.errorText ?? 'unknown';
      // A request aborted because the page navigated away is ordinary browser
      // behaviour, not a defect. Reporting it buries the real findings — and a
      // findings list nobody trusts is a findings list nobody reads.
      if (/ERR_ABORTED|NS_BINDING_ABORTED/i.test(reason)) return;
      this.record(
        `reqfail:${url}`,
        'request_failed',
        'medium',
        `Request failed (${reason})`,
        url,
        this.page.url(),
      );
    });
  }

  /**
   * A final sweep of things only visible once the page settled. Runs whatever
   * the mission's own assertions were about — this is the "while I was here I
   * also noticed" pass.
   */
  async sweepPage(): Promise<void> {
    try {
      const found = await this.page.locator('body').evaluate((root: Element) => {
        const brokenImages: string[] = [];
        const unlabelled: string[] = [];

        const imgs = Array.from(root.querySelectorAll('img')) as HTMLImageElement[];
        for (const img of imgs) {
          const style = window.getComputedStyle(img);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          if (img.complete && img.naturalWidth === 0) {
            brokenImages.push(img.currentSrc || img.getAttribute('src') || '(no src)');
          }
        }

        const controls = Array.from(
          root.querySelectorAll('button, a[href], [role="button"]'),
        ) as HTMLElement[];
        for (const el of controls) {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          if (el.getAttribute('aria-hidden') === 'true') continue;

          let name = el.getAttribute('aria-label') || '';
          if (!name) name = el.getAttribute('title') || '';
          if (!name) name = el.textContent ? el.textContent.trim() : '';
          if (!name) {
            const img = el.querySelector('img[alt]');
            name = img ? img.getAttribute('alt') || '' : '';
          }
          if (name.trim()) continue;

          const tag = el.tagName.toLowerCase();
          const href = el.getAttribute('href');
          unlabelled.push(href ? `<${tag} href="${href}">` : `<${tag}>`);
        }

        return { brokenImages, unlabelled };
      });

      for (const src of found.brokenImages) {
        this.record(`img:${src}`, 'broken_image', 'medium', 'Image failed to load', src, this.page.url());
      }
      for (const control of found.unlabelled) {
        this.record(
          `label:${control}`,
          'unlabelled_control',
          'low',
          'Control has no accessible name',
          control,
          this.page.url(),
        );
      }
    } catch {
      // Never let observation break a run. It is a bystander, not a participant.
    }
  }

  /**
   * One broken resource announces itself three ways — a failed response, a
   * console error, and a DOM image that never decoded. They are the same bug.
   * Reporting it three times inflates the list and trains people to skim it,
   * so findings that name the same URL are merged, keeping the most specific
   * description.
   */
  private static rootUrl(f: Finding): string | undefined {
    const candidate = f.detail ?? '';
    const match = /https?:\/\/[^\s)'"]+/.exec(candidate);
    return match ? match[0] : undefined;
  }

  list(): Finding[] {
    const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
    // Which description survives a merge, most specific first.
    const specificity: Record<FindingKind, number> = {
      page_exception: 0,
      broken_image: 1,
      http_error: 2,
      request_failed: 3,
      console_error: 4,
      unlabelled_control: 5,
    };

    const byResource = new Map<string, Finding>();
    const standalone: Finding[] = [];

    for (const f of this.findings.values()) {
      const url = Observer.rootUrl(f);
      // Only resource-level findings share a root cause this way; a console
      // error with no URL is its own thing.
      if (!url || f.kind === 'unlabelled_control') {
        standalone.push(f);
        continue;
      }
      const existing = byResource.get(url);
      if (!existing) {
        byResource.set(url, { ...f });
        continue;
      }
      existing.count += f.count;
      if (specificity[f.kind] < specificity[existing.kind]) {
        existing.kind = f.kind;
        existing.summary = f.summary;
        existing.detail = f.detail;
      }
      if (order[f.severity] < order[existing.severity]) existing.severity = f.severity;
    }

    return [...byResource.values(), ...standalone].sort(
      (a, b) => order[a.severity] - order[b.severity],
    );
  }

  get count(): number {
    return this.findings.size;
  }
}
