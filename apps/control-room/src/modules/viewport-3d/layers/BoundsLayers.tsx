"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, memo } from "react";
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
  isViewport3DTopologyRenderable,
  resolveUnavailableTopologyVisualizationSettings,
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
  pointColorFromSettings,
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

const AirboxMeshPartLayer = memo(function AirboxMeshPartLayer({
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
  const renderSettings = resolvedSettings;
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
      renderSettings.geometryScope,
      partModel,
      renderSettings.wireframeVisible,
    );
    const next = buildLineIndexGeometry(topologyModel.positions, edgeIndices);
    return next ? tracker.track("geometry", next) : null;
  }, [
    partModel,
    renderSettings.geometryScope,
    renderSettings.wireframeVisible,
    topologyModel.positions,
    tracker,
  ]);
  const pointsGeometry = useMemo(() => {
    const indices = renderSettings.geometryScope === "full"
      ? resolvePartNodeIndices(partModel.part, topologyModel.nodeCount)
      : (partModel.surfaceIndices ? getUniqueSortedIndices(partModel.surfaceIndices) : null);

    if (!indices || !indices.length) return null;
    const next = tracker.track("geometry", new BufferGeometry());
    next.setAttribute("position", new BufferAttribute(topologyModel.positions, 3));
    next.setIndex(new BufferAttribute(indices, 1));
    return next;
  }, [partModel, topologyModel, renderSettings.geometryScope, tracker]);

  useEffect(() => () => tracker.release("geometry", geometry), [geometry, tracker]);
  useEffect(
    () => () => tracker.release("geometry", edgeGeometry),
    [edgeGeometry, tracker],
  );
  useEffect(
    () => () => tracker.release("geometry", pointsGeometry),
    [pointsGeometry, tracker],
  );

  const opacity = opacityFromSettings(renderSettings);
  const part = partModel.part;
  const airboxWireframeSemantic =
    resolveAirboxWireframeSemantic(renderSettings);
  const surfaceColorState = resolveAirboxSurfaceColorState(
    renderSettings,
    fieldModel,
    topologyModel.nodeCount,
    colors.mesh,
  );
  useEffect(() => {
    if (!geometry) return;
    if (!renderSettings.shaderVisible) return;
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
    renderSettings.shaderVisible,
    surfaceColorState.scalarColors,
    topologyModel.nodeCount,
    tracker,
    surfaceColorState.vertexColorsEnabled,
  ]);

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onSelectPart(selectionForMeshPart(part));
  };
  if (!geometry) {
    return (
      <group onPointerDown={handlePointerDown}>
        {renderSettings.shaderVisible ? (
          <BoundsBox
            bounds={resolveMeshPartBounds(part)}
            color={shaderColorFromSettings(renderSettings, colors.accent)}
            opacity={opacity}
            wireframe={false}
          />
        ) : null}
        {renderSettings.wireframeVisible && (
          <>
            {edgeGeometry && (
              <lineSegments
                geometry={edgeGeometry}
                renderOrder={RENDER_POLICIES[airboxWireframeSemantic].renderOrder}
              >
                <lineBasicMaterial
                  color={wireframeColorFromSettings(renderSettings, colors.wire)}
                  opacity={airboxWireframeOpacityFromSettings(
                    renderSettings,
                    materialProfile.featureEdges,
                  )}
                  {...materialPolicyProps(airboxWireframeSemantic)}
                />
              </lineSegments>
            )}
            {(renderSettings.geometryScope === "full" || !edgeGeometry) && (
              <AirboxWireframeFallback
                bounds={resolveMeshPartBounds(part)}
                color={wireframeColorFromSettings(renderSettings, colors.wire)}
                opacity={airboxWireframeOpacityFromSettings(renderSettings)}
                policySemantic={airboxWireframeSemantic}
                settings={renderSettings}
                tracker={tracker}
              />
            )}
          </>
        )}

        {renderSettings.boundsVisible ? (
          <BoundsBox
            bounds={resolveMeshPartBounds(part)}
            color={colors.accent}
            opacity={Math.max(opacity, 0.35)}
            policySemantic="hiddenEdges"
          />
        ) : null}
        {renderSettings.pointsVisible ? (
          pointsGeometry ? (
            <points
              geometry={pointsGeometry}
              renderOrder={RENDER_POLICIES.points.renderOrder}
            >
              <pointsMaterial
                color={pointColorFromSettings(renderSettings, colors.wire)}
                opacity={opacity}
                sizeAttenuation={false}
                size={3}
                {...materialPolicyProps("points")}
              />
            </points>
          ) : (
            <BoundsPoints
              bounds={resolveMeshPartBounds(part)}
              color={pointColorFromSettings(renderSettings, colors.wire)}
              opacity={opacity}
            />
          )
        ) : null}
        {renderSettings.vectorsVisible ? (
          <VectorFieldLayer
            colors={colors}
            colorMode={vectorColorModeFromSettings(renderSettings, vectorColorMode)}
            materialProfile={materialProfile.glyphs}
            opacity={opacity}
            segments={fieldModel?.partVectorSegments.get(part.id) ?? null}
            style={vectorStyleFromSettings(renderSettings, vectorStyle)}
            tracker={tracker}
          />
        ) : null}
      </group>
    );
  }

  return (
    <group onPointerDown={handlePointerDown}>
      {renderSettings.shaderVisible ? (
        <mesh
          geometry={geometry}
          renderOrder={RENDER_POLICIES.airSurface.renderOrder}
        >
          <meshBasicMaterial
            color={surfaceColorState.materialColor}
            opacity={opacity}
            toneMapped={materialProfile.airSurface.toneMapped}
            vertexColors={surfaceColorState.hasScalarColors}
            {...materialPolicyProps("airSurface")}
          />
        </mesh>
      ) : null}
      {renderSettings.wireframeVisible && (
        <>
          {edgeGeometry && (
            <lineSegments
              geometry={edgeGeometry}
              renderOrder={RENDER_POLICIES[airboxWireframeSemantic].renderOrder}
            >
              <lineBasicMaterial
                color={wireframeColorFromSettings(renderSettings, colors.wire)}
                opacity={airboxWireframeOpacityFromSettings(
                  renderSettings,
                  materialProfile.featureEdges,
                )}
                {...materialPolicyProps(airboxWireframeSemantic)}
              />
            </lineSegments>
          )}
          {(renderSettings.geometryScope === "full" || !edgeGeometry) && (
            <AirboxWireframeFallback
              bounds={resolveMeshPartBounds(part)}
              color={wireframeColorFromSettings(renderSettings, colors.wire)}
              opacity={airboxWireframeOpacityFromSettings(renderSettings)}
              policySemantic={airboxWireframeSemantic}
              settings={renderSettings}
              tracker={tracker}
            />
          )}
        </>
      )}
      {renderSettings.boundsVisible ? (
        <BoundsBox
          bounds={resolveMeshPartBounds(part)}
          color={colors.accent}
          opacity={Math.max(opacity, 0.35)}
          policySemantic="hiddenEdges"
        />
      ) : null}
      {renderSettings.pointsVisible ? (
        pointsGeometry ? (
          <points
            geometry={pointsGeometry}
            renderOrder={RENDER_POLICIES.points.renderOrder}
          >
            <pointsMaterial
              color={pointColorFromSettings(renderSettings, colors.wire)}
              opacity={opacity}
              sizeAttenuation={false}
              size={3}
              {...materialPolicyProps("points")}
            />
          </points>
        ) : (
          <BoundsPoints
            bounds={resolveMeshPartBounds(part)}
            color={pointColorFromSettings(renderSettings, colors.wire)}
            opacity={opacity}
          />
        )
      ) : null}
      {renderSettings.vectorsVisible ? (
        <VectorFieldLayer
          colors={colors}
          colorMode={vectorColorModeFromSettings(renderSettings, vectorColorMode)}
          materialProfile={materialProfile.glyphs}
          opacity={opacity}
          segments={fieldModel?.partVectorSegments.get(part.id) ?? null}
          style={vectorStyleFromSettings(renderSettings, vectorStyle)}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
});

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
  if (geometryScope === "full" && hasEdgeGeometry) return "lines";
  return hasEdgeGeometry ? "lines" : "bounds";
}

