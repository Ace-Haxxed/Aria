/**
 * Global hotkeys and tray events.
 *
 * Registration lives in Rust (the OS needs a system-wide grab); this hook keeps
 * it in sync with settings and routes the resulting events to app actions.
 */
import { useEffect } from 'react';
import { isTauri } from '@/platform';
import { useSettings } from '@/store/settings';
import { humanise, toast } from '@/store/toasts';

/** Names the user recognises, for messages about a failed shortcut. */
const LABELS: Record<string, string> = {
  toggleWindow: 'show/hide window',
  pushToTalk: 'push to talk',
  screenshotAsk: 'ask about screen',
  cancel: 'cancel',
};

export interface HotkeyHandlers {
  toggleWindow: () => void;
  pushToTalk: () => void;
  screenshotAsk: () => void;
  cancel: () => void;
  openSettings?: () => void;
  toggleMute?: () => void;
}

export function useHotkeys(handlers: HotkeyHandlers) {
  const hotkeys = useSettings((s) => s.settings.hotkeys);

  // (Re-)register whenever the bindings change.
  useEffect(() => {
    if (!isTauri) return;

    let cancelled = false;
    void (async () => {
      const { desktop } = await import('@/platform/desktop');
      try {
        const outcomes = await desktop.registerHotkeys([
          ['toggleWindow', hotkeys.toggleWindow],
          ['pushToTalk', hotkeys.pushToTalk],
          ['screenshotAsk', hotkeys.screenshotAsk],
          // Escape is handled in the window itself; grabbing it globally would
          // steal the key from every other application.
        ]);
        if (cancelled) return;

        const failed = outcomes.filter((o) => !o.registered);
        const substituted = outcomes.filter((o) => o.registered && o.accelerator !== o.requested);

        // A fallback took: the action works, just on a different key. Worth
        // saying once, quietly, because the user pressing their original
        // combination would otherwise get nothing with no explanation.
        if (substituted.length > 0) {
          toast.info(
            substituted.length === 1
              ? `${LABELS[substituted[0].action] ?? substituted[0].action} moved to ${substituted[0].accelerator}`
              : `${substituted.length} shortcuts moved to other keys`,
            substituted
              .map((o) => `${o.requested} was taken, using ${o.accelerator}`)
              .join('. '),
          );
        }

        // Nothing worked for these, including every fallback. Name them —
        // "some shortcuts failed" is not something anyone can act on.
        if (failed.length > 0) {
          toast.error(
            failed.length === 1
              ? `The ${LABELS[failed[0].action] ?? failed[0].action} shortcut is unavailable`
              : `${failed.length} shortcuts are unavailable`,
            `${failed
              .map((o) => `${LABELS[o.action] ?? o.action} (${o.requested})`)
              .join(', ')} — another application already owns them. Pick different keys in Settings.`,
            {
              label: 'Change shortcuts',
              run: () => {
                window.dispatchEvent(new CustomEvent('nova:open-settings'));
              },
            },
          );
        }
      } catch (e) {
        // The command itself failed, rather than an individual shortcut.
        if (!cancelled) {
          toast.error('Keyboard shortcuts could not be set up', humanise(e), {
            label: 'Change shortcuts',
            run: () => {
              window.dispatchEvent(new CustomEvent('nova:open-settings'));
            },
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hotkeys.toggleWindow, hotkeys.pushToTalk, hotkeys.screenshotAsk]);

  // Listen for the events Rust emits when a hotkey fires.
  useEffect(() => {
    if (!isTauri) return;

    let unlistenHotkey: (() => void) | undefined;
    let unlistenTray: (() => void) | undefined;

    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');

      unlistenHotkey = await listen<string>('nova://hotkey', (event) => {
        switch (event.payload) {
          case 'toggleWindow':
            handlers.toggleWindow();
            break;
          case 'pushToTalk':
            handlers.pushToTalk();
            break;
          case 'screenshotAsk':
            handlers.screenshotAsk();
            break;
          case 'cancel':
            handlers.cancel();
            break;
        }
      });

      unlistenTray = await listen<string>('nova://tray', (event) => {
        if (event.payload === 'settings') handlers.openSettings?.();
        if (event.payload === 'mute') handlers.toggleMute?.();
      });
    })();

    return () => {
      unlistenHotkey?.();
      unlistenTray?.();
    };
    // Handlers are stable enough in practice; re-subscribing on every render
    // would tear down and rebuild the native listener constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape cancels the running action, in-window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handlers.cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
