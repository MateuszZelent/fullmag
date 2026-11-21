"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useId, useMemo, memo } from "react";
import { BufferAttribute, BufferGeometry } from "three";
import type { ColorRepresentation } from "three";
import { RENDER_POLICIES, type RenderSemantic, materialPolicyProps } from "./viewport3DRenderPolicy";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import type { SessionResourceIdentity } from "@/kernel/resources/sessionResourceIdentity";
import {
  viewport3DFieldColorLayersEnabledFromBrowserConfig,
  viewport3DVectorLayersEnabledFromBrowserConfig,
} from "@/kernel/browserFullmagConfig";

import { createViewport3DGpuUploadManager } from "../build-engine/gpu/viewport3dGpuUploadManager";
import { resolveMeshPartBounds, selectionForMeshPart, type Viewport3DMeshPart, type Viewport3DPartSelection } from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";

import { useViewport3DGeometryUpload } from "../hooks/useViewport3DGeometryUpload";
import { useViewport3DScalarColorUpload } from "../hooks/useViewport3DScalarColorUpload";

import { createViewport3DIndexedPointGeometry } from "../viewport3dPointGeometry";
import { attachViewport3DSharedTopologyPosition } from "../viewport3dSharedTopologyPositions";
import { type Viewport3DTopologyFreshness } from "../viewport3dTopologyStaleness";
import type { Viewport3DBounds, Viewport3DFieldRenderModel, Viewport3DTopologyPartRenderModel, Viewport3DTopologyRenderModel } from "../viewport3dRenderModel";
import { buildLineIndexGeometry } from "../viewport3dSurfaceEdges";
import type { Viewport3DColors } from "../viewport3dTypes";
import type { FdmUniverseOutsideSupportOverlayModel } from "../model/fdmUniverseOverlay";
import type { FdmMultilayerAirboxRenderView } from "../viewport3dDomainAdapter";
import {
  resolveFdmMultilayerAirboxBoundsOverlay,
  resolveFdmMultilayerAuthoredAirboxBoundsOverlay,
} from "../model/viewport3DFdmMultilayerAirboxOverlay";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import { ComplexGlyphPassLayer } from "./ComplexVectorGlyphLayer";
import { VectorFieldLayer } from "./VectorFieldLayer";
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer.model";
import { recordMeshPartSurfaceAdoption } from "./MeshPartLayer.model";
import type { Viewport3DRenderAdoptionRegistry } from "../model/viewport3DRenderAdoptionRegistry";
import { percentToUnit, pointColorFromSettings, shaderColorFromSettings, surfaceMaterialColorFromSettings, vectorColorModeFromSettings, vectorStyleFromSettings, wireframeColorFromSettings } from "./viewport3DLayerSettings";
import {
  resolveViewport3DSelectionRenderPlan,
  resolveViewport3DTargetRenderPlan,
} from "./viewport3DTargetRenderPlan";
import { resolveViewport3DTargetLayerRequestedSourceIdentity } from "./viewport3DLayerPassInputs";
import { resolveViewport3DTargetVectorLayerInput } from "./viewport3DLayerPassInputs";
import {
  VIEWPORT_3D_PICK_PRIORITY,
  viewport3DPickShouldDefer,
} from "./viewport3DPickPriority";
import { buildBoundsVolumeWireframePositions, resolveAirboxTopologyVisualizationSettings, resolveAirboxWireframeEdgeIndices, resolveAirboxWireframeSemantic, resolveAirboxSurfaceColorState, resolveAirboxMeshPartSurfacePickIdentity, getUniqueSortedIndices, resolveAirboxRuntimeVisualizationSettings } from "./BoundsLayers.model";

const AIRBOX_MESH_PART_GEOMETRY_UPLOAD_FRAME_BUDGET_MS = 3;

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

