import type { Page } from '@playwright/test';

/**
 * The bounded state probe.
 *
 * Every other check here starts from something somebody wrote down. This one
 * does not: it finds the inputs on a page and tries the small set of things a
 * tester tries in the first two minutes — empty, whitespace, far too long,
 * unusual characters, pressing Enter — and records what the application did.
 *
 * **It does not grade anything.** There is no oracle. The requirement does not
 * say what a 300-character username should do, so "the field accepted it" is
 * not a pass and not a defect; it is a fact for a human who knows the product.
 * Grading it would manufacture false defects at scale, and a false defect costs
 * more human QA time than reporting nothing at all.
 *
 * **Why this needs its own browser context (VISION §7b).** Unlike ambient
 * observation, this mutates the page. Typing 300 characters into the username
 * field while a mission is trying to sign in breaks the mission and
 * manufactures a failure that looks real. That is a physical constraint, not a
 * preference: it runs concurrently, but never in the session a mission is using.
 */

export interface ProbeInput {
  /** How the field would be described to a human. */
  label: string;
  type: string;
  required: boolean;
  maxLength?: number;
}

export interface ProbeObservation {
  input: string;
  /** What was tried, in plain words. */
  trial: string;
  /** What the application did about it. Never a verdict. */
  observed: string;
  /** Worth a human's attention first — still not a defect. */
  notable: boolean;
}

export interface ProbeReport {
  url: string;
  inputs: ProbeInput[];
  observations: ProbeObservation[];
  /** Inputs deliberately left alone, and why. */
  skipped: { input: string; reason: string }[];
}

/**
 * Fields this must never touch.
 *
 * A probe that types into a password field on a login form triggers the very
 * lockout the account needs for a real test; one that submits a payment form
 * on STAGE creates records somebody has to clean up. Refusing to probe is
 * always cheaper than the cleanup, so the list is deliberately broad.
 */
const SENSITIVE = /pass(word|code)|otp|mfa|2fa|card|cvv|cvc|iban|account.?number|ssn|security.?code/i;
const DESTRUCTIVE = /delete|remove|destroy|cancel.?subscription|close.?account/i;

const LONG = 'A'.repeat(300);
const UNICODE = 'Ωמ𝔘𝔫🙂 ñ é 中文';

export async function collectInputs(page: Page): Promise<ProbeInput[]> {
  // NOTE: this body runs inside the browser. Do not introduce named inner
  // functions — the TypeScript loader rewrites them with a `__name` helper that
  // does not exist in page context, and the call dies with "ReferenceError:
  // __name is not defined". The same warning is on the sweeps, for the same
  // reason, and it was ignored here once already.
  return page.evaluate(() => {
    const fields = Array.from(
      document.querySelectorAll('input, textarea'),
    ) as (HTMLInputElement | HTMLTextAreaElement)[];

    const out: { label: string; type: string; required: boolean; maxLength?: number }[] = [];

    for (const el of fields) {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'file'].indexOf(type) !== -1) continue;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || el.disabled) continue;

      let label = '';
      const id = el.getAttribute('id');
      if (id) {
        const labels = Array.from(document.querySelectorAll('label'));
        for (const lb of labels) {
          if ((lb as HTMLLabelElement).htmlFor === id && lb.textContent && lb.textContent.trim()) {
            label = lb.textContent.trim();
            break;
          }
        }
      }
      if (!label) label = (el.getAttribute('aria-label') || '').trim();
      if (!label) label = (el.getAttribute('placeholder') || '').trim();
      if (!label) label = (el.getAttribute('name') || '').trim();
      if (!label) label = (el.getAttribute('id') || '').trim();
      if (!label) label = '(unlabelled field)';

      const max = Number(el.getAttribute('maxlength'));
      const entry: { label: string; type: string; required: boolean; maxLength?: number } = {
        label,
        type: (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase(),
        required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
      };
      if (isFinite(max) && max > 0) entry.maxLength = max;
      out.push(entry);
    }

    return out;
  });
}

/** A short, stable description of what the page is showing right now. */
async function pageState(page: Page): Promise<string> {
  return page.evaluate(() => {
    const alerts = Array.from(document.querySelectorAll('[role="alert"], .error, .invalid-feedback'))
      .map((e) => e.textContent?.trim())
      .filter((t): t is string => Boolean(t) && t.length < 200);
    const invalid = document.querySelectorAll(':invalid, [aria-invalid="true"]').length;
    return JSON.stringify({ url: location.pathname + location.search, alerts: alerts.slice(0, 3), invalid });
  });
}

function describeDelta(before: string, after: string): string {
  if (before === after) return 'nothing visibly changed';
  const b = JSON.parse(before) as { url: string; alerts: string[]; invalid: number };
  const a = JSON.parse(after) as { url: string; alerts: string[]; invalid: number };

  const parts: string[] = [];
  if (b.url !== a.url) parts.push(`navigated to ${a.url}`);
  const fresh = a.alerts.filter((t) => !b.alerts.includes(t));
  if (fresh.length) parts.push(`message shown: "${fresh[0]}"`);
  if (a.invalid > b.invalid) parts.push(`${a.invalid - b.invalid} field(s) marked invalid`);
  return parts.length ? parts.join('; ') : 'page state changed but not in a way this can describe';
}

/**
 * Try one value in one field and report what happened.
 *
 * Everything is wrapped: a probe that throws must degrade to an observation,
 * never take down the run. It is the lowest-value thing happening on the page.
 */
