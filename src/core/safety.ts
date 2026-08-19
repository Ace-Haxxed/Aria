/**
 * Risk classification for the action log.
 *
 * NOVA executes every tool call the model makes, immediately and without
 * asking. This module no longer gates anything — it exists to label what
 * happened, so the action log can say how serious each call was and the UI can
 * colour it accordingly.
 *
 * The classification is still worth computing precisely: with no confirmation
 * step, the log is the only record of what NOVA did to this machine, and
 * "deleted a file" needs to stand out from "took a screenshot" when the user
 * goes looking for what went wrong.
 */
import type { RiskLevel, Settings, ToolCall, ToolDefinition } from './types';

export interface SafetyVerdict {
  risk: RiskLevel;
  /** One line, written for the user, describing exactly what happened. */
  summary: string;
  /** Why this call is notable — recorded alongside it in the action log. */
  reason?: string;
}

/**
 * Shell commands worth flagging as high risk in the log. These are the ones
 * that are irreversible, take the machine down, or need root — the entries
 * someone auditing the log after something went wrong is looking for.
 */
const HIGH_RISK_COMMANDS = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, // rm -rf and friends
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+.*\bof=\/dev\//i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /:\(\)\s*\{.*\}\s*;?\s*:/, // fork bomb
  /\bchmod\s+(-R\s+)?777\s+\//,
  /\b(curl|wget)\b.*\|\s*(sudo\s+)?(ba)?sh/i, // pipe-to-shell
  />\s*\/dev\/[sn]d[a-z]/i,
  /\bsudo\b/i,
];

function describeArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => {
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}: ${text.length > 90 ? `${text.slice(0, 89)}…` : text}`;
    });
  return parts.join(', ');
}

/** A human-readable one-liner for the action log and confirmation card. */
export function summariseCall(call: ToolCall, tool?: ToolDefinition): string {
  const a = call.args;

  switch (call.name) {
    case 'run_command':
      return `Run: ${String(a.cmd ?? '')}`;
    case 'delete_file':
      return `Move to trash: ${String(a.path ?? '')}`;
    case 'write_file':
      return `Write ${String(a.path ?? '')}`;
    case 'move_file':
      return `Move ${String(a.src ?? '')} → ${String(a.dst ?? '')}`;
    case 'install_package':
      return `Install package: ${String(a.name ?? '')}`;
    case 'remove_package':
      return `Remove package: ${String(a.name ?? '')}`;
    case 'update_system':
      return 'Update all system packages';
    case 'kill_app':
      return `Force-quit ${String(a.name ?? '')}`;
    case 'kill_process':
      return `Kill process ${String(a.target ?? '')}`;
    case 'close_window':
      return `Close window: ${String(a.target ?? '')}`;
    case 'power_action':
      return `${String(a.action ?? '')} the system`;
    case 'open_url':
      return `Open ${String(a.url ?? '')}`;
    case 'click':
      return a.x != null ? `Click at ${a.x}, ${a.y}` : 'Click';
    case 'type_text':
      return `Type: ${String(a.text ?? '').slice(0, 60)}`;
    case 'take_screenshot':
      return 'Take a screenshot';
    case 'manage_service':
      return `${String(a.action ?? '')} the ${String(a.name ?? '')} service`;
    default: {
      const detail = describeArgs(a);
      const label = tool?.description.split('.')[0] ?? call.name;
      return detail ? `${label} (${detail})` : label;
    }
  }
}

export function evaluate(call: ToolCall, tool: ToolDefinition | undefined): SafetyVerdict {
  const summary = summariseCall(call, tool);

  if (!tool) {
    return { risk: 'low', summary, reason: 'Unknown tool' };
  }

  let risk = tool.risk;
  let reason: string | undefined;

  // A shell command is judged on its content, not just on being a shell command.
  if (call.name === 'run_command') {
    const cmd = String(call.args.cmd ?? '');
    if (HIGH_RISK_COMMANDS.some((re) => re.test(cmd))) {
      return {
        risk: 'high',
        summary,
        reason: 'Irreversible or requires administrator rights.',
      };
    }
  }

  // Writing over an existing file in a system location is worse than writing
  // into the user's own documents.
  if (call.name === 'write_file') {
    const path = String(call.args.path ?? '');
    if (/^\/(etc|usr|bin|sbin|boot|sys|proc|var)\//.test(path) || /^C:\\Windows/i.test(path)) {
      risk = 'high';
      reason = 'This writes to a system location.';
    }
  }

  if (tool.destructive || risk === 'high') {
    return {
      risk: tool.destructive ? (risk === 'low' ? 'medium' : risk) : risk,
      summary,
      reason: reason ?? 'Changes the system and may be hard to undo.',
    };
  }

  return { risk, summary };
}

/**
 * Every tool is offered to the model.
 *
 * The per-capability toggles used to filter the tool list before the model saw
 * it. They are gone: a capability the user switched off produced a tool that
 * silently did not exist, which the model could not distinguish from the
 * feature being unimplemented, and it would loop trying to find another way.
 * Genuine refusals now come from the OS — a missing device, a denied portal —
 * and reach the model as real errors it can act on.
 */
export function capabilityAllowed(_tool: ToolDefinition, _settings: Settings): boolean {
  return true;
}
