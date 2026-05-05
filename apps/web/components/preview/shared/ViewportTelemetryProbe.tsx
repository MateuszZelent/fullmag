"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";

const ENABLE_VIEWPORT_DEBUG_LOGS =
  typeof process !== "undefined" &&
  process.env.NODE_ENV !== "production" &&
  FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging &&
  FRONTEND_DIAGNOSTIC_FLAGS.interactions.trace;
const lastViewportDebugLogAtByLabel = new Map<string, number>();

export default function ViewportTelemetryProbe({
  label = "viewport",
  dpr,
  hidden,
  onStats,
}: {
  label?: string;
  dpr: number;
  hidden: boolean;
  onStats: (stats: {
    drawCalls: number;
    triangles: number;
    lines: number;
    points: number;
    geometries: number;
    textures: number;
    width: number;
    height: number;
    dpr: number;
    lastFrameAt: number;
    lastFrameAtUnixMs: number;
  }) => void;
}) {
  const { gl, size } = useThree();
  const lastReportedAtRef = useRef(0);

  useEffect(() => {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const wallClockNow = Date.now();
    onStats({
      drawCalls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      lines: gl.info.render.lines,
      points: gl.info.render.points,
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      width: size.width,
      height: size.height,
      dpr,
      lastFrameAt: now,
      lastFrameAtUnixMs: wallClockNow,
    });
  }, [dpr, gl, onStats, size.height, size.width]);

  useFrame(() => {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (hidden || now - lastReportedAtRef.current < 250) {
      return;
    }
    lastReportedAtRef.current = now;
    const wallClockNow = Date.now();
    onStats({
      drawCalls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      lines: gl.info.render.lines,
      points: gl.info.render.points,
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      width: size.width,
      height: size.height,
      dpr,
      lastFrameAt: now,
      lastFrameAtUnixMs: wallClockNow,
    });
    if (
      ENABLE_VIEWPORT_DEBUG_LOGS &&
      wallClockNow - (lastViewportDebugLogAtByLabel.get(label) ?? 0) >= 1000
    ) {
      lastViewportDebugLogAtByLabel.set(label, wallClockNow);
      console.info("[fullmag-debug][viewport] frame rendered", {
        label,
        drawCalls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
        width: size.width,
        height: size.height,
        dpr,
        lastFrameAtUnixMs: wallClockNow,
      });
    }
  });

  return null;
}
