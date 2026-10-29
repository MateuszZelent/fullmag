import type {KernelApi} from "../types";
import {observationSourceWorkspaceStore} from "../workspace/observationSourceWorkspace";

/** Switch render sources only; never starts, resumes or mutates a simulation. */
export function returnResultsToLive(kernel:KernelApi):void {
  const selection = kernel.selection.get();
  const wasSavedPlayback = kernel.savedResultsPlayback?.getSnapshot() != null;
  kernel.snapshotVisualizations?.returnToLive();
  kernel.savedResultsPlayback?.close();
  kernel.analysisFieldOverlay.clear();
  observationSourceWorkspaceStore.clear();
  // A historical Inspector must not remain attached to the live viewport.
  // Preserve a live model selection made while the preview was open.
  if (selection.ref?.type === "result-output" ||
      (wasSavedPlayback && selection.ref?.type === "materialized-dataset")) {
    kernel.selection.clear("workspace");
  }
}
