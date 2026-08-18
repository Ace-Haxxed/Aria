/**
 * Types shared by every platform. Nothing in this file may import from
 * `@/platform/*` — the dependency arrow points the other way.
 */

/* ── Agent state ─────────────────────────────────────────────── */

export type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'acting';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
  /** Present on assistant messages that requested tools. */
  toolCalls?: ToolCall[];
  /** Present on tool messages — links the result back to its request. */
  toolCallId?: string;
  /** Base64 data URLs for vision input. */
  images?: string[];
  /** Set while the message is still streaming in. */
  streaming?: boolean;
  error?: string;
  /** How this reply was produced. Shown as small grey text under it. */
  meta?: {
    model: string;
    provider: string;
    /** Wall-clock time for the whole turn. */
    ms: number;
    /** Estimated from the streamed text; providers rarely report it. */
    tokens: number;
  };
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  /** Rolling summary of messages that have been evicted from the context window. */
  summary?: string;
  pinned?: boolean;
}

/* ── Tools ───────────────────────────────────────────────────── */

export type RiskLevel = 'low' | 'medium' | 'high';

/** Capability groups the user can independently allow or deny in Settings. */
export type Capability =
  | 'mouse'
  | 'keyboard'
  | 'screen'
  | 'files'
  | 'browser'
  | 'terminal'
  | 'packages'
  | 'system'
  | 'camera'
  | 'microphone'
  | 'notifications'
  | 'network';

export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

export interface ParamSchema {
  type: JsonSchemaType;
  description: string;
  enum?: string[];
  default?: unknown;
  items?: ParamSchema;
  properties?: Record<string, ParamSchema>;
  required?: string[];
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, ParamSchema>;
  required?: string[];
}

export interface ToolDefinition extends ToolSchema {
  capability: Capability;
  risk: RiskLevel;
  /** When true the safety layer asks the user before every run unless trusted. */
  destructive?: boolean;
  platforms: Array<'desktop' | 'mobile'>;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * Opaque provider state that must be echoed back with the call.
   *
   * Gemini's thinking models return a `thoughtSignature` beside every
   * `functionCall` and reject the following turn if the call is replayed
   * without it. It is meaningless to ARIA — it is never read, only carried —
   * but dropping it breaks multi-step tool use entirely.
   */
  signature?: string;
}

export interface ToolResult {
  ok: boolean;
  /** Text fed back to the model. Keep it short — this costs context. */
  output: string;
  /** Structured payload for the UI (screenshots, file lists, …). Never sent to the model verbatim. */
  data?: unknown;
  error?: string;
  /** Populated when the action can be reversed (e.g. a trashed file's restore path). */
  undo?: UndoRecord;
}

export interface UndoRecord {
  kind: 'restore-file' | 'restore-clipboard' | 'reopen-window' | 'none';
  label: string;
  payload: Record<string, unknown>;
}

/* ── Action log ──────────────────────────────────────────────── */

export type ActionStatus = 'pending' | 'running' | 'ok' | 'error' | 'cancelled';

export interface ActionLogEntry {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  risk: RiskLevel;
  status: ActionStatus;
  startedAt: number;
  finishedAt?: number;
  summary: string;
  result?: string;
  error?: string;
  undo?: UndoRecord;
  undone?: boolean;
}

/* ── LLM ─────────────────────────────────────────────────────── */

export type LLMProvider =
  /** Runs inside the ARIA process. No server, no key, no internet. */
  | 'builtin'
  /** One key, every model — routes to whichever provider hosts it. */
  | 'openrouter'
  /** NVIDIA's hosted NIM endpoints — OpenAI-compatible, free build tier. */
  | 'nvidia'
  | 'bytez'
  | 'ollama'
  | 'groq'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'custom'
  | 'on-device';

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  visionModel: string;
  /** Only used by `custom`; the other providers have fixed base URLs. */
  baseUrl?: string;
  apiKey?: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
}

