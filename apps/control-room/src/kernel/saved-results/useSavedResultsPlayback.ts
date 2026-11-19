"use client";
import { useSyncExternalStore } from "react";
import { useKernel } from "../KernelContext";
const empty = () => null;
const subscribeNever = () => () => undefined;

export function useSavedResultsPlaybackSelection() {
  const controller = useKernel().savedResultsPlayback;
  return useSyncExternalStore(controller?.subscribe ?? subscribeNever,
    controller?.getSnapshot ?? empty, controller?.getServerSnapshot ?? empty);
}
