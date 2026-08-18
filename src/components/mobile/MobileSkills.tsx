import { Bell, Clipboard, Globe, Share2, Timer, Wifi } from 'lucide-react';
import { Card } from '@/components/ui/primitives';

interface Skill {
  label: string;
  description: string;
  icon: typeof Globe;
  prompt: string;
}

const SKILLS: Skill[] = [
  {
    label: 'Search the web',
    description: 'Look something up and summarise it',
    icon: Globe,
    prompt: 'Search the web for the latest news and give me a short summary.',
  },
  {
    label: 'Set a timer',
    description: 'Remind me in a few minutes',
    icon: Timer,
    prompt: 'Set a timer for 5 minutes.',
  },
  {
    label: 'Read my clipboard',
    description: 'Summarise or explain what I copied',
    icon: Clipboard,
    prompt: 'Read my clipboard and tell me what it says.',
  },
  {
    label: 'Share something',
    description: 'Draft a message and open the share sheet',
    icon: Share2,
    prompt: 'Help me draft a short message, then share it.',
  },
  {
    label: 'Notify me',
    description: 'Send a notification to this device',
    icon: Bell,
    prompt: 'Send me a test notification.',
  },
  {
    label: 'Check connection',
    description: 'Am I online, and on what?',
    icon: Wifi,
    prompt: 'Check my network status and battery level.',
  },
];

interface MobileSkillsProps {
  onRun: (prompt: string) => void;
}

export function MobileSkills({ onRun }: MobileSkillsProps) {
  return (
    <div className="p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Skills
      </h2>

      <div className="grid grid-cols-2 gap-3">
        {SKILLS.map((skill) => (
          <button key={skill.label} onClick={() => onRun(skill.prompt)} className="text-left">
            <Card className="h-full p-3.5 transition-colors active:bg-accent">
              <skill.icon className="mb-2 h-5 w-5 text-primary" />
              <div className="text-sm font-medium">{skill.label}</div>
              <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                {skill.description}
              </div>
            </Card>
          </button>
        ))}
      </div>
    </div>
  );
}
