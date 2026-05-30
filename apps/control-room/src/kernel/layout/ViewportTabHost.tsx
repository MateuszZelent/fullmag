"use client";

import { useEffect, useMemo } from "react";

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
  const { setActiveViewportMainModule } = useLayoutActions();
  const activeModule = selectActiveViewportModule(modules, activeModuleId);

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
                value={module.id}
              >
                {module.title}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <div className="fm-viewport-tabs__surface">
          <MountedModule
            key={activeModule.id}
            kernel={kernel}
            manifest={activeModule}
            slotId="viewport-main"
          />
        </div>
      </Tabs>
    </section>
  );
}

export const __viewportTabHostTestUtils = {
  selectActiveViewportModule,
};
