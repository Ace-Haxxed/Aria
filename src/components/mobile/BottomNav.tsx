import { motion } from 'framer-motion';
import { FolderOpen, MessageCircle, Settings, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

export type MobileTab = 'chat' | 'skills' | 'files' | 'settings';

const TABS: Array<{ id: MobileTab; label: string; icon: typeof MessageCircle }> = [
  { id: 'chat', label: 'Chat', icon: MessageCircle },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'settings', label: 'Settings', icon: Settings },
];

interface BottomNavProps {
  active: MobileTab;
  onChange: (tab: MobileTab) => void;
}

export function BottomNav({ active, onChange }: BottomNavProps) {
  return (
    <nav
      className="aria-panel flex shrink-0 items-stretch border-x-0 border-b-0"
      // Keep the bar clear of the home indicator on gesture-navigation phones.
      style={{ paddingBottom: 'var(--safe-bottom)' }}
    >
      {TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={cn(
              'relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition-colors',
              selected ? 'text-primary' : 'text-muted-foreground',
            )}
            aria-current={selected ? 'page' : undefined}
          >
            {selected && (
              <motion.span
                layoutId="mobile-tab-indicator"
                className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-primary"
                transition={{ type: 'spring', damping: 30, stiffness: 400 }}
              />
            )}
            <tab.icon className="h-5 w-5" />
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
