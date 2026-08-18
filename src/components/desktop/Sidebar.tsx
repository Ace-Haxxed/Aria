import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Camera,
  ChevronDown,
  ChevronLeft,
  FolderOpen,
  Globe,
  MessageSquarePlus,
  Pin,
  Search,
  Trash2,
} from 'lucide-react';
import { ScrollArea, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/primitives';
import { useConversation } from '@/store/conversation';
import { cn } from '@/lib/utils';

interface QuickAction {
  label: string;
  icon: typeof Camera;
  prompt: string;
}

/** One-tap prompts for the things people ask for most. */
const QUICK_ACTIONS: QuickAction[] = [
  {
    label: 'What is on my screen?',
    icon: Camera,
    prompt: 'Take a screenshot and tell me what is on my screen.',
  },
  {
    label: 'Tidy my downloads',
    icon: FolderOpen,
    prompt:
      'Look through my Downloads folder and organise it into subfolders by file type. ' +
      'Tell me your plan before you move anything.',
  },
  {
    label: 'Search the web',
    icon: Globe,
    prompt: 'Search the web for ',
  },
  {
    label: 'System status',
    icon: Search,
    prompt: 'Give me a summary of this system: CPU, memory, disk and battery.',
  },
];

/** How many past conversations the history shows before it needs scrolling. */
const HISTORY_LIMIT = 10;

interface SidebarProps {
  onQuickAction: (prompt: string) => void;
  /** Owned by the layout, which renders the rail that brings it back. */
  collapsed: boolean;
  onCollapse: () => void;
}

export function Sidebar({ onQuickAction, collapsed, onCollapse }: SidebarProps) {
  const list = useConversation((s) => s.list);
  const currentId = useConversation((s) => s.current.id);
  const open = useConversation((s) => s.open);
  const remove = useConversation((s) => s.remove);
  const startNew = useConversation((s) => s.startNew);
  const refreshList = useConversation((s) => s.refreshList);

  const [historyOpen, setHistoryOpen] = useState(true);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const recent = list.slice(0, HISTORY_LIMIT);

  return (
    <aside
      className={cn(
        'relative flex h-full shrink-0 flex-col overflow-hidden transition-[width] duration-[600ms]',
        collapsed ? 'w-0' : 'w-[220px]',
      )}
      style={{
        background: 'hsl(222 71% 5% / 0.6)',
        backdropFilter: 'blur(10px)',
        borderRight: collapsed ? 'none' : '1px solid var(--border-subtle)',
        transitionTimingFunction: 'var(--aria-ease)',
      }}
    >
      {/* Held at full width while collapsing so the contents slide out as a
          block rather than reflowing to nothing on the way. */}
      <div className="flex h-full w-[220px] flex-col">
      <div className="p-3">
        {/* Outline by default, filling on hover — a solid cyan block here
            outweighs everything else in the panel. */}
        <button
          onClick={startNew}
          className="flex w-full items-center justify-center gap-2 rounded-lg border
            border-primary/50 px-3 py-2 text-[13px] text-primary transition-colors
            duration-150 hover:bg-primary hover:text-[hsl(var(--background))]"
        >
          <MessageSquarePlus className="h-4 w-4" />
          New conversation
        </button>
      </div>

      {/* Quick actions as a single row of icons. The labels live in tooltips:
          four of them stacked as full-width rows cost more vertical space than
          the history they were pushing down. */}
      <div className="flex items-center justify-between gap-1 px-3 pb-3">
        {QUICK_ACTIONS.map((action) => (
          <Tooltip key={action.label}>
            <TooltipTrigger asChild>
              <button
                onClick={() => onQuickAction(action.prompt)}
                aria-label={action.label}
                className="flex h-9 flex-1 items-center justify-center rounded-lg border
                  border-white/[0.07] bg-white/[0.03] text-muted-foreground
                  transition-colors duration-150 hover:border-primary/40 hover:text-primary"
              >
                <action.icon className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{action.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>

      <button
        onClick={() => setHistoryOpen((v) => !v)}
        className="flex items-center gap-1.5 px-4 pb-1 pt-2 text-muted-foreground
          transition-colors duration-150 hover:text-foreground"
        aria-expanded={historyOpen}
      >
        <ChevronDown
          className={cn(
            'h-3 w-3 transition-transform duration-150',
            !historyOpen && '-rotate-90',
          )}
        />
        <span
          className="text-[10px] uppercase tracking-[0.2em]"
          style={{ color: 'var(--text-dim)' }}
        >
          History
        </span>
        {list.length > 0 && (
          <span className="ml-auto font-mono text-[10px] opacity-60">{list.length}</span>
        )}
      </button>

      {historyOpen && (
        <ScrollArea className="aria-scroll flex-1">
          <div className="space-y-0.5 p-2">
            {recent.length === 0 && (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                Your conversations will appear here.
              </p>
            )}

            {recent.map((conversation) => (
              <motion.div
                key={conversation.id}
                layout
                className={cn(
                  'group flex items-start gap-1 rounded-lg border-l-2 px-2 py-1.5 transition-colors duration-150',
                  conversation.id === currentId
                    ? 'border-primary bg-[var(--bg-glass)] text-foreground'
                    : 'border-transparent hover:bg-[var(--bg-glass)] hover:text-foreground',
                )}
                style={
                  conversation.id === currentId ? undefined : { color: 'var(--text-secondary)' }
                }
              >
                <button
                  onClick={() => void open(conversation.id)}
                  className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                >
                  <span className="flex items-center gap-1.5">
                    {conversation.pinned && <Pin className="h-3 w-3 shrink-0 text-primary" />}
                    <span className="truncate text-[13px]">{conversation.title}</span>
                  </span>
                  {conversation.preview && (
                    <span className="truncate text-[10px] leading-tight opacity-55">
                      {conversation.preview}
                    </span>
                  )}
                </button>

                <button
                  onClick={() => void remove(conversation.id)}
                  className="mt-0.5 shrink-0 opacity-0 transition-opacity duration-150
                    hover:text-risk-high group-hover:opacity-100"
                  aria-label={`Delete ${conversation.title}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </motion.div>
            ))}
          </div>
        </ScrollArea>
      )}

      <button
        onClick={onCollapse}
        aria-label="Collapse sidebar"
        className="mt-auto flex items-center justify-center gap-1.5 py-2 text-[10px]
          uppercase tracking-[0.16em] text-muted-foreground transition-colors
          duration-150 hover:text-primary"
        style={{ borderTop: '1px solid var(--border-subtle)' }}
      >
        <ChevronLeft className="h-3 w-3" />
        Collapse
      </button>
      </div>
    </aside>
  );
}
