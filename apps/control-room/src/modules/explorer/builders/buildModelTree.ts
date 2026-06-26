import type {
  ExplorerNode,
  ExplorerNodeStatus,
  ExplorerTabId,
  ModelTreeObjectSnapshot,
  ModelTreePhysicsInteractionSnapshot,
  ModelTreeCouplingSnapshot,
  ModelTreeSnapshot,
} from "../explorerTypes";

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

import { meshPipelineStatusIsActive } from "@/shared/domain/mesh/buildPipeline";
import {
  resolveMeshBuildFreshness,
  type MeshFreshnessState,
} from "@/shared/domain/mesh/meshBuildFreshness";

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

function objectNodes(object: ModelTreeObjectSnapshot): ExplorerNode {
  const objectId = object.id;
  const parentId = `model:object:${objectId}`;
  const meshStatus = object.meshStatus ?? "primitive-only";
  if (object.objectRole === "antenna") {
    return {
      id: parentId,
      kind: "object.root",
      label: object.label,
      parentId: "model:objects",
      badge: object.geometryKind ?? "antenna",
      icon: "wave",
      objectId,
      status: "ready",
      contextCommands: [
        "geometry.focus-primitive",
        "geometry.delete-object",
        "workspace.focus-selection",
        "explorer.expand-all",
        "explorer.collapse-all",
      ],
      children: [
        {
          id: `${parentId}:geometry`,
          kind: "object.geometry",
          label: "Geometry",
          parentId,
          badge: object.geometryKind ?? "unresolved",
          icon: "braces",
          objectId,
          status: "ready",
          contextCommands: ["workspace.focus-selection"],
        },
        {
          id: `${parentId}:antenna`,
          kind: "object.antenna",
          label: "Antenna",
          parentId,
          badge: "Zeeman mask",
          icon: "wave",
          objectId,
          status: "ready",
          contextCommands: ["workspace.focus-selection"],
        },
        {
          id: `${parentId}:visualization`,
          kind: "object.visualization",
          label: "Visualization",
          parentId,
          badge: "display",
          icon: "sparkles",
          objectId,
          status: "ready",
          contextCommands: ["workspace.focus-selection"],
        },
      ],
    };
  }

  return {
    id: parentId,
    kind: "object.root",
    label: object.label,
    parentId: "model:objects",
    badge: object.geometryKind ?? "object",
    icon: "box",
    objectId,
    status: meshStatus,
    contextCommands: [
      "geometry.focus-primitive",
      "geometry.delete-object",
      "mesh.build-selected",
      "workspace.focus-selection",
      "explorer.expand-all",
      "explorer.collapse-all",
    ],
    children: [
      {
        id: `${parentId}:geometry`,
        kind: "object.geometry",
        label: "Geometry",
        parentId,
        badge: object.geometryKind ?? "unresolved",
        icon: "braces",
        objectId,
        status: "ready",
        contextCommands: ["workspace.focus-selection"],
      },
      regionsNode(parentId, object),
      magneticParametersNode(parentId, object),
      {
        id: `${parentId}:magnetic-texture`,
        kind: "object.magnetic-texture",
        label: "Magnetic Texture",
        parentId,
        badge:
          object.magnetizationKind ??
          object.magnetizationLabel ??
          object.magnetization ??
          "unassigned",
        icon: "wave",
        objectId,
        status: object.magnetization ? "ready" : "degraded",
        contextCommands: ["magnetization-texture.activate-load-file"],
        children: magneticTextureChildren(parentId, object),
      },
      {
        id: `${parentId}:mesh`,
        kind: "object.mesh",
        label: "Mesh",
        parentId,
        badge: meshStatusBadge(meshStatus),
        icon: "mesh",
        objectId,
        status: meshStatus,
        contextCommands: ["mesh.build-selected", "mesh.open-object-report"],
      },
      {
        id: `${parentId}:visualization`,
        kind: "object.visualization",
        label: "Visualization",
        parentId,
        badge: "display",
        icon: "sparkles",
        objectId,
        status: "ready",
        contextCommands: ["workspace.focus-selection"],
      },
      ...objectExtensionNodes(parentId, object),
    ],
  };
}

function objectExtensionNodes(
  parentId: string,
  object: ModelTreeObjectSnapshot,
): ExplorerNode[] {
  return (object.extensions ?? []).map((extension) => ({
    id: `${parentId}:extensions:${extension.id}`,
    kind: "object.extension.topological-charge",
    label: extension.label,
    parentId,
    badge: "extension",
    icon: "activity",
    objectId: object.id,
    extensionId: extension.id,
    status: extension.status ?? "ready",
    contextCommands: ["workspace.focus-selection"],
  }));
}

