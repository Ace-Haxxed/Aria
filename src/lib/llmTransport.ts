/**
 * Bridge between the provider code in `core/llm.ts` and the Rust transport.
 *
 * On the desktop, no LLM request leaves the webview. A `fetch` from here would
 * have to satisfy the page CSP, the Tauri HTTP allowlist and the provider's
 * CORS policy simultaneously, and any one of them failing looks the same to
 * the user — the assistant just never answers. Rust has none of those
 * constraints, so the request is made there and the response body is streamed
 * back as Tauri events.
 *
 * Those events are reassembled into a real `Response` object here, which means
 * everything above this file — SSE parsing, tool-call assembly, the five
 * provider dialects — is unchanged and still reads as ordinary streaming HTTP.
 *
 * On mobile there is no Tauri and no problem to solve: Capacitor's WebView
 * talks to the LLM APIs directly, and those APIs all send permissive CORS
 * headers, so the direct `fetch` fallback at the bottom is used instead.
 */
import { isTauri } from '@/platform';
import { uid } from '@/lib/utils';

export type TransportProvider =
  | 'builtin'
  | 'ollama'
  | 'groq'
  | 'openai'
  | 'anthropic'
  | 'gemini';

export interface ProviderStreamParams {
  provider: TransportProvider;
  model: string;
  /** Already converted into the provider's own message shape by the caller. */
  messages: unknown;
  apiKey?: string;
  baseUrl?: string;
  /** Anthropic and Gemini take the system prompt outside the message list. */
  system?: string;
  tools?: unknown;
  temperature?: number;
  maxTokens?: number;
  /**
   * How the key goes in the Authorization header. `'raw'` sends it unprefixed,
   * which is what Bytez expects; everything else uses `Bearer`.
   */
  authStyle?: 'bearer' | 'raw';
  /**
   * The service to name in error messages. Several providers share the
   * OpenAI-shaped transport, so `provider` above selects the wire format while
   * this says who actually answered.
   */
  label?: string;
  signal?: AbortSignal;
}

/** What the Rust side reports once the response headers are in. */
interface StreamStart {
  ok: boolean;
  status: number;
  error: string | null;
  /** Seconds the provider asked us to wait, when it said so. */
  retryAfter: number | null;
  /** The request was refused for size; waiting will not help. */
  tooLarge: boolean;
}

/**
 * A `Response` carrying a ready-to-display explanation of a failure.
 *
 * Rust builds these — it knows the provider, the status and the body — so the
 * user is shown "Groq did not accept that API key…" rather than a status code.
 */
export interface ExplainedResponse extends Response {
  ariaError?: string;
  /** Set when the provider rate-limited us and named a delay. */
  ariaRetryAfter?: number;
  /** Set when the request was refused for exceeding the context window. */
  ariaTooLarge?: boolean;
}

const COMMANDS: Record<Exclude<TransportProvider, 'builtin'>, string> = {
  ollama: 'ollama_chat',
  groq: 'groq_chat',
  openai: 'openai_chat',
  anthropic: 'anthropic_chat',
  gemini: 'gemini_chat',
};

/**
 * Start a streaming completion and return it as a `Response`.
 *
 * Listeners are attached before the command is invoked: Rust begins emitting
 * as soon as the first bytes arrive, and a listener registered afterwards
 * would miss the opening of the answer.
 */
