import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  calls: {
    current: [] as boolean[],
    latest: [] as boolean[],
    report: [] as boolean[],
  },
  current: null as Record<string, unknown> | null,
  latest: null as Record<string, unknown> | null,
  meshBuildRevision: 0,
  meshRevision: 3,
  report: null as Record<string, unknown> | null,
}));

vi.mock("@/kernel/resources/useSessionStatus", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/kernel/resources/useSessionStatus")
  >();
  return {
    ...actual,
    useSessionStatusSelector: (selector: (status: unknown) => unknown) =>
      selector({
        data: {
          capabilities: { explicit_topology: true },
          domain: { discretization: "fem" },
          resources: {
            mesh_build_revision: testState.meshBuildRevision,
            mesh_revision: testState.meshRevision,
          },
        },
      }),
  };
});

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useMeshBuildCurrent: ({ enabled }: { enabled: boolean }) => {
    testState.calls.current.push(enabled);
    return { data: testState.current, status: enabled ? "ready" : "disabled" };
  },
  useMeshBuildLatestSuccessful: ({ enabled }: { enabled: boolean }) => {
    testState.calls.latest.push(enabled);
    return { data: enabled ? testState.latest : null, status: enabled ? "ready" : "disabled" };
  },
  useMeshUniverseReportResource: ({ enabled }: { enabled: boolean }) => {
    testState.calls.report.push(enabled);
    return { data: testState.report, status: enabled ? "ready" : "disabled" };
  },
}));

import type { Selection } from "@/kernel/selection/selectionTypes";
import { AirboxMeshBuildPanel } from "./AirboxMeshBuildPanel";

const selection = {
  kind: "airbox.mesh.build",
  label: "Build",
  moduleSource: "inspector",
  nodeId: "model:airbox:mesh:build",
  objectId: null,
  ref: null,
} satisfies Selection;

describe("AirboxMeshBuildPanel", () => {
  it("keeps every build-owned hook disabled until mesh_build_revision exists", () => {
    testState.meshBuildRevision = 0;
    testState.meshRevision = 3;
    testState.calls.current.length = 0;
    testState.calls.latest.length = 0;
    testState.calls.report.length = 0;

    renderToStaticMarkup(<AirboxMeshBuildPanel selection={selection} />);
    expect(testState.calls).toEqual({ current: [false], latest: [false], report: [false] });

    testState.meshBuildRevision = 4;
    renderToStaticMarkup(<AirboxMeshBuildPanel selection={selection} />);
    expect(testState.calls).toEqual({ current: [false, true], latest: [false, true], report: [false, true] });
  });

  it("renders typed degraded phase, report, fallback, operation, policy, and provenance data", () => {
    testState.meshBuildRevision = 7;
    testState.report = null;
    testState.current = {
      effective_airbox_target: { maximum_element_size: 2e-8 },
      mesh_pipeline_status: [
        {
          detail: "Netgen rejected the volume",
          id: "tetrahedralize",
          label: "Tetrahedralize",
          status: "failed",
        },
      ],
      policy_diff: [{ effect: "clamped", path: "airbox_hmax", scope: "airbox" }],
      provenance: {
        build_id: "build-7",
        command_id: "command-6",
        completed_at_unix_ms: 1_720_000_000_000,
        duration_ms: 900,
        geometry_realization_revision: 5,
        mesh_revision: 6,
        requested_policy_revision: 4,
        source_scene_revision: 3,
      },
      published_resources: {
        manifest: "meshing/manifest/7",
        mesh_build_revision: 7,
        mesh_revision: 6,
        quality: "meshing/quality/7",
        realized_size_fields: "meshing/size-fields/7",
      },
      resolved_policy: { airbox_grading: "geometric" },
      revision: 7,
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
      source_scene_revision: 6,
    };
    testState.latest = {
      geometry_realization_revision: 5,
      last_success: { artifact: "mesh-6", build_id: "build-6" },
      revision: 6,
      source_scene_revision: 3,
    };

    const html = renderToStaticMarkup(
      <AirboxMeshBuildPanel selection={selection} />,
    );
    expect(html).toContain("degraded");
    expect(html).toContain("Netgen rejected the volume");
    expect(html).toContain("shared_domain_mesh_with_air");
    expect(html).toContain("fallback-tetrahedralizer");
    expect(html).toContain("primary operation failed");
    expect(html).toContain("Bounded Build Details");
    expect(html).toContain("Source scene revision");
    expect(html).toContain("build-7");
    expect(html).toContain("command-6");
    expect(html).toContain("1720000000000");
    expect(html).toContain("meshing/manifest/7");
    expect(html).toContain("mesh-6");
    expect(html).toContain("Latest Successful Build");
  });

  it("renders bounded metadata instead of an oversized universe report", () => {
    testState.meshBuildRevision = 8;
    testState.current = null;
    testState.latest = null;
    testState.report = {
      report: { payload: "x".repeat(5_000), status: "FAILED" },
      revision: 8,
    };

    const html = renderToStaticMarkup(
      <AirboxMeshBuildPanel selection={selection} />,
    );
    expect(html).toContain("degraded");
    expect(html).toContain("truncated");
    expect(html).toContain("byteLength");
    expect(html).not.toContain("x".repeat(4_097));
    expect(html.match(/fm-mesh-json-preview/g)).toHaveLength(1);
  });

  it("bounds Unicode lifecycle, fallback, phase, and operation rows at the final DOM boundary", () => {
    const huge = "ż".repeat(2_000);
    testState.meshBuildRevision = 9;
    testState.report = null;
    testState.current = {
      last_build_error: huge,
      mesh_pipeline_status: [{ detail: huge, id: huge, label: huge, status: "failed" }],
      revision: 9,
      shared_domain_build_report: {
        degraded: true,
        fallbacks_triggered: Array.from({ length: 51 }, (_, index) => `fallback-${index}-${huge}`),
        operation_statuses: [{ kind: huge, reason: huge, scope: huge, status: "failed" }],
      },
    };

    const html = renderToStaticMarkup(<AirboxMeshBuildPanel selection={selection} />);
    expect(html).not.toContain("ż".repeat(513));
    expect(html).not.toContain("fallback-50-");
  });
});
