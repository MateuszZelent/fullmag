"use client";

import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, memo } from "react";
import { BufferAttribute, BufferGeometry, LessEqualDepth, LineBasicMaterial, Vector3, type Camera, type Sprite } from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import type {
  Viewport3DCameraProjection,
  Viewport3DCameraState,
} from "../viewport3dStore";
import type { Viewport3DColors } from "../viewport3dTypes";
import { VIEWPORT_3D_HUD_LAYER } from "../viewport3dHudLayer";

import { useHudTextTexture } from "../orientation/hudText";
import {
  dimensionFrameBoundsFromProjectedCorners,
  resolveDimensionFrameLabelVisibility,
  type DimensionFrameLabelCandidate,
  type DimensionFramePixelRect,
  type DimensionFrameProjectedPoint,
} from "./dimensionFrameLabelLayout";
import { buildDimensionFrameModel, type DimensionFrameAnnotation, type DimensionFrameAxis, type DimensionFrameCameraOrientation, type DimensionFrameDensity, type DimensionFrameLabel, type DimensionFrameMode, type DimensionFrameModel, type DimensionFrameOriginMode, type DimensionFrameUnitMode, resolveDimensionFrameOrientation, resolveDimensionFrameOrientationWithHysteresis } from "./dimensionFrameModel";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import {
  createDimensionFrameLineGeometry,
  createDimensionFrameOrientationStore,
  createDimensionFrameScreenTickAttributes,
  dimensionFrameLabelRuns,
  releaseDimensionFrameGeometry,
  resolveDimensionFrameLayerColors,
  tickThinningForSpacing,
  trackDimensionFrameGeometry,
  type DimensionFrameLayerColors,
} from "./DimensionFrameLayer.model";

interface DimensionFrameLayerProps {
  annotation?: DimensionFrameAnnotation;
  bounds: Viewport3DBounds | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraState: Viewport3DCameraState;
  colors: Viewport3DColors;
  density: DimensionFrameDensity;
  gridOpacity?: number;
  labelsVisible: boolean;
  majorLinesVisible: boolean;
  materialProfile: Viewport3DMaterialProfile;
  mode: DimensionFrameMode;
  minorLinesVisible: boolean;
  originMode?: DimensionFrameOriginMode;
  reservedHudRegions?: readonly DimensionFramePixelRect[];
  tracker: Viewport3DResourceTracker;
  unitMode: DimensionFrameUnitMode;
}

type TickSpacingProbes = Partial<
  Record<DimensionFrameAxis, [DimensionFrameLabel, DimensionFrameLabel]>
>;

interface DimensionFrameCameraFrameState {
  cameraState: Viewport3DCameraState;
  forward: Vector3;
  position: Vector3;
  up: Vector3;
}

const DIMENSION_FRAME_RENDER_ORDER = 4;
/** Below this projected length the outward direction is seen end-on. */
const DEGENERATE_OUTWARD = 0.2;
const ANCHOR_THRESHOLD = 0.35;

function createDimensionFrameCameraFrameState(): DimensionFrameCameraFrameState {
  return {
    cameraState: {
      position: [0, 0, 0],
      target: [0, 0, 1],
      up: [0, 0, 1],
    },
    forward: new Vector3(),
    position: new Vector3(),
    up: new Vector3(),
  };
}

