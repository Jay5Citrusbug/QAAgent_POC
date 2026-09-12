import type { Capture } from './captures.js';
import type { ControlFact, PageReality } from './inspector.js';

/**
 * Build diff — regression detection with no test cases at all.
 *
 * Every other check in this system finds what somebody thought to look for.
 * This finds what *changed*, which is a different and often better question:
 * nobody wrote a test case saying "the Remember me checkbox should still be
 * there", and nobody ever will, because it is only worth asserting once it has
 * gone missing.
 *
 * It answers the thing this system gets asked most: *what if something quietly
 * broke on a page my test cases do not reach?*
 *
 * Two rules, both learned the expensive way elsewhere in this codebase:
 *
 *  1. **A diff is an observation, never a verdict.** A removed control may be a
 *     deliberate redesign. Reporting it as a defect would be a false positive
 *     on every intentional change, and a check that cries wolf gets muted.
 *
 *  2. **Renames are detected, not reported as add + remove.** "Sign in became
 *     Log in" is one fact a human can judge in a second. The same thing split
 *     into two lines reads as a feature deleted and an unrelated one added,
 *     which is actively misleading.
 */

export type ChangeKind =
  | 'control_added'
  | 'control_removed'
  | 'control_renamed'
  | 'control_count_changed'
  | 'heading_changed'
  | 'image_broke'
  | 'image_fixed'
  | 'page_added'
  | 'page_removed'
  | 'ambiguity_introduced';

export interface Change {
  kind: ChangeKind;
  /** Which page it happened on, so a human can get back to it. */
  url: string;
  summary: string;
  detail?: string;
  /** Changes worth reading first. Not a severity — nothing here is a defect. */
  notable: boolean;
}

export interface DiffReport {
  from: { captured_at: string; build: string };
  to: { captured_at: string; build: string };
  changes: Change[];
}

/** Levenshtein, small strings only — same approach as near-miss.ts. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = curr;
  }
  return prev[b.length] ?? 0;
}

function similarity(a: string, b: string): number {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (!x && !y) return 1;
  const longest = Math.max(x.length, y.length);
  return longest === 0 ? 1 : 1 - distance(x, y) / longest;
}

const key = (c: ControlFact): string => `${c.role}\u0000${c.name}`;

/**
 * A removed control and an added control of the same role with a similar name
 * are almost always one control that got renamed.
 *
 * The 0.55 threshold is deliberately generous. A missed rename costs two
 * confusing lines; a false rename costs a wrong story about what happened, and
 * the wrong story is harder to recover from than noise.
 */
function matchRenames(
  removed: ControlFact[],
  added: ControlFact[],
): { renames: [ControlFact, ControlFact][]; removed: ControlFact[]; added: ControlFact[] } {
  const renames: [ControlFact, ControlFact][] = [];
  const takenAdded = new Set<ControlFact>();
  const takenRemoved = new Set<ControlFact>();

  for (const gone of removed) {
    let best: ControlFact | undefined;
    let bestScore = 0;
    for (const fresh of added) {
      if (takenAdded.has(fresh) || fresh.role !== gone.role) continue;
      const score = similarity(gone.name, fresh.name);
      if (score > bestScore) {
        bestScore = score;
        best = fresh;
      }
    }
    if (best && bestScore >= 0.55) {
      renames.push([gone, best]);
      takenAdded.add(best);
      takenRemoved.add(gone);
    }
  }

  return {
    renames,
    removed: removed.filter((c) => !takenRemoved.has(c)),
    added: added.filter((c) => !takenAdded.has(c)),
  };
}

/**
 * Controls whose disappearance is worth reading first.
 *
 * Not a severity ranking — a heuristic about what a human should look at
 * before the rest. An interactive control vanishing changes what a user can
 * do; a heading changing usually does not.
 */
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'switch', 'tab']);

