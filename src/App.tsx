import { Suspense, lazy, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// Lazy so it stays out of the entry chunk; this is a desktop-only build,
// so there is no second layout to choose between.
const DesktopLayout = lazy(() =>
  import('@/components/desktop/DesktopLayout').then((m) => ({ default: m.DesktopLayout })),
);
// Neither is needed to paint the first screen — settings is behind a click,
// and first run only ever opens once. Loading them lazily keeps them out of
// the entry chunk and off the startup path.
const SettingsPanel = lazy(() =>
  import('@/components/Settings/SettingsPanel').then((m) => ({ default: m.SettingsPanel })),
);
const FirstRun = lazy(() =>
  import('@/components/onboarding/FirstRun').then((m) => ({ default: m.FirstRun })),
);
const ModelDownload = lazy(() =>
  import('@/components/onboarding/ModelDownload').then((m) => ({ default: m.ModelDownload })),
);
import { DependencyBanner } from '@/components/shared/DependencyBanner';
import { SpaceBackground } from '@/components/shared/SpaceBackground';
import { ToastViewport } from '@/components/ui/toast';
import { CommandPalette } from '@/components/shared/CommandPalette';
import { BootSequence } from '@/components/onboarding/BootSequence';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { useTrayState } from '@/hooks/useTrayState';
import { TooltipProvider } from '@/components/ui/primitives';
import { useSettings } from '@/store/settings';
import { useConversation } from '@/store/conversation';
import { useConnection } from '@/store/connection';
import { isTauri } from '@/platform';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Everything here is local; refetching on focus buys nothing.
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30_000,
    },
  },
});

export default function App() {
  const loaded = useSettings((s) => s.loaded);
  const load = useSettings((s) => s.load);
  const setupComplete = useSettings((s) => s.settings.setupComplete);
  const initConversations = useConversation((s) => s.init);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('general');
  const [wizardDismissed, setWizardDismissed] = useState(false);
  /**
   * Whether the built-in model still needs fetching.
   * `null` while unknown — the screen must not flash for users who already
   * have it, which is everyone after the first launch.
   */
  const [needsModel, setNeedsModel] = useState<boolean | null>(null);
  /** The start-up sequence, shown once per launch while subsystems report in. */
  const [booting, setBooting] = useState(true);

  useWindowTitle();
  useTrayState();

  // Settings must be loaded before anything can render — the LLM config, the
  // capability toggles and the accent hue all come from there.
  useEffect(() => {
    void load();
  }, [load]);

  // `nova --keys` opens straight to the key settings. The flag is read from
  // the process NOVA was launched with, so this only fires on that launch.
  useEffect(() => {
    if (!isTauri) return;
    void (async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      const wanted = await invoke<boolean>('open_keys_requested').catch(() => false);
      if (wanted) {
        // Skip the boot sequence too: the point of the flag is to get to the
        // key field, not to watch subsystems report in first.
        setBooting(false);
        setSettingsTab('keys');
        setSettingsOpen(true);
      }
    })();
  }, []);

  // Conversation history is not needed to paint an empty transcript, so it is
  // fetched after the first frame rather than blocking it.
  useEffect(() => {
    if (!loaded) return;
    const handle = requestAnimationFrame(() => void initConversations());
    return () => cancelAnimationFrame(handle);
  }, [loaded, initConversations]);

  // Does the built-in model need downloading? Asked once, before the wizard,
  // because everything downstream depends on having a backend at all.
  useEffect(() => {
    if (!loaded) return;
    if (!isTauri) {
      setNeedsModel(false);
      return;
    }
    void import('@/platform/desktop')
      .then((m) => m.desktop.builtinStatus())
      .then((status) => setNeedsModel(!status.downloaded && !status.loaded))
      .catch(() => setNeedsModel(false));
  }, [loaded]);

  // Reach for a model in the background once setup is done. Deliberately not
  // awaited anywhere: the window must be interactive immediately, and the
  // status bar fills in whenever the answer arrives.
  useEffect(() => {
    if (loaded && setupComplete) void useConnection.getState().check();
  }, [loaded, setupComplete]);

  // Re-apply the saved microphone. Rust holds this in memory, so a device
  // chosen in a previous session is otherwise forgotten at every launch.
  useEffect(() => {
    if (!loaded || !isTauri) return;
    const name = useSettings.getState().settings.voice.inputDevice;
    if (!name) return;
    void import('@/platform/desktop').then((m) => m.desktop.setInputDevice(name));
  }, [loaded]);

  // Settle the OpenRouter model against the live catalogue. OpenRouter
  // withdraws free models without notice, so a saved id can stop existing
  // between one launch and the next; Rust re-picks one when that happens.
  //
  // Fired after the first frame and never awaited — it is a network round trip,
  // and the first message must not queue behind it. Whatever is already saved
  // stays usable until this returns something different.
  useEffect(() => {
    if (!loaded || !isTauri) return;
    const handle = requestAnimationFrame(() => {
      void import('@/store/keys').then((m) => m.useKeys.getState().reconcileOpenRouterModel());
    });
    return () => cancelAnimationFrame(handle);
  }, [loaded]);

  // One place to open settings, so a keyboard shortcut and a toast action can
  // both reach it without threading a callback through the tree.
  useEffect(() => {
    const open = () => setSettingsOpen(true);
    window.addEventListener('nova:open-settings', open);
    return () => window.removeEventListener('nova:open-settings', open);
  }, []);

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
      </div>
    );
  }

  // The model download comes first: the wizard's AI check is meaningless
  // without a backend, and the download is the longest step in setup.
  const showModelDownload = needsModel === true && !setupComplete && !wizardDismissed;
  const showWizard = !showModelDownload && !setupComplete && !wizardDismissed;

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        {/* Behind everything, outside the app tree's stacking context so no
            component has to leave room for it. */}
        <SpaceBackground />
        <div className="relative z-10 h-full">
          {/* Sits above everything and clears itself; the app renders behind
              it, so nothing is waiting on the animation. */}
          {booting && <BootSequence onDone={() => setBooting(false)} />}
          {showModelDownload ? (
            <Suspense fallback={<div className="fixed inset-0 bg-background" />}>
              <ModelDownload
                onReady={() => setNeedsModel(false)}
                onSkip={() => setNeedsModel(false)}
              />
            </Suspense>
          ) : showWizard ? (
            <Suspense fallback={<div className="fixed inset-0 bg-background" />}>
              <FirstRun onComplete={() => setWizardDismissed(true)} />
            </Suspense>
          ) : (
            <Suspense fallback={<div className="h-full bg-background" />}>
              <DesktopLayout onOpenSettings={() => setSettingsOpen(true)} />
            </Suspense>
          )}

          {/* Settings are modal. */}
          {settingsOpen && (
            <Suspense fallback={null}>
              <SettingsPanel initialTab={settingsTab} onClose={() => setSettingsOpen(false)} />
            </Suspense>
          )}

          {/* Missing system tools, offered for one-click install. Suppressed
              during the wizard, which reports the same thing in more detail. */}
          {!showWizard && !showModelDownload && <DependencyBanner />}

          {/* Errors and notices land here, never as blocking modals. */}
          <ToastViewport />

          <CommandPalette onOpenSettings={() => setSettingsOpen(true)} />
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

/** Start minimised, if the user asked for that and we are in the Tauri shell. */
export async function applyStartupWindowState(): Promise<void> {
  if (!isTauri) return;
  try {
    const { useSettings: store } = await import('@/store/settings');
    if (!store.getState().settings.startMinimized) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().hide();
  } catch {
    // Non-fatal: worst case the window is visible when it need not be.
  }
}
