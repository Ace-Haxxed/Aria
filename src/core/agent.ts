/**
 * The agent loop: think → act → observe → repeat.
 *
 * This module owns no UI and no store. It takes a set of callbacks and drives
 * them, which keeps the loop testable and lets the desktop and mobile shells
 * render it however they like.
 */
import type {
  ActionLogEntry,
  AgentState,
  Conversation,
  Message,
  PlatformInfo,
  Settings,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from './types';
import { streamChat } from './llm';
import { SentenceStream } from './sentences';
import { ToolCache, formatAge } from './toolCache';
import { capabilityAllowed, evaluate, summariseCall } from './safety';
import { recallFacts, summariseEvicted, trimToBudget } from './memory';
import { uid } from '@/lib/utils';

/** Stop after this many tool rounds so a confused model cannot loop forever. */
const MAX_STEPS = 12;

/** Leave room for the reply and the tool schemas inside the model's window. */
const CONTEXT_BUDGET = 12_000;

/**
 * The system prompt.
 *
 * Written as instructions rather than description: "answer in two or three
 * sentences" changes behaviour where "be concise" does not. The persona is
 * kept short because every token here is spent on every single request, and
 * an 8B local model follows three firm rules better than ten soft ones.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are ARIA, an AI assistant with direct control of this computer.

HOW YOU ANSWER
- Lead with the answer. No preamble, no restating the question, no "Certainly!".
- Two or three sentences unless asked for more, or unless the answer is a list or code.
- Say the specific thing. "Moved 12 files to ~/Documents" beats "I've organised your files."
- If you do not know, say so and say what would settle it. Never invent a path, command, or result.

HOW YOU ACT
- When a request implies an action, take it — do not ask whether you should begin.
- Look before you act: read the file, take the screenshot, list the directory. Never guess at state you could check.
- Use one tool at a time and read its result before the next. Tools return real output; base what you say on it, not on what you expected.
- If a tool fails, say what failed and what you will try instead. Do not repeat the same call unchanged.
- "[Tool returned no content]" means the tool ran and found nothing. Say so plainly — "I couldn't read that; it may be a visual-only page" — and either try a different tool or ask. Never describe content you did not receive.
- Destructive actions run the moment you call them: there is no confirmation step and nothing will stop you. Deleting, overwriting, shell commands, installing, quitting apps — all of it executes immediately, so be certain the call is right before you make it.
- Prefer the reversible form when one exists: trash over permanent delete, move over overwrite, a copy before an edit in place.
- Narrow the blast radius. Name exact paths, never a glob or a parent directory, when a specific target will do.

HOW YOU SOUND
- Composed and direct. Dry wit is welcome; performance is not.
- Address the user plainly. No flattery, no "great question", no filler.
- Report failures as plainly as successes.`;

export interface AgentCallbacks {
  onState: (state: AgentState) => void;
  /** Streaming assistant text for the message currently being written. */
  onDelta: (messageId: string, text: string) => void;
  /** A completed message to append to the conversation. */
  onMessage: (message: Message) => void;
  onActionStart: (entry: ActionLogEntry) => void;
  onActionUpdate: (id: string, patch: Partial<ActionLogEntry>) => void;
  /** Called once per assistant turn with the final text, for TTS. */
  onSpeak: (text: string) => void;
  /**
   * A finished sentence, ready to speak, delivered while the rest of the reply
   * is still generating. `null` marks the end of the utterance.
   *
   * When present this replaces `onSpeak` entirely — a caller that handles
   * sentences must not also be handed the whole text, or every reply is spoken
   * twice.
   */
  onSpeakSentence?: (sentence: string | null) => void;
  /** Surfaces an image a tool produced (screenshot, camera, page capture). */
  onImage?: (dataUrl: string) => void;
}

export interface RunOptions {
  conversation: Conversation;
  settings: Settings;
  tools: ToolDefinition[];
  platform: PlatformInfo;
  callbacks: AgentCallbacks;
  signal: AbortSignal;
}

