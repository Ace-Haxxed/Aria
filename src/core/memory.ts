/**
 * Conversation persistence and long-term memory.
 *
 * Desktop stores everything in SQLite through the Rust layer; mobile uses
 * Capacitor Preferences. Both are hidden behind the same functions so nothing
 * upstream needs to know which one is in play.
 */
import type { Conversation, Message } from './types';
import { isMobile, isTauri } from '@/platform';
import { uid } from '@/lib/utils';

const CONV_INDEX_KEY = 'nova.conversations';
const CONV_PREFIX = 'nova.conversation.';
const FACTS_KEY = 'nova.facts';

async function prefs() {
  const { Preferences } = await import('@capacitor/preferences');
  return Preferences;
}

async function db() {
  const { desktop } = await import('@/platform/desktop');
  return desktop;
}

/** True when there is somewhere durable to write. */
function persistent(): boolean {
  return isMobile || isTauri;
}

/* ── Conversations ───────────────────────────────────────────────── */

export async function saveConversation(conversation: Conversation): Promise<void> {
  if (!persistent()) return;

  if (isMobile) {
    const P = await prefs();
    await P.set({
      key: CONV_PREFIX + conversation.id,
      value: JSON.stringify(conversation),
    });

    // Keep a lightweight index so the sidebar does not have to load every
    // conversation body just to render a list of titles.
    const index = await loadIndex();
    const without = index.filter((c) => c.id !== conversation.id);
    without.unshift({
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      pinned: conversation.pinned ?? false,
    });
    await P.set({ key: CONV_INDEX_KEY, value: JSON.stringify(without.slice(0, 200)) });
    return;
  }

  const d = await db();
  await d.saveConversation({
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    summary: conversation.summary ?? null,
    pinned: conversation.pinned ?? false,
  });
}

export async function saveMessage(conversationId: string, message: Message): Promise<void> {
  if (!persistent()) return;

  // On mobile the whole conversation is one blob, so the caller's
  // saveConversation already covers it.
  if (isMobile) return;

  const d = await db();
  await d.saveMessage({
    conversationId,
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    toolCalls: message.toolCalls ? JSON.stringify(message.toolCalls) : null,
    toolCallId: message.toolCallId ?? null,
    images: message.images ? JSON.stringify(message.images) : null,
  });
}

interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
}

async function loadIndex(): Promise<ConversationSummary[]> {
  const P = await prefs();
  const { value } = await P.get({ key: CONV_INDEX_KEY });
  if (!value) return [];
  try {
    return JSON.parse(value) as ConversationSummary[];
  } catch {
    return [];
  }
}

export async function listConversations(): Promise<ConversationSummary[]> {
  if (!persistent()) return [];

  if (isMobile) return await loadIndex();

  const d = await db();
  const rows = await d.listConversations(200);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    pinned: r.pinned,
  }));
}

export async function loadConversation(id: string): Promise<Conversation | null> {
  if (!persistent()) return null;

  if (isMobile) {
    const P = await prefs();
    const { value } = await P.get({ key: CONV_PREFIX + id });
    if (!value) return null;
    try {
      return JSON.parse(value) as Conversation;
    } catch {
      return null;
    }
  }

  const d = await db();
  const [meta] = (await d.listConversations(200)).filter((c) => c.id === id);
  if (!meta) return null;

  const rows = await d.getMessages(id);
  const messages: Message[] = rows.map((r) => ({
    id: r.id,
    role: r.role as Message['role'],
    content: r.content,
    timestamp: r.timestamp,
    toolCalls: r.toolCalls ? JSON.parse(r.toolCalls) : undefined,
    toolCallId: r.toolCallId ?? undefined,
    images: r.images ? JSON.parse(r.images) : undefined,
  }));

  return {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    summary: meta.summary ?? undefined,
    pinned: meta.pinned,
    messages,
  };
}

