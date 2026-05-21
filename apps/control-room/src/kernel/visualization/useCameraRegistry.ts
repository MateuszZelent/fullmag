"use client";

import { useCallback, useSyncExternalStore } from "react";

import { useKernel } from "../KernelContext";
import type {
  CameraRegistryController,
  CameraRegistrySnapshot,
} from "./CameraRegistryController";

export function useCameraRegistryController(): CameraRegistryController {
  return useKernel().cameraRegistry;
}

export function useCameraRegistrySnapshot(): CameraRegistrySnapshot {
  const cameraRegistry = useCameraRegistryController();
  const subscribe = useCallback(
    (onStoreChange: () => void) => cameraRegistry.subscribe(onStoreChange),
    [cameraRegistry],
  );

  return useSyncExternalStore(
    subscribe,
    () => cameraRegistry.getSnapshot(),
    () => cameraRegistry.getSnapshot(),
  );
}
