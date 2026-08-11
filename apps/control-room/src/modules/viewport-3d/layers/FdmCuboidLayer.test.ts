import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";
import { memoryBudgetRegistry } from "@/kernel/performance/MemoryBudgetRegistry";
import type { FdmGridRenderDomain } from "../viewport3dDomainAdapter";
import {
  FDM_CUBOID_UPLOAD_BATCH_SIZE,
  buildFdmPointPositions,
  buildFdmCuboidInstanceModel as buildFdmCuboidInstanceModelWithMembership,
  buildFdmCuboidUploadBatches,
  buildFdmCuboidColorUploadBatchesForView,
  fdmCuboidUsesInstanceColors,
  buildFdmVectorSegments,
  fdmCuboidSurfaceMeshKey,
  hasAnyEffectiveFdmPass,
  handleFdmCuboidContextLost,
  resolveFdmCuboidPassPlan,
  resolveFdmVectorGlyphScale,
  recordFdmCuboidSurfaceAdoption,
  resolveFdmCuboidGeometryScopeInstanceOrdinals,
  resolveFdmCuboidSourceInstanceOrdinal,
  resolveFdmCuboidPreparedSourceOrdinal,
  prepareFdmCuboidInstanceMatrices,
  estimateFdmCuboidCarrierPeakBytes,
  uploadFdmCuboidAttribute,
  visibleFdmCuboidInspectTargets,
  resolveFdmCuboidColorUploadRevision,
  shouldAttachFdmCuboidInspectListener,
} from "./FdmCuboidLayer";
import { BoxGeometry, InstancedBufferAttribute, InstancedMesh, MeshBasicMaterial } from "three";
import type { FdmCuboidInstanceModelOptions } from "./fdmCuboidBuildModel";
import { createViewport3DRenderAdoptionRegistry } from "../model/viewport3DRenderAdoptionRegistry";

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

