/**
 * Desktop tools — thin, typed wrappers over the Tauri commands in `src-tauri`.
 *
 * Each tool's `description` is the only thing the model sees, so they are
 * written for the model, not for a human reader: what it does, when to reach
 * for it, and any constraint that would otherwise cost a failed call.
 */
import { invoke } from '@tauri-apps/api/core';
import type { PlatformInfo, ToolDefinition } from '@/core/types';
import {
  argBool,
  argNumber,
  argString,
  argStringArray,
  defineTool,
  fail,
  ok,
  p,
} from '@/core/tools/base';
import { sharedTools } from '@/core/tools/web';
import { visionTools } from '@/core/tools/vision';
import { formatBytes } from '@/lib/utils';

/* ── Typed command surface ───────────────────────────────────────
 * Exported so hooks and components can call the backend directly without
 * going through a tool definition.
 */

export interface WindowInfo {
  id: string;
  title: string;
  app: string;
  x: number;
  y: number;
  w: number;
  h: number;
  focused: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export interface SystemInfo {
  os: string;
  hostname: string;
  cpuUsage: number;
  cpuCount: number;
  ramUsed: number;
  ramTotal: number;
  diskUsed: number;
  diskTotal: number;
  battery: number | null;
  charging: boolean | null;
  uptime: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
}

export interface CmdOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export interface DependencyCheck {
  name: string;
  present: boolean;
  required: boolean;
  purpose: string;
  /** The command the user would run themselves. Empty when already present. */
  installHint: string;
  /** Package name for this machine's package manager, when one exists. */
  package: string | null;
  /** Whether `installDependency` can install this without a terminal. */
  installable: boolean;
}

export interface OllamaStatus {
  running: boolean;
  /** Whether the binary exists — distinguishes "start it" from "install it". */
  installed: boolean;
  /** Every model actually installed, straight from /api/tags. */
  models: string[];
  /** Best installed model, or null when nothing is pulled. */
  preferred: string | null;
  latencyMs: number;
}

export interface EndpointTest {
  ok: boolean;
  latencyMs: number;
  models: string[];
  message: string;
}

export interface PullProgress {
  status: string;
  completed: number;
  total: number;
  percent: number;
  done: boolean;
  error: string | null;
}

export interface KeyCheck {
  valid: boolean;
  message: string;
  /** Round-trip time of the check, so providers can be compared. */
  latencyMs: number;
}

export interface BuiltinStatus {
  loaded: boolean;
  modelId: string;
  modelName: string;
  modelPath: string;
  contextTotal: number;
  tokensPerSec: number;
  /** "cuda", "metal" or "cpu". */
  backend: string;
  threads: number;
  /** Whether the default model's weights are on disk. */
  downloaded: boolean;
}

export interface ModelCatalogEntry {
  id: string;
  name: string;
  description: string;
  sizeMb: number;
  needsRamGb: number;
  license: string;
  installed: boolean;
  downloadedBytes: number;
  path: string;
}

export interface ModelDownloadProgress {
  modelId: string;
  downloaded: number;
  total: number;
  percent: number;
  bytesPerSec: number;
  etaSeconds: number;
  phase: string;
  done: boolean;
  error: string | null;
}

export interface GpuInfo {
  available: boolean;
  kind: string;
  name: string;
  vramMb: number;
  cpuThreads: number;
  recommendedGpuLayers: number;
}

export interface WakeWordStatus {
  running: boolean;
  paused: boolean;
  word: string;
  sensitivity: number;
  /** False until the user has recorded a template. */
  trained: boolean;
  templates: number;
}

export interface TrainingReadiness {
  pythonAvailable: boolean;
  pythonVersion: string;
  gpu: boolean;
  device: string;
  backend: string | null;
  ready: boolean;
  pairs: number;
  estimatedMinutes: number;
  problem: string | null;
}

export interface Adapter {
  name: string;
  path: string;
  trainedAt: number;
  sizeBytes: number;
}

export interface ShortcutOutcome {
  action: string;
  /** What was actually registered — may be a fallback. */
  accelerator: string;
  /** What the user asked for. */
  requested: string;
  registered: boolean;
  /** Every combination tried and why each failed. */
  problem: string | null;
}

export interface MicTest {
  ok: boolean;
  device: string;
  sampleRate: number;
  channels: number;
}

export interface VoiceStatus {
  whisperBinary: string | null;
  whisperModel: string | null;
  piperBinary: string | null;
  piperVoice: string | null;
  nativeTts: string | null;
  modelsDir: string;
}

export const desktop = {
  /* platform */
  platformInfo: () => invoke<PlatformInfo>('get_platform_info'),
  checkDependencies: () => invoke<DependencyCheck[]>('check_dependencies'),
  installDependency: (name: string) => invoke<string>('install_dependency', { name }),

  /* AI backends — every provider request is made in Rust, see lib/llmTransport */
  checkOllama: (baseUrlOverride?: string) =>
    invoke<OllamaStatus>('check_ollama', { baseUrlOverride: baseUrlOverride ?? null }),
  checkOllamaAndStart: (baseUrlOverride?: string) =>
    invoke<OllamaStatus>('check_ollama_and_start', { baseUrlOverride: baseUrlOverride ?? null }),
  installOllama: () => invoke<string>('install_ollama'),
  ollamaHasModel: (model: string, baseUrlOverride?: string) =>
    invoke<boolean>('ollama_has_model', { model, baseUrlOverride: baseUrlOverride ?? null }),
  testOllamaEndpoint: (url: string) => invoke<EndpointTest>('test_ollama_endpoint', { url }),
  ollamaPull: (model: string, baseUrlOverride?: string) =>
    invoke<void>('ollama_pull', { model, baseUrlOverride: baseUrlOverride ?? null }),
  validateApiKey: (provider: string, apiKey: string) =>
    invoke<KeyCheck>('validate_api_key', { provider, apiKey }),

  /* built-in model — runs inside this process */
  builtinStatus: () => invoke<BuiltinStatus>('builtin_status'),
  builtinLoadModel: (modelId: string) => invoke<BuiltinStatus>('builtin_load_model', { modelId }),
  builtinUnloadModel: () => invoke<void>('builtin_unload_model'),
  builtinCancel: () => invoke<void>('builtin_cancel'),
  detectAcceleration: () =>
    invoke<{ backend: string; detail: string; threads: number }>('detect_acceleration'),
  listBuiltinModels: () => invoke<ModelCatalogEntry[]>('list_builtin_models'),
  downloadBuiltinModel: (modelId: string) =>
    invoke<string>('download_builtin_model', { modelId }),
  cancelModelDownload: () => invoke<void>('cancel_model_download'),
  deleteBuiltinModel: (modelId: string) => invoke<void>('delete_builtin_model', { modelId }),

  /* hardware + speed */
  checkGpu: () => invoke<GpuInfo>('check_gpu'),
  warmupModel: (model: string, baseUrlOverride?: string) =>
    invoke<void>('warmup_model', { model, baseUrlOverride: baseUrlOverride ?? null }),

  /* wake word — always-on local listener */
  startWakeWord: (word: string) => invoke<WakeWordStatus>('start_wake_word', { word }),
  stopWakeWord: () => invoke<void>('stop_wake_word'),
  wakeWordStatus: (word: string) => invoke<WakeWordStatus>('wake_word_status', { word }),
  trainWakeWord: (word: string, replace: boolean) =>
    invoke<WakeWordStatus>('train_wake_word', { word, replace }),
  setWakeWordSensitivity: (threshold: number) =>
    invoke<void>('set_wake_word_sensitivity', { threshold }),

  /* training data — written locally, never uploaded */
  trainingAppend: (record: {
    id: string;
    timestamp: string;
    user: string;
    assistant: string;
    model_used: string;
    quality_score: number | null;
  }) => invoke<void>('training_append', { record }),
  trainingStats: () =>
    invoke<{
      count: number;
      ratedGood: number;
      ratedBad: number;
      target: number;
      percent: number;
      ready: boolean;
      path: string;
      sizeBytes: number;
    }>('training_stats'),
  trainingRate: (id: string, score: number, note?: string) =>
    invoke<void>('training_rate', { id, score, note: note ?? null }),
  trainingExport: (destination: string) => invoke<string>('training_export', { destination }),
  trainingClear: () => invoke<void>('training_clear'),

  /* fine-tuning, via the Python sidecar */
  checkFinetuneSupport: () => invoke<TrainingReadiness>('check_finetune_support'),
  startFinetuning: (args: {
    name: string;
    baseModel?: string;
    epochs?: number;
    learningRate?: number;
    autoInstall?: boolean;
  }) =>
    invoke<string>('start_finetuning', {
      name: args.name,
      baseModel: args.baseModel ?? null,
      epochs: args.epochs ?? null,
      learningRate: args.learningRate ?? null,
      autoInstall: args.autoInstall ?? false,
    }),
  cancelFinetuning: () => invoke<void>('cancel_finetuning'),
  listAdapters: () => invoke<Adapter[]>('list_adapters'),
  deleteAdapter: (name: string) => invoke<void>('delete_adapter', { name }),

  /* microphone — cpal in Rust, never getUserMedia. WebKitGTK cannot reach the
   * microphone on a Wayland session, so the webview is not asked to. */
  testMicrophone: () => invoke<MicTest>('test_microphone'),
  startCapture: (silenceTimeoutMs?: number) =>
    invoke<void>('start_capture', { silenceTimeoutMs: silenceTimeoutMs ?? null }),
  /** Stops recording and returns the take as a base64 WAV (16 kHz mono). */
  stopCapture: () => invoke<string>('stop_capture'),
  isCapturing: () => invoke<boolean>('is_capturing'),

  /* screen */
  screenshot: (region?: { x: number; y: number; w: number; h: number }) =>
    invoke<string>('take_screenshot', { region: region ?? null }),
  saveScreenshot: (path: string, region?: { x: number; y: number; w: number; h: number }) =>
    invoke<string>('save_screenshot', { path, region: region ?? null }),
  screenSize: () => invoke<{ width: number; height: number }>('get_screen_size'),

  /* mouse */
  moveMouse: (x: number, y: number) => invoke<void>('move_mouse', { x, y }),
  click: (x?: number, y?: number, button?: 'left' | 'right' | 'middle') =>
    invoke<void>('click', { x: x ?? null, y: y ?? null, button: button ?? 'left' }),
  doubleClick: (x?: number, y?: number) =>
    invoke<void>('double_click', { x: x ?? null, y: y ?? null }),
  rightClick: (x?: number, y?: number) =>
    invoke<void>('right_click', { x: x ?? null, y: y ?? null }),
  drag: (x1: number, y1: number, x2: number, y2: number) =>
    invoke<void>('drag', { x1, y1, x2, y2 }),
  scroll: (direction: string, amount?: number, x?: number, y?: number) =>
    invoke<void>('scroll', {
      direction,
      amount: amount ?? null,
      x: x ?? null,
      y: y ?? null,
    }),
  mousePosition: () => invoke<{ x: number; y: number }>('get_mouse_position'),

  /* keyboard */
  typeText: (text: string) => invoke<void>('type_text', { text }),
  pressKey: (combo: string) => invoke<void>('press_key', { combo }),
  holdKey: (key: string) => invoke<void>('hold_key', { key }),
  releaseKey: (key: string) => invoke<void>('release_key', { key }),
  hotkey: (keys: string[]) => invoke<void>('hotkey', { keys }),

  /* windows */
  listWindows: () => invoke<WindowInfo[]>('list_windows'),
  focusWindow: (target: string) => invoke<void>('focus_window', { target }),
  moveWindow: (target: string, x: number, y: number) =>
    invoke<void>('move_window', { target, x, y }),
  resizeWindow: (target: string, w: number, h: number) =>
    invoke<void>('resize_window', { target, w, h }),
  closeWindow: (target: string) => invoke<void>('close_window', { target }),
  minimizeWindow: (target: string) => invoke<void>('minimize_window', { target }),
  maximizeWindow: (target: string) => invoke<void>('maximize_window', { target }),
  activeWindow: () => invoke<WindowInfo>('get_active_window'),

  /* files */
  readFile: (path: string) => invoke<string>('read_file', { path }),
  writeFile: (path: string, content: string) => invoke<string>('write_file', { path, content }),
  appendFile: (path: string, content: string) => invoke<string>('append_file', { path, content }),
  copyFile: (src: string, dst: string) => invoke<string>('copy_file', { src, dst }),
  moveFile: (src: string, dst: string) => invoke<string>('move_file', { src, dst }),
  deleteFile: (path: string) => invoke<string>('delete_file', { path }),
  listDirectory: (path: string) => invoke<FileEntry[]>('list_directory', { path }),
  createDirectory: (path: string) => invoke<string>('create_directory', { path }),
  searchFiles: (query: string, dir?: string) =>
    invoke<string[]>('search_files', { query, dir: dir ?? null }),
  fileInfo: (path: string) => invoke<Record<string, unknown>>('get_file_info', { path }),
  openFile: (path: string) => invoke<void>('open_file', { path }),
  zipFiles: (files: string[], output: string) => invoke<string>('zip_files', { files, output }),
  unzipFile: (path: string, dest: string) => invoke<string[]>('unzip_file', { path, dest }),
  restoreFromTrash: (originalPath: string) =>
    invoke<string>('restore_from_trash', { originalPath }),

  /* apps */
  launchApp: (name: string) => invoke<string>('launch_app', { name }),
  killApp: (name: string) => invoke<string>('kill_app', { name }),
  listRunningApps: () => invoke<string[]>('list_running_apps'),
  isAppRunning: (name: string) => invoke<boolean>('is_app_running', { name }),

  /* system */
  systemInfo: () => invoke<SystemInfo>('get_system_info'),
  getVolume: () => invoke<number>('get_volume'),
  setVolume: (level: number) => invoke<void>('set_volume', { level }),
  mute: () => invoke<void>('mute'),
  unmute: () => invoke<void>('unmute'),
  getBrightness: () => invoke<number>('get_brightness'),
  setBrightness: (level: number) => invoke<void>('set_brightness', { level }),
  lockScreen: () => invoke<void>('lock_screen'),
  sleepSystem: () => invoke<void>('sleep_system'),
  shutdown: (delay?: number) => invoke<void>('shutdown', { delay: delay ?? null }),
  restart: (delay?: number) => invoke<void>('restart', { delay: delay ?? null }),
  getClipboard: () => invoke<string>('get_clipboard'),
  setClipboard: (text: string) => invoke<void>('set_clipboard', { text }),
  clipboardHistory: () => invoke<string[]>('get_clipboard_history'),
  clearClipboardHistory: () => invoke<void>('clear_clipboard_history'),
  notify: (title: string, body: string) => invoke<void>('send_notification', { title, body }),
  runCommand: (cmd: string) => invoke<CmdOutput>('run_command', { cmd }),
  listProcesses: () => invoke<ProcessInfo[]>('list_processes'),
  killProcess: (target: string) => invoke<string>('kill_process', { target }),
  toggleWindow: () => invoke<void>('toggle_main_window'),
  showWindow: () => invoke<void>('show_main_window'),

  /* browser */
  openUrl: (url: string) => invoke<string>('open_url', { url }),
  currentUrl: () => invoke<string>('get_current_url'),
  pageTitle: () => invoke<string>('get_page_title'),
  pageText: () => invoke<string>('get_page_text'),
  pageScreenshot: () => invoke<string>('take_page_screenshot'),
  clickElement: (selector: string) => invoke<string>('click_element', { selector }),
  typeInElement: (selector: string, text: string) =>
    invoke<string>('type_in_element', { selector, text }),
  scrollPage: (direction: string, amount?: number) =>
    invoke<string>('scroll_page', { direction, amount: amount ?? null }),
  goBack: () => invoke<string>('go_back'),
  goForward: () => invoke<string>('go_forward'),
  reloadPage: () => invoke<string>('reload_page'),
  newTab: (url?: string) => invoke<string>('new_tab', { url: url ?? null }),
  closeTab: (id?: string) => invoke<string>('close_tab', { id: id ?? null }),
  listTabs: () => invoke<Array<{ id: string; title: string; url: string }>>('list_tabs'),
  switchTab: (index: number) => invoke<string>('switch_tab', { index }),
  waitForElement: (selector: string, timeout?: number) =>
    invoke<string>('wait_for_element', { selector, timeout: timeout ?? null }),
  executeJs: (code: string) => invoke<string>('execute_js', { code }),
  fillForm: (fields: Array<{ selector: string; value: string }>) =>
    invoke<string>('fill_form', { fields }),
  downloadFile: (url: string, dest: string) => invoke<string>('download_file', { url, dest }),

  /* packages & services */
  installPackage: (name: string) => invoke<string>('install_package', { name }),
  removePackage: (name: string) => invoke<string>('remove_package', { name }),
  listInstalledPackages: () => invoke<string[]>('list_installed_packages'),
  updateSystem: () => invoke<string>('update_system'),
  manageService: (name: string, action: string) =>
    invoke<string>('manage_service', { name, action }),

  /* voice */
  voiceStatus: () => invoke<VoiceStatus>('voice_status'),
  transcribe: (audioBase64: string) => invoke<string>('transcribe', { audioBase64 }),
  synthesize: (text: string, speed?: number) =>
    invoke<string>('synthesize', { text, speed: speed ?? null }),
  speakNative: (text: string) => invoke<void>('speak_native', { text }),

  /* secrets */
  setApiKey: (provider: string, key: string) => invoke<void>('set_api_key', { provider, key }),
  getApiKey: (provider: string) => invoke<string | null>('get_api_key', { provider }),
  deleteApiKey: (provider: string) => invoke<void>('delete_api_key', { provider }),
  listConfiguredProviders: () => invoke<string[]>('list_configured_providers'),

  /* hotkeys & tray */
  registerHotkeys: (bindings: Array<[string, string]>) =>
    invoke<ShortcutOutcome[]>('register_hotkeys', { bindings }),
  unregisterHotkeys: () => invoke<void>('unregister_hotkeys'),
  setTrayActive: (active: boolean) => invoke<void>('set_tray_active', { active }),
  setTrayState: (state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'acting') =>
    invoke<void>('set_tray_state', { state }),

  /* persistence */
  saveConversation: (args: {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    summary: string | null;
    pinned: boolean;
  }) => invoke<void>('db_save_conversation', args),
  listConversations: (limit?: number) =>
    invoke<
      Array<{
        id: string;
        title: string;
        createdAt: number;
        updatedAt: number;
        summary: string | null;
        pinned: boolean;
      }>
    >('db_list_conversations', { limit: limit ?? null }),
  getMessages: (conversationId: string) =>
    invoke<
      Array<{
        id: string;
        role: string;
        content: string;
        timestamp: number;
        toolCalls: string | null;
        toolCallId: string | null;
        images: string | null;
      }>
    >('db_get_messages', { conversationId }),
  saveMessage: (args: {
    conversationId: string;
    id: string;
    role: string;
    content: string;
    timestamp: number;
    toolCalls: string | null;
    toolCallId: string | null;
    images: string | null;
  }) => invoke<void>('db_save_message', args),
  deleteConversation: (id: string) => invoke<void>('db_delete_conversation', { id }),
  searchMessages: (query: string) =>
    invoke<Array<{ id: string; role: string; content: string; timestamp: number }>>(
      'db_search_messages',
      { query },
    ),
  clearHistory: () => invoke<void>('db_clear_history'),
  memorySet: (key: string, value: string) => invoke<void>('memory_set', { key, value }),
  memoryGetAll: () => invoke<Array<[string, string]>>('memory_get_all'),
  memoryDelete: (key: string) => invoke<void>('memory_delete', { key }),
  logAction: (args: {
    id: string;
    tool: string;
    args: string;
    risk: string;
    status: string;
    startedAt: number;
    finishedAt: number | null;
    summary: string;
    result: string | null;
    error: string | null;
  }) => invoke<void>('log_action', args),
  exportActionLog: () => invoke<string>('export_action_log'),
  findOnScreen: (description: string) =>
    invoke<{ found: boolean; x: number; y: number; detail: string }>('find_on_screen', {
      description,
    }),
  captureScreen: () => invoke<string>('capture_screen'),
  clickMouse: (x: number, y: number, button?: string) =>
    invoke<void>('click_mouse', { x, y, button }),
};

export async function desktopPlatformInfo(): Promise<PlatformInfo> {
  const info = await desktop.platformInfo();
  return { ...info, isMobile: false, isDesktop: true };
}

/* ── Tool definitions ────────────────────────────────────────────── */

const ALL: Array<'desktop'> = ['desktop'];

export async function desktopTools(): Promise<ToolDefinition[]> {
  return [
    ...sharedTools(),
    ...visionTools(),

    /* ── Screen vision ── */
    defineTool({
      name: 'take_screenshot',
      description:
        'Capture the screen and return it as an image. Use this before any mouse or keyboard ' +
        'action so you can see where things are. Optionally pass a region to capture just part ' +
        'of the screen.',
      capability: 'screen',
      risk: 'low',
      platforms: ALL,
      parameters: {
        x: p.integer('Left edge of the region. Omit to capture the whole screen.'),
        y: p.integer('Top edge of the region.'),
        w: p.integer('Region width.'),
        h: p.integer('Region height.'),
      },
      async run(args) {
        const hasRegion = ['x', 'y', 'w', 'h'].every((k) => args[k] != null);
        const region = hasRegion
          ? {
              x: argNumber(args, 'x'),
              y: argNumber(args, 'y'),
              w: argNumber(args, 'w'),
              h: argNumber(args, 'h'),
            }
          : undefined;

        const dataUrl = await desktop.screenshot(region);
        // The image goes to the UI and to the vision model as structured data;
        // the model's text channel only needs to know it succeeded.
        return ok('Screenshot captured.', { image: dataUrl });
      },
    }),

    defineTool({
      name: 'get_screen_size',
      description: 'Get the screen resolution in pixels. Useful before positioning windows.',
      capability: 'screen',
      risk: 'low',
      platforms: ALL,
      parameters: {},
      async run() {
        const { width, height } = await desktop.screenSize();
        return `Screen is ${width}x${height} pixels.`;
      },
    }),

    /* ── Mouse ── */
    defineTool({
      name: 'move_mouse',
      description: 'Move the mouse cursor to absolute screen coordinates.',
      capability: 'mouse',
      risk: 'low',
      platforms: ALL,
      parameters: { x: p.integer('X coordinate.'), y: p.integer('Y coordinate.') },
      required: ['x', 'y'],
      async run(args) {
        await desktop.moveMouse(argNumber(args, 'x'), argNumber(args, 'y'));
        return `Moved the mouse to ${argNumber(args, 'x')}, ${argNumber(args, 'y')}.`;
      },
    }),

    defineTool({
      name: 'click',
      description:
        'Click the mouse. Pass x and y to click at a specific point, or omit them to click ' +
        'wherever the cursor already is. Take a screenshot first to find the coordinates.',
      capability: 'mouse',
      risk: 'medium',
      platforms: ALL,
      parameters: {
        x: p.integer('X coordinate. Omit to click at the current position.'),
        y: p.integer('Y coordinate.'),
        button: p.enum('Which button to click.', ['left', 'right', 'middle']),
      },
      async run(args) {
        const x = args.x != null ? argNumber(args, 'x') : undefined;
        const y = args.y != null ? argNumber(args, 'y') : undefined;
        const button = (argString(args, 'button', 'left') as 'left' | 'right' | 'middle') ?? 'left';
        await desktop.click(x, y, button);
        return x != null ? `Clicked at ${x}, ${y}.` : 'Clicked.';
      },
    }),

    defineTool({
      name: 'double_click',
      description: 'Double-click, typically to open a file or select a word.',
      capability: 'mouse',
      risk: 'medium',
      platforms: ALL,
      parameters: { x: p.integer('X coordinate.'), y: p.integer('Y coordinate.') },
      async run(args) {
        const x = args.x != null ? argNumber(args, 'x') : undefined;
        const y = args.y != null ? argNumber(args, 'y') : undefined;
        await desktop.doubleClick(x, y);
        return 'Double-clicked.';
      },
    }),

    defineTool({
      name: 'right_click',
      description: 'Right-click to open a context menu.',
      capability: 'mouse',
      risk: 'medium',
      platforms: ALL,
      parameters: { x: p.integer('X coordinate.'), y: p.integer('Y coordinate.') },
      async run(args) {
        const x = args.x != null ? argNumber(args, 'x') : undefined;
        const y = args.y != null ? argNumber(args, 'y') : undefined;
        await desktop.rightClick(x, y);
        return 'Right-clicked.';
      },
    }),

    defineTool({
      name: 'drag',
      description: 'Press the left button at one point, move to another, and release.',
      capability: 'mouse',
      risk: 'medium',
      platforms: ALL,
      parameters: {
        x1: p.integer('Start X.'),
        y1: p.integer('Start Y.'),
        x2: p.integer('End X.'),
        y2: p.integer('End Y.'),
      },
      required: ['x1', 'y1', 'x2', 'y2'],
      async run(args) {
        await desktop.drag(
          argNumber(args, 'x1'),
          argNumber(args, 'y1'),
          argNumber(args, 'x2'),
          argNumber(args, 'y2'),
        );
        return 'Drag complete.';
      },
    }),

    defineTool({
      name: 'scroll',
      description: 'Scroll the window under the cursor.',
      capability: 'mouse',
      risk: 'low',
      platforms: ALL,
      parameters: {
        direction: p.enum('Scroll direction.', ['up', 'down', 'left', 'right']),
        amount: p.integer('Number of scroll steps. Defaults to 3.'),
        x: p.integer('Move the pointer here first. Scrolling acts on whatever is under it.'),
        y: p.integer('Vertical position to scroll at.'),
      },
      required: ['direction'],
      async run(args) {
        const dir = argString(args, 'direction');
        await desktop.scroll(
          dir,
          args.amount != null ? argNumber(args, 'amount') : undefined,
          args.x != null ? argNumber(args, 'x') : undefined,
          args.y != null ? argNumber(args, 'y') : undefined,
        );
        return `Scrolled ${dir}.`;
      },
    }),

    defineTool({
      name: 'get_mouse_position',
      description: 'Read the current cursor position.',
      capability: 'mouse',
      risk: 'low',
      platforms: ALL,
      parameters: {},
      async run() {
        const { x, y } = await desktop.mousePosition();
        return `The cursor is at ${x}, ${y}.`;
      },
    }),

    /* ── Keyboard ── */
    defineTool({
      name: 'type_text',
      description:
        'Type text into whatever currently has keyboard focus. Click the target field first.',
      capability: 'keyboard',
      risk: 'medium',
      platforms: ALL,
      parameters: { text: p.string('The text to type.') },
      required: ['text'],
      async run(args) {
        const text = argString(args, 'text');
        await desktop.typeText(text);
        return `Typed ${text.length} characters.`;
      },
    }),

    defineTool({
      name: 'press_key',
      description:
        'Press a key or key combination, written with + between parts — for example ' +
        '"ctrl+s", "alt+tab", "escape", "ctrl+shift+t".',
      capability: 'keyboard',
      risk: 'medium',
      platforms: ALL,
      parameters: { combo: p.string('The key combination.') },
      required: ['combo'],
      async run(args) {
        const combo = argString(args, 'combo');
        await desktop.pressKey(combo);
        return `Pressed ${combo}.`;
      },
    }),

    /* ── Windows ── */
    defineTool({
      name: 'list_windows',
      description:
        'List every open window with its title, application and geometry. Use this to find ' +
        'out what is running before focusing or moving anything.',
      capability: 'screen',
      risk: 'low',
      platforms: ALL,
      parameters: {},
      async run() {
        const windows = await desktop.listWindows();
        if (windows.length === 0) return ok('No open windows.', { windows: [] });

        const lines = windows.map(
          (w) =>
            `${w.focused ? '* ' : '  '}${w.app || 'unknown'} — "${w.title}" ` +
            `(${w.w}x${w.h} at ${w.x},${w.y})`,
        );
        return ok(`${windows.length} open windows:\n${lines.join('\n')}`, { windows });
      },
    }),

    defineTool({
      name: 'focus_window',
      description:
        'Bring a window to the front. Match by window title or application name; a partial, ' +
        'case-insensitive match is enough.',
      capability: 'screen',
      risk: 'low',
      platforms: ALL,
      parameters: { target: p.string('Window title or application name.') },
      required: ['target'],
      async run(args) {
        const target = argString(args, 'target');
        await desktop.focusWindow(target);
        return `Focused ${target}.`;
      },
    }),

    defineTool({
      name: 'move_window',
      description: 'Move a window to a screen position.',
      capability: 'screen',
      risk: 'low',
      platforms: ALL,
      parameters: {
        target: p.string('Window title or application name.'),
        x: p.integer('New X position.'),
        y: p.integer('New Y position.'),
      },
      required: ['target', 'x', 'y'],
      async run(args) {
        await desktop.moveWindow(
          argString(args, 'target'),
          argNumber(args, 'x'),
          argNumber(args, 'y'),
        );
        return 'Window moved.';
      },
    }),

    defineTool({
      name: 'resize_window',
      description: 'Resize a window.',
      capability: 'screen',
      risk: 'low',
      platforms: ALL,
      parameters: {
        target: p.string('Window title or application name.'),
        w: p.integer('New width.'),
        h: p.integer('New height.'),
      },
      required: ['target', 'w', 'h'],
      async run(args) {
        await desktop.resizeWindow(
          argString(args, 'target'),
          argNumber(args, 'w'),
          argNumber(args, 'h'),
        );
        return 'Window resized.';
      },
    }),

    defineTool({
      name: 'close_window',
      description:
        'Close a window. Always confirm with the user first if the window may hold unsaved work.',
      capability: 'screen',
      risk: 'high',
      destructive: true,
      platforms: ALL,
      parameters: { target: p.string('Window title or application name.') },
      required: ['target'],
      async run(args) {
        const target = argString(args, 'target');
        await desktop.closeWindow(target);
        return `Closed ${target}.`;
      },
    }),

    defineTool({
      name: 'minimize_window',
      description: 'Minimise a window.',
      capability: 'screen',
      risk: 'low',
      platforms: ALL,
      parameters: { target: p.string('Window title or application name.') },
      required: ['target'],
      async run(args) {
        await desktop.minimizeWindow(argString(args, 'target'));
        return 'Window minimised.';
      },
    }),

    defineTool({
      name: 'maximize_window',
      description: 'Maximise a window.',
      capability: 'screen',
      risk: 'low',
      platforms: ALL,
      parameters: { target: p.string('Window title or application name.') },
      required: ['target'],
      async run(args) {
        await desktop.maximizeWindow(argString(args, 'target'));
        return 'Window maximised.';
      },
    }),

    defineTool({
      name: 'get_active_window',
      description: 'Get the window that currently has focus.',
      capability: 'screen',
      risk: 'low',
      platforms: ALL,
      parameters: {},
      async run() {
        const w = await desktop.activeWindow();
        return `Active window: ${w.app} — "${w.title}".`;
      },
    }),

    /* ── Apps ── */
    defineTool({
      name: 'launch_app',
      description:
        'Start an application by name, for example "firefox", "code" or "Spotify".',
      capability: 'system',
      risk: 'low',
      platforms: ALL,
      parameters: { name: p.string('Application name.') },
      required: ['name'],
      async run(args) {
        return await desktop.launchApp(argString(args, 'name'));
      },
    }),

    defineTool({
      name: 'kill_app',
      description:
        'Force-quit an application. Unsaved work will be lost, so confirm with the user first.',
      capability: 'system',
      risk: 'high',
      destructive: true,
      platforms: ALL,
      parameters: { name: p.string('Application or process name.') },
      required: ['name'],
      async run(args) {
        return await desktop.killApp(argString(args, 'name'));
      },
    }),

    defineTool({
      name: 'list_running_apps',
      description: 'List the applications currently running.',
      capability: 'system',
      risk: 'low',
      platforms: ALL,
      parameters: {},
      async run() {
        const apps = await desktop.listRunningApps();
        return `Running: ${apps.slice(0, 60).join(', ')}`;
      },
    }),

    defineTool({
      name: 'is_app_running',
      description: 'Check whether a particular application is running.',
      capability: 'system',
      risk: 'low',
      platforms: ALL,
      parameters: { name: p.string('Application name.') },
      required: ['name'],
      async run(args) {
        const name = argString(args, 'name');
        const running = await desktop.isAppRunning(name);
        return running ? `${name} is running.` : `${name} is not running.`;
      },
    }),

    /* ── Files ── */
    defineTool({
      name: 'read_file',
      description:
        'Read a text file. Paths may start with ~ for the home directory. Binary and very ' +
        'large files are rejected.',
      capability: 'files',
      risk: 'low',
      platforms: ALL,
      parameters: { path: p.string('File path.') },
      required: ['path'],
      async run(args) {
        const path = argString(args, 'path');
        const content = await desktop.readFile(path);
        return ok(content, { path });
      },
    }),

    defineTool({
      name: 'write_file',
      description:
        'Write text to a file, replacing anything already there. Parent directories are ' +
        'created as needed. Prefer append_file when adding to an existing file.',
      capability: 'files',
      risk: 'medium',
      destructive: true,
      platforms: ALL,
      parameters: {
        path: p.string('File path.'),
        content: p.string('The full new contents of the file.'),
      },
      required: ['path', 'content'],
      async run(args) {
        const path = await desktop.writeFile(argString(args, 'path'), argString(args, 'content'));
        return `Wrote ${path}.`;
      },
    }),

    defineTool({
      name: 'append_file',
      description: 'Append text to the end of a file, creating it if it does not exist.',
      capability: 'files',
      risk: 'low',
      platforms: ALL,
      parameters: {
        path: p.string('File path.'),
        content: p.string('Text to append.'),
      },
      required: ['path', 'content'],
      async run(args) {
        const path = await desktop.appendFile(argString(args, 'path'), argString(args, 'content'));
        return `Appended to ${path}.`;
      },
    }),

    defineTool({
      name: 'copy_file',
      description: 'Copy a file or directory.',
      capability: 'files',
      risk: 'low',
      platforms: ALL,
      parameters: { src: p.string('Source path.'), dst: p.string('Destination path.') },
      required: ['src', 'dst'],
      async run(args) {
        const dst = await desktop.copyFile(argString(args, 'src'), argString(args, 'dst'));
        return `Copied to ${dst}.`;
      },
    }),

    defineTool({
      name: 'move_file',
      description: 'Move or rename a file or directory.',
      capability: 'files',
      risk: 'medium',
      destructive: true,
      platforms: ALL,
      parameters: { src: p.string('Source path.'), dst: p.string('Destination path.') },
      required: ['src', 'dst'],
      async run(args) {
        const dst = await desktop.moveFile(argString(args, 'src'), argString(args, 'dst'));
        return `Moved to ${dst}.`;
      },
    }),

    defineTool({
      name: 'delete_file',
      description:
        'Move a file or directory to the system trash. This is reversible — it never deletes ' +
        'permanently. Always confirm with the user first.',
      capability: 'files',
      risk: 'high',
      destructive: true,
      platforms: ALL,
      parameters: { path: p.string('Path to delete.') },
      required: ['path'],
      async run(args) {
        const path = argString(args, 'path');
        const original = await desktop.deleteFile(path);
        return {
          ok: true,
          output: `Moved ${path} to the trash.`,
          undo: {
            kind: 'restore-file' as const,
            label: `Restore ${path}`,
            payload: { originalPath: original },
          },
        };
      },
    }),

    defineTool({
      name: 'list_directory',
      description: 'List the contents of a directory.',
      capability: 'files',
      risk: 'low',
      platforms: ALL,
      parameters: { path: p.string('Directory path. Use ~ for the home directory.') },
      required: ['path'],
      async run(args) {
        const path = argString(args, 'path');
        const entries = await desktop.listDirectory(path);
        if (entries.length === 0) return ok(`${path} is empty.`, { entries: [] });

        const lines = entries
          .slice(0, 200)
          .map((e) => (e.isDir ? `  ${e.name}/` : `  ${e.name} (${formatBytes(e.size)})`));
        const more = entries.length > 200 ? `\n… and ${entries.length - 200} more` : '';
        return ok(`${entries.length} entries in ${path}:\n${lines.join('\n')}${more}`, {
          entries,
        });
      },
    }),

    defineTool({
      name: 'create_directory',
      description: 'Create a directory, including any missing parents.',
      capability: 'files',
      risk: 'low',
      platforms: ALL,
      parameters: { path: p.string('Directory path.') },
      required: ['path'],
      async run(args) {
        const path = await desktop.createDirectory(argString(args, 'path'));
        return `Created ${path}.`;
      },
    }),

    defineTool({
      name: 'search_files',
      description:
        'Find files whose name contains the query, searching recursively from a directory ' +
        '(the home directory by default).',
      capability: 'files',
      risk: 'low',
      platforms: ALL,
      parameters: {
        query: p.string('Text to look for in file names.'),
        dir: p.string('Directory to search from. Defaults to the home directory.'),
      },
      required: ['query'],
      async run(args) {
        const query = argString(args, 'query');
        const dir = args.dir != null ? argString(args, 'dir') : undefined;
        const hits = await desktop.searchFiles(query, dir);
        if (hits.length === 0) return `No files matching "${query}".`;
        return `${hits.length} matches:\n${hits.slice(0, 80).join('\n')}`;
      },
    }),

    defineTool({
      name: 'get_file_info',
      description: 'Get size, timestamps and type for a path.',
      capability: 'files',
      risk: 'low',
      platforms: ALL,
      parameters: { path: p.string('File or directory path.') },
      required: ['path'],
      async run(args) {
        const info = await desktop.fileInfo(argString(args, 'path'));
        return ok(JSON.stringify(info, null, 2), info);
      },
    }),

    defineTool({
      name: 'open_file',
      description: 'Open a file or folder with the default application.',
      capability: 'files',
      risk: 'low',
      platforms: ALL,
      parameters: { path: p.string('Path to open.') },
      required: ['path'],
      async run(args) {
        const path = argString(args, 'path');
        await desktop.openFile(path);
        return `Opened ${path}.`;
      },
    }),

    defineTool({
      name: 'zip_files',
      description: 'Create a zip archive from files and/or directories.',
      capability: 'files',
      risk: 'low',
      platforms: ALL,
      parameters: {
        files: p.array('Paths to include.', p.string('A path.')),
        output: p.string('Path of the .zip file to create.'),
      },
      required: ['files', 'output'],
      async run(args) {
        const out = await desktop.zipFiles(argStringArray(args, 'files'), argString(args, 'output'));
        return `Created ${out}.`;
      },
    }),

    defineTool({
      name: 'unzip_file',
      description: 'Extract a zip archive into a directory.',
      capability: 'files',
      risk: 'low',
      platforms: ALL,
      parameters: {
        path: p.string('Path to the .zip file.'),
        dest: p.string('Directory to extract into.'),
      },
      required: ['path', 'dest'],
      async run(args) {
        const files = await desktop.unzipFile(argString(args, 'path'), argString(args, 'dest'));
        return `Extracted ${files.length} files.`;
      },
    }),

    /* ── Browser ── */
    defineTool({
      name: 'open_url',
      description:
        'Open a web page in a controllable browser. Do this before any other browser tool. ' +
        'Only http and https URLs are allowed.',
      capability: 'browser',
      risk: 'low',
      platforms: ALL,
      parameters: { url: p.string('The URL to open.') },
      required: ['url'],
      async run(args) {
        return await desktop.openUrl(argString(args, 'url'));
      },
    }),

    defineTool({
      name: 'get_page_text',
      description:
        'Read the visible text of the current page. This is how you read an article or check ' +
        'what a page says after navigating.',
      capability: 'browser',
      risk: 'low',
      platforms: ALL,
      parameters: {},
      async run() {
        const text = await desktop.pageText();
        return text.trim() || 'The page has no readable text.';
      },
    }),

    defineTool({
      name: 'get_current_url',
      description: 'Get the URL of the current page.',
      capability: 'browser',
      risk: 'low',
      platforms: ALL,
      parameters: {},
      async run() {
        return await desktop.currentUrl();
      },
    }),

    defineTool({
      name: 'get_page_title',
      description: 'Get the title of the current page.',
      capability: 'browser',
      risk: 'low',
      platforms: ALL,
      parameters: {},
      async run() {
        return await desktop.pageTitle();
      },
    }),

    defineTool({
      name: 'take_page_screenshot',
      description: 'Screenshot the browser page (not the whole screen).',
      capability: 'browser',
      risk: 'low',
      platforms: ALL,
      parameters: {},
      async run() {
        const image = await desktop.pageScreenshot();
        return ok('Captured the page.', { image });
      },
    }),

    defineTool({
      name: 'click_element',
      description:
        'Click something on the page. Pass a CSS selector, or the visible text of a link or ' +
        'button — for example "Sign in" or "#submit".',
      capability: 'browser',
      risk: 'medium',
      platforms: ALL,
      parameters: { selector: p.string('CSS selector or visible element text.') },
      required: ['selector'],
      async run(args) {
        return await desktop.clickElement(argString(args, 'selector'));
      },
    }),

    defineTool({
      name: 'type_in_element',
      description:
        'Type into a form field, identified by CSS selector or nearby visible text.',
      capability: 'browser',
      risk: 'medium',
      platforms: ALL,
      parameters: {
        selector: p.string('CSS selector or visible label text.'),
        text: p.string('Text to enter.'),
      },
      required: ['selector', 'text'],
      async run(args) {
        return await desktop.typeInElement(argString(args, 'selector'), argString(args, 'text'));
      },
    }),

    defineTool({
      name: 'fill_form',
      description: 'Fill several form fields at once.',
      capability: 'browser',
      risk: 'medium',
      platforms: ALL,
      parameters: {
        fields: p.array(
          'The fields to fill.',
          p.object('One field.', {
            selector: p.string('CSS selector or label text.'),
            value: p.string('Value to enter.'),
          }),
        ),
      },
      required: ['fields'],
      async run(args) {
        const raw = args.fields;
        if (!Array.isArray(raw)) return fail('`fields` must be an array');
        const fields = raw.map((f) => {
          const o = f as Record<string, unknown>;
          return { selector: String(o.selector ?? ''), value: String(o.value ?? '') };
        });
        return await desktop.fillForm(fields);
      },
    }),

    defineTool({
      name: 'scroll_page',
      description: 'Scroll the browser page up or down.',
      capability: 'browser',
      risk: 'low',
      platforms: ALL,
      parameters: {
        direction: p.enum('Direction to scroll.', ['up', 'down']),
        amount: p.integer('Pixels to scroll. Defaults to 600.'),
      },
      required: ['direction'],
      async run(args) {
        return await desktop.scrollPage(
          argString(args, 'direction'),
          args.amount != null ? argNumber(args, 'amount') : undefined,
        );
      },
    }),

    defineTool({
      name: 'browser_navigate',
      description: 'Go back, go forward, or reload the current page.',
      capability: 'browser',
      risk: 'low',
      platforms: ALL,
      parameters: { action: p.enum('What to do.', ['back', 'forward', 'reload']) },
      required: ['action'],
      async run(args) {
        const action = argString(args, 'action');
        if (action === 'back') return await desktop.goBack();
        if (action === 'forward') return await desktop.goForward();
        return await desktop.reloadPage();
      },
    }),

    defineTool({
      name: 'list_tabs',
      description: 'List the browser tabs that are currently open.',
      capability: 'browser',
      risk: 'low',
      platforms: ALL,
      parameters: {},
      async run() {
        const tabs = await desktop.listTabs();
        if (tabs.length === 0) return 'No open tabs.';
        return tabs.map((t, i) => `${i}: ${t.title} — ${t.url}`).join('\n');
      },
    }),

    defineTool({
      name: 'switch_tab',
      description: 'Switch to a tab by its index in list_tabs.',
      capability: 'browser',
      risk: 'low',
      platforms: ALL,
      parameters: { index: p.integer('Tab index.') },
      required: ['index'],
      async run(args) {
        return await desktop.switchTab(argNumber(args, 'index'));
      },
    }),

    defineTool({
      name: 'new_tab',
      description: 'Open a new browser tab, optionally at a URL.',
      capability: 'browser',
      risk: 'low',
      platforms: ALL,
      parameters: { url: p.string('URL to open in the new tab.') },
      async run(args) {
        return await desktop.newTab(args.url != null ? argString(args, 'url') : undefined);
      },
    }),

    defineTool({
      name: 'close_tab',
      description: 'Close the current browser tab.',
      capability: 'browser',
      risk: 'medium',
      platforms: ALL,
      parameters: {},
      async run() {
        return await desktop.closeTab();
      },
    }),

    defineTool({
      name: 'wait_for_element',
      description:
        'Wait until an element appears on the page. Use after an action that loads content.',
      capability: 'browser',
      risk: 'low',
      platforms: ALL,
      parameters: {
        selector: p.string('CSS selector or visible text.'),
        timeout: p.integer('Milliseconds to wait. Defaults to 10000.'),
      },
      required: ['selector'],
      async run(args) {
        return await desktop.waitForElement(
          argString(args, 'selector'),
          args.timeout != null ? argNumber(args, 'timeout') : undefined,
        );
      },
    }),

    defineTool({
      name: 'download_file',
      description: 'Download a URL to a local path.',
      capability: 'browser',
      risk: 'medium',
      platforms: ALL,
      parameters: {
        url: p.string('URL to download.'),
        dest: p.string('Where to save it.'),
      },
      required: ['url', 'dest'],
      async run(args) {
        return await desktop.downloadFile(argString(args, 'url'), argString(args, 'dest'));
      },
    }),

    /* ── System ── */
    defineTool({
      name: 'get_system_info',
      description: 'Get CPU, memory, disk, battery and uptime figures.',
      capability: 'system',
      risk: 'low',
      platforms: ALL,
      parameters: {},
      async run() {
        const i = await desktop.systemInfo();
        const lines = [
          `OS: ${i.os}`,
          `CPU: ${i.cpuUsage.toFixed(1)}% across ${i.cpuCount} cores`,
          `RAM: ${formatBytes(i.ramUsed)} of ${formatBytes(i.ramTotal)}`,
          `Disk: ${formatBytes(i.diskUsed)} of ${formatBytes(i.diskTotal)}`,
          i.battery != null
            ? `Battery: ${i.battery}%${i.charging ? ' (charging)' : ''}`
            : 'Battery: none',
          `Uptime: ${Math.floor(i.uptime / 3600)}h ${Math.floor((i.uptime % 3600) / 60)}m`,
        ];
        return ok(lines.join('\n'), i);
      },
    }),

    defineTool({
      name: 'set_volume',
      description: 'Set the system output volume, 0 to 100.',
      capability: 'system',
      risk: 'low',
      platforms: ALL,
      parameters: { level: p.integer('Volume level from 0 to 100.') },
      required: ['level'],
      async run(args) {
        const level = argNumber(args, 'level');
        await desktop.setVolume(level);
        return `Volume set to ${level}%.`;
      },
    }),

    defineTool({
      name: 'get_volume',
      description: 'Read the current system volume.',
      capability: 'system',
      risk: 'low',
      platforms: ALL,
      parameters: {},
      async run() {
        return `Volume is at ${await desktop.getVolume()}%.`;
      },
    }),

    defineTool({
      name: 'set_mute',
      description: 'Mute or unmute the system audio output.',
      capability: 'system',
      risk: 'low',
      platforms: ALL,
      parameters: { muted: p.boolean('True to mute, false to unmute.') },
      required: ['muted'],
      async run(args) {
        const muted = argBool(args, 'muted');
        await (muted ? desktop.mute() : desktop.unmute());
        return muted ? 'Muted.' : 'Unmuted.';
      },
    }),

    defineTool({
      name: 'set_brightness',
      description: 'Set screen brightness, 1 to 100.',
      capability: 'system',
      risk: 'low',
      platforms: ALL,
      parameters: { level: p.integer('Brightness from 1 to 100.') },
      required: ['level'],
      async run(args) {
        const level = argNumber(args, 'level');
        await desktop.setBrightness(level);
        return `Brightness set to ${level}%.`;
      },
    }),

    defineTool({
      name: 'lock_screen',
      description: 'Lock the screen.',
      capability: 'system',
      risk: 'medium',
      platforms: ALL,
      parameters: {},
      async run() {
        await desktop.lockScreen();
        return 'Screen locked.';
      },
    }),

    defineTool({
      name: 'power_action',
      description:
        'Sleep, shut down or restart the machine. Always confirm with the user before running this.',
      capability: 'system',
      risk: 'high',
      destructive: true,
      platforms: ALL,
      parameters: {
        action: p.enum('What to do.', ['sleep', 'shutdown', 'restart']),
        delay: p.integer('Delay in minutes before shutdown or restart.'),
      },
      required: ['action'],
      async run(args) {
        const action = argString(args, 'action');
        const delay = args.delay != null ? argNumber(args, 'delay') : undefined;
        if (action === 'sleep') {
          await desktop.sleepSystem();
          return 'Going to sleep.';
        }
        if (action === 'shutdown') {
          await desktop.shutdown(delay);
          return `Shutting down${delay ? ` in ${delay} minutes` : ''}.`;
        }
        await desktop.restart(delay);
        return `Restarting${delay ? ` in ${delay} minutes` : ''}.`;
      },
    }),

    defineTool({
      name: 'get_clipboard',
      description: 'Read the current clipboard contents.',
      capability: 'system',
      risk: 'low',
      platforms: ALL,
      parameters: {},
      async run() {
        const text = await desktop.getClipboard();
        return text || 'The clipboard is empty.';
      },
    }),

    defineTool({
      name: 'set_clipboard',
      description: 'Put text on the clipboard.',
      capability: 'system',
      risk: 'low',
      platforms: ALL,
      parameters: { text: p.string('Text to copy.') },
      required: ['text'],
      async run(args) {
        await desktop.setClipboard(argString(args, 'text'));
        return 'Copied to the clipboard.';
      },
    }),

    defineTool({
      name: 'get_clipboard_history',
      description: 'List recent clipboard entries, most recent first.',
      capability: 'system',
      risk: 'low',
      platforms: ALL,
      parameters: {},
      async run() {
        const history = await desktop.clipboardHistory();
        if (history.length === 0) return 'No clipboard history yet.';
        return history.map((h, i) => `${i + 1}. ${h.slice(0, 120)}`).join('\n');
      },
    }),

    defineTool({
      name: 'send_notification',
      description: 'Show a desktop notification.',
      capability: 'notifications',
      risk: 'low',
      platforms: ALL,
      parameters: {
        title: p.string('Notification title.'),
        body: p.string('Notification body.'),
      },
      required: ['title', 'body'],
      async run(args) {
        await desktop.notify(argString(args, 'title'), argString(args, 'body'));
        return 'Notification sent.';
      },
    }),

    defineTool({
      name: 'run_command',
      description:
        'Run a shell command and return its output. This is powerful and irreversible — ' +
        'prefer a dedicated tool when one exists, and always tell the user what you are about ' +
        'to run.',
      capability: 'terminal',
      risk: 'high',
      destructive: true,
      platforms: ALL,
      parameters: { cmd: p.string('The command line to run.') },
      required: ['cmd'],
      async run(args) {
        const out = await desktop.runCommand(argString(args, 'cmd'));
        const parts: string[] = [];
        if (out.stdout.trim()) parts.push(out.stdout.trim());
        if (out.stderr.trim()) parts.push(`stderr:\n${out.stderr.trim()}`);
        parts.push(`(exit code ${out.exit_code})`);
        return { ok: out.exit_code === 0, output: parts.join('\n'), data: out };
      },
    }),

    defineTool({
      name: 'list_processes',
      description: 'List running processes, heaviest by memory first.',
      capability: 'system',
      risk: 'low',
      platforms: ALL,
      parameters: {},
      async run() {
        const procs = await desktop.listProcesses();
        const lines = procs
          .slice(0, 40)
          .map((p) => `${p.pid}\t${p.name}\t${p.cpu.toFixed(1)}%\t${formatBytes(p.memory)}`);
        return ok(`pid\tname\tcpu\tmemory\n${lines.join('\n')}`, procs);
      },
    }),

    defineTool({
      name: 'kill_process',
      description: 'Kill a process by pid or name. Confirm with the user first.',
      capability: 'system',
      risk: 'high',
      destructive: true,
      platforms: ALL,
      parameters: { target: p.string('Process id or name.') },
      required: ['target'],
      async run(args) {
        return await desktop.killProcess(argString(args, 'target'));
      },
    }),

    /* ── Packages & services ── */
    defineTool({
      name: 'install_package',
      description:
        'Install a system package using the machine\'s package manager. Requires administrator ' +
        'rights and will raise a password prompt. Always confirm with the user first.',
      capability: 'packages',
      risk: 'high',
      destructive: true,
      platforms: ALL,
      parameters: { name: p.string('Package name.') },
      required: ['name'],
      async run(args) {
        return await desktop.installPackage(argString(args, 'name'));
      },
    }),

    defineTool({
      name: 'remove_package',
      description: 'Remove a system package. Confirm with the user first.',
      capability: 'packages',
      risk: 'high',
      destructive: true,
      platforms: ALL,
      parameters: { name: p.string('Package name.') },
      required: ['name'],
      async run(args) {
        return await desktop.removePackage(argString(args, 'name'));
      },
    }),

    defineTool({
      name: 'list_installed_packages',
      description: 'List installed system packages.',
      capability: 'packages',
      risk: 'low',
      platforms: ALL,
      parameters: {},
      async run() {
        const pkgs = await desktop.listInstalledPackages();
        return `${pkgs.length} packages installed. First 100:\n${pkgs.slice(0, 100).join(', ')}`;
      },
    }),

    defineTool({
      name: 'update_system',
      description:
        'Update all system packages. This can take a long time and needs administrator rights. ' +
        'Always confirm with the user first.',
      capability: 'packages',
      risk: 'high',
      destructive: true,
      platforms: ALL,
      parameters: {},
      async run() {
        return await desktop.updateSystem();
      },
    }),

    defineTool({
      name: 'manage_service',
      description: 'Start, stop, restart or check a systemd service.',
      capability: 'system',
      risk: 'high',
      destructive: true,
      platforms: ALL,
      parameters: {
        name: p.string('Service name, e.g. "docker".'),
        action: p.enum('What to do.', ['start', 'stop', 'restart', 'status']),
      },
      required: ['name', 'action'],
      async run(args) {
        return await desktop.manageService(argString(args, 'name'), argString(args, 'action'));
      },
    }),
  ];
}
