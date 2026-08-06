import { describe, expect, it } from "vitest";

import {
  viewportSelectionForMeshPart,
  viewportSelectionForDomain,
  viewportSelectionForObject,
  viewportSelectionForRegion,
  viewportSelectionForFdmCell,
  viewportSelectionForFdmTarget,
  viewportSelectionForFdmUniverseOutsideSupport,
} from "./viewport3dSelection";
import type { FdmRegionMembershipResource } from "@/kernel/api/apiTypes";
import { selectionRefEquals } from "@/kernel/selection/selectionTypes";

describe("viewport3dSelection", () => {
  it("builds an identity-complete FDM cell selection", () => {
    const membership: FdmRegionMembershipResource = {
      binary_path: "fdm.bin",
      cell_count: 8,
      cell_m: [1, 1, 1],
      counts: [2, 2, 2],
      domain_generation_id: "generation-7",
      encoding: "u32le",
      freshness: "current",
      grid_fingerprint: "grid-7",
      mesh_revision: 11,
      origin_m: [0, 0, 0],
      region_legend: [{ numeric_id: 7, object_id: "object:core", priority: 0, region_id: "region:core" }],
      region_membership_revision: 12,
      schema_version: "fdm_region_membership.v1",
    };
    const selection = viewportSelectionForFdmCell({
      binary: {
        counts: [2, 2, 2], cellCount: 8, gridFingerprint: "grid-7", legendCount: 1,
        formatVersion: 2, payloadKind: 2, regionIds: new Uint32Array([0, 7, 0, 0, 0, 0, 0, 0]), semanticStatus: "canonical",
      },
      domainShape: [2, 2, 2],
      instanceId: 0,
      membership,
      model: { cellIndices: new Uint32Array([1]), centers: new Float32Array(3), count: 1, gridShape: [2, 2, 2], cellSize: [1, 1, 1], regionIds: new Uint32Array([7]) },
    });
    expect(selection?.ref).toMatchObject({
      type: "fdm-cell", cellOrdinal: "1", gridFingerprint: "grid-7", ijk: [1, 0, 0],
      maskState: "region", numericRegionId: 7, regionId: "region:core", membershipRevision: "11:12",
    });
  });

  it("fails closed for legacy or missing FDM membership identity", () => {
    expect(viewportSelectionForFdmCell({
      binary: null,
      domainShape: [2, 2, 2],
      instanceId: 0,
      membership: null,
      model: null,
    })).toBeNull();
  });
  it("maps a domain pick to the visible Universe Explorer node", () => {
    expect(viewportSelectionForDomain("fdm-domain")).toEqual({
      kind: "universe.root",
      label: "fdm-domain",
      nodeId: "model:universe",
      objectId: null,
      ref: null,
    });
  });

  it("maps the FDM universe overlay pick to its distinct visualization target", () => {
    expect(viewportSelectionForFdmUniverseOutsideSupport()).toEqual({
      kind: "airbox.visualization",
      label: "Airbox",
      nodeId: "model:airbox:visualization",
      objectId: null,
      ref: {
        kind: "mesh.grid.universe-outside-support",
        nodeId: "model:airbox:visualization",
        scope: "universe-outside-support",
        type: "fdm-domain",
        visualizationTargetId: "fdm-universe-outside-support",
      },
    });
  });

  it("maps viewport object picks to canonical explorer object selections", () => {
    expect(
      viewportSelectionForObject({
        label: "Free layer",
        objectId: "free-layer",
      }),
    ).toEqual({
      kind: "object.root",
      label: "Free layer",
      nodeId: "model:object:free-layer",
      objectId: "free-layer",
      ref: {
        kind: "object.root",
        nodeId: "model:object:free-layer",
        objectId: "free-layer",
        type: "scene-object",
        visualizationTargetId: "object:free-layer",
      },
    });
  });

  it("maps viewport region picks to canonical explorer region selections", () => {
    expect(
      viewportSelectionForRegion({
        objectId: "free-layer",
        regionId: "region:free-layer",
      }),
    ).toEqual({
      kind: "object.region",
      label: "region:free-layer",
      nodeId: "model:object:free-layer:regions:region:free-layer",
      objectId: "free-layer",
      ref: {
        kind: "object.region",
        nodeId: "model:object:free-layer:regions:region:free-layer",
        objectId: "free-layer",
        regionId: "region:free-layer",
        type: "scene-object",
        visualizationTargetId: "region:free-layer:region%3Afree-layer",
      },
    });
  });

  it("maps FDM target-view picks to their object or region Explorer nodes", () => {
    expect(
      viewportSelectionForFdmTarget({
        id: "object:free-layer",
        kind: "object",
        label: "Free layer",
      }),
    ).toMatchObject({
      kind: "object.root",
      label: "Free layer",
      nodeId: "model:object:free-layer",
      objectId: "free-layer",
    });
    expect(
      viewportSelectionForFdmTarget({
        id: "region:free-layer:region%3Afree-layer",
        kind: "region",
        label: "region:free-layer",
      }),
    ).toMatchObject({
      kind: "mesh.grid.region",
      label: "region:free-layer",
      nodeId: "model:mesh:region:free-layer:region%3Afree-layer",
      objectId: "free-layer",
      ref: {
        kind: "mesh.grid.region",
        regionId: "region:free-layer",
        scope: "region",
        type: "fdm-domain",
        visualizationTargetId: "region:free-layer:region%3Afree-layer",
      },
    });
  });

  it("fails closed for malformed FDM region target identities", () => {
    expect(
      viewportSelectionForFdmTarget({
        id: "region:missing-separator",
        kind: "region",
        label: "broken",
      }),
    ).toBeNull();
  });

  it("maps an Airbox carrier pick to the canonical Airbox Explorer node", () => {
    expect(
      viewportSelectionForMeshPart(
        {
          carrierIds: ["part:__air__"],
          explorerNodeId: "model:airbox",
          explorerTabId: "model",
          label: "Airbox",
          targetId: "airbox",
          targetKind: "airbox",
        },
        {
          boundaryFaceIndex: 12,
          carrierPartId: "part:__air__",
          elementFamily: "tet4",
          globalCellOrdinal: "9007199254740993",
          label: "Exterior air",
        },
      ),
    ).toEqual({
      kind: "airbox.root",
      label: "Airbox",
      nodeId: "model:airbox",
      objectId: null,
      ref: {
        boundaryFaceIndex: 12,
        carrierPartId: "part:__air__",
        elementFamily: "tet4",
        globalCellOrdinal: "9007199254740993",
        kind: "airbox.root",
        nodeId: "model:airbox",
        type: "airbox",
        visualizationTargetId: "airbox",
      },
    });
  });

  it("treats canonical cell identity as part of selection equality", () => {
    const base = viewportSelectionForMeshPart(
      {
        carrierIds: ["part:film"],
        explorerNodeId: "model:object:film",
        explorerTabId: "model",
        label: "film",
        targetId: "object:film",
        targetKind: "object",
      },
      {
        boundaryFaceIndex: 3,
        carrierPartId: "part:film",
        elementFamily: "prism6",
        globalCellOrdinal: "9007199254740993",
        label: "Film volume",
      },
    ).ref;
    if (!base || base.type !== "scene-object") {
      throw new Error("Expected a scene-object selection ref");
    }

    expect(selectionRefEquals(base, { ...base })).toBe(true);
    expect(selectionRefEquals(
      base,
      { ...base, globalCellOrdinal: "9007199254740994" },
    )).toBe(false);
    expect(selectionRefEquals(
      base,
      { ...base, elementFamily: "pyramid5" },
    )).toBe(false);
  });

  it("maps an owned FEM carrier pick to its authored object Explorer node", () => {
    expect(
      viewportSelectionForMeshPart(
        {
          carrierIds: ["part:film"],
          explorerNodeId: "model:object:film",
          explorerTabId: "model",
          label: "film",
          targetId: "object:film",
          targetKind: "object",
        },
        {
          boundaryFaceIndex: 3,
          carrierPartId: "part:film",
          label: "Film volume",
        },
      ),
    ).toMatchObject({
      kind: "object.root",
      nodeId: "model:object:film",
      objectId: "film",
      ref: {
        carrierPartId: "part:film",
        type: "scene-object",
        visualizationTargetId: "object:film",
      },
    });
  });

  it("maps an orphan FEM carrier pick to its explicit fallback Explorer node", () => {
    expect(
      viewportSelectionForMeshPart(
        {
          carrierIds: ["part:orphan"],
          explorerNodeId: "model:mesh:unassigned:part%3Aorphan",
          explorerTabId: "model",
          label: "Orphan",
          targetId: "part:orphan",
          targetKind: "part",
        },
        {
          boundaryFaceIndex: null,
          carrierPartId: "part:orphan",
          label: "Orphan",
        },
      ),
    ).toMatchObject({
      kind: "mesh-part",
      nodeId: "model:mesh:unassigned:part%3Aorphan",
      ref: {
        carrierPartId: "part:orphan",
        type: "mesh-part",
        visualizationTargetId: "part:orphan",
      },
    });
  });
});
