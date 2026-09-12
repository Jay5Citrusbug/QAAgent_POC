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

const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 — best at finding unstated gaps (recommended)' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — cheaper, good for a re-run' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — fastest, too shallow for gap analysis' },
];

export default function Page() {
  const [stage, setStage] = useState<Stage>('input');
  const [requirement, setRequirement] = useState('');
  const [model, setModel] = useState('claude-opus-5');
  const [effort, setEffort] = useState('high');
  const [featureId, setFeatureId] = useState('');
  const [featureSlug, setFeatureSlug] = useState('');
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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/think')
      .then((r) => r.json())
      .then((d) => {
        setFeatures(d.features ?? []);
        if (d.default?.model) setModel(d.default.model);
        if (d.default?.effort) setEffort(d.default.effort);
      })
      .catch(() => undefined);
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
      const d = await call('/api/think', { phase: 'analyze', model, effort, requirement, featureId });
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

  async function saveAll() {
    setError('');
    setBusy(true);
    try {
      const d = await call('/api/save', {
        featureSlug: featureSlug || featureId || 'analysis',
        analysisMarkdown: analysis?.analysisMarkdown ?? '',
        missions,
      });
      setSaved(d.written ?? []);
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

  async function approve(testId: string) {
    setError('');
    setBusy(true);
    try {
      await call('/api/approve', {
        testId,
        approvedBy: approver,
        reviewMinutes: reviewMinutes ? Number(reviewMinutes) : undefined,
      });
      setApprovedIds((a) => [...a, testId]);
    } catch (e) {
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
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
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
        </div>
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
            <button onClick={saveAll} disabled={busy}>Save analysis + drafts to disk</button>
          </div>

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
                return (
                  <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                    <code style={{ minWidth: 78 }}>{id}</code>
                    <span style={{ flex: 1, fontSize: 13.5, color: 'var(--muted)' }}>{String(m.test_objective ?? '')}</span>
                    <button className={done ? 'ok' : ''} onClick={() => approve(id)} disabled={busy || done || !approver.trim()}>
                      {done ? 'Approved' : 'Approve'}
                    </button>
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
