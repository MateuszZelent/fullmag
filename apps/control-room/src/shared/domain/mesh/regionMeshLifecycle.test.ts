import { describe, expect, it } from "vitest";

import { resolveRegionMeshLifecycle } from "./regionMeshLifecycle";

const membership = {
  boundary_face_indices: [1],
  element_indices: [2],
  freshness: "current",
  mesh_generation_id: "generation-7",
  mesh_id: "shared-domain",
  mesh_part_ids: ["part:core"],
  mesh_revision: 7,
  node_indices: [3],
  owner_object_id: "film",
  realization: "conformal",
  region_id: "film:core",
  region_membership_revision: 9,
  source: "fem_shared_domain",
  topology_fingerprint: "topology-7",
};

describe("resolveRegionMeshLifecycle", () => {
  it("distinguishes an authored draft from a realized mesh", () => {
    expect(
      resolveRegionMeshLifecycle({
        build: null,
        draftDirty: true,
        membership,
        policyEnabled: true,
        supported: true,
      }),
    ).toMatchObject({
      status: "draft",
      reason: expect.stringContaining("Unapplied"),
    });
  });

  it("reports a certified current conformal membership", () => {
    expect(
      resolveRegionMeshLifecycle({
        build: null,
        draftDirty: false,
        membership,
        policyEnabled: true,
        supported: true,
      }),
    ).toMatchObject({
      generationId: "generation-7",
      membershipRevision: 9,
      status: "current",
      topologyFingerprint: "topology-7",
    });
  });

  it("fails closed for unsupported local region policies", () => {
    expect(
      resolveRegionMeshLifecycle({
        build: null,
        draftDirty: false,
        membership: null,
        policyEnabled: true,
        supported: false,
      }),
    ).toMatchObject({ status: "unsupported" });
  });

  it("prioritizes pending and failed build states over stale membership", () => {
    expect(
      resolveRegionMeshLifecycle({
        build: {
          active_build: { command_id: "cmd-1" } as never,
          mesh_pipeline_status: [],
          revision: 8,
        },
        draftDirty: false,
        membership: { ...membership, freshness: "stale" },
        policyEnabled: true,
        supported: true,
      }),
    ).toMatchObject({ status: "pending" });

    expect(
      resolveRegionMeshLifecycle({
        build: {
          active_build: null,
          last_build_error: "marker certificate rejected",
          mesh_pipeline_status: [],
          revision: 8,
        },
        draftDirty: false,
        membership: { ...membership, freshness: "stale" },
        policyEnabled: true,
        supported: true,
      }),
    ).toMatchObject({ status: "failed", reason: "marker certificate rejected" });
  });

  it("treats a malformed membership payload as stale instead of throwing", () => {
    expect(() =>
      resolveRegionMeshLifecycle({
        build: null,
        draftDirty: false,
        membership: { revision: 1 } as never,
        policyEnabled: true,
        supported: true,
      }),
    ).not.toThrow();

    expect(
      resolveRegionMeshLifecycle({
        build: null,
        draftDirty: false,
        membership: { revision: 1 } as never,
        policyEnabled: true,
        supported: true,
      }),
    ).toMatchObject({
      generationId: null,
      membershipRevision: null,
      status: "stale",
      topologyFingerprint: null,
    });
  });
});
