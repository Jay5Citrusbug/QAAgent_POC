import fs from 'node:fs';
import path from 'node:path';
import { PATHS, rel } from './config.js';
import { listDefects, type DefectCandidate } from './defect.js';
import { assessTrust } from './executor.js';
import { listIntents, readIntentFile } from './intents.js';
import type { NetworkEntry } from './step-evidence.js';
import { readMissionFile } from './validate.js';
import type { VerifyReport } from './verify.js';
import type { AssertionResult, ExecutionResult, StepRecord, TestIntent, TestMission } from './types.js';

/**
 * The execution report as one HTML page — the thing a reviewer opens after a run.
 *
 * Built for the question "can I trust what the AI just told me?":
 *
 *   - what did NOT run comes first, before any pass rate
 *   - every test shows its flow step by step, with the element each step used
 *     outlined in a screenshot, the page after it, and the URL it reached
 *   - every check shows expected vs actual, and HOW it matched (exact,
 *     normalised, or AI judging the meaning)
 *   - a trust chip per test: "verified" (exact matches only) or "review"
 *     (names the steps where a fallback or AI decision was involved)
 *   - the screen recording, jumped to where this test starts
 *   - the API calls the page made, failures highlighted, bodies expandable
 *   - defects in full bug format
 *
 * Self-contained: styles and script inline, evidence referenced by relative
 * path, so the report folder can be zipped and opened anywhere.
 */

export interface HtmlReportInput {
  feature?: string;
  results: ExecutionResult[];
  verification?: VerifyReport;
  baseUrl?: string;
}

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Evidence paths are relative to the project root; the report lives in reports/. */
const href = (p: string | undefined): string => (p ? esc(`../${p.replace(/\\/g, '/')}`) : '');

function readJson<T>(p: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(PATHS.root, p), 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function missionsById(): Map<string, TestMission> {
  const out = new Map<string, TestMission>();
  for (const dir of [PATHS.missionsApproved, PATHS.missionsDraft]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        const m = readMissionFile(path.join(dir, f));
        if (!out.has(m.test_id)) out.set(m.test_id, m);
      } catch {
        /* validate reports malformed files */
      }
    }
  }
  return out;
}

