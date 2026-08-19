/**
 * Settings store, persisted to disk and rehydrated at startup.
 *
 * API keys are the one exception: they live in the OS keychain (desktop) or
 * secure preferences (mobile) and are merged into the in-memory config, never
 * written into the settings file.
 */
import { create } from 'zustand';
import type { Capability, LLMProvider, Settings } from '@/core/types';
import { DEFAULT_SYSTEM_PROMPT } from '@/core/agent';
import { providerSpec } from '@/core/llm';
import { migrateModels } from '@/core/modelMigration';
import { isMobile, isTauri } from '@/platform';
import { clamp } from '@/lib/utils';

const SETTINGS_KEY = 'nova.settings';

const ALL_CAPABILITIES: Capability[] = [
  'mouse',
  'keyboard',
  'screen',
  'files',
  'browser',
  'terminal',
  'packages',
  'system',
  'camera',
  'microphone',
  'notifications',
  'network',
];

function defaultCapabilities(): Record<Capability, boolean> {
  const caps = {} as Record<Capability, boolean>;
  for (const c of ALL_CAPABILITIES) {
    // Everything is on except the two that can do the most damage fastest —
    // those are opt-in, so a fresh install cannot run shell commands or touch
    // system packages until the user says so.
    caps[c] = c !== 'terminal' && c !== 'packages';
  }
  return caps;
}

export function defaultSettings(): Settings {
  const provider: LLMProvider = isMobile ? 'groq' : 'ollama';
  const spec = providerSpec(provider);

  return {
    launchAtStartup: false,
    startMinimized: false,
    language: 'en',
    accentHue: 189,
    llm: {
      provider,
      model: spec.defaultModel,
      visionModel: spec.defaultVisionModel,
      baseUrl: spec.baseUrl,
      temperature: 0.7,
      maxTokens: 2048,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    },
    voice: {
      sttEngine: isMobile ? 'native' : 'whisper-sidecar',
      ttsEngine: isMobile ? 'native' : 'piper-sidecar',
      wakeWordEnabled: false,
      wakeWord: 'nova',
      wakeWordSensitivity: 7,
      activationSound: true,
      autoStopOnSilence: true,
      silenceTimeoutMs: 800,
      speed: 1,
      pitch: 1,
      voice: 'default',
      autoSpeak: true,
    },
    hotkeys: {
      toggleWindow: 'CommandOrControl+Space',
      pushToTalk: 'CommandOrControl+Shift+J',
      screenshotAsk: 'CommandOrControl+Shift+S',
      cancel: 'Escape',
    },
    saveHistory: true,
    screenshotRetention: 'session',
    capabilities: defaultCapabilities(),
    trustedTools: [],
    setupComplete: false,
    trainLocalFromCloud: false,
    seenHints: [],
    fallbackChain: [
      'builtin',
      'ollama',
      'groq',
      'openrouter',
      'openai',
      'anthropic',
      'gemini',
      'bytez',
    ],
    useBestAvailable: false,
    responseSpeed: 'balanced',
    fastMode: false,
    modelWarmup: true,
    showModelStats: true,
    goodbyeMinimizes: true,
    raiseOnWakeWord: true,
    persistentMemory: true,
  };
}

/** Merge a stored blob over the defaults so new fields appear on upgrade. */
function reconcile(stored: Partial<Settings> | null): Settings {
  const base = defaultSettings();
  if (!stored) return base;

  return {
    ...base,
    ...stored,
    llm: { ...base.llm, ...stored.llm },
    voice: { ...base.voice, ...stored.voice },
    hotkeys: { ...base.hotkeys, ...stored.hotkeys },
    capabilities: { ...base.capabilities, ...stored.capabilities },
    trustedTools: stored.trustedTools ?? base.trustedTools,
  };
}

async function readRaw(): Promise<Partial<Settings> | null> {
  try {
    if (isMobile) {
      const { Preferences } = await import('@capacitor/preferences');
      const { value } = await Preferences.get({ key: SETTINGS_KEY });
      return value ? (JSON.parse(value) as Partial<Settings>) : null;
    }
    if (isTauri) {
      const { load } = await import('@tauri-apps/plugin-store');
      const store = await load('settings.json', { autoSave: false });
      return ((await store.get(SETTINGS_KEY)) as Partial<Settings> | null) ?? null;
    }
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as Partial<Settings>) : null;
  } catch {
    return null;
  }
}

async function writeRaw(settings: Settings): Promise<void> {
  // The API key is held only in memory and the keychain.
  const { apiKey: _omit, ...llm } = settings.llm;
  const persistable: Settings = { ...settings, llm: llm as Settings['llm'] };

  try {
    if (isMobile) {
      const { Preferences } = await import('@capacitor/preferences');
      await Preferences.set({ key: SETTINGS_KEY, value: JSON.stringify(persistable) });
      return;
    }
    if (isTauri) {
      const { load } = await import('@tauri-apps/plugin-store');
      const store = await load('settings.json', { autoSave: false });
      await store.set(SETTINGS_KEY, persistable);
      await store.save();
      return;
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(persistable));
  } catch (e) {
    // Losing a setting silently is worse than an interruption: the user
    // would keep changing it and keep having it revert.
    void import('./toasts').then((m) =>
      m.toast.error('Could not save your settings', m.humanise(e)),
    );
  }
}

/* ── API keys ────────────────────────────────────────────────────── */

