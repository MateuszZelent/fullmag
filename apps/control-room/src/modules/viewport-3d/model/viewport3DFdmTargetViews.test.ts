import { describe, expect, it } from "vitest";

import type { FdmRegionMembershipResource } from "@/kernel/api/apiTypes";

import type { FdmCuboidInstanceModel } from "../layers/fdmCuboidBuildModel";
import {
  buildViewport3DFdmTargetSurfaceCellIndices,
  buildViewport3DFdmTargetViews,
  memoizeViewport3DFdmTargetRenderView,
  memoizeViewport3DFdmTargetSurfaceColors,
  memoizeViewport3DFdmSurfaceColors,
  type Viewport3DFdmTargetRenderView,
} from "./viewport3DFdmTargetViews";

function membership(
  patch: Partial<FdmRegionMembershipResource> = {},
): FdmRegionMembershipResource {
  return {
    binary_path: "fdm-region-membership.bin",
    cell_count: 4,
    cell_m: [1, 1, 1],
    counts: [4, 1, 1],
    domain_generation_id: "generation-current",
    encoding: "u32le",
    freshness: "current",
    grid_fingerprint: "grid-current",
    mesh_revision: 3,
    object_ids: ["left", "right"],
    origin_m: [0, 0, 0],
    region_legend: [
      { numeric_id: 1, object_id: "left", priority: 0, region_id: "core" },
      { numeric_id: 2, object_id: "right", priority: 0, region_id: "core" },
    ],
    region_membership_revision: 5,
    schema_version: "fdm_region_membership.v2",
    ...patch,
  };
}

function model(regionIds: number[]): FdmCuboidInstanceModel {
  return {
    cellIndices: Uint32Array.from(regionIds, (_, index) => index),
    cellSize: [1, 1, 1],
    centers: Float32Array.from(regionIds.flatMap((_, index) => [index, 0, 0])),
    count: regionIds.length,
    gridShape: [regionIds.length, 1, 1],
    matrices: new Float32Array(regionIds.length * 16),
    matrixContentRevision: "test-matrix",
    membershipRevision: "test-membership",
    regionIds: Uint32Array.from(regionIds),
  };
}