export async function deleteConversation(id: string): Promise<void> {
  if (!persistent()) return;

  if (isMobile) {
    const P = await prefs();
    await P.remove({ key: CONV_PREFIX + id });
    const index = (await loadIndex()).filter((c) => c.id !== id);
    await P.set({ key: CONV_INDEX_KEY, value: JSON.stringify(index) });
    return;
  }

  const d = await db();
  await d.deleteConversation(id);
}

export async function clearAllHistory(): Promise<void> {
  if (!persistent()) return;

  if (isMobile) {
    const P = await prefs();
    for (const c of await loadIndex()) {
      await P.remove({ key: CONV_PREFIX + c.id });
    }
    await P.remove({ key: CONV_INDEX_KEY });
    return;
  }

  const d = await db();
  await d.clearHistory();
}

export function newConversation(): Conversation {
  const now = Date.now();
  return {
    id: uid('conv'),
    title: 'New conversation',
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

/** Derive a title from the first thing the user said. */
export function deriveTitle(messages: Message[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return 'New conversation';
  const text = first.content.trim().replace(/\s+/g, ' ');
  return text.length > 48 ? `${text.slice(0, 47)}…` : text || 'New conversation';
}

/* ── Long-term facts ─────────────────────────────────────────────── */

export async function rememberFact(key: string, value: string): Promise<void> {
  if (isMobile || !isTauri) {
    const facts = await recallFacts();
    facts[key] = value;
    const P = await prefs();
    await P.set({ key: FACTS_KEY, value: JSON.stringify(facts) });
    return;
  }
  const d = await db();
  await d.memorySet(key, value);
}

export async function recallFacts(): Promise<Record<string, string>> {
  if (isMobile || !isTauri) {
    try {
      const P = await prefs();
      const { value } = await P.get({ key: FACTS_KEY });
      return value ? (JSON.parse(value) as Record<string, string>) : {};
    } catch {
      return {};
    }
  }
  const d = await db();
  return Object.fromEntries(await d.memoryGetAll());
}

export async function forgetFact(key: string): Promise<void> {
  if (isMobile || !isTauri) {
    const facts = await recallFacts();
    delete facts[key];
    const P = await prefs();
    await P.set({ key: FACTS_KEY, value: JSON.stringify(facts) });
    return;
  }
  const d = await db();
  await d.memoryDelete(key);
}

/* ── Context-window management ───────────────────────────────────── */

/**
 * Rough token estimate. Real tokenisers differ per model, but ~4 characters
 * per token holds well enough across all of them for a budgeting decision, and
 * shipping a tokeniser per provider would cost megabytes for no real gain.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messageTokens(m: Message): number {
  let n = estimateTokens(m.content) + 8;
  if (m.toolCalls) n += estimateTokens(JSON.stringify(m.toolCalls));
  // Images dominate everything else; charge a flat, deliberately high estimate.
  if (m.images?.length) n += m.images.length * 1200;
  return n;
}

export interface TrimResult {
  messages: Message[];
  /** Messages dropped from the window, for the caller to summarise. */
  evicted: Message[];
}

/**
 * Fit a conversation into a token budget, keeping the most recent exchanges.
 *
 * Tool results are dropped alongside the assistant message that requested
 * them — an orphaned `tool` message with no matching call makes several
 * providers reject the whole request.
 */
export function trimToBudget(messages: Message[], budget: number): TrimResult {
  const kept: Message[] = [];
  let used = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const cost = messageTokens(m);
    if (used + cost > budget && kept.length > 0) break;
    used += cost;
    kept.unshift(m);
  }

  // Never open the window on a dangling tool result.
  while (kept.length > 0 && kept[0].role === 'tool') {
    kept.shift();
  }

  const evicted = messages.slice(0, messages.length - kept.length);
  return { messages: kept, evicted };
}

/** Condense evicted messages into a paragraph for the system prompt. */
export function summariseEvicted(evicted: Message[], existing?: string): string {
  if (evicted.length === 0) return existing ?? '';

  const lines = evicted
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'User' : 'NOVA'}: ${m.content.replace(/\s+/g, ' ').slice(0, 200)}`);

  const body = lines.slice(-40).join('\n');
  return existing ? `${existing}\n${body}` : body;
}
