"use client";

import { useEffect, useRef } from "react";

import { cameraOrientationSignature, type SceneCameraHandle } from "./cameraOrientation";

export function useSceneCameraChange(
  sceneRef: React.MutableRefObject<SceneCameraHandle | null> | undefined,
  onChange: () => void,
): void {
  const latestHandlerRef = useRef(onChange);

  useEffect(() => {
    latestHandlerRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let raf = 0;
    let disposed = false;
    let attachedControls: SceneCameraHandle["controls"] = null;
    let lastSignature = "";

    const handleChange = () => {
      latestHandlerRef.current();
    };

    const syncFromCamera = () => {
      const camera = sceneRef?.current?.camera ?? null;
      if (!camera) {
        return;
      }
      const signature = cameraOrientationSignature(camera);
      if (signature !== lastSignature) {
        lastSignature = signature;
        handleChange();
      }
    };

    const attachWhenReady = () => {
      if (disposed) {
        return;
      }

      const controls = sceneRef?.current?.controls ?? null;
      if (controls !== attachedControls) {
        attachedControls?.removeEventListener?.("change", handleChange);
        attachedControls = controls;
        attachedControls?.addEventListener?.("change", handleChange);
      }

      syncFromCamera();

      raf = window.requestAnimationFrame(attachWhenReady);
    };

    attachWhenReady();

    return () => {
      disposed = true;
      if (raf) {
        window.cancelAnimationFrame(raf);
      }
      attachedControls?.removeEventListener?.("change", handleChange);
    };
  }, [sceneRef]);
}
