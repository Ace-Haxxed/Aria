/**
 * One HTTP entry point for the whole app.
 *
 * A WebView cannot fetch third-party pages directly — CORS blocks it and there
 * is no origin to whitelist. On the desktop every request therefore goes
 * through the Rust `http_request` command, which has no CSP, no allowlist and
 * no same-origin policy to satisfy. Mobile uses Capacitor's native HTTP, which
 * runs outside the WebView for the same reason.
 *
 * Streaming LLM responses are a separate concern and live in `llmTransport.ts`.
 */
import { isMobile, isTauri } from '@/platform';

export interface HttpResponse {
  status: number;
  body: string;
  ok: boolean;
}

const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

/** Shape returned by the Rust `http_request` command. */
interface RustReply {
  status: number;
  ok: boolean;
  body: string;
}

async function viaRust(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs?: number,
): Promise<HttpResponse> {
  const { invoke } = await import('@tauri-apps/api/core');
  const reply = await invoke<RustReply>('http_request', {
    method,
    url,
    headers,
    body: body ?? null,
    timeoutMs: timeoutMs ?? null,
  });
  return { status: reply.status, body: reply.body, ok: reply.ok };
}

export async function httpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  const merged = { 'User-Agent': DEFAULT_UA, ...headers };

  if (isTauri) return viaRust('GET', url, merged);

  if (isMobile) {
    // Imported on demand: the Capacitor core bundle is sizeable and, on the
    // desktop, entirely unreachable — a static import would ship its native
    // bridge shim to every user who will never run on a phone.
    const { CapacitorHttp } = await import('@capacitor/core');
    const res = await CapacitorHttp.get({ url, headers: merged });
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    return { status: res.status, body, ok: res.status >= 200 && res.status < 300 };
  }

  // Plain browser during `vite dev` — subject to CORS, which is expected.
  const res = await fetch(url, { headers: merged });
  return { status: res.status, body: await res.text(), ok: res.ok };
}

export async function httpPostJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  const merged = { 'Content-Type': 'application/json', ...headers };

  if (isTauri) return viaRust('POST', url, merged, JSON.stringify(body));

  if (isMobile) {
    const { CapacitorHttp } = await import('@capacitor/core');
    const res = await CapacitorHttp.post({ url, headers: merged, data: body });
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    return { status: res.status, body: text, ok: res.status >= 200 && res.status < 300 };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: merged,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text(), ok: res.ok };
}

/**
 * Iterate the `data:` payloads of a Server-Sent Events stream.
 *
 * Chunk boundaries fall wherever the network puts them, so a partial line must
 * be carried into the next read rather than parsed as-is.
 */
export async function* readSSE(response: Response): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;
        yield payload;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Read a non-SSE stream line by line — Ollama emits newline-delimited JSON. */
export async function* readLines(response: Response): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim()) yield line.trim();
      }
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    reader.releaseLock();
  }
}
