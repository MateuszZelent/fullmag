import { beforeEach, describe, expect, it } from "vitest";

import type { FemLiveMesh } from "@/lib/session/types";
import {
  clearGlobalFemMeshTopologyCache,
  getGlobalFemMeshTopologyFrame,
  putGlobalFemMeshTopologyFrame,
} from "../hooks/useFemMeshTopologyHydration";

function makeMesh(id: string): FemLiveMesh {
  return {
    mesh_name: id,
    mesh_id: id,
    generation_id: id,
    nodes: [],
    elements: [],
    element_markers: [],
    boundary_faces: [],
    boundary_markers: [],
    node_count: 0,
    element_count: 0,
    boundary_face_count: 0,
  } as unknown as FemLiveMesh;
}

describe("global FEM mesh topology hydration cache", () => {
  beforeEach(() => {
    clearGlobalFemMeshTopologyCache();
  });

  it("keeps decoded topology outside hook lifetime", () => {
    const mesh = makeMesh("mesh-a");

    putGlobalFemMeshTopologyFrame("gen:mesh-a", mesh);

    expect(getGlobalFemMeshTopologyFrame("gen:mesh-a")).toBe(mesh);
  });

  it("uses LRU eviction so the primary recent topology survives", () => {
    const first = makeMesh("mesh-a");
    const second = makeMesh("mesh-b");
    const third = makeMesh("mesh-c");

    putGlobalFemMeshTopologyFrame("gen:mesh-a", first);
    putGlobalFemMeshTopologyFrame("gen:mesh-b", second);
    expect(getGlobalFemMeshTopologyFrame("gen:mesh-a")).toBe(first);

    putGlobalFemMeshTopologyFrame("gen:mesh-c", third);

    expect(getGlobalFemMeshTopologyFrame("gen:mesh-b")).toBeNull();
    expect(getGlobalFemMeshTopologyFrame("gen:mesh-a")).toBe(first);
    expect(getGlobalFemMeshTopologyFrame("gen:mesh-c")).toBe(third);
  });
});
