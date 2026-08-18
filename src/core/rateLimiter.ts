/**
 * Client-side rate limiting for model requests.
 *
 * Providers enforce their own limits, but only by rejecting requests — which
 * arrives as an error mid-conversation, after the user has already waited.
 * Holding requests back on this side turns that into a short, explained pause
 * before anything is sent, and keeps the daily quota from being spent on
 * calls that were going to be refused anyway.
 *
 * Requests are queued, never dropped. A dropped request is a message the user
 * typed that produced nothing, which is the worst possible outcome; a queued
 * one is the same message arriving a few seconds later.
 *
 * The limit is per model rather than per provider: they are metered
 * separately, and one busy model should not stall another.
 */

/** Requests allowed in any rolling window, per model. */
const MAX_REQUESTS = 10;
/** Length of that window. */
const WINDOW_MS = 60_000;

/**
 * Requests older than this are dropped from the queue unattempted.
 *
 * A request the user has long since given up on is not worth sending — it
 * would spend quota to answer a question they have moved past.
 */
const MAX_QUEUE_AGE_MS = 120_000;

export interface RateLimitState {
  /** True while a request is being held back. */
  waiting: boolean;
  /** How many are queued ahead of this one. */
  queued: number;
  /** Seconds until the next slot opens. */
  retryInSeconds: number;
}

type Listener = (state: RateLimitState) => void;

interface Waiter {
  resolve: () => void;
  reject: (reason: Error) => void;
  readonly queuedAt: number;
  readonly signal?: AbortSignal;
}

class ModelBucket {
  /** Timestamps of requests sent inside the current window. */
  private sent: number[] = [];
  private queue: Waiter[] = [];
  private timer: number | null = null;

  /** Drop timestamps that have aged out of the window. */
  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    while (this.sent.length > 0 && this.sent[0] <= cutoff) {
      this.sent.shift();
    }
  }

  hasCapacity(now: number): boolean {
    this.prune(now);
    return this.sent.length < MAX_REQUESTS;
  }

  /** Milliseconds until the oldest request leaves the window. */
  msUntilSlot(now: number): number {
    this.prune(now);
    if (this.sent.length < MAX_REQUESTS) return 0;
    return Math.max(0, this.sent[0] + WINDOW_MS - now);
  }

  record(now: number): void {
    this.sent.push(now);
  }

  enqueue(waiter: Waiter): number {
    this.queue.push(waiter);
    return this.queue.length;
  }

  /** Drop a specific waiter, for a caller that cancelled. */
  remove(waiter: Waiter): void {
    const index = this.queue.indexOf(waiter);
    if (index >= 0) this.queue.splice(index, 1);
  }

  get queueLength(): number {
    return this.queue.length;
  }

  /**
   * Release as many queued requests as there is room for, then schedule
   * another pass for when the next slot opens.
   */
  drain(notify: () => void): void {
    const now = Date.now();

    // Abandoned or aborted waiters are discarded before capacity is spent.
    this.queue = this.queue.filter((waiter) => {
      if (waiter.signal?.aborted) {
        waiter.reject(new Error('cancelled'));
        return false;
      }
      if (now - waiter.queuedAt > MAX_QUEUE_AGE_MS) {
        waiter.reject(
          new Error('That request waited too long to be sent. Try asking again.'),
        );
        return false;
      }
      return true;
    });

    while (this.queue.length > 0 && this.hasCapacity(Date.now())) {
      const waiter = this.queue.shift()!;
      this.record(Date.now());
      waiter.resolve();
    }

    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.queue.length > 0) {
      // Wake exactly when the next slot frees, plus a little, so the retry
      // does not land a millisecond early and find the window still full.
      const wait = this.msUntilSlot(Date.now()) + 50;
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.drain(notify);
      }, wait);
    }

    notify();
  }
}

const buckets = new Map<string, ModelBucket>();
const listeners = new Set<Listener>();

function bucketFor(key: string): ModelBucket {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = new ModelBucket();
    buckets.set(key, bucket);
  }
  return bucket;
}

function notify(key: string): void {
  const bucket = bucketFor(key);
  const state: RateLimitState = {
    waiting: bucket.queueLength > 0,
    queued: bucket.queueLength,
    retryInSeconds: Math.ceil(bucket.msUntilSlot(Date.now()) / 1000),
  };
  listeners.forEach((listener) => listener(state));
}

/**
 * Subscribe to rate-limit state, so the UI can say "hold on" rather than
 * appearing to hang.
 */
export function onRateLimit(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Wait until this model has a free slot.
 *
 * Resolves immediately when under the limit, which is the overwhelmingly
 * common case and costs nothing.
 */
export function acquireSlot(
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<void> {
  // Local models are not metered by anyone; rate limiting them would only slow
  // the app down for no benefit.
  if (provider === 'builtin' || provider === 'ollama') return Promise.resolve();

  const key = `${provider}/${model}`;
  const bucket = bucketFor(key);
  const now = Date.now();

  if (bucket.queueLength === 0 && bucket.hasCapacity(now)) {
    bucket.record(now);
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('cancelled'));
      return;
    }

    const waiter: Waiter = { resolve, reject, queuedAt: Date.now(), signal };
    bucket.enqueue(waiter);

    // Reject the moment the caller gives up, rather than at the next drain.
    // Otherwise a cancelled request sits pending until a slot frees, and the
    // caller is left awaiting a promise for a message nobody wants any more.
    if (signal) {
      const onAbort = () => {
        bucket.remove(waiter);
        reject(new Error('cancelled'));
        notify(key);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // Stop holding the listener once the request goes through.
      const settled = () => signal.removeEventListener('abort', onAbort);
      waiter.resolve = () => {
        settled();
        resolve();
      };
      waiter.reject = (reason) => {
        settled();
        reject(reason);
      };
    }

    // Schedules the release and publishes the waiting state in one pass.
    bucket.drain(() => notify(key));
  });
}

/** Current state for a model, for a status readout. */
export function rateLimitState(provider: string, model: string): RateLimitState {
  const bucket = buckets.get(`${provider}/${model}`);
  if (!bucket) return { waiting: false, queued: 0, retryInSeconds: 0 };
  return {
    waiting: bucket.queueLength > 0,
    queued: bucket.queueLength,
    retryInSeconds: Math.ceil(bucket.msUntilSlot(Date.now()) / 1000),
  };
}

/** Forget all history. Exported for tests and for a settings reset. */
export function resetRateLimits(): void {
  buckets.clear();
}

/** The configured ceiling, so the UI can explain the limit it is applying. */
export const RATE_LIMIT = { maxRequests: MAX_REQUESTS, windowMs: WINDOW_MS };
