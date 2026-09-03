/**
 * Study Pipeline Commands
 *
 * A typed discriminated union for all semantic operations on the study pipeline.
 * The reducer `applyPipelineCommand` is a pure function:
 *   (document, command) → document
 *
 * Components dispatch commands instead of calling operations directly,
 * enabling undo/redo, logging, and consistent validation.
 */

import type {
  StudyPipelineDocument,
  StudyPipelineNode,
  StudyPrimitiveStageKind,
  StudyMacroStageKind,
} from "@/lib/study-builder/types";
import {
  createPrimitiveNode,
  createMacroNode,
  appendNode,
  insertNodeNear,
  deleteNode,
  duplicateNode,
  toggleNodeEnabled,
  patchNode,
  patchNodeConfig,
} from "@/lib/study-builder/operations";
import { getStageTemplate } from "../registry/stageTemplateRegistry";

// ── Command types ────────────────────────────────────────────

export type StudyPipelineCommand =
  | { type: "stage.add-primitive"; kind: StudyPrimitiveStageKind; anchorId?: string; position?: "before" | "after" }
  | { type: "stage.add-macro"; kind: StudyMacroStageKind; anchorId?: string; position?: "before" | "after" }
  | { type: "stage.add-from-template"; templateKind: string; anchorId?: string; position?: "before" | "after" }
  | { type: "stage.delete"; nodeId: string }
  | { type: "stage.duplicate"; nodeId: string }
  | { type: "stage.toggle-enabled"; nodeId: string }
  | { type: "stage.reorder"; nodeId: string; delta: -1 | 1 }
  | { type: "stage.rename"; nodeId: string; label: string }
  | { type: "stage.patch-config"; nodeId: string; patch: Record<string, unknown> }
  | { type: "stage.patch-notes"; nodeId: string; notes: string }
  | { type: "stage.group"; nodeIds: string[] }
  | { type: "stage.ungroup"; groupId: string }
  | { type: "stage.insert-before-run"; nodeId: string }
  | { type: "stage.insert-after-run"; nodeId: string };

// ── Helpers ──────────────────────────────────────────────────

function reorderNodes(nodes: StudyPipelineNode[], nodeId: string, delta: -1 | 1): StudyPipelineNode[] {
  const index = nodes.findIndex((n) => n.id === nodeId);
  if (index < 0) return nodes;
  const target = index + delta;
  if (target < 0 || target >= nodes.length) return nodes;
  const next = [...nodes];
  const [node] = next.splice(index, 1);
  next.splice(target, 0, node);
  return next;
}

function groupNodes(doc: StudyPipelineDocument, nodeIds: string[]): StudyPipelineDocument {
  if (nodeIds.length === 0) return doc;
  const selected = doc.nodes.filter((n) => nodeIds.includes(n.id));
  if (selected.length === 0) return doc;
  const firstIndex = doc.nodes.findIndex((n) => nodeIds.includes(n.id));
  const remaining = doc.nodes.filter((n) => !nodeIds.includes(n.id));
  const group: StudyPipelineNode = {
    id: `group_${Date.now()}_${Math.floor(Math.random() * 10_000)}`,
    label: "Stage Group",
    enabled: true,
    node_kind: "group",
    collapsed: false,
    children: selected,
  };
  const next = [...remaining];
  next.splice(firstIndex, 0, group);
  return { ...doc, nodes: next };
}

function ungroupNodes(doc: StudyPipelineDocument, groupId: string): StudyPipelineDocument {
  const groupIndex = doc.nodes.findIndex((n) => n.id === groupId);
  if (groupIndex < 0) return doc;
  const group = doc.nodes[groupIndex];
  if (group.node_kind !== "group") return doc;
  const next = [...doc.nodes];
  next.splice(groupIndex, 1, ...group.children);
  return { ...doc, nodes: next };
}

function placeNode(
  doc: StudyPipelineDocument,
  node: StudyPipelineNode,
  anchorId?: string,
  position?: "before" | "after",
): StudyPipelineDocument {
  if (!anchorId || !position) {
    return appendNode(doc, node);
  }
  return insertNodeNear(doc, anchorId, position, node);
}

// ── Reducer ──────────────────────────────────────────────────

export function applyPipelineCommand(
  doc: StudyPipelineDocument,
  command: StudyPipelineCommand,
): StudyPipelineDocument {
  switch (command.type) {
    case "stage.add-primitive":
      return placeNode(doc, createPrimitiveNode(command.kind), command.anchorId, command.position);

    case "stage.add-macro":
      return placeNode(doc, createMacroNode(command.kind), command.anchorId, command.position);

    case "stage.add-from-template": {
      const template = getStageTemplate(command.templateKind);
      if (!template) return doc;
      return placeNode(doc, template.create(), command.anchorId, command.position);
    }

    case "stage.delete":
      return deleteNode(doc, command.nodeId);

    case "stage.duplicate":
      return duplicateNode(doc, command.nodeId);

    case "stage.toggle-enabled":
      return toggleNodeEnabled(doc, command.nodeId);

    case "stage.reorder":
      return { ...doc, nodes: reorderNodes(doc.nodes, command.nodeId, command.delta) };

    case "stage.rename":
      return patchNode(doc, command.nodeId, { label: command.label });

    case "stage.patch-config":
      return patchNodeConfig(doc, command.nodeId, command.patch);

    case "stage.patch-notes":
      return patchNode(doc, command.nodeId, { notes: command.notes });

    case "stage.group":
      return groupNodes(doc, command.nodeIds);

    case "stage.ungroup":
      return ungroupNodes(doc, command.groupId);

    case "stage.insert-before-run":
      return insertNodeNear(doc, command.nodeId, "before", createPrimitiveNode("run"));

    case "stage.insert-after-run":
      return insertNodeNear(doc, command.nodeId, "after", createPrimitiveNode("run"));
  }
}
