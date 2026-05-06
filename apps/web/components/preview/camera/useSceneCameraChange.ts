"use client";

import { useEffect, useRef } from "react";

import { cameraOrientationSignature, type SceneCameraHandle } from "./cameraOrientation";

const CONTROLS_ATTACH_POLL_MS = 250;

export interface SceneCameraChangeOptions {
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}

export function useSceneCameraChange(
  sceneRef: React.MutableRefObject<SceneCameraHandle | null> | undefined,
  onChange: () => void,
  options?: SceneCameraChangeOptions,
): void {
  const latestHandlerRef = useRef(onChange);
  const latestInteractionStartRef = useRef(options?.onInteractionStart);
  const latestInteractionEndRef = useRef(options?.onInteractionEnd);

  useEffect(() => {
    latestHandlerRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    latestInteractionStartRef.current = options?.onInteractionStart;
    latestInteractionEndRef.current = options?.onInteractionEnd;
  }, [options?.onInteractionEnd, options?.onInteractionStart]);

  useEffect(() => {
    let pollTimer: number | null = null;
    let disposed = false;
    let attachedControls: SceneCameraHandle["controls"] = null;
    let lastSignature = "";

    const emitChangeFromCamera = () => {
      const camera = sceneRef?.current?.camera ?? null;
      if (camera) {
        lastSignature = cameraOrientationSignature(camera);
      }
      latestHandlerRef.current();
    };

    const handleChange = () => {
      emitChangeFromCamera();
    };

    const handleInteractionStart = () => {
      latestInteractionStartRef.current?.();
    };

    const handleInteractionEnd = () => {
      latestInteractionEndRef.current?.();
    };

    const syncFromCamera = () => {
      const camera = sceneRef?.current?.camera ?? null;
      if (!camera) {
        return;
      }
      const signature = cameraOrientationSignature(camera);
      if (signature !== lastSignature) {
        lastSignature = signature;
        latestHandlerRef.current();
      }
    };

    const attachWhenReady = () => {
      if (disposed) {
        return;
      }

      const controls = sceneRef?.current?.controls ?? null;
      if (controls !== attachedControls) {
        attachedControls?.removeEventListener?.("change", handleChange);
        attachedControls?.removeEventListener?.("start", handleInteractionStart);
        attachedControls?.removeEventListener?.("end", handleInteractionEnd);
        attachedControls = controls;
        attachedControls?.addEventListener?.("change", handleChange);
        attachedControls?.addEventListener?.("start", handleInteractionStart);
        attachedControls?.addEventListener?.("end", handleInteractionEnd);
      }

      syncFromCamera();

      // Only keep polling while controls are not yet attached.
      // Once attached, event listeners handle all subsequent changes.
      if (!attachedControls) {
        pollTimer = window.setTimeout(attachWhenReady, CONTROLS_ATTACH_POLL_MS);
      }
    };

    attachWhenReady();

    return () => {
      disposed = true;
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
        pollTimer = null;
      }
      attachedControls?.removeEventListener?.("change", handleChange);
      attachedControls?.removeEventListener?.("start", handleInteractionStart);
      attachedControls?.removeEventListener?.("end", handleInteractionEnd);
    };
  }, [sceneRef]);
}