async function trial(
  page: Page,
  input: ProbeInput,
  what: string,
  value: string,
  submit: boolean,
): Promise<ProbeObservation | undefined> {
  try {
    /**
     * Reach the field however it is identifiable.
     *
     * `getByLabel` alone silently skipped every field that has no label — which
     * is exactly backwards, because an unlabelled field is the one most likely
     * to have had no thought given to its validation either. The first probe
     * run reported "2 fields" and then produced observations for one, which
     * looks like the probe working and is not.
     */
    const attempts = [
      page.getByLabel(input.label, { exact: false }),
      page.getByPlaceholder(input.label, { exact: false }),
      // `label` falls back to the name/id attribute when nothing else named the
      // field, so these two are how an unlabelled field is reached at all.
      page.locator(`input[name="${input.label}"], textarea[name="${input.label}"]`),
      page.locator(`input[id="${input.label}"], textarea[id="${input.label}"]`),
    ];

    let field = attempts[0]!.first();
    for (const attempt of attempts) {
      if ((await attempt.count()) > 0) {
        field = attempt.first();
        break;
      }
    }
    if ((await field.count()) === 0) return undefined;

    const before = await pageState(page);
    await field.fill('');
    if (value) await field.fill(value);

    let accepted = '';
    if (value) {
      const got = await field.inputValue();
      if (got.length !== value.length) {
        accepted = `field truncated it to ${got.length} of ${value.length} characters`;
      }
    }

    if (submit) await field.press('Enter');
    await page.waitForTimeout(400);

    const after = await pageState(page);
    const delta = describeDelta(before, after);
    const observed = [accepted, delta].filter(Boolean).join('; ');

    return {
      input: input.label,
      trial: what,
      observed,
      // Silence in response to bad input is the thing most worth a human's
      // eye: either validation is missing, or it is there and says nothing.
      notable: submit && delta === 'nothing visibly changed',
    };
  } catch (err) {
    return {
      input: input.label,
      trial: what,
      observed: `could not complete: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
      notable: false,
    };
  }
}

/**
 * Probe one page. The caller supplies the page, from a context of its own.
 */
export async function probePage(page: Page, maxInputs = 6): Promise<ProbeReport> {
  const all = await collectInputs(page);
  const skipped: { input: string; reason: string }[] = [];
  const safe: ProbeInput[] = [];

  for (const input of all) {
    if (SENSITIVE.test(input.label) || SENSITIVE.test(input.type)) {
      skipped.push({
        input: input.label,
        reason: 'credential or secret field — probing it risks triggering the very lockout a real test needs',
      });
    } else if (DESTRUCTIVE.test(input.label)) {
      skipped.push({ input: input.label, reason: 'looks destructive — refusing to find out' });
    } else {
      safe.push(input);
    }
  }

  const chosen = safe.slice(0, maxInputs);
  if (safe.length > chosen.length) {
    for (const extra of safe.slice(maxInputs)) {
      skipped.push({ input: extra.label, reason: `beyond the per-page cap of ${maxInputs}` });
    }
  }

  const observations: ProbeObservation[] = [];
  for (const input of chosen) {
    const matrix: [string, string, boolean][] = [
      ['left empty and submitted', '', true],
      ['whitespace only', '   ', true],
      ['300 characters', LONG, false],
      ['unicode and emoji', UNICODE, false],
    ];
    if (input.maxLength) {
      matrix.push([`one over its maxlength of ${input.maxLength}`, 'A'.repeat(input.maxLength + 1), false]);
    }

    for (const [what, value, submit] of matrix) {
      const obs = await trial(page, input, what, value, submit);
      if (obs) observations.push(obs);
    }

    try {
      await page.getByLabel(input.label, { exact: false }).first().fill('');
    } catch {
      // Leaving a field dirty is untidy, not a failure worth reporting.
    }
  }

  return { url: page.url(), inputs: chosen, observations, skipped };
}

export function renderProbe(reports: ProbeReport[]): string {
  const lines: string[] = ['## Input probe', ''];
  lines.push(
    'What the application did when each field was given something awkward.',
    '',
    '> **Nothing here is graded.** The requirement does not say what a 300-character',
    '> value should do, so none of this is a pass or a defect until someone who knows',
    '> the product reads it. Grading it automatically would invent defects at scale.',
    '',
  );

  let any = false;
  for (const r of reports) {
    if (r.inputs.length === 0 && r.skipped.length === 0) continue;
    any = true;
    lines.push(`### ${r.url}`, '');

    const notable = r.observations.filter((o) => o.notable);
    if (notable.length) {
      lines.push('**Silent on bad input — look at these first:**', '');
      for (const o of notable) lines.push(`* \`${o.input}\` — ${o.trial}: ${o.observed}`);
      lines.push('');
    }

    const rest = r.observations.filter((o) => !o.notable);
    if (rest.length) {
      lines.push('| Field | Tried | Observed |', '|---|---|---|');
      for (const o of rest) {
        lines.push(`| ${o.input} | ${o.trial} | ${o.observed} |`);
      }
      lines.push('');
    }

    if (r.skipped.length) {
      lines.push('**Deliberately not probed:**', '');
      for (const s of r.skipped) lines.push(`* \`${s.input}\` — ${s.reason}`);
      lines.push('');
    }
  }

  if (!any) return '';
  return lines.join('\n');
}