export interface LLMChunk {
  /** Incremental assistant text. */
  delta?: string;
  /** Emitted once the provider has finished assembling a tool call. */
  toolCall?: ToolCall;
  done?: boolean;
  error?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LLMRequest {
  messages: Message[];
  tools: ToolSchema[];
  signal?: AbortSignal;
}

/* ── Platform ────────────────────────────────────────────────── */

export type OSKind = 'linux' | 'windows' | 'macos' | 'android' | 'ios' | 'web';
export type SessionType = 'x11' | 'wayland' | 'none';
export type Compositor = 'gnome' | 'kde' | 'hyprland' | 'sway' | 'xfce' | 'other' | 'none';

export interface PlatformInfo {
  os: OSKind;
  isMobile: boolean;
  isDesktop: boolean;
  arch: string;
  osVersion: string;
  /** Linux only. */
  sessionType: SessionType;
  compositor: Compositor;
  distro?: string;
  packageManager?: 'pacman' | 'dnf' | 'apt' | 'brew' | 'winget' | 'none';
  /** Which of the external helper binaries were found on PATH. */
  tools: Record<string, boolean>;
}

export interface DependencyCheck {
  name: string;
  present: boolean;
  required: boolean;
  purpose: string;
  installHint: string;
}

/* ── Voice ───────────────────────────────────────────────────── */

export type STTEngine = 'whisper-sidecar' | 'browser' | 'native' | 'off';
export type TTSEngine = 'piper-sidecar' | 'os-native' | 'browser' | 'native' | 'off';

export interface VoiceSettings {
  sttEngine: STTEngine;
  /** cpal device name, or undefined for the system default. */
  inputDevice?: string;
  ttsEngine: TTSEngine;
  wakeWordEnabled: boolean;
  wakeWord: string;
  /** 1-10. Higher accepts a looser match, at the cost of false triggers. */
  wakeWordSensitivity: number;
  /** Short chime when the wake word fires, so activation is audible. */
  activationSound: boolean;
  /** Stop recording automatically once the user stops speaking. */
  autoStopOnSilence: boolean;
  /** How long a pause counts as "finished speaking", in milliseconds. */
  silenceTimeoutMs: number;
  speed: number;
  pitch: number;
  voice: string;
  /** Speak responses without being asked. */
  autoSpeak: boolean;
}

/* ── Settings ────────────────────────────────────────────────── */

export type ScreenshotRetention = 'never' | 'session' | 'always';

export interface HotkeyConfig {
  toggleWindow: string;
  pushToTalk: string;
  screenshotAsk: string;
  cancel: string;
}

export interface Settings {
  launchAtStartup: boolean;
  startMinimized: boolean;
  language: string;
  accentHue: number;
  llm: LLMConfig;
  voice: VoiceSettings;
  hotkeys: HotkeyConfig;
  saveHistory: boolean;
  screenshotRetention: ScreenshotRetention;
  capabilities: Record<Capability, boolean>;
  /** Unused: kept so an older settings file still parses. Nothing reads it. */
  trustedTools: string[];
  setupComplete: boolean;
  /**
   * Save each exchange locally so a local model can be fine-tuned on them
   * later. Off unless the user opts in; nothing is ever uploaded.
   */
  trainLocalFromCloud: boolean;
  /** Onboarding hints the user has already seen and dismissed. */
  seenHints: string[];
  /**
   * Providers to try, in order, when the preferred one is unreachable.
   * A failed provider is skipped silently — a fallback the user has to
   * acknowledge is not a fallback.
   */
  fallbackChain: LLMProvider[];
  /** Pick whichever configured provider answers fastest, rather than a fixed one. */
  useBestAvailable: boolean;
  /**
   * How to trade speed against quality.
   * `fast` always uses the small model, `smart` always the large one, and
   * `balanced` decides per message from the request itself.
   */
  responseSpeed: 'fast' | 'balanced' | 'smart';
  /** Skip the confirmation prompt for actions classed as low risk. */
  fastMode: boolean;
  /** Load the model at launch so the first message does not pay for it. */
  modelWarmup: boolean;
  /** Show which model answered, and how fast, under each reply. */
  showModelStats: boolean;
  /** "Goodbye ARIA" hides the window to the tray. */
  goodbyeMinimizes: boolean;
  /** Bring the window to the front when the wake word fires. */
  raiseOnWakeWord: boolean;
  persistentMemory: boolean;
}