export const DimensionFrameLayer = memo(function DimensionFrameLayer({
  annotation = "ticks",
  bounds,
  cameraProjection,
  cameraState,
  colors,
  density,
  gridOpacity = 1,
  labelsVisible,
  majorLinesVisible,
  materialProfile,
  mode,
  minorLinesVisible,
  originMode = "frame-center",
  reservedHudRegions = [],
  tracker,
  unitMode,
}: DimensionFrameLayerProps) {
  const invalidate = useBatchedInvalidate("resize");
  const layerColors = useMemo(
    () => resolveDimensionFrameLayerColors(colors),
    [colors],
  );
  const [orientationStore] = useState(() =>
    createDimensionFrameOrientationStore(
      resolveDimensionFrameOrientation(bounds, cameraState),
    ),
  );
  const cameraOrientation = useSyncExternalStore(
    orientationStore.subscribe,
    orientationStore.getSnapshot,
    orientationStore.getSnapshot,
  );
  const cameraFrameStateRef = useRef<DimensionFrameCameraFrameState | null>(null);

  useFrame(({ camera }) => {
    if (mode === "off") return;
    const frameState =
      cameraFrameStateRef.current ?? createDimensionFrameCameraFrameState();
    cameraFrameStateRef.current = frameState;
    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(frameState.position);
    camera.getWorldDirection(frameState.forward);
    frameState.up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    frameState.cameraState.position[0] = frameState.position.x;
    frameState.cameraState.position[1] = frameState.position.y;
    frameState.cameraState.position[2] = frameState.position.z;
    frameState.cameraState.target[0] = frameState.position.x + frameState.forward.x;
    frameState.cameraState.target[1] = frameState.position.y + frameState.forward.y;
    frameState.cameraState.target[2] = frameState.position.z + frameState.forward.z;
    frameState.cameraState.up[0] = frameState.up.x;
    frameState.cameraState.up[1] = frameState.up.y;
    frameState.cameraState.up[2] = frameState.up.z;

    const previous = orientationStore.getSnapshot();
    const next = resolveDimensionFrameOrientationWithHysteresis(
      bounds,
      frameState.cameraState,
      previous,
    );
    if (!sameDimensionFrameOrientation(previous, next)) {
      orientationStore.setSnapshot(next);
      invalidate();
    }
  });

  const model = useMemo(
    () =>
      buildDimensionFrameModel({
        annotation,
        bounds,
        cameraOrientation,
        cameraProjection,
        density,
        labelsVisible,
        mode,
        originMode,
        unitMode,
      }),
    [
      annotation,
      bounds,
      cameraProjection,
      density,
      labelsVisible,
      mode,
      originMode,
      unitMode,
      cameraOrientation,
    ],
  );
  const axisPoints = useMemo(() => {
    const points: [number, number, number][] = [];
    for (let i = 0; i < model.axisLines.length; i += 3) {
      points.push([model.axisLines[i], model.axisLines[i + 1], model.axisLines[i + 2]]);
    }
    return points;
  }, [model.axisLines]);
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
  const resolvedGridOpacity = clampGridContrast(gridOpacity);

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
        opacity={frame.minorOpacity * resolvedGridOpacity}
        renderOrder={DIMENSION_FRAME_RENDER_ORDER}
      />
      <FrameLines
        color={layerColors.grid}
        geometry={majorGeometry}
        opacity={frame.majorOpacity * resolvedGridOpacity}
        renderOrder={DIMENSION_FRAME_RENDER_ORDER + 1}
      />
      <FrameLines
        color={layerColors.tick}
        geometry={minorTickGeometry}
        opacity={frame.tickOpacity}
        renderOrder={DIMENSION_FRAME_RENDER_ORDER + 2}
        screenLengthPx={4}
      />
      <FrameLines
        color={layerColors.tick}
        geometry={majorTickGeometry}
        opacity={frame.labelOpacity}
        renderOrder={DIMENSION_FRAME_RENDER_ORDER + 2}
        screenLengthPx={7}
      />
      <FrameLines
        color={layerColors.extent}
        geometry={extentGeometry}
        opacity={frame.labelOpacity}
        renderOrder={DIMENSION_FRAME_RENDER_ORDER + 2}
      />
      {/* Screen-width baselines retain SI endpoints; Drei owns their geometry/material cleanup. */}
      {axisPoints.length > 0 ? (
        <Line
          color={layerColors.axisLine}
          depthFunc={LessEqualDepth}
          depthTest
          depthWrite={false}
          lineWidth={2}
          opacity={frame.labelOpacity}
          points={axisPoints}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
          renderOrder={DIMENSION_FRAME_RENDER_ORDER + 3}
          segments
          toneMapped={false}
          transparent
        />
      ) : null}
      {model.labels.length > 0 ? (
        <DimensionFrameLabels
          colors={layerColors}
          extent={model.extent}
          labels={model.labels}
          opacity={frame.labelOpacity}
          reservedHudRegions={reservedHudRegions}
        />
      ) : null}
    </group>
  );
});

type DimensionFrameTickShader = Parameters<LineBasicMaterial["onBeforeCompile"]>[0];

interface DimensionFrameTickShaderState {
  isOrthographic: number;
  shader: DimensionFrameTickShader | null;
  viewportHeight: number;
}

const DIMENSION_FRAME_TICK_START_ATTRIBUTE = "dimensionFrameTickStart";
const DIMENSION_FRAME_TICK_DIRECTION_ATTRIBUTE = "dimensionFrameTickDirection";
const DIMENSION_FRAME_TICK_ENDPOINT_ATTRIBUTE = "dimensionFrameTickEndpoint";

