import { describe, expect, it, vi } from "vitest";

import { inspectorActionState, type InspectorEditSession } from "../InspectorEditSession";
import {
  createObjectMaterialMutationCoordinator,
  combineObjectMaterialEditSessions,
  OBJECT_MATERIAL_MULTIPLE_DRAFTS_BLOCK_REASON,
  resolveObjectMaterialDraftApplyPolicy,
  type ObjectMaterialDraftScope,
} from "./ObjectMaterialPanelEditSession";

function session(
  patch: Partial<InspectorEditSession> = {},
): InspectorEditSession {
  return {
    apply: vi.fn(async () => true),
    applying: false,
    dirty: false,
    mode: "staged",
    reset: vi.fn(async () => undefined),
    valid: true,
    ...patch,
  };
}

describe("ObjectMaterialPanel edit session composition", () => {
  it("acquires one synchronous object lease before any React update can admit a second writer", () => {
    const coordinator = createObjectMaterialMutationCoordinator();
    const scopeKey = "session-a|object-a";
    const first = coordinator.acquire(scopeKey, "Create and assign material");

    if (!first) throw new Error("The first object mutation lease should be available");
    expect(coordinator.getActive(scopeKey)).toBe(first);
    expect(coordinator.acquire(scopeKey, "Apply assignment")).toBeNull();
    const otherObjectLease = coordinator.acquire("session-a|object-b", "Apply assignment");
    if (!otherObjectLease) throw new Error("A separate object should have an independent lease");
    expect(coordinator.finish({ ...first, token: Symbol("stale") })).toBe(false);
    expect(coordinator.getActive(scopeKey)).toBe(first);
    expect(coordinator.finish(first)).toBe(true);
    expect(coordinator.acquire(scopeKey, "Apply assignment")).not.toBeNull();
  });

  it("blocks multi-scope Apply and explains available local actions", () => {
    expect(
      resolveObjectMaterialDraftApplyPolicy([], new Set<ObjectMaterialDraftScope>()),
    ).toEqual({});
    expect(
      resolveObjectMaterialDraftApplyPolicy(
        ["parameters"],
        new Set<ObjectMaterialDraftScope>(),
      ),
    ).toEqual({});

    const parametersAndAnisotropy = resolveObjectMaterialDraftApplyPolicy(
      ["parameters", "anisotropy"],
      new Set<ObjectMaterialDraftScope>(["parameters", "anisotropy"]),
    );
    expect(parametersAndAnisotropy.applyBlockReason).toContain("Apply Parameters and Apply Anisotropy");
    expect(parametersAndAnisotropy.applyBlockReason).toContain("separate writes");

    const assignmentAndParameters = resolveObjectMaterialDraftApplyPolicy(
      ["assignment", "parameters"],
      new Set<ObjectMaterialDraftScope>(["assignment", "parameters"]),
    );
    expect(assignmentAndParameters.applyBlockReason).toContain("Apply Assignment first");
    expect(assignmentAndParameters.applyBlockReason).toContain("wait until the assigned material loads");
    expect(assignmentAndParameters.applyBlockReason).toContain("Apply Parameters");

    const hiddenAction = resolveObjectMaterialDraftApplyPolicy(
      ["parameters", "anisotropy"],
      new Set<ObjectMaterialDraftScope>(["parameters"]),
    );
    expect(hiddenAction.applyBlockReason).toContain("hides Apply Anisotropy");
    expect(hiddenAction.directApplyFailureReason).toContain("hides Apply Anisotropy");
  });

  it("routes Apply to the sole dirty draft and switches owners after acknowledgement", async () => {
    const materialApply = vi.fn(async () => true);
    const boundaryApply = vi.fn(async () => true);
    const material = session({ apply: materialApply, dirty: false });
    const boundary = session({ apply: boundaryApply, dirty: true });

    expect(await combineObjectMaterialEditSessions(material, boundary).apply()).toBe(true);
    expect(boundaryApply).toHaveBeenCalledOnce();
    expect(materialApply).not.toHaveBeenCalled();

    const afterBoundaryAcknowledgement = combineObjectMaterialEditSessions(
      { ...material, dirty: true },
      { ...boundary, dirty: false },
    );
    expect(afterBoundaryAcknowledgement.dirty).toBe(true);
    expect(await afterBoundaryAcknowledgement.apply()).toBe(true);
    expect(materialApply).toHaveBeenCalledOnce();
    expect(boundaryApply).toHaveBeenCalledOnce();
  });

  it("blocks global Apply when both drafts are dirty and keeps Revert available", async () => {
    const material = session({ dirty: true });
    const boundary = session({ dirty: true });
    const combined = combineObjectMaterialEditSessions(material, boundary);
    const actions = inspectorActionState(combined);

    expect(combined.applyBlockReason).toBe(OBJECT_MATERIAL_MULTIPLE_DRAFTS_BLOCK_REASON);
    expect(combined.valid).toBe(true);
    expect(actions.canApply).toBe(false);
    expect(actions.canReset).toBe(true);
    expect(await combined.apply()).toBe(false);
    expect(material.apply).not.toHaveBeenCalled();
    expect(boundary.apply).not.toHaveBeenCalled();
    expect(
      combineObjectMaterialEditSessions(
        { ...material, valid: false },
        boundary,
      ).valid,
    ).toBe(false);
  });

  it("reverts both dirty drafts and reports partial reset failure after attempting each", async () => {
    const materialReset = vi.fn(async () => undefined);
    const boundaryReset = vi.fn(async () => undefined);
    const material = session({ dirty: true, reset: materialReset });
    const boundary = session({ dirty: true, reset: boundaryReset });
    await combineObjectMaterialEditSessions(material, boundary).reset();
    expect(materialReset).toHaveBeenCalledOnce();
    expect(boundaryReset).toHaveBeenCalledOnce();

    materialReset.mockRejectedValueOnce(new Error("material reset failed"));
    await expect(
      combineObjectMaterialEditSessions(material, boundary).reset(),
    ).rejects.toThrow("Revert did not reset every dirty Inspector draft.");
    expect(materialReset).toHaveBeenCalledTimes(2);
    expect(boundaryReset).toHaveBeenCalledTimes(2);
  });

  it("does not treat a failed sole-owner Apply as success or apply the clean draft", async () => {
    const materialApply = vi.fn(async () => false);
    const boundaryApply = vi.fn(async () => true);
    const combined = combineObjectMaterialEditSessions(
      session({ apply: materialApply, dirty: true }),
      session({ apply: boundaryApply, dirty: false }),
    );

    expect(await combined.apply()).toBe(false);
    expect(materialApply).toHaveBeenCalledOnce();
    expect(boundaryApply).not.toHaveBeenCalled();
  });
});
