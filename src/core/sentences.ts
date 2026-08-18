/**
 * Splitting a reply into speakable sentences while it is still arriving.
 *
 * Waiting for a complete response before speaking wastes the whole generation
 * time: on slow hardware that is the difference between ARIA answering in
 * two seconds and answering in twenty. The first sentence is usually complete
 * long before the last one, and speech is slower than generation, so once the
 * first sentence is playing the rest arrive well ahead of being needed.
 *
 * The hard part is deciding when a sentence has actually finished. A full stop
 * is not enough — "e.g.", "Dr.", "3.5" and a decimal point all end a token
 * without ending a thought — and speaking half a sentence is worse than
 * waiting a moment longer.
 */

/**
 * Abbreviations that end in a period without ending a sentence.
 *
 * Not exhaustive by design: a missed one costs an early break, which sounds
 * like a pause rather than a defect. Over-matching would swallow real endings.
 */
const ABBREVIATIONS = [
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st',
  'e.g', 'i.e', 'etc', 'vs', 'approx', 'no', 'fig',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
];

/** Speaking anything shorter is a fragment; hold it and wait for more. */
const MIN_SENTENCE_CHARS = 12;

/**
 * Is the period at `index` a sentence ending rather than part of a token?
 */
function isSentenceEnd(text: string, index: number): boolean {
  const char = text[index];
  if (char !== '.' && char !== '!' && char !== '?') return false;

  // "..." and "?!" are one ending, not several. Only the last mark counts.
  const next = text[index + 1];
  if (next === '.' || next === '!' || next === '?') return false;

  if (char === '.') {
    // A digit either side means a number or a version, not an ending.
    const before = text[index - 1];
    if (before && /\d/.test(before) && next && /\d/.test(next)) return false;

    // A known abbreviation immediately before the period.
    const preceding = text.slice(Math.max(0, index - 12), index).toLowerCase();
    const word = preceding.match(/([a-z.]+)$/)?.[1] ?? '';
    if (ABBREVIATIONS.includes(word)) return false;

    // A single capital letter is an initial: "J. Smith".
    if (/(^|\s)[a-z]$/i.test(preceding) && /^[A-Z]/.test(word)) return false;
  }

  // A sentence ends where whitespace, a closing mark or the text follows.
  if (next === undefined) return true;
  return /[\s"'”’)\]]/.test(next);
}

export interface SentenceSplit {
  /** Complete sentences, ready to speak. */
  sentences: string[];
  /** Text after the last complete sentence, to carry into the next call. */
  remainder: string;
}

/**
 * Pull every complete sentence out of `buffer`.
 *
 * Fenced code blocks are skipped entirely — reading a code listing aloud is
 * never what the user wants, and a stray `.` inside one would split mid-symbol.
 */
export function takeSentences(buffer: string): SentenceSplit {
  const sentences: string[] = [];
  let start = 0;
  let i = 0;

  while (i < buffer.length) {
    // Skip over a fenced block. An unterminated fence means the block is still
    // streaming, so everything from here on is held back.
    if (buffer.startsWith('```', i)) {
      const close = buffer.indexOf('```', i + 3);
      if (close === -1) {
        return { sentences, remainder: buffer.slice(start) };
      }
      i = close + 3;
      continue;
    }

    if (isSentenceEnd(buffer, i)) {
      const candidate = buffer.slice(start, i + 1).trim();
      // Too short to be a sentence on its own: keep accumulating rather than
      // speaking a fragment.
      if (candidate.length >= MIN_SENTENCE_CHARS) {
        sentences.push(candidate);
        start = i + 1;
      }
    }
    i++;
  }

  return { sentences, remainder: buffer.slice(start) };
}

/**
 * Prepare a sentence for speech.
 *
 * Markdown syntax is punctuation to a reader and noise to a listener: a TTS
 * engine will happily pronounce asterisks and backticks.
 */
export function speakable(text: string): string {
  return text
    // Fenced blocks are announced rather than read out.
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // Link text is worth speaking; the URL is not.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Incremental splitter over a growing response.
 *
 * `push` is called with the full text so far — which is what the streaming
 * loop already has — and returns only sentences not yet handed out.
 */
export class SentenceStream {
  private consumed = 0;

  /** Complete sentences that have appeared since the last call. */
  push(fullText: string): string[] {
    const pending = fullText.slice(this.consumed);
    const { sentences, remainder } = takeSentences(pending);
    if (sentences.length === 0) return [];

    this.consumed = fullText.length - remainder.length;
    return sentences.map(speakable).filter(Boolean);
  }

  /** Whatever is left when generation ends, complete or not. */
  flush(fullText: string): string[] {
    const tail = speakable(fullText.slice(this.consumed));
    this.consumed = fullText.length;
    return tail ? [tail] : [];
  }

  reset(): void {
    this.consumed = 0;
  }
}
