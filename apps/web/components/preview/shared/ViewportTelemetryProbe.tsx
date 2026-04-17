"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";

export default function ViewportTelemetryProbe({
  dpr,
  hidden,
  onStats,
}: {
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
  }) => void;
}) {
  const { gl, size } = useThree();
  const lastReportedAtRef = useRef(0);

  useEffect(() => {
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
      lastFrameAt: typeof performance !== "undefined" ? performance.now() : Date.now(),
    });
  }, [dpr, gl, onStats, size.height, size.width]);

  useFrame(() => {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (hidden || now - lastReportedAtRef.current < 250) {
      return;
    }
    lastReportedAtRef.current = now;
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
    });
  });

  return null;
}
