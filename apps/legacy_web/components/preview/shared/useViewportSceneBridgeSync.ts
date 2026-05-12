"use client";

import { useEffect, type MutableRefObject } from "react";
import type * as THREE from "three";

export function useViewportSceneBridgeSync({
  bridgeRef,
  controlsRef,
  camera,
  awaitControls,
}: {
  bridgeRef: MutableRefObject<any> | null;
  controlsRef: MutableRefObject<any>;
  camera: THREE.Camera;
  awaitControls: boolean;
}): void {
  useEffect(() => {
    if (!bridgeRef) {
      return;
    }

    let raf = 0;
    let disposed = false;

    const syncBridge = () => {
      if (disposed) {
        return;
      }
      const controls = controlsRef.current ?? null;
      bridgeRef.current = { camera, controls };
      if (awaitControls && !controls) {
        raf = window.requestAnimationFrame(syncBridge);
      }
    };

    syncBridge();

    return () => {
      disposed = true;
      if (raf) {
        window.cancelAnimationFrame(raf);
      }
      bridgeRef.current = null;
    };
  }, [awaitControls, bridgeRef, camera, controlsRef]);
}