export function BoundsVolumeWireframe({
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
  adoptionRegistry,
  colors,
  sessionIdentity,
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
  adoptionRegistry?: Viewport3DRenderAdoptionRegistry;
  colors: Viewport3DColors;
  sessionIdentity?: SessionResourceIdentity | null;
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
  const renderPlan = resolveViewport3DTargetRenderPlan(
    renderSettings,
    materialProfile,
  );
  const topologyUploadManager = useMemo(
    () =>
      createViewport3DGpuUploadManager({
        policy: {
          targetFrameBudgetMs: AIRBOX_MESH_PART_GEOMETRY_UPLOAD_FRAME_BUDGET_MS,
        },
      }),
    [],
  );
  useEffect(() => () => topologyUploadManager.dispose(), [topologyUploadManager]);

  const part = partModel.part;
  const topologyRevision = topologyModel.meshRevision ?? null;
  const surfaceIndices = partModel.surfaceIndices;
  const createSurfaceGeometry = useCallback(() => {
    if (!surfaceIndices?.length) return null;
    const next = new BufferGeometry();
    attachViewport3DSharedTopologyPosition(next, topologyModel.positions);
    next.setIndex(new BufferAttribute(surfaceIndices, 1));
    return next;
  }, [surfaceIndices, topologyModel.positions]);
  const geometry = useViewport3DGeometryUpload({
    createGeometry: createSurfaceGeometry,
    dirtyReason: "airbox-surface",
    enabled: Boolean(surfaceIndices?.length),
    estimatedBytes:
      topologyModel.positions.byteLength + (surfaceIndices?.byteLength ?? 0),
    invalidate,
    itemCount: surfaceIndices?.length ?? 0,
    key: `airbox-surface:${part.id}:topology=${topologyRevision ?? "none"}:positions=${topologyModel.positions.byteLength}:indices=${surfaceIndices?.byteLength ?? 0}`,
    lane: "topology-index",
    targetRevision: topologyRevision === null ? null : String(topologyRevision),
    tracker,
    uploadManager: topologyUploadManager,
  });

  const edgeIndices = resolveAirboxWireframeEdgeIndices(
    renderSettings.geometryScope,
    partModel,
    renderSettings.wireframeVisible,
  );
  const createEdgeGeometry = useCallback(() => {
    const resolvedEdgeIndices = resolveAirboxWireframeEdgeIndices(
      renderSettings.geometryScope,
      {
        edgeIndices: partModel.edgeIndices,
        volumeEdgeIndices: partModel.volumeEdgeIndices,
      },
      renderSettings.wireframeVisible,
    );
    return buildLineIndexGeometry(
      topologyModel.positions,
      resolvedEdgeIndices,
    );
  }, [
    partModel.edgeIndices,
    partModel.volumeEdgeIndices,
    renderSettings.geometryScope,
    renderSettings.wireframeVisible,
    topologyModel.positions,
  ]);
  const edgeGeometry = useViewport3DGeometryUpload({
    createGeometry: createEdgeGeometry,
    dirtyReason: "airbox-wireframe",
    enabled: Boolean(renderSettings.wireframeVisible && edgeIndices?.length),
    estimatedBytes:
      topologyModel.positions.byteLength + (edgeIndices?.byteLength ?? 0),
    invalidate,
    itemCount: edgeIndices?.length ?? 0,
    key: `airbox-wireframe:${part.id}:scope=${renderSettings.geometryScope}:edge-source=${renderSettings.geometryScope === "full" ? "volumeEdges" : "surfaceEdges"}:render-semantic=${resolveAirboxWireframeSemantic(renderSettings)}:topology=${topologyRevision ?? "none"}:positions=${topologyModel.positions.byteLength}:indices=${edgeIndices?.byteLength ?? 0}`,
    lane: "topology-index",
    targetRevision: topologyRevision === null ? null : String(topologyRevision),
    tracker,
    uploadManager: topologyUploadManager,
  });

  const createPointsGeometry = useCallback(() => {
    if (!renderSettings.pointsVisible) return null;
    const selection = resolveAirboxPointSelection(
      renderSettings.geometryScope,
      partModel,
    );
    return createViewport3DIndexedPointGeometry(topologyModel, selection);
  }, [
    partModel,
    renderSettings.geometryScope,
    renderSettings.pointsVisible,
    topologyModel,
  ]);
  const pointsGeometry = useViewport3DGeometryUpload({
    createGeometry: createPointsGeometry,
    dirtyReason: "airbox-points",
    enabled: renderPlan.points.visible,
    estimatedBytes:
      topologyModel.positions.byteLength +
      airboxPointSelectionEstimatedBytes(partModel),
    invalidate,
    itemCount: airboxPointSelectionCount(
      renderSettings.geometryScope,
      partModel,
      topologyModel.nodeCount,
    ),
    key: `airbox-points:${part.id}:scope=${renderSettings.geometryScope}:topology=${topologyRevision ?? "none"}:positions=${topologyModel.positions.byteLength}:selection=${airboxPointSelectionRevision(renderSettings.geometryScope, partModel, topologyModel.nodeCount)}`,
    lane: "topology-index",
    targetRevision: topologyRevision === null ? null : String(topologyRevision),
    tracker,
    uploadManager: topologyUploadManager,
  });

  const opacity = renderPlan.surface.opacity;
  const airboxWireframeSemantic =
    resolveAirboxWireframeSemantic(renderSettings);
  const fieldColorLayersEnabled =
    viewport3DFieldColorLayersEnabledFromBrowserConfig();
  const surfaceColorState = resolveAirboxSurfaceColorState(
    renderSettings,
    fieldColorLayersEnabled ? fieldModel : null,
    part.id,
    topologyModel.nodeCount,
    colors.mesh,
  );
  const visibleScalarColorsUpload = useViewport3DScalarColorUpload({
    colorBuffer: surfaceColorState.scalarColors,
    dirtyReason: "airbox-field-colors",
    enabled: Boolean(
      geometry && renderPlan.surface.visible && fieldColorLayersEnabled,
    ),
    geometry,
    invalidate,
    targetRevision: surfaceColorState.scalarColors?.targetRevision ?? null,
    tracker,
    uploadKey:
      surfaceColorState.scalarColors?.buildKey ??
      `airbox-surface-colors:${part.id}:${topologyModel.nodeCount}`,
    vertexColorsEnabled: surfaceColorState.vertexColorsEnabled,
    vertexCount: topologyModel.nodeCount,
  });
  const visibleScalarColors = visibleScalarColorsUpload.buffer;
  const requestedFieldBufferId = resolveViewport3DTargetLayerRequestedSourceIdentity({
    fieldModel,
    partId: part.id,
  }).fieldBufferId;
  const adoptionOwnerId = `airbox-mesh-surface:${useId()}`;
  useEffect(() => {
    if (!adoptionRegistry || !visibleScalarColors) return;
    let adoption = recordMeshPartSurfaceAdoption({
      carrierId: part.id,
      fieldBufferId: requestedFieldBufferId,
      ownerId: adoptionOwnerId,
      registry: adoptionRegistry,
      sessionIdentity,
      scalarBuffer: visibleScalarColors,
    });
    const replay = () => {
      adoption = recordMeshPartSurfaceAdoption({
        carrierId: part.id,
        fieldBufferId: requestedFieldBufferId,
        ownerId: adoptionOwnerId,
        registry: adoptionRegistry,
        sessionIdentity,
        scalarBuffer: visibleScalarColors,
      });
    };
    const unregister = adoptionRegistry.registerCarrierAdoptionReplay(part.id, replay);
    return () => {
      unregister();
      adoptionRegistry.clearAdoption(adoptionOwnerId, adoption);
    };
  }, [adoptionOwnerId, adoptionRegistry, part.id, requestedFieldBufferId, sessionIdentity, visibleScalarColors]);

  const hasScalarColors =
    surfaceColorState.hasScalarColors &&
    visibleScalarColors === surfaceColorState.scalarColors;

  const materialColor = surfaceMaterialColorFromSettings(
    renderSettings,
    colors.mesh,
    hasScalarColors,
  );
  const vectorLayerInput = resolveViewport3DTargetVectorLayerInput({
    fieldModel,
    partId: part.id,
  });

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (
      viewport3DPickShouldDefer(
        event.intersections,
        VIEWPORT_3D_PICK_PRIORITY.airbox,
      )
    ) {
      return;
    }
    event.stopPropagation();
    const identity = resolveAirboxMeshPartSurfacePickIdentity({
      expandedSurfaceFaces: false,
      faceIndex: event.faceIndex,
      part,
      surfaceHit: event.object.userData.viewportAirboxMeshPartSurface === true,
      surfaceTriangleCellTypes: partModel.surfaceTriangleCellTypes,
      surfaceTriangleFacetIndices: partModel.surfaceTriangleFacetIndices,
      surfaceTriangleGlobalCellOrdinals:
        partModel.surfaceTriangleGlobalCellOrdinals,
    });
    onSelectPart(
      selectionForMeshPart(
        part,
        identity.boundaryFaceIndex,
        identity.globalCellOrdinal,
        identity.elementFamily,
      ),
    );
  };
  if (!geometry) {
    return (
      <group
        onPointerDown={handlePointerDown}
        userData={{ viewportSemanticPickPriority: VIEWPORT_3D_PICK_PRIORITY.airbox }}
      >
        {renderPlan.surface.visible ? (
          <BoundsBox
            bounds={resolveMeshPartBounds(part)}
            color={shaderColorFromSettings(renderSettings, colors.accent)}
            opacity={opacity}
            wireframe={false}
          />
        ) : null}
        {renderPlan.wireframe.visible && (
          <>
            {edgeGeometry && (
              <lineSegments
                geometry={edgeGeometry}
                renderOrder={RENDER_POLICIES[airboxWireframeSemantic].renderOrder}
              >
                <lineBasicMaterial
                  color={wireframeColorFromSettings(renderSettings, colors.wire)}
                  opacity={renderPlan.wireframe.opacity}
                  {...materialPolicyProps(airboxWireframeSemantic)}
                />
              </lineSegments>
            )}
            {!edgeGeometry && (
              <AirboxWireframeFallback
                bounds={resolveMeshPartBounds(part)}
                color={wireframeColorFromSettings(renderSettings, colors.wire)}
                opacity={renderPlan.wireframe.opacity}
                policySemantic={airboxWireframeSemantic}
                settings={renderSettings}
                tracker={tracker}
              />
            )}
          </>
        )}

        {renderPlan.bounds.visible ? (
          <BoundsBox
            bounds={resolveMeshPartBounds(part)}
            color={colors.accent}
            opacity={renderPlan.bounds.opacity}
            policySemantic="hiddenEdges"
          />
        ) : null}
        {renderPlan.points.visible ? (
          pointsGeometry ? (
            <points
              geometry={pointsGeometry}
              renderOrder={RENDER_POLICIES.points.renderOrder}
            >
              <pointsMaterial
                color={pointColorFromSettings(renderSettings, colors.wire)}
                opacity={renderPlan.points.opacity}
                sizeAttenuation={false}
                size={3}
                {...materialPolicyProps("points")}
              />
            </points>
          ) : (
            <BoundsPoints
              bounds={resolveMeshPartBounds(part)}
              color={pointColorFromSettings(renderSettings, colors.wire)}
              opacity={renderPlan.points.opacity}
            />
          )
        ) : null}
        {viewport3DVectorLayersEnabledFromBrowserConfig() &&
        renderPlan.vectors.visible &&
        vectorLayerInput.complexGlyphs ? (
          <ComplexGlyphPassLayer
            adoptionRegistry={adoptionRegistry}
            carrierId={part.id}
            fallbackColor={String(colors.field)}
            fieldBufferId={requestedFieldBufferId}
            opacity={renderPlan.vectors.opacity}
            pass={vectorLayerInput.complexGlyphs}
            sessionIdentity={sessionIdentity}
            style={vectorStyleFromSettings(renderSettings, vectorStyle)}
            tracker={tracker}
          />
        ) : viewport3DVectorLayersEnabledFromBrowserConfig() &&
        renderPlan.vectors.visible ? (
          <VectorFieldLayer
            adoptionRegistry={adoptionRegistry}
            buildReference={vectorLayerInput.buildReference}
            carrierId={part.id}
            colors={colors}
            colorMode={vectorColorModeFromSettings(renderSettings, vectorColorMode)}
            glyphColorsOverride={vectorLayerInput.glyphColors}
            colorScale={vectorLayerInput.colorScale}
            materialProfile={materialProfile.glyphs}
            opacity={renderPlan.vectors.opacity}
            fieldBufferId={requestedFieldBufferId}
            sessionIdentity={sessionIdentity}
            segments={vectorLayerInput.segments}
            style={vectorStyleFromSettings(renderSettings, vectorStyle)}
            tracker={tracker}
          />
        ) : null}
      </group>
    );
  }

  return (
    <group
      onPointerDown={handlePointerDown}
      userData={{ viewportSemanticPickPriority: VIEWPORT_3D_PICK_PRIORITY.airbox }}
    >
      {renderPlan.surface.visible ? (
        <mesh
          geometry={geometry}
          renderOrder={RENDER_POLICIES.airSurface.renderOrder}
          userData={{ viewportAirboxMeshPartSurface: true }}
        >
          <meshBasicMaterial
            color={materialColor}
            opacity={opacity}
            toneMapped={materialProfile.airSurface.toneMapped}
            vertexColors={hasScalarColors}
            {...materialPolicyProps("airSurface")}
          />
        </mesh>
      ) : null}
      {renderPlan.wireframe.visible && (
        <>
          {edgeGeometry && (
            <lineSegments
              geometry={edgeGeometry}
              renderOrder={RENDER_POLICIES[airboxWireframeSemantic].renderOrder}
            >
              <lineBasicMaterial
                color={wireframeColorFromSettings(renderSettings, colors.wire)}
                opacity={renderPlan.wireframe.opacity}
                {...materialPolicyProps(airboxWireframeSemantic)}
              />
            </lineSegments>
          )}
          {!edgeGeometry && (
            <AirboxWireframeFallback
              bounds={resolveMeshPartBounds(part)}
              color={wireframeColorFromSettings(renderSettings, colors.wire)}
              opacity={renderPlan.wireframe.opacity}
              policySemantic={airboxWireframeSemantic}
              settings={renderSettings}
              tracker={tracker}
            />
          )}
        </>
      )}
      {renderPlan.bounds.visible ? (
        <BoundsBox
          bounds={resolveMeshPartBounds(part)}
          color={colors.accent}
          opacity={renderPlan.bounds.opacity}
          policySemantic="hiddenEdges"
        />
      ) : null}
      {renderPlan.points.visible ? (
        pointsGeometry ? (
          <points
            geometry={pointsGeometry}
            renderOrder={RENDER_POLICIES.points.renderOrder}
          >
            <pointsMaterial
              color={pointColorFromSettings(renderSettings, colors.wire)}
              opacity={renderPlan.points.opacity}
              sizeAttenuation={false}
              size={3}
              {...materialPolicyProps("points")}
            />
          </points>
        ) : (
          <BoundsPoints
            bounds={resolveMeshPartBounds(part)}
            color={pointColorFromSettings(renderSettings, colors.wire)}
            opacity={renderPlan.points.opacity}
          />
        )
      ) : null}
      {viewport3DVectorLayersEnabledFromBrowserConfig() &&
      renderPlan.vectors.visible ? (
        <VectorFieldLayer
          adoptionRegistry={adoptionRegistry}
          buildReference={vectorLayerInput.buildReference}
          carrierId={part.id}
          colors={colors}
          colorMode={vectorColorModeFromSettings(renderSettings, vectorColorMode)}
          glyphColorsOverride={vectorLayerInput.glyphColors}
          colorScale={vectorLayerInput.colorScale}
          materialProfile={materialProfile.glyphs}
          opacity={renderPlan.vectors.opacity}
          fieldBufferId={requestedFieldBufferId}
          sessionIdentity={sessionIdentity}
          segments={vectorLayerInput.segments}
          style={vectorStyleFromSettings(renderSettings, vectorStyle)}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
});

function resolveAirboxPointSelection(
  geometryScope: VisualizationTargetSettings["geometryScope"],
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>,
): Viewport3DMeshPart | { nodeIndices: Uint32Array } | null {
  if (geometryScope === "full") return partModel.part;

  const nodeIndices =
    partModel.surfaceNodeIndices ??
    (partModel.surfaceIndices ? getUniqueSortedIndices(partModel.surfaceIndices) : null);
  if (!nodeIndices?.length) return null;
  return { nodeIndices };
}

function airboxPointSelectionEstimatedBytes(
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>,
): number {
  return (
    partModel.surfaceNodeIndices?.byteLength ??
    partModel.surfaceIndices?.byteLength ??
    0
  );
}

function airboxPointSelectionCount(
  geometryScope: VisualizationTargetSettings["geometryScope"],
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>,
  nodeCount: number,
): number {
  if (geometryScope === "full") {
    return resolveAirboxFullPointSelectionCount(partModel.part, nodeCount);
  }

  return (
    partModel.surfaceNodeIndices?.length ??
    partModel.surfaceIndices?.length ??
    0
  );
}

function airboxPointSelectionRevision(
  geometryScope: VisualizationTargetSettings["geometryScope"],
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>,
  nodeCount: number,
): string {
  if (geometryScope === "full") {
    return `full:${airboxPartNodeSelectionRevision(partModel.part, nodeCount)}`;
  }

  const nodeIndices = partModel.surfaceNodeIndices;
  if (nodeIndices?.length) {
    return `surface-nodes:${nodeIndices.length}:${nodeIndices[0] ?? "none"}:${nodeIndices[nodeIndices.length - 1] ?? "none"}`;
  }

  const surfaceIndices = partModel.surfaceIndices;
  if (surfaceIndices?.length) {
    return `surface-indices:${surfaceIndices.length}:${surfaceIndices[0] ?? "none"}:${surfaceIndices[surfaceIndices.length - 1] ?? "none"}`;
  }

  return "surface:empty";
}

function airboxPartNodeSelectionRevision(
  part: Viewport3DMeshPart,
  nodeCount: number,
): string {
  const indices = airboxPartNodeIndices(part);
  if (indices?.length) {
    return `indices:${indices.length}:${indices[0] ?? "none"}:${indices[indices.length - 1] ?? "none"}`;
  }

  const start = airboxPartNodeStart(part);
  return `range:${start}:${resolveAirboxFullPointSelectionCount(part, nodeCount)}`;
}

function resolveAirboxFullPointSelectionCount(
  part: Viewport3DMeshPart,
  nodeCount: number,
): number {
  const indices = airboxPartNodeIndices(part);
  if (indices?.length) return indices.length;

  const start = airboxPartNodeStart(part);
  const rawCount = airboxPartNodeCount(part);
  const count =
    rawCount === undefined || (rawCount <= 0 && start > 0)
      ? nodeCount - start
      : Math.max(0, Math.floor(rawCount));
  if (count <= 0 || start >= nodeCount) return 0;

  return Math.min(count, nodeCount - start);
}

function airboxPartNodeIndices(
  part: Viewport3DMeshPart,
): readonly number[] | undefined {
  return (
    part.node_indices ??
    (part as Viewport3DMeshPart & { nodeIndices?: readonly number[] })
      .nodeIndices
  );
}

function airboxPartNodeStart(part: Viewport3DMeshPart): number {
  return Math.max(
    0,
    Math.floor(
      part.node_start ??
        (part as Viewport3DMeshPart & { nodeStart?: number }).nodeStart ??
        0,
    ),
  );
}

function airboxPartNodeCount(part: Viewport3DMeshPart): number | undefined {
  return (
    part.node_count ??
    (part as Viewport3DMeshPart & { nodeCount?: number }).nodeCount
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

export const DomainBoxLayer = memo(function DomainBoxLayer({
  bounds,
  boundsOpacityPercent = 35,
  boundsVisible = true,
  colors,
  onSelectDomain,
}: {
  bounds: Viewport3DBounds | null;
  boundsOpacityPercent?: number;
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
        opacity={percentToUnit(boundsOpacityPercent)}
        transparent
        wireframe
      />
    </mesh>
  );
});

/**
 * FDM universe extent is a regular-grid context overlay, never a FEM Airbox
 * topology layer. Its visibility is driven by an explicit semantic role from
 * the domain presentation; inactive membership values are not interpreted.
 */
export const FdmUniverseOutsideSupportLayer = memo(
  function FdmUniverseOutsideSupportLayer({
    colors,
    model,
    onSelect,
    settings,
    tracker,
  }: {
    colors: Viewport3DColors;
    model: FdmUniverseOutsideSupportOverlayModel | null;
    onSelect: () => void;
    settings: VisualizationTargetSettings | null;
    tracker: Viewport3DResourceTracker;
  }) {
    if (!model || !settings?.visible) return null;
    const universeBoundsOpacity = percentToUnit(
      settings.boundsOpacityPercent,
    );
    const magneticSupportWireframeOpacity = percentToUnit(
      settings.wireframeOpacityPercent,
    );
    const wireframeColor = wireframeColorFromSettings(settings, colors.accent);
    return (
      <group
        name={model.target.id}
        userData={{ semanticRole: model.kind }}
        onPointerDown={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        {settings.boundsVisible ? (
          <BoundsBox
            bounds={model.universeBounds}
            color={wireframeColor}
            opacity={universeBoundsOpacity}
            policySemantic="hiddenEdges"
          />
        ) : null}
        {settings.wireframeVisible ? (
          <>
            <BoundsVolumeWireframe
              bounds={model.universeBounds}
              color={wireframeColor}
              opacity={magneticSupportWireframeOpacity}
              policySemantic="hiddenEdges"
              tracker={tracker}
            />
            <BoundsBox
              bounds={model.magneticSupportBounds}
              color={wireframeColor}
              opacity={magneticSupportWireframeOpacity}
              policySemantic="featureEdges"
            />
          </>
        ) : null}
      </group>
    );
  },
);

export function AirboxLayerContent({
  adoptionRegistry,
  colors,
  sessionIdentity,
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
  adoptionRegistry?: Viewport3DRenderAdoptionRegistry;
  colors: Viewport3DColors;
  sessionIdentity?: SessionResourceIdentity | null;
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
          adoptionRegistry={adoptionRegistry}
          key={partModel.part.id}
          colors={colors}
          sessionIdentity={sessionIdentity}
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

/**
 * Target-only FDM multilayer Airbox extent.  This is deliberately separate
 * from the structured-universe overlay: both the bounds and the full hidden-
 * edge volume grid come exclusively from the published target carrier, or,
 * until one is published, from the authored Universe box.
 */
export const FdmMultilayerAirboxBoundsLayer = memo(
  function FdmMultilayerAirboxBoundsLayer({
    authoredUniverseBounds,
    authoredSettings,
    colors,
    onSelect,
    tracker,
    view,
  }: {
    authoredUniverseBounds: Viewport3DBounds | null;
    authoredSettings: VisualizationTargetSettings;
    colors: Viewport3DColors;
    onSelect: () => void;
    tracker: Viewport3DResourceTracker;
    view: FdmMultilayerAirboxRenderView | null;
  }) {
    const overlay =
      resolveFdmMultilayerAirboxBoundsOverlay(view) ??
      resolveFdmMultilayerAuthoredAirboxBoundsOverlay(
        view,
        authoredUniverseBounds,
        authoredSettings,
      );
    if (!overlay) return null;
    const settings = view?.settings ?? authoredSettings;
    const wireframeColor = wireframeColorFromSettings(settings, colors.accent);
    return (
      <group
        name={overlay.targetId}
        userData={{ semanticRole: "fdm-multilayer-airbox-target" }}
        onPointerDown={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        {overlay.boundsVisible ? (
          <BoundsBox
            bounds={overlay.bounds}
            color={wireframeColor}
            opacity={percentToUnit(settings.boundsOpacityPercent)}
            policySemantic="hiddenEdges"
          />
        ) : null}
        {overlay.fullWireframeVisible ? (
          <BoundsVolumeWireframe
            bounds={overlay.bounds}
            color={wireframeColor}
            opacity={percentToUnit(settings.wireframeOpacityPercent)}
            policySemantic="hiddenEdges"
            tracker={tracker}
          />
        ) : null}
      </group>
    );
  },
);

export function SelectionHighlightLayerContent({
  bounds,
  colors,
  materialProfile,
}: {
  bounds: Viewport3DBounds | null;
  colors: Viewport3DColors;
  materialProfile: Viewport3DMaterialProfile;
}) {
  const renderPlan = resolveViewport3DSelectionRenderPlan(
    Boolean(bounds),
    materialProfile.selectionShell.opacity,
  );
  if (!renderPlan.visible) return null;
  return (
    <BoundsBox
      bounds={bounds}
      color={colors.accent}
      opacity={renderPlan.opacity}
    />
  );
}

export const SelectionHighlightLayer = memo(SelectionHighlightLayerContent);
