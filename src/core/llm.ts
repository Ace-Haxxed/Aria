/**
 * LLM client. One streaming interface, six wire formats behind it.
 *
 * Every provider gets the same input — our `Message[]` plus a tool list — and
 * yields the same `LLMChunk` stream, so `agent.ts` never branches on provider.
 */
import type { LLMChunk, LLMConfig, LLMProvider, Message, ToolCall, ToolSchema } from './types';
import { readLines, readSSE } from '@/lib/http';
import {
  streamProvider,
  streamProviderViaFetch,
  transportUsesRust,
  type ExplainedResponse,
  type ProviderStreamParams,
} from '@/lib/llmTransport';
import { acquireSlot } from './rateLimiter';
import { toJsonSchema } from './tools/base';
import { isTauri } from '@/platform';
import { uid } from '@/lib/utils';

export interface ProviderSpec {
  id: LLMProvider;
  label: string;
  /** Empty when the endpoint is local or the user supplies the URL. */
  needsApiKey: boolean;
  defaultModel: string;
  defaultVisionModel: string;
  models: string[];
  baseUrl: string;
  hint: string;
}

export const PROVIDERS: ProviderSpec[] = [
  {
    id: 'builtin',
    label: 'Built-in (runs inside ARIA)',
    needsApiKey: false,
    defaultModel: 'phi-3.5-mini',
    defaultVisionModel: 'phi-3.5-mini',
    models: [],
    baseUrl: '',
    hint: 'Runs in this app, on this machine. No server, no account, no internet after the one-time model download.',
  },
  {
    id: 'ollama',
    label: 'Ollama (local, offline)',
    needsApiKey: false,
    defaultModel: 'llama3.1:8b',
    defaultVisionModel: 'llava',
    models: ['llama3.1:8b', 'llama3.2', 'qwen2.5:7b', 'mistral', 'phi3', 'llava', 'gemma2'],
    baseUrl: 'http://localhost:11434',
    hint: 'Runs entirely on this machine. Install from ollama.com, then `ollama pull llama3.1:8b`.',
  },
  {
    id: 'groq',
    label: 'Groq (fastest cloud, free tier)',
    needsApiKey: true,
    // The 8B model is the free-tier default: it has five times the daily token
    // allowance of the 70B (500K vs 100K) and fourteen times the requests
    // (14,400 vs 1,000), which are the ceilings a free key actually hits.
    defaultModel: 'llama-3.1-8b-instant',
    defaultVisionModel: 'llama-3.1-8b-instant',
    // Only models confirmed present on Groq. `mixtral-8x7b-32768`,
    // `llama-3.1-70b-versatile` and the `llama3-groq-*-tool-use` fine-tunes
    // are on Groq's own decommissioned list and 404 on first use.
    models: [
      'llama-3.1-8b-instant',
      'llama-3.3-70b-versatile',
      'llama3-8b-8192',
      'llama3-70b-8192',
    ],
    baseUrl: 'https://api.groq.com/openai/v1',
    hint: 'Free API key from console.groq.com. Fastest option by a wide margin. The 8B model has the most generous free allowance.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    needsApiKey: true,
    defaultModel: 'gpt-4o',
    defaultVisionModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-mini'],
    baseUrl: 'https://api.openai.com/v1',
    hint: 'API key from platform.openai.com.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    needsApiKey: true,
    defaultModel: 'claude-sonnet-5',
    defaultVisionModel: 'claude-sonnet-5',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    baseUrl: 'https://api.anthropic.com/v1',
    hint: 'API key from console.anthropic.com.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    needsApiKey: true,
    // Gemini 1.5 was retired by Google: `models/gemini-1.5-pro is not found
    // for API version v1beta` is what a request for it returns now. Every name
    // below was checked against Google's published model list.
    defaultModel: 'gemini-2.5-flash',
    // Every Gemini model is multimodal, so the text model reads images too.
    defaultVisionModel: 'gemini-2.5-flash',
    models: [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-3.5-flash',
      'gemini-3.1-pro',
      'gemini-2.0-flash',
    ],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    hint: 'API key from aistudio.google.com.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (one key, every model)',
    needsApiKey: true,
    // A free model by default: an OpenRouter key works without credits on the
    // `:free` tier, so the app is usable the moment a key is pasted.
    defaultModel: 'google/gemma-4-26b-a4b-it:free',
    defaultVisionModel: 'google/gemini-2.5-flash',
    models: [
      'google/gemma-4-26b-a4b-it:free',
      'nvidia/nemotron-3.5-lightning:free',
      'anthropic/claude-sonnet-4.5',
      'openai/gpt-4o',
      'google/gemini-2.5-pro',
      'meta-llama/llama-3.3-70b-instruct',
    ],
    baseUrl: 'https://openrouter.ai/api/v1',
    hint: 'One key for models from every provider. Free tier needs no credits. Key from openrouter.ai/keys.',
  },
  {
    id: 'bytez',
    label: 'Bytez',
    needsApiKey: true,
    defaultModel: 'google/gemma-2-9b-it',
    defaultVisionModel: 'google/gemma-2-9b-it',
    // Bytez hosts thousands of HuggingFace models and publishes no short
    // list, so the picker is a free-text field rather than a dropdown of
    // names that would be stale within a week.
    models: [],
    // Bytez's OpenAI-compatible surface lives under this path, not at /v1.
    baseUrl: 'https://api.bytez.com/models/v2/openai/v1',
    hint: 'Serverless HuggingFace models, OpenAI-compatible. Key from bytez.com. Enter a model id exactly as it appears in the Bytez catalog — an id they do not host is rejected with a 404.',
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible endpoint',
    needsApiKey: false,
    defaultModel: 'local-model',
    defaultVisionModel: 'local-model',
    models: [],
    baseUrl: '',
    hint: 'Any server that speaks the OpenAI chat completions API — vLLM, LM Studio, llama.cpp.',
  },
  {
    id: 'on-device',
    label: 'On-device (mobile, llama.cpp)',
    needsApiKey: false,
    defaultModel: 'phi-3-mini',
    defaultVisionModel: 'phi-3-mini',
    models: ['phi-3-mini', 'gemma-2b'],
    baseUrl: 'http://localhost:8080/v1',
    hint: 'Runs on the phone itself. Download the model over Wi-Fi in Settings.',
  },
];

