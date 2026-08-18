/**
 * What the selected model costs you on a free plan.
 *
 * The published limits are the difference between a key that lasts a month and
 * one that stops working before lunch, and they are not intuitive: Groq's 70B
 * model has a *higher* per-minute allowance than the 8B but only a fifth of the
 * daily one. Stating both is the only way that choice can be made sensibly.
 */
import type { LLMProvider } from '@/core/types';
import { modelsFor } from '@/core/modelLimits';

export function ModelAllowance({
  provider,
  model,
}: {
  provider: LLMProvider;
  model: string;
}) {
  const limits = modelsFor(provider).find((m) => m.id === model);
  if (!limits) return null;

  const parts: string[] = [];
  if (limits.tokensPerMinute) parts.push(`${compact(limits.tokensPerMinute)} tokens/min`);
  if (limits.tokensPerDay) parts.push(`${compact(limits.tokensPerDay)} tokens/day`);
  if (limits.requestsPerDay) parts.push(`${compact(limits.requestsPerDay)} requests/day`);

  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      <div>
        Context window: {compact(limits.context)} tokens
        {parts.length > 0 && ` · free tier: ${parts.join(' · ')}`}
      </div>
      {limits.note && <div className="leading-relaxed">{limits.note}</div>}
    </div>
  );
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(n);
}
