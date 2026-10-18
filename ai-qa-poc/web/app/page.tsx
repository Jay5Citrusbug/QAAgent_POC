'use client';

import { useEffect, useState } from 'react';

/**
 * The Thinking Agent, as a single page.
 *
 *   requirement + model → Start
 *     → agent analyses, returns gaps and clarifying questions
 *     → human answers, reviews the analysis, approves          (Gate 1a)
 *     → agent generates draft missions
 *     → human approves each mission, which writes it to disk   (Gate 1b)
 *
 * The agent never skips from requirement straight to missions. That ordering
 * is the point: a mission built on an invented answer produces a confident
 * false defect, which costs more QA time than producing nothing at all.
 */

type Stage = 'input' | 'analyzing' | 'questions' | 'generating' | 'missions' | 'done';

interface Question { id: string; question: string; why: string; options?: string[] }
interface Analysis { analysisMarkdown: string; questions: Question[]; readyForMissions: boolean; summary: string }
interface Mission { test_id?: string; test_objective?: string; priority?: string; module?: string; [k: string]: unknown }
interface Usage { inputTokens: number; outputTokens: number; model: string; estimatedCost: number }
interface ModelChoice { id: string; label: string; note: string; provider: string }
interface WorkspaceArtifacts {
  generatedAt: string;
  analysis: { file: string; content: string } | null;
  missions: { draft: { id: string; content: string }[]; approved: { id: string; content: string }[] };
  runs: { test_id?: string; status?: string; failure_classification?: string; confidence?: string; feature?: string; build?: string }[];
  defects: { file: string; fingerprint?: string; title?: string; status?: string; severity?: string }[];
  reports: { file: string; content?: string }[];
}

