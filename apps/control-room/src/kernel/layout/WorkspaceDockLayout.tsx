"use client";

import { Fragment, useEffect, useState } from "react";

import type { ModuleManifest } from "../types";
import {
  DEFAULT_WORKSPACE_LAYOUT,
  moveWorkspaceColumn,
  restoreWorkspaceLayout,
  serializeWorkspaceLayout,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  type WorkspaceColumnLayout,
} from "./layoutModel";
import { SlotHost } from "./SlotHost";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/shared/ui/Resizable";
import { SortableItem, SortableList } from "@/shared/ui/Sortable";

interface SortableWorkspaceColumnProps {
  column: WorkspaceColumnLayout;
  moduleManifest: ModuleManifest | null;
}

function SortableWorkspaceColumn({
  column,
  moduleManifest,
}: SortableWorkspaceColumnProps) {
  return (
    <SortableItem id={column.slotId}>
      {({ attributes, isDragging, listeners, setNodeRef, style }) => (
        <div
          ref={setNodeRef}
          className="fm-dock-column"
          data-dragging={isDragging}
          style={style}
        >
          <div className="fm-dock-column__handle" {...attributes} {...listeners}>
            <span>{column.label}</span>
            <span aria-hidden="true">::</span>
          </div>
          <SlotHost slotId={column.slotId} moduleManifest={moduleManifest} />
        </div>
      )}
    </SortableItem>
  );
}

export function WorkspaceDockLayout() {
  const [layout, setLayout] = useState(DEFAULT_WORKSPACE_LAYOUT);
  const [hasRestoredLayout, setHasRestoredLayout] = useState(false);

  useEffect(() => {
    try {
      setLayout(
        restoreWorkspaceLayout(
          window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY),
        ),
      );
    } finally {
      setHasRestoredLayout(true);
    }
  }, []);

  useEffect(() => {
    if (!hasRestoredLayout) {
      return;
    }

    try {
      window.localStorage.setItem(
        WORKSPACE_LAYOUT_STORAGE_KEY,
        serializeWorkspaceLayout(layout),
      );
    } catch {
      return;
    }
  }, [hasRestoredLayout, layout]);

  function handleMoveColumn(activeId: string, overId: string): void {
    setLayout((currentLayout) =>
      moveWorkspaceColumn(currentLayout, activeId, overId),
    );
  }

  return (
    <div className="fm-workspace-body">
      <ResizablePanelGroup
        autoSaveId="fullmag-workspace-main"
        direction="vertical"
      >
        <ResizablePanel defaultSize={78} id="workspace-main" minSize={42}>
          <SortableList
            id="workspace-dock-columns"
            items={layout.columns.map((column) => column.slotId)}
            onMove={handleMoveColumn}
          >
            <ResizablePanelGroup
              autoSaveId="fullmag-workspace-columns"
              direction="horizontal"
            >
              {layout.columns.map((column, index) => (
                <Fragment key={column.slotId}>
                  <ResizablePanel
                    key={column.slotId}
                    defaultSize={column.defaultSize}
                    id={column.slotId}
                    minSize={column.minSize}
                  >
                    <SortableWorkspaceColumn
                      column={column}
                      moduleManifest={null}
                    />
                  </ResizablePanel>
                  {index < layout.columns.length - 1 ? (
                    <ResizableHandle className="fm-resize-handle--vertical" />
                  ) : null}
                </Fragment>
              ))}
            </ResizablePanelGroup>
          </SortableList>
        </ResizablePanel>
        <ResizableHandle className="fm-resize-handle--horizontal" />
        <ResizablePanel
          defaultSize={layout.bottomDockDefaultSize}
          id="panel-bottom"
          minSize={layout.bottomDockMinSize}
        >
          <SlotHost slotId="panel-bottom" moduleManifest={null} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