export function providerSpec(id: LLMProvider): ProviderSpec {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

export function resolveBaseUrl(config: LLMConfig): string {
  const spec = providerSpec(config.provider);
  const url = config.baseUrl?.trim() || spec.baseUrl;
  return url.replace(/\/+$/, '');
}

/* ── Message conversion ──────────────────────────────────────────── */

/** Split a data URL into its media type and payload. */
function splitDataUrl(dataUrl: string): { mediaType: string; data: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) return { mediaType: 'image/png', data: dataUrl };
  return { mediaType: match[1], data: match[2] };
}

type OpenAIMessage = Record<string, unknown>;

function toOpenAIMessages(messages: Message[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      continue;
    }

    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });
      continue;
    }

    if (m.images?.length && m.role === 'user') {
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: m.content },
          ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      });
      continue;
    }

    out.push({ role: m.role, content: m.content });
  }

  return out;
}

function toOpenAITools(tools: ToolSchema[]) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: toJsonSchema(t),
    },
  }));
}

/* ── Transport ───────────────────────────────────────────────────── */

/**
 * Open a streaming request, through Rust on the desktop and directly on mobile.
 *
 * The `fallback` describes the same request as a plain HTTP call, for the two
 * shells that have no Rust side: the Capacitor WebView and `vite dev` in a
 * browser. Both talk to LLM APIs that send permissive CORS headers, so a
 * direct fetch is fine there — it is only the Tauri WebView that cannot.
 */
async function openStream(
  params: ProviderStreamParams,
  fallback: { url: string; body: unknown; headers: Record<string, string> },
): Promise<ExplainedResponse> {
  if (transportUsesRust()) return await streamProvider(params);
  return await streamProviderViaFetch(fallback.url, fallback.body, fallback.headers, params.signal);
}

