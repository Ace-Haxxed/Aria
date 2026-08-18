/**
 * Choosing which backend actually answers a message.
 *
 * A configured provider is not the same as a working one: Ollama may be
 * stopped, a key may have been revoked, a laptop may be offline. Rather than
 * failing the message, this walks the user's fallback chain and returns the
 * first backend that can serve it — and repairs the model name on the way, so
 * a stale `llama3.1:8b` in settings does not become a 404 the user has to
 * decode.
 *
 * The rule throughout: if a fallback succeeds, the user is told which model
 * answered but is never shown an error. An error is for something they must
 * act on, and a successful answer is not that.
 */
import type { LLMConfig, LLMProvider, Settings } from './types';
import { providerSpec } from './llm';
import { isTauri } from '@/platform';
import { loadApiKey } from '@/store/settings';

export interface ResolvedProvider {
  config: LLMConfig;
  /** True when this is not the provider the user nominated. */
  substituted: boolean;
  /** Set when the model had to be changed, for a one-line notice. */
  modelNote?: string;
}

/** Local check that a provider is even worth attempting. */
async function isConfigured(provider: LLMProvider, settings: Settings): Promise<boolean> {
  const spec = providerSpec(provider);

  // The built-in model is only usable once its weights are on disk; before
  // that it is a download, not a backend.
  if (provider === 'builtin') {
    if (!isTauri) return false;
    try {
      const { desktop } = await import('@/platform/desktop');
      const status = await desktop.builtinStatus();
      return status.loaded || status.downloaded;
    } catch {
      return false;
    }
  }

  if (!spec.needsApiKey) return true;
  if (settings.llm.provider === provider && settings.llm.apiKey) return true;
  // Keys live in the OS keychain, one per provider.
  return Boolean(await loadApiKey(provider));
}

async function configFor(provider: LLMProvider, settings: Settings): Promise<LLMConfig> {
  const spec = providerSpec(provider);
  const isCurrent = settings.llm.provider === provider;

  return {
    ...settings.llm,
    provider,
    // Only the nominated provider's model/baseUrl carry over; another
    // provider's settings would name a model it does not have.
    model: isCurrent ? settings.llm.model : spec.defaultModel,
    visionModel: isCurrent ? settings.llm.visionModel : spec.defaultVisionModel,
    baseUrl: isCurrent ? settings.llm.baseUrl : undefined,
    apiKey: spec.needsApiKey
      ? ((isCurrent ? settings.llm.apiKey : undefined) ?? (await loadApiKey(provider)) ?? undefined)
      : undefined,
  };
}

/**
 * Confirm Ollama is up and that the requested model exists, correcting the
 * model when it does not.
 *
 * Returns `null` when the server itself is unreachable, which tells the caller
 * to move on to the next provider in the chain.
 */
async function resolveOllama(config: LLMConfig): Promise<ResolvedProvider | null> {
  if (!isTauri) return { config, substituted: false };

  const { desktop } = await import('@/platform/desktop');
  const status = await desktop.checkOllamaAndStart(config.baseUrl || undefined);
  if (!status.running || status.models.length === 0) return null;

  // Prefix match, because Ollama tags everything: a settings value of
  // `llama3.1:8b` should be satisfied by `llama3.1:8b-instruct-q4_0`.
  const exact = status.models.find(
    (m) => m === config.model || m.startsWith(`${config.model}:`) || m.startsWith(config.model),
  );
  if (exact) {
    return { config: { ...config, model: exact }, substituted: false };
  }

  const replacement = status.preferred ?? status.models[0];
  return {
    config: { ...config, model: replacement },
    substituted: false,
    modelNote: `Switched to ${replacement} — ${config.model} is not installed.`,
  };
}

/**
 * Find a backend that can answer, starting with the user's choice.
 *
 * Throws only when nothing in the chain is usable, since at that point there
 * is genuinely nothing to fall back to and the user has to intervene.
 */
export async function resolveProvider(
  settings: Settings,
  /**
   * What the router decided this message needs. `builtin` asks for the local
   * model specifically — routine work that should not cost API quota — and
   * falls through to the normal chain if it is not ready.
   */
  tier?: 'builtin' | 'fast' | 'smart' | 'vision',
): Promise<ResolvedProvider> {
  const preferred = settings.llm.provider;

  // The nominated provider first, then the chain with it removed so it is not
  // attempted twice.
  const order: LLMProvider[] = [
    preferred,
    ...settings.fallbackChain.filter((p) => p !== preferred),
  ];

  // A local-tier request tries the built-in model first regardless of which
  // provider is selected. If it is not downloaded the chain proceeds as
  // normal, so this can only help.
  if (tier === 'builtin' && order[0] !== 'builtin') {
    order.unshift('builtin');
  }

  const reasons: string[] = [];

  for (const provider of order) {
    if (!(await isConfigured(provider, settings))) {
      reasons.push(`${providerSpec(provider).label.split(' (')[0]}: no API key`);
      continue;
    }

    const config = await configFor(provider, settings);

    // Loading takes seconds and only has to happen once; doing it here means
    // the first message does not fail on a model that was merely downloaded.
    if (provider === 'builtin' && isTauri) {
      try {
        const { desktop } = await import('@/platform/desktop');
        const status = await desktop.builtinStatus();
        if (!status.loaded) {
          await desktop.builtinLoadModel(config.model || 'phi-3.5-mini');
        }
        return { config, substituted: provider !== preferred };
      } catch {
        reasons.push('Built-in model: could not be loaded');
        continue;
      }
    }

    if (provider === 'ollama') {
      const resolved = await resolveOllama(config);
      if (!resolved) {
        reasons.push('Ollama: not running');
        continue;
      }
      return { ...resolved, substituted: provider !== preferred };
    }

    // Cloud providers are not probed here. A round trip before every message
    // would add latency to the common case to detect the rare one, and a
    // failure surfaces immediately anyway with a message that names the fix.
    return { config, substituted: provider !== preferred };
  }

  throw new Error(
    `No AI backend is available. ${reasons.join('; ')}. Add an API key or start Ollama in Settings → API Keys.`,
  );
}
