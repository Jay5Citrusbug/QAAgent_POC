import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/**
 * The one place the Execution Agent talks to Claude during a run.
 *
 * Two jobs use it, both narrow and both recorded:
 *
 *   - picking an element when every deterministic strategy found nothing
 *     ("Log in" in the mission, "Sign in" on the page)
 *   - judging whether a message that is worded differently still says what the
 *     test expected, and triaging a failed run
 *
 * Neither can make a test pass on its own authority. Every AI decision is
 * written onto the step or assertion it affected, and the report marks that
 * test "review" rather than "verified".
 *
 * ## Which route — no API key needed
 *
 *   claude-cli   Claude Code in headless mode (`claude -p`), signed in with
 *                your Claude subscription. No API key, no separate bill. This
 *                is the default whenever Claude Code is installed.
 *   api          The Anthropic API with ANTHROPIC_API_KEY — metered per token.
 *                Used only when a key is set and AI_PROVIDER does not say
 *                otherwise.
 *   off          Deterministic matching only.
 *
 * Choose explicitly with AI_PROVIDER=claude-cli | api | off. Model with
 * EXECUTION_AI_MODEL (default: whatever the route defaults to — Opus on the
 * CLI, claude-opus-5 on the API).
 */

export type AiProvider = 'claude-cli' | 'api' | 'off';

let cliPath: string | null | undefined;