function ms(n?: number): string {
  if (n === undefined) return '—';
  return n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`;
}

const STRATEGY_LABEL: Record<string, string> = {
  cache: 'cached',
  test_id: 'test id',
  role_name: 'exact role + name',
  label: 'exact label',
  placeholder: 'placeholder',
  text: 'exact text',
  selector: 'CSS selector',
  fuzzy: 'fuzzy wording',
  synonym: 'synonym',
  ai: 'AI choice',
  none: '—',
};

function strategyChip(s?: string): string {
  if (!s || s === 'none') return '';
  const cls = s === 'ai' ? 'chip warn' : s === 'fuzzy' || s === 'synonym' ? 'chip info' : 'chip ok';
  return `<span class="${cls}">${esc(STRATEGY_LABEL[s] ?? s)}</span>`;
}

function matchChip(m?: string): string {
  if (!m) return '';
  const cls = m === 'semantic' ? 'chip warn' : m === 'normalised' ? 'chip info' : 'chip ok';
  const label = m === 'semantic' ? 'AI: same meaning' : m === 'normalised' ? 'case/spacing ignored' : 'exact';
  return `<span class="${cls}">${label}</span>`;
}

function thumb(p: string | undefined, caption: string): string {
  if (!p) return '';
  return `<figure class="thumb"><a href="${href(p)}" data-lightbox data-caption="${esc(caption)}"><img loading="lazy" src="${href(p)}" alt="${esc(caption)}"></a><figcaption>${esc(caption)}</figcaption></figure>`;
}

function stepRows(steps: StepRecord[]): string {
  if (steps.length === 0) return '<p class="muted">No steps were executed.</p>';
  return `<table class="steps"><thead><tr><th>#</th><th>Step</th><th>Element used</th><th>Result</th><th>Evidence</th></tr></thead><tbody>${steps
    .map((s) => {
      const outcome =
        s.outcome === 'OK'
          ? '<span class="chip ok">done</span>'
          : s.outcome === 'TOLERATED_FAILURE'
            ? '<span class="chip info">refused, as expected</span>'
            : s.outcome === 'SKIPPED'
              ? '<span class="chip muted">skipped</span>'
              : '<span class="chip bad">failed</span>';
      return `<tr class="${s.outcome === 'FAILED' ? 'row-bad' : ''}">
        <td>${s.index}</td>
        <td><div class="act">${esc(s.action)}</div>${esc(s.instruction)}${s.url ? `<div class="url">${esc(s.url)}</div>` : ''}</td>
        <td>${strategyChip(s.resolution_strategy)}${s.resolved_locator && s.resolution_strategy !== 'none' ? `<code>${esc(s.resolved_locator)}</code>` : ''}${s.resolution_note ? `<div class="note">${esc(s.resolution_note)}</div>` : ''}</td>
        <td>${outcome}${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}${s.duration_ms !== undefined ? `<div class="muted small">${ms(s.duration_ms)}</div>` : ''}</td>
        <td class="shots">${thumb(s.target_screenshot, `Step ${s.index}: element used`)}${thumb(s.screenshot, `Step ${s.index}: after`)}</td>
      </tr>`;
    })
    .join('')}</tbody></table>`;
}

function checkRows(checks: AssertionResult[]): string {
  if (checks.length === 0) return '<p class="muted">No checks were evaluated.</p>';
  return `<table class="checks"><thead><tr><th>Check</th><th>Expected</th><th>Actual</th><th>Result</th><th>Evidence</th></tr></thead><tbody>${checks
    .map((a) => {
      const verdict =
        a.evaluable === false
          ? '<span class="chip muted">could not evaluate</span>'
          : a.passed
            ? '<span class="chip ok">held</span>'
            : '<span class="chip bad">did not hold</span>';
      return `<tr class="${!a.passed && a.evaluable !== false ? 'row-bad' : ''}">
        <td><b>${esc(a.id)}</b>${a.critical ? '' : ' <span class="chip muted">non-critical</span>'}<div class="muted small">${esc(a.check_type ?? '')}</div></td>
        <td>${esc(a.statement)}${a.expected_value !== undefined ? `<div class="val">"${esc(a.expected_value)}"</div>` : ''}</td>
        <td>${a.observed ? `<div class="val">${esc(a.observed)}</div>` : '<span class="muted">—</span>'}${a.error && !a.passed ? `<div class="err">${esc(a.error)}</div>` : ''}${a.resolution_note ? `<div class="note">${esc(a.resolution_note)}</div>` : ''}</td>
        <td>${verdict} ${matchChip(a.match)}${a.match_note ? `<div class="note">${esc(a.match_note)}</div>` : ''}</td>
        <td class="shots">${thumb(a.screenshot, `Check ${a.id}`)}</td>
      </tr>`;
    })
    .join('')}</tbody></table>`;
}

function networkBlock(r: ExecutionResult): string {
  if (!r.network) return '';
  const entries = readJson<NetworkEntry[]>(r.network.path) ?? [];
  if (entries.length === 0) return `<details class="sub"><summary>API calls (none)</summary></details>`;
  const rows = entries
    .map((e) => {
      const bad = e.status === null || e.status >= 400;
      const body =
        e.request_body || e.response_body || e.failure
          ? `<details><summary>body</summary>${e.request_body ? `<div class="muted small">request</div><pre>${esc(e.request_body)}</pre>` : ''}${e.response_body ? `<div class="muted small">response</div><pre>${esc(e.response_body)}</pre>` : ''}${e.failure ? `<pre>${esc(e.failure)}</pre>` : ''}</details>`
          : '';
      return `<tr class="${bad ? 'row-bad' : ''}"><td>${esc(e.method)}</td><td class="u">${esc(e.url)}</td><td>${e.status === null ? '<span class="chip bad">failed</span>' : `<span class="chip ${bad ? 'bad' : 'ok'}">${e.status}</span>`}</td><td>${ms(e.duration_ms)}</td><td>${body}</td></tr>`;
    })
    .join('');
  return `<details class="sub" ${r.network.failed ? 'open' : ''}><summary>API calls — ${r.network.total} total, ${r.network.failed} failed</summary><table class="net"><thead><tr><th>Method</th><th>URL</th><th>Status</th><th>Time</th><th></th></tr></thead><tbody>${rows}</tbody></table></details>`;
}

function videoBlock(r: ExecutionResult, byVideo: Map<string, string[]>): string {
  if (!r.video) return '';
  const others = (byVideo.get(r.video.path) ?? []).filter((id) => id !== r.test_id);
  const t = (r.video.offset_ms / 1000).toFixed(1);
  return `<div class="video"><video controls preload="metadata" src="${href(r.video.path)}#t=${t}"></video>
    <p class="muted small">${others.length ? `This recording also contains ${esc(others.join(', '))} — it opens at ${t}s, where ${esc(r.test_id)} starts.` : `Recording of ${esc(r.test_id)}.`}</p></div>`;
}

function whyBlock(r: ExecutionResult, m?: TestMission): string {
  if (r.status === 'PASS') {
    const trust = r.evidence_trust ?? 'verified';
    return `<div class="callout ${trust === 'verified' ? 'ok' : 'warn'}"><b>How it passed.</b> ${
      trust === 'verified'
        ? 'Every step used an exactly matching element and every check matched exactly. The screenshots below show each element used and the page after each step.'
        : 'It passed, but some of the evidence rests on tolerant or AI matching. Look at these before trusting it:'
    }${r.trust_reasons?.length ? `<ul>${r.trust_reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
  }
  const failedCheck = r.assertion_results?.find((a) => !a.passed && a.evaluable !== false);
  const failedStep = r.steps_executed.find((s) => s.outcome === 'FAILED');
  const parts: string[] = [];
  if (failedStep) parts.push(`<p><b>Stopped at step ${failedStep.index}</b> — ${esc(failedStep.instruction)}</p><p class="err">${esc(failedStep.error ?? '')}</p>`);
  if (failedCheck) {
    parts.push(`<div class="grid2"><div><div class="muted small">Expected</div><div class="val">${esc(failedCheck.statement)}${failedCheck.expected_value ? `<br>"${esc(failedCheck.expected_value)}"` : ''}</div></div><div><div class="muted small">Actual</div><div class="val">${esc(failedCheck.observed ?? '—')}</div></div></div>`);
  }
  if (r.failure_classification) {
    parts.push(`<p><b>Proposed cause:</b> ${esc(r.failure_classification)} (confidence ${esc(r.confidence)})${r.classification_rationale?.length ? `</p><ul>${r.classification_rationale.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '</p>'}`);
  }
  if (r.ai_analysis?.status === 'available') {
    parts.push(`<p><b>AI review (${esc(r.ai_analysis.model)}):</b> ${esc(r.ai_analysis.summary)}</p>`);
  }
  if (r.replay?.attempted) parts.push(`<p class="muted small">Replay: ${esc(r.replay.note)}</p>`);
  const notes = r.notes.filter((n) => !/deterministic replay pass/.test(n));
  if (notes.length) parts.push(`<details class="sub"><summary>Notes (${notes.length})</summary><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>`);
  const cls = r.status === 'FAIL' ? 'bad' : 'warn';
  const head = r.status === 'FAIL' ? 'Why it failed.' : r.status === 'BLOCKED' ? 'Why it could not run to the end.' : 'Why there is no verdict.';
  void m;
  return `<div class="callout ${cls}"><b>${head}</b>${parts.join('')}</div>`;
}

