/**
 * Provider credentials, mirrored from `~/.config/aria/keys.json`.
 *
 * Rust reads the file once during setup and holds it in memory, so this store
 * is filled by a single command call before the first frame renders. Nothing
 * in the message path ever waits on it afterwards: sending a message reads the
 * active provider and key straight out of this store.
 */
import { create } from 'zustand';
import { isTauri } from '@/platform';

export type Provider = 'openai' | 'anthropic' | 'gemini' | 'groq' | 'openrouter' | 'bytez';

export const PROVIDERS: Provider[] = [
  'bytez',
  'openrouter',
  'groq',
  'openai',
  'anthropic',
  'gemini',
];

export const PROVIDER_LABEL: Record<Provider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  bytez: 'Bytez',
};

/** Where to get a key, shown next to an empty field. */
export const PROVIDER_CONSOLE: Record<Provider, string> = {
  openai: 'platform.openai.com/api-keys',
  anthropic: 'console.anthropic.com/settings/keys',
  gemini: 'aistudio.google.com/apikey',
  groq: 'console.groq.com/keys',
  openrouter: 'openrouter.ai/keys',
  bytez: 'bytez.com',
};

export interface KeyCheck {
  ok: boolean;
  message: string;
  latencyMs: number;
}

export type CheckState = 'unset' | 'checking' | 'ok' | 'failed';

interface KeyConfig {
  active_provider: string;
  keys: Record<string, string>;
  model: string;
  openrouter_model: string;
}

/** One row of OpenRouter's free catalogue, as Rust reports it. */
export interface FreeModel {
  id: string;
  name: string;
  context: number;
  /** Total parameters in billions, when the id states them. */
  paramsB: number | null;
  /** 'Smart' | 'Balanced' | 'Fast', or null when the size is unknown. */
  tier: string | null;
  vision: boolean;
}

/**
 * Used when OpenRouter cannot be reached.
 *
 * Kept in step with OPENROUTER_FALLBACK_MODEL in the Rust key module; a Rust
 * test hits the live catalogue and fails if this id stops being free.
 */
export const OPENROUTER_FALLBACK_MODEL = 'google/gemma-4-26b-a4b-it:free';

interface KeyState {
  loaded: boolean;
  activeProvider: Provider;
  model: string;
  keys: Record<string, string>;
  status: Record<string, CheckState>;
  messages: Record<string, string>;
  /** OpenRouter's free catalogue, fetched when the settings page opens. */
  freeModels: FreeModel[];
  freeModelsState: 'idle' | 'loading' | 'ready' | 'failed';
  loadFreeModels: () => Promise<void>;

  load: () => Promise<void>;
  saveKey: (provider: Provider, key: string) => Promise<boolean>;
  removeKey: (provider: Provider) => Promise<void>;
  setActive: (provider: Provider) => Promise<void>;
  setModel: (model: string) => Promise<void>;
  /** True when the active provider has a key — the app is usable. */
  ready: () => boolean;
}

const DEFAULTS: Pick<KeyState, 'activeProvider' | 'model' | 'keys' | 'status' | 'messages'> = {
  activeProvider: 'bytez',
  model: OPENROUTER_FALLBACK_MODEL,
  keys: Object.fromEntries(PROVIDERS.map((p) => [p, ''])),
  status: Object.fromEntries(PROVIDERS.map((p) => [p, 'unset' as CheckState])),
  messages: {},
};

export const useKeys = create<KeyState>((set, get) => ({
  loaded: false,
  freeModels: [],
  freeModelsState: 'idle',
  ...DEFAULTS,

  async loadFreeModels() {
    if (!isTauri) return;
    // Already have them, or a fetch is in flight: opening the settings page
    // twice should not mean fetching the catalogue twice.
    const { freeModelsState } = get();
    if (freeModelsState === 'loading' || freeModelsState === 'ready') return;

    set({ freeModelsState: 'loading' });
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const models = await invoke<FreeModel[]>('openrouter_free_models');
      // Rust returns an empty list rather than an error when the fetch fails,
      // so an empty result is a failure to load, not a real empty catalogue.
      set(
        models.length > 0
          ? { freeModels: models, freeModelsState: 'ready' }
          : { freeModelsState: 'failed' },
      );
    } catch {
      set({ freeModelsState: 'failed' });
    }
  },

  async load() {
    if (!isTauri) {
      set({ loaded: true });
      return;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const config = await invoke<KeyConfig>('key_config');

      set({
        loaded: true,
        activeProvider: (config.active_provider as Provider) ?? 'bytez',
        model: config.model || config.openrouter_model || DEFAULTS.model,
        keys: { ...DEFAULTS.keys, ...config.keys },
        // A stored key is assumed good until something proves otherwise.
        // Probing all six on launch would add a round trip to startup for
        // information the user only needs when they open Settings.
        status: Object.fromEntries(
          PROVIDERS.map((p) => [p, config.keys?.[p] ? 'ok' : 'unset']),
        ) as Record<string, CheckState>,
      });
    } catch {
      // A failure here must not stop the app from starting; the settings page
      // will show empty fields and the user can re-enter a key.
      set({ loaded: true });
    }
  },

  async saveKey(provider, key) {
    const trimmed = key.replace(/\s+/g, '');
    if (!trimmed) return false;

    set((s) => ({ status: { ...s.status, [provider]: 'checking' } }));

    const { invoke } = await import('@tauri-apps/api/core');
    const check = await invoke<KeyCheck>('validate_key', { provider, key: trimmed });

    if (!check.ok) {
      set((s) => ({
        status: { ...s.status, [provider]: 'failed' },
        messages: { ...s.messages, [provider]: check.message },
      }));
      return false;
    }

    await invoke('set_key', { provider, key: trimmed });
    set((s) => ({
      keys: { ...s.keys, [provider]: trimmed },
      status: { ...s.status, [provider]: 'ok' },
      messages: { ...s.messages, [provider]: check.message },
    }));
    return true;
  },

  async removeKey(provider) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_key', { provider, key: '' });
    set((s) => ({
      keys: { ...s.keys, [provider]: '' },
      status: { ...s.status, [provider]: 'unset' },
      messages: { ...s.messages, [provider]: '' },
    }));
  },

  async setActive(provider) {
    set({ activeProvider: provider });
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_active_provider', { provider });

    // Rust moves the model with the provider — each one serves a different
    // catalogue. Without reading it back, the UI would keep showing the model
    // belonging to the provider we just left.
    const config = await invoke<KeyConfig>('key_config').catch(() => null);
    if (config) set({ model: config.model });
  },

  async setModel(model) {
    set({ model });
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_active_model', { model });
  },

  ready() {
    const { activeProvider, keys } = get();
    return Boolean(keys[activeProvider]);
  },
}));

/** A key with its middle removed, for display. */
export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 12) return '••••••';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