function buildFdmCuboidInstanceModel(
  domain: FdmGridRenderDomain | null,
  options: Partial<FdmCuboidInstanceModelOptions> = {},
) {
  const {
    cellSelection = "active",
    realizedRegionIds = domain ? new Uint32Array(domain.totalCells) : null,
    ...rest
  } = options;
  return buildFdmCuboidInstanceModelWithMembership(domain, {
    ...rest,
    cellSelection,
    realizedRegionIds,
  });
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
  it("prepares Three column-major matrices atomically for a target view", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture());
    const prepared = prepareFdmCuboidInstanceMatrices(
      model!,
      Uint32Array.from([3, 1]),
      "topology:7:target:bottom",
    );

    expect(prepared.contentRevision).toMatch(
      /^topology:7:target:bottom:matrix:64:[0-9a-f]+:2:[0-9a-f]+$/,
    );
    expect(prepared.count).toBe(2);
    expect(Array.from(prepared.ordinals)).toEqual([3, 1]);
    expect(Array.from(prepared.cellIndices)).toEqual([
      model!.cellIndices[3],
      model!.cellIndices[1],
    ]);
    expect(Array.from(prepared.matrices.slice(12, 16))).toEqual([
      model!.centers[9],
      model!.centers[10],
      model!.centers[11],
      1,
    ]);
    expect(prepared.matrices).toHaveLength(2 * 16);
  });

  it("changes prepared content revision when transforms change with identical membership", () => {
    const original = buildFdmCuboidInstanceModel(domainFixture());
    const translated = buildFdmCuboidInstanceModel(
      domainFixture({ origin: [10, 0, 0] }),
    );
    const ordinals = Uint32Array.from([3, 1]);

    const before = prepareFdmCuboidInstanceMatrices(original!, ordinals, "target");
    const after = prepareFdmCuboidInstanceMatrices(translated!, ordinals, "target");

    expect(after.cellIndices).toEqual(before.cellIndices);
    expect(after.contentRevision).not.toBe(before.contentRevision);
    expect(after.matrices).not.toEqual(before.matrices);
  });

  it("maps reordered picks through the atomic prepared ordinals", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture());
    const prepared = prepareFdmCuboidInstanceMatrices(
      model!,
      Uint32Array.from([3, 1]),
      "target",
    );

    expect(resolveFdmCuboidPreparedSourceOrdinal(prepared, 0)).toBe(3);
    expect(resolveFdmCuboidPreparedSourceOrdinal(prepared, 1)).toBe(1);
    expect(resolveFdmCuboidPreparedSourceOrdinal(prepared, 2)).toBeNull();
  });

  it("keeps color upload revision stable across matrix-only changes", () => {
    const original = buildFdmCuboidInstanceModel(domainFixture());
    const translated = buildFdmCuboidInstanceModel(
      domainFixture({ origin: [10, 0, 0] }),
    );
    const ordinals = Uint32Array.from([3, 1]);
    const before = prepareFdmCuboidInstanceMatrices(original!, ordinals, "target");
    const after = prepareFdmCuboidInstanceMatrices(translated!, ordinals, "target");
    const scalar = {
      buildKey: "scalar:r1|range:1|palette:viridis",
      colors: new Float32Array(6),
      range: { max: 1, min: -1 },
    };

    expect(before.contentRevision).not.toBe(after.contentRevision);
    expect(resolveFdmCuboidColorUploadRevision(before, scalar)).toBe(
      resolveFdmCuboidColorUploadRevision(after, scalar),
    );
    expect(
      resolveFdmCuboidColorUploadRevision(after, {
        ...scalar,
        buildKey: "scalar:r2|range:2|palette:viridis",
      }),
    ).not.toBe(resolveFdmCuboidColorUploadRevision(after, scalar));
  });

  it("reduces active raw inspect listeners from two to one to zero on hide", () => {
    const active = (visible: readonly boolean[]) =>
      visible.filter((targetVisible) =>
        shouldAttachFdmCuboidInspectListener({
          inspectEnabled: true,
          prepared: true,
          surfaceVisible: targetVisible,
          targetVisible,
          wireframeVisible: false,
        }),
      ).length;

    expect(active([true, true])).toBe(2);
    expect(active([true, false])).toBe(1);
    expect(active([false, false])).toBe(0);
  });

  it("bulk uploads exactly one owned attribute range per content revision", () => {
    const source = Float32Array.from({ length: 32 }, (_, index) => index + 1);
    const left = new InstancedBufferAttribute(new Float32Array(32), 16);
    const right = new InstancedBufferAttribute(new Float32Array(32), 16);

    expect(uploadFdmCuboidAttribute(left, source, "geometry:1", null)).toBe(
      "geometry:1",
    );
    expect(Array.from(left.array)).toEqual(Array.from(source));
    expect(left.version).toBe(1);
    expect(uploadFdmCuboidAttribute(left, source, "geometry:1", "geometry:1")).toBe(
      "geometry:1",
    );
    expect(left.version).toBe(1);
    expect(uploadFdmCuboidAttribute(right, source, "geometry:1", null)).toBe(
      "geometry:1",
    );
    expect(right.array).not.toBe(left.array);
    expect(right.version).toBe(1);
  });

  it("keeps the conservative 153600-cell carrier peak below 72 MiB", () => {
    const bytes = estimateFdmCuboidCarrierPeakBytes(153_600);
    expect(bytes).toBe(65_740_800);
    expect(bytes).toBeLessThanOrEqual(72 * 1024 * 1024);
  });

  it("prevents default context loss before invalidating uploaded revisions", () => {
    const event = new Event("webglcontextlost", { cancelable: true });
    let invalidated = false;

    handleFdmCuboidContextLost(event, () => {
      expect(event.defaultPrevented).toBe(true);
      invalidated = true;
    });

    expect(invalidated).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("excludes retained hidden carriers from raw inspect raycasts", () => {
    const geometry = new BoxGeometry();
    const material = new MeshBasicMaterial();
    const surface = new InstancedMesh(geometry, material, 1);
    const wireframe = new InstancedMesh(geometry, material, 1);
    surface.visible = false;
    wireframe.visible = true;

    expect(visibleFdmCuboidInspectTargets([surface, wireframe])).toEqual([
      wireframe,
    ]);
    surface.visible = true;
    wireframe.visible = false;
    expect(visibleFdmCuboidInspectTargets([surface, wireframe])).toEqual([
      surface,
    ]);

    surface.dispose();
    wireframe.dispose();
    geometry.dispose();
    material.dispose();
  });

  it("keeps both cuboid carriers mounted and detaches hidden pointer handlers", () => {
    const source = readFileSync(fdmCuboidLayerPath, "utf8");

    expect(source).toContain("visible={renderPlan.surface.visible}");
    expect(source).toContain("visible={renderPlan.wireframe.visible}");
    expect(source).toContain(
      "onPointerMove={renderPlan.surface.visible ? onPointerMove : undefined}",
    );
    expect(source).toContain(
      "onPointerMove={renderPlan.wireframe.visible ? onPointerMove : undefined}",
    );
    expect(source).not.toContain("mesh.setMatrixAt(");
    expect(source).not.toContain("mesh.setColorAt(");
    expect(source).toContain('canvas.addEventListener("webglcontextlost"');
    expect(source).toContain('canvas.addEventListener("webglcontextrestored"');
    expect(source).toContain('canvas.removeEventListener("webglcontextlost"');
    expect(source).toContain('canvas.removeEventListener("webglcontextrestored"');
    expect(source).toContain("event.preventDefault();");
    expect(source).toContain("visibleFdmCuboidInspectTargets([");
    expect(source).toContain("resolveFdmCuboidPreparedSourceOrdinal(");
    expect(source).toContain("resolveViewport3DScalarColorBufferKey(surfaceColors)");
  });
  it("maps rendered target instances back to the shared sampled model", () => {
    const instanceOrdinals = Uint32Array.from([3, 1]);

    expect(resolveFdmCuboidSourceInstanceOrdinal(0, instanceOrdinals, 4)).toBe(3);
    expect(resolveFdmCuboidSourceInstanceOrdinal(1, instanceOrdinals, 4)).toBe(1);
    expect(resolveFdmCuboidSourceInstanceOrdinal(2, instanceOrdinals, 4)).toBeNull();
    expect(resolveFdmCuboidSourceInstanceOrdinal(0, null, 4)).toBe(0);
  });

  it("uses target-local surface instances for every surface-scoped cell pass", () => {
    const targetInstances = Uint32Array.from([0, 1, 2, 3]);
    const targetSurfaceInstances = Uint32Array.from([0, 3]);

    expect(
      Array.from(
        resolveFdmCuboidGeometryScopeInstanceOrdinals(
          "surface",
          targetInstances,
          targetSurfaceInstances,
        ) ?? [],
      ),
    ).toEqual([0, 3]);
    expect(
      Array.from(
        resolveFdmCuboidGeometryScopeInstanceOrdinals(
          "full",
          targetInstances,
          targetSurfaceInstances,
        ) ?? [],
      ),
    ).toEqual([0, 1, 2, 3]);
  });

  it("builds points from a target view without copying the shared centers", () => {
    const source = buildFdmCuboidInstanceModel(domainFixture());

    expect(
      Array.from(
        buildFdmPointPositions(
          source,
          "full",
          Uint32Array.from([3, 1]),
        ) ?? [],
      ),
    ).toEqual([
      source?.centers[9],
      source?.centers[10],
      source?.centers[11],
      source?.centers[3],
      source?.centers[4],
      source?.centers[5],
    ]);
  });

  it("builds vector segments only for target-view instances", () => {
    const source = buildFdmCuboidInstanceModel(domainFixture());
    const field = vectorField([
      1, 0, 0,
      1, 0, 0,
      1, 0, 0,
      1, 0, 0,
      1, 0, 0,
      1, 0, 0,
      1, 0, 0,
      1, 0, 0,
    ]);

    const segments = buildFdmVectorSegments(source, field, 1, 8, {
      anchorMode: "tail",
      instanceOrdinals: Uint32Array.from([3, 1]),
    });

    expect(segments).toHaveLength(2 * 7);
    expect(Array.from(segments?.slice(0, 3) ?? [])).toEqual([
      source?.centers[9],
      source?.centers[10],
      source?.centers[11],
    ]);
  });

  it("keeps points and vectors for an internal target-local surface", () => {
    const source = buildFdmCuboidInstanceModel(
      domainFixture({
        displayCellBudget: 27,
        displayCellCount: 27,
        shape: [3, 3, 3],
        stride: 1,
        totalCells: 27,
      }),
    );
    const centerOnly = Uint32Array.from([13]);
    const field = vectorField(
      Array.from({ length: 27 }, () => [1, 0, 0]).flat(),
    );

    expect(buildFdmPointPositions(source, "surface", centerOnly)).toHaveLength(3);
    expect(
      buildFdmVectorSegments(source, field, 1, 8, {
        geometryScope: "surface",
        instanceOrdinals: centerOnly,
      }),
    ).toHaveLength(7);
  });

  it("keeps magnetic and Airbox FDM cuboids as independent membership-gated passes", () => {
    const sceneModelSource = readFileSync(viewport3DSceneModelPath, "utf8");
    const sceneSource = readFileSync(viewport3DScenePath, "utf8");

    expect(sceneModelSource).toContain("const fdmMembershipCurrent = Boolean(");
    expect(sceneModelSource).toContain(
      "fdmRealizedRegionIds instanceof Uint32Array",
    );
    expect(sceneModelSource).toContain('cellSelection: "active"');
    expect(sceneModelSource).toContain('cellSelection: "inactive"');
    expect(sceneModelSource).toContain("fdmAirboxInstanceModel");
    expect(sceneSource).toContain("fdmAirboxInstanceModel: FdmCuboidInstanceModel");
    expect(sceneSource).toContain("settings={fdmUniverseOutsideSupportSettings}");
  });

  it("keeps native multilayer and Airbox surface colors independent from shader visibility", () => {
    const source = readFileSync(viewport3DSceneModelPath, "utf8");
    const nativeBlock = source.slice(
      source.indexOf("const fdmNativeLayerViews"),
      source.indexOf("const fdmMultilayerAirboxView"),
    );
    const airboxBlock = source.slice(
      source.indexOf("const fdmMultilayerAirboxView"),
      source.indexOf("const fdmSurfaceColors"),
    );

    for (const block of [nativeBlock, airboxBlock]) {
      expect(block).toContain("memoizeViewport3DFdmSurfaceColors({");
      expect(block).toContain("buildKey: surfaceColorKey");
      expect(block).toContain("model?.membershipRevision");
      expect(block).not.toContain("model?.matrixContentRevision");
      const surfaceModeBlock = block.slice(
        block.indexOf("const surfaceMode"),
        block.indexOf("const surfaceColorKey"),
      );
      expect(surfaceModeBlock).not.toContain("shaderVisible");
    }
  });

  it("reconstructs the surface mesh when field colors become available", () => {
    expect(fdmCuboidSurfaceMeshKey(4096, false)).not.toBe(
      fdmCuboidSurfaceMeshKey(4096, true),
    );
    expect(fdmCuboidSurfaceMeshKey(4096, true)).toBe(
      "fdm-cuboids-surface-4096-field-colors",
    );
  });

  it("never lets stale field colors override an explicitly solid surface", () => {
    const surfaceColors = {
      buildKey: "field-colors",
      colors: new Float32Array(12),
      range: { max: 1, min: -1 },
    };

    expect(
      fdmCuboidUsesInstanceColors(
        { surfaceColorSource: "solid" },
        surfaceColors,
        4,
      ),
    ).toBe(false);
    expect(
      fdmCuboidUsesInstanceColors(
        { surfaceColorSource: "orientation" },
        surfaceColors,
        4,
      ),
    ).toBe(true);
  });

  it("clears the exact FDM surface receipt when colors disappear or the pass unmounts", () => {
    const source = readFileSync(fdmCuboidLayerPath, "utf8");

    expect(source).toContain("adoptionRegistry.clearAdoption(");
    expect(source).toContain("if (usesInstanceColors || !adoptionRegistry) return;");
    expect(source).toContain("unregister();");
  });
  it("records FDM surface colors as an adopted derived-global carrier", () => {
    const registry = createViewport3DRenderAdoptionRegistry();
    registry.setCarrierTargets(new Map([["fdm-domain", ["object:sample"]]]));
    registry.retainDemand("object:sample");

    recordFdmCuboidSurfaceAdoption({
      fieldBufferId: "field-global",
      registry,
      scalarBuffer: {
        buildKey: "scalar-global",
        colors: new Float32Array(12),
        range: { max: 1, min: -1 },
      },
    });

    expect(registry.snapshot("object:sample")[0]).toMatchObject({
      carrierId: "fdm-domain",
      fieldBufferId: "field-global",
      kind: "surface",
      scalarBufferKey: "scalar-global",
    });
  });

  it("records target-aware FDM surface adoption against the exact carrier", () => {
    const registry = createViewport3DRenderAdoptionRegistry();
    registry.setCarrierTargets(new Map([["region:left:core", ["region:left:core"]]]));
    registry.retainDemand("region:left:core");

    recordFdmCuboidSurfaceAdoption({
      carrierId: "region:left:core",
      fieldBufferId: "field-global",
      registry,
      scalarBuffer: {
        buildKey: "scalar-left-core",
        colors: new Float32Array(6),
        range: { max: 1, min: -1 },
      },
    });

    expect(registry.snapshot("region:left:core")[0]).toMatchObject({
      carrierId: "region:left:core",
      scalarBufferKey: "scalar-left-core",
    });
  });
  it("keeps every independently enabled FDM pass renderable", () => {
    expect(
      hasAnyEffectiveFdmPass({
        boundsVisible: false,
        pointsVisible: false,
        shaderVisible: true,
        vectorsVisible: false,
        wireframeVisible: false,
      }),
    ).toBe(true);
    expect(
      hasAnyEffectiveFdmPass({
        boundsVisible: false,
        pointsVisible: false,
        shaderVisible: false,
        vectorsVisible: false,
        wireframeVisible: true,
      }),
    ).toBe(true);
    expect(
      hasAnyEffectiveFdmPass({
        boundsVisible: false,
        pointsVisible: true,
        shaderVisible: false,
        vectorsVisible: false,
        wireframeVisible: false,
      }),
    ).toBe(true);
    expect(
      hasAnyEffectiveFdmPass({
        boundsVisible: false,
        pointsVisible: false,
        shaderVisible: false,
        vectorsVisible: true,
        wireframeVisible: false,
      }),
    ).toBe(true);
    expect(
      hasAnyEffectiveFdmPass({
        boundsVisible: true,
        pointsVisible: false,
        shaderVisible: false,
        vectorsVisible: false,
        wireframeVisible: false,
      }),
    ).toBe(true);
    expect(
      hasAnyEffectiveFdmPass({
        boundsVisible: false,
        pointsVisible: false,
        shaderVisible: false,
        vectorsVisible: false,
        wireframeVisible: false,
      }),
    ).toBe(false);
  });

  it("does not request cuboid surface instances for points-only or vectors-only passes", () => {
    const pointsOnly = resolveFdmCuboidPassPlan({
      boundsVisible: false,
      pointsVisible: true,
      shaderVisible: false,
      vectorsVisible: false,
      wireframeVisible: false,
    });
    const vectorsOnly = resolveFdmCuboidPassPlan({
      boundsVisible: false,
      pointsVisible: false,
      shaderVisible: false,
      vectorsVisible: true,
      wireframeVisible: false,
    });
    const allOff = resolveFdmCuboidPassPlan({
      boundsVisible: false,
      pointsVisible: false,
      shaderVisible: false,
      vectorsVisible: false,
      wireframeVisible: false,
    });

    expect(pointsOnly).toMatchObject({
      hasAnyEffectivePass: true,
      needsCellModel: true,
      needsPointGeometry: true,
      needsSurfaceInstances: false,
      needsVectors: false,
    });
    expect(vectorsOnly).toMatchObject({
      hasAnyEffectivePass: true,
      needsCellModel: true,
      needsPointGeometry: false,
      needsSurfaceInstances: false,
      needsVectors: true,
    });
    expect(allOff).toMatchObject({
      hasAnyEffectivePass: false,
      needsCellModel: false,
      needsSurfaceInstances: false,
    });
  });

  it("builds bounded FDM point positions from cell centers for the selected geometry scope", () => {
    const model = buildFdmCuboidInstanceModel(
      domainFixture({
        displayCellBudget: 8,
        displayCellCount: 8,
        shape: [2, 2, 2],
        stride: 1,
        totalCells: 8,
      }),
    );

    expect(buildFdmPointPositions(model, "full")).toHaveLength(8 * 3);
    expect(buildFdmPointPositions(model, "surface")).toHaveLength(8 * 3);
    expect(buildFdmPointPositions(null, "full")).toBeNull();

    const interiorModel = buildFdmCuboidInstanceModel(
      domainFixture({
        displayCellBudget: 27,
        displayCellCount: 27,
        shape: [3, 3, 3],
        stride: 1,
        totalCells: 27,
      }),
    );
    expect(buildFdmPointPositions(interiorModel, "full")).toHaveLength(27 * 3);
    expect(buildFdmPointPositions(interiorModel, "surface")).toHaveLength(26 * 3);
  });

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

    expect(model?.count).toBe(4);
    expect(Array.from(model?.cellIndices ?? [])).toEqual([1, 2, 3, 6]);
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

    expect(instanceModelBlock).toContain("sampleFdmDisplayCellIndices(");
    expect(instanceModelBlock).toContain(
      "new Uint32Array(displayCellIndices.length)",
    );
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

  it("maps explicit FDM vector payload indices to cell ordinals", () => {
    const model = buildFdmCuboidInstanceModel(
      domainFixture({
        displayCellBudget: 4,
        displayCellCount: 4,
        shape: [4, 1, 1],
        stride: 1,
        totalCells: 4,
      }),
    );
    const segments = buildFdmVectorSegments(
      model,
      {
        ...vectorField([
          1, 0, 0, // field index 0 is cell ordinal 3
          0, 1, 0, // field index 1 is cell ordinal 1
        ]),
        indexing: "explicit_node_indices",
        nodeIndices: Uint32Array.from([3, 1]),
      },
      2e-9,
      2,
    );

    expect(Array.from(segments ?? [])).toEqual([
      expect.closeTo(1.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(1.5e-9),
      1,
      expect.closeTo(2.5e-9),
      expect.closeTo(1e-9),
      expect.closeTo(1.5e-9),
      expect.closeTo(2.5e-9),
      expect.closeTo(1e-9),
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
    expect(sceneModelSource).toContain("buildViewport3DFdmTargetViews");
    expect(sceneModelSource).toContain("view.cellIndices");
    expect(sceneModelSource).toContain(
      "modelFieldVector: fdmInstanceModelFieldVector",
    );
    expect(sceneModelSource).toContain("fdmInstanceModel: fdmInstanceModel");
    expect(sceneModelSource).toContain("fdmVectorSegments");
    expect(sceneModelSource).toContain("fdmBuildState?.error?.message");
    expect(sceneModelSource).not.toContain("buildFdmCuboidInstanceModel(");
    expect(sceneModelSource).not.toContain("const fdmSurfaceInstanceModel");
    expect(sceneSource).toContain("fdmInstanceModel: FdmCuboidInstanceModel | null | undefined");
    expect(sceneSource).toContain("fdmVectorSegments: Float32Array | null");
    expect(sceneSource).toContain("instanceModel={view.sourceModel}");
    expect(sceneSource).toContain("instanceOrdinals={view.instanceOrdinals}");
    expect(sceneSource).toContain("carrierId={view.target.id}");
    expect(sceneSource).toContain("vectorSegments={view.vectorSegments}");
    expect(layerSource).toContain("instanceModel?: FdmCuboidInstanceModel | null");
    expect(layerSource).toContain("const model = instanceModel ?? null");
    expect(layerSource).not.toContain("instanceModel !== undefined");
    expect(layerSource).toContain("resolveFdmCuboidBuildState");
    expect(layerSource).toContain("createFdmCuboidBuildStateController");
    expect(layerSource).toContain("store.begin(buildKey)");
    expect(layerSource).toContain("store.resolve(buildKey, result)");
    expect(layerSource).toContain("store.reject(buildKey, error)");
    expect(layerSource).toContain("() => EMPTY_FDM_CUBOID_BUILD_SNAPSHOT");
  });

  it("uses unlit materials for FDM cell surfaces", () => {
    const layerSource = readFileSync(fdmCuboidLayerPath, "utf8");

    expect(layerSource).toContain("MeshBasicMaterial");
    expect(layerSource).not.toContain("MeshStandardMaterial");
    expect(layerSource).toContain("color.fill(1);");
    expect(layerSource).toContain("new BufferAttribute(color, 3)");
  });

  it("keeps instance colors neutral against the regular vertex-color channel", () => {
    const layerSource = readFileSync(fdmCuboidLayerPath, "utf8");

    expect(layerSource).toContain(
      'next.setAttribute("color", new BufferAttribute(color, 3))',
    );
    expect(layerSource).toContain("color.fill(1)");
  });

  it("keys FDM matrix uploads by prepared content rather than render mode", () => {
    const layerSource = readFileSync(fdmCuboidLayerPath, "utf8");
    const matrixUploadBlock = layerSource.slice(
      layerSource.indexOf("const uploadPreparedCarriers = useCallback"),
      layerSource.indexOf("useEffect(() => {\n    uploadPreparedCarriers();"),
    );

    expect(matrixUploadBlock).toContain("preparedInstances.contentRevision");
    expect(matrixUploadBlock).not.toContain("renderPlan.surface.visible");
    expect(matrixUploadBlock).not.toContain("renderPlan.wireframe.visible");
  });

  it("retains the FDM surface mesh when scalar coloring changes", () => {
    const layerSource = readFileSync(fdmCuboidLayerPath, "utf8");
    const surfaceMeshBlock = layerSource.slice(
      layerSource.indexOf("<instancedMesh"),
      layerSource.indexOf("ref={surfaceRef}"),
    );

    expect(surfaceMeshBlock).not.toContain("key=");
    expect(layerSource).toContain(
      "surface.instanceColor = new InstancedBufferAttribute(",
    );
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

  it("routes target-view picks through a target-aware callback", () => {
    const layerSource = readFileSync(fdmCuboidLayerPath, "utf8");
    const sceneSource = readFileSync(viewport3DScenePath, "utf8");

    expect(layerSource).toContain("onSelectTarget?: () => void");
    expect(layerSource).toContain("if (onSelectTarget)");
    expect(layerSource).toContain("onSelectTarget();");
    expect(sceneSource).toContain("onSelectFdmTarget");
    expect(sceneSource).toContain("onSelectTarget={() => onSelectFdmTarget(view.target)}");
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

  it("bounds target color uploads by the target view, not the shared model", () => {
    expect(
      buildFdmCuboidColorUploadBatchesForView(
        { count: 1_000_000 },
        Uint32Array.from([999_999]),
        256,
      ),
    ).toEqual([{ end: 1, start: 0 }]);
  });

  it("caps rendered FDM vector glyph scale to the local voxel size", () => {
    const model = buildFdmCuboidInstanceModel(domainFixture(), {
      voxelFillRatio: 0.5,
    });

    expect(resolveFdmVectorGlyphScale(model, 100e-9)).toBeCloseTo(1.125e-9);
    expect(resolveFdmVectorGlyphScale(model, 0.25e-9)).toBeCloseTo(0.25e-9);
  });
});
