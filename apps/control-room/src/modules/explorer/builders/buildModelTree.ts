import type {
  ExplorerNode,
  ExplorerNodeStatus,
  ExplorerTabId,
  ModelTreeObjectSnapshot,
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
      {
        id: `${parentId}:physics`,
        kind: "object.physics",
        label: "Physics",
        parentId,
        badge: object.magnetization ?? "default",
        icon: "activity",
        objectId,
        status: "ready",
        contextCommands: ["workspace.focus-selection"],
      },
      {
        id: `${parentId}:material`,
        kind: "object.material",
        label: "Material",
        parentId,
        badge: object.material ?? "unassigned",
        icon: "magnet",
        objectId,
        status: object.material ? "ready" : "degraded",
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

const DEFAULT_OBJECTS: ModelTreeObjectSnapshot[] = [
  {
    id: "free-layer",
    label: "Free layer",
    geometryKind: "thin film",
    material: "Permalloy",
    meshStatus: "ready",
  },
  {
    id: "reference-layer",
    label: "Reference layer",
    geometryKind: "ellipse",
    material: "CoFeB",
    meshStatus: "ready",
  },
];

export function buildModelTree(snapshot: ModelTreeSnapshot | null = null): ExplorerNode[] {
  const universe = snapshot?.universe ?? {
    id: "universe",
    label: "Universe",
    size: [2e-6, 1e-6, 5e-8] as const,
  };
  const objects = snapshot?.objects ?? DEFAULT_OBJECTS;

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
      children: [
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
        {
          id: "model:materials",
          kind: "materials.root",
          label: "Materials",
          parentId: "model:session",
          badge: "2",
          icon: "magnet",
          status: "ready",
          children: [
            {
              id: "model:material:permalloy",
              kind: "material.entry",
              label: "Permalloy",
              parentId: "model:materials",
              badge: "Ms, Aex",
              icon: "circle",
              status: "ready",
            },
            {
              id: "model:material:cofeb",
              kind: "material.entry",
              label: "CoFeB",
              parentId: "model:materials",
              badge: "anisotropy",
              icon: "circle",
              status: "ready",
            },
          ],
        },
        {
          id: "model:physics",
          kind: "physics.root",
          label: "Physics",
          parentId: "model:session",
          badge: "LLG",
          icon: "sparkles",
          status: "ready",
          children: [
            {
              id: "model:physics:exchange",
              kind: "physics.interaction",
              label: "Exchange",
              parentId: "model:physics",
              badge: "active",
              icon: "activity",
              status: "ready",
            },
            {
              id: "model:physics:demag",
              kind: "physics.interaction",
              label: "Demagnetization",
              parentId: "model:physics",
              badge: "active",
              icon: "activity",
              status: "ready",
            },
          ],
        },
        {
          id: "model:mesh",
          kind: "mesh.root",
          label: "Mesh Policy",
          parentId: "model:session",
          badge: "shared domain",
          icon: "mesh",
          status: "ready",
        },
        {
          id: "model:study",
          kind: "study.root",
          label: "Study",
          parentId: "model:session",
          badge: "2 stages",
          icon: "play",
          status: "ready",
          children: [
            {
              id: "model:study:relax",
              kind: "study.stage.relax",
              label: "Relax",
              parentId: "model:study",
              badge: "stop criteria",
              icon: "play",
              status: "ready",
            },
            {
              id: "model:study:run",
              kind: "study.stage.run",
              label: "Run",
              parentId: "model:study",
              badge: "time domain",
              icon: "play",
              status: "ready",
            },
          ],
        },
      ],
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
