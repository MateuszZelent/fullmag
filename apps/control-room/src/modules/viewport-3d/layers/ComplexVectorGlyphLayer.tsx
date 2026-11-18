"use client";

import { useEffect, useId, useLayoutEffect, useMemo } from "react";

import type { SessionResourceIdentity } from "@/kernel/resources/sessionResourceIdentity";
import type { LivePhaseUniform } from "@/kernel/visualization/livePhaseUniform";

import type { Viewport3DRenderAdoptionRegistry } from "../model/viewport3DRenderAdoptionRegistry";
import type { Viewport3DComplexGlyphPass } from "../viewport3dRenderModel";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type { ScalarRange } from "../viewport3dFieldMapping";
import {
  complexVectorGlyphColorRange,
  createComplexVectorGlyphGeometry,
  createComplexVectorGlyphMaterial,
  DEFAULT_COMPLEX_VECTOR_GLYPH_HEAD_LENGTH_RATIO,
  updateComplexVectorGlyphMaterial,
  type Viewport3DComplexVectorGlyphs,
} from "./complexVectorGlyphs";
import {
  recordVectorFieldAdoption,
  resolveVectorFieldLayerStyle,
  resolveVectorGlyphDepthPolicy,
  type VectorFieldLayerVectorStyle,
} from "./VectorFieldLayer";
import { RENDER_POLICIES } from "./viewport3DRenderPolicy";

/**
 * Glyphs of a complex field oriented on the GPU. Phase animation updates the
 * shared phase uniform only: this component does not re-render, and neither
 * geometry nor instance attributes are rebuilt or re-uploaded per frame.
 */
