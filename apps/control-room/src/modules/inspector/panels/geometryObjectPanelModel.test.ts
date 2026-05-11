import { describe, expect, it } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  buildGeometryDraftPatch,
  buildTransformDraftPatch,
  createDraftObjectId,
  resolveGeometryObjectDraft,
  resolveGeometryObjectPanelModel,
  summarizeGeometryValidationMessages,
} from "./geometryObjectPanelModel";

const baseSelection: Selection = {
  kind: "object.root",
  label: "Box",
  moduleSource: "test",
  nodeId: "model:object:box",
  objectId: "box",
  ref: {
    kind: "object.root",
    nodeId: "model:object:box",
    objectId: "box",
    type: "scene-object",
    visualizationTargetId: "object:box",
  },
};

describe("resolveGeometryObjectPanelModel", () => {
  it("reads committed object data from SceneDocument", () => {
    const model = resolveGeometryObjectPanelModel(baseSelection, {
      objects: [
        {
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [1e-9, 2e-9, 3e-9] },
          },
          id: "box",
          material_ref: "permalloy",
          name: "Box",
          region_name: "free",
          tags: ["mesh:dirty"],
        },
      ],
      revision: 4,
    });

    expect(model).toEqual({
      dimensions: "1.0 x 2.0 x 3.0 nm",
      material: "permalloy",
      meshStatus: "mesh-stale",
      mode: "committed",
      name: "Box",
      objectId: "box",
      region: "free",
      revision: 4,
      shape: "Box",
      source: "SceneDocument",
    });
  });

  it("keeps primitive draft selections separate from committed scene objects", () => {
    const model = resolveGeometryObjectPanelModel(
      {
        ...baseSelection,
        kind: "builder.primitive",
        label: "New box",
        nodeId: "geometry:draft:box",
        objectId: null,
        ref: null,
      },
      {
        objects: [],
        revision: 4,
      },
    );

    expect(model).toMatchObject({
      meshStatus: "primitive-only",
      mode: "draft-new",
      objectId: "draft",
      shape: "box",
      source: "Inspector draft",
    });
  });

  it("initializes committed object drafts with scene revision, geometry, and transform", () => {
    const draft = resolveGeometryObjectDraft(baseSelection, {
      objects: [
        {
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [1e-8, 2e-8, 3e-8] },
          },
          id: "box",
          material_ref: "permalloy",
          name: "Box",
          region_name: "free",
          transform: {
            rotation: [0.1, 0.2, 0.3],
            scale: [1, 2, 3],
            translation: [4e-9, 5e-9, 6e-9],
          },
        },
      ],
      revision: 9,
    });

    expect(draft).toMatchObject({
      baseRevision: 9,
      geometryKind: "Box",
      material: "permalloy",
      mode: "committed",
      objectId: "box",
      region: "free",
      rotation: ["0.1", "0.2", "0.3"],
      scale: ["1", "2", "3"],
      size: ["1e-8", "2e-8", "3e-8"],
      translation: ["4e-9", "5e-9", "6e-9"],
    });
  });

  it("builds create and patch payloads from editable primitive drafts", () => {
    const draft = resolveGeometryObjectDraft(
      {
        ...baseSelection,
        kind: "builder.primitive",
        label: "New cylinder",
        nodeId: "geometry:draft:cylinder",
        objectId: null,
        ref: null,
      },
      { objects: [], revision: 12 },
    );

    expect(buildGeometryDraftPatch(draft)).toEqual({
      error: null,
      geometry: {
        geometry_kind: "Cylinder",
        geometry_params: { height: 1e-8, radius: 5e-8 },
      },
    });
    expect(buildTransformDraftPatch(draft)).toEqual({
      error: null,
      transform: {
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        translation: [0, 0, 0],
      },
    });
    expect(createDraftObjectId({ ...draft, name: "Free Layer" }, 12345)).toBe(
      "free-layer-9ix",
    );
  });

  it("validates local geometry and transform draft values before transactions", () => {
    const draft = resolveGeometryObjectDraft(baseSelection, {
      objects: [
        {
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [1e-8, 2e-8, 3e-8] },
          },
          id: "box",
        },
      ],
      revision: 1,
    });

    expect(
      buildGeometryDraftPatch({
        ...draft,
        size: ["1e-8", "0", "3e-8"],
      }),
    ).toEqual({
      error: "Box size 2 must be greater than 0.",
      geometry: null,
    });
    expect(
      buildTransformDraftPatch({
        ...draft,
        scale: ["1", "bad", "1"],
      }),
    ).toEqual({
      error: "Scale 2 must be a finite SI value.",
      transform: null,
    });
  });

  it("extracts object-scoped backend validation messages", () => {
    expect(
      summarizeGeometryValidationMessages(
        {
          diagnostics: [
            { message: "Box is outside universe", object_id: "box" },
            { message: "Cylinder radius is unsupported", object_id: "other" },
          ],
          nested: {
            issues: [
              { detail: "Material is missing", targetId: "object:box" },
            ],
          },
        },
        "box",
      ),
    ).toEqual(["Box is outside universe", "Material is missing"]);
  });
});