/** Reports a countdown while a rate limit is waited out. */
export type WaitReporter = (secondsRemaining: number) => void;

let waitReporter: WaitReporter | null = null;

/**
 * Register a callback for rate-limit countdowns.
 *
 * Being rate limited is a wait, not a failure — the request will succeed, just
 * not yet. Showing a ticking countdown says that; showing the provider's error
 * text asks the user to solve a problem that resolves itself.
 */
export function onRateLimitWait(reporter: WaitReporter | null): void {
  waitReporter = reporter;
}

/**
 * Transient failures worth a second attempt.
 *
 * A 500 or a dropped connection is usually a blip that succeeds on retry; a
 * 401 or a 404 is a considered answer that will be identical next time, so
 * retrying those only delays telling the user what is wrong.
 */
function isTransient(status: number): boolean {
  return status === 0 || status === 408 || status === 502 || status === 503 || status === 504;
}

/** Attempts for a transient failure, including the first. */
const MAX_TRANSIENT_ATTEMPTS = 3;

/** Longest we will sit on a rate limit before giving the user the choice. */
const MAX_WAIT_SECONDS = 90;
/** How many times to wait and retry within one request. */
const MAX_RATE_LIMIT_RETRIES = 2;

/**
 * Open a stream, waiting out rate limits rather than failing on them.
 *
 * The provider states exactly how long to wait, so the retry lands as the
 * window reopens. Anything longer than a minute and a half is reported instead
 * of waited out — at that point the user should be able to choose another
 * provider rather than watch a timer.
 */