describe("buildViewport3DFdmTargetViews", () => {
  it("reuses surface colors across visibility changes and invalidates scalar range or palette", () => {
    const [view] = buildViewport3DFdmTargetViews({
      membership: membership(),
      model: model([1, 2, 1, 2]),
      realizedRegionIds: Uint32Array.from([1, 2, 1, 2]),
    }).views;
    expect(view).toBeDefined();
    let builds = 0;
    const build = (key: string) =>
      memoizeViewport3DFdmTargetSurfaceColors({
        build: () => {
          builds += 1;
          return {
            buildKey: key,
            colors: new Float32Array(6),
            colorPalette: key.includes("magma") ? "magma" : "viridis",
            range: key.includes("range:2")
              ? { max: 2, min: -2 }
              : { max: 1, min: -1 },
          };
        },
        colorKey: key,
        view: view!,
      });

    const visible = build("scalar:r1|range:1|palette:viridis");
    const hidden = build("scalar:r1|range:1|palette:viridis");
    const ranged = build("scalar:r1|range:2|palette:viridis");
    const palette = build("scalar:r1|range:2|palette:magma");

    expect(hidden).toBe(visible);
    expect(ranged).not.toBe(visible);
    expect(palette).not.toBe(ranged);
    expect(builds).toBe(3);
  });

  it.each(["native-layer", "multilayer-airbox"])(
    "uploads %s colors once across surface-wireframe-surface and once per semantic revision",
    (kind) => {
      const owner = {};
      let builds = 0;
      const resolve = (key: string) =>
        memoizeViewport3DFdmSurfaceColors({
          build: () => {
            builds += 1;
            return {
              buildKey: key,
              colors: new Float32Array(6),
              colorPalette: key.includes("magma") ? "magma" : "viridis",
              range: key.includes("field:r2")
                ? { max: 2, min: -2 }
                : { max: 1, min: -1 },
            };
          },
          colorKey: `${kind}|${key}`,
          owner,
        });

      const surface = resolve("field:r1|palette:viridis");
      const wireframe = resolve("field:r1|palette:viridis");
      const surfaceAgain = resolve("field:r1|palette:viridis");
      const fieldRevision = resolve("field:r2|palette:viridis");
      const paletteRevision = resolve("field:r2|palette:magma");

      expect(wireframe).toBe(surface);
      expect(surfaceAgain).toBe(surface);
      expect(fieldRevision).not.toBe(surface);
      expect(paletteRevision).not.toBe(fieldRevision);
      expect(builds).toBe(3);
    },
  );
  it("fails closed when a malformed membership omits freshness", () => {
    const result = buildViewport3DFdmTargetViews({
      membership: { ...membership(), freshness: undefined } as never,
      model: model([1, 2, 1, 2]),
      realizedRegionIds: Uint32Array.from([1, 2, 1, 2]),
    });

    expect(result).toMatchObject({
      reason: "membership-not-current",
      status: "incompatible",
      views: [],
    });
  });

  it("partitions one sampled model into shared object and region views", () => {
    const source = model([1, 2, 1, 2]);

    const result = buildViewport3DFdmTargetViews({
      membership: membership(),
      model: source,
      realizedRegionIds: Uint32Array.from([1, 2, 1, 2]),
    });

    expect(result.status).toBe("ready");
    expect(result.views.map((view) => view.target.id)).toEqual([
      "object:left",
      "object:right",
      "region:left:core",
      "region:right:core",
    ]);
    const leftObject = result.views.find((view) => view.target.id === "object:left");
    const rightObject = result.views.find((view) => view.target.id === "object:right");
    const leftRegion = result.views.find((view) => view.target.id === "region:left:core");
    const rightRegion = result.views.find((view) => view.target.id === "region:right:core");
    expect(Array.from(leftObject?.instanceOrdinals ?? [])).toEqual([0, 2]);
    expect(Array.from(leftObject?.cellIndices ?? [])).toEqual([0, 2]);
    expect(Array.from(rightObject?.instanceOrdinals ?? [])).toEqual([1, 3]);
    expect(Array.from(rightObject?.cellIndices ?? [])).toEqual([1, 3]);
    expect(Array.from(leftRegion?.instanceOrdinals ?? [])).toEqual([0, 2]);
    expect(Array.from(leftRegion?.cellIndices ?? [])).toEqual([0, 2]);
    expect(Array.from(rightRegion?.instanceOrdinals ?? [])).toEqual([1, 3]);
    expect(Array.from(rightRegion?.cellIndices ?? [])).toEqual([1, 3]);
    expect(result.views.every((view) => view.sourceModel === source)).toBe(true);
    expect(result.views.every((view) => view.sourceModel.centers === source.centers)).toBe(true);
  });

  it("routes active-unassigned cells to the only proven owner object", () => {
    const result = buildViewport3DFdmTargetViews({
      membership: membership({
        object_ids: ["object:film"],
        region_legend: [
          {
            numeric_id: 1,
            object_id: "object:film",
            priority: 0,
            region_id: "region:edge",
          },
        ],
      }),
      model: model([0, 1, 0, 1]),
      realizedRegionIds: Uint32Array.from([0, 1, 0, 1]),
    });

    expect(result.status).toBe("ready");
    expect(result.views.map((view) => view.target.id)).toEqual([
      "object:film",
      "region:film:region%3Aedge",
    ]);
    const objectView = result.views.find((view) => view.target.id === "object:film");
    const regionView = result.views.find(
      (view) => view.target.id === "region:film:region%3Aedge",
    );
    expect(Array.from(objectView?.cellIndices ?? [])).toEqual([0, 1, 2, 3]);
    expect(Array.from(regionView?.cellIndices ?? [])).toEqual([1, 3]);
  });

  it("keeps a homogeneous active grid renderable when the membership lists aliases", () => {
    const result = buildViewport3DFdmTargetViews({
      membership: membership({
        object_ids: ["film", "film-geometry"],
        region_legend: [],
      }),
      model: model([0, 0, 0, 0]),
      realizedRegionIds: Uint32Array.from([0, 0, 0, 0]),
      sceneObjectIds: new Set(["film"]),
    });

    expect(result.status).toBe("ready");
    expect(result.views.map((view) => view.target.id)).toEqual([
      "object:film",
    ]);
    expect(Array.from(result.views[0]?.cellIndices ?? [])).toEqual([0, 1, 2, 3]);
  });

  it("does not collapse distinct scene objects when the membership lists several owners", () => {
    const result = buildViewport3DFdmTargetViews({
      membership: membership({
        object_ids: ["film-a", "film-b", "film-a-geometry"],
        region_legend: [],
      }),
      model: model([0, 0, 0, 0]),
      realizedRegionIds: Uint32Array.from([0, 0, 0, 0]),
      sceneObjectIds: new Set(["film-a", "film-b"]),
    });

    expect(result).toMatchObject({
      reason: "ambiguous-active-unassigned-owner",
      status: "incompatible",
      views: [],
    });
  });

  it("uses the resolved scene owner for region aliases as well as object aliases", () => {
    const result = buildViewport3DFdmTargetViews({
      membership: membership({
        object_ids: ["film", "film-geometry"],
        region_legend: [
          {
            numeric_id: 1,
            object_id: "film-geometry",
            priority: 0,
            region_id: "core",
          },
        ],
      }),
      model: model([1, 1, 1, 1]),
      realizedRegionIds: Uint32Array.from([1, 1, 1, 1]),
      sceneObjectIds: new Set(["film"]),
    });

    expect(result.status).toBe("ready");
    expect(result.views.map((view) => view.target.id)).toEqual([
      "object:film",
      "region:film:core",
    ]);
  });

  it("does not treat same-owner region interfaces as object surface boundaries", () => {
    const realizedRegionIds = new Uint32Array(27);
    realizedRegionIds.fill(1);
    realizedRegionIds[13] = 2;
    const source: FdmCuboidInstanceModel = {
      cellIndices: Uint32Array.from({ length: 27 }, (_, index) => index),
      cellSize: [1, 1, 1],
      centers: new Float32Array(27 * 3),
      count: 27,
      gridShape: [3, 3, 3],
      matrices: new Float32Array(27 * 16),
      matrixContentRevision: "test-matrix",
      membershipRevision: "test-membership",
      regionIds: realizedRegionIds,
    };

    const result = buildViewport3DFdmTargetViews({
      membership: membership({
        cell_count: 27,
        counts: [3, 3, 3],
        object_ids: ["film"],
        region_legend: [
          { numeric_id: 1, object_id: "film", priority: 0, region_id: "base" },
          { numeric_id: 2, object_id: "film", priority: 1, region_id: "core" },
        ],
      }),
      model: source,
      realizedRegionIds,
    });

    expect(result.status).toBe("ready");
    const objectView = result.views.find((view) => view.target.id === "object:film");
    const coreView = result.views.find((view) => view.target.id === "region:film:core");
    expect(objectView).toBeDefined();
    expect(coreView).toBeDefined();
    expect(objectView?.surfaceInstanceOrdinals).not.toContain(13);
    expect(coreView?.surfaceInstanceOrdinals).toEqual(Uint32Array.of(13));
  });

  it("fails closed when active-unassigned cells cannot be assigned to one owner", () => {
    const result = buildViewport3DFdmTargetViews({
      membership: membership(),
      model: model([0, 1, 2, 2]),
      realizedRegionIds: Uint32Array.from([0, 1, 2, 2]),
    });

    expect(result).toMatchObject({
      reason: "ambiguous-active-unassigned-owner",
      status: "incompatible",
      views: [],
    });
  });

  it("fails closed when sampled membership references a missing legend entry", () => {
    const result = buildViewport3DFdmTargetViews({
      membership: membership(),
      model: model([1, 3, 2, 2]),
      realizedRegionIds: Uint32Array.from([1, 3, 2, 2]),
    });

    expect(result).toMatchObject({
      reason: "sampled-region-missing-from-legend",
      status: "incompatible",
      views: [],
    });
  });

  it("derives sparse sampled surfaces from the full FMRM rather than sampled neighbors", () => {
    const realizedRegionIds = new Uint32Array(125);
    realizedRegionIds.fill(1);
    const source: FdmCuboidInstanceModel = {
      cellIndices: Uint32Array.from([0, 62]),
      cellSize: [1, 1, 1],
      centers: Float32Array.from([0, 0, 0, 2, 2, 2]),
      count: 2,
      gridShape: [5, 5, 5],
      matrices: new Float32Array(2 * 16),
      matrixContentRevision: "test-matrix",
      membershipRevision: "test-membership",
      regionIds: Uint32Array.from([1, 1]),
    };

    const result = buildViewport3DFdmTargetViews({
      membership: membership({
        cell_count: 125,
        counts: [5, 5, 5],
        object_ids: ["film"],
        region_legend: [
          { numeric_id: 1, object_id: "film", priority: 0, region_id: "core" },
        ],
      }),
      model: source,
      realizedRegionIds,
    });

    expect(result.status).toBe("ready");
    expect(Array.from(result.views[0]?.surfaceInstanceOrdinals ?? [])).toEqual([0]);
  });

  it("maps surface target ordinals to matching field cell ordinals for shaded colors", () => {
    const source: FdmCuboidInstanceModel = {
      cellIndices: Uint32Array.from([10, 20, 30, 40]),
      cellSize: [1, 1, 1],
      centers: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
      count: 4,
      gridShape: [4, 1, 1],
      matrices: new Float32Array(4 * 16),
      matrixContentRevision: "test-matrix",
      membershipRevision: "test-membership",
      regionIds: Uint32Array.from([1, 1, 1, 1]),
    };
    const view = {
      cellIndices: Uint32Array.from([10, 20, 30, 40]),
      instanceOrdinals: Uint32Array.from([0, 1, 2, 3]),
      ownerTarget: { id: "object:film", kind: "object" as const, label: "film" },
      sourceModel: source,
      surfaceInstanceOrdinals: Uint32Array.from([0, 3]),
      target: { id: "object:film", kind: "object" as const, label: "film" },
    };

    expect(Array.from(buildViewport3DFdmTargetSurfaceCellIndices(view))).toEqual([
      10, 40,
    ]);
  });

  it("rebuilds only the changed target render view", () => {
    const result = buildViewport3DFdmTargetViews({
      membership: membership(),
      model: model([1, 2, 1, 2]),
      realizedRegionIds: Uint32Array.from([1, 2, 1, 2]),
    });
    const builds = new Map<string, number>();
    const build = (view: (typeof result.views)[number]) => {
      builds.set(view.target.id, (builds.get(view.target.id) ?? 0) + 1);
      return {
        ...view,
        fieldVector: null,
        settings: {} as Viewport3DFdmTargetRenderView["settings"],
        surfaceColors: null,
        vectorColors: null,
        vectorGlyphColors: null,
        vectorSegments: null,
      };
    };
    const render = (keyByTarget: ReadonlyMap<string, string>) =>
      new Map(
        result.views.map((view) => [
          view.target.id,
          memoizeViewport3DFdmTargetRenderView({
            build: () => build(view),
            renderKey: keyByTarget.get(view.target.id) ?? "",
            view,
          }),
        ]),
      );
    const first = render(
      new Map(result.views.map((view) => [view.target.id, "v1"])),
    );
    const second = render(
      new Map([
        ["region:left:core", "v2"],
        ["region:right:core", "v1"],
      ]),
    );

    expect(builds.get("region:left:core")).toBe(2);
    expect(builds.get("region:right:core")).toBe(1);
    expect(second.get("region:right:core")).toBe(first.get("region:right:core"));
    expect(second.get("region:left:core")).not.toBe(first.get("region:left:core"));
  });
});
