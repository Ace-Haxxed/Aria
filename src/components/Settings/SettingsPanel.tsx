import { createContext, useContext, useEffect, useState } from 'react';
import { Check, Loader2, Mic, RotateCcw, Volume2 } from 'lucide-react';
import type { LLMProvider } from '@/core/types';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import {
  Card,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/primitives';
import { PROVIDERS, listOllamaModels, providerSpec, testConnection } from '@/core/llm';
import { DEFAULT_SYSTEM_PROMPT } from '@/core/agent';
import { useSettings } from '@/store/settings';
import { useConnection } from '@/store/connection';
import { modelsFor } from '@/core/modelLimits';
import { clearAllHistory } from '@/core/memory';
import { isDesktop, isMobile } from '@/platform';
import { KeysPage } from './KeysPage';
import { VoicePage } from './VoicePage';
import { WakeWordSettings } from './WakeWordSettings';
import { TrainingSection } from './TrainingSection';
import { MyModel } from './MyModel';
import { ModelAllowance } from './ModelAllowance';
import { HotkeyRecorder } from './HotkeyRecorder';
import { toast } from '@/store/toasts';
import { cn } from '@/lib/utils';




interface SettingsPanelProps {
  onClose?: () => void;
  /** Rendered inline on mobile rather than as a modal. */
  embedded?: boolean;
  /** Which tab to open on. `nova --keys` uses this to land on the keys page. */
  initialTab?: string;
}

export function SettingsPanel({ onClose, embedded, initialTab = 'general' }: SettingsPanelProps) {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const updateLLM = useSettings((s) => s.updateLLM);
  const updateVoice = useSettings((s) => s.updateVoice);
  const setProvider = useSettings((s) => s.setProvider);
  const setAccentHue = useSettings((s) => s.setAccentHue);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [micResult, setMicResult] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const spec = providerSpec(settings.llm.provider);

  // Clear a stale connection result when the provider changes.
  useEffect(() => {
    setTestResult(null);
  }, [settings.llm.provider]);

  // The launch check already asked Ollama what it has; reuse that rather than
  // making the same call again when Settings opens.
  const discovered = useConnection((s) => s.localModels);
  useEffect(() => {
    if (settings.llm.provider !== 'ollama') return;
    if (discovered.length > 0) {
      setOllamaModels(discovered);
      return;
    }
    void listOllamaModels(settings.llm.baseUrl ?? spec.baseUrl).then(setOllamaModels);
  }, [settings.llm.provider, settings.llm.baseUrl, spec.baseUrl, discovered]);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestResult(await testConnection(settings.llm));
    setTesting(false);
  };

  const testMic = async () => {
    setMicResult(null);
    try {
      // Rust/cpal, not getUserMedia: WebKitGTK cannot open the microphone on a
      // Wayland session, so the webview is never asked for hardware access.
      const { desktop } = await import('@/platform/desktop');
      const mic = await desktop.testMicrophone();
      setMicResult(`Microphone works — ${mic.device} at ${mic.sampleRate} Hz.`);
    } catch (e) {
      setMicResult(
        `Microphone unavailable: ${typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const testSpeaker = async () => {
    const { useVoiceTest } = await import('./testSpeaker');
    await useVoiceTest('NOVA speech test. All systems nominal.');
  };

  const modelOptions =
    settings.llm.provider === 'ollama' && ollamaModels.length > 0 ? ollamaModels : spec.models;

  const exportSettings = () => {
    // The keychain holds the API keys and they are deliberately not included:
    // an exported file is likely to end up in a backup or a chat window.
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `nova-settings-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  const importSettings = (file: File) => {
    void file
      .text()
      .then((text) => {
        const parsed = JSON.parse(text) as Partial<typeof settings>;
        // Merged rather than replaced, so a file from an older version does
        // not wipe settings it predates.
        update(parsed);
        toast.success('Settings imported');
      })
      .catch(() => toast.error('That file is not a NOVA settings export'));
  };

  const body = (
    <FilterContext.Provider value={filter}>
    <Tabs defaultValue={initialTab} className="flex min-h-0 flex-1 flex-col">
      <div className="mx-4 mt-4 flex shrink-0 items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search settings…"
          className="h-8 max-w-56 text-xs"
          aria-label="Search settings"
        />
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={exportSettings} className="h-8 px-2 text-xs">
            Export
          </Button>
          <label className="cursor-pointer rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
            Import
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) importSettings(file);
                e.target.value = '';
              }}
            />
          </label>
        </div>
      </div>

      <TabsList className="mx-4 mt-3 w-auto shrink-0 self-start">
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="ai">AI</TabsTrigger>
        <TabsTrigger value="ai-speed">Speed</TabsTrigger>
        {/* Not desktop-only any more. This was hidden on mobile because the
            key store only ever spoke to Tauri, so the page was inert there —
            keys now persist through Capacitor Preferences, and hiding the tab
            left a phone with no way to enter one at all. */}
        <TabsTrigger value="keys">API Keys</TabsTrigger>
        <TabsTrigger value="voice">Voice</TabsTrigger>
        {isDesktop && <TabsTrigger value="hotkeys">Hotkeys</TabsTrigger>}
        <TabsTrigger value="permissions">Permissions</TabsTrigger>
        <TabsTrigger value="privacy">Privacy</TabsTrigger>
      </TabsList>

      <div className="nova-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {/* ── General ── */}
        <TabsContent value="general" className="space-y-5">
          {isDesktop && (
            <>
              <Row
                label="Launch at startup"
                description="Start NOVA when you log in"
                control={
                  <Switch
                    checked={settings.launchAtStartup}
                    onCheckedChange={(v) => update({ launchAtStartup: v })}
                  />
                }
              />
              <Row
                label="Start minimised"
                description="Open straight to the tray, with no window"
                control={
                  <Switch
                    checked={settings.startMinimized}
                    onCheckedChange={(v) => update({ startMinimized: v })}
                  />
                }
              />
            </>
          )}

          {isDesktop && (
            <>
              <Row
                label="Raise the window on wake word"
                description="Bring NOVA to the front when it hears you"
                control={
                  <Switch
                    checked={settings.raiseOnWakeWord}
                    onCheckedChange={(v) => update({ raiseOnWakeWord: v })}
                  />
                }
              />
              <Row
                label={'"Goodbye NOVA" hides the window'}
                description="Say it, or press Escape, to send NOVA back to the tray"
                control={
                  <Switch
                    checked={settings.goodbyeMinimizes}
                    onCheckedChange={(v) => update({ goodbyeMinimizes: v })}
                  />
                }
              />
            </>
          )}

          <div className="space-y-2">
            <Label>Accent colour</Label>
            <p className="text-xs text-muted-foreground">
              NOVA is dark-theme only. This shifts the accent hue everything derives from.
            </p>
            <div className="flex items-center gap-3">
              <Slider
                value={[settings.accentHue]}
                min={0}
                max={360}
                step={1}
                onValueChange={([v]) => setAccentHue(v)}
                className="flex-1"
              />
              <div
                className="h-7 w-7 shrink-0 rounded-full border border-border"
                style={{ background: `hsl(${settings.accentHue} 94% 55%)` }}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="language">Language</Label>
            <Select
              value={settings.language}
              onValueChange={(v) => update({ language: v })}
            >
              <SelectTrigger id="language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="es">Español</SelectItem>
                <SelectItem value="fr">Français</SelectItem>
                <SelectItem value="de">Deutsch</SelectItem>
                <SelectItem value="pt">Português</SelectItem>
                <SelectItem value="zh">中文</SelectItem>
                <SelectItem value="ja">日本語</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </TabsContent>

        {/* ── AI ── */}
        <TabsContent value="ai" className="space-y-5">
          <div className="space-y-2">
            <Label>Backend</Label>
            <Select
              value={settings.llm.provider}
              onValueChange={(v) => void setProvider(v as LLMProvider)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{spec.hint}</p>
          </div>

          {/* Keys and endpoints live in the API Keys tab, where every provider
              is visible at once rather than only the selected one. */}
          {settings.llm.provider === 'custom' && (
            <div className="space-y-2">
              <Label htmlFor="baseurl">Endpoint URL</Label>
              <Input
                id="baseurl"
                value={settings.llm.baseUrl ?? ''}
                onChange={(e) => updateLLM({ baseUrl: e.target.value })}
                placeholder={spec.baseUrl || 'https://…/v1'}
              />
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="model">Model</Label>
              {modelOptions.length > 0 ? (
                <Select value={settings.llm.model} onValueChange={(v) => updateLLM({ model: v })}>
                  <SelectTrigger id="model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.map((m) => {
                      const limits = modelsFor(settings.llm.provider).find((x) => x.id === m);
                      return (
                        <SelectItem key={m} value={m}>
                          {m}
                          {limits?.recommendedFree && ' · recommended (free)'}
                          {limits?.recommendedPaid && ' · recommended (paid)'}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="model"
                  value={settings.llm.model}
                  onChange={(e) => updateLLM({ model: e.target.value })}
                />
              )}
              <ModelAllowance provider={settings.llm.provider} model={settings.llm.model} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="vision">Vision model</Label>
              <Input
                id="vision"
                value={settings.llm.visionModel}
                onChange={(e) => updateLLM({ visionModel: e.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">
                Used for screenshots and photos.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Temperature</Label>
              <span className="font-mono text-xs text-muted-foreground">
                {settings.llm.temperature.toFixed(2)}
              </span>
            </div>
            <Slider
              value={[settings.llm.temperature]}
              min={0}
              max={1.5}
              step={0.05}
              onValueChange={([v]) => updateLLM({ temperature: v })}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Max tokens</Label>
              <span className="font-mono text-xs text-muted-foreground">
                {settings.llm.maxTokens}
              </span>
            </div>
            <Slider
              value={[settings.llm.maxTokens]}
              min={256}
              max={8192}
              step={256}
              onValueChange={([v]) => updateLLM({ maxTokens: v })}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="prompt">System prompt</Label>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={() => updateLLM({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </Button>
            </div>
            <Textarea
              id="prompt"
              value={settings.llm.systemPrompt}
              onChange={(e) => updateLLM({ systemPrompt: e.target.value })}
              className="min-h-[140px] font-mono text-xs"
            />
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={() => void runTest()} disabled={testing} variant="outline">
              {testing && <Loader2 className="h-4 w-4 animate-spin" />}
              Test connection
            </Button>
            {testResult && (
              <span
                className={cn(
                  'text-xs',
                  testResult.ok ? 'text-nova-acting' : 'text-risk-high',
                )}
              >
                {testResult.message}
              </span>
            )}
          </div>
        </TabsContent>

        {/* ── Voice ── */}
        <TabsContent value="ai-speed" className="space-y-5">
          <div className="space-y-2">
            <Label>Response speed</Label>
            <Select
              value={settings.responseSpeed}
              onValueChange={(v) => update({ responseSpeed: v as never })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fast">Fast — always the small model</SelectItem>
                <SelectItem value="balanced">Balanced — decide per message</SelectItem>
                <SelectItem value="smart">Smart — always the large model</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Balanced sends short questions to the quick model and anything involving code,
              files or long context to the capable one.
            </p>
          </div>

          <Row
            label="Warm up the model at launch"
            description="Load it before the first message, so that one is not slower than the rest"
            control={
              <Switch
                checked={settings.modelWarmup}
                onCheckedChange={(v) => update({ modelWarmup: v })}
              />
            }
          />
          <Row
            label="Show model and speed"
            description="Which model answered, how long it took, and tokens per second"
            control={
              <Switch
                checked={settings.showModelStats}
                onCheckedChange={(v) => update({ showModelStats: v })}
              />
            }
          />
        </TabsContent>

        <TabsContent value="keys" className="space-y-5">
          <KeysPage />
        </TabsContent>

        <TabsContent value="voice" className="space-y-5">
          {/* Engine status, provisioning and calibration. Placed first
              because it answers "why is nothing happening" — the rest of this
              tab is preferences that only matter once STT works at all. */}
          {isDesktop && <VoicePage />}

          <Row
            label="Speak replies aloud"
            description="Read every answer out through the speaker"
            control={
              <Switch
                checked={settings.voice.autoSpeak}
                onCheckedChange={(v) => updateVoice({ autoSpeak: v })}
              />
            }
          />

          <WakeWordSettings />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Speech to text</Label>
              <Select
                value={settings.voice.sttEngine}
                onValueChange={(v) => updateVoice({ sttEngine: v as never })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {isDesktop && (
                    <SelectItem value="whisper-sidecar">whisper.cpp (offline)</SelectItem>
                  )}
                  {isMobile && <SelectItem value="native">Device recogniser</SelectItem>}
                  <SelectItem value="browser">Built-in recogniser</SelectItem>
                  <SelectItem value="off">Off</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Text to speech</Label>
              <Select
                value={settings.voice.ttsEngine}
                onValueChange={(v) => updateVoice({ ttsEngine: v as never })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {isDesktop && <SelectItem value="piper-sidecar">piper (offline)</SelectItem>}
                  {isDesktop && <SelectItem value="os-native">System voice</SelectItem>}
                  {isMobile && <SelectItem value="native">Device voice</SelectItem>}
                  <SelectItem value="browser">Built-in voice</SelectItem>
                  <SelectItem value="off">Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Speed</Label>
              <span className="font-mono text-xs text-muted-foreground">
                {settings.voice.speed.toFixed(2)}×
              </span>
            </div>
            <Slider
              value={[settings.voice.speed]}
              min={0.5}
              max={2}
              step={0.05}
              onValueChange={([v]) => updateVoice({ speed: v })}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Pitch</Label>
              <span className="font-mono text-xs text-muted-foreground">
                {settings.voice.pitch.toFixed(2)}
              </span>
            </div>
            <Slider
              value={[settings.voice.pitch]}
              min={0.5}
              max={2}
              step={0.05}
              onValueChange={([v]) => updateVoice({ pitch: v })}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => void testMic()} className="gap-2">
              <Mic className="h-4 w-4" />
              Test microphone
            </Button>
            <Button variant="outline" onClick={() => void testSpeaker()} className="gap-2">
              <Volume2 className="h-4 w-4" />
              Test speaker
            </Button>
            {micResult && <span className="text-xs text-muted-foreground">{micResult}</span>}
          </div>
        </TabsContent>

        {/* ── Hotkeys ── */}
        {isDesktop && (
          <TabsContent value="hotkeys" className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Click a shortcut and press the keys you want. These work even when NOVA is not
              focused.
            </p>
            <HotkeyRecorder action="toggleWindow" label="Show or hide NOVA" />
            <HotkeyRecorder action="pushToTalk" label="Push to talk" />
            <HotkeyRecorder action="screenshotAsk" label="Screenshot and ask" />
            <div className="flex items-center justify-between py-2">
              <div>
                <div className="text-sm font-medium">Cancel the current action</div>
                <div className="text-xs text-muted-foreground">
                  Always Escape, while the window is focused
                </div>
              </div>
              <kbd className="rounded border border-border bg-muted px-2 py-1 font-mono text-xs">
                Escape
              </kbd>
            </div>
          </TabsContent>
        )}

        {/* ── Permissions ── */}
        <TabsContent value="permissions" className="space-y-3">
          <p className="text-xs text-muted-foreground">
            NOVA runs every action the model decides on, straight away — there is no
            confirmation step and no per-capability switch. Everything it does is recorded
            in the action log, and anything reversible can be undone from there.
          </p>
          <p className="text-xs text-muted-foreground">
            Refusals you see come from the operating system itself: a device it cannot open,
            a screen-capture portal you declined. Those are real errors, not prompts.
          </p>
        </TabsContent>

        {/* ── Privacy ── */}
        <TabsContent value="privacy" className="space-y-5">
          {isDesktop && (
            <>
              <TrainingSection />
              <div className="border-t border-border/60" />
              <MyModel />
              <div className="border-t border-border/60" />
            </>
          )}

          <Row
            label="Save conversation history"
            description="Keep past conversations on this device"
            control={
              <Switch
                checked={settings.saveHistory}
                onCheckedChange={(v) => update({ saveHistory: v })}
              />
            }
          />

          <Row
            label="Remember things between sessions"
            description="Let NOVA keep notes on your preferences"
            control={
              <Switch
                checked={settings.persistentMemory}
                onCheckedChange={(v) => update({ persistentMemory: v })}
              />
            }
          />

          <div className="space-y-2">
            <Label>Screenshot retention</Label>
            <Select
              value={settings.screenshotRetention}
              onValueChange={(v) => update({ screenshotRetention: v as never })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="never">Never keep screenshots</SelectItem>
                <SelectItem value="session">Keep for this session only</SelectItem>
                <SelectItem value="always">Keep until I clear them</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Card className="space-y-2 p-3.5">
            <div className="text-sm font-medium">No analytics</div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              NOVA collects nothing and phones home to nothing. The only network traffic is
              to the AI backend you chose and to pages you ask it to read. Pick Ollama and
              nothing leaves this device at all.
            </p>
          </Card>

          <Button
            variant="outline"
            className="border-risk-high/50 text-risk-high hover:bg-risk-high/10"
            onClick={() => {
              void clearAllHistory();
              void useSettings.getState().load();
            }}
          >
            Delete all conversation history
          </Button>
        </TabsContent>
      </div>
    </Tabs>
    </FilterContext.Provider>
  );

  if (embedded) {
    return <div className="flex h-full flex-col">{body}</div>;
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
      <div className="nova-panel flex h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-semibold">Settings</h2>
          <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close settings">
            <Check className="h-4 w-4" />
          </Button>
        </div>
        {body}
      </div>
    </div>
  );
}

/**
 * The active settings filter.
 *
 * Passed by context rather than as a prop: there are dozens of rows across six
 * tabs, and threading the same string through every one of them would be
 * noise in each call site for no benefit.
 */
const FilterContext = createContext('');

/** Does this row survive the current filter? */
function useMatchesFilter(...text: Array<string | undefined>): boolean {
  const filter = useContext(FilterContext).trim().toLowerCase();
  if (!filter) return true;
  return text.filter(Boolean).join(' ').toLowerCase().includes(filter);
}

function Row({
  label,
  description,
  control,
}: {
  label: string;
  description: string;
  control: React.ReactNode;
}) {
  const matches = useMatchesFilter(label, description);
  if (!matches) return null;

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
