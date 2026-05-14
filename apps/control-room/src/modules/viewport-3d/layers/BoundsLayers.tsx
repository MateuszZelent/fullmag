"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";
import type { ColorRepresentation } from "three";
import {
  RENDER_POLICIES,
  materialPolicyProps,
} from "./viewport3DRenderPolicy";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import {
  resolveMeshPartBounds,
  selectionForMeshPart,
  type Viewport3DMeshPart,
  type Viewport3DPartSelection,
} from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { buildSurfaceEdgeGeometry } from "../viewport3dSurfaceEdges";
import {
  resolveStaleTopologyVisualizationSettings,
  type Viewport3DTopologyFreshness,
} from "../viewport3dTopologyStaleness";
import type {
  Viewport3DBounds,
  Viewport3DFieldRenderModel,
  Viewport3DTopologyPartRenderModel,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import { VectorFieldLayer } from "./VectorFieldLayer";
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer";
import {
  opacityFromSettings,
  shaderColorFromSettings,
  vectorColorModeFromSettings,
  vectorStyleFromSettings,
  wireframeColorFromSettings,
  wireframeOpacityFromSettings,
} from "./viewport3DLayerSettings";

export function BoundsBox({
  bounds,
  color,
  opacity,
  wireframe = true,
}: {
  bounds: Viewport3DBounds | null;
  color: ColorRepresentation;
  opacity: number;
  wireframe?: boolean;
}) {
  if (!bounds) return null;

  return (
    <mesh position={bounds.center}>
      <boxGeometry
        args={[
          Math.max(bounds.size[0], 1e-9),
          Math.max(bounds.size[1], 1e-9),
          Math.max(bounds.size[2], 1e-9),
        ]}
      />
      <meshBasicMaterial
        color={color}
        opacity={opacity}
        transparent
        wireframe={wireframe}
      />
    </mesh>
  );
}

function BoundsPoints({
  bounds,
  color,
  opacity,
}: {
  bounds: Viewport3DBounds | null;
  color: ColorRepresentation;
  opacity: number;
}) {
  if (!bounds) return null;

  return (
    <points position={bounds.center}>
      <boxGeometry
        args={[
          Math.max(bounds.size[0], 1e-9),
          Math.max(bounds.size[1], 1e-9),
          Math.max(bounds.size[2], 1e-9),
        ]}
      />
      <pointsMaterial color={color} opacity={opacity} sizeAttenuation={false} size={3} transparent />
    </points>
  );
}

function AirboxMeshPartLayer({
  colors,
  fieldModel,
  onSelectPart,
  partModel,
  settings,
  topologyModel,
  topologyFreshness,
  tracker,
  vectorColorMode,
  vectorStyle,
}: {
  colors: Viewport3DColors;
  fieldModel: Viewport3DFieldRenderModel | null;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>;
  settings: VisualizationTargetSettings;
  topologyModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart>;
  topologyFreshness: Viewport3DTopologyFreshness;
  tracker: Viewport3DResourceTracker;
  vectorColorMode: string;
  vectorStyle: VectorFieldLayerVectorStyle;
}) {
  const resolvedSettings =
    topologyFreshness === "stale"
      ? resolveStaleTopologyVisualizationSettings(settings)
      : settings;
  const geometry = useMemo(() => {
    const { surfaceIndices } = partModel;
    if (!surfaceIndices?.length) return null;
    const next = tracker.track("geometry", new BufferGeometry());
    next.setAttribute("position", new BufferAttribute(topologyModel.positions, 3));
    next.setIndex(new BufferAttribute(surfaceIndices, 1));
    next.computeVertexNormals();
    return next;
  }, [partModel, topologyModel, tracker]);
  const edgeGeometry = useMemo(() => {
    const next = buildSurfaceEdgeGeometry(
      topologyModel.positions,
      partModel.surfaceIndices,
    );
    return next ? tracker.track("geometry", next) : null;
  }, [partModel.surfaceIndices, topologyModel.positions, tracker]);

  useEffect(() => () => tracker.release("geometry", geometry), [geometry, tracker]);
  useEffect(
    () => () => tracker.release("geometry", edgeGeometry),
    [edgeGeometry, tracker],
  );

  const opacity = opacityFromSettings(resolvedSettings);
  const part = partModel.part;

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onSelectPart(selectionForMeshPart(part));
  };

  if (!geometry) {
    return (
      <group onPointerDown={handlePointerDown}>
        {resolvedSettings.shaderVisible ? (
          <BoundsBox
            bounds={resolveMeshPartBounds(part)}
            color={shaderColorFromSettings(resolvedSettings, colors.accent)}
            opacity={opacity}
            wireframe={false}
          />
        ) : null}
        {resolvedSettings.wireframeVisible ? (
          <BoundsBox
            bounds={resolveMeshPartBounds(part)}
            color={wireframeColorFromSettings(resolvedSettings, colors.wire)}
            opacity={wireframeOpacityFromSettings(resolvedSettings)}
          />
        ) : null}
        {resolvedSettings.boundsVisible ? (
          <BoundsBox
            bounds={resolveMeshPartBounds(part)}
            color={colors.accent}
            opacity={Math.max(opacity, 0.35)}
          />
        ) : null}
        {resolvedSettings.pointsVisible ? (
          <BoundsPoints
            bounds={resolveMeshPartBounds(part)}
            color={wireframeColorFromSettings(resolvedSettings, colors.wire)}
            opacity={opacity}
          />
        ) : null}
        {resolvedSettings.vectorsVisible ? (
          <VectorFieldLayer
            colors={colors}
            colorMode={vectorColorModeFromSettings(resolvedSettings, vectorColorMode)}
            opacity={opacity}
            segments={fieldModel?.partVectorSegments.get(part.id) ?? null}
            style={vectorStyleFromSettings(resolvedSettings, vectorStyle)}
            tracker={tracker}
          />
        ) : null}
      </group>
    );
  }

  return (
    <group onPointerDown={handlePointerDown}>
      {resolvedSettings.shaderVisible ? (
        <mesh
          geometry={geometry}
          renderOrder={RENDER_POLICIES.airSurface.renderOrder}
        >
          <meshStandardMaterial
            color={shaderColorFromSettings(resolvedSettings, colors.mesh)}
            opacity={opacity}
            roughness={0.86}
            {...materialPolicyProps("airSurface")}
          />
        </mesh>
      ) : null}
      {resolvedSettings.wireframeVisible ? (
        resolvedSettings.geometryScope === "surface" && edgeGeometry ? (
          <lineSegments
            geometry={edgeGeometry}
            renderOrder={RENDER_POLICIES.featureEdges.renderOrder}
          >
            <lineBasicMaterial
              color={wireframeColorFromSettings(resolvedSettings, colors.wire)}
              opacity={wireframeOpacityFromSettings(resolvedSettings)}
              {...materialPolicyProps("featureEdges")}
            />
          </lineSegments>
        ) : (
          <BoundsBox
            bounds={resolveMeshPartBounds(part)}
            color={wireframeColorFromSettings(resolvedSettings, colors.wire)}
            opacity={wireframeOpacityFromSettings(resolvedSettings)}
          />
        )
      ) : null}
      {resolvedSettings.boundsVisible ? (
        <BoundsBox
          bounds={resolveMeshPartBounds(part)}
          color={colors.accent}
          opacity={Math.max(opacity, 0.35)}
        />
      ) : null}
      {resolvedSettings.pointsVisible ? (
        <points
          geometry={geometry}
          renderOrder={RENDER_POLICIES.points.renderOrder}
        >
          <pointsMaterial
            color={wireframeColorFromSettings(resolvedSettings, colors.wire)}
            opacity={opacity}
            sizeAttenuation={false}
            size={3}
            {...materialPolicyProps("points")}
          />
        </points>
      ) : null}
      {resolvedSettings.vectorsVisible ? (
        <VectorFieldLayer
          colors={colors}
          colorMode={vectorColorModeFromSettings(resolvedSettings, vectorColorMode)}
          opacity={opacity}
          segments={fieldModel?.partVectorSegments.get(part.id) ?? null}
          style={vectorStyleFromSettings(resolvedSettings, vectorStyle)}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
}

export function DomainBoxLayer({
  bounds,
  boundsVisible = true,
  colors,
  onSelectDomain,
}: {
  bounds: Viewport3DBounds | null;
  boundsVisible?: boolean;
  colors: Viewport3DColors;
  onSelectDomain: () => void;
}) {
  if (!bounds || !boundsVisible) return null;

  return (
    <mesh
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelectDomain();
      }}
      position={bounds.center}
    >
      <boxGeometry
        args={[
          Math.max(bounds.size[0], 1e-9),
          Math.max(bounds.size[1], 1e-9),
          Math.max(bounds.size[2], 1e-9),
        ]}
      />
      <meshBasicMaterial
        color={colors.accent}
        opacity={0.35}
        transparent
        wireframe
      />
    </mesh>
  );
}

export function AirboxLayer({
  colors,
  vectorColorMode,
  fieldModel,
  onSelectPart,
  settings,
  topologyModel,
  topologyFreshness,
  tracker,
  vectorStyle,
}: {
  colors: Viewport3DColors;
  vectorColorMode: string;
  fieldModel: Viewport3DFieldRenderModel | null;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  settings: VisualizationTargetSettings;
  topologyModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart> | null;
  topologyFreshness: Viewport3DTopologyFreshness;
  tracker: Viewport3DResourceTracker;
  vectorStyle: VectorFieldLayerVectorStyle;
}) {
  if (!settings.visible) return null;

  return (
    <>
      {topologyModel?.airboxParts.map((partModel) => (
        <AirboxMeshPartLayer
          key={partModel.part.id}
          colors={colors}
          fieldModel={fieldModel}
          onSelectPart={onSelectPart}
          partModel={partModel}
          settings={settings}
          topologyModel={topologyModel}
          topologyFreshness={topologyFreshness}
          tracker={tracker}
          vectorColorMode={vectorColorMode}
          vectorStyle={vectorStyle}
        />
      ))}
    </>
  );
}

export function SelectionHighlightLayer({
  bounds,
  colors,
}: {
  bounds: Viewport3DBounds | null;
  colors: Viewport3DColors;
}) {
  return <BoundsBox bounds={bounds} color={colors.accent} opacity={0.72} />;
}
