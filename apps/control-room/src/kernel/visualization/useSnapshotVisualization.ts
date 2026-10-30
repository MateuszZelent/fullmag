"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useKernel } from "../KernelContext";
import type { SnapshotVisualizationState } from "./SnapshotVisualizationController";

const EMPTY: SnapshotVisualizationState = Object.freeze({activeKey:null, definitions:Object.freeze({})});
const serverSnapshot = () => EMPTY;

export function useSnapshotVisualization() {
  const controller=useKernel().snapshotVisualizations;
  const subscribe=useCallback((listener:()=>void)=>controller?.subscribe(listener) ?? (()=>undefined),[controller]);
  const getSnapshot=useCallback(()=>controller?.getSnapshot() ?? EMPTY,[controller]);
  return useSyncExternalStore(subscribe,getSnapshot,serverSnapshot);
}