async function openStreamWithRetry(
  params: ProviderStreamParams,
  fallback: { url: string; body: unknown; headers: Record<string, string> },
): Promise<ExplainedResponse> {
  // Hold the request until this model has a free slot. Providers meter by
  // model, and being refused costs the same quota as succeeding — so it is
  // better to wait a moment here than to spend an attempt being rejected.
  try {
    await acquireSlot(params.provider, params.model, params.signal);
  } catch (e) {
    // Cancelled or abandoned while queued; nothing was sent.
    const message = e instanceof Error ? e.message : String(e);
    if (message === 'cancelled') {
      return explainedWait(new Response(null, { status: 499 }) as ExplainedResponse, '');
    }
    return explainedWait(new Response(null, { status: 408 }) as ExplainedResponse, message);
  }

  let transientAttempts = 0;

  for (let attempt = 0; ; attempt++) {
    const response = await openStream(params, fallback);

    // A blip rather than an answer: back off and try again, doubling each
    // time so a struggling provider is not hammered.
    if (
      !response.ok &&
      response.ariaRetryAfter == null &&
      isTransient(response.status) &&
      transientAttempts < MAX_TRANSIENT_ATTEMPTS - 1
    ) {
      transientAttempts++;
      const backoff = 500 * 2 ** (transientAttempts - 1);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      if (params.signal?.aborted) return response;
      continue;
    }

    const wait = response.ariaRetryAfter;
    if (wait == null || attempt >= MAX_RATE_LIMIT_RETRIES) return response;

    if (wait > MAX_WAIT_SECONDS) {
      return explainedWait(
        response,
        `${providerSpec((params.label ?? params.provider) as LLMProvider).label.split(' (')[0]} is rate limited for ` +
          `another ${Math.ceil(wait / 60)} minutes. Switch provider in Settings → API Keys, or try again later.`,
      );
    }

    // A second of headroom: retrying at the exact boundary often trips the
    // same limit again.
    const total = Math.ceil(wait) + 1;
    for (let remaining = total; remaining > 0; remaining--) {
      if (params.signal?.aborted) return response;
      waitReporter?.(remaining);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    waitReporter?.(0);
  }
}

function explainedWait(response: ExplainedResponse, message: string): ExplainedResponse {
  return Object.assign(response, { ariaError: message });
}

/* ── OpenAI-compatible streaming (OpenAI, Groq, custom, on-device) ── */

async function* streamOpenAICompatible(
  config: LLMConfig,
  messages: Message[],
  tools: ToolSchema[],
  signal?: AbortSignal,
): AsyncGenerator<LLMChunk> {
  const base = resolveBaseUrl(config);
  const headers: Record<string, string> = {};
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const converted = toOpenAIMessages(messages);
  const wireTools = tools.length > 0 ? toOpenAITools(tools) : undefined;

  const body: Record<string, unknown> = {
    model: config.model,
    messages: converted,
    stream: true,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
  };
  if (wireTools) {
    body.tools = wireTools;
    body.tool_choice = 'auto';
  }

  // Groq has its own command so its errors can name it; everything else
  // OpenAI-shaped — including custom endpoints and on-device servers — goes
  // through the OpenAI command, which omits the bearer token when there is no
  // key rather than sending an empty one.
  //
  // The built-in model reuses this path because its input is the same
  // {role, content} list; only the transport underneath differs.
  // OpenRouter and Bytez both speak the OpenAI chat-completions API, so they
  // ride the same transport — only the base URL and key differ.
  const transport =
    config.provider === 'groq'
      ? 'groq'
      : config.provider === 'builtin'
        ? 'builtin'
        : 'openai';

  const res = await openStreamWithRetry(
    {
      provider: transport,
      model: config.model,
      messages: converted,
      apiKey: config.apiKey,
      baseUrl: base,
      // Bytez documents the bare key, but its OpenAI-compatible endpoint may
      // want Bearer. Validation tries both and remembers which one the service
      // actually accepted, so this uses the proven answer rather than a guess.
      authStyle: config.provider === 'bytez' ? await bytezAuthStyle() : 'bearer',
      // The transport is shared; this keeps the real provider's name on any
      // error it produces.
      label: config.provider,
      // The built-in model is small and has no grammar constraints, so it
      // cannot be relied on to emit well-formed tool calls. Offering it tools
      // it will mangle produces confident nonsense; omitting them means it
      // answers in prose and the agent loop simply gets no tool call.
      tools: transport === 'builtin' ? undefined : wireTools,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      signal,
    },
    { url: `${base}/chat/completions`, body, headers },
  );
  if (!res.ok) {
    yield { error: await describeHttpError(res, config.provider), done: true };
    return;
  }

  // Tool calls stream in fragments keyed by index; assemble them as we go.
  const pending = new Map<number, { id: string; name: string; args: string }>();

  for await (const payload of readSSE(res)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }

    const choice = (parsed.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) continue;

    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) continue;

    if (typeof delta.content === 'string' && delta.content) {
      yield { delta: delta.content };
    }

    const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const index = typeof tc.index === 'number' ? tc.index : 0;
        const fn = tc.function as Record<string, unknown> | undefined;

        const entry = pending.get(index) ?? { id: '', name: '', args: '' };
        if (typeof tc.id === 'string' && tc.id) entry.id = tc.id;
        if (typeof fn?.name === 'string' && fn.name) entry.name = fn.name;
        if (typeof fn?.arguments === 'string') entry.args += fn.arguments;
        pending.set(index, entry);
      }
    }

    // `finish_reason` marks the point at which every fragment has arrived.
    if (choice.finish_reason) {
      for (const entry of pending.values()) {
        const call = finaliseToolCall(entry.id, entry.name, entry.args);
        if (call) yield { toolCall: call };
      }
      pending.clear();
    }
  }

  // Some gateways close the stream without ever sending finish_reason.
  for (const entry of pending.values()) {
    const call = finaliseToolCall(entry.id, entry.name, entry.args);
    if (call) yield { toolCall: call };
  }

  yield { done: true };
}

function finaliseToolCall(id: string, name: string, args: string): ToolCall | null {
  if (!name) return null;
  let parsed: Record<string, unknown> = {};
  if (args.trim()) {
    try {
      parsed = JSON.parse(args) as Record<string, unknown>;
    } catch {
      // A malformed argument blob is better sent through as empty than dropped:
      // the tool reports what is missing and the model corrects itself.
      parsed = {};
    }
  }
  return { id: id || uid('call'), name, args: parsed };
}

