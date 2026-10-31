import { describe, it, expect } from "vitest";
import { commandReducer, isCommandExpired, OpsError } from "../src/index";
import type { Command } from "@hash8/sdk-ts";
import { NOW } from "./fixtures";

const cmd = (over: Partial<Command> = {}): Command => ({
  id: "cmd-1", deviceId: "dev-1", message: "reboot", data: {}, status: "queued", requestedBy: "user:1",
  createdAt: "2026-10-31T11:00:00.000Z", updatedAt: "2026-10-31T11:00:00.000Z", ...over,
});
const at = "2026-10-31T11:05:00.000Z";

describe("commandReducer", () => {
  it("queued -> sent -> acked", () => {
    const s = commandReducer(cmd(), { type: "sent", at });
    expect(s.status).toBe("sent");
    expect(s.updatedAt).toBe(at);
    expect(commandReducer(s, { type: "ack", at }).status).toBe("acked");
  });
  it("does not mutate input", () => {
    const c = cmd();
    commandReducer(c, { type: "sent", at });
    expect(c.status).toBe("queued");
  });
  it("fail records error", () => {
    const f = commandReducer(cmd({ status: "sent" }), { type: "fail", at, error: "NACK 0x02" });
    expect(f).toMatchObject({ status: "failed", error: "NACK 0x02" });
  });
  it("timeout from sent", () => {
    expect(commandReducer(cmd({ status: "sent" }), { type: "timeout", at }).status).toBe("timeout");
  });
  it("cancel from queued and sent", () => {
    expect(commandReducer(cmd(), { type: "cancel", at }).status).toBe("cancelled");
    expect(commandReducer(cmd({ status: "sent" }), { type: "cancel", at }).status).toBe("cancelled");
  });
  it("tolerates ack racing ahead of sent", () => {
    expect(commandReducer(cmd(), { type: "ack", at }).status).toBe("acked");
  });
  it.each(["acked", "failed", "timeout", "cancelled"] as const)("rejects events on terminal %s", (status) => {
    expect(() => commandReducer(cmd({ status }), { type: "sent", at })).toThrow(OpsError);
  });
  it("rejects sent twice with INVALID_COMMAND_TRANSITION", () => {
    try {
      commandReducer(cmd({ status: "sent" }), { type: "sent", at });
      expect.unreachable();
    } catch (e) {
      expect((e as OpsError).code).toBe("INVALID_COMMAND_TRANSITION");
    }
  });
});

describe("isCommandExpired", () => {
  it("expires sent commands after timeout since last update", () => {
    expect(isCommandExpired(cmd({ status: "sent", updatedAt: "2026-10-31T11:58:00.000Z" }), NOW, 60)).toBe(true);
    expect(isCommandExpired(cmd({ status: "sent", updatedAt: "2026-10-31T11:59:30.000Z" }), NOW, 60)).toBe(false);
  });
  it("expires queued commands too", () => {
    expect(isCommandExpired(cmd(), NOW, 60)).toBe(true);
  });
  it("never expires terminal commands", () => {
    expect(isCommandExpired(cmd({ status: "acked" }), NOW, 1)).toBe(false);
  });
});
