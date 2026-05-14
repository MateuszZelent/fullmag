"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type { Viewport3DColors } from "../viewport3dTypes";
import { buildVectorGlyphInstances } from "./vectorGlyphGeometry";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import { RENDER_POLICIES } from "./viewport3DRenderPolicy";

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

export function syncVectorGlyphColorState({
  hasInstanceColors,
  head,
  instanceColorAttr,
  material,
  materialColor,
  shaft,
}: {
  hasInstanceColors: boolean;
  head: InstancedMesh;
  instanceColorAttr: InstancedBufferAttribute;
  material: MeshBasicMaterial;
  materialColor: string;
  shaft: InstancedMesh;
}) {
  const nextInstanceColor = hasInstanceColors ? instanceColorAttr : null;
  shaft.instanceColor = nextInstanceColor;
  head.instanceColor = nextInstanceColor;
  material.vertexColors = hasInstanceColors;
  material.color.set(hasInstanceColors ? "white" : materialColor);
  if (hasInstanceColors) {
    instanceColorAttr.needsUpdate = true;
  }
  material.needsUpdate = true;
}

export function ensureWhiteVertexColorAttribute(
  geometry: BufferGeometry,
): BufferGeometry {
  const position = geometry.getAttribute("position");
  const vertexCount = position?.count ?? 0;
  const existing = geometry.getAttribute("color");
  if (existing?.itemSize === 3 && existing.count === vertexCount) {
    return geometry;
  }

  const colors = new Float32Array(vertexCount * 3);
  colors.fill(1);
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  return geometry;
}

export function VectorFieldLayer({
  colors,
  colorMode = "orientation",
  opacity = 1,
  segments,
  style,
  materialProfile,
  tracker,
}: {
  colors: Viewport3DColors;
  colorMode?: string;
  materialProfile?: Viewport3DMaterialProfile["glyphs"];
  opacity?: number;
  segments: Float32Array | null;
  style?: VectorFieldLayerVectorStyle;
  tracker: Viewport3DResourceTracker;
}) {
  const invalidate = useBatchedInvalidate();
  const shaftRef = useRef<InstancedMesh>(null);
  const headRef = useRef<InstancedMesh>(null);
  const glyphPolicy = RENDER_POLICIES.glyphs;
  const resolvedStyle = resolveVectorFieldLayerStyle({
    colorMode,
    fallbackColor: String(colors.field),
    opacity: opacity * (materialProfile?.opacityScale ?? 1),
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
  const glyphCount = glyphs?.count ?? 0;

  // Stable power-of-two capacity keeps allocations bounded without render-time
  // ref reads, which React Compiler rejects.
  const capacity = useMemo(() => {
    const desired = Math.max(1, glyphCount);
    let next = 1;
    while (next < desired) next *= 2;
    return Math.min(next, 1 << 20); // cap at ~1M
  }, [glyphCount]);

  const shaftGeometry = useMemo(
    () =>
      tracker.track(
        "geometry",
        ensureWhiteVertexColorAttribute(
          new CylinderGeometry(1, 1, 1, 12, 1),
        ),
      ),
    [tracker],
  );
  const headGeometry = useMemo(
    () =>
      tracker.track(
        "geometry",
        ensureWhiteVertexColorAttribute(new ConeGeometry(1, 1, 12, 1)),
      ),
    [tracker],
  );
  const material = useMemo(
    () =>
      tracker.track(
        "material",
        new MeshBasicMaterial({
          color: useInstanceColors ? "white" : resolvedStyle.materialColor,
          depthWrite: glyphPolicy.depthWrite,
          depthTest: glyphPolicy.depthTest,
          opacity: resolvedStyle.materialOpacity,
          side: glyphPolicy.side,
          toneMapped: materialProfile?.toneMapped ?? false,
          transparent:
            glyphPolicy.transparent ||
            resolvedStyle.materialOpacity < 0.99,
          vertexColors: useInstanceColors,
        }),
      ),
    [
      glyphPolicy,
      resolvedStyle.materialColor,
      resolvedStyle.materialOpacity,
      tracker,
      useInstanceColors,
      materialProfile?.toneMapped,
    ],
  );

  const instanceColorAttrRef = useRef<InstancedBufferAttribute | null>(null);

  useEffect(() => {
    const attr = new InstancedBufferAttribute(
      new Float32Array(capacity * 3),
      3,
    );
    attr.setUsage(DynamicDrawUsage);
    instanceColorAttrRef.current = attr;
    return () => {
      if (instanceColorAttrRef.current === attr) {
        instanceColorAttrRef.current = null;
      }
    };
  }, [capacity]);

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
    const instanceColorAttr = instanceColorAttrRef.current;
    if (!glyphs || !shaft || !head || !instanceColorAttr) return;

    // Set visible count (may be less than capacity).
    shaft.count = glyphs.count;
    head.count = glyphs.count;

    // Attach instance color attribute for bulk writes.
    syncVectorGlyphColorState({
      hasInstanceColors: Boolean(glyphs.colors),
      head,
      instanceColorAttr,
      material,
      materialColor: resolvedStyle.materialColor,
      shaft,
    });
    shaft.instanceMatrix.setUsage(DynamicDrawUsage);
    head.instanceMatrix.setUsage(DynamicDrawUsage);

    const matrix = new Matrix4();
    const quaternion = new Quaternion();
    const position = new Vector3();
    const scale = new Vector3();
    const direction = new Vector3();

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
    }

    // Bulk color write instead of per-instance setColorAt.
    if (glyphs.colors) {
      const colorArray = instanceColorAttr.array as Float32Array;
      colorArray.set(glyphs.colors.subarray(0, glyphs.count * 3));
      instanceColorAttr.needsUpdate = true;
    }

    shaft.instanceMatrix.needsUpdate = true;
    head.instanceMatrix.needsUpdate = true;
    tracker.recordDirtyFrame("vector-glyphs");
    invalidate();
  }, [glyphs, invalidate, material, resolvedStyle.materialColor, tracker]);

  if (!glyphs || glyphs.count === 0) return null;

  return (
    <>
      <instancedMesh
        args={[shaftGeometry, material, capacity]}
        frustumCulled={false}
        key={`vector-shaft-${capacity}`}
        ref={shaftRef}
        renderOrder={glyphPolicy.renderOrder}
      />
      <instancedMesh
        args={[headGeometry, material, capacity]}
        frustumCulled={false}
        key={`vector-head-${capacity}`}
        ref={headRef}
        renderOrder={glyphPolicy.renderOrder}
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
