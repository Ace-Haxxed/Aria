/**
 * What each model can actually accept, and what the free tier allows.
 *
 * These figures decide whether a request is sent, trimmed, or routed
 * elsewhere, so they are worth stating precisely rather than guessing. The
 * Groq numbers were taken from Groq's own rate-limit documentation; the
 * context windows are the published values for each model.
 *
 * Every model listed here was confirmed present on the provider at the time of
 * writing. That check matters more than it sounds: Groq has decommissioned
 * several popular models (`mixtral-8x7b-32768`, `llama-3.1-70b-versatile` and
 * the `llama3-groq-*-tool-use` fine-tunes), and naming one of those as a
 * default would fail every first request with a 404.
 */
import type { LLMProvider } from './types';

export interface ModelLimits {
  id: string;
  label: string;
  /** Total context window in tokens, prompt plus completion. */
  context: number;
  /** Free-tier tokens per minute, where the provider publishes one. */
  tokensPerMinute?: number;
  /** Free-tier tokens per day. Often the real constraint, not TPM. */
  tokensPerDay?: number;
  /** Free-tier requests per day. */
  requestsPerDay?: number;
  /** Shown in the picker to explain the trade. */
  note?: string;
  /** The one ARIA recommends on a free plan. */
  recommendedFree?: boolean;
  /** The one ARIA recommends when quota is not a concern. */
  recommendedPaid?: boolean;
}

/**
 * Groq's current production models.
 *
 * `llama-3.1-8b-instant` is the free-tier default. It is not the largest, but
 * it has five times the daily token allowance of the 70B model and fourteen
 * times the daily request allowance — on a free key those ceilings are what
 * users actually hit, not the per-minute rate.
 */
export const GROQ_MODELS: ModelLimits[] = [
  {
    id: 'llama-3.1-8b-instant',
    label: 'Llama 3.1 8B Instant',
    context: 131_072,
    tokensPerMinute: 6_000,
    tokensPerDay: 500_000,
    requestsPerDay: 14_400,
    note: 'Best free-tier headroom — 500K tokens and 14,400 requests a day.',
    recommendedFree: true,
  },
  {
    id: 'llama-3.3-70b-versatile',
    label: 'Llama 3.3 70B Versatile',
    context: 131_072,
    tokensPerMinute: 12_000,
    tokensPerDay: 100_000,
    requestsPerDay: 1_000,
    note: 'Stronger reasoning, but only 100K tokens and 1,000 requests a day free.',
    recommendedPaid: true,
  },
  {
    id: 'llama3-8b-8192',
    label: 'Llama 3 8B',
    context: 8_192,
    note: 'Older 8B model with a small context window.',
  },
  {
    id: 'llama3-70b-8192',
    label: 'Llama 3 70B',
    context: 8_192,
    note: 'Older 70B model with a small context window.',
  },
];

const OPENAI_MODELS: ModelLimits[] = [
  { id: 'gpt-4o', label: 'GPT-4o', context: 128_000, recommendedPaid: true },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', context: 128_000, recommendedFree: true },
  { id: 'gpt-4-turbo', label: 'GPT-4 Turbo', context: 128_000 },
  { id: 'o1-mini', label: 'o1-mini', context: 128_000 },
];

const ANTHROPIC_MODELS: ModelLimits[] = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', context: 200_000, recommendedPaid: true },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', context: 200_000, recommendedFree: true },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', context: 200_000 },
];

/**
 * Gemini's current models.
 *
 * The 1.5 generation is retired: a request for `gemini-1.5-pro` now returns
 * "models/gemini-1.5-pro is not found for API version v1beta", which is
 * indistinguishable from a typo unless you know the model is gone. Every entry
 * here was checked against Google's published list.
 */
