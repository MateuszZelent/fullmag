import { describe, expect, it, vi } from "vitest";

import { PendingFormRegistry, type PendingForm } from "./PendingFormRegistry";

function form(patch: Partial<PendingForm> = {}): PendingForm {
  return {
    apply: vi.fn(async () => true),
    applying: false,
    dirty: true,
    mode: "staged",
    reset: vi.fn(async () => undefined),
    valid: true,
    ...patch,
  };
}

describe("PendingFormRegistry", () => {
  it("exposes the active staged form to shared Apply and Reset commands", async () => {
    const registry = new PendingFormRegistry();
    const owner = Symbol("form");
    const active = form();
    registry.register(owner, active);

    expect(registry.getSnapshot()).toMatchObject({
      active: true,
      canApply: true,
      canReset: true,
      dirty: true,
      registeredCount: 1,
    });
    await expect(registry.apply()).resolves.toMatchObject({ status: "completed" });
    await expect(registry.reset()).resolves.toMatchObject({ status: "completed" });
    expect(active.apply).toHaveBeenCalledOnce();
    expect(active.reset).toHaveBeenCalledOnce();
  });

  it("blocks Apply for invalid, locked, live, immediate and clean forms", () => {
    const cases: Partial<PendingForm>[] = [
      { valid: false },
      { lockReason: "Conflict" },
      { mode: "liveViewport" },
      { mode: "immediate" },
      { dirty: false },
    ];

    for (const patch of cases) {
      const registry = new PendingFormRegistry();
      registry.register(Symbol("form"), form(patch));
      expect(registry.canApply()).toBe(false);
    }
  });

  it("updates and removes the owner without leaving stale pending state", () => {
    const registry = new PendingFormRegistry();
    const owner = Symbol("form");
    registry.register(owner, form());
    registry.update(owner, form({ dirty: false }));
    expect(registry.getSnapshot()).toMatchObject({ canApply: false, dirty: false });

    registry.unregister(owner);
    expect(registry.getSnapshot()).toMatchObject({
      active: false,
      canApply: false,
      canReset: false,
      registeredCount: 0,
    });
  });

  it("returns a failed command result when a panel callback rejects", async () => {
    const registry = new PendingFormRegistry();
    registry.register(
      Symbol("form"),
      form({ apply: vi.fn(async () => { throw new Error("conflict"); }) }),
    );

    await expect(registry.apply()).resolves.toMatchObject({
      message: "Inspector Apply failed: conflict",
      status: "failed",
    });
  });
});