function FrameLines({
  color,
  geometry,
  opacity,
  renderOrder,
  screenLengthPx,
}: {
  color: string;
  geometry: BufferGeometry | null;
  opacity: number;
  renderOrder: number;
  screenLengthPx?: number;
}) {
  const shaderStateRef = useRef<DimensionFrameTickShaderState>({
    isOrthographic: 1,
    shader: null,
    viewportHeight: 1,
  });
  const tickAttributes = useMemo(() => {
    if (!geometry || screenLengthPx === undefined) return null;
    const positions = geometry.getAttribute("position").array;
    return createDimensionFrameScreenTickAttributes(positions);
  }, [geometry, screenLengthPx]);
  const gpuAttributes = useMemo(() => {
    if (!tickAttributes) return null;
    return {
      direction: new BufferAttribute(tickAttributes.directions, 3),
      endpoint: new BufferAttribute(tickAttributes.endpoints, 1),
      start: new BufferAttribute(tickAttributes.starts, 3),
    };
  }, [tickAttributes]);

  useLayoutEffect(() => {
    if (!geometry || !gpuAttributes) return undefined;
    geometry.setAttribute(DIMENSION_FRAME_TICK_START_ATTRIBUTE, gpuAttributes.start);
    geometry.setAttribute(DIMENSION_FRAME_TICK_DIRECTION_ATTRIBUTE, gpuAttributes.direction);
    geometry.setAttribute(DIMENSION_FRAME_TICK_ENDPOINT_ATTRIBUTE, gpuAttributes.endpoint);
    return () => {
      if (geometry.getAttribute(DIMENSION_FRAME_TICK_START_ATTRIBUTE) === gpuAttributes.start) {
        geometry.deleteAttribute(DIMENSION_FRAME_TICK_START_ATTRIBUTE);
      }
      if (geometry.getAttribute(DIMENSION_FRAME_TICK_DIRECTION_ATTRIBUTE) === gpuAttributes.direction) {
        geometry.deleteAttribute(DIMENSION_FRAME_TICK_DIRECTION_ATTRIBUTE);
      }
      if (geometry.getAttribute(DIMENSION_FRAME_TICK_ENDPOINT_ATTRIBUTE) === gpuAttributes.endpoint) {
        geometry.deleteAttribute(DIMENSION_FRAME_TICK_ENDPOINT_ATTRIBUTE);
      }
    };
  }, [geometry, gpuAttributes]);

  useFrame(({ camera, size }) => {
    if (screenLengthPx === undefined || size.height <= 0) return;
    const state = shaderStateRef.current;
    state.viewportHeight = size.height;
    state.isOrthographic =
      "isOrthographicCamera" in camera && camera.isOrthographicCamera ? 1 : 0;
    const shader = state.shader;
    if (!shader) return;
    const viewportHeight = shader.uniforms.dimensionFrameViewportHeight as
      | { value: number }
      | undefined;
    const isOrthographic = shader.uniforms.dimensionFrameIsOrthographic as
      | { value: number }
      | undefined;
    if (viewportHeight) viewportHeight.value = state.viewportHeight;
    if (isOrthographic) isOrthographic.value = state.isOrthographic;
  });

  const onBeforeCompile = useCallback(
    (shader: DimensionFrameTickShader) => {
      if (screenLengthPx !== undefined) {
        const state = shaderStateRef.current;
        shader.uniforms.dimensionFrameViewportHeight = { value: state.viewportHeight };
        shader.uniforms.dimensionFrameIsOrthographic = { value: state.isOrthographic };
        shader.uniforms.dimensionFramePixelLength = { value: screenLengthPx };
        state.shader = shader;
        shader.vertexShader = shader.vertexShader.replace(
          "#include <common>",
          `#include <common>
attribute vec3 ${DIMENSION_FRAME_TICK_START_ATTRIBUTE};
attribute vec3 ${DIMENSION_FRAME_TICK_DIRECTION_ATTRIBUTE};
attribute float ${DIMENSION_FRAME_TICK_ENDPOINT_ATTRIBUTE};
uniform float dimensionFrameViewportHeight;
uniform float dimensionFrameIsOrthographic;
uniform float dimensionFramePixelLength;`,
        );
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          `vec3 transformed = vec3(position);
vec4 dimensionFrameStartView = modelViewMatrix * vec4(${DIMENSION_FRAME_TICK_START_ATTRIBUTE}, 1.0);
float dimensionFrameDepth = max(-dimensionFrameStartView.z, 1e-12);
float dimensionFrameProjectionScale = max(projectionMatrix[1][1] * dimensionFrameViewportHeight, 1e-12);
float dimensionFrameWorldPerPixel = dimensionFrameIsOrthographic > 0.5
  ? 2.0 / dimensionFrameProjectionScale
  : 2.0 * dimensionFrameDepth / dimensionFrameProjectionScale;
transformed = ${DIMENSION_FRAME_TICK_START_ATTRIBUTE} + ${DIMENSION_FRAME_TICK_DIRECTION_ATTRIBUTE} * dimensionFrameWorldPerPixel * dimensionFramePixelLength * ${DIMENSION_FRAME_TICK_ENDPOINT_ATTRIBUTE};`,
        );
      }
      // Bias only projected depth; measured coordinates and tick values stay unchanged.
      shader.vertexShader = shader.vertexShader.replace(
        "#include <project_vertex>",
        "#include <project_vertex>\ngl_Position.z -= 0.000002 * gl_Position.w;",
      );
    },
    [screenLengthPx],
  );
  const customProgramCacheKey = useCallback(
    () =>
      screenLengthPx === undefined
        ? "dimension-frame-depth-bias-v1"
        : `dimension-frame-screen-tick-gpu-v1-${screenLengthPx}`,
    [screenLengthPx],
  );

  if (!geometry) return null;
  return (
    <lineSegments
      frustumCulled={screenLengthPx === undefined}
      geometry={geometry}
      renderOrder={renderOrder}
    >
      <lineBasicMaterial
        color={color}
        depthTest
        depthWrite={false}
        depthFunc={LessEqualDepth}
        opacity={opacity}
        toneMapped={false}
        transparent
        onBeforeCompile={onBeforeCompile}
        customProgramCacheKey={customProgramCacheKey}
      />
    </lineSegments>
  );
}

