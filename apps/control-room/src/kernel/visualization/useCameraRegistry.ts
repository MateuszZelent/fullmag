"use client";

import { useCallback, useSyncExternalStore } from "react";

import { useKernel } from "../KernelContext";
import type {
  CameraRegistryController,
  CameraRegistrySnapshot,
} from "./CameraRegistryController";

function useCameraRegistryController(): CameraRegistryController {
  return useKernel().cameraRegistry;
}

export function useCameraRegistryCamera(): CameraRegistrySnapshot["camera"] {
  const cameraRegistry = useCameraRegistryController();
  const subscribe = useCallback(
    (onStoreChange: () => void) => cameraRegistry.subscribe(onStoreChange),
    [cameraRegistry],
  );

  return useSyncExternalStore(
    subscribe,
    () => cameraRegistry.getSnapshot().camera,
    () => cameraRegistry.getSnapshot().camera,
  );
}
