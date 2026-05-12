"use client";

import { useMemo } from "react";
import { Text, Line, Billboard } from "@react-three/drei";
import { pickUnitScale } from "../../../lib/units";

/* ── Types ─────────────────────────────────────────────────────────── */

export type AxesProfile = "full" | "compact" | "triad" | "hidden";

interface SceneAxes3DProps {
  /** Physical extent [x, y, z] in metres */
  worldExtent: [number, number, number];
  /** Scene-space center of the geometry bounding box */
  center: [number, number, number];
  /**
   * How many scene units correspond to one metre along each axis.
   * For FDM: sceneScale = grid / worldExtent  (cells per metre)
   * For FEM: usually [1, 1, 1] if mesh is already in metres
   */
  sceneScale: [number, number, number];
  /**
   * Custom axis labels [xLabel, yLabel, zLabel].
   * Defaults to ["x", "y", "z"]. For FDM scene where scene-Y=sim-Z
   * and scene-Z=sim-Y, pass ["x", "z", "y"].
   */
  axisLabels?: [string, string, string];
  /** Toggle visibility */
  visible?: boolean;
  /** Axes display profile. Defaults to "full". */
  profile?: AxesProfile;
}

/* ── SI prefix logic (from shared lib/units.ts) ─────────────── */

function pickUnit(extent: number) {
  return pickUnitScale(extent);
}

function niceTickValues(maxVal: number, maxTicks = 5): number[] {
  if (maxVal <= 0) return [0];
  const raw = maxVal / maxTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step: number;
  if (norm <= 1.5) step = 1 * mag;
  else if (norm <= 3) step = 2 * mag;
  else if (norm <= 7) step = 5 * mag;
  else step = 10 * mag;

  const ticks: number[] = [];
  for (let v = 0; v <= maxVal + step * 0.01; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6);
    if (ticks.length >= maxTicks + 1) break;
  }
  return ticks;
}

function fmtTickLabel(v: number): string {
  if (v === 0) return "0";
  if (Number.isInteger(v)) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(1);
  return v.toPrecision(3);
}

/* ── Colors ─────────────────────────────────────────────────────── */

const AXIS_COLORS = {
  x: "#ef4444", // red
  y: "#22c55e", // green
  z: "#3b82f6", // blue
};

const TICK_COLOR = "#64748b";      // slate-500
const LABEL_COLOR = "#94a3b8";     // slate-400
const UNIT_COLOR = "#cbd5e1";      // slate-300

/* ── Component ─────────────────────────────────────────────────── */

