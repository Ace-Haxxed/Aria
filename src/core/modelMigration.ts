/**
 * Repairing saved model names that the provider has since retired.
 *
 * Changing the defaults only helps new users. Anyone who already picked
 * `gemini-1.5-pro` has it written into their settings, and every request they
 * make fails with "models/gemini-1.5-pro is not found for API version v1beta"
 * — an error that names a model they never typed and cannot be fixed by
 * updating the app. So saved settings are migrated on load.
 *
 * The mapping is to the nearest live equivalent rather than to the newest
 * model: someone who chose a fast, cheap model should not silently be moved
 * onto an expensive one.
 */
import type { LLMProvider } from './types';

/** Retired model → its closest living replacement, per provider. */
const RETIRED: Record<string, Record<string, string>> = {
  gemini: {
    'gemini-1.5-pro': 'gemini-2.5-pro',
    'gemini-1.5-pro-latest': 'gemini-2.5-pro',
    'gemini-1.5-flash': 'gemini-2.5-flash',
    'gemini-1.5-flash-latest': 'gemini-2.5-flash',
    'gemini-1.5-flash-8b': 'gemini-2.5-flash',
    'gemini-2.0-flash-exp': 'gemini-2.0-flash',
    'gemini-pro': 'gemini-2.5-pro',
    'gemini-pro-vision': 'gemini-2.5-flash',
  },
  groq: {
    // Groq has now retired the entire Llama line, including the two models
    // this table previously migrated *to* — so anyone repaired by an earlier
    // version was moved onto an id that has since died as well. Everything
    // lands on `gpt-oss-20b`, which their /models endpoint serves today and
    // which was verified against a real tool call.
    'mixtral-8x7b-32768': 'openai/gpt-oss-20b',
    'llama-3.1-8b-instant': 'openai/gpt-oss-20b',
    'llama-3.1-70b-versatile': 'openai/gpt-oss-120b',
    'llama-3.3-70b-versatile': 'openai/gpt-oss-120b',
    'llama3-8b-8192': 'openai/gpt-oss-20b',
    'llama3-70b-8192': 'openai/gpt-oss-120b',
    'llama3-groq-8b-8192-tool-use-preview': 'openai/gpt-oss-20b',
    'llama3-groq-70b-8192-tool-use-preview': 'openai/gpt-oss-120b',
    'llama-3.2-90b-vision-preview': 'openai/gpt-oss-120b',
    'llama-3.2-11b-vision-preview': 'openai/gpt-oss-20b',
    'gemma-7b-it': 'openai/gpt-oss-20b',
    'gemma2-9b-it': 'openai/gpt-oss-20b',
  },
};

export interface Migration {
  provider: LLMProvider;
  from: string;
  to: string;
}

/** The replacement for a retired model, or `null` if it is still current. */
export function replacementFor(provider: LLMProvider, model: string): string | null {
  return RETIRED[provider]?.[model] ?? null;
}

/**
 * Rewrite any retired model names in a settings object.
 *
 * Returns what changed so the caller can tell the user once, rather than
 * leaving them wondering why the model in Settings is not the one they chose.
 */
export function migrateModels<
  T extends { llm: { provider: LLMProvider; model: string; visionModel: string } },
>(settings: T): { settings: T; migrations: Migration[] } {
  const migrations: Migration[] = [];
  const llm = { ...settings.llm };

  const model = replacementFor(llm.provider, llm.model);
  if (model) {
    migrations.push({ provider: llm.provider, from: llm.model, to: model });
    llm.model = model;
  }

  const vision = replacementFor(llm.provider, llm.visionModel);
  if (vision) {
    // Only reported once if it is the same swap as the text model.
    if (!migrations.some((m) => m.from === llm.visionModel)) {
      migrations.push({ provider: llm.provider, from: llm.visionModel, to: vision });
    }
    llm.visionModel = vision;
  }

  return migrations.length > 0
    ? { settings: { ...settings, llm }, migrations }
    : { settings, migrations };
}