/** Locate the Claude Code binary. The .exe directly, so no shell is involved. */
function findClaudeCli(): string | null {
  if (cliPath !== undefined) return cliPath;
  const override = process.env.CLAUDE_CLI;
  if (override) return (cliPath = fs.existsSync(override) ? override : null);

  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    candidates.push(path.join(appdata, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
    candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude.exe'));
    try {
      for (const line of execFileSync('where', ['claude'], { encoding: 'utf8' }).split(/\r?\n/)) {
        const p = line.trim();
        if (p.endsWith('.exe')) candidates.push(p);
        // npm shim: the real binary sits beside it in node_modules.
        if (p.endsWith('.cmd')) {
          candidates.push(path.join(path.dirname(p), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
        }
      }
    } catch {
      /* not on PATH */
    }
  } else {
    candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude');
    try {
      candidates.push(execFileSync('which', ['claude'], { encoding: 'utf8' }).trim());
    } catch {
      /* not on PATH */
    }
  }
  return (cliPath = candidates.find((c) => c && fs.existsSync(c)) ?? null);
}

export function aiProvider(): AiProvider {
  const explicit = (process.env.AI_PROVIDER ?? process.env.SMART_AI ?? '').toLowerCase();
  if (explicit === 'off') return 'off';
  if (explicit === 'api') return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? 'api' : 'off';
  if (explicit === 'claude-cli' || explicit === 'cli') return findClaudeCli() ? 'claude-cli' : 'off';
  // Auto: the subscription first — it costs nothing extra.
  if (findClaudeCli()) return 'claude-cli';
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'api';
  return 'off';
}

export function aiAvailable(): boolean {
  return aiProvider() !== 'off';
}

/** A short label for logs and the report. */
export function aiModel(): string {
  const configured = process.env.EXECUTION_AI_MODEL;
  if (aiProvider() === 'claude-cli') return configured ? `${configured} via Claude Code` : 'Claude (subscription)';
  return configured ?? 'claude-opus-5';
}

type Answer<T> = { ok: true; value: T; model: string } | { ok: false; error: string; model: string };

/**
 * One structured question, one structured answer, validated against `schema`
 * whichever route answered it.
 */
export async function askStructured<T extends z.ZodType>(
  schema: T,
  system: string,
  prompt: string,
  opts: AskOptions = {},
): Promise<Answer<z.infer<T>>> {
  const provider = aiProvider();
  const model = opts.model ?? aiModel();
  if (provider === 'off') return { ok: false, error: 'AI is off (no Claude Code install and no API key)', model };
  return provider === 'claude-cli'
    ? askViaCli(schema, system, prompt, model, opts.timeoutMs ?? 120_000, opts)
    : askViaApi(schema, system, prompt, opts.model ?? model, opts.timeoutMs ?? 60_000, opts);
}

/**
 * Execution-time calls leave these unset: small, fast, low effort. The
 * Thinking Agent sets all of them — a whole feature analysed at high effort
 * is minutes of work and a long answer, not a quick judgement.
 */
export interface AskOptions {
  timeoutMs?: number;
  /** A model id. Unset: the route's default (EXECUTION_AI_MODEL on the CLI). */
  model?: string;
  effort?: string;
  /** API route only — the CLI sizes its own output. */
  maxTokens?: number;
}

// --- route 1: Claude Code headless, on the subscription -----------------------

async function askViaCli<T extends z.ZodType>(
  schema: T,
  system: string,
  prompt: string,
  model: string,
  timeoutMs: number,
  opts: AskOptions,
): Promise<Answer<z.infer<T>>> {
  const bin = findClaudeCli();
  if (!bin) return { ok: false, error: 'Claude Code not found', model };

  const args = [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(cliSchema(schema)),
    '--system-prompt', system,
    // A pure question: no tools, nothing saved, no project context pulled in.
    '--tools', '',
    '--no-session-persistence',
    // Small bounded judgements: depth costs latency on every step that needs one.
    '--effort', opts.effort ?? process.env.EXECUTION_AI_EFFORT ?? 'low',
    '--setting-sources', 'user',
    ...(opts.model ? ['--model', opts.model] : process.env.EXECUTION_AI_MODEL ? ['--model', process.env.EXECUTION_AI_MODEL] : []),
  ];

  // An API key in the environment would switch Claude Code to metered billing;
  // this route exists to use the subscription, so it is removed for the child.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  const out = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const child = spawn(bin, args, { cwd: os.tmpdir(), env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.end(prompt);
  });

  if (out.timedOut) return { ok: false, error: `Claude Code did not answer within ${timeoutMs / 1000}s`, model };
  let parsed: { is_error?: boolean; structured_output?: unknown; result?: string; modelUsage?: Record<string, unknown> };
  try {
    parsed = JSON.parse(out.stdout);
  } catch {
    const hint = /login|auth|sign in/i.test(out.stderr + out.stdout) ? ' — run `claude` once and sign in' : '';
    return { ok: false, error: `Claude Code returned no JSON (exit ${out.code})${hint}: ${(out.stderr || out.stdout).slice(0, 200)}`, model };
  }
  if (parsed.is_error) return { ok: false, error: `Claude Code error: ${String(parsed.result ?? '').slice(0, 200)}`, model };

  const used = Object.keys(parsed.modelUsage ?? {}).find((m) => !/haiku/i.test(m)) ?? model;
  const check = schema.safeParse(parsed.structured_output ?? tryJson(parsed.result));
  if (!check.success) return { ok: false, error: 'answer did not match the expected shape', model: used };
  return { ok: true, value: check.data as z.infer<T>, model: `${used} (subscription)` };
}

/** The CLI's validator does not know the draft-2020-12 meta-schema zod stamps on. */
function cliSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

function tryJson(s: unknown): unknown {
  if (typeof s !== 'string') return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// --- route 2: the Anthropic API, metered ---------------------------------------

async function askViaApi<T extends z.ZodType>(
  schema: T,
  system: string,
  prompt: string,
  model: string,
  timeoutMs: number,
  opts: AskOptions,
): Promise<Answer<z.infer<T>>> {
  // Loaded only on this route, so the subscription path needs no SDK at all.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
  const client = new Anthropic();
  try {
    const response = await client.messages.parse(
      {
        model,
        max_tokens: opts.maxTokens ?? 2048,
        output_config: { effort: (opts.effort ?? 'low') as 'low', format: zodOutputFormat(schema) },
        system,
        messages: [{ role: 'user', content: prompt }],
      },
      { timeout: timeoutMs },
    );
    if (response.stop_reason === 'refusal') return { ok: false, error: 'model declined the request', model };
    if (!response.parsed_output) return { ok: false, error: 'no parseable answer', model };
    return { ok: true, value: response.parsed_output as z.infer<T>, model };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return { ok: false, error: 'rate limited', model };
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, error: 'invalid API credential', model };
    if (err instanceof Anthropic.APIError) return { ok: false, error: `API error ${err.status}: ${err.message}`, model };
    return { ok: false, error: err instanceof Error ? err.message : String(err), model };
  }
}
