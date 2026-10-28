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

  it("preserves an Apply blocker and never invokes a blocked form", async () => {
    const registry = new PendingFormRegistry();
    const reason = "Resolve the scene revision conflict before applying this draft.";
    const blockedApply = vi.fn(async () => true);
    const owner = Symbol("blocked-form");
    registry.register(owner, form({ apply: blockedApply, applyBlockReason: reason }));

    expect(registry.canApply()).toBe(false);
    expect(registry.getSnapshot()).toMatchObject({
      applyBlockReason: reason,
      canApply: false,
      lockReason: null,
    });
    expect(registry.getTransitionSnapshot()).toMatchObject({
      applyBlockedOwnerCount: 1,
      blockedReason: reason,
      canApplyPendingChanges: false,
    });
    await expect(registry.apply()).resolves.toEqual({ message: reason, status: "failed" });
    await expect(registry.prepareTransition({ applyPendingChanges: true })).rejects.toThrow(reason);
    expect(blockedApply).not.toHaveBeenCalled();
  });

  it("keeps Reset available when a form-specific blocker disables Apply", async () => {
    const registry = new PendingFormRegistry();
    const blocked = form({ applyBlockReason: "Rebase the draft first." });
    registry.register(Symbol("blocked-form"), blocked);

    expect(registry.canReset()).toBe(true);
    await expect(registry.reset()).resolves.toMatchObject({ status: "completed" });
    expect(blocked.reset).toHaveBeenCalledOnce();
    expect(blocked.apply).not.toHaveBeenCalled();
  });

  it("invalidates a pinned transition if the form-specific Apply blocker changes", async () => {
    const registry = new PendingFormRegistry();
    const clean = form({ dirty: false });
    registry.register(Symbol("clean-form"), clean);
    const guard = await registry.prepareTransition({ applyPendingChanges: false });

    clean.applyBlockReason = "Resolve the newly detected conflict first.";
    expect(() => guard.assertCurrent()).toThrow("The prepared workspace transition is no longer current.");
    guard.release();
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
