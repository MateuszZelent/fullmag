"use client";

import { Columns2, Rows2, ArrowLeftRight, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { PanelChrome, PanelFrame, usePanelChromeControls, type PanelMode, type PanelModeRequest, type PanelMoveEvent } from "@/shared/ui/PanelFrame";
import { Button } from "@/shared/ui/Button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/Resizable";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

import { useKernel } from "../KernelContext";
import type { ModuleManifest } from "../types";
import { MountedModule } from "./SlotHost";
import { hitTestDockEdge, planViewportDock, type DockEdge } from "./viewportDocking";
import { useLayoutActions, useLayoutSelector } from "./useLayout";

interface DockBounds { left: number; top: number; width: number; height: number }
const ignoreDockChange = () => undefined;

function selectActiveViewportModule(modules: ModuleManifest[], activeModuleId: string): ModuleManifest | null {
  return modules.find(module => module.id === activeModuleId) ?? modules[0] ?? null;
}

/** Only anchors participate in the splitter. Renderer parents never move. */
function DockAnchor({ id, surface, onBounds }: {
  id: string;
  surface: RefObject<HTMLDivElement | null>;
  onBounds: (id: string, bounds: DockBounds) => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = anchor.current;
    const host = surface.current;
    if (!node || !host) return;
    const measure = () => {
      const rect = node.getBoundingClientRect(), parent = host.getBoundingClientRect();
      onBounds(id, { left: rect.left - parent.left, top: rect.top - parent.top, width: rect.width, height: rect.height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(host);
    measure();
    return () => observer.disconnect();
  }, [id, onBounds, surface]);
  return <div ref={anchor} className="fm-viewport-dock-anchor" data-dock-anchor={id} aria-hidden="true" />;
}

function WindowChrome({ title, onHide }: { title: string; onHide: () => void }) {
  const chrome = usePanelChromeControls();
  return <PanelChrome>
    <span className="fm-panel-chrome__title">{title}</span>
    <Button aria-label={`Hide ${title} window`} size="icon" variant="ghost"
      onClick={() => chrome ? chrome.hideWith(onHide) : onHide()}><X aria-hidden="true" size={14} /></Button>
  </PanelChrome>;
}

function ViewportWindow({ manifest, visible, bounds, modeRequest, onMoveGesture, onModeChange, onDock, onHide }: {
  manifest: ModuleManifest;
  visible: boolean;
  bounds?: DockBounds;
  modeRequest?: PanelModeRequest;
  onMoveGesture: (id: string, event: PanelMoveEvent) => void;
  onModeChange: (id: string, mode: PanelMode) => void;
  onDock: (id: string) => void;
  onHide: (id: string) => void;
}) {
  const kernel = useKernel();
  const reportMode = useCallback((mode: PanelMode) => onModeChange(manifest.id, mode), [manifest.id, onModeChange]);
  const moveGesture = useCallback((event: PanelMoveEvent) => onMoveGesture(manifest.id, event), [manifest.id, onMoveGesture]);
  const dock = useCallback(() => onDock(manifest.id), [manifest.id, onDock]);
  const hide = useCallback(() => onHide(manifest.id), [manifest.id, onHide]);
  return <div className="fm-viewport-window" id={`fm-viewport-window-${manifest.id}`} data-viewport-window={manifest.id}
    hidden={!visible} style={bounds ?? { inset: 0 }}>
    <PanelFrame id={`viewport-module:${manifest.id}`} title={manifest.title} visible={visible}
      dragToFloat modeRequest={modeRequest} onMoveGesture={moveGesture} onModeChange={reportMode} onDockChange={ignoreDockChange} onDock={dock} onHide={hide}>
      <WindowChrome title={manifest.title} onHide={hide} />
      {visible ? <div className="fm-viewport-window__content"><MountedModule kernel={kernel} manifest={manifest} slotId="viewport-main" /></div> : null}
    </PanelFrame>
  </div>;
}

export function ViewportTabHost() {
  const kernel = useKernel();
  const modules = useMemo(() => kernel.modules.forSlot("viewport-main"), [kernel.modules]);
  const activeModuleId = useLayoutSelector(layout => layout.activeViewportMainModuleId);
  const companion = useLayoutSelector(layout => layout.viewportCompanion ?? null);
  const { setActiveViewportMainModule, setViewportCompanion } = useLayoutActions();
  const activeModule = selectActiveViewportModule(modules, activeModuleId);
  const companionModule = companion && companion.moduleId !== activeModule?.id
    ? modules.find(module => module.id === companion.moduleId) ?? null : null;
  const surface = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ id: string; edge: DockEdge | null } | null>(null);
  const [modeRequests, setModeRequests] = useState<Record<string, PanelModeRequest>>({});
  const [layoutRequest, setLayoutRequest] = useState<{ layout: Record<string, number>; onApplied: () => void } | undefined>();
  const [modes, setModes] = useState<Record<string, PanelMode>>({});
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [bounds, setBounds] = useState<Record<string, DockBounds>>({});
  const reportMode = useCallback((id: string, mode: PanelMode) => {
    setModes(previous => previous[id] === mode ? previous : { ...previous, [id]: mode });
  }, []);
  const reportBounds = useCallback((id: string, next: DockBounds) => {
    setBounds(previous => {
      const old = previous[id];
      return old && old.left === next.left && old.top === next.top && old.width === next.width && old.height === next.height
        ? previous : { ...previous, [id]: next };
    });
  }, []);
  const hide = useCallback((id: string) => setHidden(previous => ({ ...previous, [id]: true })), []);
  const dock = useCallback((id: string) => {
    const layout = kernel.layout.get();
    if (layout.activeViewportMainModuleId !== id) {
      kernel.layout.setViewportCompanion({ moduleId: id, placement: layout.viewportCompanion?.placement ?? "beside" });
    }
  }, [kernel.layout]);
  const moveGesture = (id: string, event: PanelMoveEvent) => {
    if (event.phase === "cancel") { setPreview(null); return; }
    const area = surface.current?.getBoundingClientRect();
    const edge = area ? hitTestDockEdge(area, event) : null;
    if (event.phase === "move") {
      setPreview(previous => previous?.id === id && previous.edge === edge ? previous : { id, edge });
      return;
    }
    setPreview(null);
    if (!edge || !activeModule) return;
    const selectedIds = [activeModule.id, ...(companionModule ? [companionModule.id] : [])];
    const visibleIds = modules.filter(module => !hidden[module.id] &&
      (selectedIds.includes(module.id) || modes[module.id] === "floating" || modes[module.id] === "maximized")).map(module => module.id);
    const dockedIds = selectedIds.filter(moduleId => visibleIds.includes(moduleId) && (!modes[moduleId] || modes[moduleId] === "docked"));
    const plan = planViewportDock(id, edge, selectedIds, visibleIds, dockedIds);
    const placements: Record<string, "docked" | "floating"> = {};
    for (const displaced of plan.displacedIds) placements[displaced] = "floating";
    placements[plan.primaryId] = "docked";
    if (plan.companionId) placements[plan.companionId] = "docked";
    setModeRequests(previous => {
      const next = { ...previous };
      for (const [moduleId, mode] of Object.entries(placements)) next[moduleId] = { mode, sequence: (previous[moduleId]?.sequence ?? 0) + 1 };
      return next;
    });
    setModes(previous => ({ ...previous, ...placements }));
    if (plan.companionId) setLayoutRequest({ layout: { "viewport-window:first": 50, "viewport-window:second": 50 }, onApplied: () => setLayoutRequest(undefined) });
    kernel.layout.replace({ ...kernel.layout.get(), activeViewportMainModuleId: plan.primaryId,
      viewportCompanion: plan.companionId ? { moduleId: plan.companionId, placement: plan.placement } : null });
  };
  const select = (id: string) => {
    setHidden(previous => previous[id] ? { ...previous, [id]: false } : previous);
    // Selecting a visible floating/companion window focuses it, preserving the
    // other visible windows and the current dock composition.
    if ((!modes[id] || modes[id] === "docked") && companionModule?.id !== id) setActiveViewportMainModule(id);
    document.getElementById(`fm-viewport-window-${id}`)?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  };
  const swap = () => {
    if (!activeModule || !companionModule || !companion) return;
    kernel.layout.replace({ ...kernel.layout.get(), activeViewportMainModuleId: companionModule.id,
      viewportCompanion: { moduleId: activeModule.id, placement: companion.placement } });
  };
  useEffect(() => {
    if (activeModule && activeModule.id !== activeModuleId) setActiveViewportMainModule(activeModule.id);
  }, [activeModule, activeModuleId, setActiveViewportMainModule]);
  useEffect(() => {
    const reset = () => setHidden({});
    window.addEventListener("fullmag:workspace-layout-restored", reset);
    return () => window.removeEventListener("fullmag:workspace-layout-restored", reset);
  }, []);

  if (!activeModule) return <section className="fm-slot" data-slot-id="viewport-main"><div className="fm-slot__empty">No module mounted</div></section>;
  const isSelected = (id: string) => id === activeModule.id || id === companionModule?.id;
  const isFloating = (id: string) => modes[id] === "floating" || modes[id] === "maximized";
  const docked = [activeModule, companionModule].filter((module): module is ModuleManifest => Boolean(module && !hidden[module.id] && !isFloating(module.id)));
  const previewHasPeer = preview && modules.some(module => module.id !== preview.id && !hidden[module.id] && (isSelected(module.id) || isFloating(module.id)));
  const direction = companion?.placement === "below" ? "vertical" : "horizontal";

  return <section className="fm-slot fm-viewport-tabs" data-active-module-id={activeModule.id}
    data-companion-module-id={companionModule?.id} data-slot-id="viewport-main">
    <Tabs activationMode="manual" className="fm-viewport-tabs__root" onValueChange={select} value={activeModule.id}>
      <PanelChrome className="fm-viewport-tabs__bar">
        <TabsList aria-label="Viewport surfaces" className="fm-viewport-tabs__list">
          {modules.map(module => <TabsTrigger key={module.id} className="fm-viewport-tabs__trigger"
            data-companion={module.id === companionModule?.id || undefined} data-restore-panel={`viewport-module:${module.id}`} value={module.id} onClick={() => select(module.id)}>
            {module.title}
          </TabsTrigger>)}
        </TabsList>
        {companionModule && companion ? <>
          <Button aria-label="Arrange viewport windows side by side" size="icon" variant="ghost" onClick={() => setViewportCompanion({ ...companion, placement: "beside" })}><Columns2 aria-hidden="true" size={14} /></Button>
          <Button aria-label="Arrange viewport windows vertically" size="icon" variant="ghost" onClick={() => setViewportCompanion({ ...companion, placement: "below" })}><Rows2 aria-hidden="true" size={14} /></Button>
          <Button aria-label="Swap viewport window positions" size="icon" variant="ghost" onClick={swap}><ArrowLeftRight aria-hidden="true" size={14} /></Button>
          <Button aria-label={`Close ${companionModule.title} split view`} size="icon" variant="ghost" onClick={() => setViewportCompanion(null)}><X aria-hidden="true" size={14} /></Button>
        </> : null}
      </PanelChrome>
      <div ref={surface} className="fm-viewport-tabs__surface">
        {docked.length === 2 ? <ResizablePanelGroup autoSaveId={`fullmag.viewport-windows.split.${direction}`} direction={direction} panelCount={2} layoutRequest={layoutRequest}>
          <ResizablePanel defaultSize={50} id="viewport-window:first" minSize={20}><DockAnchor id={docked[0].id} surface={surface} onBounds={reportBounds} /></ResizablePanel>
          <ResizableHandle className={direction === "vertical" ? "fm-resize-handle--horizontal" : "fm-resize-handle--vertical"} />
          <ResizablePanel defaultSize={50} id="viewport-window:second" minSize={20}><DockAnchor id={docked[1].id} surface={surface} onBounds={reportBounds} /></ResizablePanel>
        </ResizablePanelGroup> : docked[0] ? <DockAnchor id={docked[0].id} surface={surface} onBounds={reportBounds} />
          : <div className="fm-slot__empty">Windows are floating or hidden. Use a window menu to dock, or a tab to restore.</div>}
        {modules.map(module => <ViewportWindow key={module.id} manifest={module}
          visible={!hidden[module.id] && (isSelected(module.id) || isFloating(module.id))}
          bounds={bounds[module.id]} modeRequest={modeRequests[module.id]} onMoveGesture={moveGesture} onModeChange={reportMode} onDock={dock} onHide={hide} />)}
        {preview ? <div className="fm-dock-guides" aria-hidden="true">
          {(["left", "right", "top", "bottom"] as const).map(edge => <span key={edge} className={`fm-dock-guide fm-dock-guide--${edge}`} data-active={preview.edge === edge}>{edge === "left" ? "◀" : edge === "right" ? "▶" : edge === "top" ? "▲" : "▼"}</span>)}
        </div> : null}
        {preview?.edge ? <div className={`fm-dock-preview fm-dock-preview--${previewHasPeer ? preview.edge : "full"}`} data-dock-preview={preview.edge} role="status">
          <span>Release to dock {preview.edge}</span>
        </div> : null}
      </div>
    </Tabs>
  </section>;
}

export const __viewportTabHostTestUtils = { selectActiveViewportModule };
