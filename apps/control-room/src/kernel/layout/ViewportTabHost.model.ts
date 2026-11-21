import type { ModuleManifest } from "../types";

export function selectActiveViewportModule(
  modules: ModuleManifest[],
  activeModuleId: string,
): ModuleManifest | null {
  return (
    modules.find((module) => module.id === activeModuleId) ??
    modules[0] ??
    null
  );
}

export const __viewportTabHostTestUtils = {
  selectActiveViewportModule,
};