/* ── Ollama ──────────────────────────────────────────────────────── */

async function* streamOllama(
  config: LLMConfig,
  messages: Message[],
  tools: ToolSchema[],
  signal?: AbortSignal,
): AsyncGenerator<LLMChunk> {
  const base = resolveBaseUrl(config);

  const ollamaMessages = messages.map((m) => {
    const base: Record<string, unknown> = { role: m.role, content: m.content };
    // Ollama wants bare base64, not a data URL.
    if (m.images?.length) {
      base.images = m.images.map((img) => splitDataUrl(img).data);
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      base.tool_calls = m.toolCalls.map((tc) => ({
        function: { name: tc.name, arguments: tc.args },
      }));
    }
    return base;
  });

  const wireTools = tools.length > 0 ? toOpenAITools(tools) : undefined;
  const body: Record<string, unknown> = {
    model: config.model,
    messages: ollamaMessages,
    stream: true,
    options: {
      temperature: config.temperature,
      num_predict: config.maxTokens,
    },
  };
  if (wireTools) body.tools = wireTools;

  let res: ExplainedResponse;
  try {
    res = await openStream(
      {
        provider: 'ollama',
        model: config.model,
        messages: ollamaMessages,
        baseUrl: base,
        tools: wireTools,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        signal,
      },
      { url: `${base}/api/chat`, body, headers: {} },
    );
  } catch {
    yield {
      error:
        'Ollama is not responding on this machine. ARIA can start it for you from ' +
        'Settings → AI, or you can switch to a cloud provider there.',
      done: true,
    };
    return;
  }

  if (!res.ok) {
    yield { error: await describeHttpError(res, 'ollama'), done: true };
    return;
  }

  for await (const line of readLines(res)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof parsed.error === 'string') {
      yield { error: parsed.error, done: true };
      return;
    }

    const message = parsed.message as Record<string, unknown> | undefined;
    if (message) {
      if (typeof message.content === 'string' && message.content) {
        yield { delta: message.content };
      }

      const calls = message.tool_calls as Array<Record<string, unknown>> | undefined;
      for (const tc of calls ?? []) {
        const fn = tc.function as Record<string, unknown> | undefined;
        if (typeof fn?.name !== 'string') continue;
        // Ollama already returns arguments as an object, not a JSON string.
        const args =
          typeof fn.arguments === 'string'
            ? (JSON.parse(fn.arguments || '{}') as Record<string, unknown>)
            : ((fn.arguments as Record<string, unknown>) ?? {});
        yield { toolCall: { id: uid('call'), name: fn.name, args } };
      }
    }

    if (parsed.done === true) break;
  }

  yield { done: true };
}

/* ── Anthropic ───────────────────────────────────────────────────── */

