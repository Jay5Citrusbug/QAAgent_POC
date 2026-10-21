import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { PATHS, rel } from './config.js';

/**
 * Visual comparison — did the page change how it LOOKS since a person last
 * approved it?
 *
 * Every other check reads the DOM, and the DOM cannot see a white icon on a
 * white background, a button rendered off-brand, a font that failed to load,
 * text overlapping an image. A screenshot compared with an approved baseline
 * can.
 *
 * Two rules:
 *
 *  - A baseline is approved by a person, never adopted silently. The first
 *    screenshot of a test is a *candidate*; until someone approves it there is
 *    nothing to compare with, and the result says so.
 *  - A difference is a finding, not a FAIL. Most visual changes between builds
 *    are intended; whether this one is a bug is a Gate 3 judgement. A test that
 *    must look identical uses the `looks_like_baseline` check instead.
 *
 * Noise control: animations frozen, text caret hidden, anything marked
 * `data-visual-ignore` masked (clocks, ads, avatars), and a per-pixel colour
 * tolerance so anti-aliasing differences do not count.
 */

/** Share of pixels that may differ before it counts as a change (default 0.2%). */
export const VISUAL_TOLERANCE = Number(process.env.VISUAL_TOLERANCE ?? 0.002);
/**
 * Changed pixels that always count, however small a share of the page.
 *
 * A share alone missed the case this exists for: a 32px icon turning white on
 * white is 0.01% of a desktop page. pixelmatch already ignores anti-aliasing,
 * so an unchanged page measures 0 here; a few dozen real pixels is a change.
 */
export const VISUAL_MIN_PIXELS = Number(process.env.VISUAL_MIN_PIXELS ?? 25);
/** Per-pixel colour threshold passed to pixelmatch (0 strict … 1 lax). */
const PIXEL_THRESHOLD = 0.1;

export interface VisualResult {
  status: 'no_baseline' | 'same' | 'changed';
  /** Share of pixels that differ, 0..1. */
  diff_ratio?: number;
  baseline?: string;
  current: string;
  diff?: string;
  size_changed?: string;
  /** Changed pixels, and the box around them, so a reviewer knows where to look. */
  changed_pixels?: number;
  region?: { x: number; y: number; width: number; height: number };
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'default';
}

export function baselineDir(testId: string, viewport: string): string {
  return path.join(PATHS.root, 'baselines', testId, slug(viewport));
}

/** The baseline key for a page: its real size, so mobile and desktop never compare. */
export function viewportKey(page: Page): string {
  const v = page.viewportSize();
  // Engines render fonts and controls differently, so each keeps its own baseline.
  const engine = page.context().browser()?.browserType().name() ?? 'chromium';
  return `${engine}-${v ? `${v.width}x${v.height}` : 'default'}`;
}

/**
 * The baseline key for one page of a test: engine and size, plus the page.
 * A flow through four pages keeps four baselines, one per page.
 */
export function visualKey(page: Page): string {
  let path = '/';
  try {
    path = new URL(page.url()).pathname;
  } catch {
    /* about:blank and the like */
  }
  const slug = path.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'home';
  return `${viewportKey(page)}__${slug}`;
}

/** Screenshot the page as it stands, with the usual sources of noise removed. */
export async function capturePage(page: Page): Promise<Buffer> {
  return page.screenshot({
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
    mask: [page.locator('[data-visual-ignore]')],
  });
}

/**
 * Compare a screenshot with the approved baseline and keep the evidence.
 * `evidenceDir` gets current.png, and diff.png when something changed.
 */
