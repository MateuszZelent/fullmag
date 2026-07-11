import { describe, expect, it } from "vitest";

import {
  resolveManifestRenderableCarrierKind,
  resolveVisualizationRenderResolution,
  resolveVisualizationTopologyFreshness,
} from "./visualizationDisplayResolution";
import type { VisualizationTargetSettings } from "./ObjectVisualizationController";

const visibleShaderVectorSettings = {
  geometryScope: "full",
  opacityPercent: 80,
  pointsVisible: true,
  renderMode: "surface",
  shaderVisible: true,
  vectorAlphaPercent: 100,
  vectorsVisible: true,
  visible: true,
  wireframeOpacityPercent: 30,
  wireframeVisible: false,
} as VisualizationTargetSettings;

describe("resolveVisualizationTopologyFreshness", () => {
  it("constrains stale topology to a wireframe-only ghost view", () => {
    const resolution = resolveVisualizationRenderResolution({
      effectiveSettings: visibleShaderVectorSettings,
      settings: visibleShaderVectorSettings,
      topologyFreshness: "stale",
    });

    expect(resolution.degradedReasons).toContainEqual(
      expect.objectContaining({ code: "topology-stale" }),
    );
    expect(resolution.finalSettings).toMatchObject({
      shaderVisible: false,
      pointsVisible: false,
      vectorsVisible: false,
      wireframeVisible: true,
    });
  });

  it("treats explicit manifest provenance mismatch as stale before coverage heuristics", () => {
    expect(
      resolveVisualizationTopologyFreshness(
        { revision: 12, objects: [{ id: "film", tags: ["mesh:ready"] }] },
        { source_scene_revision: 11, mesh_parts: [{ object_id: "film" }] },
      ),
    ).toBe("stale");
  });

  it("treats primitive-only scenes without manifest coverage as unknown topology", () => {
    expect(
      resolveVisualizationTopologyFreshness(
        {
          revision: 3,
          objects: [{ id: "film", visible: true }],
        },
        {
          revision: 1,
          mesh_parts: [],
        },
      ),
    ).toBe("unknown");
  });

  it("accepts topology without source revision only when the manifest covers visible objects", () => {
    expect(
      resolveVisualizationTopologyFreshness(
        {
          revision: 3,
          objects: [{ id: "film", visible: true }],
        },
        {
          revision: 1,
          mesh_parts: [{ id: "part-1", object_id: "film" }],
        },
      ),
    ).toBe("current");
  });

  it("recognizes object segments as explicit degraded manifest carriers", () => {
    expect(
      resolveManifestRenderableCarrierKind({
        meshPartCount: 0,
        objectSegmentCount: 1,
      }),
    ).toBe("object-segments");
    expect(
      resolveVisualizationTopologyFreshness(
        { revision: 3, objects: [{ id: "film", visible: true }] },
        { revision: 1, object_segments: [{ object_id: "film" }] },
      ),
    ).toBe("current");
  });
});
