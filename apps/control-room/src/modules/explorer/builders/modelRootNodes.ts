import type { PlanarMonitorCollectionResource } from "@/kernel/api/apiTypes";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
import type { PlanarMonitorDraft } from "@/kernel/workspace/crossSectionWorkspace";

import type {
  ExplorerNode,
  ExplorerNodeStatus,
  ModelTreeCouplingSnapshot,
  ModelTreeObjectSnapshot,
  ModelTreeSnapshot,
} from "../explorerTypes";
import {
  createExplorerNode,
  type ModelTreeResources,
} from "./explorerNodeContract";
import { buildObjectExplorerNode } from "./objectExplorerNodes";

function formatLength(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e-3) return `${(value * 1e3).toFixed(1)} mm`;
  if (abs >= 1e-6) return `${(value * 1e6).toFixed(1)} um`;
  return `${(value * 1e9).toFixed(1)} nm`;
}

function formatSize(size: readonly [number, number, number] | null | undefined): string {
  if (!size) return "domain";
  return size.map(formatLength).join(" x ");
}


export function buildPlanarMonitorNodes(
  resource: PlanarMonitorCollectionResource | null | undefined,
  draft: PlanarMonitorDraft | null | undefined = null,
): ExplorerNode {
  const monitors: ExplorerNode[] = (resource?.monitors ?? [])
    .map((monitor) => {
      const id = monitor.id;
      return {
        badge: monitor.operator.kind,
        contextCommands: [
          "field-map.select-monitor",
          "planar-monitor.show-frame-3d",
          "planar-monitor.duplicate",
          "planar-monitor.rename",
          "planar-monitor.delete",
          "field-map.export-data",
        ],
        contextCommandInputs: {
          "field-map.export-data": { monitorId: id },
          "field-map.select-monitor": { monitorId: id },
          "planar-monitor.delete": { monitorId: id },
          "planar-monitor.duplicate": { monitorId: id },
          "planar-monitor.rename": { monitorId: id },
          "planar-monitor.show-frame-3d": { monitorId: id },
        },
        icon: "layers" as const,
        id: `model:definitions:planar-monitors:${id}`,
        kind: "model.planar.monitor" as const,
        label: monitor.name,
        monitorId: id,
        parentId: "model:definitions:planar-monitors",
        status: "ready" as const,
      };
    });
  if (draft) {
    const preset = draft.monitor.frame.preset?.toUpperCase() ?? "ARBITRARY";
    monitors.unshift({
      badge: `${preset} ${draft.ui.previewPositionPercent}%`,
      contextCommands: ["workspace.focus-selection"],
      icon: "layers",
      id: "model:definitions:planar-monitors:draft",
      kind: "model.planar.monitor.draft",
      label: draft.monitor.name,
      parentId: "model:definitions:planar-monitors",
      status: "queued",
    });
  }
  return {
    badge: `${monitors.length}`,
    children: monitors,
    icon: "layers",
    id: "model:definitions:planar-monitors",
    kind: "model.planar.monitors",
    label: "Planar Monitors",
    parentId: "model:definitions",
    selectable: false,
    status: "ready",
  };
}


export function buildDefinitionsNode(
  resources: ModelTreeResources,
): ExplorerNode {
  return createExplorerNode({
    badge: "authoring",
    children: [
      buildPlanarMonitorNodes(
        resources.planarMonitors,
        resources.planarMonitorDraft,
      ),
    ],
    icon: "braces",
    id: "model:definitions",
    kind: "definitions.root",
    label: "Definitions",
    parentId: "model:session",
    selectable: false,
    status: "ready",
  });
}

export function buildUniverseNode(
  universe: NonNullable<ModelTreeSnapshot["universe"]>,
  children: ExplorerNode[],
): ExplorerNode {
  return createExplorerNode({
    id: "model:universe",
    kind: "universe.root",
    label: universe.label,
    parentId: "model:session",
    badge: formatSize(universe.size),
    icon: "shield",
    selectable: false,
    status: "ready",
    children,
  });
}

export function buildObjectsRootNode(
  objects: readonly ModelTreeObjectSnapshot[],
  resources: ModelTreeResources,
  physicsGraph: unknown | null,
): ExplorerNode {
  return createExplorerNode({
    id: "model:objects",
    kind: "objects.root",
    label: "Objects",
    parentId: "model:session",
    badge: `${objects.length}`,
    icon: "layers",
    selectable: false,
    status: "ready",
    children: objects.map((object) =>
      buildObjectExplorerNode(object, resources, physicsGraph),
    ),
  });
}

export function buildCouplingsNode(couplings: readonly ModelTreeCouplingSnapshot[]): ExplorerNode | null {
  if (couplings.length === 0) return null;
  return {
    id: "model:physics:couplings",
    kind: "physics.couplings",
    label: "Couplings",
    parentId: "model:session",
    badge: `${couplings.length}`,
    icon: "activity",
    status: "ready",
    contextCommands: ["workspace.focus-selection"],
    children: couplings.map((coupling) => ({
      id: `model:physics:couplings:${coupling.id}`,
      kind: "physics.coupling" as const,
      label: coupling.label,
      parentId: "model:physics:couplings",
      badge: coupling.realizationStatus ?? coupling.kind,
      icon: "activity" as const,
      couplingId: coupling.id,
      status: couplingStatus(coupling),
      contextCommands: [
        "workspace.focus-selection",
        "couplings.disable",
        "couplings.delete",
      ],
    })),
  };
}


function couplingStatus(coupling: ModelTreeCouplingSnapshot): ExplorerNodeStatus {
  if (!coupling.enabled) return "degraded";
  if (coupling.realizationStatus?.includes("requires")) return "unsupported";
  if (coupling.realizationStatus?.includes("pending")) return "warning";
  return "ready";
}

export function buildPhysicsGraphUnavailableNode(
  status: ResourceStatus,
): ExplorerNode {
  const presentation = {
    idle: { label: "Physics graph unavailable", nodeStatus: "unavailable" as const },
    loading: { label: "Loading physics graph", nodeStatus: "queued" as const },
    stale: { label: "Physics graph stale", nodeStatus: "stale" as const },
    ready: { label: "Physics graph unavailable", nodeStatus: "unavailable" as const },
    error: { label: "Physics graph unavailable", nodeStatus: "failed" as const },
  }[status];
  return createExplorerNode({
    id: "model:physics:unresolved",
    kind: "physics.scope.unresolved",
    label: presentation.label,
    parentId: "model:session",
    badge: "graph resource",
    icon: "activity",
    selectable: false,
    status: presentation.nodeStatus,
  });
}

export function buildSessionRootNode(children: ExplorerNode[]): ExplorerNode {
  return createExplorerNode({
    id: "model:session",
    kind: "session.root",
    label: "Session Model",
    parentId: null,
    badge: "ProblemIR",
    icon: "folder",
    selectable: false,
    status: "ready",
    contextCommands: ["explorer.expand-all", "explorer.collapse-all"],
    children,
  });
}
