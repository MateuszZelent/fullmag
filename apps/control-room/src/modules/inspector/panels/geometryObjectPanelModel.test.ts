import { describe, expect, it } from "vitest";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";

import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  buildGeometryDraftPatch,
  buildTransformDraftPatch,
  createDraftObjectId,
  resolveGeometryObjectDraft,
  resolveGeometryObjectPanelModel,
  resolvePrimitiveDraft,
  isPrimitiveDraftRevisionConflict,
  rebaseGeometryObjectDraft,
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
  it("recognizes only the real revision-conflict API model", () => {
    expect(
      isPrimitiveDraftRevisionConflict(
        new ControlRoomApiError("stale", 409, "request-1", "revision_conflict"),
      ),
    ).toBe(true);
    expect(
      isPrimitiveDraftRevisionConflict(
        new ControlRoomApiError("invalid", 400, "request-2", "revision_conflict"),
      ),
    ).toBe(false);
    expect(isPrimitiveDraftRevisionConflict(new Error("revision_conflict"))).toBe(false);
  });

  it("rebases only the base revision and preserves every dirty field", () => {
    const draft = resolveGeometryObjectDraft(
      { ...baseSelection, kind: "builder.primitive", nodeId: "geometry:draft:box", objectId: null, ref: null },
      { objects: [], revision: 12 },
    );
    const dirty = { ...draft, name: "Dirty Box", size: ["1e-7", "2e-7", "3e-8"] as [string, string, string] };

    expect(rebaseGeometryObjectDraft(dirty, 13)).toEqual({
      ...dirty,
      baseRevision: 13,
    });
  });
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
          notes: "Release candidate waveguide",
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
      notes: "Release candidate waveguide",
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
          notes: "Inspect edge roughness before release",
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
      notes: "Inspect edge roughness before release",
      objectId: "box",
      region: "free",
      rotation: ["0.1", "0.2", "0.3"],
      scale: ["1", "2", "3"],
      size: ["1e-8", "2e-8", "3e-8"],
      translation: ["4e-9", "5e-9", "6e-9"],
    });
  });

  it("keeps ArchWaveguide script parameters editable without collapsing them to a size vector", () => {
    const selection: Selection = {
      ...baseSelection,
      label: "arch_waveguide",
      nodeId: "model:object:arch_waveguide",
      objectId: "arch_waveguide",
      ref: {
        kind: "object.root",
        nodeId: "model:object:arch_waveguide",
        objectId: "arch_waveguide",
        type: "scene-object",
        visualizationTargetId: "object:arch_waveguide",
      },
    };
    const scene = {
      objects: [
        {
          geometry: {
            geometry_kind: "ArchWaveguide",
            geometry_params: {
              arch_height: 5e-8,
              height: 2e-9,
              length: 2.5e-6,
              width: 1e-6,
              z0: -2.5e-8,
            },
          },
          id: "arch_waveguide",
          material_ref: "mat:arch_waveguide",
          name: "arch_waveguide",
          region_name: "arch_waveguide",
        },
      ],
      revision: 13,
    };

    expect(resolveGeometryObjectPanelModel(selection, scene)).toMatchObject({
      dimensions: "2.5 x 1.0 x 0.1 um",
      shape: "ArchWaveguide",
    });

    const draft = resolveGeometryObjectDraft(selection, scene);
    expect(draft).toMatchObject({
      archHeight: "5e-8",
      geometryKind: "ArchWaveguide",
      height: "2e-9",
      length: "2.5e-6",
      width: "1e-6",
      z0: "-2.5e-8",
    });
    expect(buildGeometryDraftPatch(draft)).toEqual({
      error: null,
      geometry: {
        geometry_kind: "ArchWaveguide",
        geometry_params: {
          arch_height: 5e-8,
          height: 2e-9,
          length: 2.5e-6,
          width: 1e-6,
          z0: -2.5e-8,
        },
      },
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
        translation: [0, 0, 0],
      },
    });
    expect(createDraftObjectId({ ...draft, name: "Free Layer" }, 12345)).toBe(
      "free-layer-9ix",
    );
  });

  it("validates local geometry and translation while excluding unsupported rigid transforms", () => {
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
        rotation: ["bad", "bad", "bad"],
        scale: ["bad", "bad", "bad"],
        translation: ["1e-9", "bad", "0"],
      }),
    ).toEqual({
      error: "Translation 2 must be a finite SI value.",
      transform: null,
    });
  });

  it.each([
    ["box", "geometry:draft:box", [1e-7, 1e-7, 1e-8]],
    ["cylinder", "geometry:draft:cylinder", [1e-7, 1e-8, 1e-7]],
    ["sphere", "geometry:draft:sphere", [1e-7, 1e-7, 1e-7]],
  ] as const)("builds a valid %s preview in SI without a server request", (_, nodeId, dimensions) => {
    const draft = resolveGeometryObjectDraft(
      { ...baseSelection, kind: "builder.primitive", nodeId, objectId: null, ref: null },
      { objects: [], revision: 12 },
    );

    expect(resolvePrimitiveDraft(draft)).toEqual({
      dimensions,
      errors: {},
      kind: nodeId.split(":").at(-1)?.replace(/^./, (value) => value.toUpperCase()),
      translation: [0, 0, 0],
    });
  });

  it("returns field-scoped errors and no preview dimensions for invalid SI values", () => {
    const draft = resolveGeometryObjectDraft(
      { ...baseSelection, kind: "builder.primitive", nodeId: "geometry:draft:box", objectId: null, ref: null },
      { objects: [], revision: 12 },
    );

    expect(resolvePrimitiveDraft({ ...draft, size: ["1e-7", "0", "bad"] })).toEqual({
      dimensions: null,
      errors: {
        "size.1": "Box size Y must be greater than 0.",
        "size.2": "Box size Z must be a finite SI value.",
      },
      kind: "Box",
      translation: [0, 0, 0],
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
