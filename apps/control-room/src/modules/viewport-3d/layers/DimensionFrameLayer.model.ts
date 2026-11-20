import { type DimensionFrameAxis, type DimensionFrameCameraOrientation, type DimensionFrameLabel } from "./dimensionFrameModel";
import { type HudTextRun, type HudTextStyle } from "../orientation/hudText.model";
import type { Viewport3DColors } from "../viewport3dTypes";
import { hudAxisColor, resolveHudColors } from "../orientation/hudColors";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { BufferAttribute, BufferGeometry } from "three";

export interface DimensionFrameLayerColors {
  axis: Record<DimensionFrameAxis, string>;
  axisLine: string;
  extent: string;
  grid: string;
  halo: string;
  label: string;
  tick: string;
}

export interface DimensionFrameOrientationStore {
  getSnapshot(): DimensionFrameCameraOrientation;
  setSnapshot(orientation: DimensionFrameCameraOrientation): void;
  subscribe(listener: () => void): () => void;
}

export function createDimensionFrameOrientationStore(
  initial: DimensionFrameCameraOrientation,
): DimensionFrameOrientationStore {
  let snapshot = initial;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => snapshot,
    setSnapshot(orientation) {
      if (snapshot === orientation) return;
      snapshot = orientation;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const DIMENSION_FRAME_TICK_DIRECTION_ATTRIBUTE = "dimensionFrameTickDirection";
export const DIMENSION_FRAME_TICK_ENDPOINT_ATTRIBUTE = "dimensionFrameTickEndpoint";
export const DIMENSION_FRAME_TICK_START_ATTRIBUTE = "dimensionFrameTickStart";

export interface DimensionFrameScreenTickAttributes {
  directions: Float32Array;
  endpoints: Float32Array;
  starts: Float32Array;
}

export function createDimensionFrameScreenTickAttributes(
  positions: ArrayLike<number>,
): DimensionFrameScreenTickAttributes {
  const vertexCount = Math.floor(positions.length / 3);
  const starts = new Float32Array(vertexCount * 3);
  const directions = new Float32Array(vertexCount * 3);
  const endpoints = new Float32Array(vertexCount);

  for (let vertex = 0; vertex + 1 < vertexCount; vertex += 2) {
    const startIndex = vertex * 3;
    const endIndex = (vertex + 1) * 3;
    const startX = positions[startIndex] ?? 0;
    const startY = positions[startIndex + 1] ?? 0;
    const startZ = positions[startIndex + 2] ?? 0;
    const deltaX = (positions[endIndex] ?? startX) - startX;
    const deltaY = (positions[endIndex + 1] ?? startY) - startY;
    const deltaZ = (positions[endIndex + 2] ?? startZ) - startZ;
    const length = Math.hypot(deltaX, deltaY, deltaZ);
    const directionX = length > 0 ? deltaX / length : 0;
    const directionY = length > 0 ? deltaY / length : 0;
    const directionZ = length > 0 ? deltaZ / length : 0;

    for (const index of [startIndex, endIndex]) {
      starts[index] = startX;
      starts[index + 1] = startY;
      starts[index + 2] = startZ;
      directions[index] = directionX;
      directions[index + 1] = directionY;
      directions[index + 2] = directionZ;
    }
    endpoints[vertex + 1] = 1;
  }

  return { directions, endpoints, starts };
}

const TICK_LABEL_FONT_PX = 11;

const TITLE_LABEL_FONT_PX = 12;

/** Minimum on-screen spacing between neighbouring tick numbers. */
const TICK_LABEL_MIN_SPACING_PX = 34;

export function createDimensionFrameLineGeometry(
  positions: Float32Array,
  screenSpaceTicks = false,
): BufferGeometry | null {
  if (positions.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  if (screenSpaceTicks) {
    // The renderer releases these buffers from geometry.attributes on dispose.
    const { directions, endpoints, starts } = createDimensionFrameScreenTickAttributes(positions);
    geometry.setAttribute(DIMENSION_FRAME_TICK_DIRECTION_ATTRIBUTE, new BufferAttribute(directions, 3));
    geometry.setAttribute(DIMENSION_FRAME_TICK_ENDPOINT_ATTRIBUTE, new BufferAttribute(endpoints, 1));
    geometry.setAttribute(DIMENSION_FRAME_TICK_START_ATTRIBUTE, new BufferAttribute(starts, 3));
  }
  geometry.computeBoundingSphere();
  return geometry;
}

export function trackDimensionFrameGeometry(
  tracker: Viewport3DResourceTracker,
  geometry: BufferGeometry,
): BufferGeometry {
  return tracker.track("geometry", geometry);
}

export function releaseDimensionFrameGeometry(
  tracker: Viewport3DResourceTracker,
  geometry: BufferGeometry | null,
): void {
  tracker.release("geometry", geometry);
}

export function resolveDimensionFrameLayerColors(
  colors: Viewport3DColors,
): DimensionFrameLayerColors {
  const hud = resolveHudColors(colors);
  return {
    axis: {
      x: hudAxisColor(hud, "x"),
      y: hudAxisColor(hud, "y"),
      z: hudAxisColor(hud, "z"),
    },
    axisLine: hud.label,
    extent: hud.label,
    grid: hud.grid,
    halo: hud.halo,
    label: hud.label,
    tick: hud.tick,
  };
}

/** Text runs for one frame label: numbers, "x (nm)" titles and "Lx = 240 nm". */
export function dimensionFrameLabelRuns(
  label: DimensionFrameLabel,
  colors: DimensionFrameLayerColors,
): { runs: HudTextRun[]; style: HudTextStyle } {
  const axisColor = colors.axis[label.axis];
  if (label.kind === "tick") {
    return {
      runs: [{ color: colors.label, text: label.text, weight: 700 }],
      style: { font: "mono", fontPx: TICK_LABEL_FONT_PX, halo: colors.halo },
    };
  }
  if (label.kind === "title") {
    return {
      runs: [
        { color: axisColor, italic: true, size: 1.15, text: label.text, weight: 800 },
        { color: colors.label, text: ` (${label.unitLabel ?? ""})`, weight: 600 },
      ],
      style: { font: "ui", fontPx: TITLE_LABEL_FONT_PX, halo: colors.halo },
    };
  }
  return {
    runs: [
      { color: axisColor, italic: true, text: "L", weight: 800 },
      {
        color: axisColor,
        italic: true,
        shiftPx: 3,
        size: 0.72,
        text: label.axis,
        weight: 800,
      },
      {
        color: colors.label,
        text: ` = ${label.text} ${label.unitLabel ?? ""}`,
        weight: 700,
      },
    ],
    style: { font: "mono", fontPx: TICK_LABEL_FONT_PX, halo: colors.halo },
  };
}

/** Shows every 1st, 2nd or 5th number so neighbours stay legible. */
export function tickThinningForSpacing(spacingPx: number, previous?: number): number {
  if (previous === undefined) {
    if (spacingPx >= TICK_LABEL_MIN_SPACING_PX) return 1;
    if (spacingPx >= TICK_LABEL_MIN_SPACING_PX / 2) return 2;
    return 5;
  }
  if (previous === 1) {
    if (spacingPx < 15) return 5;
    return spacingPx < TICK_LABEL_MIN_SPACING_PX - 4 ? 2 : 1;
  }
  if (previous === 2) {
    if (spacingPx >= TICK_LABEL_MIN_SPACING_PX + 5) return 1;
    return spacingPx < 15 ? 5 : 2;
  }
  if (spacingPx >= TICK_LABEL_MIN_SPACING_PX + 5) return 1;
  return spacingPx >= TICK_LABEL_MIN_SPACING_PX / 2 + 3 ? 2 : 5;
}
