import { describe, expect, it, vi } from "vitest";

import {
  commitObjectTransformTransaction,
  createObjectTransaction,
  deleteObjectTransaction,
  patchObjectGeometryTransaction,
  submitObjectMeshBuild,
} from "./geometryLifecycleCommands";

describe("geometry lifecycle command adapters", () => {
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
});
