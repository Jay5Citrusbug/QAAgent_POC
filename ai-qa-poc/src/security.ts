import type { BrowserContext, Page, Request, Response } from '@playwright/test';

/**
 * Passive security checks — what a run can notice about security without
 * attacking anything.
 *
 * These are the checks a baseline scanner (OWASP ZAP's "baseline" mode) makes
 * from ordinary traffic: secrets where they get logged, session cookies a
 * script could steal, pages that can be framed by another site, HTTP content on
 * an HTTPS page. None of them sends anything the application did not ask for;
 * active testing (injection, fuzzing) is a different tool and a different
 * permission.
 *
 * Findings, never FAILs, and one per origin or cookie — the same missing header
 * on every page is one problem, not forty.
 */

export interface SecurityFinding {
  key: string;
  kind: 'secret_in_url' | 'insecure_cookie' | 'missing_security_header' | 'mixed_content';
  severity: 'high' | 'medium' | 'low';
  summary: string;
  detail: string;
  url: string;
}

const SECRET_PARAM = /^(pass(word)?|pwd|token|access_token|id_token|refresh_token|api[-_]?key|secret|session(id)?|sid|auth|otp|ssn|card(number)?|cvv)$/i;
const SESSION_COOKIE = /sess|sid|auth|token|jwt|login|remember/i;

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export class SecurityWatch {
  private readonly found = new Map<string, SecurityFinding>();
  private readonly onRequest = (req: Request) => this.request(req);
  private readonly onResponse = (res: Response) => this.response(res);

  constructor(private readonly page: Page) {}

  private add(f: SecurityFinding): void {
    if (!this.found.has(f.key)) this.found.set(f.key, f);
  }

  start(): void {
    this.page.on('request', this.onRequest);
    this.page.on('response', this.onResponse);
  }

  stop(): void {
    this.page.off('request', this.onRequest);
    this.page.off('response', this.onResponse);
  }

  private request(req: Request): void {
    let u: URL;
    try {
      u = new URL(req.url());
    } catch {
      return;
    }
    // Secrets in a URL end up in server logs, proxies, history and Referer headers.
    const leaked = [...u.searchParams.keys()].filter((k) => SECRET_PARAM.test(k) && u.searchParams.get(k));
    if (leaked.length) {
      this.add({
        key: `secret_url:${u.origin}${u.pathname}:${leaked.join(',')}`,
        kind: 'secret_in_url',
        severity: 'high',
        summary: `Sensitive value sent in the URL (${leaked.join(', ')}) — ${req.method()} ${u.pathname}`,
        detail: 'URLs are written to server logs, browser history and Referer headers. Send this in the request body or a header instead. (Value not recorded here.)',
        url: `${u.origin}${u.pathname}`,
      });
    }
    // HTTP content on an HTTPS page can be read or changed in transit.
    const pageUrl = this.page.url();
    if (pageUrl.startsWith('https:') && u.protocol === 'http:' && !/^(localhost|127\.)/.test(u.hostname)) {
      this.add({
        key: `mixed:${u.origin}`,
        kind: 'mixed_content',
        severity: 'medium',
        summary: `HTTPS page loads content over plain HTTP from ${u.origin}`,
        detail: `${req.resourceType()} ${req.url()} on ${pageUrl}`,
        url: pageUrl,
      });
    }
  }

  private response(res: Response): void {
    if (res.request().resourceType() !== 'document' || res.status() >= 300) return;
    const h = res.headers();
    const o = origin(res.url());
    const https = res.url().startsWith('https:');
    const missing: string[] = [];
    const csp = h['content-security-policy'] ?? '';
    if (!h['x-frame-options'] && !/frame-ancestors/i.test(csp)) missing.push('X-Frame-Options or CSP frame-ancestors (clickjacking)');
    if (!csp) missing.push('Content-Security-Policy (script injection damage limit)');
    if ((h['x-content-type-options'] ?? '').toLowerCase() !== 'nosniff') missing.push('X-Content-Type-Options: nosniff');
    if (https && !h['strict-transport-security']) missing.push('Strict-Transport-Security (HTTPS enforcement)');
    if (missing.length) {
      this.add({
        key: `headers:${o}`,
        kind: 'missing_security_header',
        severity: 'low',
        summary: `Security headers missing on ${o}: ${missing.length}`,
        detail: missing.map((m) => `- ${m}`).join('\n'),
        url: res.url(),
      });
    }
  }

  /** Session-looking cookies a script could read, or that travel without protection. */
  async inspectCookies(context: BrowserContext): Promise<void> {
    const pageUrl = this.page.url();
    if (!/^https?:/.test(pageUrl)) return;
    const https = pageUrl.startsWith('https:');
    for (const c of await context.cookies(pageUrl)) {
      if (!SESSION_COOKIE.test(c.name)) continue;
      const gaps: string[] = [];
      if (!c.httpOnly) gaps.push('not HttpOnly (page scripts can read it, so an injected script can steal it)');
      if (https && !c.secure) gaps.push('not Secure (can be sent over plain HTTP)');
      if (c.sameSite === 'None' && !c.secure) gaps.push('SameSite=None without Secure');
      if (!c.sameSite || c.sameSite === 'None') gaps.push('no SameSite protection (cross-site request forgery)');
      if (gaps.length) {
        this.add({
          key: `cookie:${c.domain}:${c.name}`,
          kind: 'insecure_cookie',
          severity: !c.httpOnly ? 'medium' : 'low',
          summary: `Session cookie "${c.name}" is ${gaps.length > 1 ? 'weakly protected' : gaps[0]!.split(' (')[0]}`,
          detail: gaps.map((g) => `- ${g}`).join('\n'),
          url: pageUrl,
        });
      }
    }
  }

  list(): SecurityFinding[] {
    return [...this.found.values()];
  }
}

/**
 * End the session the way a timeout would: cookies and web storage gone. The
 * next step finds out what the application does about it.
 */
export async function expireSession(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page
    .evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        /* storage blocked: nothing to clear */
      }
    })
    .catch(() => undefined);
}
