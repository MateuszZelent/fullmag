import { describe, expect, it, vi } from "vitest";

import { SIMULATION_PREPARATION_PATH } from "../api/apiPaths";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";

import { materializeCurrentLivePreparation } from "./livePreparationMaterialization";

function materializationApi({
  sourceSceneRevision = 17,
  status = "ready" as "ready" | "running",
} = {}) {
  const preparation = vi.fn(async () => ({
    preparation_id: "prep-current",
    status,
  }));
  const scene = vi.fn(async () => ({ revision: 17 }));
  const sharedDomainManifest = vi.fn(async () => ({
    source_scene_revision: sourceSceneRevision,
  }));
  const materializePreparation = vi.fn(async () => ({
    disposition: "accepted" as const,
    preparation_id: "prep-current",
    scene_revision: 17,
    run_id: "run-current",
    plan_fingerprint: `sha256:${"a".repeat(64)}`,
    receipt_sha256: `sha256:${"b".repeat(64)}`,
  }));
  const invalidate = vi.fn();

  return {
    context: {
      api: {
        meshing: { sharedDomainManifest },
        model: { scene },
        simulation: { materializePreparation, preparation },
      },
      resourceData: {
        [SESSION_STATUS_RESOURCE_KEY]: {
          capabilities: { explicit_topology: true },
          domain: { discretization: "fem" },
        },
      },
      resources: { invalidate },
      sessionScopeKey: "session=current&epoch=1&request_scope_epoch=api%3A1",
      source: "test" as const,
    } as never,
    invalidate,
    materializePreparation,
    preparation,
    scene,
    sharedDomainManifest,
  };
}

describe("Live preparation materialization", () => {
  it("accepts a receipt only after matching the current FEM mesh and scene revisions", async () => {
    const fixture = materializationApi();

    const outcome = await materializeCurrentLivePreparation(fixture.context, {
      expectedSceneRevision: 17,
      requireCurrentSharedDomainMesh: true,
    });

    expect(outcome.kind).toBe("materialized");
    expect(fixture.materializePreparation).toHaveBeenCalledWith(
      { preparation_id: "prep-current", scene_revision: 17 },
      { sessionScopeKey: "session=current&epoch=1&request_scope_epoch=api%3A1" },
    );
    expect(fixture.invalidate).toHaveBeenCalledWith(
      SIMULATION_PREPARATION_PATH,
      `sha256:${"b".repeat(64)}`,
    );
  });

  it("fails closed when the shared-domain mesh belongs to another scene revision", async () => {
    const fixture = materializationApi({ sourceSceneRevision: 16 });

    const outcome = await materializeCurrentLivePreparation(fixture.context, {
      expectedSceneRevision: 17,
      requireCurrentSharedDomainMesh: true,
    });

    expect(outcome).toMatchObject({ kind: "rejected" });
    expect(fixture.materializePreparation).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("does not materialize while the Live preparation is still running", async () => {
    const fixture = materializationApi({ status: "running" });

    const outcome = await materializeCurrentLivePreparation(fixture.context);

    expect(outcome).toMatchObject({ kind: "rejected" });
    expect(fixture.scene).not.toHaveBeenCalled();
    expect(fixture.materializePreparation).not.toHaveBeenCalled();
  });
});
