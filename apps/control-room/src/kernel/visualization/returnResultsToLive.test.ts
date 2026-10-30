import {describe, expect, it, vi} from "vitest";
import type {KernelApi} from "../types";
import {SavedResultsPlaybackController} from "../saved-results/SavedResultsPlaybackController";
import {SnapshotVisualizationController, snapshotVisualizationKey} from "./SnapshotVisualizationController";
import {returnResultsToLive} from "./returnResultsToLive";

describe("return from historical results to live", () => {
  it("clears render sources while retaining snapshot appearance without accessing the solver API", () => {
    const snapshots=new SnapshotVisualizationController();
    const identity={runId:"run",stageId:"propagate",datasetId:"array",quantityId:"m",sampleIndex:2,revision:"revision"};
    snapshots.select(identity);
    const key=snapshotVisualizationKey(identity);
    snapshots.updateAppearance(key,{component:"x",palette:"viridis"});
    const playback=new SavedResultsPlaybackController();
    playback.open({itemId:"17",name:"Saved run"});
    const clearOverlay=vi.fn();
    const clearSelection=vi.fn();
    const kernel={selection:{get:()=>({ref:{type:"result-output"}}),clear:clearSelection},snapshotVisualizations:snapshots,savedResultsPlayback:playback,analysisFieldOverlay:{clear:clearOverlay},
      get api():never {throw new Error("Returning to live must not access the solver API.");},
    } as unknown as KernelApi;
    returnResultsToLive(kernel);
    expect(snapshots.getSnapshot().activeKey).toBeNull();
    expect(snapshots.getSnapshot().definitions[key]?.appearance).toMatchObject({component:"x",palette:"viridis"});
    expect(playback.getSnapshot()).toBeNull();
    expect(clearOverlay).toHaveBeenCalledOnce();
    expect(clearSelection).toHaveBeenCalledExactlyOnceWith("workspace");
  });
  it("preserves a live model selection when closing a historical preview", () => {
    const clearSelection = vi.fn();
    const kernel = {
      selection: {get: () => ({ref: {type: "object"}}), clear: clearSelection},
      analysisFieldOverlay: {clear: vi.fn()},
      get api(): never {throw new Error("Returning to live must not access the solver API.");},
    } as unknown as KernelApi;
    returnResultsToLive(kernel);
    expect(clearSelection).not.toHaveBeenCalled();
  });
});
