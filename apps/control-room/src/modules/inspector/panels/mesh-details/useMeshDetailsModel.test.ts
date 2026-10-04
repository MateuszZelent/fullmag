import { describe, expect, it } from "vitest";

import {
  buildSharedDomainPolicyDiffRows,
  resolveCurrentMixedCertificateQualityPresentation,
  resolveMeshDetailsLane,
  resolveRetainedMeshArtifact,
  shouldLoadMeshDetailsFemResources,
} from "./useMeshDetailsModel";

describe("useMeshDetailsModel helpers", () => {
  it("exposes the exact published mesh retained after a failed candidate", () => {
    expect(resolveRetainedMeshArtifact({
      lastBuildError: "mesher rejected the candidate",
      latestSuccess: {
        build_id: "mesh:good",
        mesh_name: "previous mesh",
        source_scene_revision: 14,
      },
      manifest: {
        generation_id: "generation-7",
        mesh_id: "mesh-id-7",
        mesh_name: "published mesh",
        source_scene_revision: 14,
      },
      meshRevision: 7,
    })).toEqual({
      buildId: "mesh:good",
      generationId: "generation-7",
      meshId: "mesh-id-7",
      meshName: "published mesh",
      meshRevision: 7,
      sourceSceneRevision: 14,
      state: "retained",
    });
  });

  it("does not claim rollback when the published artifact identity is incomplete", () => {
    expect(resolveRetainedMeshArtifact({
      lastBuildError: "mesher rejected the candidate",
      latestSuccess: { build_id: "mesh:good" },
      manifest: null,
      meshRevision: null,
    })).toMatchObject({
      buildId: "mesh:good",
      state: "identity-unavailable",
    });
    expect(resolveRetainedMeshArtifact({
      lastBuildError: null,
      latestSuccess: { build_id: "mesh:good" },
      manifest: { mesh_id: "mesh-id-7" },
      meshRevision: 7,
    })).toBeNull();
  });

  it("only enables FEM mesh resources for an explicit FEM session lane", () => {
    expect(resolveMeshDetailsLane("fem")).toBe("fem");
    expect(resolveMeshDetailsLane("FEM")).toBe("fem");
    expect(resolveMeshDetailsLane("fdm")).toBe("fdm");
    expect(resolveMeshDetailsLane("auto")).toBe("unknown");
    expect(resolveMeshDetailsLane(null)).toBe("unknown");

    expect(shouldLoadMeshDetailsFemResources("fem", true)).toBe(true);
    expect(shouldLoadMeshDetailsFemResources("fem", false)).toBe(false);
    expect(shouldLoadMeshDetailsFemResources("fdm", true)).toBe(false);
    expect(shouldLoadMeshDetailsFemResources("unknown", true)).toBe(false);
  });

  it("builds current, draft, and realized shared-domain policy diff rows", () => {
    const rows = buildSharedDomainPolicyDiffRows({
      activeBuild: {
        requested_policy: {
          algorithm_3d: 1,
          airbox_hmax: 1e-8,
        },
        realized_policy: {
          algorithm_3d: 2,
          airbox_hmax: 1e-8,
        },
      },
      latestBuild: null,
      semantics: {
        shared_domain_policy: {
          algorithm_3d: 1,
          airbox_hmax: 2e-8,
        },
      },
    });

    expect(rows.map((row) => [row.path, row.currentValue, row.draftValue, row.realizedValue, row.state])).toEqual([
      ["airbox_hmax", "2e-8", "1e-8", "1e-8", "changed"],
      ["algorithm_3d", "1", "1", "2", "realized-drift"],
    ]);
  });

  it("suppresses cached certificate rows during invalidation, refresh failure, or revision drift", () => {
    const data = {
      mixed_certificate: {
        certificate_fingerprint: "sha256:mixed",
        certificate_schema_version: "mixed_layer_topology_certificate.v1",
        certificate_status: "accepted",
        family_gates: [
          {
            family: "prism6",
            metric: "mixed_topology_scaled_jacobian.v1",
            minimum_jacobian_m3: 2.5e-22,
            p05: 0.34,
            passed: true,
            positive_jacobian: true,
            threshold: 0.1,
          },
        ],
        mesh_revision: 91,
        status: "valid",
        topology_fingerprint: "sha256:mixed",
      },
      revision: 91,
    };

    expect(resolveCurrentMixedCertificateQualityPresentation({
      currentMeshRevision: 91,
      data,
      resourceStatus: "ready",
    }).familyGates).toHaveLength(1);

    for (const input of [
      { currentMeshRevision: 91, data, resourceStatus: "stale" as const },
      { currentMeshRevision: 91, data, resourceStatus: "error" as const },
      { currentMeshRevision: 92, data, resourceStatus: "ready" as const },
      {
        currentMeshRevision: 91,
        data: { ...data, revision: 92 },
        resourceStatus: "ready" as const,
      },
      {
        currentMeshRevision: 91,
        data: {
          ...data,
          mixed_certificate: { ...data.mixed_certificate, mesh_revision: 92 },
        },
        resourceStatus: "ready" as const,
      },
    ]) {
      const presentation = resolveCurrentMixedCertificateQualityPresentation(input);
      expect(presentation.status).toBe("stale");
      expect(presentation.familyGates).toEqual([]);
    }
  });
});