function regionsNode(
  parentId: string,
  object: ModelTreeObjectSnapshot,
): ExplorerNode {
  const regions = object.regions ?? [];
  return {
    id: `${parentId}:regions`,
    kind: "object.regions",
    label: "Regions",
    parentId,
    badge: `${regions.length}`,
    icon: "layers",
    objectId: object.id,
    status: "ready",
    contextCommands: ["workspace.focus-selection", "mesh.open-regions"],
    children: regions.map((region) =>
      authoredRegionNode(`${parentId}:regions`, object, region),
    ),
  };
}

function authoredRegionNode(
  parentId: string,
  object: ModelTreeObjectSnapshot,
  region: NonNullable<ModelTreeObjectSnapshot["regions"]>[number],
): ExplorerNode {
  const nodeId = `${parentId}:${region.id}`;
  const status = region.enabled ? "ready" : "degraded";
  return {
    id: nodeId,
    kind: "object.region",
    label: region.label,
    parentId,
    badge: region.realizationStatus ?? region.source,
    icon: "circle",
    objectId: object.id,
    regionId: region.id,
    status,
    contextCommands: [
      "regions.focus",
      "regions.duplicate",
      "regions.delete",
      "regions.priority-up",
      "regions.priority-down",
      "mesh.open-region-report",
      "mesh.open-regions",
    ],
    children: [
      {
        id: `${nodeId}:geometry`,
        kind: "object.region.geometry",
        label: "Geometry",
        parentId: nodeId,
        badge: region.shapeKind ?? "selector",
        icon: "braces",
        objectId: object.id,
        regionId: region.id,
        status,
      },
      {
        id: `${nodeId}:magnetic-parameters`,
        kind: "object.region.magnetic-parameters",
        label: "Magnetic Parameters",
        parentId: nodeId,
        badge: regionMaterialBadge(region),
        icon: "magnet",
        objectId: object.id,
        regionId: region.id,
        status:
          region.materialOverrideCount > 0 || region.materialFieldCount > 0
            ? "ready"
            : "degraded",
        children: regionMaterialFieldNodes(nodeId, object, region),
      },
      {
        id: `${nodeId}:mesh`,
        kind: "object.region.mesh",
        label: "Mesh",
        parentId: nodeId,
        badge: region.meshPolicyActive ? "policy" : "inherits object",
        icon: "mesh",
        objectId: object.id,
        regionId: region.id,
        status: region.meshPolicyActive ? "ready" : "degraded",
        contextCommands: ["mesh.open-region-report", "mesh.open-regions"],
      },
      {
        id: `${nodeId}:texture`,
        kind: "object.region.texture",
        label: "Texture",
        parentId: nodeId,
        badge: region.textureOverrideActive ? "override" : "inherits object",
        icon: "wave",
        objectId: object.id,
        regionId: region.id,
        status: region.textureOverrideActive ? "ready" : "degraded",
      },
      {
        id: `${nodeId}:visualization`,
        kind: "object.region.visualization",
        label: "Visualization",
        parentId: nodeId,
        badge: "display",
        icon: "sparkles",
        objectId: object.id,
        regionId: region.id,
        status,
      },
      {
        id: `${nodeId}:regions`,
        kind: "object.region.regions",
        label: "Regions",
        parentId: nodeId,
        badge: "inherits none",
        icon: "layers",
        objectId: object.id,
        regionId: region.id,
        status: "degraded",
      },
      {
        id: `${nodeId}:diagnostics`,
        kind: "object.region.diagnostics",
        label: "Diagnostics",
        parentId: nodeId,
        badge: region.realizationPolicy ?? region.realizationStatus ?? "authored",
        icon: "gauge",
        objectId: object.id,
        regionId: region.id,
        status: region.realizationStatus ? "warning" : "ready",
      },
    ],
  };
}

function regionMaterialBadge(
  region: NonNullable<ModelTreeObjectSnapshot["regions"]>[number],
): string {
  const parts: string[] = [];
  if (region.materialOverrideCount > 0) {
    parts.push(`${region.materialOverrideCount} override`);
  }
  if (region.materialFieldCount > 0) {
    parts.push(`${region.materialFieldCount} field`);
  }
  return parts.length > 0 ? parts.join(" / ") : "inherits object";
}

