import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import { P, readIfPresent } from './paths';
import { providerForModel } from './models';

/**
 * The Thinking Agent, driven by the API instead of by copy-paste.
 *
 * Two phases, with a human gate between them:
 *
 *   analyze  → gaps + (optionally) clarifying questions for the human
 *   generate → draft missions, only after the human has answered and approved
 *
 * The agent never proceeds to missions on its own. That ordering is the whole
 * point: a mission built on an invented answer produces a confident false
 * defect, which costs more human QA time than producing nothing.
 */

export type Phase = 'analyze' | 'generate';

export interface ClarifyingQuestion {
  id: string;
  question: string;
  why: string;
  options?: string[];
}

export interface AnalyzeResult {
  kind: 'analysis';
  /** Markdown, matching ANALYSIS_TEMPLATE.md, ready to commit. */
  analysisMarkdown: string;
  questions: ClarifyingQuestion[];
  /** The agent's own read on whether it can write missions yet. */
  readyForMissions: boolean;
  summary: string;
}

export interface GenerateResult {
  kind: 'missions';
  missions: unknown[];
  notes: string[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

function client(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Copy web/.env.local.example to web/.env.local and add your key.',
    );
  }
  return new Anthropic();
}

function apiKey(provider: 'openai' | 'google'): string {
  const key = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!key) {
    const variable = provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY or GOOGLE_API_KEY';
    throw new Error(`${variable} is not set. Configure it in web/.env.local to use this provider.`);
  }
  return key;
}

/**
 * Built from the files already committed in the repo — the same system prompt
 * the CLI pastes. One source of truth for what the agent is held to.
 */
function buildSystemPrompt(appContextYaml: string | undefined): string {
  const systemPrompt = readIfPresent(P.systemPrompt) ?? '';
  const schema = readIfPresent(P.missionSchema) ?? '{}';
  const template = readIfPresent(P.analysisTemplate) ?? '';

  return [
    systemPrompt,
    '\n---\n\n# Application context\n',
    appContextYaml ? '```yaml\n' + appContextYaml + '\n```' : '_(none provided)_',
    '\n---\n\n# The mission contract — authoritative\n',
    'Every mission must validate against this JSON Schema exactly. It is reproduced',
    'here in full because you cannot open files.\n',
    '```json\n' + schema + '\n```',
    '\n---\n\n# Analysis format\n',
    template,
  ].join('\n');
}

/** Extract the first JSON object/array from a model response, tolerantly. */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the outermost braces/brackets.
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(`Model did not return parseable JSON. First 300 chars:\n${candidate.slice(0, 300)}`);
    }
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

async function runOpenAI(model: string, system: string, messages: ChatMessage[], effort: string) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey('openai')}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      max_completion_tokens: 16000,
      ...(model.startsWith('o') ? { reasoning_effort: effort } : {}),
    }),
  });
  const body = (await response.json()) as {
    error?: { message?: string };
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  if (!response.ok) throw new Error(body.error?.message ?? `OpenAI API returned HTTP ${response.status}.`);
  return {
    text: body.choices?.[0]?.message?.content ?? '',
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
  };
}