export default function Page() {
  const [stage, setStage] = useState<Stage>('input');
  const [requirement, setRequirement] = useState('');
  const [model, setModel] = useState('claude-opus-5');
  const [effort, setEffort] = useState('high');
  const [featureId, setFeatureId] = useState('');
  const [featureSlug, setFeatureSlug] = useState('');
  const [idPrefix, setIdPrefix] = useState('');
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [conflicts, setConflicts] = useState<{ testId: string; existingObjective: string; where: string }[]>([]);
  const [features, setFeatures] = useState<{ id: string; label: string }[]>([]);

  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [missions, setMissions] = useState<Mission[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [history, setHistory] = useState<unknown[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [spend, setSpend] = useState(0);

  const [approver, setApprover] = useState('');
  const [reviewMinutes, setReviewMinutes] = useState('');
  const [saved, setSaved] = useState<string[]>([]);
  const [approvedIds, setApprovedIds] = useState<string[]>([]);
  /**
   * Binding exceptions per mission, and which ones the human has said they read.
   *
   * Gate 2.5 exists because a binder that could not settle something must not
   * have that decision made for it by a default. Showing the exceptions and
   * requiring a deliberate tick is the browser's version of the CLI's
   * --reviewed; without it, approving blind and approving after reading are the
   * same click.
   */
  const [exceptions, setExceptions] = useState<Record<string, { kind: string; where: string; summary: string }[]>>({});
  const [reviewed, setReviewed] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [artifacts, setArtifacts] = useState<WorkspaceArtifacts | null>(null);
  const [artifactError, setArtifactError] = useState('');

  async function refreshArtifacts() {
    try {
      const res = await fetch('/api/artifacts', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Workspace refresh failed (${res.status})`);
      setArtifacts((await res.json()) as WorkspaceArtifacts);
      setArtifactError('');
    } catch (e) {
      setArtifactError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    fetch('/api/think')
      .then((r) => r.json())
      .then((d) => {
        setFeatures(d.features ?? []);
        setModels(d.models ?? []);
        if (d.default?.model) setModel(d.default.model);
        if (d.default?.effort) setEffort(d.default.effort);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void refreshArtifacts();
    const timer = window.setInterval(() => void refreshArtifacts(), 3000);
    return () => window.clearInterval(timer);
  }, []);

  async function call(path: string, body: unknown) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return data;
  }

  async function start() {
    setError('');
    setBusy(true);
    setStage('analyzing');
    try {
      const d = await call('/api/think', { phase: 'analyze', model, effort, requirement, featureId, idPrefix });
      setAnalysis(d.result);
      setHistory(d.history);
      setUsage(d.usage);
      setSpend((s) => s + (d.usage?.estimatedCost ?? 0));
      setStage('questions');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage('input');
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    setError('');
    setBusy(true);
    setStage('generating');
    try {
      const d = await call('/api/think', {
        phase: 'generate',
        model,
        effort,
        history,
        idPrefix,
        questions: analysis?.questions ?? [],
        answers,
      });
      setMissions(d.result.missions ?? []);
      setNotes(d.result.notes ?? []);
      setHistory(d.history);
      setUsage(d.usage);
      setSpend((s) => s + (d.usage?.estimatedCost ?? 0));
      setStage('missions');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage('questions');
    } finally {
      setBusy(false);
    }
  }

  async function saveAll(overwrite = false) {
    setError('');
    setBusy(true);
    if (overwrite) setConflicts([]);
    try {
      const res = await fetch('/api/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          featureSlug: featureSlug || featureId || 'analysis',
          analysisMarkdown: analysis?.analysisMarkdown ?? '',
          missions,
          overwrite,
        }),
      });
      const d = await res.json();
      if (res.status === 409) {
        // Never clobber silently — show what would be lost and let the human decide.
        setConflicts(d.conflicts ?? []);
        setError(d.error ?? 'Mission ids already exist.');
        return;
      }
      if (!res.ok) throw new Error(d.error ?? `Request failed (${res.status})`);
      setSaved(d.written ?? []);
      // Drafts are on disk now, so the gate can read what the binder left open.
      void loadExceptions();
      if (d.rejected?.length) {
        setError(
          `${d.rejected.length} mission(s) failed schema validation and were not written: ` +
            d.rejected.map((r: { testId: string; errors: string[] }) => `${r.testId} (${r.errors[0]})`).join('; '),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Load which drafts carry binding exceptions, so the gate can show them. */
  async function loadExceptions() {
    try {
      const res = await fetch('/api/approve');
      const data = (await res.json()) as { exceptions?: Record<string, { kind: string; where: string; summary: string }[]> };
      setExceptions(data.exceptions ?? {});
    } catch {
      // Not fatal: the CLI still refuses on the server side. This only affects
      // whether the browser can explain the refusal before it happens.
    }
  }

  async function approve(testId: string) {
    setError('');
    setBusy(true);
    try {
      await call('/api/approve', {
        testId,
        approvedBy: approver,
        reviewMinutes: reviewMinutes ? Number(reviewMinutes) : undefined,
        reviewedExceptions: reviewed.includes(testId),
      });
      setApprovedIds((a) => [...a, testId]);
    } catch (e) {
      // The message comes from scripts/approve.ts verbatim — it names the
      // exception and says what to do, which is better than anything this
      // could paraphrase.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const stages: { key: Stage; label: string }[] = [
    { key: 'input', label: '1 · Requirement' },
    { key: 'questions', label: '2 · Gaps & questions' },
    { key: 'missions', label: '3 · Test cases' },
    { key: 'done', label: '4 · Approved' },
  ];
  const order = ['input', 'analyzing', 'questions', 'generating', 'missions', 'done'];
  const at = order.indexOf(stage);

  return (
    <div className="wrap">
      <header>
        <h1>QA Thinking Agent</h1>
        <p>Requirement in. Gaps and questions out. Approved missions written to disk — nothing skips a human.</p>
      </header>

      <section className="workspace panel">
        <div className="workspace-head">
          <div>
            <h2>Local workspace</h2>
            <p className="hint" style={{ margin: 0 }}>Live view of files written by VS Code Chat, Antigravity, the CLI, and browser runs.</p>
          </div>
          <button className="secondary" onClick={() => void refreshArtifacts()}>Refresh now</button>
        </div>
        {artifactError && <div className="alert bad" style={{ marginTop: 14 }}>{artifactError}</div>}
        {artifacts && (
          <>
            <div className="workspace-stats">
              <div><strong>{artifacts.missions.draft.length}</strong><span>draft missions</span></div>
              <div><strong>{artifacts.missions.approved.length}</strong><span>approved missions</span></div>
              <div><strong>{artifacts.runs.filter((r) => r.status === 'PASS').length}</strong><span>latest passes</span></div>
              <div><strong>{artifacts.runs.filter((r) => r.status === 'FAIL').length}</strong><span>latest failures</span></div>
              <div><strong>{artifacts.defects.filter((d) => d.status === 'candidate').length}</strong><span>defect candidates</span></div>
            </div>

            <div className="workspace-grid">
              <div>
                <h3>Latest execution</h3>
                {artifacts.runs.length === 0 ? <p className="hint">No execution results on disk yet.</p> : (
                  <div className="artifact-list">
                    {artifacts.runs.map((run) => (
                      <div className="artifact-row" key={run.test_id}>
                        <code>{run.test_id}</code>
                        <span>{run.failure_classification ?? run.feature ?? 'run'}</span>
                        <details>
                          <summary className={`status-${String(run.status ?? '').toLowerCase()}`}>{run.status ?? 'unknown'}</summary>
                          <pre>{JSON.stringify(run, null, 2)}</pre>
                        </details>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <h3>Latest analysis</h3>
                {artifacts.analysis ? (
                  <details>
                    <summary><code>{artifacts.analysis.file}</code></summary>
                    <pre>{artifacts.analysis.content}</pre>
                  </details>
                ) : <p className="hint">No analysis file on disk yet.</p>}
              </div>
            </div>

            <div className="workspace-grid">
              <div>
                <h3>Mission files</h3>
                <p className="hint">Draft: {artifacts.missions.draft.length || 'none'}</p>
                {artifacts.missions.draft.map((mission) => <details key={`draft-${mission.id}`}><summary><code>{mission.id}</code></summary><pre>{mission.content}</pre></details>)}
                <p className="hint">Approved: {artifacts.missions.approved.length || 'none'}</p>
                {artifacts.missions.approved.map((mission) => <details key={`approved-${mission.id}`}><summary><code>{mission.id}</code></summary><pre>{mission.content}</pre></details>)}
              </div>
              <div>
                <h3>Defects &amp; reports</h3>
                <p className="hint">{artifacts.defects.length} defect file(s), {artifacts.reports.length} report file(s)</p>
                {artifacts.reports[0]?.content && <details><summary>Open latest report</summary><pre>{artifacts.reports[0].content}</pre></details>}
              </div>
            </div>
            <p className="workspace-updated">Last read {new Date(artifacts.generatedAt).toLocaleTimeString()}</p>
          </>
        )}
      </section>

      <div className="steps">
        {stages.map((s) => {
          const idx = order.indexOf(s.key);
          const cls = at === idx ? 'step active' : at > idx ? 'step done' : 'step';
          return <div key={s.key} className={cls}>{s.label}</div>;
        })}
      </div>

      {error && <div className="alert bad"><strong>Error:</strong> {error}</div>}

      {/* ---------- 1. Requirement ---------- */}
      <div className="panel">
        <h2>Requirement</h2>
        <label htmlFor="req">Paste the requirement. Anything it doesn&apos;t say becomes a question, not a guess.</label>
        <textarea
          id="req"
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
          placeholder="The e-commerce platform includes the following core functional components: ..."
          disabled={stage !== 'input'}
        />
        <div className="row" style={{ marginTop: 14 }}>
          <div>
            <label htmlFor="model">Model</label>
            <select id="model" value={model} onChange={(e) => setModel(e.target.value)} disabled={stage !== 'input'}>
              {models.length === 0 && <option value="">No configured model provider</option>}
              {models.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.provider})</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="effort">Effort</label>
            <select id="effort" value={effort} onChange={(e) => setEffort(e.target.value)} disabled={stage !== 'input'}>
              {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="feature">Application context</label>
            <select id="feature" value={featureId} onChange={(e) => setFeatureId(e.target.value)} disabled={stage !== 'input'}>
              <option value="">(none)</option>
              {features.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="prefix">Test ID prefix</label>
            <input
              id="prefix"
              value={idPrefix}
              onChange={(e) => setIdPrefix(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))}
              placeholder="EC"
              disabled={stage !== 'input'}
            />
          </div>
        </div>

        {!featureId && (
          <div className="alert warn" style={{ marginTop: 14 }}>
            No application context selected. The agent will have nothing but the requirement text to go on, so it is
            far more likely to assume UI that may not exist. Pick a context if one fits this feature.
          </div>
        )}
        {!idPrefix && (
          <div className="alert warn" style={{ marginTop: 14 }}>
            No test ID prefix set — the agent will pick its own, and a fresh run starts numbering at 001 again.
            If those ids already exist, saving will stop and ask rather than overwrite. Set a prefix per feature
            (<code>EC</code> for e-commerce, <code>WP</code> for WorkPod) to avoid the collision entirely.
          </div>
        )}
        <div style={{ marginTop: 16 }}>
          <button onClick={start} disabled={busy || stage !== 'input' || !requirement.trim()}>
            {stage === 'analyzing' ? <><span className="spinner" />Analysing…</> : 'Start analysis'}
          </button>
          {stage !== 'input' && (
            <button className="secondary" style={{ marginLeft: 10 }} onClick={() => window.location.reload()}>
              Start over
            </button>
          )}
        </div>
        <p className="hint">
          Roughly $0.20–0.30 per analysis on Opus 5. Model cost isn&apos;t the variable that matters here — review time is.
        </p>
      </div>

      {/* ---------- 2. Gaps and questions ---------- */}
      {analysis && (
        <div className="panel">
          <h2>Gaps &amp; questions</h2>
          {analysis.summary && <p style={{ marginTop: 0 }}>{analysis.summary}</p>}

          {!analysis.readyForMissions && analysis.questions.length > 0 && (
            <div className="alert warn">
              The agent says it can&apos;t write reliable missions until these are answered. Leaving one blank is allowed —
              it will avoid depending on it rather than invent an answer.
            </div>
          )}

          {analysis.questions.map((q) => (
            <div className="q" key={q.id}>
              <div className="qtext">{q.id}. {q.question}</div>
              <div className="why">{q.why}</div>
              {q.options && q.options.length > 0 && (
                <div className="chips">
                  {q.options.map((o) => (
                    <span key={o} className="chip" onClick={() => setAnswers((a) => ({ ...a, [q.id]: o }))}>{o}</span>
                  ))}
                </div>
              )}
              <input
                value={answers[q.id] ?? ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                placeholder="Your answer…"
              />
            </div>
          ))}

          {analysis.questions.length === 0 && (
            <div className="alert ok">No blocking questions — the agent believes the requirement is clear enough to proceed.</div>
          )}

          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 13 }}>Full analysis (markdown)</summary>
            <pre style={{ marginTop: 10 }}>{analysis.analysisMarkdown}</pre>
          </details>

          {stage === 'questions' && (
            <div style={{ marginTop: 16 }}>
              <button onClick={generate} disabled={busy}>
                {busy ? <><span className="spinner" />Generating…</> : 'Approve & generate test cases'}
              </button>
              <p className="hint">This is Gate 1a — you&apos;re confirming the agent understood the requirement before it writes anything.</p>
            </div>
          )}
        </div>
      )}

      {/* ---------- 3. Test cases ---------- */}
      {missions.length > 0 && (
        <div className="panel">
          <h2>Draft test cases ({missions.length})</h2>

          {notes.length > 0 && (
            <div className="alert warn">
              <strong>Agent notes:</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </div>
          )}

          {missions.map((m, i) => (
            <details className="mission" key={m.test_id ?? i}>
              <summary>
                {String(m.test_id ?? `#${i + 1}`)} — {String(m.test_objective ?? '')}
                {m.priority && <span className="badge">{String(m.priority)}</span>}
                {approvedIds.includes(String(m.test_id)) && <span className="badge" style={{ background: '#12261d', color: '#9ae6c4' }}>approved</span>}
              </summary>
              <div className="body">
                <pre>{JSON.stringify(m, null, 2)}</pre>
              </div>
            </details>
          ))}

          <div className="row" style={{ marginTop: 16 }}>
            <div>
              <label htmlFor="slug">Analysis filename slug</label>
              <input id="slug" value={featureSlug} onChange={(e) => setFeatureSlug(e.target.value)} placeholder="ecommerce" />
            </div>
            <div>
              <label htmlFor="who">Your name (for the approval stamp)</label>
              <input id="who" value={approver} onChange={(e) => setApprover(e.target.value)} placeholder="jay.r" />
            </div>
            <div>
              <label htmlFor="mins">Review minutes</label>
              <input id="mins" value={reviewMinutes} onChange={(e) => setReviewMinutes(e.target.value)} placeholder="5" inputMode="numeric" />
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <button onClick={() => saveAll(false)} disabled={busy}>Save analysis + drafts to disk</button>
          </div>

          {conflicts.length > 0 && (
            <div className="alert bad" style={{ marginTop: 14 }}>
              <strong>These ids already exist. Saving would replace real work:</strong>
              <ul style={{ margin: '8px 0 10px', paddingLeft: 18 }}>
                {conflicts.map((c) => (
                  <li key={`${c.where}-${c.testId}`}>
                    <code>{c.testId}</code> in <em>{c.where}</em> — &ldquo;{c.existingObjective}&rdquo;
                  </li>
                ))}
              </ul>
              <p style={{ margin: '0 0 10px' }}>
                Best fix: set a different Test ID prefix above and regenerate. Overwrite only if you are certain the
                existing missions are obsolete — this cannot be undone unless they are committed to git.
              </p>
              <button className="secondary" onClick={() => saveAll(true)} disabled={busy}>
                Overwrite anyway
              </button>
            </div>
          )}

          {saved.length > 0 && (
            <>
              <div className="alert ok" style={{ marginTop: 14 }}>
                Written: {saved.map((s) => <code key={s} style={{ marginRight: 10 }}>{s}</code>)}
              </div>
              <h2 style={{ marginTop: 18 }}>Gate 1b — approve each mission</h2>
              <p className="hint" style={{ marginTop: -6, marginBottom: 12 }}>
                Approving moves it from <code>missions/draft/</code> to <code>missions/approved/</code> and pins the
                requirement&apos;s hash. Only approved missions ever run. There is deliberately no approve-all button.
              </p>
              {missions.map((m) => {
                const id = String(m.test_id ?? '');
                const done = approvedIds.includes(id);
                const open = exceptions[id] ?? [];
                const acknowledged = reviewed.includes(id);
                return (
                  <div key={id} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <code style={{ minWidth: 78 }}>{id}</code>
                      <span style={{ flex: 1, fontSize: 13.5, color: 'var(--muted)' }}>{String(m.test_objective ?? '')}</span>
                      <button
                        className={done ? 'ok' : ''}
                        onClick={() => approve(id)}
                        disabled={busy || done || !approver.trim() || (open.length > 0 && !acknowledged)}
                      >
                        {done ? 'Approved' : 'Approve'}
                      </button>
                    </div>
                    {open.length > 0 && !done && (
                      <div className="alert" style={{ margin: '6px 0 14px 90px', fontSize: 13 }}>
                        <strong>The binder could not settle {open.length} thing{open.length > 1 ? 's' : ''}.</strong>
                        <ul style={{ margin: '8px 0', paddingLeft: 18 }}>
                          {open.map((e) => (
                            <li key={e.where} style={{ marginBottom: 4 }}>
                              <code>{e.where}</code> ({e.kind}) — {e.summary}
                            </li>
                          ))}
                        </ul>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input
                            type="checkbox"
                            checked={acknowledged}
                            onChange={(ev) =>
                              setReviewed((r) => (ev.target.checked ? [...r, id] : r.filter((x) => x !== id)))
                            }
                          />
                          I have read these and the mission is right as it stands.
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
              {!approver.trim() && <p className="hint">Enter your name above — the gate refuses anonymous approvals.</p>}
            </>
          )}
        </div>
      )}

      {usage && (
        <div className="meta">
          <span>model: <strong>{usage.model}</strong></span>
          <span>in: {usage.inputTokens.toLocaleString()} tok</span>
          <span>out: {usage.outputTokens.toLocaleString()} tok</span>
          <span>session spend: ~${spend.toFixed(3)}</span>
        </div>
      )}
    </div>
  );
}
