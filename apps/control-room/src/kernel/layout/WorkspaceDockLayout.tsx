"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { GripVertical } from "lucide-react";

import {
  DEFAULT_WORKSPACE_LAYOUT,
  moveWorkspaceColumn,
  restoreWorkspaceLayout,
  serializeWorkspaceLayout,
  WORKSPACE_LAYOUT_RESTORED_EVENT,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  type WorkspaceColumnLayout,
} from "./layoutModel";
import { SlotHost } from "./SlotHost";
import { ViewportTabHost } from "./ViewportTabHost";
import { useKernel } from "../KernelContext";
import { useLayoutSelector } from "./useLayout";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/shared/ui/Resizable";
import { SortableItem, SortableList } from "@/shared/ui/Sortable";

interface SortableWorkspaceColumnProps {
  column: WorkspaceColumnLayout;
}

interface WorkspaceDockState {
  layout: typeof DEFAULT_WORKSPACE_LAYOUT;
  restored: boolean;
}

function persistWorkspaceLayout(layout: typeof DEFAULT_WORKSPACE_LAYOUT): void {
  try {
    window.localStorage.setItem(
      WORKSPACE_LAYOUT_STORAGE_KEY,
      serializeWorkspaceLayout(layout),
    );
  } catch {
    return;
  }
}

function SortableWorkspaceColumn({
  column,
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
            <GripVertical size={12} aria-hidden="true" />
          </div>
          {column.slotId === "viewport-main" ? (
            <ViewportTabHost />
          ) : (
            <SlotHost slotId={column.slotId} />
          )}
        </div>
      )}
    </SortableItem>
  );
}