function testCard(r: ExecutionResult, m: TestMission | undefined, byVideo: Map<string, string[]>): string {
  const quote = (r.requirement_ref as { quote?: string } | undefined)?.quote;
  const trust = r.evidence_trust ?? 'weak';
  const evidence = r.evidence.filter((e) => /trace\.zip|execution\.log|failure-snapshot|network\.json/.test(e));
  return `<details class="test" data-status="${esc(r.status)}" data-trust="${esc(trust)}" data-search="${esc(`${r.test_id} ${r.test_objective ?? ''}`.toLowerCase())}" ${r.status !== 'PASS' ? 'open' : ''}>
  <summary>
    <span class="badge ${esc(r.status)}">${esc(r.status)}</span>
    <span class="tid">${esc(r.test_id)}</span>
    <span class="obj">${esc(r.test_objective ?? m?.test_objective ?? '')}</span>
    <span class="chip ${trust === 'verified' ? 'ok' : trust === 'review' ? 'warn' : 'muted'}" title="${esc((r.trust_reasons ?? []).join('\n'))}">${trust}</span>
    <span class="muted small">${ms(r.duration_ms)}</span>
  </summary>
  <div class="body">
    <div class="meta">
      ${quote ? `<div><span class="muted small">Requirement</span><blockquote>${esc(quote)}</blockquote></div>` : ''}
      <div class="kv"><span>Expected outcome</span><b>${esc(m?.expected_outcome === 'blocked' ? 'the application refuses' : 'the action succeeds')}</b>
      <span>Role</span><b>${esc(r.role)}</b>
      <span>Session</span><b>${r.session?.fresh ? 'fresh browser' : `continued from ${esc(r.session?.inherited_from ?? 'previous test')}`}</b>
      ${m?.preconditions?.length ? `<span>Preconditions</span><b>${m.preconditions.map(esc).join('; ')}</b>` : ''}</div>
    </div>
    ${whyBlock(r, m)}
    <h4>Flow</h4>
    ${stepRows(r.steps_executed)}
    <h4>Checks — expected vs actual</h4>
    ${checkRows(r.assertion_results ?? [])}
    ${videoBlock(r, byVideo)}
    ${networkBlock(r)}
    ${r.incidental_findings?.length ? `<details class="sub"><summary>Also noticed (${r.incidental_findings.length}) — not part of this test's verdict</summary><ul>${r.incidental_findings.map((f) => `<li><b>${esc(f.severity)}</b> ${esc(f.summary)}${f.detail ? ` <span class="muted">${esc(f.detail)}</span>` : ''}</li>`).join('')}</ul></details>` : ''}
    <div class="files">${evidence.map((e) => `<a href="${href(e)}">${esc(path.basename(e))}</a>`).join(' · ')}${evidence.some((e) => e.endsWith('trace.zip')) ? `<span class="muted small"> — open a trace with <code>npx playwright show-trace ${esc(evidence.find((e) => e.endsWith('trace.zip')))}</code></span>` : ''}</div>
  </div>
</details>`;
}

function defectCard(d: DefectCandidate): string {
  return `<details class="defect"><summary><span class="chip bad">${esc(d.severity)}</span> <b>${esc(d.title)}</b> <span class="muted small">${esc(d.test_id ?? '')} · seen ${d.occurrences}×</span></summary>
  <div class="body"><p>${esc(d.summary)}</p>
  ${d.preconditions?.length ? `<h5>Preconditions</h5><ul>${d.preconditions.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
  <h5>Steps to reproduce</h5><ol>${d.steps_to_reproduce.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
  <div class="grid2"><div><h5>Expected</h5><div class="val">${esc(d.expected)}</div></div><div><h5>Actual</h5><div class="val">${esc(d.actual)}</div></div></div>
  <p class="muted small">Environment: ${esc(d.environment.url)} · build ${esc(d.environment.build ?? 'unknown')} · ${esc(d.environment.browser ?? 'chromium')} · role ${esc(d.environment.role ?? '—')}</p>
  ${d.evidence?.length ? `<p class="files">${d.evidence.map((e) => `<a href="${href((e as { path?: string }).path)}">${esc(path.basename((e as { path?: string }).path ?? ''))}</a>`).join(' · ')}</p>` : ''}
  </div></details>`;
}

export function buildHtmlReport(input: HtmlReportInput): string {
  const feature = input.feature ?? 'default';
  const results = input.results.map((r) => {
    // Recompute: classification and replay can change the status after the run.
    const t = assessTrust(r);
    return { ...r, evidence_trust: t.level, trust_reasons: t.reasons };
  });
  const missions = missionsById();
  const intents = listIntents(PATHS.intentsApproved)
    .map(readIntentFile)
    .filter((i) => i.feature === feature) as TestIntent[];
  const ran = new Set(results.map((r) => r.test_id));
  const notRun = intents.filter((i) => !ran.has(i.test_id));
  const ids = new Set(results.map((r) => r.test_id));
  const defects = listDefects().filter((d) => d.test_id && ids.has(d.test_id) && d.status !== 'rejected');

  const byVideo = new Map<string, string[]>();
  for (const r of results) if (r.video) byVideo.set(r.video.path, [...(byVideo.get(r.video.path) ?? []), r.test_id]);

  const count = (s: string) => results.filter((r) => r.status === s).length;
  const verified = results.filter((r) => r.evidence_trust === 'verified').length;
  const review = results.filter((r) => r.evidence_trust === 'review').length;
  const started = results.map((r) => r.started_at).filter(Boolean).sort()[0];
  const finished = results.map((r) => r.finished_at).filter(Boolean).sort().pop();

  const whyNotRun = (id: string): string => {
    const v = input.verification?.issues.find((x) => x.severity === 'block' && x.test_id === id) ??
      input.verification?.issues.find((x) => x.severity === 'block' && !x.test_id);
    return v ? `Held by pre-execution verification — ${v.check}: ${v.message}` : 'No approved mission was bound for it.';
  };

  const tiles = [
    ['Approved', intents.length || results.length, ''],
    ['Executed', results.length, ''],
    ['Passed', count('PASS'), 'ok'],
    ['Failed', count('FAIL'), 'bad'],
    ['Blocked', count('BLOCKED'), 'warn'],
    ['Inconclusive', count('INCONCLUSIVE'), 'warn'],
    ['Not run', notRun.length, notRun.length ? 'bad' : ''],
  ] as const;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Execution Report</title>
<style>
:root{--bg:#f7f7f8;--card:#fff;--fg:#1b1b1f;--muted:#6b6b76;--line:#e4e4e9;--ok:#1a7f4b;--okbg:#e6f4ec;--bad:#c4302b;--badbg:#fdecea;--warn:#a05a00;--warnbg:#fff4e0;--info:#1f5fbf;--infobg:#e8f0fd;--code:#f1f1f4}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#111114;--card:#1a1a1f;--fg:#ececf1;--muted:#9a9aa6;--line:#2c2c34;--ok:#4cc38a;--okbg:#10291c;--bad:#ff6b63;--badbg:#341513;--warn:#f0a83a;--warnbg:#33240c;--info:#7aa7ff;--infobg:#142240;--code:#24242b}}
:root[data-theme=dark]{--bg:#111114;--card:#1a1a1f;--fg:#ececf1;--muted:#9a9aa6;--line:#2c2c34;--ok:#4cc38a;--okbg:#10291c;--bad:#ff6b63;--badbg:#341513;--warn:#f0a83a;--warnbg:#33240c;--info:#7aa7ff;--infobg:#142240;--code:#24242b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1280px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 12px}h4{margin:20px 0 8px;font-size:14px}h5{margin:12px 0 4px}
.muted{color:var(--muted)}.small{font-size:12px}code,pre{font:12px/1.4 ui-monospace,Consolas,monospace;background:var(--code);border-radius:4px}code{padding:1px 4px;word-break:break-all}pre{padding:8px;white-space:pre-wrap;word-break:break-all;max-height:320px;overflow:auto}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:16px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.tile b{display:block;font-size:26px}.tile.ok b{color:var(--ok)}.tile.bad b{color:var(--bad)}.tile.warn b{color:var(--warn)}
.trustbar{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:8px}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;margin-right:4px;white-space:nowrap}
.chip.ok{background:var(--okbg);color:var(--ok)}.chip.bad{background:var(--badbg);color:var(--bad)}.chip.warn{background:var(--warnbg);color:var(--warn)}.chip.info{background:var(--infobg);color:var(--info)}.chip.muted{background:var(--code);color:var(--muted)}
.badge{display:inline-block;min-width:108px;text-align:center;padding:3px 8px;border-radius:6px;font-weight:700;font-size:12px;letter-spacing:.03em}
.badge.PASS{background:var(--okbg);color:var(--ok)}.badge.FAIL{background:var(--badbg);color:var(--bad)}.badge.BLOCKED,.badge.INCONCLUSIVE{background:var(--warnbg);color:var(--warn)}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 12px;position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:2}
.filters button{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:4px 12px;cursor:pointer;font:inherit}
.filters button[aria-pressed=true]{background:var(--fg);color:var(--bg)}
.filters input{flex:1;min-width:180px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit}
details.test,details.defect{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:10px}
details.test>summary,details.defect>summary{display:flex;gap:10px;align-items:center;padding:12px 14px;cursor:pointer;list-style:none;flex-wrap:wrap}
details>summary::-webkit-details-marker{display:none}
.tid{font-weight:700;font-family:ui-monospace,Consolas,monospace}.obj{flex:1;min-width:200px}
.body{padding:0 14px 14px;border-top:1px solid var(--line)}
.meta{display:grid;gap:8px;margin-top:12px}blockquote{margin:4px 0;padding:6px 10px;border-left:3px solid var(--line);color:var(--muted)}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px}.kv span{color:var(--muted);font-size:12px}
.callout{border-radius:8px;padding:10px 12px;margin:14px 0}.callout.ok{background:var(--okbg)}.callout.bad{background:var(--badbg)}.callout.warn{background:var(--warnbg)}.callout ul{margin:6px 0 0;padding-left:18px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:8px 0}@media(max-width:700px){.grid2{grid-template-columns:1fr}}
.val{background:var(--code);border-radius:6px;padding:6px 8px;margin-top:4px;word-break:break-word}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;font-weight:600;color:var(--muted);font-size:12px;border-bottom:1px solid var(--line);padding:6px}td{border-bottom:1px solid var(--line);padding:8px 6px;vertical-align:top}
.row-bad td{background:color-mix(in srgb,var(--badbg) 60%,transparent)}
.act{font-size:11px;text-transform:uppercase;color:var(--muted);font-weight:700}.url{font-size:11px;color:var(--muted);word-break:break-all}
.note{font-size:12px;color:var(--info);margin-top:4px}.err{color:var(--bad);font-size:12px;margin-top:4px;white-space:pre-wrap;word-break:break-word}
.shots{white-space:nowrap}.thumb{display:inline-block;margin:0 6px 0 0;vertical-align:top}.thumb img{width:150px;height:94px;object-fit:cover;object-position:top;border:1px solid var(--line);border-radius:6px;display:block}.thumb figcaption{font-size:11px;color:var(--muted);max-width:150px}
.video video{width:100%;max-width:720px;border-radius:8px;border:1px solid var(--line);margin-top:12px;background:#000}
details.sub{margin-top:12px}details.sub>summary{cursor:pointer;font-weight:600}.net .u{word-break:break-all;max-width:520px}
.files{margin-top:12px;font-size:12px}a{color:var(--info)}
.table-wrap{overflow-x:auto}
#lb{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;flex-direction:column;z-index:9;padding:16px}#lb img{max-width:100%;max-height:88vh;border-radius:6px}#lb p{color:#fff;margin:8px 0 0}#lb.on{display:flex}
@media(max-width:700px){.badge{min-width:0}.thumb img{width:110px;height:70px}td{padding:6px 4px}}
</style></head><body><div class="wrap">
<header style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start">
<div><h1>Execution report — ${esc(feature)}</h1>
<div class="muted small">${esc(new Date().toISOString())}${input.baseUrl ? ` · ${esc(input.baseUrl)}` : ''}${results[0]?.build ? ` · build ${esc(results[0].build)}` : ''}${started && finished ? ` · run ${ms(Date.parse(finished) - Date.parse(started))}` : ''}</div></div>
<button id="theme" class="chip muted" style="border:0;cursor:pointer">Toggle theme</button>
</header>

<div class="tiles">${tiles.map(([k, v, c]) => `<div class="tile ${c}"><span class="muted small">${k}</span><b>${v}</b></div>`).join('')}</div>

<div class="trustbar"><b>Can these results be trusted?</b> ${verified} verified on exact matches only · ${review} need a look (tolerant or AI matching used) · ${results.length - verified - review} have no clean verdict.
<div class="muted small">A PASS marked <span class="chip warn">review</span> lists exactly which steps relied on a synonym, fuzzy wording or an AI judgement. Every step shows the element it used outlined in red.</div></div>

${notRun.length ? `<h2>Did not run (${notRun.length})</h2><p class="muted">These were approved at Gate 2 but produced no result. Read this before any pass rate.</p><div class="table-wrap"><table><thead><tr><th>Test</th><th>Objective</th><th>Why</th></tr></thead><tbody>${notRun.map((i) => `<tr><td class="tid">${esc(i.test_id)}</td><td>${esc(i.test_objective)}</td><td>${esc(whyNotRun(i.test_id))}</td></tr>`).join('')}</tbody></table></div>` : ''}

<h2>Tests (${results.length})</h2>
<div class="filters" role="toolbar">
${['ALL', 'FAIL', 'BLOCKED', 'INCONCLUSIVE', 'PASS'].map((s) => `<button data-f="${s}" aria-pressed="${s === 'ALL'}">${s === 'ALL' ? 'All' : s}</button>`).join('')}
<button data-t="review" aria-pressed="false">Needs review</button>
<input id="q" type="search" placeholder="Search test id or objective">
</div>
<div id="tests">${results
    .sort((a, b) => ['FAIL', 'BLOCKED', 'INCONCLUSIVE', 'PASS'].indexOf(a.status) - ['FAIL', 'BLOCKED', 'INCONCLUSIVE', 'PASS'].indexOf(b.status))
    .map((r) => testCard(r, missions.get(r.test_id), byVideo))
    .join('\n')}</div>

<h2>Defects (${defects.length})</h2>
${defects.length ? `<p class="muted">Candidates only — nothing here is confirmed until a human reviews it at Gate 3.</p>${defects.map(defectCard).join('')}` : '<p class="muted">No product defects were raised by this run.</p>'}
</div>
<div id="lb" role="dialog" aria-label="Screenshot"><img alt=""><p></p></div>
<script>
(function(){
  var f='ALL',t=false,q='';
  function apply(){document.querySelectorAll('details.test').forEach(function(d){
    var ok=(f==='ALL'||d.dataset.status===f)&&(!t||d.dataset.trust==='review')&&(!q||d.dataset.search.indexOf(q)>=0);
    d.style.display=ok?'':'none';});}
  document.querySelectorAll('[data-f]').forEach(function(b){b.onclick=function(){f=b.dataset.f;document.querySelectorAll('[data-f]').forEach(function(x){x.setAttribute('aria-pressed',x===b)});apply();};});
  var tb=document.querySelector('[data-t]');tb.onclick=function(){t=!t;tb.setAttribute('aria-pressed',t);apply();};
  document.getElementById('q').oninput=function(e){q=e.target.value.toLowerCase();apply();};
  var lb=document.getElementById('lb');
  document.addEventListener('click',function(e){var a=e.target.closest('[data-lightbox]');if(a){e.preventDefault();lb.querySelector('img').src=a.getAttribute('href');lb.querySelector('p').textContent=a.dataset.caption||'';lb.classList.add('on');}else if(e.target.closest('#lb')){lb.classList.remove('on');}});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')lb.classList.remove('on');});
  document.getElementById('theme').onclick=function(){var r=document.documentElement;var dark=r.dataset.theme?r.dataset.theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches;r.dataset.theme=dark?'light':'dark';};
})();
</script></body></html>`;
}

export function writeHtmlReport(input: HtmlReportInput): string {
  fs.mkdirSync(PATHS.reports, { recursive: true });
  const file = path.join(PATHS.reports, `EXECUTION-REPORT-${input.feature ?? 'default'}.html`);
  fs.writeFileSync(file, buildHtmlReport(input), 'utf8');
  return rel(file);
}
