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
  it("rejects invalid frame positions and color ranges", () => {
    const c = new SavedResultsPlaybackController(); c.open({itemId:"a",name:"A"});
    for (const v of [-1,NaN,Infinity,1.5]) { c.selectFrame(v); c.setColorLimit(v); }
    expect(c.getSnapshot()?.frameIndex).toBe(0);
    expect(c.getSnapshot()?.colorLimit).toBe(1.5);
    c.selectStage("other"); expect(c.getSnapshot()?.frameIndex).toBe(0);
  });
});