export function WorkspaceDockLayout() {
  const kernel = useKernel();
  const panelVisible = useLayoutSelector((layout) => layout.panelVisible);
  const hasAuxViewportModule = kernel.modules.forSlot("viewport-aux").length > 0;
  const [dockState, setDockState] = useState<WorkspaceDockState>({
    layout: DEFAULT_WORKSPACE_LAYOUT,
    restored: false,
  });
  const inspectorPanelRef = useRef<PanelImperativeHandle | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const [inspectorMaxWidth, setInspectorMaxWidth] = useState(560);

  useEffect(() => {
    const restoreFromStorage = () => {
      let restoredLayout = DEFAULT_WORKSPACE_LAYOUT;
      try {
        restoredLayout = restoreWorkspaceLayout(
          window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY),
        );
      } finally {
        setDockState({
          layout: restoredLayout,
          restored: true,
        });
      }
    };

    restoreFromStorage();
    window.addEventListener(WORKSPACE_LAYOUT_RESTORED_EVENT, restoreFromStorage);
    return () => {
      window.removeEventListener(
        WORKSPACE_LAYOUT_RESTORED_EVENT,
        restoreFromStorage,
      );
    };
  }, []);

  useEffect(() => {
    const updateInspectorMaximum = () => {
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        const maximum = Math.max(
          360,
          Math.min(560, Math.floor(window.innerWidth * 0.38)),
        );
        setInspectorMaxWidth(maximum);
        if ((inspectorPanelRef.current?.getSize().inPixels ?? 0) > maximum) {
          inspectorPanelRef.current?.resize(`${maximum}px`);
        }
      });
    };

    updateInspectorMaximum();
    window.addEventListener("resize", updateInspectorMaximum);
    return () => {
      window.removeEventListener("resize", updateInspectorMaximum);
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
    };
  }, []);

  function handleMoveColumn(activeId: string, overId: string): void {
    setDockState((currentState) => {
      const nextLayout = moveWorkspaceColumn(
        currentState.layout,
        activeId,
        overId,
      );
      persistWorkspaceLayout(nextLayout);
      return {
        ...currentState,
        layout: nextLayout,
      };
    });
  }

  const { layout, restored } = dockState;
  const visibleColumns = layout.columns.filter((column) => {
    if (column.slotId === "panel-left") return panelVisible.left;
    if (column.slotId === "viewport-aux") return hasAuxViewportModule;
    if (column.slotId === "panel-right") return panelVisible.right;
    return true;
  });
  const mainPanelCount = panelVisible.bottom ? 2 : 1;
  const mainAutoSaveId = `fullmag-workspace-main:${mainPanelCount}`;
  const columnAutoSaveId = `fullmag-workspace-columns:${visibleColumns
    .map((column) => column.slotId)
    .join("|")}`;

  if (!restored) {
    return (
      <div className="fm-workspace-body" data-dock-hydration-pending="true" id="fm-main-content" tabIndex={-1}>
        {panelVisible.left ? (
          <div className="fm-dock-column">
            <div className="fm-dock-column__handle">
              <span>Explorer</span>
              <GripVertical size={12} aria-hidden="true" />
            </div>
            <SlotHost slotId="panel-left" />
          </div>
        ) : null}
        <div className="fm-dock-column">
          <div className="fm-dock-column__handle">
            <span>Viewport</span>
            <GripVertical size={12} aria-hidden="true" />
          </div>
          <ViewportTabHost />
        </div>
        {hasAuxViewportModule ? (
          <div className="fm-dock-column">
            <div className="fm-dock-column__handle">
              <span>Section</span>
              <GripVertical size={12} aria-hidden="true" />
            </div>
            <SlotHost slotId="viewport-aux" />
          </div>
        ) : null}
        {panelVisible.right ? (
          <div className="fm-dock-column">
            <div className="fm-dock-column__handle">
              <span>Inspector</span>
              <GripVertical size={12} aria-hidden="true" />
            </div>
            <SlotHost slotId="panel-right" />
          </div>
        ) : null}
        {panelVisible.bottom ? <SlotHost slotId="panel-bottom" /> : null}
      </div>
    );
  }

  return (
    <div className="fm-workspace-body" id="fm-main-content" tabIndex={-1}>
      <ResizablePanelGroup
        autoSaveId={mainAutoSaveId}
        direction="vertical"
        panelCount={mainPanelCount}
      >
        <ResizablePanel defaultSize={78} id="workspace-main" minSize={42}>
          <SortableList
            id="workspace-dock-columns"
            items={visibleColumns.map((column) => column.slotId)}
            onMove={handleMoveColumn}
          >
            <ResizablePanelGroup
              autoSaveId={columnAutoSaveId}
              direction="horizontal"
              onLayoutChanged={() => {
                if (resizeFrameRef.current !== null) return;
                resizeFrameRef.current = window.requestAnimationFrame(() => {
                  resizeFrameRef.current = null;
                  window.dispatchEvent(new Event("resize"));
                });
              }}
              panelCount={visibleColumns.length}
            >
              {visibleColumns.map((column, index) => (
                <Fragment key={column.slotId}>
                  <ResizablePanel
                    key={column.slotId}
                    defaultSize={column.defaultSize}
                    groupResizeBehavior={column.resizeBehavior}
                    id={column.slotId}
                    maxSize={
                      column.slotId === "panel-right"
                        ? `${inspectorMaxWidth}px`
                        : column.maxSize
                    }
                    minSize={column.minSize}
                    panelRef={
                      column.slotId === "panel-right"
                        ? inspectorPanelRef
                        : undefined
                    }
                  >
                    <SortableWorkspaceColumn column={column} />
                  </ResizablePanel>
                  {index < visibleColumns.length - 1 ? (
                    <ResizableHandle
                      className="fm-resize-handle--vertical"
                      aria-label={
                        column.slotId === "panel-right" ||
                        visibleColumns[index + 1]?.slotId === "panel-right"
                          ? "Resize Inspector"
                          : "Resize workspace panels"
                      }
                      onDoubleClick={() => {
                        if (
                          column.slotId === "panel-right" ||
                          visibleColumns[index + 1]?.slotId === "panel-right"
                        ) {
                          inspectorPanelRef.current?.resize("416px");
                        }
                      }}
                    />
                  ) : null}
                </Fragment>
              ))}
            </ResizablePanelGroup>
          </SortableList>
        </ResizablePanel>
        {panelVisible.bottom ? (
          <>
            <ResizableHandle className="fm-resize-handle--horizontal" />
            <ResizablePanel
              defaultSize={layout.bottomDockDefaultSize}
              id="panel-bottom"
              minSize={layout.bottomDockMinSize}
            >
              <SlotHost slotId="panel-bottom" />
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
    </div>
  );
}
