import YAML from 'yaml';
import { P, readIfPresent } from './paths';

/**
 * The models offered in the UI.
 *
 * Opus 5 is the default because requirement analysis is the task of finding
 * what *is not stated*, which is where reasoning depth actually pays. At
 * roughly $0.20-0.30 per analysis, model cost is not the variable that
 * matters here — human review time is.
 */
export interface ModelChoice {
  id: string;
  provider: 'anthropic' | 'openai' | 'google';
  label: string;
  note: string;
  inputPerM: number;
  outputPerM: number;
  recommended?: boolean;
}

export const MODELS: ModelChoice[] = [
  {
    id: 'claude-opus-5',
    provider: 'anthropic',
    label: 'Claude Opus 5',
    note: 'Best at finding gaps the requirement never states. Recommended.',
    inputPerM: 5,
    outputPerM: 25,
    recommended: true,
  },
  {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 5',
    note: 'Cheaper. Reasonable for re-analysing a feature already understood.',
    inputPerM: 2,
    outputPerM: 10,
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    label: 'Claude Haiku 4.5',
    note: 'Fastest and cheapest, but too shallow for real gap analysis.',
    inputPerM: 1,
    outputPerM: 5,
  },
  {
    id: 'gpt-5',
    provider: 'openai',
    label: 'GPT-5',
    note: 'OpenAI model, when OPENAI_API_KEY is configured.',
    inputPerM: 0,
    outputPerM: 0,
  },
  {
    id: 'gemini-2.5-pro',
    provider: 'google',
    label: 'Gemini 2.5 Pro',
    note: 'Google model, when GEMINI_API_KEY or GOOGLE_API_KEY is configured.',
    inputPerM: 0,
    outputPerM: 0,
  },
];

export type ModelProvider = ModelChoice['provider'];

export function providerForModel(model: string): ModelProvider {
  const known = MODELS.find((choice) => choice.id === model);
  if (known) return known.provider;
  if (/^(gpt-|o[1-9]|chatgpt-)/i.test(model)) return 'openai';
  if (/^(gemini-|gemma-)/i.test(model)) return 'google';
  if (/^(claude-)/i.test(model)) return 'anthropic';
  throw new Error(`Cannot determine provider for model: ${model}`);
}

export function providerAvailable(provider: ModelProvider): boolean {
  if (provider === 'anthropic') return Boolean(process.env.ANTHROPIC_API_KEY);
  if (provider === 'openai') return Boolean(process.env.OPENAI_API_KEY);
  return Boolean(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY);
}

/** Models configured in code plus arbitrary model ids supplied through AI_MODELS. */
export function availableModels(): ModelChoice[] {
  const configured = (process.env.AI_MODELS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => ({
      id,
      provider: providerForModel(id),
      label: id,
      note: 'Configured through AI_MODELS.',
      inputPerM: 0,
      outputPerM: 0,
    }));
  const choices = [...MODELS, ...configured.filter((choice) => !MODELS.some((known) => known.id === choice.id))];
  return choices.filter((choice) => providerAvailable(choice.provider));
}

/** The committed default from agent/thinking/config.yaml, so UI and CLI agree. */
export function configuredDefault(): { model: string; effort: string } {
  const raw = readIfPresent(P.thinkingConfig);
  const fallback = { model: 'claude-opus-5', effort: 'high' };
  if (!raw) return fallback;
  try {
    const parsed = YAML.parse(raw) as { model?: string; effort?: string };
    return { model: parsed.model ?? fallback.model, effort: parsed.effort ?? fallback.effort };
  } catch {
    return fallback;
  }
}

export function isAllowedModel(id: string): boolean {
  try {
    return providerAvailable(providerForModel(id));
  } catch {
    return false;
  }
}

/** Ask each configured provider for its current model list. */
export async function discoverAvailableModels(): Promise<ModelChoice[]> {
  const discovered: ModelChoice[] = [];

  if (providerAvailable('openai')) {
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      });
      if (response.ok) {
        const body = (await response.json()) as { data?: { id?: string }[] };
        for (const model of body.data ?? []) {
          if (model.id && /^(gpt-|o[1-9]|chatgpt-)/i.test(model.id)) discovered.push(modelChoice(model.id, 'openai'));
        }
      }
    } catch {
      // Built-in and AI_MODELS entries remain available if discovery is offline.
    }
  }

  if (providerAvailable('anthropic')) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY as string, 'anthropic-version': '2023-06-01' },
      });
      if (response.ok) {
        const body = (await response.json()) as { data?: { id?: string }[] };
        for (const model of body.data ?? []) {
          if (model.id?.startsWith('claude-')) discovered.push(modelChoice(model.id, 'anthropic'));
        }
      }
    } catch {
      // Built-in and AI_MODELS entries remain available if discovery is offline.
    }
  }

  if (providerAvailable('google')) {
    try {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '' },
      });
      if (response.ok) {
        const body = (await response.json()) as {
          models?: { name?: string; supportedGenerationMethods?: string[] }[];
        };
        for (const model of body.models ?? []) {
          const id = model.name?.replace(/^models\//, '');
          if (id?.startsWith('gemini-') && model.supportedGenerationMethods?.includes('generateContent')) {
            discovered.push(modelChoice(id, 'google'));
          }
        }
      }
    } catch {
      // Built-in and AI_MODELS entries remain available if discovery is offline.
    }
  }

  const all = [...availableModels(), ...discovered];
  return all.filter((model, index) => all.findIndex((candidate) => candidate.id === model.id) === index);
}

function modelChoice(id: string, provider: ModelProvider): ModelChoice {
  return { id, provider, label: id, note: `Available from ${provider}.`, inputPerM: 0, outputPerM: 0 };
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const m = MODELS.find((x) => x.id === model);
  if (!m) return 0;
  return (inputTokens / 1_000_000) * m.inputPerM + (outputTokens / 1_000_000) * m.outputPerM;
}
