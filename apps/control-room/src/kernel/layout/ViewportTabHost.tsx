"use client";

import { Columns2, Rows2, ArrowLeftRight, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { PanelChrome, PanelFrame, type PanelMode } from "@/shared/ui/PanelFrame";
import { Button } from "@/shared/ui/Button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/Resizable";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

import { useKernel } from "../KernelContext";
import type { ModuleManifest } from "../types";
import { MountedModule } from "./SlotHost";
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

function ViewportWindow({ manifest, visible, bounds, onModeChange, onDock, onHide }: {
  manifest: ModuleManifest;
  visible: boolean;
  bounds?: DockBounds;
  onModeChange: (id: string, mode: PanelMode) => void;
  onDock: (id: string) => void;
  onHide: (id: string) => void;
}) {
  const kernel = useKernel();
  const reportMode = useCallback((mode: PanelMode) => onModeChange(manifest.id, mode), [manifest.id, onModeChange]);
  const dock = useCallback(() => onDock(manifest.id), [manifest.id, onDock]);
  const hide = useCallback(() => onHide(manifest.id), [manifest.id, onHide]);
  return <div className="fm-viewport-window" id={`fm-viewport-window-${manifest.id}`} data-viewport-window={manifest.id}
    hidden={!visible} style={bounds ?? { inset: 0 }}>
    <PanelFrame id={`viewport-module:${manifest.id}`} title={manifest.title} visible={visible}
      dragToFloat onModeChange={reportMode} onDockChange={ignoreDockChange} onDock={dock} onHide={hide}>
      <PanelChrome>
        <span className="fm-panel-chrome__title">{manifest.title}</span>
        <Button aria-label={`Hide ${manifest.title} window`} size="icon" variant="ghost" onClick={hide}><X aria-hidden="true" size={14} /></Button>
      </PanelChrome>
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
  const select = (id: string) => {
    setHidden(previous => previous[id] ? { ...previous, [id]: false } : previous);
    // Selecting a visible floating/companion window focuses it, preserving the
    // other visible windows and the current dock composition.
    if ((!modes[id] || modes[id] === "docked") && companionModule?.id !== id) setActiveViewportMainModule(id);
    document.getElementById(`fm-viewport-window-${id}`)?.querySelector<HTMLButtonElement>("button")?.focus();
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
  const direction = companion?.placement === "below" ? "vertical" : "horizontal";

  return <section className="fm-slot fm-viewport-tabs" data-active-module-id={activeModule.id}
    data-companion-module-id={companionModule?.id} data-slot-id="viewport-main">
    <Tabs className="fm-viewport-tabs__root" onValueChange={select} value={activeModule.id}>
      <PanelChrome className="fm-viewport-tabs__bar">
        <TabsList aria-label="Viewport surfaces" className="fm-viewport-tabs__list">
          {modules.map(module => <TabsTrigger key={module.id} className="fm-viewport-tabs__trigger"
            data-companion={module.id === companionModule?.id || undefined} value={module.id} onClick={() => select(module.id)}>
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
        {docked.length === 2 ? <ResizablePanelGroup autoSaveId={`fullmag.viewport-windows.split.${direction}`} direction={direction} panelCount={2}>
          <ResizablePanel defaultSize={50} id="viewport-window:first" minSize={20}><DockAnchor id={docked[0].id} surface={surface} onBounds={reportBounds} /></ResizablePanel>
          <ResizableHandle className={direction === "vertical" ? "fm-resize-handle--horizontal" : "fm-resize-handle--vertical"} />
          <ResizablePanel defaultSize={50} id="viewport-window:second" minSize={20}><DockAnchor id={docked[1].id} surface={surface} onBounds={reportBounds} /></ResizablePanel>
        </ResizablePanelGroup> : docked[0] ? <DockAnchor id={docked[0].id} surface={surface} onBounds={reportBounds} />
          : <div className="fm-slot__empty">Windows are floating or hidden. Use a window menu to dock, or a tab to restore.</div>}
        {modules.map(module => <ViewportWindow key={module.id} manifest={module}
          visible={!hidden[module.id] && (isSelected(module.id) || isFloating(module.id))}
          bounds={bounds[module.id]} onModeChange={reportMode} onDock={dock} onHide={hide} />)}
      </div>
    </Tabs>
  </section>;
}

export const __viewportTabHostTestUtils = { selectActiveViewportModule };
