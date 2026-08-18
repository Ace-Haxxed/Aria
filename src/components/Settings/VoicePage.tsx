/**
 * Everything that decides whether talking to ARIA works.
 *
 * The page exists because the failure it diagnoses is invisible: with no
 * whisper binary and no OpenAI key, dictation records happily, transcribes
 * nothing, and says nothing about why. The status block at the top is
 * therefore the point of the page — it always names the engine in use, or the
 * two ways to get one.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Download, Hammer, Loader2, Mic, X } from 'lucide-react';
import type { Calibration, SttStatus, WhisperProgress } from '@/platform/desktop';
import { useSettings } from '@/store/settings';
import { humanise, toast } from '@/store/toasts';
import { isTauri } from '@/platform';
import { cn } from '@/lib/utils';

/** How long the test button records before transcribing. */
const TEST_SECONDS = 3;

export function VoicePage() {
  const voice = useSettings((s) => s.settings.voice);
  const updateVoice = useSettings((s) => s.updateVoice);

  const [stt, setStt] = useState<SttStatus | null>(null);
  const [devices, setDevices] = useState<string[]>([]);
  const [progress, setProgress] = useState<WhisperProgress | null>(null);
  const [busy, setBusy] = useState<'model' | 'build' | 'test' | 'calibrate' | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [calibration, setCalibration] = useState<Calibration | null>(null);

  const refresh = useCallback(async () => {
    if (!isTauri) return;
    const { desktop } = await import('@/platform/desktop');
    const [status, mics] = await Promise.all([
      desktop.sttStatus().catch(() => null),
      desktop.listMicrophones?.().catch(() => []) ?? Promise.resolve([]),
    ]);
    if (status) setStt(status);
    setDevices(mics ?? []);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Progress for both the download and the build arrives on one channel, so
  // one subscription covers both buttons.
  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const handle = await listen<WhisperProgress>('whisper-progress', (event) => {
        setProgress(event.payload);
        if (event.payload.done) {
          setProgress(null);
          void refresh();
        }
      });
      off = () => void handle();
    })();
    return () => off?.();
  }, [refresh]);

  const run = async (kind: 'model' | 'build') => {
    setBusy(kind);
    try {
      const { desktop } = await import('@/platform/desktop');
      if (kind === 'model') await desktop.downloadWhisperModel();
      else await desktop.buildWhisperSidecar();
      await refresh();
    } catch (e) {
      toast.error(
        kind === 'model' ? 'Model download failed' : 'Build failed',
        humanise(e),
      );
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  /** Record a short take and transcribe it, reporting which engine ran. */
  const test = async () => {
    setBusy('test');
    setTestResult(null);
    try {
      const { desktop } = await import('@/platform/desktop');
      await desktop.startCapture(0);
      await new Promise((r) => setTimeout(r, TEST_SECONDS * 1000));
      const wav = await desktop.stopCapture();
      const text = await desktop.transcribe(wav);
      const method = stt?.method === 'offline' ? 'offline whisper.cpp' : 'OpenAI Whisper';
      setTestResult(
        text.trim() ? `"${text.trim()}"  — via ${method}` : `Nothing was heard — via ${method}`,
      );
    } catch (e) {
      setTestResult(null);
      toast.error('Test failed', humanise(e));
    } finally {
      setBusy(null);
    }
  };

  const calibrate = async () => {
    setBusy('calibrate');
    try {
      const { desktop } = await import('@/platform/desktop');
      const result = await desktop.calibrateWakeWord(voice.wakeWord, 5);
      setCalibration(result);
    } catch (e) {
      toast.error('Could not calibrate', humanise(e));
    } finally {
      setBusy(null);
    }
  };

  const method = stt?.method ?? 'none';

  return (
    <div className="space-y-6">
      {/* Status first: this is the answer to "why doesn't voice work". */}
      <section
        className={cn(
          'rounded-xl border px-4 py-3',
          method === 'offline' && 'border-aria-acting/30 bg-aria-acting/5',
          method === 'api' && 'border-accent/30 bg-accent/5',
          method === 'none' && 'border-risk-high/30 bg-risk-high/5',
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              method === 'offline' && 'bg-aria-acting',
              method === 'api' && 'bg-accent',
              method === 'none' && 'bg-risk-high',
            )}
          />
          <h3 className="text-sm font-medium text-foreground">
            {method === 'offline' && 'Offline'}
            {method === 'api' && 'OpenAI Whisper'}
            {method === 'none' && 'No speech-to-text'}
          </h3>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{stt?.detail ?? 'Checking…'}</p>
        {method === 'api' && (
          <p className="mt-1.5 font-mono text-[11px] text-accent/80">
            ~$0.006/min — your key, your cost
          </p>
        )}
      </section>

      {/* Provisioning the offline engine. Two independent pieces: the binary
          has to be compiled, the model only downloaded. */}
      <section className="space-y-3">
        <h4 className="text-xs uppercase tracking-wider text-muted-foreground">
          Offline engine
        </h4>

        <Row
          label="whisper.cpp binary"
          value={stt?.binary ?? 'Not installed'}
          present={Boolean(stt?.binary)}
          action={
            !stt?.binary && (
              <button
                onClick={() => void run('build')}
                disabled={busy !== null || !stt?.canBuild}
                title={stt?.canBuild ? undefined : 'Needs git and cmake'}
                className="flex items-center gap-1.5 rounded-lg bg-accent/15 px-3 py-1.5 text-[11px]
                  font-medium text-accent transition-colors duration-150 hover:bg-accent/25
                  disabled:opacity-40"
              >
                {busy === 'build' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Hammer className="h-3 w-3" />
                )}
                Build
              </button>
            )
          }
        />

        <Row
          label="Model (ggml-base.en)"
          value={stt?.model ?? 'Not downloaded'}
          present={Boolean(stt?.model)}
          action={
            !stt?.model && (
              <button
                onClick={() => void run('model')}
                disabled={busy !== null}
                className="flex items-center gap-1.5 rounded-lg bg-accent/15 px-3 py-1.5 text-[11px]
                  font-medium text-accent transition-colors duration-150 hover:bg-accent/25
                  disabled:opacity-40"
              >
                {busy === 'model' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Download className="h-3 w-3" />
                )}
                Download 148 MB
              </button>
            )
          }
        />

        {progress && (
          <div className="space-y-1">
            <div className="h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-150"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <p className="font-mono text-[10px] text-muted-foreground">{progress.detail}</p>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          Models are written to{' '}
          <span className="font-mono text-foreground/70">{stt?.modelDir ?? '…'}</span>
        </p>
      </section>

      {/* Microphone. */}
      <section className="space-y-3">
        <h4 className="text-xs uppercase tracking-wider text-muted-foreground">Microphone</h4>

        {devices.length > 0 ? (
          <select
            value={voice.inputDevice ?? ''}
            onChange={(e) => {
              const name = e.target.value || undefined;
              updateVoice({ inputDevice: name });
              // Rust opens the device, so it needs telling too — the setting
              // alone would only take effect after a restart.
              void import('@/platform/desktop').then((m) => m.desktop.setInputDevice(name));
            }}
            className="h-9 w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 text-xs
              text-foreground outline-none transition-colors duration-150 focus:border-accent/50"
          >
            <option value="">System default</option>
            {devices.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Using the system default input.
          </p>
        )}

        <button
          onClick={() => void test()}
          disabled={busy !== null || method === 'none'}
          className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5
            text-[11px] text-foreground transition-colors duration-150 hover:border-accent/50
            disabled:opacity-40"
        >
          {busy === 'test' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Mic className="h-3 w-3" />
          )}
          Test — record {TEST_SECONDS}s
        </button>

        {testResult && (
          <p className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs
            text-foreground">
            {testResult}
          </p>
        )}
      </section>

      {/* Wake word. */}
      <section className="space-y-3">
        <h4 className="text-xs uppercase tracking-wider text-muted-foreground">Wake word</h4>

        <label className="flex items-center justify-between text-xs text-foreground">
          <span>
            Listen for &ldquo;{voice.wakeWord}&rdquo; continuously
          </span>
          <input
            type="checkbox"
            checked={voice.wakeWordEnabled}
            onChange={(e) => updateVoice({ wakeWordEnabled: e.target.checked })}
            className="h-4 w-4 accent-[color:var(--cyan-primary,#00d4ff)]"
          />
        </label>

        <button
          onClick={() => void calibrate()}
          disabled={busy !== null}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-foreground
            transition-colors duration-150 hover:border-accent/50 disabled:opacity-40"
        >
          {busy === 'calibrate' ? 'Listening to the room…' : 'Calibrate to this room'}
        </button>

        <p className="text-[11px] text-muted-foreground">
          Records five seconds of background noise and sets the match threshold just below
          whatever the room alone scores — as sensitive as it can be without firing on nothing.
        </p>

        {calibration && (
          <p className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono
            text-[11px] text-foreground">
            {calibration.detail}
          </p>
        )}
      </section>
    </div>
  );
}

function Row({
  label,
  value,
  present,
  action,
}: {
  label: string;
  value: string;
  present: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
      {present ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-aria-acting" />
      ) : (
        <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs text-foreground">{label}</p>
        <p className="truncate font-mono text-[10px] text-muted-foreground">{value}</p>
      </div>
      {action}
    </div>
  );
}
