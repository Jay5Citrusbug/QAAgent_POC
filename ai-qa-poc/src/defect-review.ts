import fs from 'node:fs';
import path from 'node:path';
import { PATHS, rel } from './config.js';
import { listDefects, type DefectCandidate, type DefectSeverity } from './defect.js';
import { acRef } from './test-case-sheet.js';

/**
 * Gate 3 — one page to review every defect candidate, laid out the way a Jira
 * bug is filled in, so a confirmed one can be posted by hand field by field.
 *
 * Nothing here talks to Jira, by decision: a person reads each defect before
 * it reaches the tracker, and posts it themselves. Once posted, the key goes
 * back with `npm run defects -- --confirm <fp> --ticket <KEY>` and the card
 * moves to "Posted".
 *
 * The description block is real HTML. Copied from a browser, it pastes into
 * Jira's editor with headings, lists and code kept, which plain Markdown does
 * not. Classifier and AI notes are deliberately outside it: they are for the
 * reviewer, not for the developer reading the ticket.
 */

const PRIORITY: Record<DefectSeverity, string> = {
  blocker: 'Highest',
  critical: 'High',
  major: 'Medium',
  minor: 'Low',
  trivial: 'Lowest',
};

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Evidence paths are root-relative; the report sits in reports/. */
const fromReport = (p: string): string => `../${p.replace(/\\/g, '/')}`;

type Bucket = 'review' | 'ready' | 'posted' | 'rejected';

function bucketOf(d: DefectCandidate): Bucket {
  if (d.status === 'candidate') return 'review';
  if (d.status === 'confirmed') return d.human_review?.ticket ? 'posted' : 'ready';
  return 'rejected';
}

