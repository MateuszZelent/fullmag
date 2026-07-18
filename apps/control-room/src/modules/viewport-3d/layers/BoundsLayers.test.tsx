import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_AIRBOX_VISUALIZATION,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";

import type { Viewport3DMeshPart } from "../viewport3dDomainAdapter";
import { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type {
  Viewport3DFieldRenderModel,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";
import { getViewport3DVisualProfile } from "../viewport3dVisualProfile";
import {
  AirboxLayerContent,
  SelectionHighlightLayerContent,
  airboxWireframeOpacityFromSettings,
  buildBoundsVolumeWireframePositions,
  resolveAirboxRuntimeVisualizationSettings,
  resolveAirboxSurfaceColorState,
  resolveAirboxTopologyVisualizationSettings,
  resolveAirboxWireframeEdgeIndices,
  resolveAirboxWireframePrimitive,
  resolveAirboxWireframeSemantic,
  resolvePartNodeIndices,
  getUniqueSortedIndices,
} from "./BoundsLayers";
import { VERTEX_COLOR_MATERIAL_COLOR } from "./viewport3DLayerSettings";
import { resolveViewport3DMaterialProfile } from "./viewport3DMaterialProfile";

vi.mock("../viewport3dBatchedInvalidate", () => ({
  useBatchedInvalidate: () => () => undefined,
}));

vi.mock("./VectorFieldLayer", () => ({
  VectorFieldLayer: () => "instancedMesh",
}));

const colors = {
  accent: "#aaccff",
  background: "#000000",
  field: "#ffffff",
  mesh: "#dddddd",
  selection: "#ffff00",
  wire: "#999999",
};

const visibleWireframeAirbox: VisualizationTargetSettings = {
  ...DEFAULT_AIRBOX_VISUALIZATION,
  boundsVisible: false,
  geometryScope: "surface",
  surfaceOpacityPercent: 35,
  pointsVisible: false,
  renderMode: "wireframe",
  shaderVisible: false,
  vectorsVisible: false,
  visible: true,
  wireframeVisible: true,
};

const materialProfile = resolveViewport3DMaterialProfile(
  getViewport3DVisualProfile("interactive"),
);

const boundsLayersSource = readFileSync(
  join(process.cwd(), "src/modules/viewport-3d/layers/BoundsLayers.tsx"),
  "utf8",
);

it("lets diagnostics bypass airbox field-color buffer application", () => {
  expect(boundsLayersSource).toContain(
    "viewport3DFieldColorLayersEnabledFromBrowserConfig",
  );
  expect(boundsLayersSource).toContain("fieldColorLayersEnabled");
  expect(boundsLayersSource).toContain(
    "fieldColorLayersEnabled ? fieldModel : null",
  );
  expect(boundsLayersSource).toContain("useViewport3DScalarColorUpload");
  expect(boundsLayersSource).toContain(
    "geometry && renderPlan.surface.visible && fieldColorLayersEnabled",
  );
});

it("clears the exact Airbox surface adoption when it is no longer visible", () => {
  expect(boundsLayersSource).toContain("adoptionRegistry.clearAdoption(adoption)");
  expect(boundsLayersSource).toContain("unregister();");
});

it("does not build airbox point geometry when points are hidden", () => {
  expect(boundsLayersSource).toContain("if (!renderSettings.pointsVisible) return null;");
});

it("routes airbox mesh-part topology geometry adoption through the upload manager", () => {
  const start = boundsLayersSource.indexOf("const AirboxMeshPartLayer");
  const end = boundsLayersSource.indexOf("function AirboxWireframeFallback");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const airboxMeshPartLayerSource = boundsLayersSource.slice(start, end);

  expect(airboxMeshPartLayerSource).toContain("useViewport3DGeometryUpload");
  expect(airboxMeshPartLayerSource).toContain("createViewport3DGpuUploadManager");
  expect(airboxMeshPartLayerSource).toContain('lane: "topology-index"');
  expect(airboxMeshPartLayerSource).not.toContain("const geometry = useMemo");
  expect(airboxMeshPartLayerSource).not.toContain("const edgeGeometry = useMemo");
  expect(airboxMeshPartLayerSource).not.toContain("const pointsGeometry = useMemo");
});

it("routes airbox vector layer input through target-pass selection", () => {
  expect(boundsLayersSource).toContain(
    "resolveViewport3DTargetVectorLayerInput",
  );
  expect(boundsLayersSource).toContain("vectorLayerInput.buildReference");
  expect(boundsLayersSource).toContain("vectorLayerInput.segments");
  expect(boundsLayersSource).not.toContain(
    "fieldModel?.partVectorBuilds.get(part.id)",
  );
  expect(boundsLayersSource).not.toContain(
    "fieldModel?.partVectorSegments.get(part.id)",
  );
});

function airboxTopology(): Viewport3DTopologyRenderModel<Viewport3DMeshPart> {
  const part = {
    boundary_face_count: 1,
    boundary_face_start: 0,
    bounds_max: [1, 1, 1],
    bounds_min: [0, 0, 0],
    element_count: 1,
    element_start: 0,
    id: "airbox-part",
    label: "Airbox",
    node_count: 4,
    node_start: 0,
    role: "air",
  } as Viewport3DMeshPart;

  return {
    airboxParts: [
      {
        edgeIndices: null,
        fullNodeSelection: part,
        part,
        surfaceIndices: null,
        surfaceNodeIndices: null,
        surfaceNodeSelection: null,
        volumeEdgeIndices: null,
      },
    ],
    fallbackSurfaceEdgeIndices: null,
    fallbackSurfaceIndices: new Uint32Array(),
    fallbackSurfaceNodeIndices: new Uint32Array(),
    fallbackVolumeEdgeIndices: new Uint32Array(),
    magneticParts: [],
    meshGenerationId: null,
    meshRevision: null,
    meshTopologyHash: null,
    nodeCount: 4,
    positions: new Float32Array(),
  };
}

describe("AirboxLayer", () => {
  it("does not build unused normals for unlit airbox surfaces", () => {
    expect(boundsLayersSource).toContain("<meshBasicMaterial");
    expect(boundsLayersSource).not.toContain("computeVertexNormals");
  });

  it("renders wireframe-only airbox edges as hidden-edge overlays", () => {
    expect(resolveAirboxWireframeSemantic(visibleWireframeAirbox)).toBe(
      "hiddenEdges",
    );
    expect(
      resolveAirboxWireframeSemantic({
        ...visibleWireframeAirbox,
        shaderVisible: true,
      }),
    ).toBe("featureEdges");
    expect(
      resolveAirboxWireframeSemantic({
        ...visibleWireframeAirbox,
        geometryScope: "full",
        shaderVisible: true,
      }),
    ).toBe("hiddenEdges");
  });

  it("keeps full airbox wireframe scope when topology freshness is unknown", () => {
    expect(
      resolveAirboxTopologyVisualizationSettings(
        {
          ...visibleWireframeAirbox,
          geometryScope: "full",
          shaderVisible: true,
        },
        "unknown",
      ),
    ).toMatchObject({
      geometryScope: "full",
      renderMode: "wireframe",
      shaderVisible: false,
      wireframeVisible: true,
    });
  });

  it("preserves wireframe-only airbox settings at runtime", () => {
    expect(resolveAirboxRuntimeVisualizationSettings(visibleWireframeAirbox))
      .toBe(visibleWireframeAirbox);
  });

  it("preserves airbox settings that already have another drawable pass", () => {
    const settings = {
      ...visibleWireframeAirbox,
      shaderVisible: true,
    };

    expect(resolveAirboxRuntimeVisualizationSettings(settings)).toBe(settings);
  });

  it("uses volume edges for full airbox wireframe and surface edges for surface mode", () => {
    const surfaceEdges = new Uint32Array([0, 1, 1, 2]);
    const volumeEdges = new Uint32Array([0, 1, 1, 2, 2, 3]);
    const partModel = {
      edgeIndices: surfaceEdges,
      volumeEdgeIndices: volumeEdges,
    };

    expect(
      resolveAirboxWireframeEdgeIndices(
        "full",
        partModel,
      ),
    ).toBe(volumeEdges);
    expect(
      resolveAirboxWireframeEdgeIndices(
        "surface",
        partModel,
      ),
    ).toBe(surfaceEdges);
  });

  it("does not touch edge buffers when airbox wireframe is hidden", () => {
    const partModel = {
      get edgeIndices(): Uint32Array {
        throw new Error("surface edges should not be read");
      },
      get volumeEdgeIndices(): Uint32Array {
        throw new Error("volume edges should not be read");
      },
    };

    expect(
      resolveAirboxWireframeEdgeIndices(
        "full",
        partModel,
        false,
      ),
    ).toBeNull();
    expect(
      resolveAirboxWireframeEdgeIndices(
        "surface",
        partModel,
        false,
      ),
    ).toBeNull();
  });

  it("does not downgrade full airbox wireframe to surface edges when volume edges are unavailable", () => {
    const surfaceEdges = new Uint32Array([0, 1, 1, 2]);
    const partModel = {
      edgeIndices: surfaceEdges,
      volumeEdgeIndices: null,
    };

    expect(
      resolveAirboxWireframeEdgeIndices(
        "full",
        partModel,
      ),
    ).toBeNull();
    expect(
      resolveAirboxWireframeEdgeIndices(
        "surface",
        partModel,
      ),
    ).toBe(surfaceEdges);
  });

  it("keeps surface airbox wireframe on line segments when geometry exists", () => {
    expect(resolveAirboxWireframePrimitive(true, true)).toBe("lines");
    expect(resolveAirboxWireframePrimitive(true, false)).toBe("bounds");
    expect(resolveAirboxWireframePrimitive(false, true)).toBeNull();
  });

  it("keeps full volume airbox wireframe on line segments when edge geometry exists", () => {
    expect(resolveAirboxWireframePrimitive(true, true, "full")).toBe("lines");
    expect(resolveAirboxWireframePrimitive(true, false, "full")).toBe("bounds");
  });

  it("routes the airbox render branch through the parallel wireframe layers", () => {
    expect(boundsLayersSource).toContain(
      'renderPlan.wireframe.visible && (',
    );
    expect(boundsLayersSource).toContain(
      'geometryScope === "full" || !edgeGeometry',
    );
    expect(boundsLayersSource).not.toContain(
      "shouldRenderAirboxFullBoundsOverlay",
    );
    expect(boundsLayersSource).not.toContain("showFullWireframeBoundsOverlay");
  });

  it("keeps airbox wireframe opacity independent from air surface opacity", () => {
    expect(
      airboxWireframeOpacityFromSettings({
        ...visibleWireframeAirbox,
        surfaceOpacityPercent: 20,
        wireframeOpacityPercent: 100,
      }),
    ).toBe(1);
    expect(
      airboxWireframeOpacityFromSettings(
        {
          ...visibleWireframeAirbox,
          surfaceOpacityPercent: 20,
          wireframeOpacityPercent: 80,
        },
        { opacity: 0.5 },
      ),
    ).toBe(0.4);
  });

  it("uses active field scalar colors for airbox surface coloring", () => {
    const colorsByComponent = {
      colors: new Float32Array(12).fill(0.5),
      range: { max: 1, min: -1 },
    };
    const fieldModel = {
      complexFieldVector: null,
      derivedWorkItems: [],
      fullVectorBuild: null,
      fullVectorSegments: null,
      partVectorBuilds: new Map(),
      partVectorSegments: new Map(),
      scalarColors: null,
      scalarColorsByPartAndMode: new Map(),
      scalarColorsByMode: new Map([["x", colorsByComponent]]),
      targetDiagnostics: [],
      targetPasses: new Map(),
      visualizationPhaseRad: null,
    } satisfies Viewport3DFieldRenderModel;

    expect(
      resolveAirboxSurfaceColorState(
        {
          ...DEFAULT_AIRBOX_VISUALIZATION,
          shaderVisible: true,
          surfaceColorSource: "component_x",
        },
        fieldModel,
        "airbox",
        4,
        colors.mesh,
      ),
    ).toEqual({
      hasScalarColors: true,
      materialColor: VERTEX_COLOR_MATERIAL_COLOR,
      scalarColors: colorsByComponent,
      vertexColorsEnabled: true,
    });
  });

  it("does not fall back to global colors when an airbox target pass is unavailable", () => {
    const colorsByComponent = {
      colors: new Float32Array(12).fill(0.5),
      range: { max: 1, min: -1 },
    };
    const fieldModel = {
      complexFieldVector: null,
      derivedWorkItems: [],
      fullVectorBuild: null,
      fullVectorSegments: null,
      partVectorBuilds: new Map(),
      partVectorSegments: new Map(),
      scalarColors: null,
      scalarColorsByPartAndMode: new Map(),
      scalarColorsByMode: new Map([["x", colorsByComponent]]),
      targetDiagnostics: [],
      targetPasses: new Map([
        [
          "airbox",
          {
            fieldBuffer: null,
            fieldBufferState: "target-buffer",
            surface: {
              passId: "test:surface",
degradation: "sampled-buffer-not-surface-capable",
              scalarColorMode: "x",
              scalarColors: null,
            },
            vectors: {
              passId: "test:vector-glyph",
buildReference: null,
              degradation: null,
              segments: null,
            },
          },
        ],
      ]),
      visualizationPhaseRad: null,
    } satisfies Viewport3DFieldRenderModel;

    expect(
      resolveAirboxSurfaceColorState(
        {
          ...DEFAULT_AIRBOX_VISUALIZATION,
          shaderVisible: true,
          surfaceColorSource: "component_x",
        },
        fieldModel,
        "airbox",
        4,
        colors.mesh,
      ),
    ).toMatchObject({
      hasScalarColors: false,
      scalarColors: null,
      vertexColorsEnabled: true,
    });
  });

  it("builds an interior volume wireframe for full airbox fallback overlays", () => {
    const positions = buildBoundsVolumeWireframePositions(
      {
        center: [0, 0, 0],
        radius: Math.sqrt(3),
        size: [2, 2, 2],
      },
      2,
    );

    expect(positions).not.toBeNull();
    expect(positions?.length).toBe(162);
    expect(Array.from(positions ?? [])).toEqual(
      expect.arrayContaining([0, 0, -1, 0, 0, 1]),
    );
  });

  it("passes the airbox selection handler into mesh part layers", () => {
    const onSelectPart = vi.fn();
    const topologyModel = airboxTopology();
    const element = AirboxLayerContent({
      colors,
      fieldModel: null,
      materialProfile,
      onSelectPart,
      settings: visibleWireframeAirbox,
      topologyModel,
      topologyFreshness: "current",
      tracker: {} as never,
      vectorColorMode: "orientation",
      vectorStyle: {},
    });

    expect(isValidElement(element)).toBe(true);
    const fragment = element as ReactElement<{ children: ReactElement[] }>;
    const child = fragment.props.children[0];

    expect(isValidElement(child)).toBe(true);
    expect(child.props).toMatchObject({
      onSelectPart,
      materialProfile,
      settings: visibleWireframeAirbox,
      topologyModel,
      topologyFreshness: "current",
    });
  });

  it("renders vector-only airbox layers when sampled H_eff segments are present", () => {
    const topologyModel = airboxTopology();
    const tracker = new Viewport3DResourceTracker();
    const fieldModel = {
      complexFieldVector: null,
      derivedWorkItems: [],
      fullVectorBuild: null,
      fullVectorSegments: null,
      partVectorBuilds: new Map(),
      partVectorSegments: new Map([
        ["airbox-part", new Float32Array([0, 0, 0, 1, 0, 0, 1])],
      ]),
      scalarColors: null,
      scalarColorsByPartAndMode: new Map(),
      scalarColorsByMode: new Map(),
      targetDiagnostics: [],
      targetPasses: new Map(),
      visualizationPhaseRad: null,
    } satisfies Viewport3DFieldRenderModel;

    const markup = renderToStaticMarkup(
      <AirboxLayerContent
        colors={colors}
        fieldModel={fieldModel}
        materialProfile={materialProfile}
        onSelectPart={() => undefined}
        settings={{
          ...DEFAULT_AIRBOX_VISUALIZATION,
          boundsVisible: false,
          pointsVisible: false,
          shaderVisible: false,
          vectorsVisible: true,
          visible: true,
          wireframeVisible: false,
        }}
        topologyFreshness="current"
        topologyModel={topologyModel}
        tracker={tracker}
        vectorColorMode="orientation"
        vectorStyle={{}}
      />,
    );

    expect(markup).toContain("instancedMesh");
  });
});

describe("SelectionHighlightLayer", () => {
  it("renders a high-emphasis bounds box for selected primitive or mesh bounds", () => {
    const element = SelectionHighlightLayerContent({
      bounds: {
        center: [1, 2, 3],
        radius: 4,
        size: [5, 6, 7],
      },
      colors,
      materialProfile,
    });

    expect(isValidElement(element)).toBe(true);
    const boundsBox = element as ReactElement<{
      bounds: {
        center: [number, number, number];
        radius: number;
        size: [number, number, number];
      };
      color: string;
      opacity: number;
    }>;
    expect(boundsBox.props).toMatchObject({
      bounds: {
        center: [1, 2, 3],
        radius: 4,
        size: [5, 6, 7],
      },
      color: colors.accent,
      opacity: materialProfile.selectionShell.opacity,
    });
  });

  it("does not create a selection pass when there is no selection", () => {
    const element = SelectionHighlightLayerContent({
      bounds: null,
      colors,
      materialProfile,
    });
    expect(element).toBeNull();
  });
});

describe("resolvePartNodeIndices and getUniqueSortedIndices", () => {
  it("resolves node indices from node_indices array if present", () => {
    const part = { node_indices: [2, 4, 6] };
    const result = resolvePartNodeIndices(part, 10);
    expect(Array.from(result)).toEqual([2, 4, 6]);
  });

  it("resolves node indices from nodeStart and nodeCount range", () => {
    const part = { nodeStart: 2, nodeCount: 4 };
    const result = resolvePartNodeIndices(part, 10);
    expect(Array.from(result)).toEqual([2, 3, 4, 5]);
  });

  it("handles out of bounds cleanly during range resolution", () => {
    const part = { nodeStart: 8, nodeCount: 5 };
    const result = resolvePartNodeIndices(part, 10);
    expect(Array.from(result)).toEqual([8, 9]);
  });

  it("returns unique sorted indices for point sets", () => {
    const indices = new Uint32Array([5, 1, 5, 3, 1]);
    const result = getUniqueSortedIndices(indices);
    expect(Array.from(result)).toEqual([1, 3, 5]);
  });
});
