"use client";
import { useCallback } from "react";
import { useKernel } from "../KernelContext";
import type { SavedPlaybackResource } from "../api/savedResultsPlayback";
import { decodeSavedPlaybackFrame, decodeSavedPlaybackGeometry, savedPlaybackNodeCount } from "../api/savedResultsPlayback";
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
    return decodeSavedPlaybackFrame(payload.data, savedPlaybackNodeCount(manifest));
  },[api,itemId,manifest,stageId,frameIndex]);
  // Runtime entries are released when their final observer unmounts; only the selected frame is held.
  return useResource<Float64Array>({
    resourceKey: `workspace:saved-playback:${itemId ?? "none"}:${manifest?.revision ?? ""}:${stageId ?? ""}:${frameIndex}`,
    enabled: Boolean(itemId && manifest && stageId), abortStaleInflight: true, load, retryPolicy: null,
  });
}


export function useSavedResultsGeometryResource(itemId: string|null, manifest: SavedPlaybackResource|null) {
  const {api}=useKernel();
  const load=useCallback(async ({signal}: {signal:AbortSignal})=>{
    const mesh=manifest?.fem_mesh;
    if(!itemId || !manifest || !mesh) throw new Error("No saved mesh selected.");
    const [topologyBody,supportBody]=await Promise.all([
      api.workspace.playbackGeometry(itemId,manifest.revision,"topology",{signal}),
      api.workspace.playbackGeometry(itemId,manifest.revision,"support",{signal}),
    ]);
    if(topologyBody.status!=="ready" || supportBody.status!=="ready") throw new Error("Saved mesh is unavailable.");
    return decodeSavedPlaybackGeometry(topologyBody.data,supportBody.data,mesh,signal);
  },[api,itemId,manifest]);
  return useResource<Awaited<ReturnType<typeof load>>>({
    resourceKey:`workspace:saved-playback-geometry:${itemId ?? "none"}:${manifest?.revision ?? ""}`,
    enabled:Boolean(itemId && manifest?.fem_mesh),abortStaleInflight:true,load,retryPolicy:null,
  });
}
