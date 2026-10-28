"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/shared/ui/Button";
import { PanelChrome, PanelFrame, type PanelModeRequest, type PanelMoveEvent } from "@/shared/ui/PanelFrame";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/Resizable";
import { DEFAULT_WORKSPACE_LAYOUT, WORKSPACE_LAYOUT_RESTORED_EVENT, type WorkspaceColumnLayout } from "./layoutModel";
import { DockAnchor, type DockBounds } from "./DockAnchor";
import { WORKSPACE_EXPLICIT_DOCK_KEY, restoreExplicitDocked, defaultWorkspaceTree, dockWorkspacePane, filterWorkspaceTree, resizeWorkspaceSplit, restoreWorkspaceTree, WORKSPACE_TREE_KEY, type WorkspaceDockTree, type WorkspacePaneId } from "./workspaceDocking";
import { hitTestDockEdge, type DockEdge } from "./viewportDocking";
import { SlotHost } from "./SlotHost";
import { ViewportTabHost } from "./ViewportTabHost";
import { useWorkspaceContentScope } from "./WorkspaceContentScope";
import { useKernel } from "../KernelContext";
import type { SavedResultsPlaybackSelection } from "../saved-results/SavedResultsPlaybackController";
import { useSavedResultsPlaybackSelection } from "../saved-results/useSavedResultsPlayback";
import { useLayoutSelector } from "./useLayout";

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


/** Layout containers hold measuring anchors, never live module content. */
function TreeAnchors({ tree, surface, onBounds, onResize }: {
  tree: WorkspaceDockTree; surface: RefObject<HTMLDivElement | null>;
  onBounds: (id: string, bounds: DockBounds) => void;
  onResize: (id: string, ratio: number) => void;
}) {
  if (tree.kind === "pane") return <DockAnchor id={tree.pane} surface={surface} onBounds={onBounds} />;
  const firstId = `${tree.id}:first`, secondId = `${tree.id}:second`;
  return <ResizablePanelGroup key={tree.id} direction={tree.axis} panelCount={2}
    onLayoutChanged={layout => onResize(tree.id, layout[firstId])}>
    <ResizablePanel id={firstId} defaultSize={`${tree.ratio}%`} minSize={tree.axis === "horizontal" ? "100px" : "80px"}>
      <TreeAnchors tree={tree.first} surface={surface} onBounds={onBounds} onResize={onResize} />
    </ResizablePanel>
    <ResizableHandle className={tree.axis === "horizontal" ? "fm-resize-handle--vertical" : "fm-resize-handle--horizontal"} aria-label="Resize adjacent workspace panels" />
    <ResizablePanel id={secondId} defaultSize={`${100-tree.ratio}%`} minSize={tree.axis === "horizontal" ? "100px" : "80px"}>
      <TreeAnchors tree={tree.second} surface={surface} onBounds={onBounds} onResize={onResize} />
    </ResizablePanel>
  </ResizablePanelGroup>;
}

interface WorkspaceWindowProps {
  id: WorkspacePaneId; title: string; visible: boolean; drawer: boolean; drawerShared: boolean;
  bounds?: DockBounds; request?: PanelModeRequest; playbackSelection: SavedResultsPlaybackSelection | null;
  onDockChange: (id: WorkspacePaneId, docked: boolean) => void;
  onMoveGesture: (id: WorkspacePaneId, event: PanelMoveEvent) => void;
  onDockTo: (id: WorkspacePaneId, edge: DockEdge) => void; onHide?: () => void;
}
function WorkspaceWindow({ id, title, visible, drawer, drawerShared, bounds, request, playbackSelection, onDockChange, onMoveGesture, onDockTo, onHide }: WorkspaceWindowProps) {
  const report = useCallback((docked: boolean) => onDockChange(id, docked), [id, onDockChange]);
  const move = (event: PanelMoveEvent) => onMoveGesture(id, event);
  return <div className="fm-workspace-window" data-workspace-pane={id} hidden={!visible} style={bounds ?? { inset: 0 }}>
    <PanelFrame id={id} title={title} visible={visible} dragToFloat drawer={drawer} drawerSide={id === "panel-left" ? "left" : "right"} drawerShared={drawerShared}
      suspendWhenHidden={id !== "panel-right"} modeRequest={request} onMoveGesture={move} onDockChange={report} onHide={onHide}
      placementActions={[...(["left", "right", "top", "bottom"] as const).map(edge => ({ label: `Dock to ${edge} of workspace`, onSelect: () => onDockTo(id, edge) })), { label: "Reset panel arrangement", onSelect: () => window.dispatchEvent(new Event(WORKSPACE_LAYOUT_RESTORED_EVENT)) }]}>
      {id === "viewport-aux" ? <PanelChrome><span className="fm-panel-chrome__title">{title}</span></PanelChrome> : null}
      {id === "panel-bottom" ? <SlotHost slotId="panel-bottom" /> : <WorkspaceColumnContent playbackSelection={playbackSelection} slotId={id} />}
    </PanelFrame>
  </div>;
}
interface DockTarget { edge: DockEdge; target: WorkspacePaneId | null; bounds: DockBounds; title: string }

