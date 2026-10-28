"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { Button } from "@/shared/ui/Button";
import { PanelChrome, PanelFrame } from "@/shared/ui/PanelFrame";
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
import { useWorkspaceContentScope } from "./WorkspaceContentScope";
import { useKernel } from "../KernelContext";
import type { SavedResultsPlaybackSelection } from "../saved-results/SavedResultsPlaybackController";
import { useSavedResultsPlaybackSelection } from "../saved-results/useSavedResultsPlayback";
import { useLayoutSelector } from "./useLayout";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/shared/ui/Resizable";
import { SortableItem, SortableList } from "@/shared/ui/Sortable";

interface SortableWorkspaceColumnProps {
  column: WorkspaceColumnLayout;
  playbackSelection: SavedResultsPlaybackSelection | null;
}

interface WorkspaceDockState {
  layout: typeof DEFAULT_WORKSPACE_LAYOUT;
  restored: boolean;
}

function WorkspaceColumnContent({
  playbackSelection,
  slotId,
}: {
  playbackSelection: SavedResultsPlaybackSelection | null;
  slotId: WorkspaceColumnLayout["slotId"];
}) {
  const scope = useWorkspaceContentScope();
  const kernel = useKernel();
  if (slotId === "viewport-main") {
    if (playbackSelection) {
      return <SlotHost moduleManifest={kernel.modules.get("viewport-3d") ?? null} slotId="viewport-main" />;
    }
    return scope === "project" ? (
      <section className="grid flex-1 place-items-center p-6" aria-label="Saved field preview" data-project-results-preview="unavailable">
        <div className="grid max-w-sm gap-2 text-center">
          <h2 className="m-0 text-fm-md font-semibold text-fm-primary">Saved field preview</h2>
          <p className="m-0 text-fm-sm text-fm-muted">Field preview is not available yet. Select a saved result to inspect its details.</p>
        </div>
      </section>
    ) : <ViewportTabHost />;
  }
  if (playbackSelection && slotId === "panel-left") {
    return (
      <section aria-label="Saved result folder summary" className="fm-saved-results-playback__summary" data-saved-results-folder-summary="read-only">
        <h2 className="fm-saved-results-playback__summary-title">Saved result folder</h2>
        <dl className="fm-saved-results-playback__summary-data">
          <div className="fm-saved-results-playback__summary-row">
            <dt>Name</dt>
            <dd title={playbackSelection.name}>{playbackSelection.name}</dd>
          </div>
          <div className="fm-saved-results-playback__summary-row">
            <dt>Workspace item</dt>
            <dd title={playbackSelection.itemId}>{playbackSelection.itemId}</dd>
          </div>
        </dl>
        <p className="fm-saved-results-playback__summary-note">
          Published data is read directly from this folder. The source project is unchanged and no session is started.
        </p>
      </section>
    );
  }
  if (scope === "project" && slotId === "panel-left") {
    return <SlotHost slotId={slotId} moduleManifest={kernel.modules.get("results-navigator") ?? null} />;
  }
  return <SlotHost slotId={slotId} />;
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

function SortableWorkspaceColumn({ column, playbackSelection, visible, drawer, drawerShared, onDockChange, onHide, onMove }: SortableWorkspaceColumnProps & {
  visible: boolean; drawer: boolean; drawerShared: boolean;
  onDockChange: (id: string, docked: boolean) => void;
  onHide?: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const reportDocked = useCallback((docked: boolean) => onDockChange(column.slotId, docked), [column.slotId, onDockChange]);
  const title = playbackSelection && column.slotId === "panel-left" ? "Saved folder" : column.label;
  return <SortableItem id={column.slotId}>{({ attributes, isDragging, listeners, setNodeRef, style }) => (
    <div ref={setNodeRef} className="fm-dock-column" data-dragging={isDragging} style={style}>
      <PanelFrame id={column.slotId} title={title} visible={visible} drawer={drawer} drawerSide={column.slotId === "panel-left" ? "left" : "right"} drawerShared={drawerShared} floatable={column.slotId !== "viewport-main"} suspendWhenHidden={column.slotId !== "panel-right"} onDockChange={reportDocked} onHide={onHide} onMove={onMove}
        dockHandle={<Button className="fm-panel-move" size="icon" variant="ghost" aria-label={`Move ${title} panel`} {...attributes} {...listeners}><GripVertical size={14} aria-hidden="true" /></Button>}>
        {column.slotId === "viewport-aux" ? <PanelChrome><span className="fm-panel-chrome__title">{column.label}</span></PanelChrome> : null}
        <WorkspaceColumnContent playbackSelection={playbackSelection} slotId={column.slotId} />
      </PanelFrame>
    </div>
  )}</SortableItem>;
}

export function WorkspaceDockLayout() {
  const kernel = useKernel();
  const playbackSelection = useSavedResultsPlaybackSelection();
  const playbackOnly = playbackSelection !== null;
  const projectOnly = useWorkspaceContentScope() === "project";
  const panelVisible = useLayoutSelector((layout) => layout.panelVisible);
  const hasAuxViewportModule = !projectOnly && !playbackOnly && kernel.modules.forSlot("viewport-aux").length > 0;
  const [dockState, setDockState] = useState<WorkspaceDockState>({ layout: DEFAULT_WORKSPACE_LAYOUT, restored: false });
  const [dockedPanels, setDockedPanels] = useState<Record<string, boolean>>({});
  const [windowWidth, setWindowWidth] = useState(1440);
  const panels = useRef<Record<string, PanelImperativeHandle | null>>({});

  useEffect(() => {
    const restore = () => {
      let layout = DEFAULT_WORKSPACE_LAYOUT;
      try { layout = restoreWorkspaceLayout(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)); } catch { /* Storage is optional. */ }
      setDockState({ layout, restored: true });
    };
    restore();
    window.addEventListener(WORKSPACE_LAYOUT_RESTORED_EVENT, restore);
    const resize = () => setWindowWidth(window.innerWidth);
    resize(); window.addEventListener("resize", resize);
    return () => { window.removeEventListener(WORKSPACE_LAYOUT_RESTORED_EVENT, restore); window.removeEventListener("resize", resize); };
  }, []);
  useEffect(() => { if (dockState.restored) persistWorkspaceLayout(dockState.layout); }, [dockState]);
  const onDockChange = useCallback((id: string, docked: boolean) => {
    setDockedPanels(previous => previous[id] === docked ? previous : { ...previous, [id]: docked });
  }, []);
  const bottomDockChange = useCallback((docked: boolean) => onDockChange("panel-bottom", docked), [onDockChange]);
  const resetInspectorWidth = useCallback(() => {
    const initial = DEFAULT_WORKSPACE_LAYOUT.columns.find(column => column.slotId === "panel-right");
    if (initial) panels.current["panel-right"]?.resize(initial.defaultSize);
  }, []);

  useEffect(() => {
    for (const [id, panel] of Object.entries(panels.current)) {
      if (!panel || dockedPanels[id] === undefined) continue;
      if (dockedPanels[id]) { if (panel.isCollapsed()) panel.expand(); }
      else if (!panel.isCollapsed()) panel.collapse();
    }
  }, [dockedPanels, dockState.restored]);

  const columns = dockState.layout.columns.filter(column => column.slotId !== "viewport-aux" || hasAuxViewportModule);
  const visible = (id: string) => playbackOnly && id === "panel-right"
    ? true
    : id === "panel-left" ? panelVisible.left : id === "panel-right" ? panelVisible.right : true;
  const isDrawer = (id: string) => id === "panel-right" && windowWidth < 1180 || id === "panel-left" && windowWidth < 760;
  // Explorer and Inspector drawers open together only below 760px; they then split the width.
  const drawersShared = isDrawer("panel-left") && isDrawer("panel-right") && visible("panel-left") && visible("panel-right");
  const move = (id: string, direction: -1 | 1) => {
    const index = columns.findIndex(column => column.slotId === id);
    const neighbour = columns[index + direction];
    if (neighbour) setDockState(current => ({ ...current, layout: moveWorkspaceColumn(current.layout, id, neighbour.slotId) }));
  };
  if (!dockState.restored) return <div className="fm-workspace-body" data-dock-hydration-pending="true" id="fm-main-content" tabIndex={-1}>
    {columns.filter(column => visible(column.slotId)).map(column => <div key={column.slotId} className="fm-dock-column"><section className="fm-slot" data-slot-id={column.slotId} aria-label={column.label} aria-busy="true" /></div>)}
    {!projectOnly && !playbackOnly && panelVisible.bottom ? <div className="fm-workspace-bottom-panel"><section className="fm-slot" data-slot-id="panel-bottom" aria-label="Diagnostics" aria-busy="true" /></div> : null}
  </div>;

  return <div className="fm-workspace-body" id="fm-main-content" tabIndex={-1}>
    <ResizablePanelGroup autoSaveId="fullmag-workspace-main:retained-v1" direction="vertical" panelCount={projectOnly || playbackOnly ? 1 : 2}>
      <ResizablePanel defaultSize="78%" id="workspace-main" minSize="160px">
        <SortableList id="workspace-dock-columns" items={columns.map(column => column.slotId)} onMove={(activeId, overId) => setDockState(current => ({ ...current, layout: moveWorkspaceColumn(current.layout, activeId, overId) }))}>
          <ResizablePanelGroup autoSaveId={`fullmag-workspace-columns:retained-v1:${columns.map(column => column.slotId).join("|")}`} direction="horizontal" panelCount={columns.length}>
            {columns.map((column, index) => <Fragment key={column.slotId}>
              <ResizablePanel id={column.slotId} defaultSize={column.defaultSize} minSize={column.slotId === "panel-right" ? "240px" : "160px"} maxSize={column.slotId === "panel-right" ? "560px" : column.maxSize} groupResizeBehavior={column.resizeBehavior} collapsible collapsedSize={0} panelRef={handle => { panels.current[column.slotId] = handle; }}>
                <SortableWorkspaceColumn column={column} playbackSelection={playbackSelection} visible={visible(column.slotId)} drawer={isDrawer(column.slotId)} drawerShared={drawersShared && isDrawer(column.slotId)} onDockChange={onDockChange} onHide={column.slotId === "panel-left" ? () => kernel.layout.setPanelVisible("left", false) : column.slotId === "panel-right" && !playbackOnly ? () => kernel.layout.setPanelVisible("right", false) : undefined} onMove={direction => move(column.slotId, direction)} />
              </ResizablePanel>
              {index < columns.length - 1 ? <ResizableHandle className="fm-resize-handle--vertical" aria-label={`Resize ${column.label} and ${columns[index + 1].label} panels`} onDoubleClick={column.slotId === "panel-right" || columns[index + 1].slotId === "panel-right" ? resetInspectorWidth : undefined} style={dockedPanels[column.slotId] === false || dockedPanels[columns[index + 1].slotId] === false ? { display: "none" } : undefined} /> : null}
            </Fragment>)}
          </ResizablePanelGroup>
        </SortableList>
      </ResizablePanel>
      {!projectOnly && !playbackOnly ? <>
        <ResizableHandle className="fm-resize-handle--horizontal" aria-label="Resize bottom diagnostics" style={dockedPanels["panel-bottom"] === false ? { display: "none" } : undefined} />
        <ResizablePanel defaultSize={`${dockState.layout.bottomDockDefaultSize}%`} minSize="100px" className="fm-workspace-bottom-panel" id="panel-bottom" collapsible collapsedSize={0} panelRef={handle => { panels.current["panel-bottom"] = handle; }}>
          <PanelFrame id="panel-bottom" title="Diagnostics" visible={panelVisible.bottom} onDockChange={bottomDockChange} onHide={() => kernel.layout.setPanelVisible("bottom", false)}>
            <SlotHost slotId="panel-bottom" />
          </PanelFrame>
        </ResizablePanel>
      </> : null}
    </ResizablePanelGroup>
    {!playbackOnly ? (
      <div className="fm-panel-restore-bar" aria-label="Restore hidden panels">
        {!panelVisible.left ? <Button data-restore-panel="panel-left" size="sm" variant="secondary" onClick={() => kernel.layout.setPanelVisible("left", true)}>Restore Explorer</Button> : null}
        {!panelVisible.right ? <Button data-restore-panel="panel-right" size="sm" variant="secondary" onClick={() => kernel.layout.setPanelVisible("right", true)}>Restore Inspector</Button> : null}
        {!projectOnly && !panelVisible.bottom ? <Button data-restore-panel="panel-bottom" size="sm" variant="secondary" onClick={() => kernel.layout.setPanelVisible("bottom", true)}>Restore Diagnostics</Button> : null}
      </div>
    ) : null}
  </div>;
}
