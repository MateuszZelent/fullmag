import { describe, expect, it } from "vitest";

import type { GeometryObjectDraft } from "@/kernel/authoring/object-edit/objectEditTypes";

import {
  objectEditMetadataEquals,
  rebaseDirtyDraftOntoUnchangedObject,
  reconcileObjectEditAck,
  reconcileObjectIdentityAck,
} from "./objectEditAckReconciliation";

const canonicalDraft: GeometryObjectDraft = {
  archHeight: "5e-8",
  baseRevision: 11,
  geometryKind: "Box",
  height: "1e-8",
  length: "1e-6",
  material: "canonical-material",
  mode: "committed",
  name: "Canonical name",
  notes: "Canonical notes",
  objectId: "object-a",
  radius: "5e-8",
  region: "canonical-region",
  rotation: ["0", "0", "0"],
  scale: ["1", "1", "1"],
  size: ["2e-7", "1e-7", "1e-8"],
  translation: ["1e-7", "0", "0"],
  width: "1e-6",
  z0: "0",
};

describe("reconcileObjectEditAck", () => {
  it("keeps the selected unit after an ACK with no newer semantic edit", () => {
    const submitted: GeometryObjectDraft = {
      ...canonicalDraft, size: ["200", "1e-7", "1e-8"],
      quantityFields: { "size.0": { unit: "nm", lastValidSI: 2e-7 } },
    };
    const result = reconcileObjectEditAck(submitted, submitted, canonicalDraft);
    expect(result.draft.quantityFields?.["size.0"]?.unit).toBe("nm");
    expect(Number(result.draft.size[0])).toBeCloseTo(200, 10);
    expect(result.dirty).toBe(false);
  });

  it("retains a post-submit unit change and incomplete raw with its last-valid preview", () => {
    const submitted = { ...canonicalDraft };
    const current: GeometryObjectDraft = {
      ...submitted, size: ["1e-", "1e-7", "1e-8"],
      quantityFields: { "size.0": { unit: "nm", lastValidSI: 3e-7 } },
    };
    const result = reconcileObjectEditAck(current, submitted, canonicalDraft);
    expect(result.draft.size[0]).toBe("1e-");
    expect(result.draft.quantityFields?.["size.0"]).toEqual({ unit: "nm", lastValidSI: 3e-7 });
    expect(result.dirty).toBe(true);
  });

  it("rebases newer raw geometry and metadata while keeping disabled transform fields canonical", () => {
    const submitted: GeometryObjectDraft = {
      ...canonicalDraft,
      baseRevision: 10,
      size: ["2e-7", "1e-7", "1e-8"],
      translation: ["1e-7", "0", "0"],
    };
    const current: GeometryObjectDraft = {
      ...submitted,
      baseRevision: 10,
      material: "later local material draft",
      name: "Later local name draft",
      notes: "Later local notes draft",
      region: "later local region draft",
      rotation: ["1", "2", "3"],
      scale: ["2", "2", "2"],
      size: ["3e-7", "1e-7", "1e-8"],
      translation: ["1e-7", "4e-7", "0"],
    };

    const result = reconcileObjectEditAck(current, submitted, canonicalDraft);

    expect(result).toEqual({
      dirty: true,
      draft: {
        ...canonicalDraft,
        name: current.name,
        material: current.material,
        notes: current.notes,
        region: current.region,
        size: ["3e-7", "1e-7", "1e-8"],
        translation: ["1e-7", "4e-7", "0"],
      },
    });
    expect(result.draft).toMatchObject({
      material: current.material,
      name: current.name,
      notes: current.notes,
      region: current.region,
      rotation: ["0", "0", "0"],
      scale: ["1", "1", "1"],
    });
  });

  it("retains newer incomplete raw input while keeping ACK identity and revision", () => {
    const submitted: GeometryObjectDraft = {
      ...canonicalDraft,
      baseRevision: 10,
      objectId: "object-a",
    };
    const current: GeometryObjectDraft = {
      ...submitted,
      baseRevision: 10,
      objectId: "stale-object-id",
      size: ["", "1e-7", "1e-8"],
    };

    const result = reconcileObjectEditAck(current, submitted, canonicalDraft);

    expect(result.dirty).toBe(true);
    expect(result.draft.size).toEqual(["", "1e-7", "1e-8"]);
    expect(result.draft.objectId).toBe("object-a");
    expect(result.draft.baseRevision).toBe(11);
  });

  it("preserves unsent geometry and newer metadata after an identity ACK", () => {
    const baseline = { ...canonicalDraft, baseRevision: 10, name: "Old name" };
    const submitted: GeometryObjectDraft = { ...baseline, name: "Submitted name", size: ["3e-7", "1e-7", "1e-8"] };
    const current: GeometryObjectDraft = { ...submitted, name: "Newer name", region: "newer-region", translation: ["", "0", "0"] };
    const ack = { ...canonicalDraft, name: "Submitted name" };
    const result = reconcileObjectIdentityAck(current, submitted, baseline, ack);
    expect(result.dirty).toBe(true);
    expect(result.draft).toMatchObject({ name: "Newer name", region: "newer-region", objectId: "object-a", baseRevision: 11 });
    expect(result.draft.size).toEqual(submitted.size);
    expect(result.draft.translation).toEqual(current.translation);
  });

  it("treats empty references as canonical unassigned without ignoring metadata edits", () => {
    expect(objectEditMetadataEquals({ ...canonicalDraft, material: "", region: "" }, { ...canonicalDraft, material: "unassigned", region: "unassigned" })).toBe(true);
    expect(objectEditMetadataEquals({ ...canonicalDraft, name: "Newer name" }, canonicalDraft)).toBe(false);
  });

  it("uses canonical values when there are no newer field edits", () => {
    const submitted: GeometryObjectDraft = {
      ...canonicalDraft,
      baseRevision: 10,
      size: ["2e-7", "1e-7", "1e-8"],
    };

    expect(reconcileObjectEditAck(submitted, submitted, canonicalDraft)).toEqual({
      dirty: false,
      draft: canonicalDraft,
    });
  });
});

describe("rebaseDirtyDraftOntoUnchangedObject", () => {
  const dirty: GeometryObjectDraft = { ...canonicalDraft, name: "Edited name" };

  it("moves a dirty draft onto a newer revision when the object is unchanged", () => {
    const newer = { ...canonicalDraft, baseRevision: 12 };
    expect(rebaseDirtyDraftOntoUnchangedObject(dirty, canonicalDraft, newer)).toEqual({
      ...dirty,
      baseRevision: 12,
    });
  });

  it("keeps the old base when the object itself changed", () => {
    const moved: GeometryObjectDraft = {
      ...canonicalDraft,
      baseRevision: 12,
      translation: ["2e-7", "0", "0"],
    };
    expect(rebaseDirtyDraftOntoUnchangedObject(dirty, canonicalDraft, moved)).toBeNull();
  });

  it("keeps a draft that was not based on the previous canonical revision", () => {
    const older = { ...dirty, baseRevision: 10 };
    expect(rebaseDirtyDraftOntoUnchangedObject(older, canonicalDraft, { ...canonicalDraft, baseRevision: 12 })).toBeNull();
  });
});