const GEMINI_MODELS: ModelLimits[] = [
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    context: 1_000_000,
    note: 'Fast, capable, and the most generous free tier.',
    recommendedFree: true,
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    context: 1_000_000,
    note: 'Strongest reasoning in the 2.5 generation.',
    recommendedPaid: true,
  },
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    context: 1_000_000,
    note: 'Newest fast model.',
  },
  {
    id: 'gemini-3.1-pro',
    label: 'Gemini 3.1 Pro',
    context: 1_000_000,
    note: 'Newest capable model.',
  },
  {
    id: 'gemini-2.0-flash',
    label: 'Gemini 2.0 Flash',
    context: 1_000_000,
    note: 'Older, still supported.',
  },
];

/**
 * OpenRouter proxies models from every provider, so its catalogue is theirs.
 * Only the handful ARIA offers by default are listed; anything else the user
 * types falls back to the conservative default, which is the safe direction.
 */
const OPENROUTER_MODELS: ModelLimits[] = [
  {
    id: 'google/gemma-4-26b-a4b-it:free',
    label: 'Gemma 4 26B (free)',
    context: 262_144,
    note: 'No credits needed, reads images, large context.',
    recommendedFree: true,
  },
  {
    id: 'nvidia/nemotron-3.5-lightning:free',
    label: 'Nemotron 3.5 Lightning (free)',
    context: 1_000_000,
    note: 'Very large context, no credits needed.',
  },
  {
    id: 'anthropic/claude-sonnet-4.5',
    label: 'Claude Sonnet 4.5',
    context: 1_000_000,
    note: 'Strongest all-rounder. Paid.',
    recommendedPaid: true,
  },
  { id: 'openai/gpt-4o', label: 'GPT-4o', context: 128_000, note: 'Paid.' },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', context: 1_048_576, note: 'Paid.' },
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    label: 'Llama 3.3 70B',
    context: 131_072,
    note: 'Paid, without the free tier\u2019s rate limits.',
  },
];

/** Local models, where the window is whatever the loader was configured with. */
const LOCAL_DEFAULT_CONTEXT = 8_192;

export function modelsFor(provider: LLMProvider): ModelLimits[] {
  switch (provider) {
    case 'groq':
      return GROQ_MODELS;
    case 'openai':
      return OPENAI_MODELS;
    case 'anthropic':
      return ANTHROPIC_MODELS;
    case 'gemini':
      return GEMINI_MODELS;
    case 'openrouter':
      return OPENROUTER_MODELS;
    // Bytez hosts thousands of HuggingFace models with no short list to
    // publish, so its window is whatever the conservative default is.
    case 'bytez':
      return [];
    default:
      return [];
  }
}

/**
 * The context window for a model, falling back to a conservative guess.
 *
 * Guessing low is the safe direction: an unnecessary trim costs a little
 * history, while an overestimate produces a hard failure from the provider.
 */
export function contextLimit(provider: LLMProvider, model: string): number {
  const known = modelsFor(provider).find((m) => m.id === model);
  if (known) return known.context;

  // Ollama's own default, and what the built-in engine is configured for.
  if (provider === 'ollama' || provider === 'builtin') return LOCAL_DEFAULT_CONTEXT;

  // An unrecognised cloud model is more likely modern and large than tiny,
  // but 8k is the floor that will not overflow anything.
  return LOCAL_DEFAULT_CONTEXT;
}

/** The model this provider recommends, given whether quota matters. */
export function recommendedModel(provider: LLMProvider, freeTier: boolean): string | null {
  const models = modelsFor(provider);
  const pick = freeTier
    ? models.find((m) => m.recommendedFree)
    : models.find((m) => m.recommendedPaid);
  return pick?.id ?? models[0]?.id ?? null;
}

/**
 * A model from the same provider with a larger window, if one exists.
 *
 * Used when a conversation outgrows the current model: moving to a bigger
 * window keeps the whole history, which is better than summarising it away.
 */
export function largerContextModel(
  provider: LLMProvider,
  model: string,
  needed: number,
): string | null {
  const current = contextLimit(provider, model);
  const candidates = modelsFor(provider)
    .filter((m) => m.context > current && m.context >= needed)
    .sort((a, b) => a.context - b.context);
  return candidates[0]?.id ?? null;
}

/** Roughly four characters per token — close enough to decide on trimming. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