export default function SceneAxes3D({
  worldExtent,
  center,
  sceneScale,
  axisLabels = ["x", "y", "z"],
  visible = true,
  profile = "full",
}: SceneAxes3DProps) {
  const axesData = useMemo(() => {
    if (profile === "hidden" || !visible) return null;
    const [wx, wy, wz] = worldExtent;
    const maxExtent = Math.max(wx, wy, wz);
    if (maxExtent <= 0) return null;

    const { scale, unit } = pickUnit(maxExtent);

    // Scene-space half-extents
    const hx = (wx * sceneScale[0]) / 2;
    const hy = (wy * sceneScale[1]) / 2;
    const hz = (wz * sceneScale[2]) / 2;

    // Scaled extents for labels
    const sx = wx * scale;
    const sy = wy * scale;
    const sz = wz * scale;

    return {
      unit,
      // Scene-space bounding box corners (relative to center)
      min: [-hx, -hy, -hz] as [number, number, number],
      max: [hx, hy, hz] as [number, number, number],
      hx, hy, hz,
      // Scaled extents (for tick label values)
      scaled: [sx, sy, sz] as [number, number, number],
      ticks: {
        x: niceTickValues(sx),
        y: niceTickValues(sy),
        z: niceTickValues(sz),
      },
      sceneScale: sceneScale,
    };
  }, [profile, sceneScale, visible, worldExtent]);

  if (!axesData) return null;

  const { unit, min, max, hx, hy, hz, scaled, ticks } = axesData;
  const [cx, cy, cz] = center;

  // Adaptive font size — purely proportional to scene scale (no absolute minimum)
  const maxScene = Math.max(hx * 2, hy * 2, hz * 2);
  const fontSize = maxScene * 0.035;
  const tickLen = maxScene * 0.015;
  const labelOffset = maxScene * 0.06;

  /* ── Tick marks and labels for each axis ──────────────────────── */
  const xTickElements = ticks.x.map((val) => {
    const frac = scaled[0] > 0 ? val / scaled[0] : 0;
    const sceneX = cx + min[0] + frac * (max[0] - min[0]);
    const sceneY = cy + min[1];
    const sceneZ = cz + min[2];
    return { val, pos: [sceneX, sceneY, sceneZ] as [number, number, number] };
  });

  const yTickElements = ticks.y.map((val) => {
    const frac = scaled[1] > 0 ? val / scaled[1] : 0;
    const sceneX = cx + min[0];
    const sceneY = cy + min[1] + frac * (max[1] - min[1]);
    const sceneZ = cz + min[2];
    return { val, pos: [sceneX, sceneY, sceneZ] as [number, number, number] };
  });

  const zTickElements = ticks.z.map((val) => {
    const frac = scaled[2] > 0 ? val / scaled[2] : 0;
    const sceneX = cx + min[0];
    const sceneY = cy + min[1];
    const sceneZ = cz + min[2] + frac * (max[2] - min[2]);
    return { val, pos: [sceneX, sceneY, sceneZ] as [number, number, number] };
  });

  const showTicks = profile === "full";
  const showLabels = profile === "full" || profile === "compact";
  const showLines = profile !== "triad";

  return (
    <group>

      {/* ── X-axis ticks + labels (along bottom-front edge) ───── */}
      {showTicks && xTickElements.map((tick, i) => (
        <group key={`xtick-${i}`}>
          <Line
            points={[
              [tick.pos[0], tick.pos[1], tick.pos[2]],
              [tick.pos[0], tick.pos[1] - tickLen, tick.pos[2]],
            ]}
            color={TICK_COLOR}
            lineWidth={1}
          />
          <Billboard position={[tick.pos[0], tick.pos[1] - labelOffset, tick.pos[2]]}>
            <Text
              fontSize={fontSize}
              color={LABEL_COLOR}
              anchorX="center"
              anchorY="top"
            >
              {fmtTickLabel(tick.val)}
            </Text>
          </Billboard>
        </group>
      ))}
      {/* X axis unit label centered along axis */}
      {showLabels && (
      <Billboard position={[cx, cy + min[1] - labelOffset * 2.2, cz + min[2]]}>
        <Text
          fontSize={fontSize * 1.2}
          color={UNIT_COLOR}
          anchorX="center"
          anchorY="top"
        >
          {`${axisLabels[0]} (${unit})`}
        </Text>
      </Billboard>
      )}

      {/* ── Y-axis ticks + labels (along left-front edge) ──────── */}
      {showTicks && yTickElements.map((tick, i) => (
        <group key={`ytick-${i}`}>
          <Line
            points={[
              [tick.pos[0], tick.pos[1], tick.pos[2]],
              [tick.pos[0] - tickLen, tick.pos[1], tick.pos[2]],
            ]}
            color={TICK_COLOR}
            lineWidth={1}
          />
          <Billboard position={[tick.pos[0] - labelOffset, tick.pos[1], tick.pos[2]]}>
            <Text
              fontSize={fontSize}
              color={LABEL_COLOR}
              anchorX="right"
              anchorY="middle"
            >
              {fmtTickLabel(tick.val)}
            </Text>
          </Billboard>
        </group>
      ))}
      {/* Y axis unit label centered along axis */}
      {showLabels && (
      <Billboard position={[cx + min[0] - labelOffset * 2.2, cy, cz + min[2]]}>
        <Text
          fontSize={fontSize * 1.2}
          color={UNIT_COLOR}
          anchorX="right"
          anchorY="middle"
        >
          {`${axisLabels[1]} (${unit})`}
        </Text>
      </Billboard>
      )}

      {/* ── Z-axis ticks + labels (along bottom-left edge) ──────── */}
      {showTicks && zTickElements.map((tick, i) => (
        <group key={`ztick-${i}`}>
          <Line
            points={[
              [tick.pos[0], tick.pos[1], tick.pos[2]],
              [tick.pos[0], tick.pos[1] - tickLen, tick.pos[2]],
            ]}
            color={TICK_COLOR}
            lineWidth={1}
          />
          <Billboard position={[tick.pos[0], tick.pos[1] - labelOffset, tick.pos[2]]}>
            <Text
              fontSize={fontSize}
              color={LABEL_COLOR}
              anchorX="center"
              anchorY="top"
            >
              {fmtTickLabel(tick.val)}
            </Text>
          </Billboard>
        </group>
      ))}
      {/* Z axis unit label centered along axis */}
      {showLabels && (
      <Billboard position={[cx + min[0], cy + min[1] - labelOffset * 2.2, cz]}>
        <Text
          fontSize={fontSize * 1.2}
          color={UNIT_COLOR}
          anchorX="center"
          anchorY="top"
        >
          {`${axisLabels[2]} (${unit})`}
        </Text>
      </Billboard>
      )}

      {/* ── Colored axis arrows at origin corner ───────────────── */}
      {showLines && (<>
      <Line
        points={[
          [cx + min[0], cy + min[1], cz + min[2]],
          [cx + max[0], cy + min[1], cz + min[2]],
        ]}
        color={AXIS_COLORS.x}
        lineWidth={1.5}
        transparent
        opacity={0.6}
      />
      <Line
        points={[
          [cx + min[0], cy + min[1], cz + min[2]],
          [cx + min[0], cy + max[1], cz + min[2]],
        ]}
        color={AXIS_COLORS.y}
        lineWidth={1.5}
        transparent
        opacity={0.6}
      />
      <Line
        points={[
          [cx + min[0], cy + min[1], cz + min[2]],
          [cx + min[0], cy + min[1], cz + max[2]],
        ]}
        color={AXIS_COLORS.z}
        lineWidth={1.5}
        transparent
        opacity={0.6}
      />
      </>)}
    </group>
  );
}
