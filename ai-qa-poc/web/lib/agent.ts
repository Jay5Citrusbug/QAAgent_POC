import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import { P, readIfPresent } from './paths';

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

function client(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Copy web/.env.local.example to web/.env.local and add your key.',
    );
  }
  return new Anthropic();
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
  "notes": [ "<anything the human should know at Gate 1 — assumptions, fragile assertions, things you chose not to cover>" ]
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
  history: Anthropic.MessageParam[];
}

export interface RunOutput {
  result: AnalyzeResult | GenerateResult;
  usage: Usage;
  /** The full exchange, to feed back in on the next phase. */
  history: Anthropic.MessageParam[];
}

export async function runAgent(input: RunInput): Promise<RunOutput> {
  const anthropic = client();
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

  const userTurn: Anthropic.MessageParam =
    input.phase === 'analyze'
      ? {
          role: 'user',
          content: `${ANALYZE_INSTRUCTION}\n\n---\n\n${provenance}\n\n# Requirement under test\n\n${input.requirement}`,
        }
      : { role: 'user', content: `${GENERATE_INSTRUCTION}\n\n---\n\n${provenance}` };

  const messages = [...input.history, userTurn];

  // Haiku 4.5 predates adaptive thinking and takes budget_tokens instead, so
  // effort/adaptive are only sent to the models that accept them.
  const isLegacyThinking = input.model.startsWith('claude-haiku-4-5');

  const response = await anthropic.messages.create({
    model: input.model,
    max_tokens: 16000,
    system,
    messages,
    ...(isLegacyThinking
      ? {}
      : {
          thinking: { type: 'adaptive' as const },
          output_config: { effort: input.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' },
        }),
  });

  const raw = textOf(response);
  const parsed = extractJson(raw) as Record<string, unknown>;

  const usage: Usage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model: response.model,
  };

  const history: Anthropic.MessageParam[] = [
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
): Anthropic.MessageParam {
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