async function* streamAnthropic(
  config: LLMConfig,
  messages: Message[],
  tools: ToolSchema[],
  signal?: AbortSignal,
): AsyncGenerator<LLMChunk> {
  const base = resolveBaseUrl(config);

  // Anthropic takes the system prompt as a top-level field, not a message.
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const converted: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      converted.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content },
        ],
      });
      continue;
    }

    if (m.role === 'assistant' && m.toolCalls?.length) {
      const content: Array<Record<string, unknown>> = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      converted.push({ role: 'assistant', content });
      continue;
    }

    if (m.images?.length && m.role === 'user') {
      const content: Array<Record<string, unknown>> = [];
      for (const img of m.images) {
        const { mediaType, data } = splitDataUrl(img);
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data },
        });
      }
      if (m.content) content.push({ type: 'text', text: m.content });
      converted.push({ role: 'user', content });
      continue;
    }

    converted.push({ role: m.role, content: m.content });
  }

  const wireTools =
    tools.length > 0
      ? tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: toJsonSchema(t),
        }))
      : undefined;

  const body: Record<string, unknown> = {
    model: config.model,
    messages: converted,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    stream: true,
  };
  if (system) body.system = system;
  if (wireTools) body.tools = wireTools;

  const res = await openStream(
    {
      provider: 'anthropic',
      model: config.model,
      messages: converted,
      apiKey: config.apiKey,
      baseUrl: base,
      system,
      tools: wireTools,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      signal,
    },
    {
      url: `${base}/messages`,
      body,
      headers: {
        'x-api-key': config.apiKey ?? '',
        'anthropic-version': '2023-06-01',
        // Only needed on the mobile/browser path, where the request really
        // does originate from a WebView. The Rust transport is a server-side
        // client and does not need it.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    },
  );

  if (!res.ok) {
    yield { error: await describeHttpError(res, 'anthropic'), done: true };
    return;
  }

  // tool_use blocks stream their input as partial JSON across many events.
  let currentTool: { id: string; name: string; json: string } | null = null;

  for await (const payload of readSSE(res)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }

    switch (event.type) {
      case 'content_block_start': {
        const block = event.content_block as Record<string, unknown> | undefined;
        if (block?.type === 'tool_use') {
          currentTool = {
            id: String(block.id ?? uid('call')),
            name: String(block.name ?? ''),
            json: '',
          };
        }
        break;
      }
      case 'content_block_delta': {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          yield { delta: delta.text };
        } else if (delta?.type === 'input_json_delta' && currentTool) {
          currentTool.json += String(delta.partial_json ?? '');
        }
        break;
      }
      case 'content_block_stop': {
        if (currentTool) {
          const call = finaliseToolCall(currentTool.id, currentTool.name, currentTool.json);
          if (call) yield { toolCall: call };
          currentTool = null;
        }
        break;
      }
      case 'message_delta': {
        const usage = event.usage as Record<string, unknown> | undefined;
        if (usage) {
          yield {
            usage: {
              promptTokens: Number(usage.input_tokens ?? 0),
              completionTokens: Number(usage.output_tokens ?? 0),
            },
          };
        }
        break;
      }
      case 'error': {
        const err = event.error as Record<string, unknown> | undefined;
        yield { error: String(err?.message ?? 'the model returned an error'), done: true };
        return;
      }
    }
  }

  yield { done: true };
}

/* ── Gemini ──────────────────────────────────────────────────────── */

/**
 * Shown only if a tool 400 survives the signature round-trip.
 *
 * Reaching this means Gemini rejected a call ARIA replayed correctly, so the
 * useful advice is still to move provider rather than to keep retrying.
 */
export const GEMINI_TOOLS_UNSUPPORTED =
  "Gemini thinking models don't support tools — switch to OpenRouter or Groq for agent tasks";

/**
 * Move the active provider off Gemini, to whichever agent-capable provider
 * already has a key.
 *
 * Returns whether it actually switched. OpenRouter is preferred over Groq only
 * because its free catalogue means a key there is more likely to have credit.
 * Nothing is switched if neither has a key — silently landing the user on a
 * provider that cannot authenticate would replace one dead turn with another.
 */
