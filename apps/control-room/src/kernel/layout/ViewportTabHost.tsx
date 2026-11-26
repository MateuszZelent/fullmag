"use client";

import {
  Activity,
  Box,
  ChartSpline,
  Grid3x3,
  LayoutGrid,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PanelChrome } from "@/shared/ui/PanelFrame";
import { Button } from "@/shared/ui/Button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/Resizable";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/Tooltip";

import { useKernel } from "../KernelContext";

import { MountedModule } from "./SlotHost";
import { useLayoutActions, useLayoutSelector } from "./useLayout";
import { selectActiveViewportModule } from "./ViewportTabHost.model";

/* Center surfaces use the same icon rail language as the side rails
   (specs/frontend-v2/10 §1a); unknown surfaces fall back to a grid glyph. */
const VIEWPORT_SURFACE_ICONS: Record<string, LucideIcon> = {
  "analysis-plots": ChartSpline,
  "field-map": Grid3x3,
  "live-charts": Activity,
  "viewport-3d": Box,
};

export function ViewportTabHost({ savedOnly = false }: { savedOnly?: boolean }) {
  const kernel = useKernel();
  const modules = useMemo(
    () =>
      kernel.modules.forSlot("viewport-main").filter(
        (module) => !savedOnly || module.id === "viewport-3d" || module.id === "field-map",
      ),
    [kernel.modules, savedOnly],
  );
  const activeModuleId = useLayoutSelector(
    (layout) => layout.activeViewportMainModuleId,
  );
  const companion = useLayoutSelector((layout) => layout.viewportCompanion ?? null);
  const { setActiveViewportMainModule, setViewportCompanion } = useLayoutActions();
  // Surfaces ease in only after the user has switched tabs, not on page load.
  const [userSwitched, setUserSwitched] = useState(false);
  const activeModule = selectActiveViewportModule(modules, activeModuleId);
  const companionModule = !savedOnly && companion && companion.moduleId !== activeModule?.id
    ? modules.find((module) => module.id === companion.moduleId) ?? null
    : null;

  useEffect(() => {
    if (activeModule && activeModule.id !== activeModuleId) {
      setActiveViewportMainModule(activeModule.id);
    }
  }, [activeModule, activeModuleId, setActiveViewportMainModule]);

  if (!activeModule) {
    return (
      <section className="fm-slot" data-slot-id="viewport-main">
        <div className="fm-slot__empty">No module mounted</div>
      </section>
    );
  }

  return (
    <section
      className="fm-slot fm-viewport-tabs"
      data-active-module-id={activeModule.id}
      data-companion-module-id={companionModule?.id}
      data-slot-id="viewport-main"
    >
      <Tabs
        className="fm-viewport-tabs__root"
        onValueChange={(moduleId) => {
          setUserSwitched(true);
          setActiveViewportMainModule(moduleId);
        }}
        value={activeModule.id}
      >
        <PanelChrome className="fm-viewport-tabs__bar">
          <TooltipProvider delayDuration={300}>
            <TabsList aria-label="Viewport surfaces" className="fm-viewport-tabs__list">
              {modules.map((module) => {
                const Icon = VIEWPORT_SURFACE_ICONS[module.id] ?? LayoutGrid;
                return (
                  <Tooltip key={module.id}>
                    <TooltipTrigger asChild>
                      <TabsTrigger
                        aria-label={module.title}
                        className="fm-viewport-tabs__trigger"
                        data-companion={module.id === companionModule?.id || undefined}
                        value={module.id}
                      >
                        <Icon aria-hidden="true" size={18} strokeWidth={1.75} />
                        <span className="sr-only">{module.title}</span>
                      </TabsTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{module.title}</TooltipContent>
                  </Tooltip>
                );
              })}
            </TabsList>
          </TooltipProvider>
          {companionModule ? (
            <Button
              aria-label={`Close ${companionModule.title} split view`}
              size="icon"
              type="button"
              variant="ghost"
              onClick={() => setViewportCompanion(null)}
            >
              <X aria-hidden="true" size={14} />
            </Button>
          ) : null}
        </PanelChrome>
        <div className="fm-viewport-tabs__surface" data-surface-motion={userSwitched || undefined}>
          {companionModule && companion ? (
            // Each module keeps a single mounted instance; the split only
            // places the companion (e.g. the 3D viewport) next to the active one.
            <ResizablePanelGroup
              autoSaveId={`fullmag.viewport-main.split.${companion.placement}`}
              direction={companion.placement === "below" ? "vertical" : "horizontal"}
              panelCount={2}
            >
              <ResizablePanel defaultSize={50} id={`viewport-main:${activeModule.id}`} minSize={25}>
                <MountedModule
                  key={activeModule.id}
                  kernel={kernel}
                  manifest={activeModule}
                  slotId="viewport-main"
                />
              </ResizablePanel>
              <ResizableHandle
                className={companion.placement === "below"
                  ? "fm-resize-handle--horizontal"
                  : "fm-resize-handle--vertical"}
              />
              <ResizablePanel defaultSize={50} id={`viewport-main:${companionModule.id}`} minSize={25}>
                <MountedModule
                  key={companionModule.id}
                  kernel={kernel}
                  manifest={companionModule}
                  slotId="viewport-main"
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <MountedModule
              key={activeModule.id}
              kernel={kernel}
              manifest={activeModule}
              slotId="viewport-main"
            />
          )}
        </div>
      </Tabs>
    </section>
  );
}
