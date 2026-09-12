import { chromium, type Page } from '@playwright/test';

/**
 * Page inspection for the Thinking Agent.
 *
 * The Thinking Agent has been writing tests with its eyes closed — from
 * requirement prose alone — and it shows. Of seven generated missions, two
 * asserted UI that does not exist (a cart count badge, an `aria-pressed`
 * attribute), three were circular, and one passed against a bug it was written
 * to catch. Every one of those is what happens when you describe a page you
 * have never seen.
 *
 * This gives it eyes. It is deliberately *not* a DOM dump: it reports the same
 * things a tester notices on first look — what the controls are called, which
 * names are ambiguous, what text is actually on the page, and, most
 * importantly, **what is absent**. The cart badge was invented because nothing
 * ever told the agent there wasn't one.
 */

export interface ControlFact {
  role: string;
  name: string;
  count: number;
  /** Where each match sits, so the agent knows when it must scope a target. */
  regions: string[];
}

export interface ImageFact {
  alt: string;
  src: string;
  loaded: boolean;
}

export interface PageReality {
  url: string;
  title: string;
  landmarks: string[];
  headings: { level: number; text: string }[];
  controls: ControlFact[];
  images: ImageFact[];
  /** Names matching more than one element — the ambiguity traps. */
  ambiguous: ControlFact[];
  /** Things a mission might assume exist. Checked explicitly so absence is stated. */
  absences: string[];
  textSample: string[];
}

const COMMON_ASSUMPTIONS: { key: string; selector: string; describe: string }[] = [
  { key: 'status_role', selector: '[role="status"]', describe: 'element with role="status" — no badge, counter or live region exists' },
  { key: 'alert_role', selector: '[role="alert"]', describe: 'element with role="alert" — no toast/error region exists' },
  { key: 'aria_pressed', selector: '[aria-pressed]', describe: 'element using aria-pressed — toggle state is not exposed this way' },
  { key: 'aria_selected', selector: '[aria-selected]', describe: 'element using aria-selected — selection state is not exposed this way' },
  { key: 'aria_current', selector: '[aria-current]', describe: 'element using aria-current — active-page state is not exposed this way' },
  { key: 'aria_invalid', selector: '[aria-invalid]', describe: 'element using aria-invalid — field validation state is not exposed this way' },
  { key: 'dialog', selector: '[role="dialog"], dialog', describe: 'dialog or modal' },
  { key: 'form', selector: 'form', describe: '<form> element' },
  { key: 'testid', selector: '[data-testid]', describe: 'data-testid attribute anywhere — there are no stable test hooks to target' },
];

export async function inspectPage(url: string, timeoutMs = 30_000): Promise<PageReality> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    return await extract(page, url);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function extract(page: Page, url: string): Promise<PageReality> {
  const title = await page.title();

  // Everything below runs in the page. NO named inner functions, not even
  // small helpers — the TS loader rewrites them with a `__name` helper that
  // does not exist in page context, and the whole call dies with
  // "ReferenceError: __name is not defined". This has bitten twice now; the
  // repetition below is deliberate, not an oversight.
  const raw = await page.locator('body').evaluate((root: Element) => {
    // --- landmarks -------------------------------------------------------
    const landmarks: string[] = [];
    for (const tag of ['nav', 'header', 'main', 'footer', 'aside']) {
      const n = root.ownerDocument.querySelectorAll(tag).length;
      if (n) landmarks.push(`<${tag}> x${n}`);
    }

    // --- headings --------------------------------------------------------
    const headings: { level: number; text: string }[] = [];
    for (const h of Array.from(root.querySelectorAll('h1,h2,h3'))) {
      const hs = window.getComputedStyle(h);
      if (hs.display === 'none' || hs.visibility === 'hidden') continue;
      const text = (h.textContent || '').trim().slice(0, 90);
      if (text) headings.push({ level: Number(h.tagName[1]), text });
    }

    // --- controls, with their accessible names ---------------------------
    const controlMap: Record<string, { role: string; name: string; count: number; regions: string[] }> = {};
    const selector = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"]';
    for (const el of Array.from(root.querySelectorAll(selector))) {
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;

      const tag = el.tagName.toLowerCase();
      let role = el.getAttribute('role') || '';
      if (!role) {
        if (tag === 'a') role = 'link';
        else if (tag === 'button') role = 'button';
        else if (tag === 'select') role = 'combobox';
        else if (tag === 'textarea') role = 'textbox';
        else if (tag === 'input') {
          const t = (el as HTMLInputElement).type;
          role = t === 'checkbox' ? 'checkbox' : t === 'radio' ? 'radio' : t === 'submit' ? 'button' : 'textbox';
        }
      }

      let name = el.getAttribute('aria-label') || '';
      if (!name) name = el.getAttribute('title') || '';
      if (!name) {
        const id = el.getAttribute('id');
        if (id) {
          for (const lb of Array.from(root.ownerDocument.querySelectorAll('label'))) {
            if ((lb as HTMLLabelElement).htmlFor === id) {
              name = (lb.textContent || '').trim();
              break;
            }
          }
        }
      }
      if (!name) name = (el.textContent || '').trim();
      if (!name) {
        const img = el.querySelector('img[alt]');
        name = img ? img.getAttribute('alt') || '' : '';
      }
      if (!name) name = el.getAttribute('placeholder') || '';
      name = name.replace(/\s+/g, ' ').trim().slice(0, 60);

      const key = `${role}|${name}`;
      const region = el.closest('nav')
        ? 'nav'
        : el.closest('footer')
          ? 'footer'
          : el.closest('header')
            ? 'header'
            : el.closest('main')
              ? 'main'
              : el.closest('aside')
                ? 'aside'
                : 'page';
      if (controlMap[key]) {
        controlMap[key].count += 1;
        if (!controlMap[key].regions.includes(region)) controlMap[key].regions.push(region);
      } else {
        controlMap[key] = { role, name, count: 1, regions: [region] };
      }
    }

    // --- images ----------------------------------------------------------
    const images: { alt: string; src: string; loaded: boolean }[] = [];
    for (const el of Array.from(root.querySelectorAll('img'))) {
      const is = window.getComputedStyle(el);
      if (is.display === 'none' || is.visibility === 'hidden') continue;
      const img = el as HTMLImageElement;
      images.push({
        alt: (img.getAttribute('alt') || '').slice(0, 50),
        src: (img.currentSrc || img.getAttribute('src') || '').slice(0, 110),
        loaded: img.complete && img.naturalWidth > 0,
      });
    }

    // --- a sample of real visible text ------------------------------------
    const textSample: string[] = [];
    for (const el of Array.from(root.querySelectorAll('p, li, span, h1, h2, h3'))) {
      if (textSample.length >= 40) break;
      const ts = window.getComputedStyle(el);
      if (ts.display === 'none' || ts.visibility === 'hidden') continue;
      if (el.children.length > 0) continue; // leaf nodes only, avoids duplication
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 3 && t.length < 140 && !textSample.includes(t)) textSample.push(t);
    }

    return { landmarks, headings, controls: Object.values(controlMap), images, textSample };
  });

  // --- explicit absence checks -------------------------------------------
  const absences: string[] = [];
  for (const probe of COMMON_ASSUMPTIONS) {
    const count = await page.locator(probe.selector).count();
    if (count === 0) absences.push(probe.describe);
  }

  const controls = (raw.controls as ControlFact[]).sort(
    (a, b) => b.count - a.count || a.role.localeCompare(b.role),
  );

  return {
    url,
    title,
    landmarks: raw.landmarks,
    headings: raw.headings,
    controls,
    images: raw.images,
    ambiguous: controls.filter((c) => c.count > 1),
    absences,
    textSample: raw.textSample,
  };
}

