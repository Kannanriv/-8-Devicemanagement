import { describe, it, expect } from "vitest";
import { LIFECYCLE_TRANSITIONS, type LifecycleState } from "@hash8/sdk-ts";
import { canTransition, transitionDevice, OpsError } from "../src/index";
import { makeDevice, NOW } from "./fixtures";

describe("canTransition", () => {
  it("follows the onboarding path registered → assigned → installing → pending_activation → activated", () => {
    expect(canTransition("registered", "assigned")).toBe(true);
    expect(canTransition("assigned", "installing")).toBe(true);
    expect(canTransition("installing", "pending_activation")).toBe(true);
    expect(canTransition("pending_activation", "activated")).toBe(true);
  });
  it("allows controlled maintenance / suspend / swap states", () => {
    expect(canTransition("activated", "maintenance")).toBe(true);
    expect(canTransition("activated", "suspended")).toBe(true);
    expect(canTransition("activated", "swap")).toBe(true);
    expect(canTransition("maintenance", "swap")).toBe(true);
    expect(canTransition("swap", "registered")).toBe(true);
    expect(canTransition("suspended", "activated")).toBe(true);
  });
  it("rejects skipping onboarding steps", () => {
    expect(canTransition("registered", "activated")).toBe(false);
    expect(canTransition("assigned", "activated")).toBe(false);
    expect(canTransition("suspended", "maintenance")).toBe(false);
  });
  it("matches LIFECYCLE_TRANSITIONS exhaustively", () => {
    const states = Object.keys(LIFECYCLE_TRANSITIONS) as LifecycleState[];
    for (const from of states) for (const to of states) {
      expect(canTransition(from, to)).toBe(LIFECYCLE_TRANSITIONS[from].includes(to));
    }
  });
  it("rejects any transition out of retired and self-transitions", () => {
    expect(canTransition("retired", "activated")).toBe(false);
    expect(canTransition("activated", "activated")).toBe(false);
  });
  it("rejects unknown states without throwing", () => {
    expect(canTransition("active" as never, "maintenance")).toBe(false);
    expect(canTransition("activated", "__proto__" as never)).toBe(false);
  });
});

describe("transitionDevice", () => {
  it("returns an updated device copy without mutating the input", () => {
    const d = makeDevice({ lifecycle: "activated" });
    const r = transitionDevice(d, "maintenance", "user:42", NOW, "battery swap");
    expect(r.device.lifecycle).toBe("maintenance");
    expect(r.device.updatedAt).toBe(NOW.toISOString());
    expect(d.lifecycle).toBe("activated");
  });
  it("stamps installedAt when installation starts and activatedAt on activation", () => {
    const inst = transitionDevice(makeDevice({ lifecycle: "assigned" }), "installing", "user:1", NOW);
    expect(inst.device.installedAt).toBe(NOW.toISOString());
    const act = transitionDevice(makeDevice({ lifecycle: "pending_activation" }), "activated", "user:1", NOW);
    expect(act.device.activatedAt).toBe(NOW.toISOString());
  });
  it("keeps an existing activatedAt when re-activating from maintenance", () => {
    const r = transitionDevice(makeDevice({ lifecycle: "maintenance", activatedAt: "2026-01-02T00:00:00.000Z" }), "activated", "user:1", NOW);
    expect(r.device.activatedAt).toBe("2026-01-02T00:00:00.000Z");
  });
  it("emits a lifecycle timeline event with human labels", () => {
    const r = transitionDevice(makeDevice(), "suspended", "user:42", NOW, "unpaid");
    expect(r.timeline).toMatchObject({
      deviceId: "dev-1",
      at: NOW.toISOString(),
      kind: "lifecycle",
      detail: { from: "activated", to: "suspended", actor: "user:42", note: "unpaid" },
    });
    expect(r.timeline.title).toContain("Suspended");
  });
  it("emits an audit entry", () => {
    const r = transitionDevice(makeDevice(), "retired", "agent:fleet-copilot", NOW);
    expect(r.audit).toEqual({
      tenantId: "t-1",
      at: NOW.toISOString(),
      actor: "agent:fleet-copilot",
      action: "device.lifecycle.update",
      target: "device:dev-1",
      detail: { from: "activated", to: "retired" },
    });
  });
  it("throws OpsError INVALID_TRANSITION for disallowed moves", () => {
    const d = makeDevice({ lifecycle: "retired" });
    expect(() => transitionDevice(d, "activated", "system", NOW)).toThrow(OpsError);
    try {
      transitionDevice(d, "activated", "system", NOW);
      expect.unreachable();
    } catch (e) {
      expect((e as OpsError).code).toBe("INVALID_TRANSITION");
      expect((e as OpsError).message).toContain("retired");
    }
  });
});
