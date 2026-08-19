import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { Orb, STATE_LABEL } from '@/components/shared/Orb';
import { MessageList, ThinkingSkeleton } from '@/components/shared/MessageList';
import { StatusBar } from '@/components/shared/StatusBar';
import { Hint } from '@/components/onboarding/Hint';
import { VoiceInput } from '@/components/shared/VoiceInput';
import { Sidebar } from './Sidebar';
import { ActionLog } from './ActionLog';
import { ScreenPreview } from './ScreenPreview';
import { TitleBar } from './TitleBar';
import { useAgent } from '@/hooks/useAgent';
import { useDemo } from '@/hooks/useDemo';
import { useVoice } from '@/hooks/useVoice';
import { useHotkeys } from '@/hooks/useHotkeys';
import { useWakeWord } from '@/hooks/useWakeWord';
import { useConversation } from '@/store/conversation';
import { useSettings } from '@/store/settings';
import { isTauri } from '@/platform';
import { humanise, toast } from '@/store/toasts';

interface DesktopLayoutProps {
  onOpenSettings: () => void;
}

export function DesktopLayout({ onOpenSettings }: DesktopLayoutProps) {
  const conversation = useConversation((s) => s.current);
  const agentState = useConversation((s) => s.agentState);
  const streaming = useConversation((s) => s.streaming);
  const autoSpeak = useSettings((s) => s.settings.voice.autoSpeak);
  const updateVoice = useSettings((s) => s.updateVoice);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  /** The latest transcript, handed to the composer to show then auto-send. */
  const [transcript, setTranscript] = useState<{ text: string; at: number } | null>(null);

  const voice = useVoice(
    useCallback((text: string) => {
      // "Goodbye NOVA" dismisses rather than being sent as a question. A
      // wake word needs a matching way out, or the only way to stop talking to
      // NOVA is to reach for the mouse.
      const settings = useSettings.getState().settings;
      if (settings.goodbyeMinimizes && /\bgood ?bye,? nova\b/i.test(text)) {
        if (isTauri) void import('@/platform/desktop').then((m) => m.desktop.toggleWindow());
        return;
      }
      // Shown in the composer and sent a second later, rather than fired off
      // the instant whisper returns — a misheard word is then a keystroke to
      // fix instead of a message already sent.
      setTranscript({ text, at: Date.now() });
    }, []),
  );

  const agent = useAgent(voice.speak, voice.speakSentence);

  // `nova --demo` drives the same send path a typed message uses, so the demo
  // exercises the real agent loop rather than a parallel one that could drift
  // out of sync with it.
  const demoSend = useCallback((text: string) => void agent.send(text), [agent]);
  useDemo(demoSend, agent.ready);

  // Voice problems are reported as a toast rather than an inline strip: they
  // are transient, and a permanent red block above the composer reads as a
  // broken app long after the problem has passed.
  const reportedVoiceError = useRef<string | null>(null);
  useEffect(() => {
    if (!voice.error || voice.error === reportedVoiceError.current) return;
    reportedVoiceError.current = voice.error;
    toast.error('Microphone trouble', humanise(voice.error));
  }, [voice.error]);

  // Follow the conversation as it grows — but only while the user is already
  // at the bottom. Yanking the view back down while they are reading something
  // further up is the single most irritating thing a chat UI can do.
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      // A small tolerance: sub-pixel layout and smooth scrolling mean the
      // bottom is rarely reached exactly.
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setPinned(distance < 80);
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!pinned) return;
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [conversation.messages.length, streaming?.text, pinned]);

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setPinned(true);
  }, []);

  const askAboutScreen = useCallback(async () => {
    if (!isTauri) return;
    const { desktop } = await import('@/platform/desktop');
    try {
      const image = await desktop.screenshot();
      await agent.send('What is on my screen right now?', [image]);
    } catch (e) {
      toast.error('Could not capture the screen', humanise(e), {
        label: 'Open settings',
        run: onOpenSettings,
      });
    }
  }, [agent]);

  // Escape sends the window back to the tray, matching the spoken dismissal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!useSettings.getState().settings.goodbyeMinimizes) return;
      // Not while the user is in a field or a dialog is open — Escape means
      // "close this" there, and hiding the window would lose their work.
      const active = document.activeElement;
      const typing =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      if (typing || document.querySelector('[role="dialog"]')) return;

      if (isTauri) void import('@/platform/desktop').then((m) => m.desktop.toggleWindow());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useHotkeys({
    toggleWindow: () => {
      if (isTauri) void import('@/platform/desktop').then((m) => m.desktop.toggleWindow());
    },
    pushToTalk: () => voice.toggleListening(),
    screenshotAsk: () => void askAboutScreen(),
    cancel: () => agent.cancel(),
    openSettings: onOpenSettings,
    toggleMute: () => updateVoice({ autoSpeak: !autoSpeak }),
  });

  // Wake word: bring the window forward and take one hands-free request.
  //
  // Read through a ref rather than closed over. The handler is registered once
  // with an empty dependency list, so capturing `voice` directly would pin the
  // first render's copy — whose `listening` is permanently false, so it would
  // happily open a second recording on top of one already running.
  const voiceRef = useRef(voice);
  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);

  const wake = useCallback(() => {
    if (isTauri) void import('@/platform/desktop').then((m) => m.desktop.showWindow());
    // `listenOnce`, not `startListening`: there is no button release coming,
    // so the take has to end itself or the request never reaches the model.
    void voiceRef.current.listenOnce();
  }, []);

  const wakeState = useWakeWord(wake);

  // A wake word that is enabled but has no recorded template listens for
  // nothing and says nothing. Point at the one screen that can fix it, rather
  // than leaving the user to conclude the feature is broken.
  const reportedWakeIssue = useRef<string | null>(null);
  useEffect(() => {
    const issue = wakeState.error ?? (wakeState.needsTraining ? 'untrained' : null);
    if (!issue || issue === reportedWakeIssue.current) return;
    reportedWakeIssue.current = issue;

    if (wakeState.needsTraining && !wakeState.error) {
      toast.info('Wake word needs a voice sample', 'Record one in Settings → Voice.', {
        label: 'Open settings',
        run: onOpenSettings,
      });
      return;
    }
    toast.error('Wake word listener stopped', humanise(wakeState.error));
  }, [wakeState.error, wakeState.needsTraining, onOpenSettings]);

  const handleQuickAction = (prompt: string) => {
    // Prompts ending in a space are meant to be completed by the user.
    if (prompt.endsWith(' ')) {
      setPendingPrompt(prompt);
      return;
    }
    void agent.send(prompt);
  };

  const empty = conversation.messages.length === 0;

  return (
    <div className="flex h-full flex-col">
      <TitleBar onOpenSettings={onOpenSettings} />

      <div className="flex min-h-0 flex-1">
        <Hint id="history" text="Your conversation history lives here" placement="right" delayMs={500}>
          <Sidebar
            onQuickAction={handleQuickAction}
            collapsed={sidebarCollapsed}
            onCollapse={() => setSidebarCollapsed(true)}
          />
        </Hint>

        {/* The only way back once the panel is at zero width. A full-height
            rail rather than a floating button, so it cannot end up over the
            transcript. */}
        {sidebarCollapsed && (
          <button
            onClick={() => setSidebarCollapsed(false)}
            aria-label="Expand sidebar"
            className="flex w-6 shrink-0 items-center justify-center text-muted-foreground
              transition-colors duration-150 hover:text-primary"
            style={{ borderRight: '1px solid var(--border-subtle)' }}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}

        <main className="relative flex min-w-0 flex-1 flex-col">
          {empty ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8">
              <Hint id="talk" text={'Say "Hey NOVA" or tap here to talk'} placement="right">
                <Orb
                  state={agentState}
                  level={voice.level}
                  spectrum={voice.spectrum}
                  size={72}
                  onClick={() => voice.toggleListening()}
                />
              </Hint>
              <div className="text-center">
                <h1 className="text-lg font-semibold tracking-wide">
                  {STATE_LABEL[agentState]}
                </h1>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  Ask me to find something, change a setting, drive your browser, or take care
                  of a file. Click the orb to speak.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div ref={scrollRef} className="nova-scroll relative min-h-0 flex-1 overflow-y-auto">
                <MessageList
                  messages={conversation.messages}
                  streaming={streaming}
                  scrollRef={scrollRef}
                />
                {/* Waiting on the first token: show the shape of a reply
                    rather than an empty gap under the user's message. */}
                {agentState === 'thinking' && !streaming && <ThinkingSkeleton />}
              </div>

              <AnimatePresence>
                {!pinned && (
                  <motion.button
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 8 }}
                    transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                    onClick={jumpToBottom}
                    className="absolute bottom-28 left-1/2 z-10 -translate-x-1/2 rounded-full border
                      border-border bg-card/95 px-3 py-1.5 text-xs shadow-lg backdrop-blur
                      transition-transform hover:border-primary/50 active:scale-95"
                  >
                    Jump to latest
                  </motion.button>
                )}
              </AnimatePresence>
            </>
          )}

          {/* Floating rather than a docked bar: the transcript scrolls behind
              it, so the composer reads as sitting above the conversation
              instead of cutting it off. */}
          <div className="px-6 pb-4 pt-2">
            <div className="mx-auto w-full max-w-[800px]">
              <VoiceInput
                onSend={(text, images) => void agent.send(text, images)}
                lastUserMessage={
                  [...conversation.messages].reverse().find((m) => m.role === 'user')?.content
                }
                onMicToggle={() => voice.toggleListening()}
                seed={transcript}
                listening={voice.listening}
                level={voice.level}
                busy={agent.busy}
                onCancel={agent.cancel}
              />
              {pendingPrompt && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Finish this prompt in the box above:{' '}
                  <span className="font-mono text-foreground">{pendingPrompt}</span>
                </p>
              )}
            </div>
          </div>

          <div className="mx-auto w-full max-w-[800px] px-6 pb-2">
            <StatusBar onOpenSettings={onOpenSettings} />
          </div>

          <ScreenPreview />
        </main>

        <Hint id="actions" text="Watch what NOVA is doing in real time" placement="left" delayMs={1000}>
          <ActionLog />
        </Hint>
      </div>
    </div>
  );
}