/** Compose the system prompt from the user's template plus live context. */
export async function buildSystemPrompt(
  settings: Settings,
  platform: PlatformInfo,
  conversation: Conversation,
): Promise<string> {
  const parts = [settings.llm.systemPrompt || DEFAULT_SYSTEM_PROMPT];

  const env: string[] = [
    `Platform: ${platform.os}${platform.distro ? ` (${platform.distro})` : ''}`,
  ];
  if (platform.os === 'linux') {
    env.push(`Display server: ${platform.sessionType}`, `Desktop: ${platform.compositor}`);
    if (platform.packageManager) env.push(`Package manager: ${platform.packageManager}`);
  }
  env.push(`Current date and time: ${new Date().toLocaleString()}`);
  parts.push(`\nEnvironment:\n${env.map((e) => `- ${e}`).join('\n')}`);

  parts.push(
    '\nGuidelines:\n' +
      '- Take a screenshot before clicking or typing, so you can see what is on screen.\n' +
      '- Say what you are about to do in one short sentence, then do it.\n' +
      '- Use one tool at a time and check the result before the next step.\n' +
      '- If a tool reports an error, read it and adapt rather than retrying blindly.\n' +
      '- When the task is finished, reply in plain prose with no tool call.\n' +
      '- Keep spoken replies to a couple of sentences; the user hears them aloud.',
  );

  if (settings.persistentMemory) {
    const facts = await recallFacts();
    const entries = Object.entries(facts);
    if (entries.length > 0) {
      parts.push(
        `\nWhat you remember about this user:\n${entries
          .map(([k, v]) => `- ${k}: ${v}`)
          .join('\n')}`,
      );
    }
  }

  if (conversation.summary) {
    parts.push(`\nEarlier in this conversation:\n${conversation.summary}`);
  }

  return parts.join('\n');
}

/** Every tool available on this platform — nothing is filtered out. */
export function availableTools(
  tools: ToolDefinition[],
  settings: Settings,
  platform: PlatformInfo,
): ToolDefinition[] {
  const target = platform.isMobile ? 'mobile' : 'desktop';
  return tools.filter((t) => t.platforms.includes(target) && capabilityAllowed(t, settings));
}

async function executeTool(
  tool: ToolDefinition,
  call: ToolCall,
  callbacks: AgentCallbacks,
  cache: ToolCache,
): Promise<{ result: ToolResult; cachedAgeMs?: number }> {
  // A repeat of a read-only call within its lifetime is answering a question
  // already answered. Reusing it removes a portal round trip or a process
  // probe from the middle of a multi-step task.
  const hit = cache.get<ToolResult>(call.name, call.args);
  if (hit) {
    const data = hit.value.data as { image?: string } | undefined;
    if (data?.image && callbacks.onImage) callbacks.onImage(data.image);
    return { result: hit.value, cachedAgeMs: hit.ageMs };
  }

  const result = await tool.execute(call.args);

  // Only successful reads are worth keeping; a failure should be retried.
  if (result.ok) cache.set(call.name, call.args, result);
  // Acting on the world invalidates prior observations of it, whether or not
  // this tool was itself cacheable.
  cache.invalidate(call.name);

  // Surface any image the tool produced so the UI can show it and the next
  // model turn can see it.
  const data = result.data as { image?: string } | undefined;
  if (data?.image && callbacks.onImage) {
    callbacks.onImage(data.image);
  }
  return { result };
}

/**
 * Run one user turn to completion.
 *
 * Returns every message produced, so the caller can persist the turn in one go
 * rather than writing on each callback.
 */
