import { describe, expect, it } from "vitest";
import {
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
} from "@/kernel/resources/studyRuntimeResources";

import {
  airboxInspectorRuntimeStatusEquals,
  selectAirboxInspectorRuntimeStatus,
} from "./airboxInspectorRuntimeStatus";

describe("airboxInspectorRuntimeStatus", () => {
  it("selects only the runtime fields used by mesh resource gates", () => {
    expect(
      selectAirboxInspectorRuntimeStatus({
        data: {
          capabilities: { explicit_topology: true },
          domain: { discretization: "fem" },
          resources: { mesh_build_revision: 7, mesh_revision: 8 },
        },
      } as never),
    ).toEqual({
      capabilities: { explicit_topology: true },
      domain: { discretization: "fem" },
      resources: { mesh_build_revision: 7, mesh_revision: 8 },
    });
  });

  it("returns null without status and compares selected snapshots structurally", () => {
    expect(selectAirboxInspectorRuntimeStatus({ data: null } as never)).toBeNull();
    const left = selectAirboxInspectorRuntimeStatus({
      data: {
        capabilities: { explicit_topology: false },
        domain: { discretization: "fdm" },
        resources: { mesh_build_revision: null, mesh_revision: null },
      },
    } as never);
    expect(airboxInspectorRuntimeStatusEquals(left, { ...left! })).toBe(true);
    expect(
      airboxInspectorRuntimeStatusEquals(left, {
        ...left!,
        domain: { discretization: "fem" },
      }),
    ).toBe(false);
  });

  it("keeps summary and manifest resources disabled until runtime evidence exists", () => {
    expect(shouldLoadRuntimeMeshSummary(true, null)).toBe(false);
    expect(shouldLoadRuntimeMeshManifest(true, null)).toBe(false);

    const unavailable = {
      capabilities: { explicit_topology: true },
      domain: { discretization: "fem" },
      resources: { mesh_build_revision: 0, mesh_revision: 0 },
    };
    expect(shouldLoadRuntimeMeshSummary(true, unavailable)).toBe(false);
    expect(shouldLoadRuntimeMeshManifest(true, unavailable)).toBe(false);

    const available = {
      ...unavailable,
      resources: { mesh_build_revision: 2, mesh_revision: 3 },
    };
    expect(shouldLoadRuntimeMeshSummary(true, available)).toBe(true);
    expect(shouldLoadRuntimeMeshManifest(true, available)).toBe(true);
  });
});