function regionMaterialFieldNodes(
  parentId: string,
  object: ModelTreeObjectSnapshot,
  region: NonNullable<ModelTreeObjectSnapshot["regions"]>[number],
): ExplorerNode[] {
  return (object.materialFields ?? []).flatMap((field) =>
    field.regionId === region.id
      ? [{
      id: `${parentId}:magnetic-parameters:${field.id}`,
      kind: "object.region.magnetic-parameters" as const,
      label: field.label,
      parentId: `${parentId}:magnetic-parameters`,
      badge: field.realizationStatus ?? "field",
      icon: "settings" as const,
      objectId: object.id,
      regionId: region.id,
      status: "ready" as const,
      }]
      : [],
  );
}

function magneticParametersNode(
  parentId: string,
  object: ModelTreeObjectSnapshot,
): ExplorerNode {
  const materialLabel = object.materialLabel ?? object.material ?? "unassigned";
  const interactions = object.physicsInteractions ?? [];
  const optionalInteractionCount = interactions.filter(
    (interaction) => interaction.id !== "exchange" && interaction.id !== "demag",
  ).length;

  return {
    id: `${parentId}:magnetic-parameters`,
    kind: "object.magnetic-parameters",
    label: "Magnetic Parameters",
    parentId,
    badge: optionalInteractionCount > 0 ? `+${optionalInteractionCount}` : "core",
    icon: "magnet",
    objectId: object.id,
    status: object.material ? "ready" : "degraded",
    children: [
      {
        id: `${parentId}:magnetic-parameters:material`,
        kind: "object.material",
        label: `Material: ${materialLabel}`,
        parentId: `${parentId}:magnetic-parameters`,
        badge: materialParametersBadge(object.materialPropertyKeys ?? []),
        icon: "magnet",
        objectId: object.id,
        status: object.material ? "ready" : "degraded",
      },
      ...interactions.map((interaction) => ({
        id: `${parentId}:magnetic-parameters:${interaction.id}`,
        kind: "object.physics" as const,
        label: interaction.label,
        parentId: `${parentId}:magnetic-parameters`,
        badge: physicsInteractionBadge(interaction),
        icon: "activity" as const,
        objectId: object.id,
        status: interaction.enabledCount > 0 ? "ready" as const : "degraded" as const,
      })),
    ],
  };
}

function materialParametersBadge(keys: readonly string[]): string {
  if (keys.length === 0) return "parameters";
  return keys.slice(0, 3).join(", ");
}

function magneticTextureChildren(
  parentId: string,
  object: ModelTreeObjectSnapshot,
): ExplorerNode[] {
  const textureParent = `${parentId}:magnetic-texture`;
  const children: ExplorerNode[] = [
    {
      id: `${textureParent}:asset`,
      kind: "object.magnetic-texture.asset",
      label: object.magnetizationLabel ?? object.magnetization ?? "No texture assigned",
      parentId: textureParent,
      badge: object.magnetization ?? "unassigned",
      icon: "wave",
      objectId: object.id,
      status: object.magnetization ? "ready" : "degraded",
    },
  ];

  if (object.textureLoadEnabled) {
    children.push({
      id: `${textureParent}:load`,
      kind: "object.magnetic-texture.load",
      label: "Load texture",
      parentId: textureParent,
      badge: "h5/zarr",
      icon: "file",
      objectId: object.id,
      status: "ready",
      contextCommands: ["study.load-field-state"],
    });
  }

  if (object.textureTransformAvailable) {
    children.push({
      id: `${textureParent}:transform`,
      kind: "object.magnetic-texture.transform",
      label: "Texture Transform",
      parentId: textureParent,
      badge: "m0",
      icon: "braces",
      objectId: object.id,
      status: "ready",
    });
  }

  return children;
}

function meshStatusBadge(status: ExplorerNodeStatus): string {
  if (status === "primitive-only") return "primitive";
  if (status === "mesh-stale") return "mesh stale";
  if (status === "mesh-building") return "building";
  if (status === "mesh-ready") return "mesh ready";
  if (status === "mesh-failed") return "failed";
  if (status === "validation-blocked") return "blocked";
  if (status === "stale") return "out of date";
  return "default";
}

function meshRootStatus(mesh: ModelTreeSnapshot["mesh"]): ExplorerNodeStatus {
  if (mesh?.lastError) return "mesh-failed";
  if (meshPipelineStatusIsActive(mesh?.activeBuildStatus)) {
    return "mesh-building";
  }
  if (mesh?.meshName) return "mesh-ready";
  return "mesh-stale";
}