export function ComplexVectorGlyphLayer({
  adoptionRegistry,
  carrierId,
  cellOrigin,
  colorMode,
  colorRange,
  fallbackColor,
  fieldBufferId,
  floquetSpatialConvention,
  glyphs,
  opacity = 1,
  palette,
  phase,
  phasorConvention,
  renderOnTop = false,
  sessionIdentity,
  style,
  tracker,
  wavevectorKf,
}: {
  adoptionRegistry?: Viewport3DRenderAdoptionRegistry;
  carrierId?: string;
  cellOrigin?: readonly [number, number, number] | null;
  colorMode: string;
  /** Explicit color range; defaults to the glyphs' cycle envelope. */
  colorRange?: ScalarRange | null;
  fallbackColor: string;
  fieldBufferId?: string | null;
  floquetSpatialConvention?: string | null;
  glyphs: Viewport3DComplexVectorGlyphs;
  opacity?: number;
  palette?: string | null;
  phase: LivePhaseUniform | number;
  phasorConvention?: string | null;
  renderOnTop?: boolean;
  sessionIdentity?: SessionResourceIdentity | null;
  style?: VectorFieldLayerVectorStyle;
  tracker: Viewport3DResourceTracker;
  wavevectorKf?: readonly [number, number, number] | null;
}) {
  const invalidate = useBatchedInvalidate();
  const glyphPolicy = RENDER_POLICIES.glyphs;
  const depthPolicy = resolveVectorGlyphDepthPolicy(renderOnTop);
  const resolvedStyle = resolveVectorFieldLayerStyle({
    colorMode,
    fallbackColor,
    opacity,
    style,
  });
  const resolvedColorRange =
    colorRange ?? complexVectorGlyphColorRange(glyphs, colorMode);
  const colorRangeMin = resolvedColorRange.min;
  const colorRangeMax = resolvedColorRange.max;
  const {
    headRadiusRatio,
    materialColor: monoColor,
    materialOpacity,
    shaftRadiusRatio,
  } = resolvedStyle;

  const shaftGeometry = useMemo(
    () => tracker.track("geometry", createComplexVectorGlyphGeometry(glyphs, "shaft")),
    [glyphs, tracker],
  );
  const headGeometry = useMemo(
    () => tracker.track("geometry", createComplexVectorGlyphGeometry(glyphs, "head")),
    [glyphs, tracker],
  );
  // Created once per depth policy; glyph and style changes are applied in the
  // layout effect below, before the next demand frame draws the glyphs.
  const material = useMemo(
    () =>
      tracker.track(
        "material",
        createComplexVectorGlyphMaterial({
          depthTest: depthPolicy.depthTest,
          depthWrite: depthPolicy.depthWrite,
          side: glyphPolicy.side,
        }),
      ),
    [depthPolicy.depthTest, depthPolicy.depthWrite, glyphPolicy.side, tracker],
  );
  useEffect(() => () => tracker.release("geometry", shaftGeometry), [shaftGeometry, tracker]);
  useEffect(() => () => tracker.release("geometry", headGeometry), [headGeometry, tracker]);
  useEffect(() => () => tracker.release("material", material), [material, tracker]);

  useLayoutEffect(() => {
    updateComplexVectorGlyphMaterial(material, glyphs, {
      cellOrigin,
      colorMode,
      colorRange: { max: colorRangeMax, min: colorRangeMin },
      floquetSpatialConvention,
      headLengthRatio: DEFAULT_COMPLEX_VECTOR_GLYPH_HEAD_LENGTH_RATIO,
      headRadiusRatio,
      monoColor,
      opacity: materialOpacity,
      palette,
      phase,
      phasorConvention,
      shaftRadiusRatio,
      wavevectorKf,
    });
    invalidate("vector-glyphs");
  }, [
    cellOrigin,
    colorMode,
    colorRangeMax,
    colorRangeMin,
    floquetSpatialConvention,
    glyphs,
    headRadiusRatio,
    invalidate,
    material,
    materialOpacity,
    monoColor,
    palette,
    phase,
    phasorConvention,
    shaftRadiusRatio,
    wavevectorKf,
  ]);

  const adoptionOwnerId = `complex-vector-field:${useId()}`;
  useEffect(() => {
    if (!adoptionRegistry || !carrierId) return;
    const byteLength =
      glyphs.anchors.byteLength + glyphs.complexReal.byteLength + glyphs.complexImag.byteLength;
    const adoption = recordVectorFieldAdoption({
      buildKey: glyphs.buildKey,
      byteLength,
      carrierId,
      fieldBufferId: fieldBufferId ?? null,
      glyphCount: glyphs.count,
      ownerId: adoptionOwnerId,
      registry: adoptionRegistry,
      sessionIdentity,
    });
    invalidate("vector-glyphs");
    return () => adoptionRegistry.clearAdoption(adoptionOwnerId, adoption);
  }, [adoptionOwnerId, adoptionRegistry, carrierId, fieldBufferId, glyphs, invalidate, sessionIdentity]);

  return (
    <>
      <mesh
        frustumCulled={false}
        geometry={shaftGeometry}
        material={material}
        renderOrder={glyphPolicy.renderOrder}
      />
      <mesh
        frustumCulled={false}
        geometry={headGeometry}
        material={material}
        renderOrder={glyphPolicy.renderOrder}
      />
    </>
  );
}

/** Draws a target pass's GPU-phased glyphs with the pass's phase binding. */
export function ComplexGlyphPassLayer({
  pass,
  ...layerProps
}: {
  adoptionRegistry?: Viewport3DRenderAdoptionRegistry;
  carrierId?: string;
  fallbackColor: string;
  fieldBufferId?: string | null;
  opacity?: number;
  pass: Viewport3DComplexGlyphPass;
  renderOnTop?: boolean;
  sessionIdentity?: SessionResourceIdentity | null;
  style?: VectorFieldLayerVectorStyle;
  tracker: Viewport3DResourceTracker;
}) {
  return (
    <ComplexVectorGlyphLayer
      {...layerProps}
      cellOrigin={pass.phase.cellOrigin}
      colorMode={pass.colorMode}
      colorRange={pass.colorRange}
      floquetSpatialConvention={pass.phase.floquetSpatialConvention}
      glyphs={pass.glyphs}
      palette={pass.palette}
      phase={pass.phase.uniform ?? pass.phase.phaseRad}
      phasorConvention={pass.phase.phasorConvention}
      wavevectorKf={pass.phase.wavevectorKf}
    />
  );
}
