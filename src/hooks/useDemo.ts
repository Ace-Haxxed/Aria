/**
 * The scripted demo behind `nova --demo`.
 *
 * Each prompt goes through the ordinary send path, so what runs is the real
 * agent loop against the real provider with the real tools — the screen really
 * is captured, Firefox really is launched. Nothing here fakes a response, and
 * if a step fails the failure is what gets shown.
 *
 * Steps are sequential and gated on the agent going idle rather than on a
 * timer. A fixed delay would start the next prompt while the previous one was
 * still holding the loop, and the second send would be dropped or interleaved.
 */
import { useEffect, useRef } from 'react';
import { useConversation } from '@/store/conversation';
import { isTauri } from '@/platform';

/** Pause between steps, so each answer can be read before the next begins. */
const STEP_PAUSE_MS = 2_000;
/** Give up waiting on a step that never settles, and move to the next. */
const STEP_TIMEOUT_MS = 120_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve once `predicate` holds for the conversation store, or on timeout.
 * Returns whether the condition was actually met.
 */
function waitFor(
  predicate: (state: ReturnType<typeof useConversation.getState>) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (predicate(useConversation.getState())) return Promise.resolve(true);

  return new Promise((resolve) => {
    let done = false;
    const finish = (met: boolean) => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(met);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    const unsubscribe = useConversation.subscribe((state) => {
      if (predicate(state)) finish(true);
    });
  });
}

/**
 * Run the demo if this process was started with `--demo`.
 *
 * `send` is the same function the composer calls. `ready` gates the start so
 * the first prompt is not sent before a provider is configured.
 */
export function useDemo(send: (text: string) => void, ready: boolean) {
  const started = useRef(false);

  useEffect(() => {
    if (!isTauri || started.current) return;

    // The agent has to be able to reach a model before the first prompt is
    // worth sending, or the demo opens by reporting a missing key. This effect
    // re-runs when `ready` flips, so returning is enough — waiting on a
    // predicate here would read the `ready` captured by this render and never
    // see it change.
    if (!ready) return;

    let cancelled = false;

    void (async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      const script = await invoke<string[] | null>('demo_script').catch(() => null);
      if (!script?.length || cancelled) return;

      // Claim the run before the first await that could let a re-render in.
      started.current = true;

      for (const [index, prompt] of script.entries()) {
        if (cancelled) return;

        // Let the previous answer sit on screen before the next question.
        if (index > 0) await sleep(STEP_PAUSE_MS);
        if (cancelled) return;

        send(prompt);

        // Wait for the turn to actually begin, then for it to finish. Waiting
        // only for "idle" would fall straight through, because the agent is
        // still idle in the moment before it picks the request up.
        await waitFor((s) => s.agentState !== 'idle', 10_000);
        if (cancelled) return;
        await waitFor((s) => s.agentState === 'idle', STEP_TIMEOUT_MS);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [send, ready]);
}
