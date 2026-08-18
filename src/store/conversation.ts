/**
 * Conversation state: the active thread, the sidebar list, and the agent's
 * current state. This is the store the UI reads from most.
 */
import { create } from 'zustand';
import type { AgentState, Conversation, Message } from '@/core/types';
import {
  deleteConversation as removeConversation,
  deriveTitle,
  listConversations,
  loadConversation,
  newConversation,
  saveConversation,
  saveMessage,
} from '@/core/memory';
import { generateTitle } from '@/core/agent';
import { useSettings } from './settings';
import { uid } from '@/lib/utils';

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  /** First line of the most recent message, shown under the title. */
  preview?: string;
}

interface ConversationState {
  current: Conversation;
  list: ConversationSummary[];
  agentState: AgentState;
  /** Assistant text still streaming in, keyed by message id. */
  streaming: { id: string; text: string } | null;

  init: () => Promise<void>;
  setAgentState: (state: AgentState) => void;
  setStreaming: (id: string, text: string) => void;
  clearStreaming: () => void;

  addMessage: (message: Message) => void;
  addUserMessage: (content: string, images?: string[]) => Message;
  replaceMessage: (id: string, patch: Partial<Message>) => void;

  startNew: () => void;
  open: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  refreshList: () => Promise<void>;
}

export const useConversation = create<ConversationState>((set, get) => ({
  current: newConversation(),
  list: [],
  agentState: 'idle',
  streaming: null,

  async init() {
    await get().refreshList();
  },

  setAgentState(state) {
    set({ agentState: state });
  },

  setStreaming(id, text) {
    set({ streaming: { id, text } });
  },

  clearStreaming() {
    set({ streaming: null });
  },

  addMessage(message) {
    const current = get().current;
    // The streaming placeholder and the final message share an id; replace
    // rather than append so the bubble does not duplicate.
    const existing = current.messages.findIndex((m) => m.id === message.id);
    const messages =
      existing >= 0
        ? current.messages.map((m) => (m.id === message.id ? message : m))
        : [...current.messages, message];

    const updated: Conversation = { ...current, messages, updatedAt: Date.now() };
    set({ current: updated, streaming: null });

    if (useSettings.getState().settings.saveHistory) {
      void saveConversation(updated);
      void saveMessage(updated.id, message);
    }

    // Capture the finished exchange for a future local fine-tune. The record
    // is keyed on the assistant message id so a thumbs rating given later —
    // even after a reload — lands on the right row.
    if (message.role === 'assistant' && !message.streaming && message.content.trim()) {
      const prompt = [...messages]
        .reverse()
        .find((m) => m.role === 'user' && m.content.trim());
      if (prompt) {
        const llm = useSettings.getState().settings.llm;
        void import('./training').then((m) =>
          m.useTraining.getState().capture({
            id: message.id,
            user: prompt.content,
            assistant: message.content,
            model: `${llm.model}-${llm.provider}`,
          }),
        );
      }
    }
  },

  addUserMessage(content, images) {
    const message: Message = {
      id: uid('msg'),
      role: 'user',
      content,
      timestamp: Date.now(),
      images,
    };

    const current = get().current;
    const isFirst = current.messages.filter((m) => m.role === 'user').length === 0;
    const messages = [...current.messages, message];
    const updated: Conversation = {
      ...current,
      messages,
      updatedAt: Date.now(),
      title: isFirst ? deriveTitle(messages) : current.title,
    };
    set({ current: updated });

    if (useSettings.getState().settings.saveHistory) {
      void saveConversation(updated);
      void saveMessage(updated.id, message);
      void get().refreshList();

      // Ask the model for a better title in the background; a failure here
      // just leaves the truncated first message as the title.
      if (isFirst) {
        void generateTitle(useSettings.getState().settings, content).then((title) => {
          if (!title) return;
          const now = get().current;
          if (now.id !== updated.id) return;
          const titled = { ...now, title };
          set({ current: titled });
          void saveConversation(titled);
          void get().refreshList();
        });
      }
    }

    return message;
  },

  replaceMessage(id, patch) {
    set((s) => ({
      current: {
        ...s.current,
        messages: s.current.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      },
    }));
  },

  startNew() {
    set({ current: newConversation(), streaming: null, agentState: 'idle' });
  },

  async open(id) {
    const conversation = await loadConversation(id);
    if (conversation) set({ current: conversation, streaming: null, agentState: 'idle' });
  },

  async remove(id) {
    await removeConversation(id);
    if (get().current.id === id) get().startNew();
    await get().refreshList();
  },

  async refreshList() {
    try {
      set({ list: await listConversations() });
    } catch {
      set({ list: [] });
    }
  },
}));
