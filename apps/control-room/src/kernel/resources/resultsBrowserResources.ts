"use client";

import {decodeSavedPlaybackGeometry} from "../api/savedResultsPlayback";
import {useCallback,useEffect} from "react";
import {useKernel} from "../KernelContext";
import {decodeResultValues,type ResultsSource,type ResultsArray} from "../api/resultsBrowser";
import {useResource} from "./useResource";
import {useSessionScopedResourceKey} from "./useSessionScopedResourceKey";

export function resultsSourceKey(source:ResultsSource):string {
  return source.kind==="current"?"current":`workspace:${source.itemId}`;
}
function useResultsKey(key:string,source:ResultsSource) {
  const scoped=useSessionScopedResourceKey(key);
  return {resourceKey:source.kind==="current"?scoped.resourceKey:key,enabled:source.kind!=="current"||scoped.sessionIdentity!==null};
}

export function useResultsCatalogResource(source:ResultsSource,cursor:string|null,enabled=true,watch=false) {
  const {api}=useKernel();
  const sourceKey=resultsSourceKey(source);
  const scope=useResultsKey(`results:${sourceKey}:catalog:${cursor ?? "first"}`,source);
  const load=useCallback(({signal,sessionScopeKey}:{signal:AbortSignal;sessionScopeKey?:string})=>api.results.catalog(source,cursor,{signal,sessionScopeKey}),[api,source,cursor]);
  const resource=useResource({resourceKey:scope.resourceKey,enabled:enabled&&scope.enabled,load,abortStaleInflight:true,notifyOnError:false,retryPolicy:null,resolveRevision:data=>data.revision});
  const refresh=resource.refetch;
  // Monitor only metadata while the Results browser is visible. No frame polling.
  useEffect(()=>{
    if(!enabled||!watch||!scope.enabled)return;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const schedule=()=>{
      if(timer!==undefined)clearTimeout(timer);
      if(document.visibilityState!=="hidden" && resource.status!=="loading")timer=setTimeout(refresh,5000);
    };
    schedule();
    document.addEventListener("visibilitychange",schedule);
    return ()=>{if(timer!==undefined)clearTimeout(timer);document.removeEventListener("visibilitychange",schedule);};
  },[enabled,watch,scope.enabled,resource.status,resource.revision,refresh]);
  return resource;
}

export function useResultsArrayResource(source:ResultsSource,arrayId:string|null,revision:string|null) {
  const {api}=useKernel();
  const scope=useResultsKey(`results:${resultsSourceKey(source)}:array:${arrayId ?? "none"}:${revision ?? "none"}`,source);
  const load=useCallback(({signal,sessionScopeKey}:{signal:AbortSignal;sessionScopeKey?:string})=>{
    if(!arrayId||!revision)throw new Error("No saved array selected.");
    return api.results.array(source,arrayId,revision,{signal,sessionScopeKey});
  },[api,source,arrayId,revision]);
  return useResource({resourceKey:scope.resourceKey,enabled:scope.enabled&&Boolean(arrayId&&revision),load,abortStaleInflight:true,notifyOnError:false,retryPolicy:null,resolveRevision:data=>data.revision});
}

export function useResultsSampleResource(source:ResultsSource,array:ResultsArray|null,sampleIndex:number) {
  const {api}=useKernel();
  const scope=useResultsKey(`results:${resultsSourceKey(source)}:sample:${array?.id ?? "none"}:${array?.revision ?? "none"}:${sampleIndex}`,source);
  const load=useCallback(async ({signal,sessionScopeKey}:{signal:AbortSignal;sessionScopeKey?:string})=>{
    if(!array||!array.can_read_values)throw new Error("Saved array values are unavailable.");
    const payload=await api.results.sample(source,array.id,sampleIndex,array.revision,{signal,sessionScopeKey});
    if(payload.status!=="ready")throw new Error("Saved sample has not been published.");
    return decodeResultValues(payload.data,array.shape.slice(1).reduce((a,b)=>a*b,1));
  },[api,source,array,sampleIndex]);
  return useResource<Float64Array>({resourceKey:scope.resourceKey,enabled:scope.enabled&&Boolean(array?.can_read_values)&&sampleIndex>=0&&sampleIndex<(array?.sample_count ?? 0),load,abortStaleInflight:true,notifyOnError:false,retryPolicy:null});
}

export function useResultsFilePreviewResource(source:ResultsSource,entryId:string|null,revision:string|null) {
  const {api}=useKernel();
  const scope=useResultsKey(`results:${resultsSourceKey(source)}:preview:${entryId ?? "none"}:${revision ?? "none"}`,source);
  const load=useCallback(({signal,sessionScopeKey}:{signal:AbortSignal;sessionScopeKey?:string})=>{
    if(!entryId||!revision)throw new Error("No output file selected.");
    return api.results.preview(source,entryId,revision,{signal,sessionScopeKey});
  },[api,source,entryId,revision]);
  return useResource({resourceKey:scope.resourceKey,enabled:scope.enabled&&Boolean(entryId&&revision),load,abortStaleInflight:true,notifyOnError:false,retryPolicy:null,resolveRevision:data=>data.revision});
}

/** Mesh and support are pinned to the selected exported array, including current FEM runs. */
export function useResultsGeometryResource(source:ResultsSource,array:ResultsArray|null) {
  const {api}=useKernel();
  const scope=useResultsKey(`results:${resultsSourceKey(source)}:geometry:${array?.id ?? "none"}:${array?.revision ?? "none"}`,source);
  const mesh=array?.geometry?.kind==="fem_p1" ? array.geometry.fem_mesh : null;
  const arrayId=array?.id ?? null,revision=array?.revision ?? null;
  const load=useCallback(async ({signal,sessionScopeKey}:{signal:AbortSignal;sessionScopeKey?:string})=>{
    if(!arrayId||!revision||!mesh)throw new Error("Saved FEM geometry mapping is unavailable.");
    const [topology,support]=await Promise.all([
      api.results.geometry(source,arrayId,revision,"topology",{signal,sessionScopeKey}),
      api.results.geometry(source,arrayId,revision,"support",{signal,sessionScopeKey}),
    ]);
    if(topology.status!=="ready"||support.status!=="ready")throw new Error("Saved FEM geometry is unavailable.");
    return decodeSavedPlaybackGeometry(topology.data,support.data,mesh,signal);
  },[api,source,arrayId,revision,mesh]);
  return useResource<Awaited<ReturnType<typeof load>>>({resourceKey:scope.resourceKey,enabled:scope.enabled&&Boolean(mesh&&array?.can_visualize_3d),load,abortStaleInflight:true,notifyOnError:false,retryPolicy:null});
}
