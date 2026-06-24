import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";
import { memoryBudgetRegistry } from "@/kernel/performance/MemoryBudgetRegistry";
import type { FdmGridRenderDomain } from "../viewport3dDomainAdapter";
import {
  FDM_CUBOID_UPLOAD_BATCH_SIZE,
  buildFdmCuboidInstanceModel,
  buildFdmCuboidUploadBatches,
  buildFdmVectorSegments,
  resolveFdmVectorGlyphScale,
} from "./FdmCuboidLayer";

function domainFixture(
  overrides: Partial<FdmGridRenderDomain> = {},
): FdmGridRenderDomain {
  return {
    bounds: {
      center: [2e-9, 2e-9, 1.5e-9],
      radius: 3e-9,
      size: [4e-9, 4e-9, 3e-9],
    },
    displayCellBudget: 4,
    displayCellCount: 4,
    kind: "fdm-grid",
    origin: [0, 0, 0],
    shape: [4, 2, 1],
    spacing: [1e-9, 2e-9, 3e-9],
    stride: 2,
    totalCells: 8,
    ...overrides,
  };
}

function vectorField(values: number[]): DecodedFieldVector {
  return {
    dtype: "float64",
    grid: [values.length / 3, 1, 1],
    nComp: 3,
    pointCount: values.length / 3,
    quantityId: "m",
    valueCount: values.length,
    values: new Float64Array(values),
  };
}

const fdmCuboidLayerPath = join(
  process.cwd(),
  "src/modules/viewport-3d/layers/FdmCuboidLayer.tsx",
);
const fdmCuboidBuildModelPath = join(
  process.cwd(),
  "src/modules/viewport-3d/layers/fdmCuboidBuildModel.ts",
);
const viewport3DScenePath = join(
  process.cwd(),
  "src/modules/viewport-3d/layers/Viewport3DScene.tsx",
);
const viewport3DSceneModelPath = join(
  process.cwd(),
  "src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts",
);

