/**
 * Wake-word configuration, including recording the template it matches on.
 *
 * The listener compares audio to a recording of the user's own voice rather
 * than a shipped model, so training is not an optional extra — nothing works
 * until it has heard the word once. That makes it the most important control
 * here, and it is placed accordingly.
 */
import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, Check, Loader2, Mic } from 'lucide-react';
import type { WakeWordStatus } from '@/platform/desktop';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label, Slider, Switch } from '@/components/ui/primitives';
import { useSettings } from '@/store/settings';
import { isTauri } from '@/platform';
import { humanise, toast } from '@/store/toasts';
import { cn } from '@/lib/utils';

type Phase = 'idle' | 'recording' | 'saved' | 'failed';

export function WakeWordSettings() {
  const voice = useSettings((s) => s.settings.voice);
  const updateVoice = useSettings((s) => s.updateVoice);
  const [status, setStatus] = useState<WakeWordStatus | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [problem, setProblem] = useState('');

  const refresh = useCallback(async () => {
    if (!isTauri) return;
    try {
      const { desktop } = await import('@/platform/desktop');
      setStatus(await desktop.wakeWordStatus(voice.wakeWord));
    } catch {
      setStatus(null);
    }
  }, [voice.wakeWord]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const train = async (replace: boolean) => {
    setPhase('recording');
    setProblem('');
    try {
      const { desktop } = await import('@/platform/desktop');
      const result = await desktop.trainWakeWord(voice.wakeWord, replace);
      setStatus(result);
      setPhase('saved');
      setTimeout(() => setPhase('idle'), 2_500);
      toast.success(
        `"${voice.wakeWord}" learned`,
        `${result.templates} recording${result.templates === 1 ? '' : 's'} saved. More recordings improve accuracy.`,
      );
    } catch (e) {
      setPhase('failed');
      setProblem(humanise(e));
    }
  };

  const trained = status?.trained ?? false;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">Wake word</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Listen for a trigger phrase, even when ARIA is in the tray. Runs entirely on this
            machine.
          </p>
        </div>
        <Switch
          checked={voice.wakeWordEnabled}
          onCheckedChange={(v) => updateVoice({ wakeWordEnabled: v })}
        />
      </div>

      <AnimatePresence>
        {voice.wakeWordEnabled && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-4 pt-1">
              <div className="space-y-2">
                <Label htmlFor="wakeword">Trigger phrase</Label>
                <Input
                  id="wakeword"
                  value={voice.wakeWord}
                  onChange={(e) => updateVoice({ wakeWord: e.target.value })}
                  placeholder="aria"
                />
                <p className="text-xs text-muted-foreground">
                  Short and distinctive works best. A phrase that sounds like a common word will
                  trigger by accident.
                </p>
              </div>

              {/* Training is required, so it is stated as a status rather than
                  buried as an optional action. */}
              <div
                className={cn(
                  'space-y-2 rounded-xl border p-3',
                  trained ? 'border-aria-acting/40 bg-aria-acting/5' : 'border-risk-medium/40 bg-risk-medium/5',
                )}
              >
                <div className="flex items-center gap-2 text-sm">
                  {trained ? (
                    <>
                      <Check className="h-4 w-4 shrink-0 text-aria-acting" />
                      <span>
                        Ready — {status?.templates} recording{status?.templates === 1 ? '' : 's'} of
                        your voice
                      </span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="h-4 w-4 shrink-0 text-risk-medium" />
                      <span>ARIA needs to hear you say it once</span>
                    </>
                  )}
                </div>

                <p className="text-xs leading-relaxed text-muted-foreground">
                  {trained
                    ? 'Add another recording if it misses you sometimes — different tones and distances help.'
                    : `Press record, then say "${voice.wakeWord}" clearly. This is matched against your own voice and never leaves the machine.`}
                </p>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => void train(!trained)}
                    disabled={phase === 'recording'}
                    className="gap-1.5"
                  >
                    {phase === 'recording' ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Say it now…
                      </>
                    ) : phase === 'saved' ? (
                      <>
                        <Check className="h-3.5 w-3.5" />
                        Saved
                      </>
                    ) : (
                      <>
                        <Mic className="h-3.5 w-3.5" />
                        {trained ? 'Add another recording' : 'Record wake word'}
                      </>
                    )}
                  </Button>

                  {trained && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void train(true)}
                      disabled={phase === 'recording'}
                      className="text-xs"
                    >
                      Start over
                    </Button>
                  )}
                </div>

                {problem && <p className="text-xs leading-relaxed text-risk-high">{problem}</p>}
              </div>

              <div className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <Label>Sensitivity</Label>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {voice.wakeWordSensitivity} / 10
                  </span>
                </div>
                <Slider
                  value={[voice.wakeWordSensitivity]}
                  min={1}
                  max={10}
                  step={1}
                  onValueChange={([v]) => {
                    updateVoice({ wakeWordSensitivity: v });
                    if (isTauri) {
                      void import('@/platform/desktop').then((m) =>
                        m.desktop.setWakeWordSensitivity(v).catch(() => {}),
                      );
                    }
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Higher catches more attempts but starts accepting similar-sounding words. Lower
                  is stricter.
                </p>
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium">Activation sound</div>
                  <div className="text-xs text-muted-foreground">
                    A short chime when the wake word is heard
                  </div>
                </div>
                <Switch
                  checked={voice.activationSound}
                  onCheckedChange={(v) => updateVoice({ activationSound: v })}
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="border-t border-border/60 pt-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium">Stop when you stop talking</div>
            <div className="text-xs text-muted-foreground">
              Send automatically after a pause, instead of waiting for the button
            </div>
          </div>
          <Switch
            checked={voice.autoStopOnSilence}
            onCheckedChange={(v) => updateVoice({ autoStopOnSilence: v })}
          />
        </div>

        {voice.autoStopOnSilence && (
          <div className="mt-3 space-y-2">
            <div className="flex items-baseline justify-between">
              <Label>Pause before sending</Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {(voice.silenceTimeoutMs / 1000).toFixed(1)}s
              </span>
            </div>
            <Slider
              value={[voice.silenceTimeoutMs]}
              min={400}
              max={2000}
              step={100}
              onValueChange={([v]) => updateVoice({ silenceTimeoutMs: v })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
