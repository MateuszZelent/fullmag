/**
 * P3 — Geometry Builder Tree Nodes
 *
 * Builds TreeNodeData[] for the geometry builder primitives.
 * Integrates with the existing ModelTree system.
 */

import type { TreeNodeData, NodeStatus } from "@/components/panels/ModelTree";
import type {
  GeometryGraphDocument,
  PrimitiveNode,
  DirtyState,
  PrimitiveKind,
  BuilderSelectionTarget,
} from "../model/types";

const PRIMITIVE_ICONS: Record<PrimitiveKind, string> = {
  box: "box",
  cylinder: "cylinder",
  sphere: "sphere",
  disk: "disc",
  triangular_prism: "triangle",
};

function primitiveStatus(
  node: PrimitiveNode,
  dirty: DirtyState,
): NodeStatus {
  if (!node.enabled) return "pending";
  if (dirty.geometryDraftDirty) return "active";
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
    case "cylinder":
      return `r=${formatDimension(node.params.data.radius)} h=${formatDimension(node.params.data.height)}`;
    case "sphere":
      return `r=${formatDimension(node.params.data.radius)}`;
    case "disk":
      return `r=${formatDimension(node.params.data.radius)} t=${formatDimension(node.params.data.thickness)}`;
    case "triangular_prism":
      return `b=${formatDimension(node.params.data.base)} h=${formatDimension(node.params.data.triangleHeight)}`;
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
    ? "active"
    : dirty.meshDirty
      ? "active"
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
    label: "Geometry Builder",
    icon: "shapes",
    defaultOpen: true,
    domain: "build",
    children: [
      universeNode,
      {
        id: "builder-primitives",
        label: "Primitives",
        icon: "shapes",
        badge: `${primitives.length} object${primitives.length !== 1 ? "s" : ""}`,
        defaultOpen: true,
        domain: "build",
        children: primitiveNodes,
      },
      lifecycleNode,
    ],
  };
}
