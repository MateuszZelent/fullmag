import type {
  ExplorerNode,
  ExplorerNodeStatus,
  ExplorerTabId,
  ModelTreeSnapshot,
} from "../explorerTypes";
import { isVisualizationAirboxIdentity } from "@/kernel/selection/selectionTypes";
import { isFdmDomain } from "@/shared/domain/mesh/domainPresentation";

import { buildCrossSectionNodes } from "./crossSectionExplorerNodes";
import {
  buildFrequencyDomainDiagnosticsNode,
  buildFrequencyDomainJobsNode,
  buildPeriodicPairsResourceNode,
  buildFrequencyDomainResourceNodes,
  buildFrequencyDomainResultNode,
  type ExplorerTreeResources,
} from "./frequencyDomainExplorerNodes";
import { buildStudyNodes } from "./study/studyExplorerNodes";
import { buildPhysicsGraphTree } from "./physicsGraphTree";
import {
  buildBoundaryFacesNode,
  buildFdmAirboxNode,
  buildFemAirboxNode,
} from "./airboxExplorerNodes";
import {
  compactExplorerNodes,
  type ModelTreeResources,
} from "./explorerNodeContract";
import {
  buildFdmMeshPolicyNode,
  buildMeshPolicyNode,
  buildUnresolvedMeshPolicyNode,
  resolveExplorerDomainLane,
} from "./meshExplorerNodes";
import {
  buildCouplingsNode,
  buildDefinitionsNode,
  buildObjectsRootNode,
  buildPhysicsGraphUnavailableNode,
  buildSessionRootNode,
  buildUniverseNode,
} from "./modelRootNodes";
import {
  buildPhysicsFirstResultsTree,
  physicsFirstResultsSnapshotFromResources,
} from "./resultsExplorerNodes";

export { buildPlanarMonitorNodes } from "./modelRootNodes";
export { visualizationDebugNode } from "./explorerNodeContract";

export function buildModelTree(
  snapshot: ModelTreeSnapshot | null = null,
  resources: ModelTreeResources = {},
): ExplorerNode[] {
  const universe = snapshot?.universe ?? {
    id: "universe",
    label: "Universe",
    size: [2e-6, 1e-6, 5e-8] as const,
  };
  const legacyAirboxObjectPresent = (snapshot?.objects ?? []).some(
    (object) =>
      isVisualizationAirboxIdentity({
        id: object.id,
        role: object.objectRole,
      }),
  );
  const objects = (snapshot?.objects ?? []).filter(
    (object) =>
      !isVisualizationAirboxIdentity({
        id: object.id,
        role: object.objectRole,
      }),
  );
  const domainLane = resolveExplorerDomainLane(snapshot);
  const fdmPresentation = isFdmDomain(snapshot?.domainPresentation)
    ? snapshot.domainPresentation
    : null;
  const universeChildren =
    domainLane === "fdm"
      ? compactExplorerNodes([
          fdmPresentation
            ? buildFdmAirboxNode(
                fdmPresentation,
                snapshot?.domainPresentationStatus,
                snapshot?.fdmMultilayerLayout,
                snapshot?.fdmMultilayerLayoutStatus,
              )
            : null,
        ])
      : domainLane === "fem"
        ? compactExplorerNodes([
            buildFemAirboxNode(snapshot, legacyAirboxObjectPresent),
            buildBoundaryFacesNode(snapshot),
          ])
        : [];

  const physicsGraphDataPresent =
    snapshot?.physicsGraph !== undefined && snapshot?.physicsGraph !== null;
  const physicsGraphStatus = snapshot?.physicsGraphStatus;
  const physicsGraphMode =
    physicsGraphStatus === "ready" && physicsGraphDataPresent;
  const physicsGraphNodes = physicsGraphMode
    ? buildPhysicsGraphTree({
        currentTransports: resources.currentTransports,
        graph: snapshot?.physicsGraph,
        objects,
      })
    : [];
  const sessionPhysicsGraphNodes = physicsGraphNodes.filter(
    (node) => node.kind !== "object.physics.scope",
  );

  const sessionChildren: ExplorerNode[] = [
    buildDefinitionsNode(resources),
    buildUniverseNode(universe, universeChildren),
    buildObjectsRootNode(
      objects,
      resources,
      physicsGraphMode ? snapshot?.physicsGraph : null,
    ),
  ];

  const crossSectionBranch = buildCrossSectionNodes(
    snapshot?.crossSections ?? null,
  );
  if (crossSectionBranch) sessionChildren.push(crossSectionBranch);

  const couplingBranch = buildCouplingsNode(snapshot?.couplings ?? []);
  if (couplingBranch) sessionChildren.push(couplingBranch);

  if (physicsGraphMode) {
    sessionChildren.push(...sessionPhysicsGraphNodes);
  } else {
    sessionChildren.push(
      buildPhysicsGraphUnavailableNode(physicsGraphStatus ?? "idle"),
    );
  }

  sessionChildren.push(
    domainLane === "fdm"
      ? buildFdmMeshPolicyNode(
          fdmPresentation,
          snapshot?.domainMeta,
          snapshot?.domainPresentationStatus,
          snapshot?.fdmMultilayerLayout,
          snapshot?.fdmMultilayerLayoutStatus,
        )
      : domainLane === "fem"
        ? buildMeshPolicyNode(snapshot?.mesh ?? null)
        : buildUnresolvedMeshPolicyNode(snapshot?.domainPresentationStatus),
    buildStudyNodes(snapshot?.study ?? null),
  );

  return [buildSessionRootNode(sessionChildren)];
}

function branch(id: string, label: string, kind: ExplorerNode["kind"], status: ExplorerNodeStatus = "ready"): ExplorerNode {
  return {
    id,
    kind,
    label,
    parentId: null,
    icon: "folder",
    status,
    contextCommands: ["explorer.expand-all", "explorer.collapse-all"],
  };
}

