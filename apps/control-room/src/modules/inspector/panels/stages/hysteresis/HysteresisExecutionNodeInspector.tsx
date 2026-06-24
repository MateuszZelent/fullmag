"use client";

import type { HysteresisExecutionTreeNode } from "@/kernel/api/apiTypes";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorSection } from "../../../primitives/InspectorSection";
import {
  displayValue,
  findHysteresisExecutionTreeNode,
  type ActiveHysteresisExecutionNodeSelection,
} from "./HysteresisInspectorUtils";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisExecutionNodeInspector({
  activeExecutionNode,
  executionTree,
}: Pick<HysteresisInspectorCommonProps, "executionTree"> & {
  activeExecutionNode: ActiveHysteresisExecutionNodeSelection | null;
}) {
  const node = findHysteresisExecutionTreeNode(
    executionTree?.nodes ?? [],
    activeExecutionNode,
  );
  const badge = node?.kind ?? activeExecutionNode?.nodeKind ?? "node";

  return (
    <InspectorSection
      value="hysteresis-execution-node"
      title="Execution Node"
      badge={badge}
    >
      {node ? (
        <ExecutionNodeDetails node={node} />
      ) : activeExecutionNode ? (
        <>
          <FieldRow label="Node ID" value={activeExecutionNode.nodeId ?? "n/a"} />
          <FieldRow label="Kind" value={activeExecutionNode.nodeKind ?? "n/a"} />
          {activeExecutionNode.pointId != null && (
            <FieldRow label="Point" value={String(activeExecutionNode.pointId)} />
          )}
          {activeExecutionNode.resourceRef && (
            <FieldRow label="Resource ref" value={activeExecutionNode.resourceRef} />
          )}
          {activeExecutionNode.selectionRef && (
            <FieldRow label="Selection ref" value={activeExecutionNode.selectionRef} />
          )}
          <div className="fm-hysteresis-inspector-empty">
            This execution-tree node is outside the currently loaded live window.
          </div>
        </>
      ) : (
        <div className="fm-hysteresis-inspector-empty">
          Select a hysteresis execution-tree child node to inspect its live status.
        </div>
      )}
    </InspectorSection>
  );
}

function ExecutionNodeDetails({ node }: { node: HysteresisExecutionTreeNode }) {
  const childCount = node.children?.length ?? 0;
  const resourceRef = displayValue(node.resource_ref);
  const selectionRef = displayValue(node.selection_ref);
  const settleStepId = displayValue(node.settle_step_id);

  return (
    <>
      <FieldRow label="Label" value={node.label} />
      <FieldRow label="Kind" value={node.kind} />
      <FieldRow label="Status" value={node.status} />
      <FieldRow label="Node ID" value={node.node_id} />
      <FieldRow label="Stage" value={node.stage_id} />
      <FieldRow label="Revision" value={String(node.updated_revision)} />
      {typeof node.point_id === "number" && (
        <FieldRow label="Point" value={String(node.point_id)} />
      )}
      {settleStepId && (
        <FieldRow label="Settle step" value={settleStepId} />
      )}
      {selectionRef && (
        <FieldRow label="Selection ref" value={selectionRef} />
      )}
      {resourceRef && (
        <FieldRow label="Resource ref" value={resourceRef} />
      )}
      <FieldRow label="Children" value={String(childCount)} />
      {childCount > 0 && (
        <div className="fm-hysteresis-inspector-list">
          {node.children?.map((child) => (
            <div
              className="fm-hysteresis-inspector-list__item"
              key={child.node_id}
            >
              <FieldRow label="Child" value={child.label} />
              <FieldRow label="Kind" value={child.kind} />
              <FieldRow label="Status" value={child.status} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
