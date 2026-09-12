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
  label: string;
  note: string;
  inputPerM: number;
  outputPerM: number;
  recommended?: boolean;
}

export const MODELS: ModelChoice[] = [
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    note: 'Best at finding gaps the requirement never states. Recommended.',
    inputPerM: 5,
    outputPerM: 25,
    recommended: true,
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    note: 'Cheaper. Reasonable for re-analysing a feature already understood.',
    inputPerM: 2,
    outputPerM: 10,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    note: 'Fastest and cheapest, but too shallow for real gap analysis.',
    inputPerM: 1,
    outputPerM: 5,
  },
];

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
  return MODELS.some((m) => m.id === id);
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const m = MODELS.find((x) => x.id === model);
  if (!m) return 0;
  return (inputTokens / 1_000_000) * m.inputPerM + (outputTokens / 1_000_000) * m.outputPerM;
}