export async function runAgentTurn(options: RunOptions): Promise<Message[]> {
  // Scoped to this turn. A screenshot from a previous question describes a
  // screen the user has since changed.
  const cache = new ToolCache();
  const { conversation, settings, tools, platform, callbacks, signal } = options;
  const produced: Message[] = [];

  const usable = availableTools(tools, settings, platform);
  const byName = new Map(usable.map((t) => [t.name, t]));
  const schemas = usable.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    required: t.required,
  }));

  const systemPrompt = await buildSystemPrompt(settings, platform, conversation);
  // Working copy: tool results accumulate here across steps without touching
  // the caller's conversation until the turn finishes.
  const working: Message[] = [...conversation.messages];

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) break;

    callbacks.onState('thinking');

    const { messages: windowed, evicted } = trimToBudget(working, CONTEXT_BUDGET);
    if (evicted.length > 0) {
      conversation.summary = summariseEvicted(evicted, conversation.summary);
    }

    const request: Message[] = [
      {
        id: 'system',
        role: 'system',
        content: systemPrompt,
        timestamp: Date.now(),
      },
      ...windowed,
    ];

    const assistantId = uid('msg');
    let text = '';
    const calls: ToolCall[] = [];
    let error: string | undefined;

    // Hand each finished sentence to speech as soon as it exists, rather than
    // waiting for the whole reply. Speech is slower than generation, so once
    // the first sentence is playing the rest arrive ahead of being needed —
    // which is most of the perceived latency on slow hardware.
    const speech = new SentenceStream();
    const speakIncrementally = Boolean(callbacks.onSpeakSentence);

    for await (const chunk of streamChat(settings.llm, request, schemas, signal)) {
      if (signal.aborted) break;

      if (chunk.delta) {
        text += chunk.delta;
        callbacks.onDelta(assistantId, text);
        if (speakIncrementally) {
          for (const sentence of speech.push(text)) {
            callbacks.onSpeakSentence!(sentence);
          }
        }
      }
      if (chunk.toolCall) calls.push(chunk.toolCall);
      if (chunk.error) {
        error = chunk.error;
        break;
      }
    }

    if (error) {
      const message: Message = {
        id: assistantId,
        role: 'assistant',
        content: text || '',
        timestamp: Date.now(),
        error,
      };
      callbacks.onMessage(message);
      produced.push(message);
      callbacks.onState('idle');
      return produced;
    }

    const assistantMessage: Message = {
      id: assistantId,
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
      toolCalls: calls.length > 0 ? calls : undefined,
    };
    callbacks.onMessage(assistantMessage);
    produced.push(assistantMessage);
    working.push(assistantMessage);

    // No tool calls means the model considers the task finished.
    if (calls.length === 0) {
      if (text.trim()) {
        if (speakIncrementally) {
          // Only the tail is left; everything before it is already speaking.
          for (const sentence of speech.flush(text)) {
            callbacks.onSpeakSentence!(sentence);
          }
          callbacks.onSpeakSentence!(null);
        } else {
          callbacks.onSpeak(text);
        }
      }
      callbacks.onState('idle');
      return produced;
    }

    // The turn continues into tool calls, so this reply is complete as far as
    // speech is concerned; release anything held back.
    if (speakIncrementally && text.trim()) {
      for (const sentence of speech.flush(text)) {
        callbacks.onSpeakSentence!(sentence);
      }
      callbacks.onSpeakSentence!(null);
    }

    callbacks.onState('acting');

    for (const call of calls) {
      // A turn the user stopped must not leave calls it never made looking as
      // though they are still running. With no confirmation step the log is
      // the only record of what ARIA did, so "not run" has to be recorded as
      // distinctly as "run and failed".
      if (signal.aborted) {
        for (const skipped of calls.slice(calls.indexOf(call))) {
          callbacks.onActionStart({
            id: uid('act'),
            tool: skipped.name,
            args: skipped.args,
            risk: 'low',
            status: 'cancelled',
            startedAt: Date.now(),
            finishedAt: Date.now(),
            summary: `${summariseCall(skipped, byName.get(skipped.name))} — stopped before it ran`,
          });
        }
        break;
      }

      const tool = byName.get(call.name);
      const verdict = evaluate(call, tool);
      const entryId = uid('act');
      const startedAt = Date.now();

      const entry: ActionLogEntry = {
        id: entryId,
        tool: call.name,
        args: call.args,
        risk: verdict.risk,
        status: 'running',
        startedAt,
        summary: verdict.summary,
      };
      callbacks.onActionStart(entry);

      // Unknown tool: tell the model rather than failing the turn, so it can
      // pick a real one on the next step.
      if (!tool) {
        const output = `Error: there is no tool called \`${call.name}\`. Use one of the tools you were given.`;
        callbacks.onActionUpdate(entryId, {
          status: 'error',
          finishedAt: Date.now(),
          error: output,
        });
        const toolMessage = makeToolMessage(call, output);
        callbacks.onMessage(toolMessage);
        produced.push(toolMessage);
        working.push(toolMessage);
        continue;
      }

      // No approval step: the call executes as soon as the model makes it.
      // The action log entry above is written first precisely because of that
      // — it is the only record that this ran, and it exists before the tool
      // can do anything, so a call that hangs or takes the app down still
      // leaves a trace of what was in flight.
      let result: ToolResult;
      let cachedAgeMs: number | undefined;
      try {
        const outcome = await executeTool(tool, call, callbacks, cache);
        result = outcome.result;
        cachedAgeMs = outcome.cachedAgeMs;
      } catch (e) {
        result = {
          ok: false,
          output: `Error: ${e instanceof Error ? e.message : String(e)}`,
          error: String(e),
        };
      }

      callbacks.onActionUpdate(entryId, {
        status: result.ok ? 'ok' : 'error',
        finishedAt: Date.now(),
        result: result.ok ? result.output : undefined,
        error: result.ok ? undefined : (result.error ?? result.output),
        undo: result.undo,
        // Say when a result was reused, so a suspiciously fast step is
        // explained rather than looking like the tool was skipped.
        summary: cachedAgeMs != null
          ? `${verdict.summary} (cached ${formatAge(cachedAgeMs)})`
          : undefined,
      });

      const toolMessage = makeToolMessage(call, result.output);
      // Attach a produced image to the tool result so the next request carries
      // it to the vision model.
      const data = result.data as { image?: string } | undefined;
      if (data?.image) toolMessage.images = [data.image];

      callbacks.onMessage(toolMessage);
      produced.push(toolMessage);
      working.push(toolMessage);
    }
  }

  // Fell out of the loop: report it rather than going quiet.
  if (!signal.aborted) {
    const message: Message = {
      id: uid('msg'),
      role: 'assistant',
      content:
        `I stopped after ${MAX_STEPS} steps without finishing. ` +
        'Tell me how you would like me to continue.',
      timestamp: Date.now(),
    };
    callbacks.onMessage(message);
    produced.push(message);
    callbacks.onSpeak(message.content);
  }

  callbacks.onState('idle');
  return produced;
}

