import { describe, expect, it } from "vitest";

import {
  currentViewport3DMeshCellAuditTopology,
  listViewport3DMeshCellSelections,
  resolveViewport3DMeshCellSelection,
} from "./viewport3dMeshCellSelection";

function part(id: string, role: "air" | "magnetic") {
  return {
    boundary_face_count: 1,
    boundary_face_indices: [7],
    boundary_face_start: 7,
    id,
    label: id,
    role,
  };
}

function topologyPart(
  id: string,
  role: "air" | "magnetic",
  cellType: number,
  globalCellOrdinal: bigint,
) {
  return {
    part: part(id, role),
    surfaceTriangleCellTypes: new Uint32Array([cellType]),
    surfaceTriangleFacetIndices: new Uint32Array([7]),
    surfaceTriangleGlobalCellOrdinals: new BigUint64Array([globalCellOrdinal]),
  };
}

describe("viewport3d mesh cell selection", () => {
  const topology = {
    airboxParts: [
      topologyPart("air-pyramid", "air", 3, BigInt(31)),
      topologyPart("air-tet", "air", 1, BigInt("9007199254740993")),
    ],
    magneticParts: [topologyPart("film", "magnetic", 2, BigInt(7))],
  };

  it("enumerates decimal canonical identities from the renderer topology model", () => {
    expect(listViewport3DMeshCellSelections(topology)).toEqual([
      {
        carrier: "airbox",
        carrierPartId: "air-pyramid",
        elementFamily: "pyramid5",
        globalCellOrdinal: "31",
      },
      {
        carrier: "airbox",
        carrierPartId: "air-tet",
        elementFamily: "tet4",
        globalCellOrdinal: "9007199254740993",
      },
      {
        carrier: "magnetic",
        carrierPartId: "film",
        elementFamily: "prism6",
        globalCellOrdinal: "7",
      },
    ]);
  });

  it("selects only the requested carrier, family, and decimal ordinal", () => {
    expect(resolveViewport3DMeshCellSelection(topology, {
      carrier: "magnetic",
      elementFamily: "prism6",
      globalCellOrdinal: "7",
    })).toMatchObject({
      carrierPartId: "film",
      elementFamily: "prism6",
      globalCellOrdinal: "7",
      kind: "mesh-part",
    });
    expect(resolveViewport3DMeshCellSelection(topology, {
      carrier: "airbox",
      elementFamily: "tet4",
      globalCellOrdinal: "9007199254740993",
    })).toMatchObject({
      carrierPartId: "air-tet",
      elementFamily: "tet4",
      globalCellOrdinal: "9007199254740993",
      kind: "mesh-part-airbox",
    });
  });

  it("does not select a matching family from the wrong carrier", () => {
    expect(resolveViewport3DMeshCellSelection(topology, {
      carrier: "magnetic",
      elementFamily: "tet4",
      globalCellOrdinal: "9007199254740993",
    })).toBeNull();
  });

  it("exposes audit selection only for the current topology revision", () => {
    expect(currentViewport3DMeshCellAuditTopology(topology, "current")).toBe(
      topology,
    );
    expect(currentViewport3DMeshCellAuditTopology(topology, "stale")).toBeNull();
    expect(currentViewport3DMeshCellAuditTopology(topology, "unknown")).toBeNull();
  });
});