export function renderReality(pages: PageReality[]): string {
  const out: string[] = [];
  out.push('# Observed application state');
  out.push('');
  out.push(
    'Captured from the running application. This is what is **actually there** — ' +
      'use it instead of assuming. If something you were about to assert is not listed ' +
      'below, treat that as evidence it does not exist, and say so as a gap rather than ' +
      'writing a mission against it.',
  );
  out.push('');
  out.push(`_Captured ${new Date().toISOString()}_`);
  out.push('');

  for (const p of pages) {
    out.push(`## ${p.url}`);
    out.push('');
    out.push(`**Title:** ${p.title}`);
    out.push(`**Landmarks:** ${p.landmarks.join(', ') || 'none'}`);
    out.push('');

    if (p.ambiguous.length) {
      out.push('### Ambiguous names — these MUST be scoped');
      out.push('');
      out.push(
        'Each of these names matches more than one element. A target using the name alone ' +
          'is ambiguous, and the executor will refuse it rather than guess. Scope with `within`.',
      );
      out.push('');
      out.push('| role | name | matches | regions |');
      out.push('|---|---|---:|---|');
      for (const c of p.ambiguous) {
        out.push(`| ${c.role} | ${c.name || '_(no name)_'} | ${c.count} | ${c.regions.join(', ')} |`);
      }
      out.push('');
    }

    const CONTROL_LIMIT = 60;
    const shown = p.controls.slice(0, CONTROL_LIMIT);
    out.push(`### Controls present (${shown.length} of ${p.controls.length} distinct names)`);
    out.push('');
    if (p.controls.length > CONTROL_LIMIT) {
      // Silent truncation would be worse than no list at all: a control missing
      // from the table would read as "does not exist" when it was merely cut.
      out.push(
        `**This list is truncated.** ${p.controls.length - CONTROL_LIMIT} further control name(s) exist on ` +
          `this page and are not shown. Absence from this table is therefore NOT evidence that a control ` +
          `is missing — only the "Not present on this page" section below carries that meaning, because ` +
          `those were each checked explicitly.`,
      );
      out.push('');
    }
    out.push('| role | name | count | region |');
    out.push('|---|---|---:|---|');
    for (const c of shown) {
      out.push(`| ${c.role} | ${c.name || '**_(no accessible name)_**'} | ${c.count} | ${c.regions.join(', ')} |`);
    }
    out.push('');

    if (p.headings.length) {
      out.push('### Headings');
      out.push('');
      for (const h of p.headings.slice(0, 25)) out.push(`${'  '.repeat(h.level - 1)}- h${h.level}: ${h.text}`);
      out.push('');
    }

    const broken = p.images.filter((i) => !i.loaded);
    out.push(`### Images (${p.images.length} visible, ${broken.length} failing to load)`);
    out.push('');
    if (broken.length) {
      for (const i of broken) out.push(`- **BROKEN** alt="${i.alt}" src=${i.src}`);
      out.push('');
    }

    if (p.absences.length) {
      out.push('### Not present on this page');
      out.push('');
      out.push(
        'Checked explicitly. Do **not** write a mission that depends on any of these — ' +
          'if the requirement implies one should exist, that is a gap to report, not an assertion to write.',
      );
      out.push('');
      for (const a of p.absences) out.push(`- No ${a}.`);
      out.push('');
    }

    if (p.textSample.length) {
      out.push('### Visible text (sample, verbatim)');
      out.push('');
      out.push('Exact strings as they appear — including any typos, which are real and worth noticing.');
      out.push('');
      out.push('```');
      for (const t of p.textSample.slice(0, 30)) out.push(t);
      out.push('```');
      out.push('');
    }
  }

  return out.join('\n');
}
