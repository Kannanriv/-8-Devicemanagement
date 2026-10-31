import type { Automation, AutomationAction, Device, LifecycleState } from "@hash8/sdk-ts";
import { compileExpression, type CompiledExpression } from "./expression";
import { cronMatches } from "./cron";

export type AutomationEvent =
  | { type: "message"; codecId?: string; message?: string; data: Record<string, unknown>; device: Device }
  | { type: "lifecycle"; to: LifecycleState; device: Device }
  | { type: "offline"; minutes: number; device: Device }
  | { type: "schedule"; at: Date };

export interface AutomationResult {
  matched: boolean;
  actions: AutomationAction[];
  error?: string;
}

const compiled = new Map<string, CompiledExpression>();
function compileCached(src: string): CompiledExpression {
  let f = compiled.get(src);
  if (!f) {
    f = compileExpression(src);
    if (compiled.size > 5000) compiled.clear();
    compiled.set(src, f);
  }
  return f;
}

function triggerMatches(a: Automation, e: AutomationEvent): boolean {
  const t = a.trigger;
  if (t.type !== e.type) return false;
  switch (t.type) {
    case "message": {
      const ev = e as Extract<AutomationEvent, { type: "message" }>;
      return (!t.codecId || t.codecId === ev.codecId) && (!t.message || t.message === ev.message);
    }
    case "lifecycle":
      return t.to === (e as Extract<AutomationEvent, { type: "lifecycle" }>).to;
    case "offline":
      return (e as Extract<AutomationEvent, { type: "offline" }>).minutes >= t.minutes;
    case "schedule":
      return cronMatches(t.cron, (e as Extract<AutomationEvent, { type: "schedule" }>).at);
  }
}

/**
 * Condition scope: `data` (message payload, else {}), `device`, `event` (type plus
 * codecId/message/to/minutes), the same fields flattened (`minutes`, `to`, `message`,
 * `codecId`), and `time` = { hour, minute, weekday (0=Sun), iso } in UTC from `now`.
 */
function buildScope(e: AutomationEvent, now: Date): Record<string, unknown> {
  const { device: _d, at: _a, data: _data, ...rest } = e as Record<string, unknown>;
  return {
    ...rest,
    event: { ...rest },
    data: e.type === "message" ? e.data : {},
    device: "device" in e ? e.device : undefined,
    time: { hour: now.getUTCHours(), minute: now.getUTCMinutes(), weekday: now.getUTCDay(), iso: now.toISOString() },
  };
}

export function evaluateAutomation(a: Automation, event: AutomationEvent, now: Date): AutomationResult {
  const miss: AutomationResult = { matched: false, actions: [] };
  if (!a.enabled) return miss;
  try {
    if (!triggerMatches(a, event)) return miss;
    if (a.condition && a.condition.trim()) {
      const ok = compileCached(a.condition)(buildScope(event, now));
      if (!ok) return miss;
    }
    return { matched: true, actions: a.actions.map((x) => structuredClone(x)) };
  } catch (err) {
    return { ...miss, error: err instanceof Error ? err.message : String(err) };
  }
}
