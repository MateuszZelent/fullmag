"use client";

import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry, DoubleSide, LineBasicMaterial, MeshBasicMaterial, PointsMaterial } from "three";
import { antennaColorCoordinate, resolveAntennaColorRange } from "@/kernel/visualization/antennaColorRange";
import { antennaFieldDisplayLabel } from "@/kernel/visualization/antennaFieldIntent";
import type { SessionResourceIdentity } from "@/kernel/resources/sessionResourceIdentity";
import { scalarColorRgb } from "@/shared/visualization/scalarColorPalette";
import type { AntennaFieldOverlayModel } from "../model/antennaFieldOverlayModel";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DColors } from "../viewport3dTypes";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import { VectorFieldLayer } from "./VectorFieldLayer";
import { createAntennaCurrentSurfaceMaterial, updateAntennaCurrentSurfaceMaterial } from "./antennaCurrentSurfaceMaterial";

/** An actual sample carrier, not a primitive-object field or fabricated surface. */
export function AntennaFieldLayer({ model, colors, tracker, sessionIdentity }: {
  model: AntennaFieldOverlayModel | null;
  colors: Viewport3DColors;
  tracker: Viewport3DResourceTracker;
  sessionIdentity: SessionResourceIdentity | null;
}) {
  const invalidate = useBatchedInvalidate();
  const wireColor = colors.wire;
  const rgb = useMemo(() => {
    if (!model) return null;
    const rgb = new Float32Array(model.count * 3);
    const range = resolveAntennaColorRange(model, model.intent.colorRange);
    for (let index = 0; index < model.count; index += 1) {
      rgb.set(scalarColorRgb(antennaColorCoordinate(model.scalarValues[index], range), model.intent.palette), index * 3);
    }
    return rgb;
  }, [model]);
  const positions = model?.positions, surfacePositions = model?.surfacePositions ?? positions;
  const surfaceVectors = model?.surfaceVectorValues, triangles = model?.surfaceTriangles;
  const wirePositions = model?.wirePositions ?? positions, edges = model?.surfaceEdges;
  const geometries = useMemo(() => {
    if (!positions) return null;
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.computeBoundingSphere();
    const surface = triangles ? new BufferGeometry() : null;
    if (surface) {
      surface.setAttribute("position", new BufferAttribute(surfacePositions!, 3));
      if (surfaceVectors) surface.setAttribute("fmAntennaCurrentVector", new BufferAttribute(surfaceVectors, 3));
      surface.setIndex(new BufferAttribute(triangles!, 1));
      surface.computeBoundingSphere();
    }
    const wireframe = edges ? new BufferGeometry() : null;
    if (wireframe) {
      wireframe.setAttribute("position", new BufferAttribute(wirePositions!, 3));
      wireframe.setIndex(new BufferAttribute(edges!, 1));
      wireframe.computeBoundingSphere();
    }
    return { geometry, surface, wireframe };
  }, [positions, surfacePositions, surfaceVectors, triangles, wirePositions, edges]);
  const hasSurface = Boolean(triangles), hasCurrent = Boolean(surfaceVectors), hasWire = Boolean(edges), hasModel = Boolean(model);
  const materials = useMemo(() => {
    if (!hasModel) return null;
    const material = new PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true, depthTest: true, depthWrite: true });
    const current = hasSurface && hasCurrent ? createAntennaCurrentSurfaceMaterial() : null;
    const surfaceMaterial = current?.material ?? (hasSurface ? new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }) : null);
    const wireMaterial = hasWire ? new LineBasicMaterial({ color: wireColor, depthTest: true }) : null;
    return { material, surfaceMaterial, wireMaterial, currentSurface: current };
  }, [hasModel, hasSurface, hasCurrent, hasWire, wireColor]);
  useEffect(() => {
    if (!geometries) { invalidate(); return; }
    for (const [name, geometry] of Object.entries(geometries)) if (geometry) {
      const bytes = Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, geometry.index?.array.byteLength ?? 0);
      const colorBytes = name === "geometry" || name === "surface" && !surfaceVectors ? geometry.getAttribute("position").array.byteLength : 0;
      tracker.track("geometry", geometry, { byteLength: bytes + colorBytes, owner: `antenna-field-${name}` });
    }
    invalidate();
    return () => {
      for (const geometry of Object.values(geometries)) if (geometry) tracker.release("geometry", geometry);
      invalidate();
    };
  }, [geometries, surfaceVectors, tracker, invalidate]);
  useEffect(() => {
    if (!materials) return;
    for (const material of [materials.material, materials.surfaceMaterial, materials.wireMaterial]) if (material) tracker.track("material", material, { owner: "antenna-field" });
    if (materials.currentSurface) tracker.track("texture", materials.currentSurface.palette, { byteLength: 1024, owner: "antenna-field-surface" });
    return () => {
      for (const material of [materials.material, materials.surfaceMaterial, materials.wireMaterial]) if (material) tracker.release("material", material);
      if (materials.currentSurface) tracker.release("texture", materials.currentSurface.palette);
    };
  }, [materials, tracker]);
  useEffect(() => {
    if (!geometries || !materials || !model || !rgb) return;
    for (const geometry of [geometries.geometry, materials.currentSurface ? null : geometries.surface]) if (geometry) {
      const color = geometry.getAttribute("color");
      if (color) { color.array.set(rgb); color.needsUpdate = true; }
      else geometry.setAttribute("color", new BufferAttribute(rgb.slice(), 3));
    }
    if (materials.currentSurface) updateAntennaCurrentSurfaceMaterial(materials.currentSurface.material, materials.currentSurface.palette, model);
    invalidate();
  }, [geometries, materials, model, rgb, invalidate]);
  const reference = useMemo(() => model ? {
    buildKey: model.key, fieldBufferId: model.key, fieldRevision: model.intent.contentDigest,
    groupKey: `antenna:${model.intent.sourceObjectId}`, resourceKey: model.intent.solutionId,
    revisionSummary: model.key, targetRevision: model.intent.contentDigest,
    topologyRevision: `sample-carrier:${model.intent.contentDigest}`,
  } : null, [model]);
  if (!model || !geometries || !materials || !rgb) return null;
  return <group name="antenna-scientific-field" userData={{ quantity: model.intent.quantity, label: antennaFieldDisplayLabel(model.intent), normalization: model.intent.kind === "basis" || model.intent.quantity.endsWith("_per_ampere") ? "per_ampere" : "raw_authored_current", sampleCount: model.count, minimum: model.minimum, maximum: model.maximum, colorRange: resolveAntennaColorRange(model, model.intent.colorRange), surfaceVectorScale: model.surfaceVectorScale ?? 1 }}>
    {model.intent.surface && geometries.surface && materials.surfaceMaterial ? <mesh name="antenna-field-surface" geometry={geometries.surface} material={materials.surfaceMaterial} dispose={null} /> : null}
    {model.intent.wireframe && geometries.wireframe && materials.wireMaterial ? <lineSegments name="antenna-field-wireframe" geometry={geometries.wireframe} material={materials.wireMaterial} dispose={null} /> : null}
    {model.intent.points ? <points name="antenna-field-samples" geometry={geometries.geometry} material={materials.material} dispose={null} /> : null}
    {model.intent.vectors && model.vectorSegments ? <VectorFieldLayer
      segments={model.vectorSegments} buildReference={reference} carrierId={`antenna:${model.intent.sourceObjectId}:${model.intent.portModeId}`}
      fieldBufferId={model.key} colors={colors} colorMode="magnitude" glyphColorsOverride={rgb}
      style={{ thickness: model.intent.vectorThickness ?? 1 }} tracker={tracker} sessionIdentity={sessionIdentity} renderOnTop={model.intent.vectorsOnTop ?? false}
    /> : null}
  </group>;
}