/**
 * Below this, a result is thin enough to be worth flagging to the model.
 * It is not treated as empty — "42" is a real answer — but a model that reads
 * two characters and writes a paragraph is inventing the rest.
 */
const THIN_RESULT_CHARS = 10;

/** What the model sees when a tool produced nothing at all. */
export const EMPTY_TOOL_RESULT = '[Tool returned no content]';

/**
 * Wrap a tool result as a message for the model.
 *
 * An empty result is replaced with an explicit marker rather than passed
 * through as an empty string. A blank tool message reads to the model as "the
 * call succeeded and there was nothing notable", so it carries on and
 * describes a page it never saw. Saying so plainly is what lets it answer
 * "I couldn't read that" instead.
 */
function makeToolMessage(call: ToolCall, output: string): Message {
  const text = typeof output === 'string' ? output : String(output ?? '');
  const trimmed = text.trim();

  let content: string;
  if (!trimmed) {
    content = EMPTY_TOOL_RESULT;
  } else if (trimmed.length < THIN_RESULT_CHARS) {
    // Kept verbatim — a short result is still a result, and replacing "42"
    // with "no content" would throw away the answer. The note is appended so
    // the model can weigh how much to build on it.
    content = `${text}\n\n[Tool returned only ${trimmed.length} characters — may be incomplete]`;
  } else {
    content = text;
  }

  return {
    id: uid('msg'),
    role: 'tool',
    content,
    timestamp: Date.now(),
    toolCallId: call.id,
  };
}

/** Ask the model for a short conversation title. Failure is non-fatal. */
export async function generateTitle(
  settings: Settings,
  firstUserMessage: string,
): Promise<string | null> {
  try {
    const { complete } = await import('./llm');
    const title = await complete(settings.llm, [
      {
        id: uid('m'),
        role: 'user',
        content:
          'Write a title of at most 6 words for a conversation that starts with this ' +
          `message. Reply with the title only, no quotes.\n\n${firstUserMessage.slice(0, 400)}`,
        timestamp: Date.now(),
      },
    ]);
    const cleaned = title.replace(/^["']|["']$/g, '').trim();
    return cleaned.length > 0 && cleaned.length <= 80 ? cleaned : null;
  } catch {
    return null;
  }
}

/** Summarise the parts of a conversation that fell out of the context window. */
export async function summariseConversation(
  settings: Settings,
  messages: Message[],
): Promise<string | null> {
  if (messages.length === 0) return null;
  try {
    const { complete } = await import('./llm');
    const transcript = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `${m.role}: ${m.content.slice(0, 400)}`)
      .join('\n');

    return await complete(settings.llm, [
      {
        id: uid('m'),
        role: 'user',
        content:
          'Summarise this conversation in under 120 words, keeping any facts, ' +
          `preferences or decisions that later turns would need.\n\n${transcript}`,
        timestamp: Date.now(),
      },
    ]);
  } catch {
    return null;
  }
}