export function buildExplorerTree(
  tabId: ExplorerTabId,
  resources: ExplorerTreeResources = {},
): ExplorerNode[] {
  if (tabId === "model") return buildModelTree(null, resources);
  if (tabId === "resources") {
    return [
      {
        ...branch("resources:root", "Session Resources", "resources.root"),
        children: [
          ...buildFrequencyDomainResourceNodes(
            resources.frequencyDomainManifest,
            resources.activeAnalysisFieldOverlay,
          ),
          {
            id: "resources:fields",
            kind: "resources.field",
            label: "Published fields",
            parentId: "resources:root",
            badge: "m, H_demag",
            icon: "wave",
            status: "ready",
          },
          {
            id: "resources:mesh",
            kind: "resources.mesh",
            label: "Mesh topology",
            parentId: "resources:root",
            badge: "revision 0",
            icon: "mesh",
            status: "stale",
            children: [buildPeriodicPairsResourceNode()],
          },
        ],
      },
    ];
  }
  if (tabId === "results") {
    if (!resources.currentRun) {
      if (!resources.physicsFirstResultsRequired) {
        return [{
          ...branch("results:root", "Results", "results.root"),
          children: [
            buildFrequencyDomainResultNode(
              resources.frequencyDomainManifest,
              resources.frequencyDomainBranches,
              resources.frequencyDomainDispersion,
              resources.frequencyDomainResponseSweep,
              resources.frequencyDomainSpectrum,
              resources.activeAnalysisFieldOverlay,
            ),
            {
              id: "results:field:m",
              kind: "results.field_quantity",
              label: "Magnetization",
              parentId: "results:root",
              badge: "A/m",
              icon: "wave",
              status: "ready",
            },
            ...(resources.pinnedQuickChart
              ? [{
                  badge: `${resources.pinnedQuickChart.selectedSeriesIds.length} series`,
                  chartId: resources.pinnedQuickChart.chartId,
                  displayUnits: resources.pinnedQuickChart.displayUnits,
                  icon: "wave" as const,
                  id: `results:quick-charts:${resources.pinnedQuickChart.chartId}`,
                  kind: "results.quick_chart" as const,
                  label: "Quick Chart",
                  parentId: "results:root",
                  status: "ready" as const,
                  range: resources.pinnedQuickChart.range,
                  selectedSeriesIds: resources.pinnedQuickChart.selectedSeriesIds,
                  tableId: resources.pinnedQuickChart.tableId,
                  xAxisId: resources.pinnedQuickChart.xAxisId,
                }]
              : []),
          ],
        }];
      }
      return [{
        ...branch("results:root", "Results", "results.root", "unavailable"),
        availability: "unavailable",
        executionState: "not_started",
        resourceState: "idle",
      }];
    }
    const adapted = physicsFirstResultsSnapshotFromResources({
      branches: resources.frequencyDomainBranches,
      currentRun: resources.currentRun,
      dispersion: resources.frequencyDomainDispersion,
      manifest: resources.frequencyDomainManifest,
      responseSweep: resources.frequencyDomainResponseSweep,
      spectrum: resources.frequencyDomainSpectrum,
    });
    return buildPhysicsFirstResultsTree(adapted.snapshot);
  }
  if (tabId === "jobs") {
    return [
      {
        ...branch("jobs:root", "Jobs", "jobs.root"),
        children: [
          buildFrequencyDomainJobsNode(resources),
          {
            id: "jobs:command-queue",
            kind: "jobs.command",
            label: "Command queue",
            parentId: "jobs:root",
            badge: "idle",
            icon: "activity",
            status: "ready",
          },
        ],
      },
    ];
  }

  return [
    {
      ...branch("diagnostics:root", "Diagnostics", "diagnostics.root"),
      children: [
        buildFrequencyDomainDiagnosticsNode(resources.frequencyDomainManifest),
        {
          id: "diagnostics:resources",
          kind: "diagnostics.resource",
          label: "Resource cache",
          parentId: "diagnostics:root",
          badge: "revision-driven",
          icon: "database",
          status: "ready",
        },
      ],
    },
  ];
}

export function flattenExplorerNodes(nodes: readonly ExplorerNode[]): ExplorerNode[] {
  return nodes.flatMap((node) => [
    node,
    ...flattenExplorerNodes(node.children ?? []),
  ]);
}

export function collectExplorerNodeIds(nodes: readonly ExplorerNode[]): string[] {
  return flattenExplorerNodes(nodes).map((node) => node.id);
}

export function findExplorerNodePath(
  nodes: readonly ExplorerNode[],
  nodeId: string,
): string[] | null {
  for (const node of nodes) {
    if (node.id === nodeId) return [node.id];
    const childPath = findExplorerNodePath(node.children ?? [], nodeId);
    if (childPath) return [node.id, ...childPath];
  }
  return null;
}

export function filterExplorerNodes(
  nodes: readonly ExplorerNode[],
  query: string,
  pinnedNodeId?: string | null,
): ExplorerNode[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [...nodes];

  return nodes.flatMap((node): ExplorerNode[] => {
    const childMatches = filterExplorerNodes(
      node.children ?? [],
      normalizedQuery,
      pinnedNodeId,
    );
    const selfMatches =
      node.label.toLowerCase().includes(normalizedQuery) ||
      node.kind.toLowerCase().includes(normalizedQuery) ||
      node.badge?.toLowerCase().includes(normalizedQuery);
    const pinned = node.id === pinnedNodeId;

    if (!selfMatches && !pinned && childMatches.length === 0) return [];
    return [{ ...node, children: childMatches.length ? childMatches : node.children }];
  });
}
