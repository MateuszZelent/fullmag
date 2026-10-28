import { act } from "react";
import { createRoot } from "react-dom/client";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { describe, expect, it, vi } from "vitest";

import type { SavedFieldGeometryResource } from "@/kernel/api/apiTypes";
import type { DecodedTopology } from "@/kernel/api/codecs";
import { buildSavedAntennaSourceModel } from "../model/savedAntennaSourceModel";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DColors } from "../viewport3dTypes";
import { createSavedAntennaSourceGeometry, SavedAntennaSourceLayer } from "./SavedAntennaSourceLayer";

const { invalidate } = vi.hoisted(() => ({ invalidate: vi.fn() }));
vi.mock("../viewport3dBatchedInvalidate", () => ({ useBatchedInvalidate: () => invalidate }));

function source() {
  const positions = new Float64Array([0, 0, 0, 2e-6, 0, 0, 0, 1e-6, 0, 0, 0, 1e-6]);
  const triangles = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
  const topology: DecodedTopology = {
    nodeCount: 4, positions, boundaryFaceCount: 4, boundaryFaces: triangles,
    boundaryMarkers: new Uint32Array(4), elementCount: 1,
    elementMarkers: new Uint32Array(1), indices: new Uint32Array([0, 1, 2, 3]),
  };
  const geometry = {
    node_count: "4", geometry_manifest: { object_ref: "source-geometry-a" },
    topology_fingerprint: "source-topology-a",
  } as SavedFieldGeometryResource;
  const model = buildSavedAntennaSourceModel(geometry, topology)!;
  return { geometry, model, topology };
}

describe("archived antenna source context", () => {
  it("renders the archived boundary in SI without field attributes or changing source coordinates", () => {
    const { model, topology } = source();
    const before = topology.positions.slice();
    const geometry = createSavedAntennaSourceGeometry(model);
    expect(model.key).toBe("source-geometry-a");
    const faces = (indices: ArrayLike<number>) => Array.from({ length: indices.length / 3 }, (_, i) =>
      Array.from({ length: 3 }, (_, corner) => indices[i * 3 + corner]!).sort().join(",")).sort();
    // The shared topology adapter reconstructs exterior faces from volume cells.
    expect(faces(geometry.index!.array)).toEqual(faces(topology.boundaryFaces));
    expect(geometry.getAttribute("position").array).toBe(model.positions);
    expect(Array.from(topology.positions)).toEqual(Array.from(before));
    expect(geometry.getAttribute("position").getX(1)).toBeCloseTo(2e-6, 12);
    expect(geometry.getAttribute("uv").count).toBe(4);
    for (const value of geometry.getAttribute("uv").array) expect(Number.isFinite(value)).toBe(true);
    expect(Object.keys(geometry.attributes).sort()).toEqual(["normal", "position", "uv"]);
    geometry.dispose();
  });

  it("rejects inconsistent or empty archived topology", () => {
    const { geometry, topology } = source();
    expect(buildSavedAntennaSourceModel({ ...geometry, node_count: "20" }, topology)).toBeNull();
    expect(buildSavedAntennaSourceModel(geometry, { ...topology, positions: new Float64Array(3) })).toBeNull();
    expect(buildSavedAntennaSourceModel(geometry, {
      ...topology, boundaryFaceCount: 0, boundaryFaces: new Uint32Array(),
      elementCount: 0, indices: new Uint32Array(),
    })).toBeNull();
  });

  it("releases previous geometry on selection change and every owned GPU resource on exit", async () => {
    const first = source().model;
    const second = { ...source().model, key: "source-geometry-b" };
    const tracked = new Set<unknown>();
    const released: unknown[] = [];
    const tracker = {
      track: vi.fn((_kind: string, resource: unknown) => { tracked.add(resource); }),
      release: vi.fn((_kind: string, resource: { dispose(): void }) => {
        expect(tracked.delete(resource)).toBe(true);
        released.push(resource);
        resource.dispose();
      }),
    } as unknown as Viewport3DResourceTracker;
    const colors = { antenna: "gold", mesh: "gray" } as Viewport3DColors;
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    let result: ReturnType<typeof SavedAntennaSourceLayer> = null;
    function Probe({ model }: { model: typeof first | null }) {
      result = SavedAntennaSourceLayer({ model, colors, tracker });
      return null;
    }
    const rerender = (model: typeof first | null) => act(async () => root.render(<Probe model={model} />));
    await rerender(first);
    try {
    expect(result!.props.userData).toEqual({
      geometryObjectRef: first.key, fieldCapable: false, archived: true,
    });
    const oldGeometry = result!.props.geometry;
    const oldMaterial = result!.props.material;
    expect(tracked.size).toBe(4);
    await rerender(second);
    expect(released).toContain(oldGeometry);
    expect(result!.props.material).toBe(oldMaterial);
    expect(result!.props.userData.geometryObjectRef).toBe(second.key);
    await rerender(null);
    expect(result).toBeNull();
    expect(tracked.size).toBe(0);
    const calls = tracker.track as ReturnType<typeof vi.fn>;
    expect(calls.mock.calls.filter(([kind]) => kind === "texture")).toHaveLength(2);
    const invalidations = invalidate.mock.calls.length;
    await rerender(null);
    expect(invalidate.mock.calls.length).toBe(invalidations);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
    expect(tracked.size).toBe(0);
  });
});
