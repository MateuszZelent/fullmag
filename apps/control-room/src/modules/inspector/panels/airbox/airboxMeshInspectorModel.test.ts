import { describe, expect, it } from "vitest";

import type {
  MeshSharedDomainManifestResource,
  MeshUniverseQualityResource,
  MeshUniverseReportResource,
} from "@/kernel/api/apiTypes";

import {
  buildAirboxMeshBuildModel,
  buildAirboxMeshInspectorModel,
  aggregateAirboxMeshParts,
  findCanonicalAirboxPart,
  isDegradedBuildStatus,
} from "./airboxMeshInspectorModel";

type MeshPart = NonNullable<MeshSharedDomainManifestResource["mesh_parts"]>[number];

const part = (
  overrides: Partial<
    NonNullable<MeshSharedDomainManifestResource["mesh_parts"]>[number]
  > = {},
): MeshPart => ({
  boundary_face_count: 12,
  boundary_face_start: 0,
  element_count: 24,
  element_start: 0,
  id: "part:__air__",
  label: "Airbox",
  node_count: 16,
  node_start: 0,
  role: "air",
  ...overrides,
});

describe("airboxMeshInspectorModel", () => {
  it("distinguishes missing fallback evidence from an explicit strict empty list", () => {
    const missing = buildAirboxMeshBuildModel({
      current: ({
        revision: 1,
        shared_domain_build_report: { build_mode: "shared_domain" },
      } as unknown) as Parameters<typeof buildAirboxMeshBuildModel>[0]["current"],
      report: null,
    });
    const explicit = buildAirboxMeshBuildModel({
      current: ({
        revision: 1,
        shared_domain_build_report: {
          build_mode: "shared_domain",
          fallbacks_triggered: [],
        },
      } as unknown) as Parameters<typeof buildAirboxMeshBuildModel>[0]["current"],
      report: null,
    });

    expect(missing.fallbacksPublished).toBe(false);
    expect(explicit.fallbacksPublished).toBe(true);
  });

  it.each([
    "FAILED",
    "failure",
    "Error",
    "degraded",
    "rejected",
    "fallback",
    "warning",
    "unavailable",
    "invalid",
    "aborted",
    "canceled",
    "cancelled",
    " FAILED ",
    "bootstrap_failed",
    "error_during_meshing",
  ])("normalizes backend failure status %s as degraded", (status) => {
    expect(isDegradedBuildStatus(status)).toBe(true);
  });

  it.each(["active", "done", "idle", "ignored", "queued", "skipped", " SKIPPED ", "bootstrap_done"])(
    "does not classify non-failure status %s as degraded",
    (status) => {
      expect(isDegradedBuildStatus(status)).toBe(false);
    },
  );

  it.each([
    "not_failed",
    "error_free",
    "recovered_failed",
    "recovered_error",
  ])("keeps negated or recovered status %s non-degraded", (status) => {
    expect(isDegradedBuildStatus(status)).toBe(false);
  });

  it("does not infer degradation from a documented healthy OCC fallback", () => {
    const model = buildAirboxMeshBuildModel({
      current: ({
        revision: 12,
        shared_domain_build_report: {
          degraded: false,
          fallbacks_triggered: ["conformal_occ_hxt_degenerate_retry_delaunay"],
          operation_statuses: [{ kind: "retry", scope: "occ", status: "recovered_failed" }],
        },
      } as unknown) as Parameters<typeof buildAirboxMeshBuildModel>[0]["current"],
      report: null,
    });

    expect(model.status).toBe("current");
  });

  it("derives degraded build lifecycle from the current build direct error", () => {
    expect(
      buildAirboxMeshBuildModel({
        current: ({
          last_build_error: "tetrahedralization failed",
          revision: 9,
        } as unknown) as Parameters<typeof buildAirboxMeshBuildModel>[0]["current"],
        report: null,
      }),
    ).toMatchObject({
      reason: "tetrahedralization failed",
      revision: 9,
      status: "degraded",
    });
  });

  it("models typed build phases, report, policies, operations, fallbacks, and bounded raw details", () => {
    const model = buildAirboxMeshBuildModel({
      current: ({
        active_build: { payload: "x".repeat(5_000) },
        effective_airbox_target: { maximum_element_size: 2e-8 },
        last_build_summary: { state: "failed" },
        mesh_pipeline_status: [
          {
            detail: "Netgen rejected the volume",
            id: "tetrahedralize",
            label: "Tetrahedralize",
            status: "failed",
          },
        ],
        policy_diff: [
          {
            effect: "clamped",
            path: "airbox_hmax",
            scope: "airbox",
          },
        ],
        provenance: {
          build_id: "build-11",
          command_id: "command-10",
          completed_at_unix_ms: 1_720_000_000_000,
          duration_ms: 1250,
          geometry_realization_revision: 8,
          mesh_revision: 9,
          requested_policy_revision: 7,
          source_scene_revision: 6,
        },
        published_resources: {
          manifest: "meshing/manifest/11",
          mesh_build_revision: 11,
          mesh_revision: 9,
          quality: "meshing/quality/11",
          realized_size_fields: "meshing/size-fields/11",
        },
        resolved_policy: { airbox_grading: "geometric" },
        revision: 11,
        shared_domain_build_report: {
          build_mode: "shared_domain_mesh_with_air",
          degraded: true,
          fallbacks_triggered: ["fallback-tetrahedralizer"],
          operation_statuses: [
            {
              kind: "tetrahedralize",
              reason: "primary operation failed",
              requested: true,
              scope: "shared-domain",
              status: "degraded",
            },
          ],
        },
        source_scene_revision: 10,
      } as unknown) as Parameters<typeof buildAirboxMeshBuildModel>[0]["current"],
      latest: ({
        geometry_realization_revision: 8,
        last_success: { build_id: "build-9", artifact: "mesh-9" },
        revision: 9,
        source_scene_revision: 6,
      } as unknown) as Parameters<typeof buildAirboxMeshBuildModel>[0]["latest"],
      report: null,
    });

    expect(model).toMatchObject({
      buildMode: "shared_domain_mesh_with_air",
      effectiveAirboxTarget: { maximum_element_size: 2e-8 },
      fallbacks: ["fallback-tetrahedralizer"],
      operationStatuses: [
        {
          kind: "tetrahedralize",
          reason: "primary operation failed",
          status: "degraded",
        },
      ],
      phases: [
        {
          detail: "Netgen rejected the volume",
          id: "tetrahedralize",
          status: "failed",
        },
      ],
      policyDiff: [{ effect: "clamped", path: "airbox_hmax", scope: "airbox" }],
      provenance: {
        buildId: "build-11",
        commandId: "command-10",
        completedAtUnixMs: 1_720_000_000_000,
        durationMs: 1250,
        geometryRealizationRevision: 8,
        meshRevision: 9,
        requestedPolicyRevision: 7,
        sourceSceneRevision: 6,
      },
      publishedResources: {
        manifest: "meshing/manifest/11",
        mesh_build_revision: 11,
        mesh_revision: 9,
        quality: "meshing/quality/11",
        realized_size_fields: "meshing/size-fields/11",
      },
      reason: "Netgen rejected the volume",
      resolvedPolicy: { airbox_grading: "geometric" },
      sourceSceneRevision: 10,
      status: "degraded",
    });
    expect(model.latestSuccess).toMatchObject({
      geometryRealizationRevision: 8,
      lastSuccess: null,
      revision: 9,
      sourceSceneRevision: 6,
    });
    expect(new TextEncoder().encode(model.rawDetails.serialized).byteLength).toBeLessThanOrEqual(4_096);
    expect(model.rawDetails.serialized).toContain("activeBuild");
    expect(model.rawDetails.serialized).toContain("lastBuildSummary");
  });

  it("bounds an oversized universe report before exposing it to the panel", () => {
    const model = buildAirboxMeshBuildModel({
      current: null,
      latest: null,
      report: ({
        report: { payload: "x".repeat(5_000), status: "FAILED" },
        revision: 20,
      } as unknown) as MeshUniverseReportResource,
    });

    expect(model.status).toBe("degraded");
    expect(model.rawDetails.truncated).toBe(true);
    expect(model.rawDetails.serialized).toContain("universeReport");
    expect(new TextEncoder().encode(model.rawDetails.serialized).byteLength).toBeLessThanOrEqual(4_096);
  });

  it("enforces one aggregate raw JSON budget across every former Build-panel bypass", () => {
    const huge = "ż".repeat(5_000);
    const model = buildAirboxMeshBuildModel({
      current: ({
        active_build: { huge },
        effective_airbox_target: { huge },
        last_build_summary: { huge },
        policy_diff: [{ path: "raw", previous: { huge }, realized: { huge }, requested: { huge }, scope: "airbox" }],
        resolved_policy: { huge },
        revision: 30,
      } as unknown) as Parameters<typeof buildAirboxMeshBuildModel>[0]["current"],
      latest: ({
        effective_airbox_target: { huge },
        last_success: { huge },
        revision: 29,
      } as unknown) as Parameters<typeof buildAirboxMeshBuildModel>[0]["latest"],
      report: ({ report: { huge }, revision: 30 } as unknown) as MeshUniverseReportResource,
    });

    const bytes = new TextEncoder().encode(model.rawDetails.serialized).byteLength;
    expect(bytes).toBeLessThanOrEqual(4_096);
    expect(model.rawDetails.truncated).toBe(true);
    for (const key of [
      "activeBuild",
      "currentEffectiveAirboxTarget",
      "lastBuildSummary",
      "latestEffectiveAirboxTarget",
      "latestSuccess",
      "policyDiff",
      "resolvedPolicy",
      "universeReport",
    ]) {
      expect(model.rawDetails.serialized).toContain(key);
    }
    expect(model.rawDetails.serialized).not.toContain(huge);
  });

  it("bounds a long lifecycle reason before rendering", () => {
    const reason = "backend failure ".repeat(400);
    const model = buildAirboxMeshBuildModel({
      current: ({ last_build_error: reason, revision: 31 } as unknown) as Parameters<
        typeof buildAirboxMeshBuildModel
      >[0]["current"],
      report: null,
    });

    expect(model.reason).not.toBe(reason);
    expect(new TextEncoder().encode(model.reason).byteLength).toBeLessThanOrEqual(512);
  });

  it.each([
    {
      current: {
        mesh_pipeline_status: [{ detail: "phase failed", status: "failed" }],
        revision: 12,
      },
      reason: "phase failed",
    },
    {
      current: {
        revision: 13,
        shared_domain_build_report: {
          build_mode: "shared_domain_mesh_with_air",
          degraded: true,
        },
      },
      reason: "Backend reported degraded mesh build evidence.",
    },
  ])("never reports current for failed/degraded typed build evidence", ({ current, reason }) => {
    const model = buildAirboxMeshBuildModel({
      current: (current as unknown) as Parameters<
        typeof buildAirboxMeshBuildModel
      >[0]["current"],
      report: null,
    });

    expect(model.status).toBe("degraded");
    expect(model.reason).toBe(reason);
  });

  it("keeps canonical authored policy separate from backend-effective values", () => {
    const model = buildAirboxMeshInspectorModel({
      manifest: null,
      policy: {
        config: { airbox_hmax: 8e-9, mode: "manual" },
        effective_config: { airbox_hmax: 9e-9, curvature_factor: 0.3 },
        revision: 7,
      },
      quality: null,
      report: null,
      summary: { effective_airbox_target: { maximum_element_size: 1e-8 }, revision: 8 },
    });

    expect(model.parameters.authored).toEqual({
      airbox_hmax: 8e-9,
      mode: "manual",
    });
    expect(model.parameters.effective).toMatchObject({
      airbox_hmax: 9e-9,
      curvature_factor: 0.3,
    });
    expect(model.parameters.resolvedTarget).toEqual({
      maximum_element_size: 1e-8,
    });
  });

  it("reports missing and stale backend evidence without inventing Airbox quality", () => {
    const missing = buildAirboxMeshInspectorModel({
      manifest: null,
      policy: { config: null, effective_config: null, revision: 4 },
      quality: null,
      report: null,
      summary: null,
    });
    expect(missing.qualityGates).toMatchObject({
      evidence: "backend",
      reason: "Airbox-scoped quality gates are not published by the backend.",
      status: "unknown",
    });
    expect(missing.build).toMatchObject({ status: "missing" });

    const stale = buildAirboxMeshInspectorModel({
      manifest: {
        mesh_id: "mesh-4",
        mesh_name: "Shared mesh",
        mesh_parts: [part()],
        revision: 4,
        topology_fingerprint: "topology-4",
      },
      policy: { config: {}, effective_config: {}, revision: 6 },
      quality: ({ quality: { status: "pass" }, revision: 4 } as unknown) as MeshUniverseQualityResource,
      report: ({ report: { status: "complete" }, revision: 4 } as unknown) as MeshUniverseReportResource,
      summary: { revision: 4 },
    });
    expect(stale.lifecycle).toMatchObject({
      reason: "Mesh evidence revision 4 is older than policy revision 6.",
      status: "stale",
    });
  });

  it("keeps lifecycle stale when any published mesh evidence predates policy", () => {
    const model = buildAirboxMeshInspectorModel({
      manifest: {
        mesh_id: "mesh-4",
        mesh_name: "Shared mesh",
        mesh_parts: [part()],
        revision: 4,
        topology_fingerprint: "topology-4",
      },
      policy: { config: {}, effective_config: {}, revision: 6 },
      quality: null,
      report: ({ report: { status: "complete" }, revision: 6 } as unknown) as MeshUniverseReportResource,
      summary: null,
    });

    expect(model.lifecycle.status).toBe("stale");
    expect(model.lifecycle.reason).toContain("revision 4");
  });

  it("prefers manifest role and canonical carrier over marker zero heuristics", () => {
    const markerZero = part({
      id: "part:marker-zero",
      label: "Marker zero",
      role: "object",
    }) as ReturnType<typeof part> & { marker: number };
    markerZero.marker = 0;
    const canonicalCarrier = part({ id: "part:__air__", role: "carrier" });
    const roleAir = part({ id: "part:air-role", role: "air" });

    expect(findCanonicalAirboxPart([markerZero, canonicalCarrier, roleAir])?.id).toBe(
      "part:air-role",
    );
    expect(findCanonicalAirboxPart([markerZero, canonicalCarrier])?.id).toBe(
      "part:__air__",
    );
  });

  it("aggregates multiple Airbox carriers with unique node coverage", () => {
    const aggregate = aggregateAirboxMeshParts([
      part({
        boundary_face_count: 5,
        element_count: 8,
        id: "part:air-a",
        node_count: 4,
        node_start: 10,
        surface_faces: [[0, 1, 2]],
      }),
      part({
        boundary_face_count: 2,
        element_count: 4,
        id: "part:air-b",
        node_count: 4,
        node_start: 12,
        surface_faces: [[3, 4, 5], [6, 7, 8]],
      }),
      part({ id: "part:film", role: "magnetic_object" }),
    ]);

    expect(aggregate).toMatchObject({
      boundaryFaceCount: 7,
      carrierCount: 2,
      elementCount: 12,
      nodeCount: 6,
      nodeCountExact: true,
      partIds: ["part:air-a", "part:air-b"],
      surfaceFaceCount: 3,
    });
  });
  it("aggregates typed element families across Airbox carriers", () => {
    const first = part({ id: "part:air-a", element_count: 8 });
    const second = part({ id: "part:air-b", element_count: 4 });
    (first as unknown as Record<string, unknown>).element_counts_by_type = {
      pyramid5: 2,
      tet4: 6,
    };
    (second as unknown as Record<string, unknown>).element_counts_by_type = {
      pyramid5: 1,
      tet4: 3,
    };

    const model = buildAirboxMeshInspectorModel({
      manifest: {
        mesh_id: "mesh-airbox-families",
        mesh_name: "Shared mesh",
        mesh_parts: [first, second],
        revision: 10,
        topology_fingerprint: "topology-airbox-families",
      },
      policy: { config: {}, effective_config: {}, revision: 10 },
      quality: null,
      report: null,
      summary: null,
    });

    expect(model.statistics).toMatchObject({
      elementCount: 12,
      volumeElementCountScope: "airbox-parts",
    });
    expect(model.statistics.volumeElementsByType).toEqual(
      expect.arrayContaining([
        { count: 3, family: "pyramid5" },
        { count: 9, family: "tet4" },
      ]),
    );
  });
  it("exposes counts, bounds, and shared interface nodes with honest ownership", () => {
    const airboxPart = part({
      bounds_max: [2, 3, 4],
      bounds_min: [-2, -3, -4],
      boundary_face_indices: [1, 2],
      node_count: 16,
      node_indices: [0, 1, 2],
      surface_faces: [[0, 1, 2]],
    });
    (airboxPart as unknown as Record<string, unknown>).element_counts_by_type = {
      pyramid5: 4,
      tet4: 20,
    };
    const model = buildAirboxMeshInspectorModel({
      manifest: {
        mesh_id: "mesh-8",
        mesh_name: "Shared mesh",
        mesh_parts: [
          airboxPart,
        ],
        revision: 8,
        topology_fingerprint: "topology-8",
      },
      policy: { config: {}, effective_config: {}, revision: 8 },
      quality: null,
      report: ({
        report: { shared_interface_node_count: 5 },
        revision: 8,
      } as unknown) as MeshUniverseReportResource,
      summary: null,
    });

    expect(model.statistics).toMatchObject({
      boundaryFaceCount: 12,
      elementCount: 24,
      nodeCount: 16,
      pyramid5Count: 4,
      surfaceFaceCount: 1,
      tet4Count: 20,
    });
    expect(model.topology.bounds).toEqual({ max: [2, 3, 4], min: [-2, -3, -4] });
    expect(model.topology.sharedInterfaceNodes).toEqual({
      count: 5,
      label: "Shared interface nodes",
      ownership: "shared",
    });
  });

  it("uses typed shared-domain family counts as a labeled fallback when part counts are absent", () => {
    const manifest: MeshSharedDomainManifestResource = {
      mesh_id: "mesh-mixed",
      mesh_name: "Mixed mesh",
      mesh_parts: [part()],
      revision: 9,
      topology_fingerprint: "topology-mixed",
    };
    (manifest as unknown as Record<string, unknown>).element_counts_by_type = {
      pyramid5: 8,
      tet4: 40,
    };

    const model = buildAirboxMeshInspectorModel({
      manifest,
      policy: { config: {}, effective_config: {}, revision: 9 },
      quality: null,
      report: null,
      summary: null,
    });

    expect(model.statistics).toMatchObject({
      pyramid5Count: 8,
      tet4Count: 40,
      volumeElementCountScope: "shared-domain",
    });
  });

  it("marks failed build reports as degraded and preserves the direct reason", () => {
    const model = buildAirboxMeshInspectorModel({
      manifest: null,
      policy: { config: {}, effective_config: {}, revision: 2 },
      quality: null,
      report: ({
        report: { reason: "tetrahedralization failed", status: "failed" },
        revision: 2,
      } as unknown) as MeshUniverseReportResource,
      summary: null,
    });

    expect(model.build).toEqual({
      reason: "tetrahedralization failed",
      revision: 2,
      status: "degraded",
    });
  });
});
