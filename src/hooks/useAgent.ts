/**
 * Wires the agent loop to the stores and to voice output.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlatformInfo, ToolDefinition } from '@/core/types';
import { runAgentTurn } from '@/core/agent';
import { getPlatformInfo, getTools, isTauri } from '@/platform';
import { useActions } from '@/store/actions';
import { useConversation } from '@/store/conversation';
import { useSettings } from '@/store/settings';
import { humanise, toast } from '@/store/toasts';
import { resolveProvider } from '@/core/providerChain';
import { decideRoute } from '@/core/routing';
import { fitToContext } from '@/core/context';
import { onRateLimitWait } from '@/core/llm';
import { onRateLimit } from '@/core/rateLimiter';
import { useToasts } from '@/store/toasts';
import { providerSpec } from '@/core/llm';

export function useAgent(
  speak?: (text: string) => void,
  /**
   * Speak sentences as they are generated. When supplied this takes over
   * entirely from `speak`, so a reply is never spoken twice.
   */
  speakSentence?: (sentence: string | null) => void,
) {
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [platform, setPlatform] = useState<PlatformInfo | null>(null);
  const [ready, setReady] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const settings = useSettings((s) => s.settings);
  const conversation = useConversation((s) => s.current);
  const agentState = useConversation((s) => s.agentState);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [loadedTools, info] = await Promise.all([getTools(), getPlatformInfo()]);
        if (cancelled) return;
        setTools(loadedTools);
        setPlatform(info);
      } catch (e) {
        toast.error(
          'Some tools are unavailable',
          humanise(e) + ' ARIA can still talk, but may not be able to act.',
        );
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    useConversation.getState().setAgentState('idle');
    useConversation.getState().clearStreaming();
    if (isTauri) void import('@/platform/desktop').then((m) => m.desktop.setTrayActive(false));
  }, []);

  const send = useCallback(
    async (text: string, images?: string[]) => {
      if (!platform || !text.trim()) return;

      // A new turn always supersedes anything still running.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const conv = useConversation.getState();
      conv.addUserMessage(text, images);

      const actions = useActions.getState();
      if (isTauri) void import('@/platform/desktop').then((m) => m.desktop.setTrayActive(true));

      const settings = useSettings.getState().settings;
      const startedAt = performance.now();

      // Decide which tier of model this deserves before choosing a backend, so
      // a one-line question is not sent to the slowest model available.
      const route = decideRoute(text, {
        hasImages: Boolean(images?.length),
        preference: settings.responseSpeed,
        history: useConversation.getState().current.messages,
      });

      // Pick a backend that can actually answer. This corrects a stale model
      // name and steps over an unreachable provider before the turn starts,
      // which is far better than failing half-way through one.
      let resolved;
      try {
        resolved = await resolveProvider(settings, route.tier);
      } catch (e) {
        conv.setAgentState('idle');
        toast.error('No AI backend available', humanise(e), {
          label: 'Open settings',
          run: () => {
            window.dispatchEvent(new CustomEvent('aria:open-settings'));
          },
        });
        return;
      }

      // A silent switch is the point of a fallback chain, but the user should
      // still be able to see what answered — as a notice, never an error.
      // Record the routing decision where the user can see it, rather than
      // leaving the choice of model unexplained.
      actions.start({
        id: `route-${Date.now()}`,
        tool: 'route',
        args: {},
        risk: 'low',
        status: 'ok',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        summary: `${route.tier} model · ${route.reason}`,
      });

      if (resolved.modelNote) toast.info(resolved.modelNote);
      if (resolved.substituted) {
        toast.info(
          `Using ${providerSpec(resolved.config.provider).label.split(' (')[0]}`,
          `${providerSpec(settings.llm.provider).label.split(' (')[0]} was unavailable.`,
        );
      }

      let lastAssistantId: string | null = null;
      let streamedChars = 0;

      // Keep the request inside the model's context window. A conversation
      // that outgrows it is refused by the provider with an error the user can
      // neither read nor fix, so it is trimmed here instead — quietly, unless
      // it takes long enough to be worth mentioning.
      const conversation = useConversation.getState().current;
      let fitted = conversation;
      try {
        const result = await fitToContext(
          resolved.config,
          conversation.messages,
          controller.signal,
        );
        if (result.trimmed) {
          fitted = { ...conversation, messages: result.messages };
          toast.info(
            'Summarised older messages',
            'The conversation had grown past what this model can hold.',
          );
        }
      } catch {
        // Trimming is best-effort: if it fails, the request goes as-is and
        // the provider's own limit handling takes over.
      }

      // Held back by our own limiter, before anything was sent. Distinct from
      // a provider rate limit: nothing failed, the request is simply queued.
      let holdToast: string | null = null;
      const stopWatchingQueue = onRateLimit((state) => {
        if (!state.waiting) {
          if (holdToast) useToasts.getState().dismiss(holdToast);
          holdToast = null;
          return;
        }
        if (holdToast) return;
        holdToast = useToasts.getState().push({
          kind: 'info',
          title: 'Hold on…',
          description:
            state.queued > 1
              ? `${state.queued} messages queued so we stay inside the rate limit.`
              : 'Pausing briefly to stay inside the rate limit.',
          duration: 0,
        });
      });

      // A rate limit is a wait, not a failure. Report it as a countdown so the
      // user can see it resolving rather than wondering what broke.
      let waitToast: string | null = null;
      onRateLimitWait((remaining) => {
        if (remaining <= 0) {
          if (waitToast) useToasts.getState().dismiss(waitToast);
          waitToast = null;
          return;
        }
        if (waitToast) useToasts.getState().dismiss(waitToast);
        waitToast = useToasts.getState().push({
          kind: 'info',
          title: `Rate limited — retrying in ${remaining}s`,
          description: 'Waiting for the provider’s limit to reset. Nothing to do.',
          duration: 0,
        });
      });

      try {
        await runAgentTurn({
          conversation: fitted,
          settings: { ...settings, llm: resolved.config },
          tools,
          platform,
          signal: controller.signal,
          callbacks: {
            onState: (state) => conv.setAgentState(state),
            onDelta: (id, streamed) => {
              streamedChars = streamed.length;
              conv.setStreaming(id, streamed);
            },
            onMessage: (message) => {
              if (message.role === 'assistant') lastAssistantId = message.id;
              conv.addMessage(message);
            },
            onActionStart: (entry) => actions.start(entry),
            onActionUpdate: (id, patch) => actions.update(id, patch),
            onImage: (dataUrl) => {
              if (useSettings.getState().settings.screenshotRetention !== 'never') {
                actions.setScreenshot(dataUrl);
              }
            },
            onSpeak: (spoken) => {
              if (speak && useSettings.getState().settings.voice.autoSpeak) {
                speak(spoken);
              }
            },
            // Present only when a sentence handler exists; the agent checks
            // for it to decide whether to stream speech at all.
            onSpeakSentence: speakSentence
              ? (sentence) => {
                  if (useSettings.getState().settings.voice.autoSpeak) {
                    speakSentence(sentence);
                  }
                }
              : undefined,
          },
        });
      } catch (e) {
        // A turn that dies outright leaves no assistant bubble to carry the
        // explanation, so it has to surface as a toast or the user simply
        // watches the orb go idle with no reply and no reason.
        conv.setAgentState('idle');
        toast.error('ARIA could not finish that', humanise(e), {
          label: 'Try again',
          run: () => void send(text, images),
        });
      } finally {
        onRateLimitWait(null);
        stopWatchingQueue();
        if (holdToast) useToasts.getState().dismiss(holdToast);
        if (waitToast) useToasts.getState().dismiss(waitToast);

        // Attach what answered and how fast, once the turn has settled.
        if (lastAssistantId) {
          const ms = Math.round(performance.now() - startedAt);
          conv.replaceMessage(lastAssistantId, {
            meta: {
              model: resolved.config.model,
              provider: resolved.config.provider,
              ms,
              // Providers seldom report token counts on a stream, and ~4
              // characters per token is close enough for a speed readout.
              tokens: Math.max(1, Math.round(streamedChars / 4)),
            },
          });
        }
        if (abortRef.current === controller) abortRef.current = null;
        if (isTauri) void import('@/platform/desktop').then((m) => m.desktop.setTrayActive(false));
      }
    },
    [platform, tools, speak],
  );

  // Abort any in-flight turn if the component unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    send,
    cancel,
    ready,
    tools,
    platform,
    settings,
    conversation,
    agentState,
    busy: agentState !== 'idle' && agentState !== 'listening',
  };
}
