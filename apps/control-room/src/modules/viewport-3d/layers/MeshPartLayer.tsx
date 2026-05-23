"use client";

import { type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";
import {
  RENDER_POLICIES,
  materialPolicyProps,
  surfaceMaterialPolicyProps,
} from "./viewport3DRenderPolicy";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import {
  resolveMeshPartBounds,
  selectionForMeshPart,
  type Viewport3DMeshPart,
  type Viewport3DPartSelection,
} from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import {
  applyVertexScalarColorBuffer,
  canApplyVertexScalarColorBuffer,
} from "../viewport3dGeometryColors";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import type { Viewport3DMagnetizationTexturePreview } from "../viewport3dPrimitiveModel";
import type {
  Viewport3DFieldRenderModel,
  Viewport3DTopologyPartRenderModel,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import { BoundsBox } from "./BoundsLayers";
import { VectorFieldLayer } from "./VectorFieldLayer";
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import {
  opacityFromSettings,
  shaderUsesVertexColors,
  surfaceMaterialColorFromSettings,
  surfaceScalarColorModeFromSettings,
  vectorColorModeFromSettings,
  vectorStyleFromSettings,
  wireframeColorFromSettings,
  wireframeOpacityFromSettings,
} from "./viewport3DLayerSettings";

export function MeshPartLayer({
  colors,
  vectorColorMode,
  fieldModel,
  materialProfile,
  onSelectPart,
  partModel,
  magnetizationTexturePreview,
  meshQualityColors,
  settings,
  topologyModel,
  tracker,
  vectorStyle,
}: {
  colors: Viewport3DColors;
  vectorColorMode: string;
  fieldModel: Viewport3DFieldRenderModel | null;
  materialProfile: Viewport3DMaterialProfile;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>;
  magnetizationTexturePreview: Viewport3DMagnetizationTexturePreview | null;
  meshQualityColors: ScalarColorBuffer | null;
  settings: VisualizationTargetSettings;
  topologyModel: Viewport3DTopologyRenderModel | null;
  tracker: Viewport3DResourceTracker;
  vectorStyle: VectorFieldLayerVectorStyle;
}) {
  const invalidate = useBatchedInvalidate();
  const geometry = useMemo(() => {
    if (!topologyModel) return null;
    const surfaceIndices = partModel.surfaceIndices;
    if (!surfaceIndices?.length) return null;

    const next = tracker.track("geometry", new BufferGeometry());
    next.setAttribute(
      "position",
      new BufferAttribute(topologyModel.positions, 3),
    );
    next.setIndex(new BufferAttribute(surfaceIndices, 1));
    next.computeVertexNormals();
    return next;
  }, [partModel, topologyModel, tracker]);
  const edgeGeometry = useMemo(() => {
    const edgeIndices = resolveMeshPartWireframeEdgeIndices(
      settings.geometryScope,
      partModel,
    );
    if (!topologyModel || !edgeIndices) return null;
    const next = new BufferGeometry();
    next.setAttribute(
      "position",
      new BufferAttribute(topologyModel.positions, 3),
    );
    next.setIndex(new BufferAttribute(edgeIndices, 1));
    return tracker.track("geometry", next);
  }, [partModel, settings.geometryScope, topologyModel, tracker]);

  useEffect(
    () => () => tracker.release("geometry", geometry),
    [geometry, tracker],
  );
  useEffect(
    () => () => tracker.release("geometry", edgeGeometry),
    [edgeGeometry, tracker],
  );

  const scalarColorMode = surfaceScalarColorModeFromSettings(settings);
  const scalarColors = scalarColorMode
    ? fieldModel?.scalarColorsByMode.get(scalarColorMode) ?? null
    : null;
  const effectiveScalarColors = meshQualityColors ?? scalarColors;
  const vertexColorsEnabled =
    Boolean(meshQualityColors) || shaderUsesVertexColors(settings);
  useEffect(() => {
    if (!geometry || !topologyModel) return;
    // Skip the destructive zero-fill when the surface mesh is unmounted
    // (shaderVisible === false).  The geometry's color buffer persists across
    // visibility toggles but the cached ScalarColorBuffer reference is stable,
    // so without this guard the effect would zero the buffer while hidden and
    // then skip re-application on toggle-on (same ref → deps unchanged).
    if (!settings.shaderVisible) return;
    applyVertexScalarColorBuffer(
      geometry,
      vertexColorsEnabled ? effectiveScalarColors : null,
      topologyModel.nodeCount,
    );
    tracker.recordDirtyFrame(
      meshQualityColors ? "mesh-quality-colors" : "field-colors",
    );
    invalidate();
  }, [
    effectiveScalarColors,
    geometry,
    invalidate,
    meshQualityColors,
    settings.shaderVisible,
    topologyModel,
    tracker,
    vertexColorsEnabled,
  ]);

  if (!geometry || !settings.visible) return null;

  const part = partModel.part;
  const hasScalarColors =
    vertexColorsEnabled &&
    canApplyVertexScalarColorBuffer(
      effectiveScalarColors,
      topologyModel?.nodeCount ?? 0,
    );
  const meshColor = surfaceMaterialColorFromSettings(
    settings,
    hasScalarColors
      ? colors.mesh
      : (settings.surfaceColorSource !== "solid"
          ? magnetizationTexturePreview?.color
          : null) ?? colors.mesh,
    hasScalarColors,
  );
  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onSelectPart(selectionForMeshPart(part));
  };

  return (
    <group onPointerDown={handlePointerDown}>
      {settings.shaderVisible ? (
        <mesh
          geometry={geometry}
          renderOrder={surfaceMaterialPolicyProps(opacityFromSettings(settings)).transparent
            ? RENDER_POLICIES.contextSurface.renderOrder
            : RENDER_POLICIES.solidSurface.renderOrder}
        >
          <meshStandardMaterial
            color={meshColor}
            opacity={opacityFromSettings(settings)}
            {...materialProfile.magneticSurface}
            vertexColors={hasScalarColors}
            {...surfaceMaterialPolicyProps(opacityFromSettings(settings))}
          />
        </mesh>
      ) : null}
      {settings.wireframeVisible && edgeGeometry ? (
        <lineSegments
          geometry={edgeGeometry}
          renderOrder={RENDER_POLICIES.featureEdges.renderOrder}
        >
          <lineBasicMaterial
            color={wireframeColorFromSettings(settings, colors.wire)}
            opacity={wireframeOpacityFromSettings(
              settings,
              materialProfile.featureEdges,
            )}
            {...materialPolicyProps("featureEdges")}
          />
        </lineSegments>
      ) : null}
      {settings.wireframeVisible && settings.shaderVisible && edgeGeometry ? (
        <lineSegments
          geometry={edgeGeometry}
          renderOrder={RENDER_POLICIES.hiddenEdges.renderOrder}
        >
          <lineBasicMaterial
            color={wireframeColorFromSettings(settings, colors.wire)}
            opacity={wireframeOpacityFromSettings(
              settings,
              materialProfile.featureEdges,
            ) * 0.25}
            {...materialPolicyProps("hiddenEdges")}
          />
        </lineSegments>
      ) : null}
      {settings.boundsVisible ? (
        <BoundsBox
          bounds={resolveMeshPartBounds(part)}
          color={colors.accent}
          opacity={Math.max(opacityFromSettings(settings), 0.35)}
        />
      ) : null}
      {settings.pointsVisible ? (
        <points
          geometry={geometry}
          renderOrder={RENDER_POLICIES.points.renderOrder}
        >
          <pointsMaterial
            color={colors.wire}
            opacity={opacityFromSettings(settings)}
            sizeAttenuation={false}
            size={3}
            {...materialPolicyProps("points")}
          />
        </points>
      ) : null}
      {settings.vectorsVisible ? (
        <VectorFieldLayer
          colors={colors}
          colorMode={vectorColorModeFromSettings(settings, vectorColorMode)}
          materialProfile={materialProfile.glyphs}
          opacity={opacityFromSettings(settings)}
          segments={fieldModel?.partVectorSegments.get(part.id) ?? null}
          style={vectorStyleFromSettings(settings, vectorStyle)}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
}

export function resolveMeshPartWireframeEdgeIndices(
  geometryScope: VisualizationTargetSettings["geometryScope"],
  partModel: Pick<
    Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>,
    "edgeIndices" | "volumeEdgeIndices"
  >,
): Uint32Array | null {
  if (geometryScope === "full") {
    return partModel.volumeEdgeIndices;
  }

  return partModel.edgeIndices;
}
