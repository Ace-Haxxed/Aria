/**
 * Choosing which model answers a given message.
 *
 * A 3B model answers "what time is it" as well as a 70B one and returns in a
 * fraction of the time; sending everything to the largest available model
 * makes the whole app feel slow to save quality nobody asked for. Equally,
 * routing a refactoring request to a 3B model produces a fast wrong answer,
 * which is worse than a slow right one.
 *
 * The decision is made on the request alone, before anything is sent, so it
 * costs nothing.
 */
import type { Message } from './types';

export type Tier = 'builtin' | 'fast' | 'smart' | 'vision';

/** How the user has constrained routing. */
export type SpeedPreference = 'fast' | 'balanced' | 'smart';

export interface RoutingDecision {
  tier: Tier;
  /** One clause, shown in the action log so the choice is never mysterious. */
  reason: string;
}

/**
 * Words that reliably indicate work a small model handles badly.
 *
 * All of these need either multi-step reasoning or precise output, which is
 * exactly where the gap between a 3B and an 8B model shows.
 */
const COMPLEX_MARKERS = [
  'refactor',
  'debug',
  'implement',
  'explain why',
  'analyse',
  'analyze',
  'compare',
  'design',
  'architecture',
  'optimise',
  'optimize',
  'algorithm',
  'step by step',
  'plan',
  'review',
  'summarise',
  'summarize',
  'translate',
  'write a',
  'write me',
];

/**
 * Routine housekeeping: moving, renaming and tidying files.
 *
 * These are mechanical. The model's job is to pick the right tool and fill in
 * its arguments, which an 8B model does reliably — and doing it locally means
 * a user's daily tidying never consumes cloud quota or leaves the machine.
 * Deliberately narrow: anything analytical about file *contents* is not here.
 */
const FILE_TASK_MARKERS = [
  'organise my',
  'organize my',
  'tidy my',
  'tidy up',
  'clean up my',
  'sort my',
  'move file',
  'move the file',
  'move these',
  'rename file',
  'rename the file',
  'rename these',
  'delete file',
  'copy file',
  'create a folder',
  'make a folder',
  'new folder',
  'empty the trash',
  'find files',
  'list files',
  'where is the file',
  'free up space',
];

/** Words that mean the request is about something on screen or in an image. */
const VISION_MARKERS = [
  'screen',
  'screenshot',
  'this image',
  'what am i looking at',
  'what is this',
  'read this',
  'see this',
];

/**
 * Roughly four characters per token. Exact counts need the model's own
 * tokenizer, which is not worth loading to make a routing decision.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Prompts longer than this benefit from a model with more capacity. */
const LONG_PROMPT_TOKENS = 500;
/** Below this a request is a short question, whatever else it contains. */
const SHORT_QUERY_WORDS = 10;

export function decideRoute(
  text: string,
  options: {
    hasImages: boolean;
    preference: SpeedPreference;
    /** Prior conversation, which counts toward the context the model must hold. */
    history?: Message[];
  },
): RoutingDecision {
  // Vision is a capability, not a preference: a text model physically cannot
  // answer a question about a picture, so this outranks everything.
  if (options.hasImages) {
    return { tier: 'vision', reason: 'image attached' };
  }

  const lower = text.toLowerCase();
  if (VISION_MARKERS.some((m) => lower.includes(m))) {
    return { tier: 'vision', reason: 'asks about the screen' };
  }

  // File housekeeping goes to the local model before any preference is
  // consulted: it is mechanical work that should never cost API quota, and
  // routing it locally is the difference between a free tier lasting a day and
  // lasting a month.
  if (FILE_TASK_MARKERS.some((m) => lower.includes(m))) {
    return { tier: 'builtin', reason: 'file task — kept local' };
  }

  if (options.preference === 'fast') {
    return { tier: 'fast', reason: 'speed set to Fast' };
  }
  if (options.preference === 'smart') {
    return { tier: 'smart', reason: 'speed set to Smart' };
  }

  const historyTokens = (options.history ?? []).reduce(
    (sum, m) => sum + estimateTokens(m.content),
    0,
  );
  const totalTokens = estimateTokens(text) + historyTokens;

  if (totalTokens > LONG_PROMPT_TOKENS) {
    return { tier: 'smart', reason: 'long conversation' };
  }

  // Fenced code, or anything that looks like a path or a symbol, means the
  // answer has to be exact.
  if (text.includes('```') || /[/\\]\w+\.\w{1,5}\b/.test(text)) {
    return { tier: 'smart', reason: 'involves code or files' };
  }

  if (COMPLEX_MARKERS.some((m) => lower.includes(m))) {
    return { tier: 'smart', reason: 'complex request' };
  }

  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words <= SHORT_QUERY_WORDS) {
    return { tier: 'fast', reason: 'short question' };
  }

  // Nothing marked it as hard, but it is not trivially short either. The
  // larger model is the safer default: a needlessly good answer costs seconds,
  // a needlessly bad one costs the user's trust.
  return { tier: 'smart', reason: 'general request' };
}