function meshRootBadge(mesh: ModelTreeSnapshot["mesh"]): string {
  if (mesh?.lastError) return "failed";
  if (mesh?.activeBuildStatus) return mesh.activeBuildStatus;
  if (mesh?.meshName) return mesh.meshName;
  return "not built";
}

function meshFreshnessState(mesh: ModelTreeSnapshot["mesh"]): MeshFreshnessState {
  return resolveMeshBuildFreshness({
    activeBuild: mesh?.activeBuildStatus
      ? { status: mesh.activeBuildStatus }
      : null,
    latestBuild: mesh?.latestBuildStatus
      ? {
          source_scene_revision: mesh.latestBuildSourceSceneRevision ?? null,
          status: mesh.latestBuildStatus,
        }
      : null,
    manifest: mesh?.manifestSourceSceneRevision != null
      ? { source_scene_revision: mesh.manifestSourceSceneRevision }
      : null,
    sceneRevision: mesh?.sourceSceneRevision ?? null,
    statusMeshRevision: mesh?.meshRevision ?? null,
  }).state;
}

function meshFreshnessStatus(
  freshness: MeshFreshnessState,
  fallback: ExplorerNodeStatus,
): ExplorerNodeStatus {
  if (freshness === "building") return "mesh-building";
  if (freshness === "current") return "mesh-ready";
  if (freshness === "failed") return "mesh-failed";
  if (freshness === "not-built") return "mesh-stale";
  if (freshness === "stale") return "mesh-stale";
  return fallback;
}

function meshFreshnessBadge(freshness: MeshFreshnessState): string {
  if (freshness === "not-built") return "not built";
  return freshness;
}

function meshPolicyNodes(mesh: ModelTreeSnapshot["mesh"]): ExplorerNode {
  const status = meshRootStatus(mesh);
  const freshness = meshFreshnessState(mesh);
  const sharedDomainStatus = meshFreshnessStatus(freshness, status);
  const revision = mesh?.meshRevision ?? mesh?.buildRevision ?? "none";
  const partCount = mesh?.partCount ?? 0;
  const objectSegmentCount = mesh?.objectSegmentCount ?? 0;
  const regionCount = mesh?.regionCount ?? 0;
  const sizeFieldCount = mesh?.realizedSizeFieldCount ?? 0;

  return {
    id: "model:mesh",
    kind: "mesh.root",
    label: "Mesh",
    parentId: "model:session",
    badge: meshRootBadge(mesh),
    icon: "mesh",
    status,
    contextCommands: [
      "mesh.build-shared-domain",
      "mesh.open-overview",
      "mesh.open-builds",
      "mesh.open-quality",
    ],
    children: [
      {
        id: "model:mesh:shared-domain",
        kind: "mesh.shared-domain",
        label: "Shared-Domain Solver Mesh",
        parentId: "model:mesh",
        badge: meshFreshnessBadge(freshness),
        icon: "mesh",
        status: sharedDomainStatus,
        contextCommands: ["mesh.build-shared-domain", "mesh.open-shared-domain"],
      },
      {
        id: "model:mesh:builds",
        kind: "mesh.builds",
        label: "Build Pipeline",
        parentId: "model:mesh",
        badge: `rev ${revision}`,
        icon: "activity",
        status,
        contextCommands: ["mesh.build-shared-domain", "mesh.open-builds"],
      },
      {
        id: "model:mesh:quality",
        kind: "mesh.quality",
        label: "Quality Gates",
        parentId: "model:mesh",
        badge: mesh?.qualityStatus ?? "quality",
        icon: "gauge",
        status: mesh?.qualityStatus === "failed" ? "failed" : "ready",
        contextCommands: ["mesh.open-quality"],
      },
      {
        id: "model:mesh:airbox-quality",
        kind: "airbox.mesh-quality",
        label: "Airbox Quality",
        parentId: "model:mesh",
        badge: "airbox",
        icon: "gauge",
        status,
        contextCommands: ["mesh.open-quality"],
      },
      {
        id: "model:mesh:size-fields",
        kind: "mesh.size-fields",
        label: "Realized Size Fields",
        parentId: "model:mesh",
        badge: `${sizeFieldCount}`,
        icon: "settings",
        status: sizeFieldCount > 0 ? "ready" : "stale",
        contextCommands: ["mesh.open-size-fields"],
      },
      {
        id: "model:mesh:regions",
        kind: "mesh.regions",
        label: "Regions And Mesh Parts",
        parentId: "model:mesh",
        badge: `${regionCount} regions / ${partCount} parts`,
        icon: "layers",
        status: partCount > 0 || objectSegmentCount > 0 ? "ready" : "stale",
        contextCommands: ["mesh.open-regions"],
      },
    ],
  };
}

