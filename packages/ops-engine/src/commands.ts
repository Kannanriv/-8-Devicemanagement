import type { Command, CommandStatus } from "@hash8/sdk-ts";
import { OpsError } from "./errors";

export type CommandEventType = "sent" | "ack" | "fail" | "timeout" | "cancel";
export interface CommandEvent {
  type: CommandEventType;
  at: string;
  error?: string;
}

/**
 * Allowed transitions. `ack` is accepted from `queued` because a device ack can
 * race ahead of the transport's "sent" confirmation.
 */
const NEXT: Partial<Record<CommandStatus, Partial<Record<CommandEventType, CommandStatus>>>> = {
  queued: { sent: "sent", ack: "acked", fail: "failed", timeout: "timeout", cancel: "cancelled" },
  sent: { ack: "acked", fail: "failed", timeout: "timeout", cancel: "cancelled" },
};

export function isTerminalCommand(status: CommandStatus): boolean {
  return NEXT[status] === undefined;
}

export function commandReducer(cmd: Command, event: CommandEvent): Command {
  const next = NEXT[cmd.status]?.[event.type];
  if (!next) {
    throw new OpsError(
      "INVALID_COMMAND_TRANSITION",
      `Command ${cmd.id} in status ${cmd.status} cannot accept event ${event.type}`,
      { status: cmd.status, event: event.type },
    );
  }
  const out: Command = { ...cmd, status: next, updatedAt: event.at };
  if (next === "failed") out.error = event.error ?? "Command failed";
  else if (next === "timeout") out.error = event.error ?? "No acknowledgement before timeout";
  return out;
}

/** True when a non-terminal command has seen no state change for longer than timeoutSec. */
export function isCommandExpired(cmd: Command, now: Date, timeoutSec: number): boolean {
  if (isTerminalCommand(cmd.status)) return false;
  const since = Date.parse(cmd.updatedAt);
  if (Number.isNaN(since)) return true;
  return now.getTime() - since > timeoutSec * 1000;
}
