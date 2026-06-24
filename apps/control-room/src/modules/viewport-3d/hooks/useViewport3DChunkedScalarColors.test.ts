import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import type { Viewport3DFieldRenderModel } from "../viewport3dRenderModel";
import {
  attachViewport3DFieldColorBuildReference,
  chunkedScalarColorStateIsCompatible,
  createViewport3DFieldColorBuildReference,
  mergeViewport3DFieldScalarColors,
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

describe("useViewport3DChunkedScalarColors", () => {
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
    expect(first!.buildKey).not.toBe(samplingChanged!.buildKey);
    expect(first).toEqual({
      buildKey:
        'field-color:{"algorithmVersion":1,"component":"orientation","domainId":"shared-domain","fieldRevision":"field-7","lane":"field-color","quantityId":"m","samplingRevision":"full-domain:chunked","scopeId":"full","scopeKind":"full","sessionId":"current","styleRevision":"palette=viridis|range=auto:min=-1:max=1|target=surface/full","targetVisualizationRevision":"targets-3","topologyRevision":"mesh-4"}',
      groupKey:
        "field-color:session=current:domain=shared-domain:quantity=m:scope=full:full:target=surface/full",
      revisionSummary:
        "topology=mesh-4 field=field-7 quantity=m mode=orientation palette=viridis range=auto:min=-1:max=1 target=surface/full sampling=full-domain:chunked",
      targetRevision: "field=field-7",
      topologyRevision: "mesh-4",
    });
  });

  it("merges chunked scalar buffers over the synchronous field render model", () => {
    const sync = colorBuffer(1);
    const asyncOrientation = colorBuffer(2);
    const base: Viewport3DFieldRenderModel = {
      complexFieldVector: null,
      fullVectorBuild: null,
      fullVectorSegments: null,
      partVectorBuilds: new Map(),
      partVectorSegments: new Map(),
      scalarColors: sync,
      scalarColorsByPartAndMode: new Map(),
      scalarColorsByMode: new Map([["orientation", sync]]),
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

  it("keeps chunked buffers out of React state and clears them on cleanup", () => {
    const source = readFileSync(sourceUrl, "utf8");

    expect(source).toContain("const chunkedScalarColorBuffers = new WeakMap");
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
      colorPalette: "viridis",
      fieldVector,
      modesKey: "orientation",
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
        topology,
      }),
    ).toBe(true);
  });

  it("drops previous chunked buffers when topology or mode compatibility changes", () => {
    const topology = { nodeCount: 75_000 };
    const fieldVector = {};
    const current = {
      colorPalette: "viridis",
      fieldVector,
      modesKey: "orientation",
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
        topology: { nodeCount: 75_000 },
      }),
    ).toBe(false);
    expect(
      chunkedScalarColorStateIsCompatible(current, {
        colorPalette: "viridis",
        enabled: true,
        fieldPointCount: 75_000,
        modesKey: "magnitude",
        needsChunking: true,
        topology,
      }),
    ).toBe(false);
    expect(
      chunkedScalarColorStateIsCompatible(current, {
        colorPalette: "viridis",
        enabled: true,
        fieldPointCount: 10_000,
        modesKey: "orientation",
        needsChunking: false,
        topology,
      }),
    ).toBe(false);
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
      targetRevision: "field=field-9",
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
      "scalarRange: fieldScalarRangesByMode?.get(mode)",
    );
    expect(sceneModelSource).toContain("useFieldMetaResource");
    expect(sceneModelSource).toContain("primaryMagnitudeFieldMeta");
    expect(sceneModelSource).toContain("fieldScalarRangesByMode");
  });
});