function couplingNodes(couplings: readonly ModelTreeCouplingSnapshot[]): ExplorerNode | null {
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

function physicsInteractionBadge(
  interaction: ModelTreePhysicsInteractionSnapshot,
): string {
  if (interaction.objectCount === 0) return "default";
  if (interaction.enabledCount === interaction.objectCount) return "active";
  if (interaction.enabledCount === 0) return "disabled";
  return `${interaction.enabledCount}/${interaction.objectCount} active`;
}

export function buildModelTree(snapshot: ModelTreeSnapshot | null = null): ExplorerNode[] {
  const universe = snapshot?.universe ?? {
    id: "universe",
    label: "Universe",
    size: [2e-6, 1e-6, 5e-8] as const,
  };
  const objects = snapshot?.objects ?? [];
  const sessionChildren: ExplorerNode[] = [
    {
      id: "model:universe",
      kind: "universe.root",
      label: universe.label,
      parentId: "model:session",
      badge: formatSize(universe.size),
      icon: "shield",
      status: "ready",
      children: [
        {
          id: "model:airbox:mesh",
          kind: "airbox.mesh",
          label: "Airbox Mesh Policy",
          parentId: "model:universe",
          badge: "mesh policy",
          icon: "mesh",
          status: "ready",
          contextCommands: ["workspace.focus-selection"],
        },
        {
          id: "model:airbox:visualization",
          kind: "airbox.visualization",
          label: "Airbox Visualization",
          parentId: "model:universe",
          badge: "display",
          icon: "sparkles",
          status: "ready",
          contextCommands: ["workspace.focus-selection"],
        },
      ],
    },
    {
      id: "model:objects",
      kind: "objects.root",
      label: "Objects",
      parentId: "model:session",
      badge: `${objects.length}`,
      icon: "layers",
      status: "ready",
      children: objects.map(objectNodes),
    },
  ];

  const crossSectionBranch = buildCrossSectionNodes(
    snapshot?.crossSections ?? null,
  );
  if (crossSectionBranch) {
    sessionChildren.push(crossSectionBranch);
  }

  const couplingBranch = couplingNodes(snapshot?.couplings ?? []);
  if (couplingBranch) {
    sessionChildren.push(couplingBranch);
  }

  sessionChildren.push(
    meshPolicyNodes(snapshot?.mesh ?? null),
    buildStudyNodes(snapshot?.study ?? null),
  );

  return [
    {
      id: "model:session",
      kind: "session.root",
      label: "Session Model",
      parentId: null,
      badge: "ProblemIR",
      icon: "folder",
      status: "ready",
      contextCommands: ["explorer.expand-all", "explorer.collapse-all"],
      children: sessionChildren,
    },
  ];
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
  if (tabId === "model") return buildModelTree();
  if (tabId === "resources") {
    return [
      {
        ...branch("resources:root", "Session Resources", "resources.root"),
        children: [
          ...buildFrequencyDomainResourceNodes(resources.frequencyDomainManifest),
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
    return [
      {
        ...branch("results:root", "Results", "results.root"),
        children: [
          buildFrequencyDomainResultNode(
            resources.frequencyDomainManifest,
            resources.frequencyDomainBranches,
            resources.frequencyDomainDispersion,
            resources.frequencyDomainResponseSweep,
            resources.frequencyDomainSpectrum,
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
        ],
      },
    ];
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

export function filterExplorerNodes(
  nodes: readonly ExplorerNode[],
  query: string,
): ExplorerNode[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [...nodes];

  return nodes.flatMap((node): ExplorerNode[] => {
    const childMatches = filterExplorerNodes(node.children ?? [], normalizedQuery);
    const selfMatches =
      node.label.toLowerCase().includes(normalizedQuery) ||
      node.kind.toLowerCase().includes(normalizedQuery) ||
      node.badge?.toLowerCase().includes(normalizedQuery);

    if (!selfMatches && childMatches.length === 0) return [];
    return [{ ...node, children: childMatches.length ? childMatches : node.children }];
  });
}
