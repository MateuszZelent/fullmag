import { describe, expect, it } from "vitest";
import { SavedResultsPlaybackController } from "./SavedResultsPlaybackController";
describe("saved result selection", () => {
  it("isolates source changes and resets stage and time when opening another folder", () => {
    const c = new SavedResultsPlaybackController();
    c.open({itemId:"a",name:"A"}); c.selectStage("stage-2"); c.selectFrame(800);
    c.setColorLimit(0.001); c.open({itemId:"b",name:"B"});
    expect(c.getSnapshot()).toEqual({itemId:"b",name:"B",stageId:null,frameIndex:0,component:2,colorLimit:null});
    expect(c.getServerSnapshot()).toBeNull();
    c.close(); expect(c.getSnapshot()).toBeNull();
  });
  it("holds the exact Study case and attempt independently of a folder frame selection", () => {
    const c = new SavedResultsPlaybackController();
    const result = {
      project_id: "project", study_id: "study", artifact_id: "final-a", artifact_sha256: "a".repeat(64),
      source: { run_id: "old", task_id: "task", step_id: "relax", case_id: "default", attempt_id: "attempt", ownership_epoch: 2 },
      codec_id: "state", codec_version: "1", accepted_at: "", authored_relation: "authored_input_changed" as const,
      supports_magnetization_input: true,
    };
    c.openStudyResult(result);
    result.source.run_id = "replacement";
    c.selectStage("another");
    c.selectFrame(6);
    c.setComponent(1);
    expect(c.getSnapshot()).toMatchObject({
      studyResult: { source: { run_id: "old", case_id: "default", attempt_id: "attempt" } },
      stageId: "relax", frameIndex: 0, component: 1,
    });
    c.close();
    expect(c.getSnapshot()).toBeNull();
  });
  it("rejects invalid frame positions and color ranges", () => {
    const c = new SavedResultsPlaybackController(); c.open({itemId:"a",name:"A"});
    for (const v of [-1,NaN,Infinity,1.5]) { c.selectFrame(v); c.setColorLimit(v); }
    expect(c.getSnapshot()?.frameIndex).toBe(0);
    expect(c.getSnapshot()?.colorLimit).toBe(1.5);
    c.selectStage("other"); expect(c.getSnapshot()?.frameIndex).toBe(0);
  });
});