async function runGoogle(model: string, system: string, messages: ChatMessage[]) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey('google') },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })),
        generationConfig: { maxOutputTokens: 16000, responseMimeType: 'application/json' },
      }),
    },
  );
  const body = (await response.json()) as {
    error?: { message?: string };
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  if (!response.ok) throw new Error(body.error?.message ?? `Google AI API returned HTTP ${response.status}.`);
  return {
    text: body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '',
    inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

const ANALYZE_INSTRUCTION = `
Analyse the requirement below.

Return ONLY a JSON object, no prose outside it, shaped exactly:

{
  "summary": "<2-3 sentences a QA lead can read in ten seconds>",
  "analysisMarkdown": "<the full analysis, in the Analysis format given above>",
  "questions": [
    { "id": "Q1", "question": "<what you need answered>", "why": "<what it changes about the missions>", "options": ["<optional suggested answers>"] }
  ],
  "readyForMissions": <true only if nothing blocking remains unanswered>
}

Rules that decide whether this is usable:
- Gaps are questions for the requirement author. Never fill one in with something plausible.
- Ask ONLY questions whose answers change what gets built. Three good questions beat ten thorough ones — review time is the real constraint.
- If a gap can be resolved by looking at the application rather than by asking a person, say so in the analysis instead of asking.
- Set readyForMissions false if any unanswered question would change a mission's assertions.
`.trim();

const GENERATE_INSTRUCTION = `
The human has reviewed your analysis and answered your questions. Now produce the draft missions.

Return ONLY a JSON object, no prose outside it, shaped exactly:

{
  "missions": [ <full mission objects, each validating against the schema above> ],
  "notes": [ "<anything the human should know at Gate 2 — assumptions, fragile assertions, things you chose not to cover>" ]
}

Rules:
- Every assertion needs both a human "statement" and a machine-checkable "check".
- Targets are semantic (role + name, label, placeholder, text) — never CSS. You cannot see the DOM, so a guessed selector is a fabricated fact.
- If several elements would match a target (nav links repeated in a footer, a button repeated per product card), scope it with "within" or set expect_multiple — never leave it ambiguous.
- expected_outcome "blocked" for negative missions, with the refused step marked tolerate_failure.
- Anything that creates data needs {run_id} in its naming_pattern.
- Fill requirement_ref with the sentence each mission comes from.
- Set a budget on every mission.
- One objective per mission. If test_objective needs the word "and", it is probably two missions.
`.trim();

export interface RunInput {
  phase: Phase;
  model: string;
  effort: string;
  requirement: string;
  appContextYaml?: string;
  /**
   * Repo-relative path of the file this requirement came from, e.g.
   * "input/feature-ecommerce/requirement.md". Without it the agent guesses,
   * and every mission ends up citing the wrong requirement — which makes the
   * traceability claim worse than useless, because it looks satisfied.
   */
  requirementPath?: string;
  /** Suggested test_id prefix, to keep one feature's ids from colliding with another's. */
  idPrefix?: string;
  /** Prior turns, so phase 2 sees the analysis and the human's answers. */
  history: ChatMessage[];
}

export interface RunOutput {
  result: AnalyzeResult | GenerateResult;
  usage: Usage;
  /** The full exchange, to feed back in on the next phase. */
  history: ChatMessage[];
}

export async function runAgent(input: RunInput): Promise<RunOutput> {
  const system = buildSystemPrompt(input.appContextYaml);

  // Told to the agent in both phases: phase 1 records it in the analysis,
  // phase 2 needs it for every mission's requirement_ref.
  const provenance = [
    input.requirementPath
      ? `The requirement below is stored at "${input.requirementPath}". Use exactly that path as requirement_ref.locator (you may append a #section anchor). Do not cite any other file.`
      : `No source file path was supplied for this requirement. Set requirement_ref.source to "CHAT_TRANSCRIPT" and say plainly in your notes that the requirement is not yet committed to a file, so results cannot be traced back to it.`,
    input.idPrefix
      ? `Number every mission with the prefix "${input.idPrefix}", starting at ${input.idPrefix}-001. Ids from other features already exist; reusing them would overwrite real work.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const userTurn: ChatMessage =
    input.phase === 'analyze'
      ? {
          role: 'user',
          content: `${ANALYZE_INSTRUCTION}\n\n---\n\n${provenance}\n\n# Requirement under test\n\n${input.requirement}`,
        }
      : { role: 'user', content: `${GENERATE_INSTRUCTION}\n\n---\n\n${provenance}` };

  const messages = [...input.history, userTurn];

  const provider = providerForModel(input.model);
  let raw: string;
  let inputTokens: number;
  let outputTokens: number;
  if (provider === 'openai') {
    const result = await runOpenAI(input.model, system, messages, input.effort);
    raw = result.text;
    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;
  } else if (provider === 'google') {
    const result = await runGoogle(input.model, system, messages);
    raw = result.text;
    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;
  } else {
    const anthropic = client();
    const isLegacyThinking = input.model.startsWith('claude-haiku-4-5');
    const response = await anthropic.messages.create({
      model: input.model,
      max_tokens: 16000,
      system,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      ...(isLegacyThinking
        ? {}
        : {
            thinking: { type: 'adaptive' as const },
            output_config: { effort: input.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' },
          }),
    });
    raw = textOf(response);
    inputTokens = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;
  }

  const parsed = extractJson(raw) as Record<string, unknown>;

  const usage: Usage = {
    inputTokens,
    outputTokens,
    model: input.model,
  };

  const history: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: raw },
  ];

  if (input.phase === 'analyze') {
    const result: AnalyzeResult = {
      kind: 'analysis',
      analysisMarkdown: String(parsed.analysisMarkdown ?? ''),
      questions: Array.isArray(parsed.questions) ? (parsed.questions as ClarifyingQuestion[]) : [],
      readyForMissions: Boolean(parsed.readyForMissions),
      summary: String(parsed.summary ?? ''),
    };
    return { result, usage, history };
  }

  const result: GenerateResult = {
    kind: 'missions',
    missions: Array.isArray(parsed.missions) ? parsed.missions : [],
    notes: Array.isArray(parsed.notes) ? (parsed.notes as string[]) : [],
  };
  return { result, usage, history };
}

/** Append the human's answers as a turn the agent will see in phase 2. */
export function answersTurn(
  questions: ClarifyingQuestion[],
  answers: Record<string, string>,
): ChatMessage {
  const lines = questions.map((q) => `- ${q.id}: ${q.question}\n  HUMAN ANSWER: ${answers[q.id]?.trim() || '(left unanswered)'}`);
  return {
    role: 'user',
    content:
      `The human reviewed your questions and answered:\n\n${lines.join('\n')}\n\n` +
      `Treat these answers as authoritative. Where one was left unanswered, do NOT invent an answer — ` +
      `either avoid depending on it, or say plainly in your notes that it remains open.`,
  };
}

export function ensureDirs(): void {
  for (const dir of [P.missionsDraft, P.missionsApproved, P.analysisDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
