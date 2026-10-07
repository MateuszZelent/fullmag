"use client";

import { useFrame } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, memo } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  Vector3,
  type Camera,
  type Sprite,
} from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import type {
  Viewport3DCameraProjection,
  Viewport3DCameraState,
} from "../viewport3dStore";
import type { Viewport3DColors } from "../viewport3dTypes";
import { hudAxisColor, resolveHudColors } from "../orientation/hudColors";
import {
  useHudTextTexture,
  type HudTextRun,
  type HudTextStyle,
} from "../orientation/hudText";
import {
  buildDimensionFrameModel,
  type DimensionFrameAnnotation,
  type DimensionFrameAxis,
  type DimensionFrameDensity,
  type DimensionFrameLabel,
  type DimensionFrameMode,
  type DimensionFrameModel,
  type DimensionFrameUnitMode,
} from "./dimensionFrameModel";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";

interface DimensionFrameLayerProps {
  annotation?: DimensionFrameAnnotation;
  bounds: Viewport3DBounds | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraState: Viewport3DCameraState;
  colors: Viewport3DColors;
  density: DimensionFrameDensity;
  labelsVisible: boolean;
  majorLinesVisible: boolean;
  materialProfile: Viewport3DMaterialProfile;
  mode: DimensionFrameMode;
  minorLinesVisible: boolean;
  tracker: Viewport3DResourceTracker;
  unitMode: DimensionFrameUnitMode;
}

export interface DimensionFrameLayerColors {
  axis: Record<DimensionFrameAxis, string>;
  extent: string;
  grid: string;
  halo: string;
  label: string;
  tick: string;
}

type TickSpacingProbes = Partial<
  Record<DimensionFrameAxis, [DimensionFrameLabel, DimensionFrameLabel]>
>;

const DIMENSION_FRAME_RENDER_ORDER = 4;
const TICK_LABEL_FONT_PX = 11;
const TITLE_LABEL_FONT_PX = 12;
/** Below this on-screen frame diagonal the labels would only pile up. */
const MIN_LABELLED_FRAME_PX = 90;
/** Minimum on-screen spacing between neighbouring tick numbers. */
const TICK_LABEL_MIN_SPACING_PX = 34;
/** Below this projected length the outward direction is seen end-on. */
const DEGENERATE_OUTWARD = 0.2;
const ANCHOR_THRESHOLD = 0.35;

export const DimensionFrameLayer = memo(function DimensionFrameLayer({
  annotation = "ticks",
  bounds,
  cameraProjection,
  cameraState,
  colors,
  density,
  labelsVisible,
  majorLinesVisible,
  materialProfile,
  mode,
  minorLinesVisible,
  tracker,
  unitMode,
}: DimensionFrameLayerProps) {
  const invalidate = useBatchedInvalidate("resize");
  const layerColors = useMemo(
    () => resolveDimensionFrameLayerColors(colors),
    [colors],
  );
  const model = useMemo(
    () =>
      buildDimensionFrameModel({
        annotation,
        bounds,
        cameraProjection,
        cameraState,
        density,
        labelsVisible,
        mode,
        unitMode,
      }),
    [
      annotation,
      bounds,
      cameraProjection,
      cameraState,
      density,
      labelsVisible,
      mode,
      unitMode,
    ],
  );
  const minorGeometry = useTrackedLineGeometry(
    tracker,
    minorLinesVisible ? model.minorLines : null,
  );
  const majorGeometry = useTrackedLineGeometry(
    tracker,
    majorLinesVisible ? model.majorLines : null,
  );
  const majorTickGeometry = useTrackedLineGeometry(tracker, model.majorTickLines);
  const minorTickGeometry = useTrackedLineGeometry(tracker, model.minorTickLines);
  const extentGeometry = useTrackedLineGeometry(tracker, model.extentLines);

  useEffect(() => {
    tracker.recordDirtyFrame("dimension-frame");
    invalidate();
  }, [invalidate, model.signature, tracker]);

  if (mode === "off") {
    return null;
  }

  const frame = materialProfile.dimensionFrame;
  return (
    <group renderOrder={DIMENSION_FRAME_RENDER_ORDER}>
      <FrameLines
        color={layerColors.grid}
        geometry={minorGeometry}
        opacity={frame.minorOpacity}
        renderOrder={DIMENSION_FRAME_RENDER_ORDER}
      />
      <FrameLines
        color={layerColors.grid}
        geometry={majorGeometry}
        opacity={frame.majorOpacity}
        renderOrder={DIMENSION_FRAME_RENDER_ORDER + 1}
      />
      <FrameLines
        color={layerColors.tick}
        geometry={minorTickGeometry}
        opacity={frame.tickOpacity}
        renderOrder={DIMENSION_FRAME_RENDER_ORDER + 2}
      />
      <FrameLines
        color={layerColors.tick}
        geometry={majorTickGeometry}
        opacity={frame.labelOpacity}
        renderOrder={DIMENSION_FRAME_RENDER_ORDER + 2}
      />
      <FrameLines
        color={layerColors.extent}
        geometry={extentGeometry}
        opacity={frame.labelOpacity}
        renderOrder={DIMENSION_FRAME_RENDER_ORDER + 2}
      />
      {model.labels.length > 0 ? (
        <DimensionFrameLabels
          colors={layerColors}
          extent={model.extent}
          labels={model.labels}
          opacity={frame.labelOpacity}
        />
      ) : null}
    </group>
  );
});