function diffPage(before: PageReality, after: PageReality): Change[] {
  const changes: Change[] = [];
  const url = after.url;

  const beforeByKey = new Map(before.controls.map((c) => [key(c), c]));
  const afterByKey = new Map(after.controls.map((c) => [key(c), c]));

  const removedRaw = before.controls.filter((c) => !afterByKey.has(key(c)));
  const addedRaw = after.controls.filter((c) => !beforeByKey.has(key(c)));
  const { renames, removed, added } = matchRenames(removedRaw, addedRaw);

  for (const [gone, fresh] of renames) {
    changes.push({
      kind: 'control_renamed',
      url,
      summary: `${gone.role} "${gone.name}" is now called "${fresh.name}"`,
      detail:
        'Any intent or mission targeting the old accessible name will no longer resolve. ' +
        'Re-bind before the next run.',
      notable: true,
    });
  }

  for (const gone of removed) {
    changes.push({
      kind: 'control_removed',
      url,
      summary: `${gone.role} "${gone.name}" is gone`,
      detail: gone.regions.length ? `Was in: ${gone.regions.join(', ')}` : undefined,
      notable: INTERACTIVE.has(gone.role),
    });
  }

  for (const fresh of added) {
    changes.push({
      kind: 'control_added',
      url,
      summary: `new ${fresh.role} "${fresh.name}"`,
      detail: 'Nothing covers this yet — worth asking whether it needs an intent.',
      notable: INTERACTIVE.has(fresh.role),
    });
  }

  // Count changes on a control that still exists: three "Delete" buttons where
  // there was one is a real change, and an exact-key match hides it.
  for (const [k, after_] of afterByKey) {
    const before_ = beforeByKey.get(k);
    if (before_ && before_.count !== after_.count) {
      changes.push({
        kind: 'control_count_changed',
        url,
        summary: `${after_.role} "${after_.name}": ${before_.count} → ${after_.count}`,
        detail:
          after_.count > 1 && before_.count === 1
            ? 'Newly ambiguous: a target naming it without a "within" scope now matches more than one element.'
            : undefined,
        notable: after_.count > before_.count,
      });
    }
  }

  const beforeAmbiguous = new Set(before.ambiguous.map(key));
  for (const amb of after.ambiguous) {
    if (!beforeAmbiguous.has(key(amb))) {
      changes.push({
        kind: 'ambiguity_introduced',
        url,
        summary: `"${amb.name}" (${amb.role}) now matches ${amb.count} elements`,
        detail: 'Bindings that relied on it being unique will now refuse to resolve rather than guess.',
        notable: true,
      });
    }
  }

  const beforeImages = new Map(before.images.map((i) => [i.src, i]));
  for (const img of after.images) {
    const was = beforeImages.get(img.src);
    if (!was) continue;
    if (was.loaded && !img.loaded) {
      changes.push({
        kind: 'image_broke',
        url,
        summary: `image no longer loads: ${img.alt || img.src}`,
        detail: img.src,
        notable: true,
      });
    } else if (!was.loaded && img.loaded) {
      changes.push({
        kind: 'image_fixed',
        url,
        summary: `image now loads: ${img.alt || img.src}`,
        notable: false,
      });
    }
  }

  const beforeHeadings = new Set(before.headings.map((h) => `${h.level}:${h.text}`));
  const afterHeadings = new Set(after.headings.map((h) => `${h.level}:${h.text}`));
  for (const h of afterHeadings) {
    if (!beforeHeadings.has(h)) {
      changes.push({ kind: 'heading_changed', url, summary: `new heading: ${h.split(':').slice(1).join(':')}`, notable: false });
    }
  }
  for (const h of beforeHeadings) {
    if (!afterHeadings.has(h)) {
      changes.push({ kind: 'heading_changed', url, summary: `heading gone: ${h.split(':').slice(1).join(':')}`, notable: false });
    }
  }

  return changes;
}

export function diffCaptures(previous: Capture, current: Capture): DiffReport {
  const changes: Change[] = [];

  const beforePages = new Map(previous.pages.map((p) => [p.url, p]));
  const afterPages = new Map(current.pages.map((p) => [p.url, p]));

  for (const [url, after] of afterPages) {
    const before = beforePages.get(url);
    if (!before) {
      changes.push({ kind: 'page_added', url, summary: `page inspected for the first time: ${url}`, notable: false });
      continue;
    }
    changes.push(...diffPage(before, after));
  }

  for (const [url] of beforePages) {
    if (!afterPages.has(url)) {
      changes.push({
        kind: 'page_removed',
        url,
        summary: `page not inspected this time: ${url}`,
        detail: 'Either it was dropped from the inspection list or it stopped responding — those are very different.',
        notable: true,
      });
    }
  }

  return {
    from: { captured_at: previous.captured_at, build: previous.build },
    to: { captured_at: current.captured_at, build: current.build },
    changes,
  };
}

export function renderDiff(report: DiffReport): string {
  const lines: string[] = [];
  lines.push(`# Build diff`);
  lines.push('');
  lines.push(`\`${report.from.build}\` (${report.from.captured_at}) → \`${report.to.build}\` (${report.to.captured_at})`);
  lines.push('');

  if (report.changes.length === 0) {
    lines.push('No structural change between these two captures.');
    lines.push('');
    lines.push('That is a useful fact, not an empty result: nothing a page capture can see');
    lines.push('has moved, so any behaviour change since the last build is not a change in');
    lines.push('what is on the page.');
    return `${lines.join('\n')}\n`;
  }

  const notable = report.changes.filter((c) => c.notable);
  const rest = report.changes.filter((c) => !c.notable);

  lines.push(
    `${report.changes.length} change(s), ${notable.length} worth reading first.`,
    '',
    '> These are **observations, not defects.** A removed control may be a deliberate',
    '> redesign. Nothing here has been graded, and nothing here changes any test result.',
    '',
  );

  if (notable.length) {
    lines.push('## Read these first', '');
    for (const c of notable) {
      lines.push(`* **${c.summary}**`);
      lines.push(`  * where: ${c.url}`);
      if (c.detail) lines.push(`  * ${c.detail}`);
    }
    lines.push('');
  }

  if (rest.length) {
    lines.push('## Everything else', '');
    for (const c of rest) lines.push(`* ${c.summary} — ${c.url}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}
