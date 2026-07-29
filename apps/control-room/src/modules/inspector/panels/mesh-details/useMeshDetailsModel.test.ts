import { describe, expect, it } from "vitest";

import {
  buildSharedDomainPolicyDiffRows,
  resolveCurrentMixedCertificateQualityPresentation,
} from "./useMeshDetailsModel";

describe("useMeshDetailsModel helpers", () => {
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
            metric: "tetra_decomposition_scaled_jacobian.v1",
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
