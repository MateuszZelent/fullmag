"use client";

import type { HysteresisExecutionTreeNode } from "@/kernel/api/apiTypes";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorSection } from "../../../primitives/InspectorSection";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisBookmarksInspector({
  executionTree,
}: Pick<HysteresisInspectorCommonProps, "executionTree">) {
  const bookmarks = flattenBookmarks(executionTree?.nodes ?? []);

  return (
    <InspectorSection
      value="hysteresis-points-bookmarks"
      title="Bookmarks"
      badge={`${bookmarks.length} ${bookmarks.length === 1 ? "event" : "events"}`}
    >
      {bookmarks.length > 0 ? (
        <div className="fm-hysteresis-inspector-list">
          {bookmarks.map((node) => (
            <div
              className="fm-hysteresis-inspector-list__item"
              key={node.node_id}
            >
              <FieldRow label="Event" value={node.label} />
              <FieldRow label="Kind" value={node.kind} />
              <FieldRow label="Status" value={node.status} />
              {typeof node.point_id === "number" && (
                <FieldRow label="Point" value={String(node.point_id)} />
              )}
              {node.selection_ref && (
                <FieldRow label="Selection ref" value={node.selection_ref} />
              )}
              {node.resource_ref && (
                <FieldRow label="Resource ref" value={node.resource_ref} />
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="fm-hysteresis-inspector-empty">
          No bookmark, key-event, or snapshot markers are available for this
          hysteresis stage yet.
        </div>
      )}
    </InspectorSection>
  );
}

function flattenBookmarks(
  nodes: readonly HysteresisExecutionTreeNode[],
): HysteresisExecutionTreeNode[] {
  const flattened: HysteresisExecutionTreeNode[] = [];
  for (const node of nodes) {
    if (
      node.kind === "bookmark" ||
      node.kind === "key_event" ||
      node.kind === "snapshot"
    ) {
      flattened.push(node);
    }
    flattened.push(...flattenBookmarks(node.children ?? []));
  }
  return flattened;
}