function clampGridContrast(value: number): number {
  return Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : 1;
}

function sameDimensionFrameOrientation(
  left: DimensionFrameCameraOrientation,
  right: DimensionFrameCameraOrientation,
): boolean {
  return (
    left.xFacing === right.xFacing &&
    left.yFacing === right.yFacing &&
    left.zCornerX === right.zCornerX &&
    left.zCornerY === right.zCornerY
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

interface LabelFrameState {
  compact: boolean;
  depthPoint: Vector3;
  frameCorners: Vector3[];
  forward: Vector3;
  projected: Vector3;
  projectedFrameCorners: DimensionFrameProjectedPoint[];
  thinning: Record<DimensionFrameAxis, number>;
  probeA: Vector3;
  probeB: Vector3;
  right: Vector3;
  up: Vector3;
  visibleKeys: Set<string>;
  world: Vector3;
}

function createLabelFrameState(): LabelFrameState {
  return {
    compact: false,
    depthPoint: new Vector3(),
    frameCorners: Array.from({ length: 8 }, () => new Vector3()),
    forward: new Vector3(),
    projected: new Vector3(),
    projectedFrameCorners: Array.from({ length: 8 }, () => ({ x: 0, y: 0, z: 2 })),
    thinning: { x: 1, y: 1, z: 1 },
    probeA: new Vector3(),
    probeB: new Vector3(),
    right: new Vector3(),
    up: new Vector3(),
    visibleKeys: new Set<string>(),
    world: new Vector3(),
  };
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
  reservedHudRegions,
}: {
  colors: DimensionFrameLayerColors;
  extent: DimensionFrameModel["extent"];
  labels: DimensionFrameLabel[];
  opacity: number;
  reservedHudRegions: readonly DimensionFramePixelRect[];
}) {
  const spritesRef = useRef<Map<string, Sprite> | null>(null);
  const frameStateRef = useRef<LabelFrameState | null>(null);
  const spacingProbes = useMemo(() => tickSpacingProbes(labels), [labels]);
  const register = useCallback((key: string, sprite: Sprite | null) => {
    const sprites = spritesRef.current ?? new Map<string, Sprite>();
    spritesRef.current = sprites;
    if (sprite) {
      sprite.layers.set(VIEWPORT_3D_HUD_LAYER);
      sprites.set(key, sprite);
    } else {
      sprites.delete(key);
    }
  }, []);

  useFrame(({ camera, size }) => {
    const sprites = spritesRef.current;
    if (!sprites) return;
    const frameState = frameStateRef.current ?? createLabelFrameState();
    frameStateRef.current = frameState;
    const { depthPoint, forward, projected, right, up, world } = frameState;
    camera.updateMatrixWorld();
    right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    forward.setFromMatrixColumn(camera.matrixWorld, 2).normalize().negate();
    const [min, max] = extent;
    for (let index = 0; index < frameState.frameCorners.length; index += 1) {
      const corner = frameState.frameCorners[index];
      const projectedCorner = frameState.projectedFrameCorners[index];
      if (!corner || !projectedCorner) continue;
      corner
        .set(
          index & 1 ? max[0] : min[0],
          index & 2 ? max[1] : min[1],
          index & 4 ? max[2] : min[2],
        )
        .project(camera);
      projectedCorner.x = corner.x;
      projectedCorner.y = corner.y;
      projectedCorner.z = corner.z;
    }
    const frameBounds = dimensionFrameBoundsFromProjectedCorners(
      frameState.projectedFrameCorners,
      size,
    );
    const frameSpan = frameBounds
      ? Math.max(
          frameBounds.right - frameBounds.left,
          frameBounds.bottom - frameBounds.top,
        )
      : 0;
    // The wider exit threshold keeps compact mode stable during slow orbits.
    frameState.compact = frameState.compact
      ? frameSpan < 96
      : frameSpan < 84;
    const thinning = resolveTickThinning(spacingProbes, camera, size, frameState);
    const candidates: DimensionFrameLabelCandidate[] = [];

    for (const label of labels) {
      const sprite = sprites.get(label.key);
      if (!sprite) continue;
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
      if (!pixelSize || size.width <= 0 || size.height <= 0) continue;

      projected.copy(sprite.position).project(camera);
      depthPoint.copy(sprite.position).sub(camera.position);
      const cameraDepth = depthPoint.dot(forward);
      if (
        cameraDepth <= 0 ||
        projected.z < -1 ||
        projected.z > 1 ||
        !Number.isFinite(projected.x) ||
        !Number.isFinite(projected.y)
      ) {
        continue;
      }
      const screenX = ((projected.x + 1) / 2) * size.width;
      const screenY = ((1 - projected.y) / 2) * size.height;
      const anchorX = anchorFor(dx);
      const anchorY = anchorFor(dy);
      const left = screenX - anchorX * pixelSize[0];
      const top = screenY - (1 - anchorY) * pixelSize[1];
      const bounds: DimensionFramePixelRect = {
        bottom: top + pixelSize[1],
        left,
        right: left + pixelSize[0],
        top,
      };
      candidates.push({
        axis: label.axis,
        bounds,
        key: label.key,
        kind: label.kind,
        tickIndex: label.tickIndex,
        tickStride: thinning[label.axis],
      });
    }

    const visibleKeys = resolveDimensionFrameLabelVisibility(
      candidates,
      size,
      frameState.visibleKeys,
      frameState.compact,
      reservedHudRegions,
    );
    for (const [key, sprite] of sprites) {
      // Sprite visibility is a Three.js scene mutation owned by this frame hook.
      // eslint-disable-next-line react-hooks/immutability -- imperative Three.js interop in useFrame
      sprite.visible = visibleKeys.has(key);
    }
    frameState.visibleKeys.clear();
    for (const key of visibleKeys) frameState.visibleKeys.add(key);
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

const FRAME_AXES: readonly DimensionFrameAxis[] = ["x", "y", "z"];

function resolveTickThinning(
  probes: TickSpacingProbes,
  camera: Camera,
  size: { height: number; width: number },
  state: LabelFrameState,
): Record<DimensionFrameAxis, number> {
  const thinning = state.thinning;
  for (const axis of FRAME_AXES) {
    const probe = probes[axis];
    if (!probe) {
      thinning[axis] = 1;
      continue;
    }
    state.probeA.set(...probe[0].position).project(camera);
    state.probeB.set(...probe[1].position).project(camera);
    thinning[axis] = tickThinningForSpacing(
      Math.hypot(
        ((state.probeA.x - state.probeB.x) * size.width) / 2,
        ((state.probeA.y - state.probeB.y) * size.height) / 2,
      ),
      thinning[axis],
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
