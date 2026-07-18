import { describe, expect, it } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  planarVisualizationCoverage,
  planarViewScopeForSelection,
  resolveVisualizationViewContext,
} from "./VisualizationViewContext";

describe("visualization view context", () => {
  it("derives 3D/2D from the center surface and preserves the last spatial context", () => {
    expect(resolveVisualizationViewContext("field-map")).toBe("planar");
    expect(resolveVisualizationViewContext("viewport-3d", "planar")).toBe(
      "three-d",
    );
    expect(resolveVisualizationViewContext("analysis-plots", "planar")).toBe(
      "planar",
    );
  });

  it.each([
    ["scene", "domain"],
    ["model.object", "spatial"],
    ["model.object.region", "region"],
    ["resources.mesh.part", "mesh_part"],
    ["model.airbox", "airbox"],
    ["results.spatial.field", "spatial"],
    ["results.eigen.mode", "spatial"],
    ["model.planar.monitor", "monitor"],
  ])("covers %s in the shared planar inspector context", (kind, targetKind) => {
    expect(
      planarVisualizationCoverage({
        kind,
        label: "Target",
        moduleSource: "inspector",
        nodeId: "target",
        objectId: null,
        ref: null,
      } satisfies Selection),
    ).toEqual({ supported: true, targetKind });
  });

  it("maps mesh-part and airbox selections to runtime view scopes", () => {
    expect(
      planarViewScopeForSelection({
        kind: "mesh-part",
        label: "Part",
        moduleSource: "inspector",
        nodeId: "part-node",
        objectId: "object-1",
        ref: {
          carrierPartId: "part-7",
          kind: "mesh-part",
          nodeId: "part-node",
          objectId: "object-1",
          type: "mesh-part",
          visualizationTargetId: "part:part-7",
        },
      }),
    ).toEqual({ kind: "mesh_part", scope_id: "part-7" });
    expect(
      planarViewScopeForSelection({
        kind: "airbox.visualization",
        label: "Airbox",
        moduleSource: "inspector",
        nodeId: "airbox",
        objectId: null,
        ref: {
          kind: "airbox.visualization",
          nodeId: "airbox",
          type: "airbox",
          visualizationTargetId: "airbox",
        },
      }),
    ).toEqual({ kind: "airbox" });
  });
});