export function compareWithBaseline(shot: Buffer, testId: string, viewport: string, evidenceDir: string, tag?: string): VisualResult {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const suffix = tag ? `-${slug(tag)}` : '';
  const currentFile = path.join(evidenceDir, `visual-current${suffix}.png`);
  fs.writeFileSync(currentFile, shot);

  const dir = baselineDir(testId, viewport);
  const baselineFile = path.join(dir, 'baseline.png');
  // The newest screenshot is always offered as the next candidate.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'candidate.png'), shot);

  if (!fs.existsSync(baselineFile)) return { status: 'no_baseline', current: rel(currentFile) };

  const a = PNG.sync.read(fs.readFileSync(baselineFile));
  const b = PNG.sync.read(shot);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  // Pad both to the same size: a page that grew or shrank is itself a change,
  // and the padding makes the new or missing area count as different.
  const pad = (img: PNG) => {
    if (img.width === width && img.height === height) return img.data;
    const out = new PNG({ width, height });
    out.data.fill(0);
    PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
    return out.data;
  };
  const diff = new PNG({ width, height });
  const changed = pixelmatch(pad(a), pad(b), diff.data, width, height, { threshold: PIXEL_THRESHOLD, alpha: 0.3 });
  const ratio = changed / (width * height);
  // pixelmatch paints real differences pure red (anti-aliasing is yellow): box them.
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let i = 0; i < diff.data.length; i += 4) {
    if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) {
      const p = i / 4;
      const x = p % width;
      const y = Math.floor(p / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const region = maxX >= 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : undefined;
  const sizeChanged = a.width !== b.width || a.height !== b.height ? `${a.width}×${a.height} → ${b.width}×${b.height}` : undefined;

  if (ratio <= VISUAL_TOLERANCE && changed < VISUAL_MIN_PIXELS && !sizeChanged) {
    return { status: 'same', diff_ratio: ratio, changed_pixels: changed, baseline: rel(baselineFile), current: rel(currentFile) };
  }
  const diffFile = path.join(evidenceDir, `visual-diff${suffix}.png`);
  fs.writeFileSync(diffFile, PNG.sync.write(diff));
  return {
    status: 'changed',
    diff_ratio: ratio,
    baseline: rel(baselineFile),
    current: rel(currentFile),
    diff: rel(diffFile),
    changed_pixels: changed,
    ...(region ? { region } : {}),
    ...(sizeChanged ? { size_changed: sizeChanged } : {}),
  };
}

/** "412 pixels changed in the area at 16,18 (32×32)" — what a reviewer needs to find it. */
export function describeChange(vr: VisualResult): string {
  const where = vr.region ? ` in the area at ${vr.region.x},${vr.region.y} (${vr.region.width}×${vr.region.height}px)` : '';
  const size = vr.size_changed ? `; page size ${vr.size_changed}` : '';
  return `${vr.changed_pixels ?? 0} pixel(s) changed${where}${size}`;
}

export interface BaselineApproval {
  approved_by: string;
  approved_at: string;
  from_run?: string;
}

/** Promote the latest candidate to the approved baseline. */
export function approveBaseline(testId: string, viewport: string, by: string): string {
  const dir = baselineDir(testId, viewport);
  const candidate = path.join(dir, 'candidate.png');
  if (!fs.existsSync(candidate)) throw new Error(`No candidate screenshot for ${testId} at ${viewport}. Run the test first.`);
  fs.copyFileSync(candidate, path.join(dir, 'baseline.png'));
  const meta: BaselineApproval = { approved_by: by, approved_at: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'approval.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return rel(path.join(dir, 'baseline.png'));
}

/** Every baseline folder, with its state. */
export function listBaselines(): { testId: string; viewport: string; approved?: BaselineApproval; hasCandidate: boolean; hasBaseline: boolean }[] {
  const root = path.join(PATHS.root, 'baselines');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const testId of fs.readdirSync(root).sort()) {
    const tdir = path.join(root, testId);
    if (!fs.statSync(tdir).isDirectory()) continue;
    for (const vp of fs.readdirSync(tdir).sort()) {
      const dir = path.join(tdir, vp);
      const meta = path.join(dir, 'approval.json');
      out.push({
        testId,
        viewport: vp,
        hasCandidate: fs.existsSync(path.join(dir, 'candidate.png')),
        hasBaseline: fs.existsSync(path.join(dir, 'baseline.png')),
        ...(fs.existsSync(meta) ? { approved: JSON.parse(fs.readFileSync(meta, 'utf8')) as BaselineApproval } : {}),
      });
    }
  }
  return out;
}
