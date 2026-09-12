"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { incrementFrontendAuditCounter } from "@/lib/debug/frontendAudit";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { writeFrontendDiagnosticConsole } from "@/lib/debug/frontendConsoleDebug";

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
  const lastStatsRef = useRef<any>(null);

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
    const wallClockNow = Date.now();
    const stats = {
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
    };
    const prev = lastStatsRef.current;
    if (
      !prev ||
      prev.drawCalls !== stats.drawCalls ||
      prev.triangles !== stats.triangles ||
      prev.geometries !== stats.geometries ||
      prev.textures !== stats.textures ||
      prev.width !== stats.width ||
      prev.height !== stats.height ||
      prev.dpr !== stats.dpr
    ) {
      lastReportedAtRef.current = now;
      lastStatsRef.current = stats;
      onStats(stats);
    }
    if (
      ENABLE_VIEWPORT_DEBUG_LOGS &&
      wallClockNow - (lastViewportDebugLogAtByLabel.get(label) ?? 0) >= 1000
    ) {
      lastViewportDebugLogAtByLabel.set(label, wallClockNow);
      writeFrontendDiagnosticConsole("info", "[fullmag-debug][viewport] frame rendered", {
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
