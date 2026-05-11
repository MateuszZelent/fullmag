"use client";

import { Canvas } from "@react-three/fiber";
import { useCallback, useMemo } from "react";

import { useSelection } from "@/kernel/selection/useSelection";
import type { ModuleProps } from "@/kernel/types";
import {
  AIRBOX_VISUALIZATION_TARGET,
  DEFAULT_OBJECT_VISUALIZATION,
  resolveVisualizationSettings,
  type VisualizationTargetRef,
} from "@/kernel/visualization/ObjectVisualizationController";
import { useObjectVisualizationRegistry } from "@/kernel/visualization/useObjectVisualization";

import { useViewport3DColors } from "./hooks/useViewport3DColors";
import { Viewport3DScene } from "./layers/Viewport3DScene";
import {
  adaptFdmDomainMeta,
  adaptFemSharedDomainManifest,
  resolveMeshPartBounds,
  type FemManifestRenderDomain,
  type Viewport3DMeshPart,
  type Viewport3DPartSelection,
} from "./viewport3dDomainAdapter";
import {
  buildViewport3DDiagnostics,
  useViewport3DResourceCounts,
  useViewport3DResourceTracker,
} from "./viewport3dDiagnostics";
import {
  resolveDomainBounds,
  resolveTopologyBounds,
  type Viewport3DBounds,
} from "./viewport3dRenderModel";
import {
  getViewport3DCacheStats,
  useViewport3DDomainMeta,
  useViewport3DDomainTopology,
  useViewport3DFieldVector,
  useViewport3DSharedDomainManifest,
  useViewport3DVisualizationState,
} from "./viewport3dResources";
import { useViewport3DCommandState } from "./viewport3dStore";
import { VIEWPORT_3D_FRAMELOOP } from "./viewport3dTypes";

const FULL_FIELD_QUERY = {
  component: "full",
  scope_kind: "full",
} as const;

export default function Viewport3DModule({
  kernel,
  moduleId,
  slotId,
}: ModuleProps) {
  const { clientReady, colors } = useViewport3DColors();
  const { selection, select, clear } = useSelection(moduleId);
  const { visualization } = useObjectVisualizationRegistry();
  const tracker = useViewport3DResourceTracker();
  const resourceCounts = useViewport3DResourceCounts(tracker);
  const commandState = useViewport3DCommandState();
  const visualizationState = useViewport3DVisualizationState();
  const quantityId = visualizationState.data?.active_quantity_id ?? "m";
  const domainMeta = useViewport3DDomainMeta();
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
  const selectedPartBounds = resolveMeshPartBounds(
    selection.nodeId ? femDomain.partsById.get(selection.nodeId) : null,
  );
  const selectedObjectBounds = resolveObjectBounds(femDomain, selection.objectId);
  const airboxBounds = resolveAirboxBounds(femDomain);
  const selectionBounds = selection.kind
    ? selectedPartBounds ??
      selectedObjectBounds ??
      (selection.kind === "airbox.visualization" ||
      selection.kind === "mesh-part-airbox"
        ? airboxBounds
        : bounds)
    : null;
  const vectorScale = Math.max((bounds?.radius ?? 1) * 0.06, 1e-9);
  const fallbackSettings = DEFAULT_OBJECT_VISUALIZATION;
  const airboxSettings = resolveVisualizationSettings(
    objectVisualizationSnapshot,
    AIRBOX_VISUALIZATION_TARGET,
  );
  const getPartSettings = (part: Viewport3DMeshPart) =>
    resolveVisualizationSettings(
      objectVisualizationSnapshot,
      targetForMeshPart(part),
    );
  const selectedLabel = selection.label ?? "No selection";
  const status =
    topology.error?.message ??
    fieldVector.error?.message ??
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
          gl={{ antialias: true, powerPreference: "high-performance" }}
          onPointerMissed={() => clear()}
        >
          <Viewport3DScene
            airboxSettings={airboxSettings}
            bounds={bounds}
            cameraState={commandState.camera}
            colors={colors}
            fallbackSettings={fallbackSettings}
            femDomain={femDomain}
            fieldVector={fieldVector.data}
            fitRevision={commandState.fitRevision}
            getPartSettings={getPartSettings}
            onSelectDomain={onSelectDomain}
            onSelectPart={onSelectPart}
            resetCameraRevision={commandState.resetCameraRevision}
            selectionBounds={selectionBounds}
            topology={topology.data}
            tracker={tracker}
            vectorScale={vectorScale}
          />
        </Canvas>
      ) : (
        <div className="fm-viewport-3d__placeholder">Preparing viewport</div>
      )}
    </section>
  );
}

function targetForMeshPart(part: Viewport3DMeshPart): VisualizationTargetRef {
  if (part.object_id) {
    return {
      id: part.object_id,
      kind: "object",
      label: part.label,
    };
  }

  return {
    id: part.id,
    kind: "part",
    label: part.label,
  };
}

function resolveAirboxBounds(
  domain: FemManifestRenderDomain,
): Viewport3DBounds | null {
  return combineBounds(domain.airboxParts.map(resolveMeshPartBounds));
}

function resolveObjectBounds(
  domain: FemManifestRenderDomain,
  objectId: string | null,
): Viewport3DBounds | null {
  if (!objectId) return null;
  const partIds = domain.objectPartIds.get(objectId) ?? [];
  return combineBounds(
    partIds.map((partId) => resolveMeshPartBounds(domain.partsById.get(partId))),
  );
}

function combineBounds(
  boundsList: Array<Viewport3DBounds | null>,
): Viewport3DBounds | null {
  const validBounds = boundsList.filter(
    (entry): entry is Viewport3DBounds => Boolean(entry),
  );
  if (!validBounds.length) return null;

  const min = validBounds.reduce<[number, number, number]>(
    (current, bounds) => [
      Math.min(current[0], bounds.center[0] - bounds.size[0] / 2),
      Math.min(current[1], bounds.center[1] - bounds.size[1] / 2),
      Math.min(current[2], bounds.center[2] - bounds.size[2] / 2),
    ],
    [Infinity, Infinity, Infinity],
  );
  const max = validBounds.reduce<[number, number, number]>(
    (current, bounds) => [
      Math.max(current[0], bounds.center[0] + bounds.size[0] / 2),
      Math.max(current[1], bounds.center[1] + bounds.size[1] / 2),
      Math.max(current[2], bounds.center[2] + bounds.size[2] / 2),
    ],
    [-Infinity, -Infinity, -Infinity],
  );
  const size: [number, number, number] = [
    Math.max(max[0] - min[0], 0),
    Math.max(max[1] - min[1], 0),
    Math.max(max[2] - min[2], 0),
  ];

  return {
    center: [
      min[0] + size[0] / 2,
      min[1] + size[1] / 2,
      min[2] + size[2] / 2,
    ],
    radius: Math.max(Math.hypot(size[0], size[1], size[2]) / 2, 1e-12),
    size,
  };
}
