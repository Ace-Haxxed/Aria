/**
 * Capture of conversation pairs, so a cloud model's answers can train a local
 * one later.
 *
 * The whole point is that the data stays on the machine: this writes to a file
 * under the user's home directory and nothing here ever uploads. Capture is
 * off unless the user turns it on during setup or in Settings.
 */
import { create } from 'zustand';
import { isTauri } from '@/platform';

export interface TrainingStats {
  count: number;
  ratedGood: number;
  ratedBad: number;
  target: number;
  percent: number;
  ready: boolean;
  path: string;
  sizeBytes: number;
}

interface TrainingState {
  stats: TrainingStats | null;
  refresh: () => Promise<void>;
  /** Record one exchange. Silently does nothing when capture is off. */
  capture: (args: {
    /** The assistant message id, reused as the record id so ratings survive a reload. */
    id: string;
    user: string;
    assistant: string;
    model: string;
  }) => Promise<string | null>;
  rate: (id: string, score: 0 | 1, note?: string) => Promise<void>;
  exportTo: (destination: string) => Promise<string>;
  clear: () => Promise<void>;
}

export const useTraining = create<TrainingState>((set, get) => ({
  stats: null,

  async refresh() {
    if (!isTauri) return;
    try {
      const { desktop } = await import('@/platform/desktop');
      set({ stats: await desktop.trainingStats() });
    } catch {
      // The panel simply shows nothing rather than an error: this is a
      // secondary feature and a failed stat read is not worth interrupting for.
      set({ stats: null });
    }
  },

  async capture({ id, user, assistant, model }) {
    if (!isTauri) return null;

    // Read the setting at call time; the user can toggle capture mid-session.
    const { useSettings } = await import('./settings');
    if (!useSettings.getState().settings.trainLocalFromCloud) return null;

    try {
      const { desktop } = await import('@/platform/desktop');
      await desktop.trainingAppend({
        id,
        timestamp: new Date().toISOString(),
        user,
        assistant,
        model_used: model,
        quality_score: null,
      });
      void get().refresh();
      return id;
    } catch {
      // Losing one training example must never surface as an error during a
      // conversation — it is bookkeeping, not the user's task.
      return null;
    }
  },

  async rate(id, score, note) {
    if (!isTauri) return;
    const { desktop } = await import('@/platform/desktop');
    await desktop.trainingRate(id, score, note);
    void get().refresh();
  },

  async exportTo(destination) {
    const { desktop } = await import('@/platform/desktop');
    const path = await desktop.trainingExport(destination);
    void get().refresh();
    return path;
  },

  async clear() {
    const { desktop } = await import('@/platform/desktop');
    await desktop.trainingClear();
    void get().refresh();
  },
}));
