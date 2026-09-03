/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it } from "vitest";

import { draftsEqual, draftSignature } from "../draftToSceneDocument";

describe("draftToSceneDocument adapters", () => {
  it("computes deterministic signature for equal drafts", () => {
    const draftA = { objects: [{ id: "obj-1", visible: true }] } as never;
    const draftB = { objects: [{ id: "obj-1", visible: true }] } as never;
    expect(draftSignature(draftA)).toBe(draftSignature(draftB));
  });

  it("compares draft equality by structure", () => {
    const draftA = { objects: [{ id: "obj-1", visible: true }] } as never;
    const draftB = { objects: [{ id: "obj-1", visible: true }] } as never;
    const draftC = { objects: [{ id: "obj-2", visible: false }] } as never;

    expect(draftsEqual(draftA, draftB)).toBe(true);
    expect(draftsEqual(draftA, draftC)).toBe(false);
    expect(draftsEqual(null, draftA)).toBe(false);
  });
});
