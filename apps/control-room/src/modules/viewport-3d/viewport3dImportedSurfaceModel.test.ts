import { describe, expect, it } from "vitest";
import { buildImportedSurfacePreview, isImportedStlGeometry, loadImportedSurfaceSources, type ImportedSurfaceSource } from "./viewport3dImportedSurfaceModel";
import { buildViewport3DPrimitiveRenderModel } from "./viewport3dPrimitiveModel";
import { createPrimitiveObjectGeometry } from "./layers/PrimitiveObjectLayerModel";

function source(): ImportedSurfaceSource {
  return {
    descriptor: { purpose: "authoring_source_surface", solver_eligible: false,
      object_id: "body", scene_revision: 7, surface_id: "surface-a", source_sha256: "a".repeat(64),
      coordinate_frame: "object_local", coordinate_unit: "m", scale_to_metres: [1e-9, 1e-9, 1e-9],
      node_count: 3, triangle_count: 1, bounds_min: [0, 0, 0], bounds_max: [2e-9, 3e-9, 0], topology_format: "FMMT/2" },
    topology: { formatVersion: 2, cellCount: 0, cellTypes: new Uint32Array(),
      facetCount: 1, facetTypes: new Uint32Array([1]), facetNodes: new Uint32Array([0, 1, 2]),
      nodeCount: 3, positions: new Float64Array([0, 0, 0, 2e-9, 0, 0, 0, 3e-9, 0]),
      boundaryFaceCount: 1, boundaryFaces: new Uint32Array([0, 1, 2]), boundaryMarkers: new Uint32Array(),
      elementCount: 0, elementMarkers: new Uint32Array(), indices: new Uint32Array() },
  };
}
const scene = { scene_revision: 7, objects: [{ id: "body", name: "Body",
  geometry: { geometry_kind: "ImportedGeometry", geometry_params: { source: "body.stl", scale: 1e-9 } },
  transform: { translation: [1e-9, 0, 0] } }] };

describe("imported STL source preview", () => {
  it("renders exact source triangles in SI and applies object translation once", () => {
    const model = buildViewport3DPrimitiveRenderModel(scene as never, null, new Map([["body", source()]]));
    expect(model.objects).toHaveLength(1);
    const object = model.objects[0];
    expect(object.kind).toBe("imported-surface");
    expect(object.bounds.size[0]).toBeCloseTo(2e-9, 20);
    expect(object.bounds.size[1]).toBeCloseTo(3e-9, 20);
    expect(object.bounds.center[0]).toBeCloseTo(2e-9, 20);
    expect(object.bounds.center[1]).toBeCloseTo(1.5e-9, 20);
    expect(object.importedSurface?.positions[3]).toBeCloseTo(3e-9, 20);
    const geometry = createPrimitiveObjectGeometry(object);
    expect(geometry.type).toBe("BufferGeometry");
    expect(Array.from(geometry.index!.array)).toEqual([0, 1, 2]);
    expect(geometry.getAttribute("position").count).toBe(3);
    geometry.dispose();
  });
  it("never substitutes a box while the source is missing or stale", () => {
    expect(buildViewport3DPrimitiveRenderModel(scene as never, null).objects).toEqual([]);
    const stale = source(); stale.descriptor.scene_revision = 6;
    expect(buildViewport3DPrimitiveRenderModel(scene as never, null, new Map([["body", stale]])).objects).toEqual([]);
  });
  it("rotates and scales local source coordinates before translating", () => {
    const preview = buildImportedSurfacePreview(source(), { scale: [2, 1, 1],
      rotation_quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2], translation: [1e-9, 0, 0] });
    expect(preview.positions[3]).toBeCloseTo(1e-9, 20);
    expect(preview.positions[4]).toBeCloseTo(4e-9, 20);
    expect(preview.positions[6]).toBeCloseTo(-2e-9, 20);
  });
  it("rejects volume topology, wrong facet count and unsupported transforms", () => {
    const volume = source(); volume.topology.cellCount = 1;
    expect(() => buildImportedSurfacePreview(volume, {})).toThrow("source descriptor");
    const wrong = source(); wrong.descriptor.triangle_count = 2;
    expect(() => buildImportedSurfacePreview(wrong, {})).toThrow("source descriptor");
    expect(() => buildImportedSurfacePreview(source(), { pivot: [1, 0, 0] })).toThrow("zero pivot");
    expect(() => buildImportedSurfacePreview(source(), { scale: [-1, 1, 1] })).toThrow("positive scale");
  });
});


it("retains healthy STL objects when a sibling source fails", async () => {
  const collection = await loadImportedSurfaceSources(["missing", "healthy"], async objectId => {
    if (objectId === "missing") throw new Error("STL source file is unavailable");
    return source();
  }, new AbortController().signal);
  expect([...collection.sources.keys()]).toEqual(["healthy"]);
  expect(collection.diagnostics).toEqual([{ objectId: "missing", message: "STL source file is unavailable" }]);
});
it("keeps legacy non-STL imports out of STL source requests", () => {
  expect(isImportedStlGeometry({ geometry_kind: "ImportedGeometry", geometry_params: { source: "mask.npz" } })).toBe(false);
  expect(isImportedStlGeometry({ geometry_kind: "ImportedGeometry", geometry_params: { source: "body.step" } })).toBe(false);
  expect(isImportedStlGeometry({ geometry_kind: "ImportedGeometry", geometry_params: { source: "body.STL" } })).toBe(true);
});
it("propagates cancellation instead of publishing a partially loaded old session", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(loadImportedSurfaceSources(["healthy"], async () => source(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});
