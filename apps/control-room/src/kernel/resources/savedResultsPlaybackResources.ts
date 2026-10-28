"use client";
import { useCallback } from "react";
import { useKernel } from "../KernelContext";
import type { SavedPlaybackResource } from "../api/savedResultsPlayback";
import { decodeSavedPlaybackFrame } from "../api/savedResultsPlayback";
import { useResource } from "./useResource";

export function useSavedResultsManifestResource(itemId: string | null) {
  const { api } = useKernel();
  const load = useCallback(({signal}: {signal: AbortSignal}) => {
    if (!itemId) throw new Error("No saved folder selected.");
    return api.workspace.playback(itemId, {signal});
  },[api,itemId]);
  return useResource<SavedPlaybackResource>({
    resourceKey: `workspace:saved-playback:${itemId ?? "none"}`,
    enabled: itemId !== null, load, retryPolicy: null,
    resolveRevision: resource => resource.revision,
  });
}

export function useSavedResultsFrameResource(itemId: string | null,
  manifest: SavedPlaybackResource | null, stageId: string | null, frameIndex: number) {
  const { api } = useKernel();
  const load = useCallback(async ({signal}: {signal: AbortSignal}) => {
    if (!itemId || !manifest || !stageId) throw new Error("No saved frame selected.");
    const payload = await api.workspace.playbackFrame(itemId, stageId, frameIndex, manifest.revision, {signal});
    if (payload.status !== "ready") throw new Error("Saved frame is unavailable.");
    return decodeSavedPlaybackFrame(payload.data, manifest.grid_cells_xyz.reduce((a,b) => a*b, 1));
  },[api,itemId,manifest,stageId,frameIndex]);
  // Runtime entries are released when their final observer unmounts; only the selected frame is held.
  return useResource<Float64Array>({
    resourceKey: `workspace:saved-playback:${itemId ?? "none"}:${manifest?.revision ?? ""}:${stageId ?? ""}:${frameIndex}`,
    enabled: Boolean(itemId && manifest && stageId), abortStaleInflight: true, load, retryPolicy: null,
  });
}
