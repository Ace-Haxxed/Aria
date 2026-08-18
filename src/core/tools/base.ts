import type { Capability, ParamSchema, RiskLevel, ToolDefinition, ToolResult } from '../types';

/** Convenience constructors so tool files stay declarative. */
export const p = {
  string(description: string, extra?: Partial<ParamSchema>): ParamSchema {
    return { type: 'string', description, ...extra };
  },
  number(description: string, extra?: Partial<ParamSchema>): ParamSchema {
    return { type: 'number', description, ...extra };
  },
  integer(description: string, extra?: Partial<ParamSchema>): ParamSchema {
    return { type: 'integer', description, ...extra };
  },
  boolean(description: string, extra?: Partial<ParamSchema>): ParamSchema {
    return { type: 'boolean', description, ...extra };
  },
  enum(description: string, values: string[]): ParamSchema {
    return { type: 'string', description, enum: values };
  },
  array(description: string, items: ParamSchema): ParamSchema {
    return { type: 'array', description, items };
  },
  object(description: string, properties: Record<string, ParamSchema>): ParamSchema {
    return { type: 'object', description, properties };
  },
};

export function ok(output: string, data?: unknown): ToolResult {
  return { ok: true, output, data };
}

export function fail(error: string): ToolResult {
  return { ok: false, output: `Error: ${error}`, error };
}

/**
 * Wrap a raw implementation so a thrown error never escapes into the agent
 * loop — a tool that throws would abort the turn, whereas a tool that returns
 * an error lets the model read it and try something else.
 */
export function defineTool(spec: {
  name: string;
  description: string;
  capability: Capability;
  risk: RiskLevel;
  destructive?: boolean;
  platforms: Array<'desktop' | 'mobile'>;
  parameters: Record<string, ParamSchema>;
  required?: string[];
  run: (args: Record<string, unknown>) => Promise<ToolResult | string>;
}): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    capability: spec.capability,
    risk: spec.risk,
    destructive: spec.destructive,
    platforms: spec.platforms,
    parameters: spec.parameters,
    required: spec.required,
    async execute(args) {
      try {
        const result = await spec.run(args);
        return typeof result === 'string' ? ok(result) : result;
      } catch (e) {
        return fail(errorMessage(e));
      }
    },
  };
}

/** Tauri rejects with a plain string; everything else throws an Error. */
export function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

/* ── Argument coercion ───────────────────────────────────────────
 * Models routinely send "12" where a number is expected, or "true" for a
 * boolean. Rejecting those would waste a whole turn on a retry, so coerce
 * what is unambiguous and fail loudly on what is not.
 */

export function argString(args: Record<string, unknown>, key: string, fallback?: string): string {
  const v = args[key];
  if (typeof v === 'string') return v;
  if (v == null) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required argument \`${key}\``);
  }
  return String(v);
}

export function argNumber(args: Record<string, unknown>, key: string, fallback?: number): number {
  const v = args[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`argument \`${key}\` must be a number`);
}

export function argBool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = args[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (/^(true|yes|1)$/i.test(v)) return true;
    if (/^(false|no|0)$/i.test(v)) return false;
  }
  return fallback;
}

export function argStringArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    // Tolerate a JSON array sent as a string.
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* fall through to the single-value reading */
    }
    return [v];
  }
  throw new Error(`argument \`${key}\` must be an array`);
}

/** JSON Schema for one tool, as the OpenAI-style function-calling APIs expect. */
export function toJsonSchema(tool: { parameters: Record<string, ParamSchema>; required?: string[] }) {
  return {
    type: 'object' as const,
    properties: tool.parameters,
    required: tool.required ?? [],
  };
}
