"use client";

import type {
  HysteresisBookmarkSchema,
  HysteresisBookmarksResource,
  HysteresisExecutionTreeNode,
} from "@/kernel/api/apiTypes";

import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorGroup } from "../../../primitives/InspectorGroup";
import type { HysteresisInspectorCommonProps } from "./HysteresisInspectorTypes";

export function HysteresisBookmarksInspector({
  bookmarks,
  executionTree,
}: Pick<HysteresisInspectorCommonProps, "executionTree"> & {
  bookmarks: HysteresisBookmarksResource | null | undefined;
}) {
  const markers = collectPointMarkers(bookmarks, executionTree?.nodes ?? []);

  return (
    <InspectorGroup
      title="Point Markers"
      badge={`${markers.length} ${markers.length === 1 ? "marker" : "markers"}`}
    >
      {markers.length > 0 ? (
        <div className="fm-hysteresis-inspector-list">
          {markers.map((node) => (
            <div
              className="fm-hysteresis-inspector-list__item"
              key={node.nodeId}
            >
              <FieldRow label="Marker" value={node.label} />
              <FieldRow label="Kind" value={node.kind} />
              <FieldRow label="Status" value={node.status} />
              {typeof node.pointId === "number" && (
                <FieldRow label="Point" value={String(node.pointId)} />
              )}
              {node.selectionRef && (
                <FieldRow label="Selection ref" value={node.selectionRef} />
              )}
              {node.resourceRef && (
                <FieldRow label="Resource ref" value={node.resourceRef} />
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="fm-hysteresis-inspector-empty">
          No point markers are available for this hysteresis stage yet.
        </div>
      )}
    </InspectorGroup>
  );
}

interface PointMarker {
  kind: string;
  label: string;
  nodeId: string;
  pointId?: number;
  resourceRef?: string | null;
  selectionRef?: string | null;
  status: string;
}

function collectPointMarkers(
  bookmarks: HysteresisBookmarksResource | null | undefined,
  nodes: readonly HysteresisExecutionTreeNode[],
): PointMarker[] {
  return [
    ...(bookmarks?.bookmarks.map(bookmarkToPointMarker) ?? []),
    ...flattenPointMarkers(nodes, { includeBookmarks: !bookmarks }),
  ];
}

function bookmarkToPointMarker(bookmark: HysteresisBookmarkSchema): PointMarker {
  return {
    kind: "bookmark",
    label: bookmark.label,
    nodeId: bookmark.bookmark_id,
    pointId: bookmark.point_id,
    resourceRef: bookmark.resource_ref,
    selectionRef: bookmark.selection_ref,
    status: bookmark.status,
  };
}

function flattenPointMarkers(
  nodes: readonly HysteresisExecutionTreeNode[],
  { includeBookmarks }: { includeBookmarks: boolean },
): PointMarker[] {
  const flattened: PointMarker[] = [];
  for (const node of nodes) {
    if (
      (includeBookmarks && node.kind === "bookmark") ||
      node.kind === "key_event" ||
      node.kind === "snapshot"
    ) {
      flattened.push(executionTreeNodeToPointMarker(node));
    }
    flattened.push(
      ...flattenPointMarkers(node.children ?? [], { includeBookmarks }),
    );
  }
  return flattened;
}

function executionTreeNodeToPointMarker(
  node: HysteresisExecutionTreeNode,
): PointMarker {
  return {
    kind: node.kind,
    label: node.label,
    nodeId: node.node_id,
    pointId: node.point_id ?? undefined,
    resourceRef: node.resource_ref,
    selectionRef: node.selection_ref,
    status: node.status,
  };
}