export function resolvePartNodeIndices(
  part: {
    node_start?: number;
    nodeStart?: number;
    node_count?: number;
    nodeCount?: number;
    node_indices?: readonly number[];
    nodeIndices?: readonly number[];
  },
  nodeCount: number,
): Uint32Array {
  const indices = part.node_indices ?? part.nodeIndices;
  if (indices?.length) {
    return new Uint32Array(indices);
  }
  const start = Math.max(0, Math.floor(part.node_start ?? part.nodeStart ?? 0));
  const rawCount = part.node_count ?? part.nodeCount;
  const count =
    rawCount === undefined || (rawCount <= 0 && start > 0)
      ? nodeCount - start
      : Math.max(0, Math.floor(rawCount));
  if (count <= 0 || start >= nodeCount) return new Uint32Array();

  const end = Math.min(nodeCount, start + count);
  const result = new Uint32Array(end - start);
  for (let i = 0; i < result.length; i += 1) {
    result[i] = start + i;
  }
  return result;
}

export function getUniqueSortedIndices(indices: Uint32Array): Uint32Array {
  const unique = new Set<number>();
  for (let index = 0; index < indices.length; index += 1) {
    unique.add(indices[index] ?? 0);
  }
  return new Uint32Array(Array.from(unique).sort((left, right) => left - right));
}



export function resolveAirboxTopologyVisualizationSettings(
  settings: VisualizationTargetSettings,
  topologyFreshness: Viewport3DTopologyFreshness,
): VisualizationTargetSettings {
  if (isViewport3DTopologyRenderable(topologyFreshness)) {
    return settings;
  }

  return {
    ...resolveUnavailableTopologyVisualizationSettings(settings),
    geometryScope: settings.geometryScope,
  };
}

export function resolveAirboxRuntimeVisualizationSettings(
  settings: VisualizationTargetSettings,
): VisualizationTargetSettings {
  const isLegacyWireframeOnlyMode =
    settings.visible &&
    settings.wireframeVisible &&
    !settings.shaderVisible &&
    !settings.pointsVisible &&
    !settings.vectorsVisible &&
    !settings.boundsVisible;

  if (!isLegacyWireframeOnlyMode) {
    return settings;
  }
  return {
    ...settings,
    renderMode: "surface",
    shaderVisible: true,
    wireframeVisible: false,
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
  wireframeVisible = true,
): Uint32Array | null {
  if (!wireframeVisible) return null;
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

export const DomainBoxLayer = memo(function DomainBoxLayer({
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
});

export function AirboxLayerContent({
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
  const runtimeSettings = resolveAirboxRuntimeVisualizationSettings(settings);

  const hasAnyVisibleRuntimeSubLayer =
    runtimeSettings.shaderVisible ||
    runtimeSettings.wireframeVisible ||
    runtimeSettings.pointsVisible ||
    runtimeSettings.vectorsVisible ||
    runtimeSettings.boundsVisible;

  if (!runtimeSettings.visible && !hasAnyVisibleRuntimeSubLayer) return null;

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
          settings={runtimeSettings}
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

export const AirboxLayer = memo(AirboxLayerContent);

export function SelectionHighlightLayerContent({
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

export const SelectionHighlightLayer = memo(SelectionHighlightLayerContent);
