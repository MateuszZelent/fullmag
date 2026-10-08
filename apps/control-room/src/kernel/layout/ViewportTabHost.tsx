"use client";

import { X } from "lucide-react";
import { useEffect, useMemo } from "react";

import { Button } from "@/shared/ui/Button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/Resizable";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

import { useKernel } from "../KernelContext";
import type { ModuleManifest } from "../types";

import { MountedModule } from "./SlotHost";
import { useLayoutActions, useLayoutSelector } from "./useLayout";

function selectActiveViewportModule(
  modules: ModuleManifest[],
  activeModuleId: string,
): ModuleManifest | null {
  return (
    modules.find((module) => module.id === activeModuleId) ??
    modules[0] ??
    null
  );
}

export function ViewportTabHost() {
  const kernel = useKernel();
  const modules = useMemo(
    () => kernel.modules.forSlot("viewport-main"),
    [kernel.modules],
  );
  const activeModuleId = useLayoutSelector(
    (layout) => layout.activeViewportMainModuleId,
  );
  const companion = useLayoutSelector((layout) => layout.viewportCompanion ?? null);
  const { setActiveViewportMainModule, setViewportCompanion } = useLayoutActions();
  const activeModule = selectActiveViewportModule(modules, activeModuleId);
  const companionModule = companion && companion.moduleId !== activeModule?.id
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
        onValueChange={setActiveViewportMainModule}
        value={activeModule.id}
      >
        <div className="fm-viewport-tabs__bar">
          <TabsList aria-label="Viewport surfaces" className="fm-viewport-tabs__list">
            {modules.map((module) => (
              <TabsTrigger
                key={module.id}
                className="fm-viewport-tabs__trigger"
                data-companion={module.id === companionModule?.id || undefined}
                value={module.id}
              >
                {module.title}
              </TabsTrigger>
            ))}
          </TabsList>
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
        </div>
        <div className="fm-viewport-tabs__surface">
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

export const __viewportTabHostTestUtils = {
  selectActiveViewportModule,
};
