"use client";

import { Canvas } from "@react-three/fiber";
import { useCallback, useMemo } from "react";

import { useSelection } from "@/kernel/selection/useSelection";
import type { ModuleProps } from "@/kernel/types";
import {
  AIRBOX_VISUALIZATION_TARGET,
  resolveVisualizationSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import { useObjectVisualizationRegistry } from "@/kernel/visualization/useObjectVisualization";

import { useViewport3DColors } from "./hooks/useViewport3DColors";
import { Viewport3DScene } from "./layers/Viewport3DScene";
import {
  FULL_FIELD_QUERY,
  resolveAirboxBaseVisualizationSettings,
  resolveGlobalObjectVisualizationSettings,
  resolveViewport3DSelectionBounds,
  targetForMeshPart,
} from "./model/viewport3DTargets";
import {
  adaptFdmDomainMeta,
  adaptFemSharedDomainManifest,
  type Viewport3DMeshPart,
  type Viewport3DPartSelection,
} from "./viewport3dDomainAdapter";
import {
  buildViewport3DDiagnostics,
  useViewport3DResourceCounts,
  useViewport3DResourceTracker,
} from "./viewport3dDiagnostics";
import {
  buildViewport3DFieldRenderModel,
  buildViewport3DTopologyRenderModel,
  resolveDomainBounds,
  resolveTopologyBounds,
} from "./viewport3dRenderModel";
import {
  buildViewport3DPrimitiveRenderModel,
  resolvePrimitiveSelectionBounds,
  type Viewport3DPrimitiveObject,
} from "./viewport3dPrimitiveModel";
import {
  getViewport3DCacheStats,
  useViewport3DDomainMeta,
  useViewport3DDomainTopology,
  useViewport3DFieldVector,
  useViewport3DScene,
  useViewport3DSharedDomainManifest,
  useViewport3DVisualizationState,
} from "./viewport3dResources";
import {
  resolveHslReferenceVisible,
  useViewport3DCommandState,
} from "./viewport3dStore";
import { VIEWPORT_3D_FRAMELOOP } from "./viewport3dTypes";

export default function Viewport3DModule({
  kernel,
  moduleId,
  slotId,
}: ModuleProps) {
  const { clientReady, colors } = useViewport3DColors();
  const { selection, select, clear } = useSelection(moduleId);
  const { snapshot: objectVisualizationSnapshot } =
    useObjectVisualizationRegistry();
  const tracker = useViewport3DResourceTracker();
  const resourceCounts = useViewport3DResourceCounts(tracker);
  const commandState = useViewport3DCommandState();
  const visualizationState = useViewport3DVisualizationState();
  const quantityId = visualizationState.data?.active_quantity_id ?? "m";
  const vectorColorMode =
    visualizationState.data?.vector_style.color_mode ?? "orientation";
  const domainMeta = useViewport3DDomainMeta();
  const scene = useViewport3DScene();
  const sharedDomainManifest = useViewport3DSharedDomainManifest();
  const topology = useViewport3DDomainTopology();
  const fieldVector = useViewport3DFieldVector(quantityId, FULL_FIELD_QUERY);
  const fdmDomain = useMemo(
    () => adaptFdmDomainMeta(domainMeta.data, 120_000),
    [domainMeta.data],
  );
  const femDomain = useMemo(
    () => adaptFemSharedDomainManifest(sharedDomainManifest.data),
    [sharedDomainManifest.data],
  );
  const bounds =
    resolveTopologyBounds(topology.data) ?? resolveDomainBounds(domainMeta.data);
  const vectorScale = Math.max((bounds?.radius ?? 1) * 0.06, 1e-9);
  const topologyRenderModel = useMemo(
    () =>
      buildViewport3DTopologyRenderModel(
        topology.data,
        femDomain.magneticParts,
        femDomain.airboxParts,
      ),
    [femDomain.airboxParts, femDomain.magneticParts, topology.data],
  );
  const fieldRenderModel = useMemo(
    () =>
      buildViewport3DFieldRenderModel(
        topologyRenderModel,
        fieldVector.data,
        vectorScale,
      ),
    [fieldVector.data, topologyRenderModel, vectorScale],
  );
  const primitiveModel = useMemo(
    () =>
      buildViewport3DPrimitiveRenderModel(
        scene.data,
        sharedDomainManifest.data,
      ),
    [scene.data, sharedDomainManifest.data],
  );
  const selectionBounds =
    resolvePrimitiveSelectionBounds(selection, primitiveModel) ??
    resolveViewport3DSelectionBounds(
      selection,
      femDomain,
      bounds,
    );
  const fallbackSettings = useMemo(
    () => resolveGlobalObjectVisualizationSettings(visualizationState.data),
    [visualizationState.data],
  );
  const airboxBaseSettings = useMemo(
    () => resolveAirboxBaseVisualizationSettings(visualizationState.data),
    [visualizationState.data],
  );
  const airboxSettings = useMemo(
    () =>
      resolveVisualizationSettings(
        objectVisualizationSnapshot,
        AIRBOX_VISUALIZATION_TARGET,
        airboxBaseSettings,
      ),
    [airboxBaseSettings, objectVisualizationSnapshot],
  );
  const getPartSettings = useCallback(
    (part: Viewport3DMeshPart) =>
      resolveVisualizationSettings(
        objectVisualizationSnapshot,
        targetForMeshPart(part),
        fallbackSettings,
      ),
    [fallbackSettings, objectVisualizationSnapshot],
  );
  const getObjectSettings = useCallback(
    (object: Viewport3DPrimitiveObject) =>
      resolveVisualizationSettings(
        objectVisualizationSnapshot,
        {
          id: object.objectId,
          kind: "object",
          label: object.label,
        },
        fallbackSettings,
      ),
    [fallbackSettings, objectVisualizationSnapshot],
  );
  const selectedLabel = selection.label ?? "No selection";
  const status =
    topology.error?.message ??
    fieldVector.error?.message ??
    scene.error?.message ??
    domainMeta.error?.message ??
    sharedDomainManifest.error?.message ??
    visualizationState.error?.message ??
    topology.status;
  const domainSummary = fdmDomain
    ? `${fdmDomain.displayCellCount}/${fdmDomain.totalCells}`
    : `${femDomain.magneticParts.length}+${femDomain.airboxParts.length}`;
  const diagnostics = buildViewport3DDiagnostics({
    airboxPartCount: femDomain.airboxParts.length,
    cache: getViewport3DCacheStats(),
    fieldRevision: fieldVector.revision,
    objectCount: femDomain.objectPartIds.size,
    quantityId,
    topologyRevision: topology.revision,
    tracker: resourceCounts,
  });
  const hslReferenceVisible = resolveHslReferenceVisible(
    commandState.widgets.hslReferenceMode,
    vectorColorMode,
  );

  const onSelectDomain = useCallback(() => {
    select({
      kind: "domain",
      label: domainMeta.data?.domain_id ?? "Domain",
      nodeId: "domain",
      objectId: domainMeta.data?.domain_id ?? null,
    });
  }, [domainMeta.data?.domain_id, select]);
  const onSelectPart = useCallback(
    (partSelection: Viewport3DPartSelection) => {
      select({
        kind: partSelection.kind,
        label: partSelection.label,
        nodeId: partSelection.nodeId,
        objectId: partSelection.objectId,
      });
    },
    [select],
  );
  const onSelectObject = useCallback(
    (object: Viewport3DPrimitiveObject) => {
      select({
        kind: "object.root",
        label: object.label,
        nodeId: `model:object:${object.objectId}`,
        objectId: object.objectId,
        ref: {
          kind: "object.root",
          nodeId: `model:object:${object.objectId}`,
          objectId: object.objectId,
          type: "scene-object",
          visualizationTargetId: `object:${object.objectId}`,
        },
      });
    },
    [select],
  );

  return (
    <section
      aria-label="3D viewport"
      className="fm-viewport-3d"
      onPointerDown={() => kernel.layout.setFocusedSlot(slotId)}
    >
      <div aria-live="polite" className="fm-viewport-3d__hud">
        <span>{quantityId}</span>
        <span>{selectedLabel}</span>
        <span>{domainSummary}</span>
        <span>{status}</span>
        <span>{diagnostics}</span>
      </div>
      {clientReady && colors ? (
        <Canvas
          camera={{ fov: 42, position: [2, 1.4, 2] }}
          className="fm-viewport-3d__canvas"
          frameloop={VIEWPORT_3D_FRAMELOOP}
          gl={{
            alpha: false,
            antialias: true,
            powerPreference: "high-performance",
          }}
          onPointerMissed={() => clear()}
        >
          <Viewport3DScene
            airboxSettings={airboxSettings}
            bounds={bounds}
            cameraState={commandState.camera}
            colors={colors}
            fallbackSettings={fallbackSettings}
            femDomain={femDomain}
            fieldModel={fieldRenderModel}
            fitRevision={commandState.fitRevision}
            getObjectSettings={getObjectSettings}
            getPartSettings={getPartSettings}
            hslReferenceVisible={hslReferenceVisible}
            onSelectObject={onSelectObject}
            onSelectDomain={onSelectDomain}
            onSelectPart={onSelectPart}
            primitiveModel={primitiveModel}
            resetCameraRevision={commandState.resetCameraRevision}
            selectionBounds={selectionBounds}
            topologyModel={topologyRenderModel}
            tracker={tracker}
            vectorColorMode={vectorColorMode}
            viewCubeVisible={commandState.widgets.viewCubeVisible}
          />
        </Canvas>
      ) : (
        <div className="fm-viewport-3d__placeholder">Preparing viewport</div>
      )}
    </section>
  );
}
