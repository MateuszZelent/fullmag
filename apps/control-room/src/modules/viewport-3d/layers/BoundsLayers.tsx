"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";
import type { ColorRepresentation } from "three";
import {
  RENDER_POLICIES,
  type RenderSemantic,
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
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import {
  applyVertexScalarColorBuffer,
  canApplyVertexScalarColorBuffer,
} from "../viewport3dGeometryColors";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import {
  isViewport3DTopologyCurrent,
  resolveStaleTopologyVisualizationSettings,
  type Viewport3DTopologyFreshness,
} from "../viewport3dTopologyStaleness";
import type {
  Viewport3DBounds,
  Viewport3DFieldRenderModel,
  Viewport3DTopologyPartRenderModel,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";
import { buildLineIndexGeometry } from "../viewport3dSurfaceEdges";
import type { Viewport3DColors } from "../viewport3dTypes";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import { VectorFieldLayer } from "./VectorFieldLayer";
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer";
import {
  opacityFromSettings,
  percentToUnit,
  shaderColorFromSettings,
  shaderUsesVertexColors,
  surfaceMaterialColorFromSettings,
  surfaceScalarColorModeFromSettings,
  vectorColorModeFromSettings,
  vectorStyleFromSettings,
  wireframeColorFromSettings,
} from "./viewport3DLayerSettings";

export interface AirboxSurfaceColorState {
  hasScalarColors: boolean;
  materialColor: ColorRepresentation;
  scalarColors: ScalarColorBuffer | null;
  vertexColorsEnabled: boolean;
}

export function BoundsBox({
  bounds,
  color,
  opacity,
  policySemantic,
  wireframe = true,
}: {
  bounds: Viewport3DBounds | null;
  color: ColorRepresentation;
  opacity: number;
  policySemantic?: RenderSemantic;
  wireframe?: boolean;
}) {
  if (!bounds) return null;
  const policyProps = policySemantic ? materialPolicyProps(policySemantic) : {};

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
        {...policyProps}
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

function BoundsVolumeWireframe({
  bounds,
  color,
  opacity,
  policySemantic,
  tracker,
}: {
  bounds: Viewport3DBounds | null;
  color: ColorRepresentation;
  opacity: number;
  policySemantic: Extract<RenderSemantic, "featureEdges" | "hiddenEdges">;
  tracker: Viewport3DResourceTracker;
}) {
  const geometry = useMemo(() => {
    const positions = buildBoundsVolumeWireframePositions(bounds);
    if (!positions) return null;
    const next = new BufferGeometry();
    next.setAttribute("position", new BufferAttribute(positions, 3));
    return next;
  }, [bounds]);

  useEffect(() => {
    if (!geometry) return undefined;
    tracker.track("geometry", geometry);
    return () => tracker.release("geometry", geometry);
  }, [geometry, tracker]);

  if (!geometry) return null;

  return (
    <lineSegments
      geometry={geometry}
      renderOrder={RENDER_POLICIES[policySemantic].renderOrder}
    >
      <lineBasicMaterial
        color={color}
        opacity={opacity}
        {...materialPolicyProps(policySemantic)}
      />
    </lineSegments>
  );
}

function AirboxMeshPartLayer({
  colors,
  fieldModel,
  materialProfile,
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
  materialProfile: Viewport3DMaterialProfile;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>;
  settings: VisualizationTargetSettings;
  topologyModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart>;
  topologyFreshness: Viewport3DTopologyFreshness;
  tracker: Viewport3DResourceTracker;
  vectorColorMode: string;
  vectorStyle: VectorFieldLayerVectorStyle;
}) {
  const invalidate = useBatchedInvalidate();
  const resolvedSettings =
    resolveAirboxTopologyVisualizationSettings(settings, topologyFreshness);
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
    const edgeIndices = resolveAirboxWireframeEdgeIndices(
      resolvedSettings.geometryScope,
      partModel,
    );
    const next = buildLineIndexGeometry(topologyModel.positions, edgeIndices);
    return next ? tracker.track("geometry", next) : null;
  }, [
    partModel,
    resolvedSettings.geometryScope,
    topologyModel.positions,
    tracker,
  ]);

  useEffect(() => () => tracker.release("geometry", geometry), [geometry, tracker]);
  useEffect(
    () => () => tracker.release("geometry", edgeGeometry),
    [edgeGeometry, tracker],
  );

  const opacity = opacityFromSettings(resolvedSettings);
  const part = partModel.part;
  const airboxWireframeSemantic =
    resolveAirboxWireframeSemantic(resolvedSettings);
  const surfaceColorState = resolveAirboxSurfaceColorState(
    resolvedSettings,
    fieldModel,
    topologyModel.nodeCount,
    colors.mesh,
  );
  useEffect(() => {
    if (!geometry) return;
    applyVertexScalarColorBuffer(
      geometry,
      surfaceColorState.vertexColorsEnabled
        ? surfaceColorState.scalarColors
        : null,
      topologyModel.nodeCount,
    );
    tracker.recordDirtyFrame("airbox-field-colors");
    invalidate();
  }, [
    geometry,
    invalidate,
    surfaceColorState.scalarColors,
    topologyModel.nodeCount,
    tracker,
    surfaceColorState.vertexColorsEnabled,
  ]);

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onSelectPart(selectionForMeshPart(part));
  };
  const wireframePrimitive = resolveAirboxWireframePrimitive(
    resolvedSettings.wireframeVisible,
    Boolean(edgeGeometry),
    resolvedSettings.geometryScope,
  );
  const showFullWireframeBoundsOverlay =
    shouldRenderAirboxFullBoundsOverlay(resolvedSettings, wireframePrimitive);

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
        {wireframePrimitive === "lines" && edgeGeometry ? (
          <lineSegments
            geometry={edgeGeometry}
            renderOrder={RENDER_POLICIES[airboxWireframeSemantic].renderOrder}
          >
            <lineBasicMaterial
              color={wireframeColorFromSettings(resolvedSettings, colors.wire)}
              opacity={airboxWireframeOpacityFromSettings(
                resolvedSettings,
                materialProfile.featureEdges,
              )}
              {...materialPolicyProps(airboxWireframeSemantic)}
            />
          </lineSegments>
        ) : wireframePrimitive === "bounds" ? (
          <AirboxWireframeFallback
            bounds={resolveMeshPartBounds(part)}
            color={wireframeColorFromSettings(resolvedSettings, colors.wire)}
            opacity={airboxWireframeOpacityFromSettings(resolvedSettings)}
            policySemantic={airboxWireframeSemantic}
            settings={resolvedSettings}
            tracker={tracker}
          />
        ) : null}
        {showFullWireframeBoundsOverlay ? (
          <BoundsVolumeWireframe
            bounds={resolveMeshPartBounds(part)}
            color={wireframeColorFromSettings(resolvedSettings, colors.wire)}
            opacity={airboxWireframeOpacityFromSettings(resolvedSettings)}
            policySemantic={airboxWireframeSemantic}
            tracker={tracker}
          />
        ) : null}
        {resolvedSettings.boundsVisible ? (
          <BoundsBox
            bounds={resolveMeshPartBounds(part)}
            color={colors.accent}
            opacity={Math.max(opacity, 0.35)}
            policySemantic="hiddenEdges"
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
            materialProfile={materialProfile.glyphs}
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
            color={surfaceColorState.materialColor}
            opacity={opacity}
            {...materialProfile.airSurface}
            vertexColors={surfaceColorState.hasScalarColors}
            {...materialPolicyProps("airSurface")}
          />
        </mesh>
      ) : null}
      {resolvedSettings.wireframeVisible ? (
        edgeGeometry ? (
          <lineSegments
            geometry={edgeGeometry}
            renderOrder={RENDER_POLICIES[airboxWireframeSemantic].renderOrder}
          >
            <lineBasicMaterial
              color={wireframeColorFromSettings(resolvedSettings, colors.wire)}
              opacity={airboxWireframeOpacityFromSettings(
                resolvedSettings,
                materialProfile.featureEdges,
              )}
              {...materialPolicyProps(airboxWireframeSemantic)}
            />
          </lineSegments>
        ) : (
          <AirboxWireframeFallback
            bounds={resolveMeshPartBounds(part)}
            color={wireframeColorFromSettings(resolvedSettings, colors.wire)}
            opacity={airboxWireframeOpacityFromSettings(resolvedSettings)}
            policySemantic={airboxWireframeSemantic}
            settings={resolvedSettings}
            tracker={tracker}
          />
        )
      ) : null}
      {showFullWireframeBoundsOverlay ? (
        <BoundsVolumeWireframe
          bounds={resolveMeshPartBounds(part)}
          color={wireframeColorFromSettings(resolvedSettings, colors.wire)}
          opacity={airboxWireframeOpacityFromSettings(resolvedSettings)}
          policySemantic={airboxWireframeSemantic}
          tracker={tracker}
        />
      ) : null}
      {resolvedSettings.boundsVisible ? (
        <BoundsBox
          bounds={resolveMeshPartBounds(part)}
          color={colors.accent}
          opacity={Math.max(opacity, 0.35)}
          policySemantic="hiddenEdges"
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
          materialProfile={materialProfile.glyphs}
          opacity={opacity}
          segments={fieldModel?.partVectorSegments.get(part.id) ?? null}
          style={vectorStyleFromSettings(resolvedSettings, vectorStyle)}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
}

function AirboxWireframeFallback({
  bounds,
  color,
  opacity,
  policySemantic,
  settings,
  tracker,
}: {
  bounds: Viewport3DBounds | null;
  color: ColorRepresentation;
  opacity: number;
  policySemantic: Extract<RenderSemantic, "featureEdges" | "hiddenEdges">;
  settings: VisualizationTargetSettings;
  tracker: Viewport3DResourceTracker;
}) {
  if (settings.geometryScope === "full") {
    return (
      <BoundsVolumeWireframe
        bounds={bounds}
        color={color}
        opacity={opacity}
        policySemantic={policySemantic}
        tracker={tracker}
      />
    );
  }

  return (
    <BoundsBox
      bounds={bounds}
      color={color}
      opacity={opacity}
      policySemantic={policySemantic}
    />
  );
}

export function resolveAirboxWireframeSemantic(
  settings: VisualizationTargetSettings,
): Extract<RenderSemantic, "featureEdges" | "hiddenEdges"> {
  if (settings.geometryScope === "full") return "hiddenEdges";
  return settings.shaderVisible ? "featureEdges" : "hiddenEdges";
}

export function airboxWireframeOpacityFromSettings(
  settings: VisualizationTargetSettings,
  featureEdges?: Viewport3DMaterialProfile["featureEdges"],
): number {
  const opacity =
    percentToUnit(settings.wireframeOpacityPercent) *
    (featureEdges?.opacity ?? 1);
  return Math.max(0, Math.min(1, opacity));
}

export function resolveAirboxWireframePrimitive(
  wireframeVisible: boolean,
  hasEdgeGeometry: boolean,
  geometryScope: VisualizationTargetSettings["geometryScope"] = "surface",
): "bounds" | "lines" | null {
  if (!wireframeVisible) return null;
  if (geometryScope === "full") return "bounds";
  return hasEdgeGeometry ? "lines" : "bounds";
}

export function shouldRenderAirboxFullBoundsOverlay(
  settings: VisualizationTargetSettings,
  wireframePrimitive: "bounds" | "lines" | null,
): boolean {
  return (
    settings.visible &&
    settings.wireframeVisible &&
    settings.geometryScope === "full" &&
    wireframePrimitive === "lines"
  );
}

export function resolveAirboxTopologyVisualizationSettings(
  settings: VisualizationTargetSettings,
  topologyFreshness: Viewport3DTopologyFreshness,
): VisualizationTargetSettings {
  if (isViewport3DTopologyCurrent(topologyFreshness)) {
    return settings;
  }

  return {
    ...resolveStaleTopologyVisualizationSettings(settings),
    geometryScope: settings.geometryScope,
  };
}

export function resolveAirboxSurfaceColorState(
  settings: VisualizationTargetSettings,
  fieldModel: Pick<Viewport3DFieldRenderModel, "scalarColorsByMode"> | null,
  nodeCount: number,
  fallbackColor: ColorRepresentation,
): AirboxSurfaceColorState {
  const scalarColorMode = surfaceScalarColorModeFromSettings(settings);
  const scalarColors: ScalarColorBuffer | null = scalarColorMode
    ? fieldModel?.scalarColorsByMode.get(scalarColorMode) ?? null
    : null;
  const vertexColorsEnabled = shaderUsesVertexColors(settings);
  const hasScalarColors =
    vertexColorsEnabled &&
    canApplyVertexScalarColorBuffer(scalarColors, nodeCount);

  return {
    hasScalarColors,
    materialColor: surfaceMaterialColorFromSettings(
      settings,
      fallbackColor,
      hasScalarColors,
    ),
    scalarColors,
    vertexColorsEnabled,
  };
}

export function resolveAirboxWireframeEdgeIndices(
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

const AIRBOX_VOLUME_WIREFRAME_DIVISIONS = 4;

export function buildBoundsVolumeWireframePositions(
  bounds: Viewport3DBounds | null,
  divisions = AIRBOX_VOLUME_WIREFRAME_DIVISIONS,
): Float32Array | null {
  if (!bounds) return null;

  const safeDivisions = Math.max(1, Math.floor(divisions));
  const [cx, cy, cz] = bounds.center;
  const [sx, sy, sz] = bounds.size.map((value) => Math.max(value, 1e-9)) as [
    number,
    number,
    number,
  ];
  const min: [number, number, number] = [
    cx - sx / 2,
    cy - sy / 2,
    cz - sz / 2,
  ];
  const max: [number, number, number] = [
    cx + sx / 2,
    cy + sy / 2,
    cz + sz / 2,
  ];
  const positions: number[] = [];

  for (let ix = 0; ix <= safeDivisions; ix += 1) {
    const x = lerp(min[0], max[0], ix / safeDivisions);
    for (let iy = 0; iy <= safeDivisions; iy += 1) {
      const y = lerp(min[1], max[1], iy / safeDivisions);
      appendLine(positions, [x, y, min[2]], [x, y, max[2]]);
    }
    for (let iz = 0; iz <= safeDivisions; iz += 1) {
      const z = lerp(min[2], max[2], iz / safeDivisions);
      appendLine(positions, [x, min[1], z], [x, max[1], z]);
    }
  }

  for (let iy = 0; iy <= safeDivisions; iy += 1) {
    const y = lerp(min[1], max[1], iy / safeDivisions);
    for (let iz = 0; iz <= safeDivisions; iz += 1) {
      const z = lerp(min[2], max[2], iz / safeDivisions);
      appendLine(positions, [min[0], y, z], [max[0], y, z]);
    }
  }

  return new Float32Array(positions);
}

function appendLine(
  positions: number[],
  start: [number, number, number],
  end: [number, number, number],
): void {
  positions.push(start[0], start[1], start[2], end[0], end[1], end[2]);
}

function lerp(start: number, end: number, factor: number): number {
  return start + (end - start) * factor;
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
  materialProfile,
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
  materialProfile: Viewport3DMaterialProfile;
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
          materialProfile={materialProfile}
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
  materialProfile,
}: {
  bounds: Viewport3DBounds | null;
  colors: Viewport3DColors;
  materialProfile: Viewport3DMaterialProfile;
}) {
  return (
    <BoundsBox
      bounds={bounds}
      color={colors.accent}
      opacity={materialProfile.selectionShell.opacity}
    />
  );
}
