"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { Button } from "@/shared/ui/Button";
import { PanelChrome, PanelFrame } from "@/shared/ui/PanelFrame";
import { readPanelFramePreference, type PanelMode } from "@/shared/ui/panelFramePreferences";
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
import { WorkspaceSideRail } from "./WorkspaceSideRail";
import { useWorkspaceContentScope } from "./WorkspaceContentScope";
import { useSavedFieldPresentation } from "../visualization/useObjectVisualization";
import { useKernel } from "../KernelContext";
import type { SavedResultsPlaybackSelection } from "../saved-results/SavedResultsPlaybackController";
import { useSavedResultsPlaybackSelection } from "../saved-results/useSavedResultsPlayback";
import { useLayoutSelector } from "./useLayout";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/shared/ui/Resizable";
import { SortableList } from "@/shared/ui/Sortable";
import { SortableItem } from "@/shared/ui/Sortable.presentation";

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
  const savedField = useSavedFieldPresentation();
  if (slotId === "viewport-main") {
    if (playbackSelection) {
      return <SlotHost moduleManifest={kernel.modules.get("viewport-3d") ?? null} slotId="viewport-main" />;
    }
    if (scope === "project" && savedField.projectMatches) return <ViewportTabHost savedOnly />;
    return scope === "project" ? (
      <section className="grid flex-1 place-items-center p-6" aria-label="Saved field preview" data-project-results-preview="unavailable">
        <div className="grid max-w-sm gap-2 text-center">
          <h2 className="m-0 text-fm-md font-semibold text-fm-primary">Saved field preview</h2>
          <p className="m-0 text-fm-sm text-fm-muted">Field preview is not available yet. Select a saved result to inspect its details.</p>
        </div>
      </section>
    ) : <ViewportTabHost />;
  }
  if (playbackSelection && !playbackSelection.studyResult && slotId === "panel-left") {
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

function SortableWorkspaceColumn({ column, playbackSelection, visible, mode, changeMode, onHide, onMove }: SortableWorkspaceColumnProps & {
  visible: boolean;
  mode: PanelMode;
  changeMode: (id: string, mode: PanelMode) => void;
  onHide?: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const onModeChange = useCallback((nextMode: PanelMode) => changeMode(column.slotId, nextMode), [column.slotId, changeMode]);
  const title = playbackSelection && !playbackSelection.studyResult && column.slotId === "panel-left" ? "Saved folder" : column.label;
  return <SortableItem id={column.slotId}>{({ attributes, isDragging, listeners, setNodeRef, style }) => (
    <div ref={setNodeRef} className="fm-dock-column" data-dragging={isDragging} style={style}>
      <PanelFrame id={column.slotId} title={title} visible={visible} mode={mode} floatable={column.slotId !== "viewport-main"} suspendWhenHidden={column.slotId !== "panel-right"} onModeChange={onModeChange} onHide={onHide} onMove={onMove}
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
  const playbackOnly = Boolean(playbackSelection && !playbackSelection.studyResult);
  const projectOnly = useWorkspaceContentScope() === "project";
  const panelVisible = useLayoutSelector((layout) => layout.panelVisible);
  const hasAuxViewportModule = !projectOnly && !playbackOnly && kernel.modules.forSlot("viewport-aux").length > 0;
  const [dockState, setDockState] = useState<WorkspaceDockState>({ layout: DEFAULT_WORKSPACE_LAYOUT, restored: false });
  const [panelModes, setPanelModes] = useState<Record<string, PanelMode>>({});
  const panels = useRef<Record<string, PanelImperativeHandle | null>>({});
  // Narrow windows give the content the width: side panels collapse to their
  // rails below 760 px and come back as they were when the window widens.
  // A rail icon still opens a panel docked in a narrow window.
  const narrowRestore = useRef<{ left: boolean; right: boolean } | null>(null);
  useEffect(() => {
    // Environments without media queries (jsdom, embedded hosts) keep the layout as is.
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 759px)");
    const apply = () => {
      const visibleNow = kernel.layout.get().panelVisible;
      if (query.matches && narrowRestore.current === null) {
        narrowRestore.current = { left: visibleNow.left, right: visibleNow.right };
        kernel.layout.setPanelVisible("left", false);
        kernel.layout.setPanelVisible("right", false);
      } else if (!query.matches && narrowRestore.current !== null) {
        const previous = narrowRestore.current;
        narrowRestore.current = null;
        kernel.layout.setPanelVisible("left", previous.left);
        kernel.layout.setPanelVisible("right", previous.right);
      }
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [kernel]);

  useEffect(() => {
    const restore = (event?: Event) => {
      let layout = DEFAULT_WORKSPACE_LAYOUT;
      try { layout = restoreWorkspaceLayout(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)); } catch { /* Storage is optional. */ }
      setDockState({ layout, restored: true });
      setPanelModes(event ? {} : Object.fromEntries(
        [...layout.columns.map(column => column.slotId), "panel-bottom"].map(id => [id, readPanelFramePreference(id).mode]),
      ));
    };
    restore();
    window.addEventListener(WORKSPACE_LAYOUT_RESTORED_EVENT, restore);
    return () => { window.removeEventListener(WORKSPACE_LAYOUT_RESTORED_EVENT, restore); };
  }, []);
  useEffect(() => { if (dockState.restored) persistWorkspaceLayout(dockState.layout); }, [dockState]);
  const changeMode = useCallback((id: string, mode: PanelMode) => {
    setPanelModes(previous => previous[id] === mode ? previous : { ...previous, [id]: mode });
  }, []);
  const changeBottomMode = useCallback((mode: PanelMode) => changeMode("panel-bottom", mode), [changeMode]);
  const visible = useCallback((id: string) => playbackOnly && id === "panel-right"
    ? true
    : id === "panel-left" ? panelVisible.left : id === "panel-right" ? panelVisible.right : true,
    [panelVisible.left, panelVisible.right, playbackOnly],
  );
  const dockedPanels = useMemo<Record<string, boolean>>(() => ({
    ...Object.fromEntries(dockState.layout.columns.map(({ slotId }) => [
      slotId, visible(slotId) && (slotId === "viewport-main" || (panelModes[slotId] ?? "docked") === "docked"),
    ])),
    "panel-bottom": panelVisible.bottom && (panelModes["panel-bottom"] ?? "docked") === "docked",
  }), [dockState.layout.columns, panelModes, panelVisible.bottom, visible]);
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
  const move = (id: string, direction: -1 | 1) => {
    const index = columns.findIndex(column => column.slotId === id);
    const neighbour = columns[index + direction];
    if (neighbour) setDockState(current => ({ ...current, layout: moveWorkspaceColumn(current.layout, id, neighbour.slotId) }));
  };
  if (!dockState.restored) return <div className="fm-workspace-body" data-dock-hydration-pending="true" id="fm-main-content" tabIndex={-1}>
    {columns.map(column => visible(column.slotId) ? <div key={column.slotId} className="fm-dock-column"><section className="fm-slot" data-slot-id={column.slotId} aria-label={column.label} aria-busy="true" /></div> : null)}
    {!projectOnly && !playbackOnly && panelVisible.bottom ? <div className="fm-workspace-bottom-panel"><section className="fm-slot" data-slot-id="panel-bottom" aria-label="Diagnostics" aria-busy="true" /></div> : null}
  </div>;

  return <div className="fm-workspace-body" id="fm-main-content" tabIndex={-1}>
    <ResizablePanelGroup autoSaveId="fullmag-workspace-main:retained-v1" direction="vertical" panelCount={projectOnly || playbackOnly ? 1 : 2}>
      <ResizablePanel defaultSize="78%" id="workspace-main" minSize="160px">
        <div className="fm-workspace-main-row">
        {!projectOnly && !playbackOnly ? <WorkspaceSideRail side="left" /> : null}
        <SortableList id="workspace-dock-columns" items={columns.map(column => column.slotId)} onMove={(activeId, overId) => setDockState(current => ({ ...current, layout: moveWorkspaceColumn(current.layout, activeId, overId) }))}>
          <ResizablePanelGroup autoSaveId={`fullmag-workspace-columns:retained-v1:${columns.map(column => column.slotId).join("|")}`} direction="horizontal" panelCount={columns.length}>
            {columns.map((column, index) => <Fragment key={column.slotId}>
              <ResizablePanel id={column.slotId} defaultSize={column.defaultSize} minSize={column.slotId === "panel-right" ? "240px" : "160px"} maxSize={column.slotId === "panel-right" ? "560px" : column.maxSize} groupResizeBehavior={column.resizeBehavior} collapsible collapsedSize={0} panelRef={handle => { panels.current[column.slotId] = handle; }}>
                <SortableWorkspaceColumn column={column} playbackSelection={playbackSelection} visible={visible(column.slotId)} mode={panelModes[column.slotId] ?? "docked"} changeMode={changeMode} onHide={column.slotId === "panel-left" ? () => kernel.layout.setPanelVisible("left", false) : column.slotId === "panel-right" && !playbackOnly ? () => kernel.layout.setPanelVisible("right", false) : undefined} onMove={direction => move(column.slotId, direction)} />
              </ResizablePanel>
              {index < columns.length - 1 ? <ResizableHandle className="fm-resize-handle--vertical" aria-label={`Resize ${column.label} and ${columns[index + 1].label} panels`} onDoubleClick={column.slotId === "panel-right" || columns[index + 1].slotId === "panel-right" ? resetInspectorWidth : undefined} style={dockedPanels[column.slotId] === false || dockedPanels[columns[index + 1].slotId] === false ? { display: "none" } : undefined} /> : null}
            </Fragment>)}
          </ResizablePanelGroup>
        </SortableList>
        {!projectOnly && !playbackOnly ? <WorkspaceSideRail side="right" /> : null}
        </div>
      </ResizablePanel>
      {!projectOnly && !playbackOnly ? <>
        <ResizableHandle className="fm-resize-handle--horizontal" aria-label="Resize bottom diagnostics" style={dockedPanels["panel-bottom"] === false ? { display: "none" } : undefined} />
        <ResizablePanel defaultSize={`${dockState.layout.bottomDockDefaultSize}%`} minSize="100px" className="fm-workspace-bottom-panel" id="panel-bottom" collapsible collapsedSize={0} panelRef={handle => { panels.current["panel-bottom"] = handle; }}>
          <PanelFrame id="panel-bottom" title="Diagnostics" visible={panelVisible.bottom} mode={panelModes["panel-bottom"] ?? "docked"} onModeChange={changeBottomMode} onHide={() => kernel.layout.setPanelVisible("bottom", false)}>
            <SlotHost slotId="panel-bottom" />
          </PanelFrame>
        </ResizablePanel>
      </> : null}
    </ResizablePanelGroup>
    {!playbackOnly ? (
      <div role="group" className="fm-panel-restore-bar" aria-label="Restore hidden panels">
        {/* Explorer and Inspector reopen from their side rails. */}
        {projectOnly && !panelVisible.left ? <Button data-restore-panel="panel-left" size="sm" variant="secondary" onClick={() => kernel.layout.setPanelVisible("left", true)}>Restore Explorer</Button> : null}
        {projectOnly && !panelVisible.right ? <Button data-restore-panel="panel-right" size="sm" variant="secondary" onClick={() => kernel.layout.setPanelVisible("right", true)}>Restore Inspector</Button> : null}
        {!projectOnly && !panelVisible.bottom ? <Button data-restore-panel="panel-bottom" size="sm" variant="secondary" onClick={() => kernel.layout.setPanelVisible("bottom", true)}>Restore Diagnostics</Button> : null}
      </div>
    ) : null}
  </div>;
}