describe("FdmCuboidLayer model", () => {
  it("samples FDM cells from grid shape, origin and spacing", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture());

    expect(model?.count).toBe(4);
    expect(model?.cellSize[0]).toBeCloseTo(0.92e-9);
    expect(model?.cellSize[1]).toBeCloseTo(1.84e-9);
    expect(model?.cellSize[2]).toBeCloseTo(2.76e-9);
    expect(Array.from(model?.cellIndices ?? [])).toEqual([0, 2, 4, 6]);
    expect(Array.from(model?.centers ?? [])).toEqual([
      expect.closeTo(0.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(2.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(0.5e-9),
      expect.closeTo(3e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(2.5e-9),
      expect.closeTo(3e-9),
      expect.closeTo(1.5e-9),
    ]);
  });

  it("uses the requested voxel fill ratio for visible cell gaps", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture(), {
      voxelFillRatio: 0.5,
    });

    expect(model?.cellSize[0]).toBeCloseTo(0.5e-9);
    expect(model?.cellSize[1]).toBeCloseTo(1e-9);
    expect(model?.cellSize[2]).toBeCloseTo(1.5e-9);
  });

  it("filters sampled cells by field magnitude threshold", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture(), {
      fieldVector: vectorField([
        0.1, 0, 0,
        1, 0, 0,
        0.6, 0, 0,
        1, 0, 0,
        0.2, 0, 0,
        1, 0, 0,
        0.8, 0, 0,
        1, 0, 0,
      ]),
      voxelMagnitudeThreshold: 0.5,
    });

    expect(model?.count).toBe(2);
    expect(Array.from(model?.cellIndices ?? [])).toEqual([2, 6]);
  });

  it("applies stylized topography displacement from the selected field component", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture(), {
      fieldVector: vectorField([
        0, 0, 0.5,
        0, 0, 0,
        0, 0, -0.25,
        0, 0, 0,
        0, 0, 0.75,
        0, 0, 0,
        0, 0, -0.5,
        0, 0, 0,
      ]),
      voxelTopography: {
        amplitudeCells: 2,
        component: "z",
        enabled: true,
      },
    });

    expect(Array.from(model?.centers ?? [])).toEqual([
      expect.closeTo(0.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(4.5e-9),
      expect.closeTo(2.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(0),
      expect.closeTo(0.5e-9),
      expect.closeTo(3e-9),
      expect.closeTo(6e-9),
      expect.closeTo(2.5e-9),
      expect.closeTo(3e-9),
      expect.closeTo(-1.5e-9),
    ]);
  });

  it("returns no model when the FDM display budget resolves to zero cells", () => {
    expect(
      buildFdmCuboidInstanceModel(
        domainFixture({ displayCellCount: 0, totalCells: 0 }),
      ),
    ).toBeNull();
  });

  it("preallocates sampled FDM cell indices in the instance-model hot path", () => {
    const buildModelSource = readFileSync(fdmCuboidBuildModelPath, "utf8");
    const instanceModelBlock = buildModelSource.slice(
      buildModelSource.indexOf("export function buildFdmCuboidInstanceModel"),
      buildModelSource.indexOf("export function buildFdmVectorSegmentsUncached"),
    );

    expect(instanceModelBlock).toContain("new Uint32Array(candidateCount)");
    expect(instanceModelBlock).not.toContain("sampledCellIndices.push");
    expect(instanceModelBlock).not.toContain("number[] = []");
  });

  it("builds vector glyph segments from sampled FDM cell indices", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture());
    const segments = buildFdmVectorSegments(
      model,
      vectorField([
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        0, 0, 1,
        0, 1, 0,
        0, 0, 1,
        -1, 0, 0,
        0, 0, 1,
      ]),
      2e-9,
      4,
    );

    expect(Array.from(segments ?? [])).toEqual([
      expect.closeTo(-0.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(1.5e-9),
      1,
      expect.closeTo(2.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(0.5e-9),
      expect.closeTo(2.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(2.5e-9),
      1,
      expect.closeTo(0.5e-9),
      expect.closeTo(2e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(0.5e-9),
      expect.closeTo(4e-9),
      expect.closeTo(1.5e-9),
      1,
      expect.closeTo(3.5e-9),
      expect.closeTo(3e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(3e-9),
      expect.closeTo(1.5e-9),
      1,
    ]);
  });

  it("bounds FDM vector segment cache entries when vector scale changes", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture());
    const fieldVector = vectorField([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
      0, 0, 1,
      0, 1, 0,
      0, 0, 1,
      -1, 0, 0,
      0, 0, 1,
    ]);
    const before =
      memoryBudgetRegistry.snapshot().find(
        (entry) => entry.id === "viewport3d.render.fdmVectorSegmentCache",
      )?.entryCount ?? 0;

    for (let index = 0; index < 20; index += 1) {
      buildFdmVectorSegments(model, fieldVector, (index + 1) * 1e-9, 4);
    }

    const after =
      memoryBudgetRegistry.snapshot().find(
        (entry) => entry.id === "viewport3d.render.fdmVectorSegmentCache",
      )?.entryCount ?? 0;

    expect(after - before).toBeLessThanOrEqual(8);
  });

  it("reuses the scene-level FDM instance model for surface color mapping and layer rendering", () => {
    const layerSource = readFileSync(fdmCuboidLayerPath, "utf8");
    const sceneSource = readFileSync(viewport3DScenePath, "utf8");
    const sceneModelSource = readFileSync(viewport3DSceneModelPath, "utf8");

    expect(sceneModelSource).toContain("const fdmInstanceModelEnabled = Boolean(");
    expect(sceneModelSource).toContain("useFdmCuboidBuildResult");
    expect(sceneModelSource).toContain("buildViewport3DFdmCuboidJobKey");
    expect(sceneModelSource).toContain("fdmInstanceModel?.cellIndices");
    expect(sceneModelSource).toContain(
      "modelFieldVector: fdmInstanceModelFieldVector",
    );
    expect(sceneModelSource).toContain("fdmInstanceModel: fdmInstanceModel");
    expect(sceneModelSource).toContain("fdmVectorSegments");
    expect(sceneModelSource).not.toContain("buildFdmCuboidInstanceModel(");
    expect(sceneModelSource).not.toContain("const fdmSurfaceInstanceModel");
    expect(sceneSource).toContain("fdmInstanceModel: FdmCuboidInstanceModel | null | undefined");
    expect(sceneSource).toContain("fdmVectorSegments: Float32Array | null");
    expect(sceneSource).toContain("instanceModel={fdmInstanceModel}");
    expect(sceneSource).toContain("vectorSegments={fdmVectorSegments}");
    expect(layerSource).toContain("instanceModel?: FdmCuboidInstanceModel | null");
    expect(layerSource).toContain("const model = instanceModel ?? null");
    expect(layerSource).not.toContain("instanceModel !== undefined");
  });

  it("uses unlit materials for FDM cell surfaces", () => {
    const layerSource = readFileSync(fdmCuboidLayerPath, "utf8");

    expect(layerSource).toContain("MeshBasicMaterial");
    expect(layerSource).not.toContain("MeshStandardMaterial");
  });

  it("keeps FDM matrix uploads independent from scalar color changes", () => {
    const layerSource = readFileSync(fdmCuboidLayerPath, "utf8");
    const matrixUploadBlock = layerSource.slice(
      layerSource.indexOf("interface FdmCuboidMatrixUploadOptions"),
      layerSource.indexOf("interface FdmCuboidColorUploadOptions"),
    );

    expect(matrixUploadBlock).not.toContain("usesInstanceColors");
  });

  it("does not recreate FDM materials for vector-only setting changes", () => {
    const layerSource = readFileSync(fdmCuboidLayerPath, "utf8");
    const surfaceMaterialBlock = layerSource.slice(
      layerSource.indexOf("const surfaceMaterial = useMemo"),
      layerSource.indexOf("const wireframePolicy = RENDER_POLICIES.featureEdges"),
    );
    const wireframeMaterialBlock = layerSource.slice(
      layerSource.indexOf("const wireframeMaterial = useMemo"),
      layerSource.indexOf("useEffect(() => () => tracker.release(\"geometry\", geometry)"),
    );

    expect(surfaceMaterialBlock).toContain("surfaceMaterialColor");
    expect(surfaceMaterialBlock).not.toContain("renderSettings,");
    expect(wireframeMaterialBlock).toContain("wireframeColor");
    expect(wireframeMaterialBlock).toContain("wireframeOpacity");
    expect(wireframeMaterialBlock).not.toContain("renderSettings,");
  });

  it("uses a native raycast path for FDM inspect hover sampling", () => {
    const layerSource = readFileSync(fdmCuboidLayerPath, "utf8");

    expect(layerSource).toContain('canvas.addEventListener("pointermove"');
    expect(layerSource).toContain("passive: true");
    expect(layerSource).toContain("requestAnimationFrame");
    expect(layerSource).toContain("cancelAnimationFrame(rafId)");
    expect(layerSource).toContain("cachedRect = canvas.getBoundingClientRect();");
    expect(layerSource).toContain("new ResizeObserver");
    expect(layerSource).toContain("raycaster.setFromCamera");
    expect(layerSource).toContain("intersectObjects(targets, false)");
    expect(layerSource).toContain("resolveProjectedFdmInspectHit");
    expect(layerSource).toContain("FDM_INSPECT_PROJECTION_FALLBACK_LIMIT");
    expect(layerSource).toContain("buildViewport3DFdmInspectSample");
  });

  it("prevents native FDM inspect from duplicating R3F hover samples in the same frame", () => {
    const layerSource = readFileSync(fdmCuboidLayerPath, "utf8");

    expect(layerSource).toContain("const r3fInspectHitFrameRef = useRef(0);");
    expect(layerSource).toContain("r3fInspectHitFrameRef.current = inspectFrameRef.current;");
    expect(layerSource).toContain(
      "if (r3fInspectHitFrameRef.current === eventFrame)",
    );
  });

  it("does not block farther overlay picking when the FDM surface handles domain selection", () => {
    const layerSource = readFileSync(fdmCuboidLayerPath, "utf8");

    expect(layerSource).toContain("if (eventIntersectsRegionOverlay(event)) return;");
    expect(layerSource).not.toContain("event.stopPropagation();\n    onSelectDomain();");
    expect(layerSource).toContain("onSelectDomain();");
  });

  it("reuses FDM vector segment buffers for the same model, field, and sampling options", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture());
    const field = vectorField([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
      0, 0, 1,
      0, 1, 0,
      0, 0, 1,
      -1, 0, 0,
      0, 0, 1,
    ]);

    const first = buildFdmVectorSegments(model, field, 2e-9, 4);
    const second = buildFdmVectorSegments(model, field, 2e-9, 4);
    const tailAnchored = buildFdmVectorSegments(model, field, 2e-9, 4, {
      anchorMode: "tail",
    });
    const differentBudget = buildFdmVectorSegments(model, field, 2e-9, 2);

    expect(first).toBe(second);
    expect(first).not.toBe(tailAnchored);
    expect(first).not.toBe(differentBudget);
  });

  it("can anchor FDM vector glyph segments by their tail", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture());
    const segments = buildFdmVectorSegments(
      model,
      vectorField([
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        0, 0, 1,
        0, 1, 0,
        0, 0, 1,
        -1, 0, 0,
        0, 0, 1,
      ]),
      2e-9,
      1,
      { anchorMode: "tail" },
    );

    expect(Array.from(segments ?? [])).toEqual([
      expect.closeTo(0.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(2.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(1.5e-9),
      1,
    ]);
  });

  it("splits large FDM instanced uploads into bounded batches", () => {
    expect(buildFdmCuboidUploadBatches(0)).toEqual([]);
    expect(buildFdmCuboidUploadBatches(5, 2)).toEqual([
      { end: 2, start: 0 },
      { end: 4, start: 2 },
      { end: 5, start: 4 },
    ]);
    expect(FDM_CUBOID_UPLOAD_BATCH_SIZE).toBeLessThanOrEqual(4096);
  });

  it("caps rendered FDM vector glyph scale to the local voxel size", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture(), {
      voxelFillRatio: 0.5,
    });

    expect(resolveFdmVectorGlyphScale(model, 100e-9)).toBeCloseTo(1.125e-9);
    expect(resolveFdmVectorGlyphScale(model, 0.25e-9)).toBeCloseTo(0.25e-9);
  });
});
