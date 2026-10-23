import { describe, expect, it } from "vitest";

import { frozenSpinsStageCatalog, frozenSpinsStageIssue } from "./frozenSpinsStageCatalog";

const leaf = { id: "stage,alpha", label: "Same label", node_kind: "primitive", stage_kind: "relax" };
const study = { study_pipeline: { version: "study_pipeline.v1", nodes: [{
  id: "group", node_kind: "group", enabled: false, children: [leaf,
    { id: "macro", label: "Same label", node_kind: "macro", macro_kind: "hysteresis" }],
}] } };

describe("Frozen Spins authoring stage catalog", () => {
  it("retains groups, nested context, exact IDs, duplicate labels and inherited disabled state", () => {
    const catalog = frozenSpinsStageCatalog(study, true);
    expect(catalog.error).toBeNull();
    expect(catalog.options.map(({ id, enabled, groupIds }) => ({ id, enabled, groupIds }))).toEqual([
      { id: "group", enabled: false, groupIds: [] },
      { id: "stage,alpha", enabled: false, groupIds: ["group"] },
      { id: "macro", enabled: false, groupIds: ["group"] },
    ]);
    expect(catalog.options[1].label).toContain("stage,alpha");
    expect(catalog.options[2].label).toContain("macro");
    expect(frozenSpinsStageIssue(["group", "stage,alpha"], catalog)).toBeUndefined();
  });

  it("does not revive flat payload IDs or an invalid pipeline", () => {
    expect(frozenSpinsStageCatalog({ stages: [{ stage_id: "flat" }] }, true).options).toEqual([]);
    const catalog = frozenSpinsStageCatalog({ ...study, study_pipeline: { version: "future", nodes: [leaf] } }, true);
    expect(catalog.ready).toBe(false);
    expect(catalog.options).toEqual([]);
    expect(catalog.error).toBeTruthy();
  });

  it.each([{ ids: [] }, { ids: [""] }, { ids: ["stage,alpha", "stage,alpha"] }, { ids: ["missing"] }])("blocks invalid or unavailable IDs $ids without rewriting them", ({ ids }) => {
    const original = [...ids];
    expect(frozenSpinsStageIssue(ids, frozenSpinsStageCatalog(study, true))).toBeTruthy();
    expect(ids).toEqual(original);
  });

  it("requires current scene confirmation even when retained options match", () => {
    expect(frozenSpinsStageIssue(["stage,alpha"], frozenSpinsStageCatalog(study, false))).toContain("current");
  });
});
