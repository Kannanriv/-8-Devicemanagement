import { describe, it, expect } from "vitest";
import { canTransition, transitionDevice, OpsError } from "../src/index";
import { makeDevice, NOW } from "./fixtures";

describe("canTransition", () => {
  it("allows transitions listed in LIFECYCLE_TRANSITIONS", () => {
    expect(canTransition("manufactured", "provisioned")).toBe(true);
    expect(canTransition("installed", "active")).toBe(true);
    expect(canTransition("suspended", "active")).toBe(true);
  });
  it("rejects unlisted transitions", () => {
    expect(canTransition("manufactured", "active")).toBe(false);
    expect(canTransition("active", "installed")).toBe(false);
  });
  it("rejects any transition out of retired and self-transitions", () => {
    expect(canTransition("retired", "active")).toBe(false);
    expect(canTransition("active", "active")).toBe(false);
  });
  it("rejects unknown states without throwing", () => {
    expect(canTransition("bogus" as never, "active")).toBe(false);
    expect(canTransition("active", "__proto__" as never)).toBe(false);
  });
});

describe("transitionDevice", () => {
  it("returns an updated device copy without mutating the input", () => {
    const d = makeDevice({ lifecycle: "active" });
    const r = transitionDevice(d, "maintenance", "user:42", NOW, "battery swap");
    expect(r.device.lifecycle).toBe("maintenance");
    expect(r.device.updatedAt).toBe(NOW.toISOString());
    expect(d.lifecycle).toBe("active");
  });
  it("emits a lifecycle timeline event", () => {
    const r = transitionDevice(makeDevice(), "suspended", "user:42", NOW, "unpaid");
    expect(r.timeline).toMatchObject({
      deviceId: "dev-1",
      at: NOW.toISOString(),
      kind: "lifecycle",
      detail: { from: "active", to: "suspended", actor: "user:42", note: "unpaid" },
    });
    expect(r.timeline.title).toContain("suspended");
  });
  it("emits an audit entry", () => {
    const r = transitionDevice(makeDevice(), "retired", "agent:fleet-copilot", NOW);
    expect(r.audit).toEqual({
      tenantId: "t-1",
      at: NOW.toISOString(),
      actor: "agent:fleet-copilot",
      action: "device.lifecycle.update",
      target: "device:dev-1",
      detail: { from: "active", to: "retired" },
    });
  });
  it("throws OpsError INVALID_TRANSITION for disallowed moves", () => {
    const d = makeDevice({ lifecycle: "retired" });
    expect(() => transitionDevice(d, "active", "system", NOW)).toThrow(OpsError);
    try {
      transitionDevice(d, "active", "system", NOW);
      expect.unreachable();
    } catch (e) {
      expect((e as OpsError).code).toBe("INVALID_TRANSITION");
      expect((e as OpsError).message).toContain("retired");
    }
  });
});
