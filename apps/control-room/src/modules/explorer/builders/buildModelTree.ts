import type {
  ExplorerNode,
  ExplorerNodeStatus,
  ExplorerTabId,
  ModelTreeObjectSnapshot,
  ModelTreePhysicsInteractionSnapshot,
  ModelTreeStudyStageSnapshot,
  ModelTreeSnapshot,
} from "../explorerTypes";

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
    ],
  };
}

function regionsNode(
  parentId: string,
  object: ModelTreeObjectSnapshot,
): ExplorerNode {
  const regionLabel = object.region ?? object.label;
  const regionId = object.regionId ?? object.region ?? `region:${object.id}`;
  const regionTextureBadge =
    object.regionMagnetizationLabel ??
    object.regionMagnetizationKind ??
    object.regionMagnetization ??
    object.magnetizationLabel ??
    object.magnetizationKind ??
    object.magnetization ??
    "inherits object";
  const primaryRegionId = `${parentId}:regions:primary`;
  return {
    id: `${parentId}:regions`,
    kind: "object.regions",
    label: "Regions",
    parentId,
    badge: "1",
    icon: "layers",
    objectId: object.id,
    status: "ready",
    children: [
      {
        id: primaryRegionId,
        kind: "object.regions",
        label: regionLabel,
        parentId: `${parentId}:regions`,
        badge: object.materialLabel ?? object.material ?? "material",
        icon: "circle",
        objectId: object.id,
        regionId,
        status: "ready",
        children: [
          {
            id: `${primaryRegionId}:magnetic-texture`,
            kind: "object.region-magnetic-texture",
            label: "Magnetic Texture",
            parentId: primaryRegionId,
            badge: regionTextureBadge,
            icon: "wave",
            objectId: object.id,
            regionId,
            status:
              object.regionMagnetization || object.magnetization
                ? "ready"
                : "degraded",
          },
        ],
      },
    ],
  };
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
      kind: "object.magnetic-texture",
      label: object.magnetizationLabel ?? object.magnetization ?? "No texture assigned",
      parentId: textureParent,
      badge: object.magnetization ?? "unassigned",
      icon: "wave",
      objectId: object.id,
      status: object.magnetization ? "ready" : "degraded",
    },
  ];

  if (object.textureTransformAvailable) {
    children.push({
      id: `${textureParent}:transform`,
      kind: "object.magnetic-texture",
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
  if (mesh?.activeBuildStatus === "running" || mesh?.activeBuildStatus === "building") {
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

function meshPolicyNodes(mesh: ModelTreeSnapshot["mesh"]): ExplorerNode {
  const status = meshRootStatus(mesh);
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
        badge: mesh?.domainMeshMode ?? "solver mesh",
        icon: "mesh",
        status,
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

function formatStudyStageKind(kind: string): string {
  return kind
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function studyStageKind(kind: string): ExplorerNode["kind"] {
  const normalized = kind.toLowerCase();
  if (normalized === "relax") return "study.stage.relax";
  if (normalized === "run") return "study.stage.run";
  if (normalized === "eigenmodes") return "study.stage.eigenmodes";
  return "study.stage.action";
}

function studyStageBadge(stage: ModelTreeStudyStageSnapshot): string {
  if (stage.kind === "relax") {
    if (stage.torqueTolerance != null) return `tol ${stage.torqueTolerance}`;
    if (stage.maxSteps != null) return `${stage.maxSteps} steps`;
    return "relax";
  }
  if (stage.kind === "run") {
    if (stage.untilSeconds != null) return `${stage.untilSeconds} s`;
    if (stage.maxSteps != null) return `${stage.maxSteps} steps`;
    return "time domain";
  }
  return stage.artifactName ?? stage.kind;
}

function studyStageNode(stage: ModelTreeStudyStageSnapshot): ExplorerNode {
  const displayKind = formatStudyStageKind(stage.kind);
  const nodeStageId = stage.stageId ?? `${stage.index}`;
  return {
    id: `model:study:stage:${nodeStageId}`,
    kind: studyStageKind(stage.kind),
    label: `${displayKind} ${stage.index + 1}`,
    parentId: "model:study",
    badge: studyStageBadge(stage),
    icon: stage.kind === "relax" || stage.kind === "run" ? "play" : "activity",
    status: stage.status ?? "ready",
    contextCommands: ["study.skip", "workspace.focus-selection"],
  };
}

function studyNodes(study: ModelTreeSnapshot["study"]): ExplorerNode {
  const stages = study?.stages ?? [];
  return {
    id: "model:study",
    kind: "study.root",
    label: "Study",
    parentId: "model:session",
    badge: `${stages.length} ${stages.length === 1 ? "stage" : "stages"}`,
    icon: "play",
    status: "ready",
    contextCommands: [
      "study.add-relax-stage",
      "study.add-run-stage",
      "study.run",
      "study.pause",
      "study.resume",
      "study.stop",
      "study.skip",
      "study.compute-fields",
      "study.compute-energies",
      "study.save-checkpoint",
      "study.restore-checkpoint",
      "study.import-state",
      "study.export-state",
      "study.discard-paused-state",
    ],
    children: stages.map(studyStageNode),
  };
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

  sessionChildren.push(
    meshPolicyNodes(snapshot?.mesh ?? null),
    studyNodes(snapshot?.study ?? null),
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

export function buildExplorerTree(tabId: ExplorerTabId): ExplorerNode[] {
  if (tabId === "model") return buildModelTree();
  if (tabId === "resources") {
    return [
      {
        ...branch("resources:root", "Session Resources", "resources.root"),
        children: [
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
