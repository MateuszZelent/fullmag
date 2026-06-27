import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import { buildViewport3DTargetFieldBuffer } from "../model/viewport3DTargetFieldBuffer";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import type { Viewport3DFieldRenderModel } from "../viewport3dRenderModel";
import {
  attachViewport3DFieldColorBuildReference,
  chunkedScalarColorStateIsCompatible,
  createViewport3DFieldColorBuildReference,
  filterViewport3DChunkedScalarColorEntries,
  mergeViewport3DFieldScalarColors,
  resolveViewport3DChunkedFieldColorTarget,
  resolveViewport3DChunkedPartFieldInput,
  resolveViewport3DChunkedPartDisplayModesKey,
  shouldBuildViewport3DPartChunkedScalarColor,
  shouldStartChunkedScalarColorBuild,
} from "./useViewport3DChunkedScalarColors";

const sourceUrl = new URL("./useViewport3DChunkedScalarColors.ts", import.meta.url);
const fallbackLayerSource = readFileSync(
  join(process.cwd(), "src/modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx"),
  "utf8",
);
const meshPartLayerSource = readFileSync(
  join(process.cwd(), "src/modules/viewport-3d/layers/MeshPartLayer.tsx"),
  "utf8",
);
const boundsLayerSource = readFileSync(
  join(process.cwd(), "src/modules/viewport-3d/layers/BoundsLayers.tsx"),
  "utf8",
);

function colorBuffer(value: number): ScalarColorBuffer {
  return {
    colors: new Float32Array([value, value, value]),
    range: { max: value, min: value },
  };
}

function fieldVectorFixture(
  quantityId: string,
  pointCount = 75_000,
): DecodedFieldVector {
  return {
    dtype: "float64",
    grid: [pointCount, 1, 1],
    nComp: 3,
    pointCount,
    quantityId,
    valueCount: pointCount * 3,
    values: new Float64Array(pointCount * 3),
  };
}

