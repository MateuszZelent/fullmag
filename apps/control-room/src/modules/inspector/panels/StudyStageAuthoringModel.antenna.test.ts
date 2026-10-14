import { describe, expect, it } from "vitest";

import {
  buildStudyStagesMergePatch,
  createDefaultStudyStageDraft,
  createStudyStageDraft,
  studyStageDraftToSceneStage,
  validateStudyStageDraft,
} from "./StudyStageAuthoringModel";

describe("antenna field-solve definition references", () => {
  const stage = {
    kind: "antenna_field_solve",
    entrypoint_kind: "flat_antenna_field_solve",
    stage_id: "antenna-definition",
    port_mode_ids: ["feed"],
    extension: { preserve: true },
  };

  it("preserves the complete payload without introducing magnetic controls", () => {
    const draft = createStudyStageDraft(stage, 0);
    expect(draft.kind).toBe("antenna_field_solve");
    expect(studyStageDraftToSceneStage(draft)).toEqual(stage);
    expect(studyStageDraftToSceneStage(draft)).not.toBe(stage);
    expect(validateStudyStageDraft(draft)).toEqual([]);
  });

  it.each([undefined, [], ["feed", "feed"], [""], [3]])(
    "rejects missing, empty, duplicate or non-string ports: %j",
    (ports) => {
      const draft = createStudyStageDraft({ ...stage, port_mode_ids: ports }, 0);
      expect(validateStudyStageDraft(draft).some((issue) => issue.severity === "error")).toBe(true);
    },
  );

  it("rejects a missing explicit definition instead of using a generated draft ID", () => {
    const draft = createStudyStageDraft({ ...stage, stage_id: undefined }, 0);
    expect(validateStudyStageDraft(draft).some((issue) => issue.severity === "error")).toBe(true);
  });

  it("cannot create an unbound default solve", () => {
    expect(() => createDefaultStudyStageDraft("antenna_field_solve", 0)).toThrow();
  });

  it("preserves singular references but rejects non-empty dual-form ambiguity", () => {
    const { port_mode_ids: ignored, ...singular } = stage;
    void ignored;
    expect(validateStudyStageDraft(createStudyStageDraft({ ...singular, port_mode_id: "feed" }, 0))).toEqual([]);
    expect(validateStudyStageDraft(createStudyStageDraft({ ...singular, port_mode_id: "feed", port_mode_ids: [] }, 0))).toEqual([]);
    expect(validateStudyStageDraft(createStudyStageDraft({ ...stage, port_mode_id: "other" }, 0))
      .some((issue) => issue.severity === "error")).toBe(true);
  });

  it("refuses dormant flat writes when a canonical pipeline is present", () => {
    expect(() => buildStudyStagesMergePatch([], 2, { study: {
      study_pipeline: { version: "study_pipeline.v1", nodes: [] },
    } })).toThrow(/canonical pipeline/);
  });

  it("keeps a regional field drive distinct from a conductor solve", () => {
    expect(createDefaultStudyStageDraft("add_field_drive", 0).kind).toBe("add_field_drive");
  });
});
