/**
 * Keeping a request inside the model's context window.
 *
 * A conversation grows without limit; a context window does not. When they
 * meet, the provider rejects the request with something like "Request too
 * large for model" — an error the user can neither understand nor act on,
 * arriving at the moment they were mid-thought.
 *
 * So it never reaches them. History is measured before every request and
 * trimmed when it is close to the ceiling: recent turns are kept verbatim,
 * older ones are replaced by a short summary. The user sees a conversation
 * that keeps working.
 */
import type { LLMConfig, Message } from './types';
import { contextLimit, estimateTokens } from './modelLimits';
import { complete } from './llm';
import { uid } from '@/lib/utils';

/**
 * Fraction of the window that may be filled before trimming starts.
 *
 * The remainder is the completion's room. A request that exactly fills the
 * window leaves nowhere to answer, which fails just as hard as overflowing it.
 */
const TRIM_THRESHOLD = 0.8;

/** Recent turns are never summarised — they are what the reply responds to. */
const KEEP_RECENT = 6;

export interface TokenBreakdown {
  system: number;
  history: number;
  current: number;
  total: number;
  limit: number;
  /** 0-1 of the usable window. */
  fraction: number;
}

/** Count what a request would cost, split by where it comes from. */
export function measure(config: LLMConfig, messages: Message[]): TokenBreakdown {
  const limit = contextLimit(config.provider, config.model);

  let system = 0;
  let history = 0;
  let current = 0;

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');

  for (const message of messages) {
    // Images dominate a request when present. A vision tile is roughly 1,100
    // tokens; counting them as text would understate the request by an order
    // of magnitude and let it overflow anyway.
    const images = (message.images?.length ?? 0) * 1_100;
    const cost = estimateTokens(message.content) + images;

    if (message.role === 'system') system += cost;
    else if (message === lastUser) current += cost;
    else history += cost;
  }

  const total = system + history + current;
  return {
    system,
    history,
    current,
    total,
    limit,
    fraction: limit > 0 ? total / limit : 0,
  };
}

export interface TrimResult {
  messages: Message[];
  /** True when history was summarised, so the caller can say so once. */
  trimmed: boolean;
  /** Tokens removed, for the log. */
  saved: number;
}

/**
 * Fit a conversation into the model's window.
 *
 * Summarising costs a model call, so it only happens when the request would
 * genuinely not fit. Below the threshold this returns the input untouched.
 */
export async function fitToContext(
  config: LLMConfig,
  messages: Message[],
  signal?: AbortSignal,
): Promise<TrimResult> {
  const before = measure(config, messages);
  if (before.fraction <= TRIM_THRESHOLD) {
    return { messages, trimmed: false, saved: 0 };
  }

  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');

  // Nothing to gain if there is no older history to fold away.
  if (rest.length <= KEEP_RECENT) {
    return { messages: hardTruncate(config, messages), trimmed: false, saved: 0 };
  }

  const recent = rest.slice(-KEEP_RECENT);
  const older = rest.slice(0, -KEEP_RECENT);

  const summary = await summarise(config, older, signal);

  const summaryMessage: Message = {
    id: uid('msg'),
    role: 'system',
    content: `Summary of the earlier conversation: ${summary}`,
    timestamp: Date.now(),
  };

  const rebuilt = [...system, summaryMessage, ...recent];
  const after = measure(config, rebuilt);

  // Even summarised it may not fit — a single enormous message, or a pasted
  // file. Cut hard rather than sending something that will be refused.
  const final = after.fraction > TRIM_THRESHOLD ? hardTruncate(config, rebuilt) : rebuilt;

  return {
    messages: final,
    trimmed: true,
    saved: Math.max(0, before.total - measure(config, final).total),
  };
}

/**
 * Condense older turns into a paragraph.
 *
 * Falls back to a mechanical extract if the model cannot be reached: losing
 * the nuance of old history is a far better outcome than failing the request
 * the user is waiting on.
 */
async function summarise(
  config: LLMConfig,
  older: Message[],
  signal?: AbortSignal,
): Promise<string> {
  const transcript = older
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'User' : 'ARIA'}: ${m.content.slice(0, 600)}`)
    .join('\n')
    .slice(0, 8_000);

  try {
    const reply = await complete(
      // Summarising with a low token cap keeps this cheap; it is overhead on
      // a request the user is already waiting for.
      { ...config, maxTokens: 300, temperature: 0.2 },
      [
        {
          id: uid('m'),
          role: 'system',
          content:
            'Summarise this conversation in one paragraph. Keep decisions, facts, file paths ' +
            'and anything the assistant agreed to do. Drop pleasantries. Write plainly.',
          timestamp: Date.now(),
        },
        { id: uid('m'), role: 'user', content: transcript, timestamp: Date.now() },
      ],
      signal,
    );
    if (reply.trim()) return reply.trim();
  } catch {
    // Fall through to the mechanical version.
  }

  const topics = older
    .filter((m) => m.role === 'user')
    .map((m) => m.content.split('\n')[0].slice(0, 80))
    .slice(-8);
  return `earlier the user asked about: ${topics.join('; ')}`;
}

/**
 * Drop whole messages, oldest first, until the request fits.
 *
 * The last resort. Used when summarising is impossible or insufficient, and
 * preferred over sending a request that is certain to be rejected.
 */
function hardTruncate(config: LLMConfig, messages: Message[]): Message[] {
  const limit = contextLimit(config.provider, config.model);
  const budget = Math.floor(limit * TRIM_THRESHOLD);

  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');

  const kept: Message[] = [];
  let used = measure(config, system).total;

  // Walk backwards so the newest turns survive.
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost =
      estimateTokens(rest[i].content) + (rest[i].images?.length ?? 0) * 1_100;
    if (used + cost > budget && kept.length > 0) break;
    kept.unshift(rest[i]);
    used += cost;
  }

  // Always keep the final user message, even if it alone exceeds the budget —
  // its content is truncated rather than the turn being dropped, so the user
  // still gets an answer to what they actually asked.
  if (kept.length === 0 && rest.length > 0) {
    const last = rest[rest.length - 1];
    const room = Math.max(500, budget - measure(config, system).total) * 4;
    kept.push({
      ...last,
      content:
        last.content.length > room
          ? `${last.content.slice(0, room)}\n\n[…truncated to fit the model's context window]`
          : last.content,
    });
  }

  return [...system, ...kept];
}