describe("useViewport3DChunkedScalarColors", () => {
  it("publishes completed color modes progressively instead of waiting for every mode", () => {
    const source = readFileSync(sourceUrl, "utf8");

    expect(source).toContain("await Promise.allSettled(");
    expect(source).toContain("publishEntries(true)");
    expect(source).toContain("publishEntries(false)");
    expect(source).not.toContain("await Promise.all(");
  });

  it("creates semantic field-color build references without camera-only revisions", () => {
    const base = {
      colorRangeRevision: "auto:min=-1:max=1",
      colorMode: "orientation",
      colorPalette: "viridis",
      domainId: "shared-domain",
      fieldRevision: "field-7",
      quantityId: "m",
      samplingRevision: "full-domain:chunked",
      sessionId: "current",
      targetId: "surface/full",
      targetScopeId: "full",
      targetScopeKind: "full",
      targetVisualizationRevision: "targets-3",
      topologyRevision: "mesh-4",
    };

    const first = createViewport3DFieldColorBuildReference({
      ...base,
      cameraRevision: "camera-1",
    });
    const second = createViewport3DFieldColorBuildReference({
      ...base,
      cameraRevision: "camera-2",
    });
    const fieldChanged = createViewport3DFieldColorBuildReference({
      ...base,
      fieldRevision: "field-8",
    });
    const topologyChanged = createViewport3DFieldColorBuildReference({
      ...base,
      topologyRevision: "mesh-5",
    });
    const paletteChanged = createViewport3DFieldColorBuildReference({
      ...base,
      colorPalette: "magma",
    });
    const rangeChanged = createViewport3DFieldColorBuildReference({
      ...base,
      colorRangeRevision: "manual:min=0:max=1",
    });
    const targetChanged = createViewport3DFieldColorBuildReference({
      ...base,
      targetId: "surface/part-a",
      targetScopeId: "part-a",
      targetScopeKind: "part",
    });
    const targetVisualizationChanged = createViewport3DFieldColorBuildReference({
      ...base,
      targetVisualizationRevision: "targets-4",
    });
    const samplingChanged = createViewport3DFieldColorBuildReference({
      ...base,
      samplingRevision: "full-domain:chunked:v2",
    });

    expect(first).not.toBeNull();
    expect(first!.buildKey).toBe(second!.buildKey);
    expect(first!.buildKey).not.toContain("camera");
    expect(first!.buildKey).not.toBe(fieldChanged!.buildKey);
    expect(first!.buildKey).not.toBe(topologyChanged!.buildKey);
    expect(first!.buildKey).not.toBe(paletteChanged!.buildKey);
    expect(first!.buildKey).not.toBe(rangeChanged!.buildKey);
    expect(first!.buildKey).not.toBe(targetChanged!.buildKey);
    expect(first!.buildKey).toBe(targetVisualizationChanged!.buildKey);
    expect(first!.buildKey).not.toBe(samplingChanged!.buildKey);
    expect(first).toEqual({
      buildKey:
        'field-color:{"algorithmVersion":1,"component":"orientation","domainId":"shared-domain","fieldRevision":"field-7","lane":"field-color","quantityId":"m","samplingRevision":"full-domain:chunked","scopeId":"full","scopeKind":"full","sessionId":"current","styleRevision":"palette=viridis|range=auto:min=-1:max=1|target=surface/full","targetVisualizationRevision":"field-color-data","topologyRevision":"mesh-4"}',
      groupKey:
        "field-color:session=current:domain=shared-domain:quantity=m:mode=orientation:scope=full:full:target=surface/full",
      revisionSummary:
        "topology=mesh-4 field=field-7 quantity=m mode=orientation palette=viridis range=auto:min=-1:max=1 target=surface/full sampling=full-domain:chunked",
      targetRevision: "topology=mesh-4 field=field-7",
      topologyRevision: "mesh-4",
    });
  });

  it("groups latest-wins field-color jobs by color mode", () => {
    const base = {
      colorRangeRevision: "auto:min=-1:max=1",
      colorPalette: "viridis",
      domainId: "shared-domain",
      fieldRevision: "field-7",
      quantityId: "m",
      samplingRevision: "full-domain:chunked",
      sessionId: "current",
      targetId: "surface/full",
      targetScopeId: "full",
      targetScopeKind: "full",
      targetVisualizationRevision: "targets-3",
      topologyRevision: "mesh-4",
    };

    const orientation = createViewport3DFieldColorBuildReference({
      ...base,
      colorMode: "orientation",
    });
    const orientationNewField = createViewport3DFieldColorBuildReference({
      ...base,
      colorMode: "orientation",
      fieldRevision: "field-8",
    });
    const x = createViewport3DFieldColorBuildReference({
      ...base,
      colorMode: "x",
    });

    expect(orientation?.groupKey).toBe(orientationNewField?.groupKey);
    expect(orientation?.groupKey).not.toBe(x?.groupKey);
    expect(orientation?.groupKey).toContain("mode=orientation");
    expect(x?.groupKey).toContain("mode=x");
  });

  it("merges chunked scalar buffers over the synchronous field render model", () => {
    const sync = colorBuffer(1);
    const asyncOrientation = colorBuffer(2);
    const base: Viewport3DFieldRenderModel = {
      complexFieldVector: null,
      derivedWorkItems: [],
      fullVectorBuild: null,
      fullVectorSegments: null,
      partVectorBuilds: new Map(),
      partVectorSegments: new Map(),
      scalarColors: sync,
      scalarColorsByPartAndMode: new Map(),
      scalarColorsByMode: new Map([["orientation", sync]]),
      targetDiagnostics: [],
      targetPasses: new Map(),
      visualizationPhaseRad: null,
    };

    const result = mergeViewport3DFieldScalarColors(
      base,
      new Map([["orientation", asyncOrientation]]),
      "orientation",
    );

    expect(result?.scalarColors).toBe(asyncOrientation);
    expect(result?.scalarColorsByMode.get("orientation")).toBe(asyncOrientation);
  });

  it("merges chunked per-part scalar buffers over the synchronous field render model", () => {
    const sync = colorBuffer(1);
    const asyncPartY = colorBuffer(3);
    const base: Viewport3DFieldRenderModel = {
      complexFieldVector: null,
      derivedWorkItems: [],
      fullVectorBuild: null,
      fullVectorSegments: null,
      partVectorBuilds: new Map(),
      partVectorSegments: new Map(),
      scalarColors: sync,
      scalarColorsByPartAndMode: new Map([
        ["part-a", new Map([["y", null]])],
      ]),
      scalarColorsByMode: new Map([["orientation", sync]]),
      targetDiagnostics: [],
      targetPasses: new Map([
        [
          "part-a",
          {
            fieldBuffer: null,
            fieldBufferState: "target-buffer",
            surface: {
              passId: "test:surface",
              degradation: "surface-colors-unavailable",
              scalarColorMode: "y",
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
    };

    const result = mergeViewport3DFieldScalarColors(
      base,
      new Map(),
      "orientation",
      new Map([["part-a", new Map([["y", asyncPartY]])]]),
    );

    expect(result?.scalarColorsByPartAndMode.get("part-a")?.get("y")).toBe(
      asyncPartY,
    );
    expect(result?.scalarColorsByMode.get("orientation")).toBe(sync);
    expect(result?.targetPasses.get("part-a")?.surface).toMatchObject({
      degradation: null,
      scalarColors: asyncPartY,
    });
    expect(result?.targetDiagnostics).toEqual([
      {
        buffers: ["state=target-buffer"],
        degradation: [],
        demand: "surface:y",
        derivedWork: [],
        passes: ["surface"],
        requests: [],
        retained: [],
        targetId: "part-a",
      },
    ]);
  });

  it("prefers capability-tagged target buffers over legacy part field vectors", () => {
    const legacyFieldVector = fieldVectorFixture("m");
    const targetFieldVector = fieldVectorFixture("H_eff");
    const targetBuffer = buildViewport3DTargetFieldBuffer({
      fieldVector: targetFieldVector,
      query: {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      },
      targetIds: ["part-a"],
    });

    const input = resolveViewport3DChunkedPartFieldInput({
      fieldVector: null,
      partFieldVectors: new Map([["part-a", legacyFieldVector]]),
      partId: "part-a",
      partTargetFieldBuffers: new Map([["part-a", targetBuffer]]),
    });

    expect(input.explicitPartFieldBuffer).toBe(targetBuffer);
    expect(input.explicitPartFieldVector).toBe(targetFieldVector);
    expect(input.partFieldVector).toBe(targetFieldVector);
  });

  it("keeps chunked buffers out of React state and clears them on cleanup", () => {
    const source = readFileSync(sourceUrl, "utf8");

    expect(source).toContain("const chunkedScalarColorBuffers = new WeakMap");
    expect(source).toContain("const chunkedScalarColorBuffersByPartAndMode = new WeakMap");
    expect(source).toContain("useReducer");
    expect(source).toContain("chunkedScalarColorReducer");
    expect(source).toContain("releaseChunkedScalarColorToken");
    expect(source).not.toContain("useState");
    expect(source).not.toContain("buffers: Map<string, ScalarColorBuffer>");
  });

  it("keeps the previous chunked buffers visible during compatible field replacement", () => {
    const topology = { nodeCount: 75_000 };
    const fieldVector = {};
    const current = {
      buildKey: "field=7|range=old",
      colorPalette: "viridis",
      fieldVector,
      modesKey: "orientation",
      targetKind: "full-domain" as const,
      token: {},
      topology,
    };

    expect(
      chunkedScalarColorStateIsCompatible(current, {
        colorPalette: "viridis",
        enabled: true,
        fieldPointCount: 75_000,
        modesKey: "orientation",
        needsChunking: true,
        targetKind: "full-domain",
        topology,
      }),
    ).toBe(true);
  });

  it("drops previous chunked buffers when topology or target compatibility changes", () => {
    const topology = { nodeCount: 75_000 };
    const fieldVector = {};
    const current = {
      buildKey: "field=7|range=old",
      colorPalette: "viridis",
      fieldVector,
      modesKey: "orientation",
      targetKind: "full-domain" as const,
      token: {},
      topology,
    };

    expect(
      chunkedScalarColorStateIsCompatible(current, {
        colorPalette: "viridis",
        enabled: true,
        fieldPointCount: 75_000,
        modesKey: "orientation",
        needsChunking: true,
        targetKind: "full-domain",
        topology: { nodeCount: 75_000 },
      }),
    ).toBe(false);
    expect(
      chunkedScalarColorStateIsCompatible(current, {
        colorPalette: "viridis",
        enabled: true,
        fieldPointCount: 10_000,
        modesKey: "orientation",
        needsChunking: false,
        targetKind: "full-domain",
        topology,
      }),
    ).toBe(false);
  });

  it("keeps previous chunked buffers visible when only requested color modes change", () => {
    const topology = { nodeCount: 75_000 };
    const fieldVector = {};
    const current = {
      buildKey: "orientation",
      colorPalette: "viridis",
      fieldVector,
      modesKey: "part-a:orientation:viridis|part-b:y:viridis",
      targetKind: "full-domain" as const,
      token: {},
      topology,
    };

    expect(
      chunkedScalarColorStateIsCompatible(current, {
        colorPalette: "viridis",
        enabled: true,
        fieldPointCount: 75_000,
        modesKey: "part-a:x:viridis|part-b:y:viridis",
        needsChunking: true,
        targetKind: "full-domain",
        topology,
      }),
    ).toBe(true);
    expect(
      shouldStartChunkedScalarColorBuild({
        builtBuildKey: current.buildKey,
        builtFieldVector: current.fieldVector,
        currentBuildKey: "part-a:x:viridis|part-b:y:viridis",
        currentFieldVector: current.fieldVector,
        eligibleForChunkedBuild: true,
        pending: false,
      }),
    ).toBe(true);
  });

  it("keeps stale chunked buffers display-compatible while a new field build is needed", () => {
    const topology = { nodeCount: 75_000 };
    const fieldVector = {};
    const current = {
      buildKey: "field=7|range=old",
      colorPalette: "viridis",
      fieldVector,
      modesKey: "part-a:y:viridis",
      targetKind: "full-domain" as const,
      token: {},
      topology,
    };

    expect(
      chunkedScalarColorStateIsCompatible(current, {
        colorPalette: "viridis",
        enabled: true,
        fieldPointCount: 75_000,
        modesKey: "part-a:y:viridis",
        needsChunking: true,
        targetKind: "full-domain",
        topology,
      }),
    ).toBe(true);
    expect(
      shouldStartChunkedScalarColorBuild({
        builtBuildKey: current.buildKey,
        builtFieldVector: current.fieldVector,
        currentBuildKey: "field=8|range=new",
        currentFieldVector: current.fieldVector,
        eligibleForChunkedBuild: true,
        pending: false,
      }),
    ).toBe(true);
  });

  it("keeps stale chunked buffers visible while refreshed field data is temporarily unavailable", () => {
    const topology = { nodeCount: 75_000 };
    const fieldVector = {};
    const current = {
      buildKey: "field=7|range=old",
      colorPalette: "viridis",
      fieldVector,
      modesKey: "part-a:y:viridis",
      targetKind: "full-domain" as const,
      token: {},
      topology,
    };

    expect(
      chunkedScalarColorStateIsCompatible(current, {
        colorPalette: "viridis",
        enabled: true,
        fieldPointCount: null,
        modesKey: "part-a:y:viridis",
        needsChunking: false,
        targetKind: null,
        topology,
      }),
    ).toBe(true);
  });

  it("keeps per-part display compatibility independent from transient field-vector availability", () => {
    const topology = {
      airboxParts: [],
      magneticParts: [
        {
          part: {
            id: "part-a",
          },
        },
      ],
    };

    expect(
      resolveViewport3DChunkedPartDisplayModesKey({
        colorPalette: "viridis",
        partScalarColorModes: new Map([["part-a", "y"]]),
        topology: topology as never,
      }),
    ).toBe("part-a:y:viridis");
    expect(
      resolveViewport3DChunkedPartDisplayModesKey({
        colorPalette: "plasma",
        partScalarColorModes: new Map([["part-a", "y"]]),
        partScalarColorPalettes: new Map([["part-a", "magma"]]),
        topology: topology as never,
      }),
    ).toBe("part-a:y:magma");
  });

  it("filters stale chunked entries to currently requested global and per-part modes", () => {
    const source = readFileSync(sourceUrl, "utf8");
    const orientation = colorBuffer(1);
    const x = colorBuffer(2);
    const y = colorBuffer(3);

    const filtered = filterViewport3DChunkedScalarColorEntries({
      colorModes: ["orientation", "y"],
      colors: new Map([
        ["orientation", orientation],
        ["x", x],
      ]),
      colorsByPartAndMode: new Map([
        [
          "part-a",
          new Map([
            ["orientation", orientation],
            ["x", x],
          ]),
        ],
        ["part-b", new Map([["y", y]])],
      ]),
      partScalarColorModes: new Map([
        ["part-a", "x"],
        ["part-b", "orientation"],
      ]),
    });

    expect(filtered.colors).toEqual(new Map([["orientation", orientation]]));
    expect(filtered.colorsByPartAndMode.get("part-a")).toEqual(
      new Map([["x", x]]),
    );
    expect(filtered.colorsByPartAndMode.has("part-b")).toBe(false);
    expect(source).toContain("const visibleEntries = useMemo");
    expect(source).toContain("colors: rawColors");
    expect(source).toContain("colorsByPartAndMode: rawColorsByPartAndMode");
  });

  it("builds part-specific chunked colors from the primary field when part range or palette differs", () => {
    const source = readFileSync(sourceUrl, "utf8");

    expect(source).toContain("resolveViewport3DTargetFieldInput");
    expect(source).toContain("shouldBuildViewport3DPartChunkedScalarColor");
    expect(source).toContain(
      "resolveViewport3DChunkedFieldColorTarget(topology, partFieldVector)",
    );
  });

  it("does not skip a part-specific chunked color unless the global build covers the same mode", () => {
    const fieldVector = { pointCount: 75_000 } as never;
    const range = { max: 1, min: -1 };

    expect(
      shouldBuildViewport3DPartChunkedScalarColor({
        explicitPartFieldVector: false,
        globalColorModes: ["orientation"],
        globalColorPalette: "viridis",
        globalFieldVector: fieldVector,
        globalScalarRange: range,
        mode: "y",
        palette: "viridis",
        partFieldVector: fieldVector,
        scalarRange: range,
      }),
    ).toBe(true);
    expect(
      shouldBuildViewport3DPartChunkedScalarColor({
        explicitPartFieldVector: false,
        globalColorModes: ["orientation", "y"],
        globalColorPalette: "viridis",
        globalFieldVector: fieldVector,
        globalScalarRange: range,
        mode: "y",
        palette: "viridis",
        partFieldVector: fieldVector,
        scalarRange: range,
      }),
    ).toBe(false);
    expect(
      shouldBuildViewport3DPartChunkedScalarColor({
        explicitPartFieldVector: true,
        globalColorModes: ["y"],
        globalColorPalette: "viridis",
        globalFieldVector: fieldVector,
        globalScalarRange: range,
        mode: "y",
        palette: "viridis",
        partFieldVector: fieldVector,
        scalarRange: range,
      }),
    ).toBe(true);
  });

  it("allows part-only chunked builds without requiring a primary field vector", () => {
    const source = readFileSync(sourceUrl, "utf8");

    expect(source).toContain(
      "const buildIdentityFieldVector =\n    fieldVector ?? partBuildSpecs[0]?.fieldVector ?? null;",
    );
    expect(source).toContain("currentFieldVector: buildIdentityFieldVector");
    expect(source).toContain("!buildIdentityFieldVector");
    expect(source).not.toContain("!fieldVector ||\n      !buildTargetKind");
  });

  it("routes magnetic-only field colors through mapped worker targets", () => {
    const target = resolveViewport3DChunkedFieldColorTarget(
      {
        magneticParts: [
          {
            part: {
              id: "cofeb",
              nodeCount: 2,
              nodeStart: 1,
            },
          },
          {
            part: {
              id: "ring",
              node_indices: [4],
            },
          },
        ],
        nodeCount: 5,
      } as never,
      {
        pointCount: 3,
      } as never,
    );

    expect(target).toEqual({
      kind: "mapped-vertices",
      targetNodeIndices: new Uint32Array([1, 2, 4]),
      vertexCount: 5,
    });
  });

  it("does not start overlapping chunked color builds while a previous build is pending", () => {
    const currentFieldVector = {};
    expect(
      shouldStartChunkedScalarColorBuild({
        builtFieldVector: null,
        currentFieldVector,
        eligibleForChunkedBuild: true,
        pending: false,
      }),
    ).toBe(true);
    expect(
      shouldStartChunkedScalarColorBuild({
        builtFieldVector: null,
        currentFieldVector,
        eligibleForChunkedBuild: true,
        pending: true,
      }),
    ).toBe(false);
    expect(
      shouldStartChunkedScalarColorBuild({
        builtFieldVector: currentFieldVector,
        currentFieldVector,
        eligibleForChunkedBuild: true,
        pending: false,
      }),
    ).toBe(false);
  });

  it("routes surface vertex color adoption through the shared GPU upload manager hook", () => {
    for (const source of [
      fallbackLayerSource,
      meshPartLayerSource,
      boundsLayerSource,
    ]) {
      expect(source).toContain("useViewport3DScalarColorUpload");
      expect(source).not.toContain("applyVertexScalarColorBuffer(");
    }
  });

  it("passes field-color build metadata into scalar color upload tickets", () => {
    expect(fallbackLayerSource).toContain(
      "targetRevision: effectiveScalarColors?.targetRevision ?? null",
    );
    expect(fallbackLayerSource).toContain("uploadKey:");
    expect(fallbackLayerSource).toContain("effectiveScalarColors?.buildKey ??");
    expect(meshPartLayerSource).toContain(
      "targetRevision: effectiveScalarColors?.targetRevision ?? null",
    );
    expect(meshPartLayerSource).toContain("uploadKey:");
    expect(meshPartLayerSource).toContain("effectiveScalarColors?.buildKey ??");
    expect(boundsLayerSource).toContain(
      "targetRevision: surfaceColorState.scalarColors?.targetRevision ?? null",
    );
    expect(boundsLayerSource).toContain("uploadKey:");
    expect(boundsLayerSource).toContain(
      "surfaceColorState.scalarColors?.buildKey ??",
    );
  });

  it("passes semantic field-color build references into off-main-thread transforms", () => {
    const source = readFileSync(sourceUrl, "utf8");

    expect(source).toContain("const fieldColorBuildReference =");
    expect(source).toContain("createViewport3DFieldColorBuildReference({");
    expect(source).toContain(
      "buildKey: fieldColorBuildReference?.buildKey",
    );
    expect(source).toContain(
      "groupKey: fieldColorBuildReference?.groupKey",
    );
    expect(source).toContain("latestWins: Boolean(fieldColorBuildReference)");
    expect(source).toContain(
      "revisionSummary: fieldColorBuildReference?.revisionSummary",
    );
  });

  it("attaches field-color build metadata without copying color arrays", () => {
    const colors = colorBuffer(3);
    const reference = createViewport3DFieldColorBuildReference({
      colorMode: "magnitude",
      colorPalette: "viridis",
      domainId: "shared-domain",
      fieldRevision: "field-9",
      quantityId: "m",
      sessionId: "current",
      targetVisualizationRevision: "targets-2",
      topologyRevision: "mesh-4",
    });

    const tagged = attachViewport3DFieldColorBuildReference(
      colors,
      reference,
    );

    expect(tagged?.colors).toBe(colors.colors);
    expect(tagged).toMatchObject({
      buildKey: reference?.buildKey,
      targetRevision: "topology=mesh-4 field=field-9",
      topologyRevision: "mesh-4",
    });
  });

  it("passes backend field stats into field-color builds by color mode when available", () => {
    const source = readFileSync(sourceUrl, "utf8");
    const sceneModelSource = readFileSync(
      join(process.cwd(), "src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts"),
      "utf8",
    );

    expect(source).toContain("fieldScalarRangesByMode");
    expect(source).toContain(
      "partScalarRangesByMode?.get(partId)?.get(mode)",
    );
    expect(source).toContain("partFieldVector === fieldVector");
    expect(sceneModelSource).toContain("useFieldMetaResource");
    expect(sceneModelSource).toContain("primaryMagnitudeFieldMeta");
    expect(sceneModelSource).toContain("resolveScalarRange(fieldVector, scalarColorMode)");
    expect(sceneModelSource).toContain("fieldScalarRangesByMode");
  });
});