export async function streamProvider(params: ProviderStreamParams): Promise<ExplainedResponse> {
  // The built-in model has no HTTP layer at all — it emits decoded text
  // directly — so it gets its own bridge rather than a fake response body.
  if (params.provider === 'builtin') return streamBuiltin(params);

  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');

  const streamId = uid('llm');
  const encoder = new TextEncoder();
  const unlisten: Array<() => void> = [];

  const detach = () => {
    unlisten.forEach((off) => off());
    unlisten.length = 0;
  };

  let onAbort: (() => void) | undefined;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        detach();
        params.signal?.removeEventListener('abort', onAbort!);
        try {
          controller.close();
        } catch {
          // Already closed by an abort that raced us; nothing to do.
        }
      };

      unlisten.push(
        await listen<string>(`llm-chunk-${streamId}`, (event) => {
          if (closed) return;
          controller.enqueue(encoder.encode(event.payload));
        }),
      );
      unlisten.push(await listen(`llm-done-${streamId}`, close));
      unlisten.push(
        await listen<string>(`llm-error-${streamId}`, (event) => {
          if (closed) return;
          // Surface mid-stream failures as part of the body rather than as a
          // stream error: the provider parsers already understand an error
          // payload, and a rejected stream would surface as an unhandled
          // exception instead of a message the user can read.
          controller.enqueue(
            encoder.encode(`\ndata: ${JSON.stringify({ error: { message: event.payload } })}\n\n`),
          );
          close();
        }),
      );

      onAbort = () => {
        void invoke('llm_cancel', { streamId }).catch(() => {});
        close();
      };
      if (params.signal?.aborted) {
        onAbort();
        return;
      }
      params.signal?.addEventListener('abort', onAbort);
    },
    cancel() {
      void invoke('llm_cancel', { streamId }).catch(() => {});
      detach();
    },
  });

  let start: StreamStart;
  try {
    start = await invoke<StreamStart>(
      COMMANDS[params.provider as Exclude<TransportProvider, 'builtin'>],
      {
        streamId,
        apiKey: params.apiKey ?? '',
        baseUrl: params.baseUrl ?? null,
        model: params.model,
        messages: params.messages,
        system: params.system ?? null,
        tools: params.tools ?? null,
        temperature: params.temperature ?? null,
        maxTokens: params.maxTokens ?? null,
        authStyle: params.authStyle ?? null,
        providerLabel: params.label ?? null,
      },
    );
  } catch (e) {
    detach();
    void body.cancel().catch(() => {});
    const message = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
    return explained(new Response(null, { status: 500 }), message);
  }

  if (!start.ok) {
    // No body will ever arrive; release the stream so it is not left open.
    detach();
    void body.cancel().catch(() => {});
    const response = explained(
      new Response(null, { status: start.status || 500 }),
      start.error ?? 'The request could not be completed.',
    );
    // Both conditions are recoverable without the user acting, so they are
    // carried through rather than being flattened into an error string.
    if (start.retryAfter != null) response.ariaRetryAfter = start.retryAfter;
    if (start.tooLarge) response.ariaTooLarge = true;
    return response;
  }

  return new Response(body, { status: 200 }) as ExplainedResponse;
}

/**
 * Bridge the in-process model onto the same streaming interface.
 *
 * It emits plain decoded text rather than a provider wire format, so the
 * chunks are wrapped as OpenAI-shaped SSE. That lets `core/llm.ts` parse the
 * built-in model with the code it already has, instead of growing a sixth
 * dialect for the one backend that has no dialect.
 */
async function streamBuiltin(params: ProviderStreamParams): Promise<ExplainedResponse> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');

  const encoder = new TextEncoder();
  const unlisten: Array<() => void> = [];
  const detach = () => {
    unlisten.forEach((off) => off());
    unlisten.length = 0;
  };

  interface TokenEvent {
    token: string;
    done: boolean;
    tokensPerSec: number;
    totalTokens: number;
    elapsedMs: number;
    error: string | null;
  }

  let onAbort: (() => void) | undefined;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        detach();
        if (onAbort) params.signal?.removeEventListener('abort', onAbort);
        try {
          controller.close();
        } catch {
          // Already closed by an abort that raced us.
        }
      };

      const sse = (payload: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

      unlisten.push(
        await listen<TokenEvent>('builtin-token', (event) => {
          if (closed) return;
          const { token, done, error } = event.payload;

          if (error) {
            sse({ error: { message: error } });
            close();
            return;
          }
          if (token) {
            sse({ choices: [{ delta: { content: token } }] });
          }
          if (done) {
            sse({ choices: [{ delta: {}, finish_reason: 'stop' }] });
            close();
          }
        }),
      );

      onAbort = () => {
        void invoke('builtin_cancel').catch(() => {});
        close();
      };
      if (params.signal?.aborted) {
        onAbort();
        return;
      }
      params.signal?.addEventListener('abort', onAbort);
    },
    cancel() {
      void invoke('builtin_cancel').catch(() => {});
      detach();
    },
  });

  try {
    // Returns once generation has been handed to its worker thread; tokens
    // then arrive as events.
    await invoke('builtin_chat', {
      messages: params.messages,
      temperature: params.temperature ?? null,
      maxTokens: params.maxTokens ?? null,
    });
  } catch (e) {
    detach();
    void body.cancel().catch(() => {});
    const message = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
    return explained(new Response(null, { status: 500 }), message);
  }

  return new Response(body, { status: 200 }) as ExplainedResponse;
}

function explained(response: Response, message: string): ExplainedResponse {
  return Object.assign(response as ExplainedResponse, { ariaError: message });
}

/**
 * Direct-`fetch` fallback for the mobile shell and for `vite dev` in a browser,
 * where there is no Rust side to route through.
 */
export async function streamProviderViaFetch(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<ExplainedResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  return res as ExplainedResponse;
}

export const transportUsesRust = () => isTauri;