function FrameLines({
  color,
  geometry,
  opacity,
  renderOrder,
}: {
  color: string;
  geometry: BufferGeometry | null;
  opacity: number;
  renderOrder: number;
}) {
  if (!geometry) return null;
  return (
    <lineSegments geometry={geometry} renderOrder={renderOrder}>
      <lineBasicMaterial
        color={color}
        depthTest
        depthWrite={false}
        opacity={opacity}
        toneMapped={false}
        transparent
      />
    </lineSegments>
  );
}

function useTrackedLineGeometry(
  tracker: Viewport3DResourceTracker,
  positions: Float32Array | null,
): BufferGeometry | null {
  const geometry = useMemo(
    () => (positions ? createDimensionFrameLineGeometry(positions) : null),
    [positions],
  );
  useEffect(() => {
    if (!geometry) return undefined;
    trackDimensionFrameGeometry(tracker, geometry);
    return () => releaseDimensionFrameGeometry(tracker, geometry);
  }, [geometry, tracker]);
  return geometry;
}

export function createDimensionFrameLineGeometry(
  positions: Float32Array,
): BufferGeometry | null {
  if (positions.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
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
      runs: [{ color: colors.tick, text: label.text }],
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

interface LabelFrameState {
  forward: Vector3;
  thinning: Record<DimensionFrameAxis, number>;
  probeA: Vector3;
  probeB: Vector3;
  right: Vector3;
  up: Vector3;
  world: Vector3;
}

/**
 * Labels keep a constant pixel size and sit `pixelOffset` px outside the
 * frame. Placement is recomputed every rendered frame, so it follows the
 * camera during an orbit without rebuilding the model.
 */
function DimensionFrameLabels({
  colors,
  extent,
  labels,
  opacity,
}: {
  colors: DimensionFrameLayerColors;
  extent: DimensionFrameModel["extent"];
  labels: DimensionFrameLabel[];
  opacity: number;
}) {
  const spritesRef = useRef(new Map<string, Sprite>());
  const frameState = useMemo<LabelFrameState>(
    () => ({
      forward: new Vector3(),
      thinning: { x: 1, y: 1, z: 1 },
      probeA: new Vector3(),
      probeB: new Vector3(),
      right: new Vector3(),
      up: new Vector3(),
      world: new Vector3(),
    }),
    [],
  );
  const spacingProbes = useMemo(() => tickSpacingProbes(labels), [labels]);
  const register = useCallback((key: string, sprite: Sprite | null) => {
    if (sprite) spritesRef.current.set(key, sprite);
    else spritesRef.current.delete(key);
  }, []);

  useFrame(({ camera, size }) => {
    const { forward, right, up, world } = frameState;
    camera.updateMatrixWorld();
    right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    forward.setFromMatrixColumn(camera.matrixWorld, 2).normalize().negate();
    frameState.probeA.set(...extent[0]).project(camera);
    frameState.probeB.set(...extent[1]).project(camera);
    const framePx = Math.hypot(
      ((frameState.probeA.x - frameState.probeB.x) * size.width) / 2,
      ((frameState.probeA.y - frameState.probeB.y) * size.height) / 2,
    );
    const legible = framePx >= MIN_LABELLED_FRAME_PX;
    const thinning = resolveTickThinning(spacingProbes, camera, size, frameState);

    for (const label of labels) {
      const sprite = spritesRef.current.get(label.key);
      if (!sprite) continue;
      sprite.visible = legible;
      if (!legible) continue;
      if (label.kind === "tick" && label.tickIndex !== undefined) {
        sprite.visible = label.tickIndex % thinning[label.axis] === 0;
        if (!sprite.visible) continue;
      }
      world.set(label.outward[0], label.outward[1], label.outward[2]);
      let dx = world.dot(right);
      let dy = world.dot(up);
      const length = Math.hypot(dx, dy);
      if (length < DEGENERATE_OUTWARD) {
        dx = 0;
        dy = -1;
      } else {
        dx /= length;
        dy /= length;
      }
      sprite.center.set(anchorFor(dx), anchorFor(dy));
      world.set(label.position[0], label.position[1], label.position[2]);
      const worldPerPixel = worldPerPixelAt(camera, world, forward, size.height);
      const offset = label.pixelOffset * worldPerPixel;
      sprite.position
        .copy(world)
        .addScaledVector(right, dx * offset)
        .addScaledVector(up, dy * offset);
      const pixelSize = sprite.userData.pixelSize as [number, number] | undefined;
      if (pixelSize) {
        sprite.scale.set(
          pixelSize[0] * worldPerPixel,
          pixelSize[1] * worldPerPixel,
          1,
        );
      }
    }
  });

  return (
    <>
      {labels.map((label) => (
        <DimensionFrameLabelSprite
          key={label.key}
          colors={colors}
          label={label}
          opacity={opacity}
          register={register}
        />
      ))}
    </>
  );
}

/** Sprite.center: text grows away from the frame along the outward direction. */
function anchorFor(component: number): number {
  if (component > ANCHOR_THRESHOLD) return 0;
  if (component < -ANCHOR_THRESHOLD) return 1;
  return 0.5;
}

function DimensionFrameLabelSprite({
  colors,
  label,
  opacity,
  register,
}: {
  colors: DimensionFrameLayerColors;
  label: DimensionFrameLabel;
  opacity: number;
  register: (key: string, sprite: Sprite | null) => void;
}) {
  const { runs, style } = useMemo(
    () => dimensionFrameLabelRuns(label, colors),
    [colors, label],
  );
  const { heightPx, texture, widthPx } = useHudTextTexture(runs, style);
  const key = label.key;
  const ref = useCallback(
    (sprite: Sprite | null) => register(key, sprite),
    [key, register],
  );
  return (
    <sprite
      ref={ref}
      position={label.position}
      renderOrder={DIMENSION_FRAME_RENDER_ORDER + 3}
      // The real size is applied per frame from the camera.
      scale={[1e-12, 1e-12, 1]}
      userData={{ pixelSize: [widthPx, heightPx] }}
    >
      <spriteMaterial
        depthTest={false}
        depthWrite={false}
        map={texture}
        opacity={opacity}
        toneMapped={false}
        transparent
      />
    </sprite>
  );
}

function tickSpacingProbes(labels: DimensionFrameLabel[]): TickSpacingProbes {
  const probes: TickSpacingProbes = {};
  const byAxis = new Map<DimensionFrameAxis, Map<number, DimensionFrameLabel>>();
  for (const label of labels) {
    if (label.kind !== "tick" || label.tickIndex === undefined) continue;
    const axisLabels = byAxis.get(label.axis) ?? new Map<number, DimensionFrameLabel>();
    axisLabels.set(label.tickIndex, label);
    byAxis.set(label.axis, axisLabels);
  }
  for (const [axis, axisLabels] of byAxis) {
    for (const [index, label] of axisLabels) {
      const next = axisLabels.get(index + 1);
      if (next) {
        probes[axis] = [label, next];
        break;
      }
    }
  }
  return probes;
}

/** Shows every 1st, 2nd or 5th number so neighbours stay legible. */
export function tickThinningForSpacing(spacingPx: number): number {
  if (spacingPx >= TICK_LABEL_MIN_SPACING_PX) return 1;
  if (spacingPx >= TICK_LABEL_MIN_SPACING_PX / 2) return 2;
  return 5;
}

const FRAME_AXES: readonly DimensionFrameAxis[] = ["x", "y", "z"];

function resolveTickThinning(
  probes: TickSpacingProbes,
  camera: Camera,
  size: { height: number; width: number },
  state: LabelFrameState,
): Record<DimensionFrameAxis, number> {
  const thinning = state.thinning;
  for (const axis of FRAME_AXES) {
    thinning[axis] = 1;
    const probe = probes[axis];
    if (!probe) continue;
    state.probeA.set(...probe[0].position).project(camera);
    state.probeB.set(...probe[1].position).project(camera);
    thinning[axis] = tickThinningForSpacing(
      Math.hypot(
        ((state.probeA.x - state.probeB.x) * size.width) / 2,
        ((state.probeA.y - state.probeB.y) * size.height) / 2,
      ),
    );
  }
  return thinning;
}

function worldPerPixelAt(
  camera: Camera,
  point: Vector3,
  forward: Vector3,
  viewportHeight: number,
): number {
  const height = Math.max(viewportHeight, 1);
  if ("isOrthographicCamera" in camera && camera.isOrthographicCamera) {
    const orthographic = camera as unknown as {
      bottom: number;
      top: number;
      zoom: number;
    };
    return (
      Math.abs(orthographic.top - orthographic.bottom) /
      (orthographic.zoom || 1) /
      height
    );
  }
  const fov = Number((camera as { fov?: unknown }).fov ?? 42);
  const distance = Math.max(
    (point.x - camera.position.x) * forward.x +
      (point.y - camera.position.y) * forward.y +
      (point.z - camera.position.z) * forward.z,
    1e-12,
  );
  return (2 * Math.tan((fov * Math.PI) / 360) * distance) / height;
}
