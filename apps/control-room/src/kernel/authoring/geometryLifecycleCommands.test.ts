import { describe, expect, it, vi } from "vitest";

import {
  awaitMeshCommandTerminal,
  commitObjectTransformTransaction,
  createObjectTransaction,
  deleteObjectTransaction,
  patchObjectGeometryTransaction,
  primitiveDraftOverlayStore,
  submitObjectMeshBuild,
} from "./geometryLifecycleCommands";

describe("geometry lifecycle command adapters", () => {
  it("keeps primitive preview state local and revision-independent", () => {
    const listener = vi.fn();
    const unsubscribe = primitiveDraftOverlayStore.subscribe(listener);
    const draft = {
      dimensions: [1e-7, 2e-7, 3e-8] as [number, number, number],
      errors: {},
      kind: "Box" as const,
      translation: [4e-9, 0, 0] as [number, number, number],
    };

    primitiveDraftOverlayStore.publish(draft);

    expect(primitiveDraftOverlayStore.getSnapshot()).toEqual(draft);
    expect(listener).toHaveBeenCalledOnce();
    primitiveDraftOverlayStore.clear();
    expect(primitiveDraftOverlayStore.getSnapshot()).toBeNull();
    unsubscribe();
  });

  it("commits object authoring through model transactions", async () => {
    const commitTransaction = vi.fn(async (request: unknown) => ({
      committed_scene: { revision: 12 },
      scene_revision: 12,
      transaction_kind: "create_object",
      request,
    }));
    const api = {
      model: {
        commitTransaction,
      },
    };

    await createObjectTransaction(api, {
      base_revision: 11,
      geometry: { kind: "box", size: [1, 2, 3] },
      name: "Box",
      object_id: "box",
    });
    await patchObjectGeometryTransaction(api, "box", {
      base_revision: 12,
      geometry: { kind: "box", size: [2, 2, 2] },
    });
    await commitObjectTransformTransaction(api, "box", {
      base_revision: 13,
      transform: { translation: [1, 0, 0] },
    });
    await deleteObjectTransaction(api, "box", { base_revision: 14 });

    expect(commitTransaction.mock.calls.map(([request]) => request)).toEqual([
      {
        base_revision: 11,
        geometry: { kind: "box", size: [1, 2, 3] },
        kind: "create_object",
        name: "Box",
        object_id: "box",
      },
      {
        base_revision: 12,
        geometry: { kind: "box", size: [2, 2, 2] },
        kind: "patch_object_geometry",
        object_id: "box",
      },
      {
        base_revision: 13,
        kind: "commit_object_transform",
        object_id: "box",
        transform: { translation: [1, 0, 0] },
      },
      {
        base_revision: 14,
        kind: "delete_object",
        object_id: "box",
      },
    ]);
  });

  it("submits selected-object mesh build through simulation commands", async () => {
    const submit = vi.fn(async (request: unknown) => ({
      accepted: true,
      command_id: "cmd-1",
      error: null,
      request,
    }));
    const api = {
      commands: {
        submit,
      },
    };

    await submitObjectMeshBuild(api, "box", "user-selected-object");

    expect(submit).toHaveBeenCalledWith({
      kind: "mesh_build",
      mesh_reason: "user-selected-object",
      mesh_target: { kind: "object_mesh", object_id: "box" },
    });
  });

  it("does not report success until the command is terminal and publishes a new mesh revision", async () => {
    const detail = vi
      .fn()
      .mockResolvedValueOnce({
        command_id: "cmd-1",
        status: "running",
        completion_status: null,
        resource_invalidations: [],
      })
      .mockResolvedValueOnce({
        command_id: "cmd-1",
        status: "completed",
        completion_status: "completed",
        resource_invalidations: [
          {
            resource_key: "meshing/shared-domain/manifest",
            revision: 8,
          },
        ],
      });

    const result = await awaitMeshCommandTerminal(
      { detail } as never,
      "cmd-1",
      { baseMeshRevision: 7, pollDelaysMs: [0, 0] },
    );

    expect(result.status).toBe("completed");
    expect(result.detail?.command_id).toBe("cmd-1");
    expect(detail).toHaveBeenCalledTimes(2);
  });

  it("keeps publication unconfirmed when a completed command has no new mesh revision", async () => {
    const detail = vi.fn().mockResolvedValue({
      command_id: "cmd-2",
      status: "completed",
      completion_status: "completed",
      resource_invalidations: [],
    });

    const result = await awaitMeshCommandTerminal(
      { detail } as never,
      "cmd-2",
      { baseMeshRevision: 7, pollDelaysMs: [0] },
    );

    expect(result.status).toBe("pending");
    expect(result.observation).toBe("publication-unconfirmed");
    expect(result.message).toContain("mesh revision");
  });

  it("fails when the authoritative command resource reports failure", async () => {
    const detail = vi.fn().mockResolvedValue({
      command_id: "cmd-failed",
      status: "failed",
      completion_status: "failed",
      error: "mesh generator rejected the domain",
      resource_invalidations: [],
    });

    const result = await awaitMeshCommandTerminal(
      { detail } as never,
      "cmd-failed",
      { pollDelaysMs: [0] },
    );

    expect(result).toEqual({
      commandId: "cmd-failed",
      detail: expect.objectContaining({ command_id: "cmd-failed" }),
      message: "mesh generator rejected the domain",
      status: "failed",
    });
  });

  it("preserves cancellation as a terminal command outcome", async () => {
    const detail = vi.fn().mockResolvedValue({
      command_id: "cmd-cancelled",
      status: "cancelled",
      completion_status: "cancelled",
      reason: "cancelled by user",
      resource_invalidations: [],
    });

    const result = await awaitMeshCommandTerminal(
      { detail } as never,
      "cmd-cancelled",
      { pollDelaysMs: [0] },
    );

    expect(result.status).toBe("cancelled");
    expect(result.message).toBe("cancelled by user");
  });

  it("treats lifecycle status as authoritative over a stale completion status", async () => {
    const detail = vi
      .fn()
      .mockResolvedValueOnce({
        command_id: "cmd-running",
        status: "running",
        completion_status: "completed",
        resource_invalidations: [],
      })
      .mockResolvedValueOnce({
        command_id: "cmd-running",
        status: "completed",
        completion_status: "completed",
        resource_invalidations: [
          { resource_key: "data/domain/topology", revision: 9 },
        ],
      });

    const result = await awaitMeshCommandTerminal(
      { detail } as never,
      "cmd-running",
      { pollDelaysMs: [0, 0] },
    );

    expect(result.status).toBe("completed");
    expect(detail).toHaveBeenCalledTimes(2);
  });

  it("keeps a long-running command pending and resumes the same authoritative id", async () => {
    vi.useFakeTimers();
    try {
      const detail = vi.fn().mockResolvedValue({
        command_id: "cmd-long", status: "running", resource_invalidations: [],
      });
      const pending = awaitMeshCommandTerminal({ detail } as never, "cmd-long", {
        baseMeshRevision: 7, pollDelaysMs: [0, 310_000],
      });
      await vi.advanceTimersByTimeAsync(310_000);
      expect(await pending).toMatchObject({
        commandId: "cmd-long", status: "pending", observation: "waiting",
      });
      expect(vi.getTimerCount()).toBe(0);
      detail.mockResolvedValue({
        command_id: "cmd-long", status: "completed",
        resource_invalidations: [{ resource_key: "data/domain/topology", revision: 8 }],
      });
      expect(await awaitMeshCommandTerminal({ detail } as never, "cmd-long", {
        baseMeshRevision: 7, pollDelaysMs: [0],
      })).toMatchObject({ commandId: "cmd-long", status: "completed" });
      expect(detail.mock.calls.every(([id]) => id === "cmd-long")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports lost observation without reporting a mesh failure or leaving timers", async () => {
    const detail = vi.fn().mockRejectedValue(new Error("network disconnected"));
    const result = await awaitMeshCommandTerminal({ detail } as never, "cmd-offline", {
      pollDelaysMs: [0, 10_000],
    });
    expect(result).toMatchObject({
      commandId: "cmd-offline", detail: null, status: "pending", observation: "disconnected",
    });
    expect(detail).toHaveBeenCalledOnce();
  });

  it("never completes a command with another command's resource", async () => {
    const detail = vi.fn().mockResolvedValue({
      command_id: "cmd-foreign", status: "completed",
      resource_invalidations: [{ resource_key: "data/domain/topology", revision: 99 }],
    });
    const result = await awaitMeshCommandTerminal({ detail } as never, "cmd-own", {
      baseMeshRevision: 7, pollDelaysMs: [0],
    });
    expect(result).toMatchObject({ commandId: "cmd-own", detail: null, status: "pending" });
  });

  it("does not make an extra unbudgeted detail request for an empty observation budget", async () => {
    const detail = vi.fn();
    expect(await awaitMeshCommandTerminal({ detail } as never, "cmd-empty", {
      pollDelaysMs: [],
    })).toMatchObject({ commandId: "cmd-empty", detail: null, status: "pending" });
    expect(detail).not.toHaveBeenCalled();
  });

});
