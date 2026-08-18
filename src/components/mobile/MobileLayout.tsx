import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronUp } from 'lucide-react';
import { Orb, STATE_LABEL } from '@/components/shared/Orb';
import { Message } from '@/components/shared/Message';
import { VoiceInput } from '@/components/shared/VoiceInput';
import { BottomNav, type MobileTab } from './BottomNav';
import { CameraView } from './CameraView';
import { SwipeHistory } from './SwipeHistory';
import { MobileFiles } from './MobileFiles';
import { MobileSkills } from './MobileSkills';
import { SettingsPanel } from '@/components/Settings/SettingsPanel';
import { useAgent } from '@/hooks/useAgent';
import { useVoice } from '@/hooks/useVoice';
import { useWakeWord } from '@/hooks/useWakeWord';
import { useConversation } from '@/store/conversation';

export function MobileLayout() {
  const [tab, setTab] = useState<MobileTab>('chat');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);

  const conversation = useConversation((s) => s.current);
  const agentState = useConversation((s) => s.agentState);
  const streaming = useConversation((s) => s.streaming);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sendRef = useRef<(text: string, images?: string[]) => void>(() => {});

  const voice = useVoice(
    useCallback((text: string) => {
      sendRef.current(text);
    }, []),
  );

  const agent = useAgent(voice.speak, voice.speakSentence);
  useEffect(() => {
    sendRef.current = (text, images) => void agent.send(text, images);
  }, [agent]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [conversation.messages.length, streaming?.text]);

  // Once there is a conversation, default to showing it rather than the orb.
  useEffect(() => {
    if (conversation.messages.length > 0) setShowTranscript(true);
  }, [conversation.messages.length]);

  useWakeWord(
    useCallback(() => {
      setTab('chat');
      void voice.startListening();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  // Native entry points: the share sheet, PROCESS_TEXT, deep links, the home
  // screen widget, the quick settings tile and Siri shortcuts all land here.
  useEffect(() => {
    const onSharedText = (event: Event) => {
      const text = (event as CustomEvent<string>).detail;
      if (!text) return;
      setTab('chat');
      setShowTranscript(true);
      sendRef.current(text);
    };

    const onStartListening = () => {
      setTab('chat');
      void voice.startListening();
    };

    window.addEventListener('aria:shared-text', onSharedText);
    window.addEventListener('aria:start-listening', onStartListening);
    return () => {
      window.removeEventListener('aria:shared-text', onSharedText);
      window.removeEventListener('aria:start-listening', onStartListening);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swiping down anywhere dismisses the on-screen keyboard.
  const dismissKeyboard = useCallback(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    void import('@capacitor/keyboard')
      .then(({ Keyboard }) => Keyboard.hide())
      .catch(() => {});
  }, []);

  return (
    <div
      className="flex h-full flex-col bg-background"
      style={{ paddingTop: 'var(--safe-top)' }}
    >
      <div className="relative min-h-0 flex-1">
        {tab === 'chat' && (
          <motion.div
            className="flex h-full flex-col"
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={0.2}
            onDragEnd={(_, info) => {
              if (info.offset.y < -80) setHistoryOpen(true);
              if (info.offset.y > 80) dismissKeyboard();
            }}
          >
            {showTranscript ? (
              <>
                <div className="flex items-center justify-center gap-3 border-b border-border/40 py-3">
                  <Orb
                    state={agentState}
                    level={voice.level}
                    spectrum={voice.spectrum}
                    size={64}
                    onClick={() => setShowTranscript(false)}
                  />
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    {STATE_LABEL[agentState]}
                  </div>
                </div>

                <div ref={scrollRef} className="aria-scroll min-h-0 flex-1 overflow-y-auto">
                  <div className="space-y-4 px-4 py-4">
                    {conversation.messages.map((message) => (
                      <Message
                        key={message.id}
                        message={message}
                        streamingText={
                          streaming?.id === message.id ? streaming.text : undefined
                        }
                      />
                    ))}
                    {streaming &&
                      !conversation.messages.some((m) => m.id === streaming.id) && (
                        <Message
                          message={{
                            id: streaming.id,
                            role: 'assistant',
                            content: '',
                            timestamp: Date.now(),
                          }}
                          streamingText={streaming.text}
                        />
                      )}
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-8 px-8">
                <Orb
                  state={agentState}
                  level={voice.level}
                  spectrum={voice.spectrum}
                  size={280}
                  // Tap types, hold talks — as the spec describes.
                  onClick={() => setShowTranscript(true)}
                  onPointerDown={() => void voice.startListening()}
                  onPointerUp={() => void voice.stopListening()}
                />
                <div className="text-center">
                  <div className="text-sm font-semibold uppercase tracking-wider text-primary">
                    {STATE_LABEL[agentState]}
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Hold the orb to speak, tap it to type.
                  </p>
                </div>

                <button
                  onClick={() => setHistoryOpen(true)}
                  className="flex items-center gap-1 text-xs text-muted-foreground"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                  Swipe up for history
                </button>
              </div>
            )}

            {voice.error && (
              <div className="mx-4 mb-2 rounded-lg border border-risk-medium/40 bg-risk-medium/10 px-3 py-2 text-xs text-risk-medium">
                {voice.error}
              </div>
            )}

            <div className="border-t border-border/40 bg-card/30 px-4 py-3">
              <VoiceInput
                onSend={(text) => void agent.send(text)}
                onMicDown={() => void voice.startListening()}
                onMicUp={() => void voice.stopListening()}
                listening={voice.listening}
                level={voice.level}
                busy={agent.busy}
                onCancel={agent.cancel}
              />
            </div>
          </motion.div>
        )}

        {tab === 'skills' && (
          <div className="aria-scroll h-full overflow-y-auto">
            <MobileSkills
              onRun={(prompt) => {
                setTab('chat');
                setShowTranscript(true);
                void agent.send(prompt);
              }}
            />
            <CameraView
              onAnalyse={(question, image) => {
                setTab('chat');
                setShowTranscript(true);
                void agent.send(question, [image]);
              }}
            />
          </div>
        )}

        {tab === 'files' && (
          <div className="aria-scroll h-full overflow-y-auto">
            <MobileFiles />
          </div>
        )}

        {tab === 'settings' && (
          <div className="aria-scroll h-full overflow-y-auto">
            <SettingsPanel embedded />
          </div>
        )}
      </div>

      <BottomNav active={tab} onChange={setTab} />
      <SwipeHistory open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </div>
  );
}
