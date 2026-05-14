"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  Color,
  ConeGeometry,
  CylinderGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DColors } from "../viewport3dTypes";
import { buildVectorGlyphInstances } from "./vectorGlyphGeometry";

const UNIT_Y = new Vector3(0, 1, 0);
// V1-matched proportions for better visual quality.
const DEFAULT_HEAD_RADIUS_RATIO = 0.20;
const DEFAULT_SHAFT_RADIUS_RATIO = 0.08;

export interface VectorFieldLayerVectorStyle {
  alpha?: number | null;
  monoColor?: string | null;
  thickness?: number | null;
}

export function resolveVectorFieldLayerStyle({
  colorMode,
  fallbackColor,
  opacity,
  style,
}: {
  colorMode: string;
  fallbackColor: string;
  opacity: number;
  style?: VectorFieldLayerVectorStyle;
}) {
  const thickness = clampStyleScale(style?.thickness ?? 1);
  return {
    headRadiusRatio: DEFAULT_HEAD_RADIUS_RATIO * thickness,
    materialColor:
      colorMode === "monochrome" && style?.monoColor
        ? style.monoColor
        : fallbackColor,
    materialOpacity: clampOpacity(opacity * (style?.alpha ?? 1)),
    shaftRadiusRatio: DEFAULT_SHAFT_RADIUS_RATIO * thickness,
  };
}

export function VectorFieldLayer({
  colors,
  colorMode = "orientation",
  opacity = 1,
  segments,
  style,
  tracker,
}: {
  colors: Viewport3DColors;
  colorMode?: string;
  opacity?: number;
  segments: Float32Array | null;
  style?: VectorFieldLayerVectorStyle;
  tracker: Viewport3DResourceTracker;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const shaftRef = useRef<InstancedMesh>(null);
  const headRef = useRef<InstancedMesh>(null);
  const resolvedStyle = resolveVectorFieldLayerStyle({
    colorMode,
    fallbackColor: String(colors.field),
    opacity,
    style,
  });
  const glyphs = useMemo(
    () =>
      segments
        ? buildVectorGlyphInstances(segments, {
            colorMode,
            headRadiusRatio: resolvedStyle.headRadiusRatio,
            shaftRadiusRatio: resolvedStyle.shaftRadiusRatio,
          })
        : null,
    [
      colorMode,
      resolvedStyle.headRadiusRatio,
      resolvedStyle.shaftRadiusRatio,
      segments,
    ],
  );
  const useInstanceColors = Boolean(glyphs?.colors);
  const shaftGeometry = useMemo(
    () => tracker.track("geometry", new CylinderGeometry(1, 1, 1, 12, 1)),
    [tracker],
  );
  const headGeometry = useMemo(
    () => tracker.track("geometry", new ConeGeometry(1, 1, 12, 1)),
    [tracker],
  );
  const material = useMemo(
    () =>
      tracker.track(
        "material",
        new MeshBasicMaterial({
          color: useInstanceColors ? "white" : resolvedStyle.materialColor,
          depthWrite: resolvedStyle.materialOpacity >= 0.99,
          opacity: resolvedStyle.materialOpacity,
          toneMapped: false,
          transparent: resolvedStyle.materialOpacity < 0.99,
          vertexColors: useInstanceColors,
        }),
      ),
    [
      resolvedStyle.materialColor,
      resolvedStyle.materialOpacity,
      tracker,
      useInstanceColors,
    ],
  );

  useEffect(
    () => () => tracker.release("geometry", shaftGeometry),
    [shaftGeometry, tracker],
  );
  useEffect(
    () => () => tracker.release("geometry", headGeometry),
    [headGeometry, tracker],
  );
  useEffect(
    () => () => tracker.release("material", material),
    [material, tracker],
  );

  useEffect(() => {
    const shaft = shaftRef.current;
    const head = headRef.current;
    if (!glyphs || !shaft || !head) return;

    const matrix = new Matrix4();
    const quaternion = new Quaternion();
    const position = new Vector3();
    const scale = new Vector3();
    const direction = new Vector3();
    const color = new Color();

    for (let index = 0; index < glyphs.count; index += 1) {
      const offset = index * 3;
      direction.set(
        glyphs.directions[offset] ?? 0,
        glyphs.directions[offset + 1] ?? 1,
        glyphs.directions[offset + 2] ?? 0,
      );
      quaternion.setFromUnitVectors(UNIT_Y, direction);

      position.set(
        glyphs.shaftCenters[offset] ?? 0,
        glyphs.shaftCenters[offset + 1] ?? 0,
        glyphs.shaftCenters[offset + 2] ?? 0,
      );
      scale.set(
        glyphs.shaftScales[offset] ?? 0,
        glyphs.shaftScales[offset + 1] ?? 0,
        glyphs.shaftScales[offset + 2] ?? 0,
      );
      matrix.compose(position, quaternion, scale);
      shaft.setMatrixAt(index, matrix);

      position.set(
        glyphs.headCenters[offset] ?? 0,
        glyphs.headCenters[offset + 1] ?? 0,
        glyphs.headCenters[offset + 2] ?? 0,
      );
      scale.set(
        glyphs.headScales[offset] ?? 0,
        glyphs.headScales[offset + 1] ?? 0,
        glyphs.headScales[offset + 2] ?? 0,
      );
      matrix.compose(position, quaternion, scale);
      head.setMatrixAt(index, matrix);

      if (glyphs.colors) {
        color.setRGB(
          glyphs.colors[offset] ?? 1,
          glyphs.colors[offset + 1] ?? 1,
          glyphs.colors[offset + 2] ?? 1,
        );
        shaft.setColorAt(index, color);
        head.setColorAt(index, color);
      }
    }

    shaft.instanceMatrix.needsUpdate = true;
    head.instanceMatrix.needsUpdate = true;
    if (shaft.instanceColor) shaft.instanceColor.needsUpdate = true;
    if (head.instanceColor) head.instanceColor.needsUpdate = true;
    tracker.recordDirtyFrame("vector-glyphs");
    invalidate();
  }, [glyphs, invalidate, tracker]);

  if (!glyphs || glyphs.count === 0) return null;

  return (
    <>
      <instancedMesh
        args={[shaftGeometry, material, glyphs.count]}
        frustumCulled={false}
        key={`vector-shaft-${glyphs.count}`}
        ref={shaftRef}
      />
      <instancedMesh
        args={[headGeometry, material, glyphs.count]}
        frustumCulled={false}
        key={`vector-head-${glyphs.count}`}
        ref={headRef}
      />
    </>
  );
}

function clampOpacity(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampStyleScale(value: number): number {
  return Math.max(0.1, Math.min(8, value));
}