export function WorkspaceDockLayout() {
  const kernel = useKernel();
  const playbackSelection = useSavedResultsPlaybackSelection();
  const playbackOnly = playbackSelection !== null;
  const projectOnly = useWorkspaceContentScope() === "project";
  const panelVisible = useLayoutSelector(layout => layout.panelVisible);
  const hasAux = !projectOnly && !playbackOnly && kernel.modules.forSlot("viewport-aux").length > 0;
  const [tree, setTree] = useState<WorkspaceDockTree>(defaultWorkspaceTree);
  const [explicitDocked, setExplicitDocked] = useState<WorkspacePaneId[]>([]);
  const [restored, setRestored] = useState(false);
  const [windowWidth, setWindowWidth] = useState(1440);
  const [docked, setDocked] = useState<Partial<Record<WorkspacePaneId, boolean>>>({});
  const [bounds, setBounds] = useState<Record<string, DockBounds>>({});
  const [requests, setRequests] = useState<Partial<Record<WorkspacePaneId, PanelModeRequest>>>({});
  const [preview, setPreview] = useState<DockTarget | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const columns = DEFAULT_WORKSPACE_LAYOUT.columns.filter(column => column.slotId !== "viewport-aux" || hasAux);
  const panes = [...columns.map(column => ({ id: column.slotId as WorkspacePaneId, title: playbackOnly && column.slotId === "panel-left" ? "Saved folder" : column.label })),
    ...(!projectOnly && !playbackOnly ? [{ id: "panel-bottom" as const, title: "Diagnostics" }] : [])];
  const available = new Set(panes.map(pane => pane.id));
  const visible = (id: WorkspacePaneId) => id === "panel-left" ? panelVisible.left : id === "panel-right" ? playbackOnly || panelVisible.right : id === "panel-bottom" ? panelVisible.bottom : true;
  // Explicit docking takes priority over automatic compact-screen drawers.
  const drawer = (id: WorkspacePaneId) => !explicitDocked.includes(id) && ((id === "panel-right" && windowWidth < 1180) || (id === "panel-left" && windowWidth < 760));
  const kept = (id: WorkspacePaneId) => available.has(id) && visible(id) && (docked[id] ?? !drawer(id));
  const activeTree = filterWorkspaceTree(tree, kept);

  useEffect(() => {
    try { setTree(restoreWorkspaceTree(localStorage.getItem(WORKSPACE_TREE_KEY))); setExplicitDocked(restoreExplicitDocked(localStorage.getItem(WORKSPACE_EXPLICIT_DOCK_KEY))); } catch { /* Optional layout preference. */ }
    setRestored(true);
    const reset = () => { setTree(defaultWorkspaceTree()); setExplicitDocked([]); setRequests({}); setDocked({}); setPreview(null); };
    const resize = () => setWindowWidth(window.innerWidth);
    resize();window.addEventListener("resize", resize);window.addEventListener(WORKSPACE_LAYOUT_RESTORED_EVENT, reset);
    return () => { window.removeEventListener("resize", resize);window.removeEventListener(WORKSPACE_LAYOUT_RESTORED_EVENT, reset); };
  }, []);
  useEffect(() => { if (restored) { try { localStorage.setItem(WORKSPACE_TREE_KEY, JSON.stringify(tree)); } catch { /* Optional preference. */ } } }, [tree, restored]);
  useEffect(() => { if (restored) { try { localStorage.setItem(WORKSPACE_EXPLICIT_DOCK_KEY, JSON.stringify(explicitDocked)); } catch { /* Optional preference. */ } } }, [explicitDocked, restored]);
  const reportDocked = useCallback((id: WorkspacePaneId, value: boolean) => setDocked(old => old[id] === value ? old : { ...old, [id]: value }), []);
  const reportBounds = useCallback((id: string, next: DockBounds) => setBounds(old => {
    const previous = old[id];
    return previous && previous.left === next.left && previous.top === next.top && previous.width === next.width && previous.height === next.height ? old : { ...old, [id]: next };
  }), []);
  const resizeSplit = useCallback((id: string, ratio: number) => setTree(old => resizeWorkspaceSplit(old, id, ratio)), []);
  const applyDock = (id: WorkspacePaneId, target: WorkspacePaneId | null, edge: DockEdge) => {
    setPreview(null);
    const splitId = crypto.randomUUID();
    setExplicitDocked(old => old.includes(id) ? old : [...old, id]);
    setTree(old => dockWorkspacePane(old, id, target, edge, splitId));
    setRequests(old => ({ ...old, [id]: { mode: "docked", sequence: (old[id]?.sequence ?? 0)+1 } }));
    setDocked(old => ({ ...old, [id]: true }));
  };
  const moveGesture = (id: WorkspacePaneId, event: PanelMoveEvent) => {
    if (event.phase === "cancel") { setPreview(null); return; }
    const root = surface.current?.getBoundingClientRect();
    if (!root) return;
    let target: DockTarget | null = null;
    const rootEdge = hitTestDockEdge(root, event);
    const rootDistance = rootEdge === "left" ? Math.abs(event.x-root.left) : rootEdge === "right" ? Math.abs(event.x-root.right) : rootEdge === "top" ? Math.abs(event.y-root.top) : Math.abs(event.y-root.bottom);
    if (rootEdge && rootDistance <= 20) target = { edge: rootEdge, target: null, bounds: { left: 0, top: 0, width: root.width, height: root.height }, title: "workspace" };
    else for (const pane of panes) {
      const b = bounds[pane.id];
      if (pane.id === id || !kept(pane.id) || !b) continue;
      if (event.x < root.left+b.left || event.x > root.left+b.left+b.width || event.y < root.top+b.top || event.y > root.top+b.top+b.height) continue;
      const edge = hitTestDockEdge({ left: root.left+b.left, top: root.top+b.top, width: b.width, height: b.height }, event);
      if (edge) { target = { edge, target: pane.id, bounds: b, title: pane.title };break; }
    }
    if (event.phase === "drop") { if (target) applyDock(id, target.target, target.edge); else setPreview(null); return; }
    setPreview(previous => previous?.edge === target?.edge && previous?.target === target?.target && previous?.bounds.left === target?.bounds.left && previous?.bounds.top === target?.bounds.top && previous?.bounds.width === target?.bounds.width && previous?.bounds.height === target?.bounds.height ? previous : target);
  };
  const hide = (id: WorkspacePaneId) => id === "panel-left" ? () => kernel.layout.setPanelVisible("left", false)
    : id === "panel-right" && !playbackOnly ? () => kernel.layout.setPanelVisible("right", false)
    : id === "panel-bottom" ? () => kernel.layout.setPanelVisible("bottom", false) : undefined;

  if (!restored) return <div className="fm-workspace-body" data-dock-hydration-pending="true" id="fm-main-content" tabIndex={-1}>
    {columns.filter(column => visible(column.slotId)).map(column => <div key={column.slotId} className="fm-dock-column"><section className="fm-slot" data-slot-id={column.slotId} aria-label={column.label} aria-busy="true" /></div>)}
    {!projectOnly && !playbackOnly && panelVisible.bottom ? <div className="fm-workspace-bottom-panel"><section className="fm-slot" data-slot-id="panel-bottom" aria-label="Diagnostics" aria-busy="true" /></div> : null}
  </div>;
  const previewStyle = preview ? { left: preview.bounds.left + (preview.edge === "right" ? preview.bounds.width/2 : 0), top: preview.bounds.top + (preview.edge === "bottom" ? preview.bounds.height/2 : 0),
    width: preview.bounds.width / (preview.edge === "left" || preview.edge === "right" ? 2 : 1), height: preview.bounds.height / (preview.edge === "top" || preview.edge === "bottom" ? 2 : 1) } : undefined;
  return <div ref={surface} className="fm-workspace-body" id="fm-main-content" tabIndex={-1}>
    <div className="fm-workspace-docking-tree">{activeTree ? <TreeAnchors tree={activeTree} surface={surface} onBounds={reportBounds} onResize={resizeSplit} /> : <div className="fm-slot__empty">Drag a window to an edge to dock it.</div>}</div>
    {panes.map(pane => <WorkspaceWindow key={pane.id} id={pane.id} title={pane.title} visible={visible(pane.id)} drawer={drawer(pane.id)}
      drawerShared={drawer("panel-left") && drawer("panel-right") && visible("panel-left") && visible("panel-right")} bounds={bounds[pane.id]} request={requests[pane.id]} playbackSelection={playbackSelection}
      onDockChange={reportDocked} onMoveGesture={moveGesture} onDockTo={(id, edge) => applyDock(id, null, edge)} onHide={hide(pane.id)} />)}
    {preview ? <div className="fm-workspace-dock-preview" data-workspace-dock-preview={preview.edge} data-dock-target={preview.target ?? "workspace"} style={previewStyle} role="status"><span>Release to dock {preview.edge} of {preview.title}</span></div> : null}
    {!playbackOnly ? <div className="fm-panel-restore-bar" aria-label="Restore hidden panels">
      {!panelVisible.left ? <Button data-restore-panel="panel-left" size="sm" variant="secondary" onClick={() => kernel.layout.setPanelVisible("left", true)}>Restore Explorer</Button> : null}
      {!panelVisible.right ? <Button data-restore-panel="panel-right" size="sm" variant="secondary" onClick={() => kernel.layout.setPanelVisible("right", true)}>Restore Inspector</Button> : null}
      {!projectOnly && !panelVisible.bottom ? <Button data-restore-panel="panel-bottom" size="sm" variant="secondary" onClick={() => kernel.layout.setPanelVisible("bottom", true)}>Restore Diagnostics</Button> : null}
    </div> : null}
  </div>;
}