async function switchAwayFromGemini(): Promise<boolean> {
  try {
    const { useKeys } = await import('@/store/keys');
    const state = useKeys.getState();
    const target = (['openrouter', 'groq'] as const).find((p) => state.keys[p]);
    if (!target) return false;
    await state.setActive(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this a 400 about the missing thought signature?
 *
 * Matched loosely: Google has reworded it once already, and the failure is
 * specific enough that a false positive is not a real risk.
 */
export function isGeminiToolError(status: number, detail: string): boolean {
  if (status !== 400) return false;
  const text = detail.toLowerCase();
  return (
    text.includes('thought_signature') ||
    text.includes('thoughtsignature') ||
    (text.includes('function') && text.includes('not supported'))
  );
}

async function* streamGemini(
  config: LLMConfig,
  messages: Message[],
  tools: ToolSchema[],
  signal?: AbortSignal,
): AsyncGenerator<LLMChunk> {
  const base = resolveBaseUrl(config);

  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const contents: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.toolCallId ?? 'tool',
              response: { result: m.content },
            },
          },
        ],
      });
      continue;
    }

    // Gemini calls the assistant "model".
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts: Array<Record<string, unknown>> = [];

    if (m.content) parts.push({ text: m.content });
    for (const img of m.images ?? []) {
      const { mediaType, data } = splitDataUrl(img);
      parts.push({ inlineData: { mimeType: mediaType, data } });
    }
    for (const tc of m.toolCalls ?? []) {
      // Echo the signature back exactly as it arrived. Without it a thinking
      // model answers 400 on the turn *after* the first tool call, which is
      // every agent task that does more than one step.
      parts.push({
        functionCall: { name: tc.name, args: tc.args },
        ...(tc.signature ? { thoughtSignature: tc.signature } : {}),
      });
    }

    if (parts.length > 0) contents.push({ role, parts });
  }

  // Every Gemini model gets tools. Thinking models used to be excluded here,
  // because replaying a `functionCall` without its `thoughtSignature` 400s on
  // the second turn — that signature is now carried through, so the exclusion
  // would only cost capability. The 400 handler below stays as a safety net.
  const declarations =
    tools.length > 0
      ? tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: toJsonSchema(t),
        }))
      : undefined;

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: config.temperature,
      maxOutputTokens: config.maxTokens,
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (declarations) body.tools = [{ functionDeclarations: declarations }];

  const url =
    `${base}/models/${encodeURIComponent(config.model)}:streamGenerateContent` +
    `?alt=sse&key=${encodeURIComponent(config.apiKey ?? '')}`;

  const res = await openStream(
    {
      provider: 'gemini',
      model: config.model,
      // Rust wraps these in `{ functionDeclarations: … }`, so the bare
      // declaration list is what crosses the boundary.
      messages: contents,
      apiKey: config.apiKey,
      baseUrl: base,
      system,
      tools: declarations,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      signal,
    },
    { url, body, headers: {} },
  );
  if (!res.ok) {
    const detail = await describeHttpError(res, 'gemini');
    // A tool 400 that arrives despite the guard above means the model reasons
    // but does not look like it does. Move to a provider that can actually run
    // the task rather than failing the turn — the user asked for the work, not
    // for a lesson in which model supports what.
    if (isGeminiToolError(res.status, detail)) {
      const switched = await switchAwayFromGemini();
      yield {
        error: switched
          ? `${GEMINI_TOOLS_UNSUPPORTED}. Switched to OpenRouter — send that again.`
          : `${GEMINI_TOOLS_UNSUPPORTED}. Add an OpenRouter or Groq key in Settings → Keys.`,
        done: true,
      };
      return;
    }
    yield { error: detail, done: true };
    return;
  }

  for await (const payload of readSSE(res)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }

    const candidate = (parsed.candidates as Array<Record<string, unknown>> | undefined)?.[0];
    const content = candidate?.content as Record<string, unknown> | undefined;
    const parts = content?.parts as Array<Record<string, unknown>> | undefined;

    for (const part of parts ?? []) {
      if (typeof part.text === 'string' && part.text) {
        yield { delta: part.text };
      }
      const fc = part.functionCall as Record<string, unknown> | undefined;
      if (fc && typeof fc.name === 'string') {
        // The signature sits on the *part*, not inside `functionCall`. It has
        // to survive the round trip or the next turn is rejected — see
        // `isGeminiToolError`. Newer payloads have also carried it inside the
        // call itself, so both spellings are accepted.
        const signature =
          typeof part.thoughtSignature === 'string'
            ? part.thoughtSignature
            : typeof fc.thoughtSignature === 'string'
              ? fc.thoughtSignature
              : undefined;

        yield {
          toolCall: {
            id: uid('call'),
            name: fc.name,
            args: (fc.args as Record<string, unknown>) ?? {},
            ...(signature ? { signature } : {}),
          },
        };
      }
    }
  }

  yield { done: true };
}

/* ── Errors ──────────────────────────────────────────────────────── */