export async function loadApiKey(provider: string): Promise<string | null> {
  try {
    if (isTauri) {
      // The unified key file is already in memory — Rust read it during setup
      // and the store was filled before the first render. Reading it here
      // costs nothing, which is what keeps the first message from waiting on
      // a keychain round trip.
      const { useKeys } = await import('./keys');
      const cached = useKeys.getState().keys[provider];
      if (cached) return cached;

      // Nothing in the new file: fall back to the keychain, which is where
      // keys lived before this build.
      const { desktop } = await import('@/platform/desktop');
      return await desktop.getApiKey(provider);
    }
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: `nova.key.${provider}` });
    return value ?? null;
  } catch {
    return null;
  }
}

export async function storeApiKey(provider: string, key: string): Promise<void> {
  if (isTauri) {
    const { desktop } = await import('@/platform/desktop');
    await desktop.setApiKey(provider, key);
    return;
  }
  const { Preferences } = await import('@capacitor/preferences');
  if (key.trim()) {
    await Preferences.set({ key: `nova.key.${provider}`, value: key });
  } else {
    await Preferences.remove({ key: `nova.key.${provider}` });
  }
}

/* ── Store ───────────────────────────────────────────────────────── */

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<Settings>) => void;
  updateLLM: (patch: Partial<Settings['llm']>) => void;
  updateVoice: (patch: Partial<Settings['voice']>) => void;
  updateHotkeys: (patch: Partial<Settings['hotkeys']>) => void;
  setCapability: (capability: Capability, enabled: boolean) => void;
  trustTool: (name: string) => void;
  untrustTool: (name: string) => void;
  setProvider: (provider: LLMProvider) => Promise<void>;
  setApiKey: (provider: string, key: string) => Promise<void>;
  setAccentHue: (hue: number) => void;
  reset: () => Promise<void>;
}

/** Push the accent hue into the CSS variable every colour derives from. */
function applyAccent(hue: number): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--accent-h', String(clamp(hue, 0, 360)));
}

export const useSettings = create<SettingsState>((set, get) => {
  const persist = (settings: Settings) => {
    void writeRaw(settings);
  };

  return {
    settings: defaultSettings(),
    loaded: false,

    async load() {
      const raw = reconcile(await readRaw());

      // Providers retire models, and a saved name that no longer exists fails
      // every request with an error naming a model the user never typed.
      // Updating the app's defaults does not reach settings already on disk,
      // so they are repaired here.
      const { settings, migrations } = migrateModels(raw);
      if (migrations.length > 0) {
        persist(settings);
        void import('./toasts').then((m) =>
          m.toast.info(
            `Switched to ${migrations[0].to}`,
            `${migrations[0].from} was retired by the provider and no longer accepts requests.`,
          ),
        );
      }

      // `~/.config/nova/keys.json` is authoritative for which provider and
      // model are in use — it is what the settings page writes and what
      // `nova --keys` edits. Settings follows it rather than keeping a second,
      // divergent answer.
      if (isTauri) {
        const { useKeys } = await import('./keys');
        const unified = useKeys.getState();
        if (unified.loaded && unified.ready()) {
          settings.llm.provider = unified.activeProvider as typeof settings.llm.provider;
          settings.llm.model = unified.model;
        }
      }

      // Pull the key for the active provider out of secure storage.
      const key = await loadApiKey(settings.llm.provider);
      if (key) settings.llm.apiKey = key;

      applyAccent(settings.accentHue);
      set({ settings, loaded: true });
    },

    update(patch) {
      const settings = { ...get().settings, ...patch };
      set({ settings });
      persist(settings);
    },

    updateLLM(patch) {
      const settings = { ...get().settings, llm: { ...get().settings.llm, ...patch } };
      set({ settings });
      persist(settings);
    },

    updateVoice(patch) {
      const settings = { ...get().settings, voice: { ...get().settings.voice, ...patch } };
      set({ settings });
      persist(settings);
    },

    updateHotkeys(patch) {
      const settings = { ...get().settings, hotkeys: { ...get().settings.hotkeys, ...patch } };
      set({ settings });
      persist(settings);
    },

    setCapability(capability, enabled) {
      const settings = {
        ...get().settings,
        capabilities: { ...get().settings.capabilities, [capability]: enabled },
      };
      set({ settings });
      persist(settings);
    },

    trustTool(name) {
      const current = get().settings;
      if (current.trustedTools.includes(name)) return;
      const settings = { ...current, trustedTools: [...current.trustedTools, name] };
      set({ settings });
      persist(settings);
    },

    untrustTool(name) {
      const current = get().settings;
      const settings = {
        ...current,
        trustedTools: current.trustedTools.filter((t) => t !== name),
      };
      set({ settings });
      persist(settings);
    },

    async setProvider(provider) {
      const spec = providerSpec(provider);
      const key = await loadApiKey(provider);

      const settings: Settings = {
        ...get().settings,
        llm: {
          ...get().settings.llm,
          provider,
          model: spec.defaultModel,
          visionModel: spec.defaultVisionModel,
          baseUrl: spec.baseUrl,
          apiKey: key ?? undefined,
        },
      };
      set({ settings });
      persist(settings);
    },

    async setApiKey(provider, key) {
      await storeApiKey(provider, key);
      // Only reflect it in the live config if it belongs to the active provider.
      if (get().settings.llm.provider === provider) {
        get().updateLLM({ apiKey: key || undefined });
      }
    },

    setAccentHue(hue) {
      applyAccent(hue);
      get().update({ accentHue: clamp(hue, 0, 360) });
    },

    async reset() {
      const settings = defaultSettings();
      applyAccent(settings.accentHue);
      set({ settings });
      await writeRaw(settings);
    },
  };
});
