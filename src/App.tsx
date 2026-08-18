import { Suspense, lazy, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// Exactly one of these ever renders, decided at load. Importing both
// statically shipped the whole Capacitor plugin tree to desktop users and the
// desktop tool set to phones — neither of which can run the other's code.
const DesktopLayout = lazy(() =>
  import('@/components/desktop/DesktopLayout').then((m) => ({ default: m.DesktopLayout })),
);
const MobileLayout = lazy(() =>
  import('@/components/mobile/MobileLayout').then((m) => ({ default: m.MobileLayout })),
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
import { ToastViewport } from '@/components/ui/toast';
import { CommandPalette } from '@/components/shared/CommandPalette';
import { BootSequence } from '@/components/onboarding/BootSequence';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { useTrayState } from '@/hooks/useTrayState';
import { TooltipProvider } from '@/components/ui/primitives';
import { useSettings } from '@/store/settings';
import { useConversation } from '@/store/conversation';
import { useConnection } from '@/store/connection';
import { isMobile, isTauri } from '@/platform';

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

  // `aria --keys` opens straight to the key settings. The flag is read from
  // the process ARIA was launched with, so this only fires on that launch.
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
    if (!isTauri || isMobile) {
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

  // One place to open settings, so a keyboard shortcut and a toast action can
  // both reach it without threading a callback through the tree.
  useEffect(() => {
    const open = () => setSettingsOpen(true);
    window.addEventListener('aria:open-settings', open);
    return () => window.removeEventListener('aria:open-settings', open);
  }, []);

  // Mobile chrome: match the status bar to the app background.
  useEffect(() => {
    if (!isMobile) return;
    void (async () => {
      try {
        const { StatusBar, Style } = await import('@capacitor/status-bar');
        await StatusBar.setStyle({ style: Style.Dark });
        await StatusBar.setBackgroundColor({ color: '#05080d' });
      } catch {
        // Not available on every device; purely cosmetic.
      }
    })();
  }, []);

  // Handle `aria://chat?message=…` deep links and Android share intents.
  useEffect(() => {
    if (!isMobile) return;

    let remove: (() => void) | undefined;
    void (async () => {
      const { App: CapApp } = await import('@capacitor/app');
      const handle = await CapApp.addListener('appUrlOpen', ({ url }) => {
        try {
          const parsed = new URL(url);
          const message = parsed.searchParams.get('message');
          if (message) {
            // Same event the native share/PROCESS_TEXT paths emit, so there is
            // one entry point for "text arrived from outside the app".
            window.dispatchEvent(new CustomEvent('aria:shared-text', { detail: message }));
          }
        } catch {
          // A malformed deep link is not worth crashing over.
        }
      });
      remove = () => void handle.remove();
    })();

    return () => remove?.();
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
        <div className="h-full">
          {/* Sits above everything and clears itself; the app renders behind
              it, so nothing is waiting on the animation. */}
          {booting && !isMobile && <BootSequence onDone={() => setBooting(false)} />}
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
              {isMobile ? (
                <MobileLayout />
              ) : (
                <DesktopLayout onOpenSettings={() => setSettingsOpen(true)} />
              )}
            </Suspense>
          )}

          {/* Desktop settings are modal; mobile has them as a tab. */}
          {settingsOpen && !isMobile && (
            <Suspense fallback={null}>
              <SettingsPanel initialTab={settingsTab} onClose={() => setSettingsOpen(false)} />
            </Suspense>
          )}

          {/* Missing system tools, offered for one-click install. Suppressed
              during the wizard, which reports the same thing in more detail. */}
          {!showWizard && !showModelDownload && <DependencyBanner />}

          {/* Errors and notices land here, never as blocking modals. */}
          <ToastViewport />

          {!isMobile && <CommandPalette onOpenSettings={() => setSettingsOpen(true)} />}
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
