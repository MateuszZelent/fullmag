/**
 * P3 — Geometry Builder Tree Nodes
 *
 * Builds TreeNodeData[] for the geometry builder primitives.
 * Integrates with the existing ModelTree system.
 */

import type { TreeNodeData, NodeStatus } from "@/components/panels/model-tree/types";
import type {
  GeometryGraphDocument,
  PrimitiveNode,
  BooleanNode,
  DirtyState,
  PrimitiveKind,
  BuilderSelectionTarget,
} from "../model/types";

const PRIMITIVE_ICONS: Record<PrimitiveKind, string> = {
  box: "box",
  cylinder: "cylinder",
  sphere: "sphere",
  ellipsoid: "sphere",
  disk: "disc",
  thin_film: "square",
  pillar: "cylinder",
  nanowire: "minus",
  ring: "circle-dashed",
  triangular_prism: "triangle",
  cone: "triangle",
  capsule: "pill",
  tube: "circle-dashed",
  wedge: "box",
  polygon_prism: "hexagon",
};

function primitiveStatus(
  node: PrimitiveNode,
  dirty: DirtyState,
): NodeStatus {
  if (!node.enabled) return "pending";
  if (dirty.geometryDraftDirty) return "dirty";
  return "ready";
}

function formatDimension(value: number): string {
  if (Math.abs(value) >= 1e-3) {
    return `${(value * 1e3).toFixed(1)} mm`;
  }
  if (Math.abs(value) >= 1e-6) {
    return `${(value * 1e6).toFixed(1)} μm`;
  }
  return `${(value * 1e9).toFixed(1)} nm`;
}

function primitiveBadge(node: PrimitiveNode): string {
  switch (node.params.kind) {
    case "box": {
      const [x, y, z] = node.params.data.size;
      return `${formatDimension(x)} × ${formatDimension(y)} × ${formatDimension(z)}`;
    }
    case "thin_film":
    case "nanowire":
    case "wedge": {
      const [x, y, z] = node.params.data.size;
      return `${formatDimension(x)} × ${formatDimension(y)} × ${formatDimension(z)}`;
    }
    case "cylinder":
    case "pillar":
      return `r=${formatDimension(node.params.data.radius)} h=${formatDimension(node.params.data.height)}`;
    case "sphere":
      return `r=${formatDimension(node.params.data.radius)}`;
    case "ellipsoid":
      return `r=${node.params.data.radii.map(formatDimension).join(" × ")}`;
    case "disk":
      return `r=${formatDimension(node.params.data.radius)} t=${formatDimension(node.params.data.thickness)}`;
    case "ring":
    case "tube":
      return `ro=${formatDimension(node.params.data.outerRadius)} ri=${formatDimension(node.params.data.innerRadius)}`;
    case "triangular_prism":
      return `b=${formatDimension(node.params.data.base)} h=${formatDimension(node.params.data.triangleHeight)}`;
    case "cone":
      return `r=${formatDimension(node.params.data.radiusBottom)} h=${formatDimension(node.params.data.height)}`;
    case "capsule":
      return `r=${formatDimension(node.params.data.radius)} h=${formatDimension(node.params.data.height)}`;
    case "polygon_prism":
      return `${node.params.data.sides} sides · r=${formatDimension(node.params.data.radius)}`;
  }
}

function buildPrimitiveTreeNode(
  node: PrimitiveNode,
  dirty: DirtyState,
  onSelect?: (target: BuilderSelectionTarget) => void,
): TreeNodeData {
  const nodeId = `builder-prim-${node.id}`;

  const children: TreeNodeData[] = [
    {
      id: `${nodeId}/params`,
      label: "Parameters",
      icon: "settings",
      badge: primitiveBadge(node),
    },
    {
      id: `${nodeId}/transform`,
      label: "Transform",
      icon: "move",
      badge: node.transform.translation.some((v) => v !== 0)
        ? `pos: ${node.transform.translation.map(formatDimension).join(", ")}`
        : "origin",
    },
  ];

  if (node.materialBindingId) {
    children.push({
      id: `${nodeId}/material`,
      label: "Material",
      icon: "magnet",
      badge: node.materialBindingId,
    });
  }

  return {
    id: nodeId,
    label: node.name,
    icon: PRIMITIVE_ICONS[node.primitiveKind],
    badge: primitiveBadge(node),
    status: primitiveStatus(node, dirty),
    defaultOpen: false,
    domain: "build",
    onClick: onSelect ? () => onSelect({ type: "primitive", id: node.id }) : undefined,
    children,
  };
}

/**
 * Build the geometry builder section of the model tree.
 * Returns a top-level "Geometry Builder" node with universe and primitives.
 */
export function buildGeometryBuilderTreeNodes(
  graph: GeometryGraphDocument,
  dirty: DirtyState,
  onSelect?: (target: BuilderSelectionTarget) => void,
): TreeNodeData {
  const primitives = graph.nodes.filter(
    (n): n is PrimitiveNode => n.kind === "primitive",
  );
  const booleans = graph.nodes.filter(
    (n): n is BooleanNode => n.kind === "boolean",
  );

  const universeNode: TreeNodeData = {
    id: "builder-universe",
    label: "Universe",
    icon: "box",
    badge: `${formatDimension(graph.universe.size[0])} × ${formatDimension(graph.universe.size[1])} × ${formatDimension(graph.universe.size[2])}`,
    status: "ready",
    domain: "build",
    onClick: onSelect ? () => onSelect({ type: "universe", id: graph.universe.id }) : undefined,
  };

  const primitiveNodes = primitives.map((p) =>
    buildPrimitiveTreeNode(p, dirty, onSelect),
  );

  const lifecycleStatus: NodeStatus = dirty.geometryRealizationDirty
    ? "dirty"
    : dirty.meshDirty
      ? "stale"
      : "ready";

  const lifecycleNode: TreeNodeData = {
    id: "builder-lifecycle",
    label: "Build Status",
    icon: dirty.geometryRealizationDirty || dirty.meshDirty ? "alert-triangle" : "check-circle",
    badge: dirty.geometryRealizationDirty
      ? "⚠ Geometry changed"
      : dirty.meshDirty
        ? "⚠ Mesh out of date"
        : "✓ Ready",
    status: lifecycleStatus,
    domain: "build",
  };

  return {
    id: "builder-root",
    label: "Object Geometry",
    icon: "shapes",
    defaultOpen: true,
    domain: "build",
    children: [
      universeNode,
      {
        id: "builder-primitives",
        label: "Geometry Graph",
        icon: "shapes",
        badge: `${primitives.length} primitive${primitives.length !== 1 ? "s" : ""}`,
        defaultOpen: true,
        domain: "build",
        children: [
          ...booleans.map((node): TreeNodeData => ({
            id: `builder-bool-${node.id}`,
            label: node.name,
            icon: node.op === "union" ? "plus" : node.op === "subtract" ? "minus" : "intersect",
            badge: `${node.op} · ${node.inputs.length} inputs`,
            status: dirty.geometryDraftDirty ? "dirty" : "ready",
            domain: "build",
            onClick: onSelect ? () => onSelect({ type: "boolean", id: node.id }) : undefined,
          })),
          ...primitiveNodes,
        ],
      },
      lifecycleNode,
    ],
  };
}