function featureOf(d: DefectCandidate): string | undefined {
  const locator = String(d.requirement_ref?.locator ?? '');
  return locator.match(/^input\/feature-([^/]+)\//)?.[1] ?? d.title.match(/^\[([^\]]+)\]/)?.[1];
}

function environmentText(d: DefectCandidate): string {
  const e = d.environment;
  return [
    `URL: ${e.url}`,
    e.build ? `Build: ${e.build}` : '',
    `Browser: ${d.seen_in_browsers?.length ? d.seen_in_browsers.join(', ') : (e.browser ?? 'Chromium (Playwright)')}`,
    e.role ? `Role: ${e.role}` : '',
    e.observed_at ? `Observed: ${e.observed_at}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function labelsOf(d: DefectCandidate): string[] {
  const feature = featureOf(d);
  return ['qa-agent', ...(feature ? [feature.toLowerCase().replace(/[^a-z0-9]+/g, '-')] : []), ...(d.test_id ? [d.test_id] : [])];
}

function linkedStory(d: DefectCandidate, texts: Map<string, string>): string | undefined {
  const locator = d.requirement_ref?.locator;
  if (!locator) return undefined;
  const ref = acRef(String(locator), d.requirement_ref?.quote ? String(d.requirement_ref.quote) : undefined, texts);
  return ref === String(locator) ? undefined : ref;
}

/** The ticket body. Everything in here is meant for the developer. */
function description(d: DefectCandidate, story: string | undefined): string {
  const H: string[] = [];
  H.push('<h3>Summary</h3>', `<p>${esc(d.summary)}</p>`);
  if (d.requirement_ref?.quote) {
    H.push(`<h3>Requirement${story ? ` (${esc(story)})` : ''}</h3>`, `<blockquote>${esc(d.requirement_ref.quote)}</blockquote>`);
  }
  if (d.preconditions?.length) {
    H.push('<h3>Preconditions</h3>', '<ul>', ...d.preconditions.map((p) => `<li>${esc(p)}</li>`), '</ul>');
  }
  H.push('<h3>Steps to reproduce</h3>', '<ol>', ...d.steps_to_reproduce.map((s) => `<li>${esc(s.replace(/^\s*\d+[.)]\s*/, ''))}</li>`), '</ol>');
  H.push('<h3>Expected result</h3>', `<p>${esc(d.expected)}</p>`);
  H.push('<h3>Actual result</h3>', `<pre>${esc(d.actual)}</pre>`);
  H.push('<h3>Environment</h3>', `<pre>${esc(environmentText(d))}</pre>`);
  if (d.occurrences > 1) {
    H.push(`<p><b>Reproduced:</b> ${d.occurrences} runs${d.seen_in_builds?.length ? `, builds ${esc(d.seen_in_builds.join(', '))}` : ''}.</p>`);
  }
  if (d.evidence?.length) {
    H.push('<h3>Evidence (attached)</h3>', '<ul>', ...d.evidence.map((e) => `<li>${esc(e.kind)}: ${esc(path.basename(e.path))}</li>`), '</ul>');
  }
  return H.join('\n');
}

function field(label: string, value: string, opts: { copy?: boolean; multiline?: boolean } = {}): string {
  const body = opts.multiline ? `<pre class="v">${esc(value)}</pre>` : `<span class="v">${esc(value)}</span>`;
  return `<div class="f"><div class="k">${esc(label)}</div><div class="val">${body}${opts.copy ? `<button class="cp" data-copy="${esc(value)}">Copy</button>` : ''}</div></div>`;
}

/** Jira links issues, not acceptance criteria: "PROJ-7 AC-2" links to PROJ-7. */
function storyLink(story: string | undefined): string {
  const key = story?.match(/^[A-Z][A-Z0-9]+-\d+/)?.[0];
  if (!story || !key) return story ? field('Requirement', story) : '';
  const ac = story.slice(key.length).trim();
  return field('Link to story', `relates to ${key}${ac ? ` (${ac})` : ''}`).replace(
    '</div></div>',
    `<button class="cp" data-copy="${esc(key)}">Copy key</button></div></div>`,
  );
}

function card(d: DefectCandidate, texts: Map<string, string>): string {
  const bucket = bucketOf(d);
  const story = linkedStory(d, texts);
  const desc = description(d, story);
  const warnings: string[] = [];
  if (d.rests_on_assumption) warnings.push('This test asserted an <b>assumed</b> rule from the clarification ledger, not a confirmed one. Check the assumption before posting: the product may be right.');
  if (d.source === 'exploration') warnings.push('Found by exploration, not by a test case. No requirement covers it, so whether it is a defect is a product decision.');
  if (d.status === 'candidate' && d.classification?.failure_classification && d.classification.failure_classification !== 'PRODUCT_DEFECT') {
    warnings.push(`The classifier thinks this is <b>${esc(d.classification.failure_classification)}</b>, not a product defect.`);
  }

  const shots = (d.evidence ?? []).filter((e) => e.kind === 'screenshot');
  const internal: string[] = [];
  if (d.classification?.failure_classification) {
    internal.push(`<p><b>Classifier:</b> ${esc(d.classification.failure_classification)}${d.classification.confidence ? ` (confidence ${esc(d.classification.confidence)})` : ''}</p>`);
    if (d.classification.rationale?.length) internal.push('<ul>', ...d.classification.rationale.map((r) => `<li>${esc(r)}</li>`), '</ul>');
  }
  if (d.ai_analysis?.summary) {
    internal.push(`<p><b>AI analysis:</b> likely ${esc(d.ai_analysis.likely_cause ?? 'inconclusive')}${d.ai_analysis.confidence ? ` (${esc(d.ai_analysis.confidence)})` : ''}. ${esc(d.ai_analysis.summary)}</p>`);
    for (const f of d.ai_analysis.follow_up ?? []) internal.push(`<p class="muted">Follow-up: ${esc(f)}</p>`);
  }
  const review = d.human_review;
  const decided = review
    ? `<p><b>${esc(review.decision)}</b> by ${esc(review.reviewed_by)} on ${esc(String(review.reviewed_at ?? '').slice(0, 10))}${review.note ? `: ${esc(review.note)}` : ''}</p>`
    : '';

  const confirm = `npm run defects -- --confirm ${d.fingerprint} --by "<your name>" --ticket <JIRA-KEY>`;
  const reject = `npm run defects -- --reject ${d.fingerprint} --by "<your name>" --note "<why>"`;

  return `<article class="card ${bucket}" data-bucket="${bucket}" data-text="${esc(`${d.fingerprint} ${d.title} ${d.test_id ?? ''}`.toLowerCase())}">
<header><span class="sev ${esc(d.severity)}">${esc(d.severity)}</span><h2>${esc(d.title)}</h2>${
    review?.ticket ? `<span class="ticket">${esc(review.ticket)}</span>` : ''
  }</header>
${warnings.map((w) => `<p class="warn">⚠ ${w}</p>`).join('\n')}
<section class="jira">
<h3 class="sec">Jira fields</h3>
${field('Summary', d.title.slice(0, 255), { copy: true })}
${field('Issue Type', 'Bug')}
${field('Priority', `${PRIORITY[d.severity]}`)}
${field('Severity', d.severity)}
${field('Environment', environmentText(d), { copy: true, multiline: true })}
${field('Labels', labelsOf(d).join(' '), { copy: true })}
${storyLink(story)}
<div class="f"><div class="k">Description</div><div class="val"><div class="desc" id="desc-${d.fingerprint}">${desc}</div><button class="cp rich" data-rich="desc-${d.fingerprint}">Copy description (formatted)</button></div></div>
<div class="f"><div class="k">Attachments</div><div class="val">${
    d.evidence?.length
      ? `<ul class="att">${d.evidence.map((e) => `<li><a href="${esc(fromReport(e.path))}">${esc(e.path)}</a> <span class="muted">${esc(e.kind)}</span></li>`).join('')}</ul>${
          shots.length ? `<div class="shots">${shots.map((s) => `<a href="${esc(fromReport(s.path))}"><img loading="lazy" src="${esc(fromReport(s.path))}" alt="${esc(path.basename(s.path))}"></a>`).join('')}</div>` : ''
        }`
      : '<span class="muted">No evidence files.</span>'
  }</div></div>
</section>
${internal.length ? `<details class="internal"><summary>Reviewer notes (do not paste into Jira)</summary>${internal.join('\n')}</details>` : ''}
<footer>${decided}${
    bucket === 'review'
      ? `<div class="cmd"><code>${esc(confirm)}</code><button class="cp" data-copy="${esc(confirm)}">Copy</button></div><div class="cmd"><code>${esc(reject)}</code><button class="cp" data-copy="${esc(reject)}">Copy</button></div>`
      : bucket === 'ready'
        ? `<div class="cmd"><code>${esc(`npm run defects -- --confirm ${d.fingerprint} --by "<your name>" --ticket <JIRA-KEY>`)}</code><button class="cp" data-copy="${esc(`npm run defects -- --confirm ${d.fingerprint} --by "<your name>" --ticket <JIRA-KEY>`)}">Copy</button></div><p class="muted">Posted it? Record the key so the next run links to it instead of raising it again.</p>`
        : ''
  }<p class="muted">Fingerprint ${esc(d.fingerprint)} · first seen ${esc(d.first_seen.slice(0, 10))}${d.test_id ? ` · test ${esc(d.test_id)}` : ''}</p></footer>
</article>`;
}

const SECTIONS: { bucket: Bucket; title: string; note: string }[] = [
  { bucket: 'review', title: 'To review', note: 'Produced by test runs and not yet read by anyone. Confirm or reject each one.' },
  { bucket: 'ready', title: 'Confirmed: ready to post to Jira', note: 'Copy each field into a new Jira Bug, attach the evidence files, then record the key.' },
  { bucket: 'posted', title: 'Posted', note: 'Already in Jira.' },
  { bucket: 'rejected', title: 'Rejected', note: 'Kept so the same failure is not raised again.' },
];

export function renderDefectReview(defects: DefectCandidate[]): string {
  const texts = new Map<string, string>();
  const counts = Object.fromEntries(SECTIONS.map((s) => [s.bucket, defects.filter((d) => bucketOf(d) === s.bucket).length])) as Record<Bucket, number>;
  const order: DefectSeverity[] = ['blocker', 'critical', 'major', 'minor', 'trivial'];
  const sorted = [...defects].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.title.localeCompare(b.title));

  const body = SECTIONS.map((s) => {
    const items = sorted.filter((d) => bucketOf(d) === s.bucket);
    if (!items.length) return '';
    const inner = items.map((d) => card(d, texts)).join('\n');
    return s.bucket === 'rejected' || s.bucket === 'posted'
      ? `<details class="group"><summary><h2 class="gt">${s.title} (${items.length})</h2></summary><p class="muted">${s.note}</p>${inner}</details>`
      : `<section class="group"><h2 class="gt">${s.title} (${items.length})</h2><p class="muted">${s.note}</p>${inner}</section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Defect Review</title>
<style>
:root{--bg:#f7f7f8;--card:#fff;--fg:#1b1b1f;--muted:#6b6b76;--line:#e4e4e9;--bad:#c4302b;--badbg:#fdecea;--warn:#a05a00;--warnbg:#fff4e0;--info:#1f5fbf;--infobg:#e8f0fd;--ok:#1a7f4b;--okbg:#e6f4ec;--code:#f1f1f4}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#111114;--card:#1a1a1f;--fg:#ececf1;--muted:#9a9aa6;--line:#2c2c34;--bad:#ff6b63;--badbg:#341513;--warn:#f0a83a;--warnbg:#33240c;--info:#7aa7ff;--infobg:#142240;--ok:#4cc38a;--okbg:#10291c;--code:#24242b}}
:root[data-theme=dark]{--bg:#111114;--card:#1a1a1f;--fg:#ececf1;--muted:#9a9aa6;--line:#2c2c34;--bad:#ff6b63;--badbg:#341513;--warn:#f0a83a;--warnbg:#33240c;--info:#7aa7ff;--infobg:#142240;--ok:#4cc38a;--okbg:#10291c;--code:#24242b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px}h1{margin:0 0 4px;font-size:22px}
.top{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.stats{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px}.stat b{font-size:18px;display:block}
.tools{display:flex;gap:8px;margin-bottom:8px}input[type=search]{flex:1;min-width:0;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
.gt{font-size:17px;margin:24px 0 4px;display:inline}.group>summary{cursor:pointer;margin-top:24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
.card header{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.card h2{font-size:16px;margin:0;flex:1;min-width:0;overflow-wrap:anywhere}
.sev{font-size:12px;font-weight:600;text-transform:uppercase;padding:2px 8px;border-radius:999px;background:var(--infobg);color:var(--info)}
.sev.blocker,.sev.critical{background:var(--badbg);color:var(--bad)}.sev.major{background:var(--warnbg);color:var(--warn)}
.ticket{background:var(--okbg);color:var(--ok);padding:2px 8px;border-radius:6px;font-weight:600}
.warn{background:var(--warnbg);color:var(--warn);padding:8px 10px;border-radius:6px;margin:8px 0}
.sec{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:14px 0 6px}
.f{display:grid;grid-template-columns:130px 1fr;gap:8px;padding:6px 0;border-top:1px solid var(--line)}
@media (max-width:600px){.f{grid-template-columns:1fr}}
.k{color:var(--muted);font-weight:600}.val{min-width:0}.val pre,.desc pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--code);padding:8px;border-radius:6px;margin:0}
.desc{border:1px dashed var(--line);border-radius:6px;padding:4px 12px;margin-bottom:6px}.desc h3{font-size:14px;margin:12px 0 4px}.desc blockquote{margin:0;padding-left:10px;border-left:3px solid var(--line);color:var(--muted)}
button.cp{margin-left:8px;font:inherit;font-size:12px;padding:3px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);cursor:pointer}button.cp.done{color:var(--ok);border-color:var(--ok)}
.rich{margin-left:0!important}.att{margin:0;padding-left:18px;overflow-wrap:anywhere}.shots{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.shots img{max-width:220px;max-height:140px;border:1px solid var(--line);border-radius:6px}
.internal{margin-top:12px;background:var(--infobg);border-radius:6px;padding:8px 12px}.internal summary{cursor:pointer;color:var(--info);font-weight:600}
footer{margin-top:12px}.cmd{display:flex;align-items:center;gap:4px;margin:4px 0;min-width:0}.cmd code{flex:1;min-width:0;overflow-wrap:anywhere;background:var(--code);padding:4px 8px;border-radius:6px;font-size:12px}
.muted{color:var(--muted);font-size:12px}#theme{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);cursor:pointer}
</style></head><body><main>
<div class="top"><div><h1>Defect Review</h1><div class="muted">Generated ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC · nothing on this page has been sent to Jira</div></div><button id="theme">Theme</button></div>
<div class="stats">${SECTIONS.map((s) => `<div class="stat"><b>${counts[s.bucket]}</b>${s.title.split(':')[0]}</div>`).join('')}</div>
${defects.length ? `<div class="tools"><input type="search" id="q" placeholder="Search by title, test id or fingerprint"></div>${body}` : '<p>No defects on file. Runs write candidates here automatically when a test fails as a product defect.</p>'}
</main>
<script>
function flash(b){var t=b.textContent;b.textContent='Copied';b.classList.add('done');setTimeout(function(){b.textContent=t;b.classList.remove('done')},1200)}
function copyText(s,b){function fb(){var a=document.createElement('textarea');a.value=s;document.body.appendChild(a);a.select();document.execCommand('copy');a.remove();flash(b)}
if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(s).then(function(){flash(b)},fb)}else fb()}
function copyRich(el,b){var r=document.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r);document.execCommand('copy');s.removeAllRanges();flash(b)}
document.addEventListener('click',function(e){var b=e.target.closest('button.cp');if(!b)return;if(b.dataset.rich)copyRich(document.getElementById(b.dataset.rich),b);else copyText(b.dataset.copy,b)});
var q=document.getElementById('q');if(q)q.addEventListener('input',function(){var v=q.value.toLowerCase();document.querySelectorAll('.card').forEach(function(c){c.style.display=!v||c.dataset.text.indexOf(v)>-1?'':'none'})});
document.getElementById('theme').onclick=function(){var r=document.documentElement;var dark=r.dataset.theme?r.dataset.theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches;r.dataset.theme=dark?'light':'dark'};
</script></body></html>
`;
}

export function reviewReportPath(): string {
  return path.join(PATHS.reports, 'DEFECT-REVIEW.html');
}

/** Rewrite the review page from every defect on file. Returns its path, root-relative. */
export function writeDefectReview(): { file: string; counts: Record<Bucket, number> } {
  const defects = listDefects();
  fs.mkdirSync(PATHS.reports, { recursive: true });
  const file = reviewReportPath();
  fs.writeFileSync(file, renderDefectReview(defects), 'utf8');
  const counts = { review: 0, ready: 0, posted: 0, rejected: 0 } as Record<Bucket, number>;
  for (const d of defects) counts[bucketOf(d)]++;
  return { file: rel(file), counts };
}
