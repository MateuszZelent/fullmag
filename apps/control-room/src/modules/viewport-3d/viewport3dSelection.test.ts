import { describe, expect, it } from "vitest";

import {
  viewportSelectionForMeshPart,
  viewportSelectionForDomain,
  viewportSelectionForObject,
  viewportSelectionForRegion,
} from "./viewport3dSelection";
import { selectionRefEquals } from "@/kernel/selection/selectionTypes";

describe("viewport3dSelection", () => {
  it("maps a domain pick to the visible Universe Explorer node", () => {
    expect(viewportSelectionForDomain("fdm-domain")).toEqual({
      kind: "universe.root",
      label: "fdm-domain",
      nodeId: "model:universe",
      objectId: null,
      ref: null,
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
