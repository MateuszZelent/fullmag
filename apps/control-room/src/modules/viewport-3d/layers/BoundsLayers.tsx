"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useId, useMemo, memo } from "react";
import { BufferAttribute, BufferGeometry } from "three";
import type { ColorRepresentation } from "three";
import {
  RENDER_POLICIES,
  type RenderSemantic,
  materialPolicyProps,
} from "./viewport3DRenderPolicy";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import {
  viewport3DFieldColorLayersEnabledFromBrowserConfig,
  viewport3DVectorLayersEnabledFromBrowserConfig,
} from "@/kernel/browserFullmagConfig";

import { createViewport3DGpuUploadManager } from "../build-engine/gpu/viewport3dGpuUploadManager";
import {
  resolveMeshPartBounds,
  selectionForMeshPart,
  type Viewport3DMeshPart,
  type Viewport3DPartSelection,
} from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import {
  canApplyVertexScalarColorBuffer,
} from "../viewport3dGeometryColors";
import { useViewport3DGeometryUpload } from "../hooks/useViewport3DGeometryUpload";
import { useViewport3DScalarColorUpload } from "../hooks/useViewport3DScalarColorUpload";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import { createViewport3DIndexedPointGeometry } from "../viewport3dPointGeometry";
import { attachViewport3DSharedTopologyPosition } from "../viewport3dSharedTopologyPositions";
import {
  isViewport3DTopologyCurrent,
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
import type { FdmUniverseOutsideSupportOverlayModel } from "../model/fdmUniverseOverlay";
import type { FdmMultilayerAirboxRenderView } from "../viewport3dDomainAdapter";
import { resolveFdmMultilayerAirboxBoundsOverlay } from "../model/viewport3DFdmMultilayerAirboxOverlay";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import { VectorFieldLayer } from "./VectorFieldLayer";
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer";
import {
  recordMeshPartSurfaceAdoption,
  resolveMeshPartSurfacePickIdentity,
} from "./MeshPartLayer";
import type { Viewport3DRenderAdoptionRegistry } from "../model/viewport3DRenderAdoptionRegistry";
import {
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
import {
  resolveViewport3DSelectionRenderPlan,
  resolveViewport3DTargetRenderPlan,
} from "./viewport3DTargetRenderPlan";
import { resolveViewport3DTargetLayerRequestedSourceIdentity } from "./viewport3DLayerPassInputs";
import {
  resolveViewport3DTargetSurfaceLayerInput,
  resolveViewport3DTargetVectorLayerInput,
} from "./viewport3DLayerPassInputs";
import {
  VIEWPORT_3D_PICK_PRIORITY,
  viewport3DPickShouldDefer,
} from "./viewport3DPickPriority";

export interface AirboxSurfaceColorState {
  hasScalarColors: boolean;
  materialColor: ColorRepresentation;
  scalarColors: ScalarColorBuffer | null;
  vertexColorsEnabled: boolean;
}

const AIRBOX_MESH_PART_GEOMETRY_UPLOAD_FRAME_BUDGET_MS = 3;

export function resolveAirboxMeshPartSurfacePickIdentity(
  input: Parameters<typeof resolveMeshPartSurfacePickIdentity>[0],
) {
  return resolveMeshPartSurfacePickIdentity(input);
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
  const visibleScalarColors = useViewport3DScalarColorUpload({
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
      scalarBuffer: visibleScalarColors,
    });
    const replay = () => {
      adoption = recordMeshPartSurfaceAdoption({
        carrierId: part.id,
        fieldBufferId: requestedFieldBufferId,
        ownerId: adoptionOwnerId,
        registry: adoptionRegistry,
        scalarBuffer: visibleScalarColors,
      });
    };
    const unregister = adoptionRegistry.registerCarrierAdoptionReplay(part.id, replay);
    return () => {
      unregister();
      adoptionRegistry.clearAdoption(adoptionOwnerId, adoption);
    };
  }, [adoptionOwnerId, adoptionRegistry, part.id, requestedFieldBufferId, visibleScalarColors]);

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
        renderPlan.vectors.visible ? (
          <VectorFieldLayer
            adoptionRegistry={adoptionRegistry}
            buildReference={vectorLayerInput.buildReference}
            carrierId={part.id}
            colors={colors}
            colorMode={vectorColorModeFromSettings(renderSettings, vectorColorMode)}
            materialProfile={materialProfile.glyphs}
            opacity={renderPlan.vectors.opacity}
            fieldBufferId={requestedFieldBufferId}
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
          materialProfile={materialProfile.glyphs}
          opacity={renderPlan.vectors.opacity}
          fieldBufferId={requestedFieldBufferId}
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
  const runtimeSettings = resolveAirboxRuntimeVisualizationSettings(settings);
  if (isViewport3DTopologyCurrent(topologyFreshness)) {
    return runtimeSettings;
  }

  return {
    ...resolveUnavailableTopologyVisualizationSettings(runtimeSettings),
    geometryScope: runtimeSettings.geometryScope,
  };
}

export function resolveAirboxRuntimeVisualizationSettings(
  settings: VisualizationTargetSettings,
): VisualizationTargetSettings {
  const renderMode = settings.pointsVisible
    ? "points"
    : settings.wireframeVisible
      ? "wireframe"
      : "off";
  if (
    !settings.shaderVisible &&
    settings.surfaceColorSource === "solid" &&
    !settings.viewportColorbarVisible &&
    settings.renderMode === renderMode
  ) {
    return settings;
  }
  return {
    ...settings,
    renderMode,
    shaderVisible: false,
    surfaceColorSource: "solid",
    viewportColorbarVisible: false,
  };
}

export function resolveAirboxSurfaceColorState(
  settings: VisualizationTargetSettings,
  fieldModel: (
    Pick<Viewport3DFieldRenderModel, "scalarColorsByMode"> &
      Partial<Pick<Viewport3DFieldRenderModel, "targetPasses">>
  ) | null,
  partId: string,
  nodeCount: number,
  fallbackColor: ColorRepresentation,
): AirboxSurfaceColorState {
  const scalarColorMode = surfaceScalarColorModeFromSettings(settings);
  const scalarColors: ScalarColorBuffer | null =
    resolveViewport3DTargetSurfaceLayerInput({
      fieldModel,
      partId,
      scalarColorMode,
    }).scalarColors;
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
 * edge volume grid come exclusively from the published target carrier.
 */
export const FdmMultilayerAirboxBoundsLayer = memo(
  function FdmMultilayerAirboxBoundsLayer({
    colors,
    onSelect,
    tracker,
    view,
  }: {
    colors: Viewport3DColors;
    onSelect: () => void;
    tracker: Viewport3DResourceTracker;
    view: FdmMultilayerAirboxRenderView | null;
  }) {
    const overlay = resolveFdmMultilayerAirboxBoundsOverlay(view);
    if (!overlay) return null;
    const settings = view?.settings;
    if (!settings) return null;
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