/** Turn an HTTP failure into something the user can act on. */
async function describeHttpError(res: ExplainedResponse, provider: LLMProvider): Promise<string> {
  // The Rust transport already knows the provider, the status and the body,
  // and builds a sentence that names the fix. Re-deriving one here would only
  // wrap a good message in a worse one.
  if (res.ariaError) return res.ariaError;

  let detail = '';
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const err = parsed.error as Record<string, unknown> | string | undefined;
    detail = typeof err === 'string' ? err : String(err?.message ?? text.slice(0, 300));
  } catch {
    detail = res.statusText;
  }

  if (res.status === 401 || res.status === 403) {
    return `${provider} rejected the API key. Check it in Settings → AI. (${detail})`;
  }
  if (res.status === 404) {
    return `${provider} does not have that model. Pick another in Settings → AI. (${detail})`;
  }
  if (res.status === 429) {
    return `${provider} is rate limiting. Wait a moment and try again. (${detail})`;
  }
  if (res.status >= 500) {
    return `${provider} had a server error. (${detail})`;
  }
  return `${provider} returned HTTP ${res.status}: ${detail}`;
}

/* ── Public entry point ──────────────────────────────────────────── */

/**
 * The Authorization scheme Bytez accepted when its key was validated.
 *
 * Falls back to the documented bare-key form, which is what validation tries
 * first anyway. Cached because it cannot change while the app is running.
 */
let bytezStyle: 'bearer' | 'raw' | null = null;

async function bytezAuthStyle(): Promise<'bearer' | 'raw'> {
  if (bytezStyle) return bytezStyle;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const style = await invoke<string>('bytez_auth_style');
    bytezStyle = style === 'bearer' ? 'bearer' : 'raw';
  } catch {
    bytezStyle = 'raw';
  }
  return bytezStyle;
}

export async function* streamChat(
  config: LLMConfig,
  messages: Message[],
  tools: ToolSchema[],
  signal?: AbortSignal,
): AsyncGenerator<LLMChunk> {
  try {
    switch (config.provider) {
      case 'ollama':
        yield* streamOllama(config, messages, tools, signal);
        break;
      case 'anthropic':
        yield* streamAnthropic(config, messages, tools, signal);
        break;
      case 'gemini':
        yield* streamGemini(config, messages, tools, signal);
        break;
      default:
        yield* streamOpenAICompatible(config, messages, tools, signal);
        break;
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      yield { done: true };
      return;
    }
    yield {
      error: e instanceof Error ? e.message : String(e),
      done: true,
    };
  }
}

/** Non-streaming convenience call, used for titles and summaries. */
export async function complete(
  config: LLMConfig,
  messages: Message[],
  signal?: AbortSignal,
): Promise<string> {
  let text = '';
  for await (const chunk of streamChat(config, messages, [], signal)) {
    if (chunk.delta) text += chunk.delta;
    if (chunk.error) throw new Error(chunk.error);
  }
  return text.trim();
}

/** Check a backend is reachable and configured — used by the setup wizard. */
export async function testConnection(
  config: LLMConfig,
): Promise<{ ok: boolean; message: string }> {
  try {
    const reply = await complete(config, [
      {
        id: uid('m'),
        role: 'user',
        content: 'Reply with exactly: OK',
        timestamp: Date.now(),
      },
    ]);
    return reply
      ? { ok: true, message: `Connected. The model replied "${reply.slice(0, 40)}".` }
      : { ok: false, message: 'The model connected but returned nothing.' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Ask a local Ollama which models are actually pulled. */
export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  // On the desktop this is the same probe the launch check uses, so it also
  // reports whether the server is up at all.
  if (isTauri) {
    try {
      const { desktop } = await import('@/platform/desktop');
      const status = await desktop.checkOllama(baseUrl);
      return status.models;
    } catch {
      return [];
    }
  }

  const { httpGet } = await import('@/lib/http');
  try {
    const res = await httpGet(`${baseUrl.replace(/\/+$/, '')}/api/tags`);
    if (!res.ok) return [];
    const parsed = JSON.parse(res.body) as { models?: Array<{ name?: string }> };
    return (parsed.models ?? []).map((m) => m.name ?? '').filter(Boolean);
  } catch {
    return [];
  }
}
