/**
 * Whether ARIA can currently reach a model, and getting it there if not.
 *
 * Runs in the background on every launch and never blocks: the window is
 * interactive immediately and the status line fills in when the answer
 * arrives. A local server can take several seconds to start, and making
 * someone watch a spinner for that is the difference between an app that feels
 * instant and one that does not.
 *
 * While disconnected it keeps trying. A user who starts Ollama in a terminal
 * should not also have to come back and press a button here.
 */
import { create } from 'zustand';
import { providerSpec } from '@/core/llm';
import { isTauri } from '@/platform';
import { useSettings } from './settings';

export type ConnectionPhase = 'idle' | 'connecting' | 'ready' | 'failed';

interface ConnectionState {
  phase: ConnectionPhase;
  /** Model currently serving requests, for the status line. */
  model: string;
  /** Provider currently serving requests. */
  provider: string;
  /** Plain-language reason, only when `phase` is `failed`. */
  problem: string;
  /** Every model the local server reports, for the model picker. */
  localModels: string[];
  latencyMs: number;

  check: () => Promise<void>;
  /** Begin retrying in the background until connected. Safe to call twice. */
  watch: () => void;
  stopWatching: () => void;
}

/** How often to retry while disconnected. */
const RECONNECT_INTERVAL_MS = 10_000;

let reconnectTimer: number | null = null;

export const useConnection = create<ConnectionState>((set, get) => ({
  phase: 'idle',
  model: '',
  provider: '',
  problem: '',
  localModels: [],
  latencyMs: 0,

  async check() {
    if (get().phase === 'connecting') return;

    const settings = useSettings.getState().settings;
    const llm = settings.llm;
    const spec = providerSpec(llm.provider);

    set({ phase: 'connecting', problem: '' });

    if (llm.provider !== 'ollama') {
      const hasKey = !spec.needsApiKey || Boolean(llm.apiKey);
      if (!hasKey) {
        set({
          phase: 'failed',
          model: '',
          provider: llm.provider,
          problem: `${spec.label.split(' (')[0]} needs an API key.`,
        });
        get().watch();
        return;
      }
      set({
        phase: 'ready',
        model: llm.model,
        provider: llm.provider,
        problem: '',
        latencyMs: 0,
      });
      get().stopWatching();
      return;
    }

    if (!isTauri) {
      set({ phase: 'ready', model: llm.model, provider: llm.provider, problem: '' });
      return;
    }

    try {
      const { desktop } = await import('@/platform/desktop');
      // Starts the server if it is installed but stopped, and returns as soon
      // as it answers rather than waiting out the full window.
      const status = await desktop.checkOllamaAndStart(llm.baseUrl || undefined);

      if (status.running && status.models.length > 0) {
        // The model list is whatever is actually installed — never a
        // hardcoded name that may not exist on this machine.
        const installed = status.models.find(
          (m) => m === llm.model || m.startsWith(`${llm.model}:`) || m.startsWith(llm.model),
        );
        const model = installed ?? status.preferred ?? status.models[0];

        set({
          phase: 'ready',
          model,
          provider: 'ollama',
          localModels: status.models,
          latencyMs: status.latencyMs,
          problem: '',
        });
        get().stopWatching();

        // Load the weights now rather than on the first message. Ollama
        // unloads after a few minutes idle, and the reload it then performs is
        // several seconds the user experiences as ARIA being slow.
        if (settings.modelWarmup) {
          void desktop.warmupModel(model, llm.baseUrl || undefined).catch(() => {});
        }
        return;
      }

      set({
        phase: 'failed',
        model: '',
        provider: 'ollama',
        localModels: status.models,
        problem: !status.installed
          ? 'Ollama is not installed'
          : status.running
            ? 'Ollama has no models installed'
            : 'Ollama offline',
      });
      get().watch();
    } catch {
      set({ phase: 'failed', model: '', provider: 'ollama', problem: 'Ollama offline' });
      get().watch();
    }
  },

  watch() {
    if (reconnectTimer != null) return;
    reconnectTimer = window.setInterval(() => {
      // Only while still down; `check` clears the timer once it succeeds.
      if (get().phase === 'failed') void get().check();
    }, RECONNECT_INTERVAL_MS);
  },

  stopWatching() {
    if (reconnectTimer == null) return;
    window.clearInterval(reconnectTimer);
    reconnectTimer = null;
  },
}));
