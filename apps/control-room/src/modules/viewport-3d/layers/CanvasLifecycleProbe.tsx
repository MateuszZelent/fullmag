"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";

import type { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";

export function CanvasLifecycleProbe({
  diagnostics,
  tracker,
}: {
  diagnostics: RequestDiagnosticsController;
  tracker: Viewport3DResourceTracker;
}) {
  const { gl, invalidate } = useThree();
  const frameWindowRef = useRef({
    frames: 0,
    startedAtMs: 0,
  });

  useEffect(() => {
    const canvas = gl.domElement;
    const onLost = (event: Event) => {
      event.preventDefault();
      tracker.recordContextLost();
    };
    const onRestored = () => {
      tracker.recordContextRestored();
      tracker.recordDirtyFrame("context-restored");
      invalidate();
    };

    tracker.recordDirtyFrame("canvas-mounted");
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    };
  }, [gl, invalidate, tracker]);

  useFrame(() => {
    const now = performance.now();
    const window = frameWindowRef.current;
    if (window.startedAtMs === 0) {
      window.startedAtMs = now;
    }
    window.frames += 1;

    const elapsedMs = now - window.startedAtMs;
    if (elapsedMs < 1_000) return;

    const fps = (window.frames / elapsedMs) * 1_000;
    const dirtyReasons = formatDirtyReasonCounts(
      tracker.consumeDirtyReasonCounts(),
    );
    diagnostics.record({
      byteLength: null,
      channel: "performance",
      contentType: null,
      detail: `frames=${window.frames};fps=${fps.toFixed(1)};windowMs=${elapsedMs.toFixed(0)};dirty=${dirtyReasons}`,
      direction: "rx",
      durationMs: elapsedMs,
      messageType: "viewport-frame-window",
      method: "SAMPLE",
      outcome: "ok",
      path: "fullmag.viewport3d.frame-window",
      requestId: "viewport3d-frame-window",
      status: null,
    });

    frameWindowRef.current = {
      frames: 0,
      startedAtMs: now,
    };
  });

  return null;
}

function formatDirtyReasonCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1]);
  if (entries.length === 0) return "none";
  return entries.map(([reason, count]) => `${reason}:${count}`).join(",");
}
