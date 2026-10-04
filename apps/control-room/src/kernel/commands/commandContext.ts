import type { KernelApi } from "../types";

import type { CommandContext } from "./commandTypes";

export function createCommandContext(
  source: CommandContext["source"],
  kernel: KernelApi,
  patch: Partial<CommandContext> = {},
): CommandContext {
  const sessionScopeKey = patch.sessionScopeKey === undefined
    ? kernel.commands?.getSessionScopeKey?.()
    : patch.sessionScopeKey;
  return {
    api: kernel.api,
    analysisFieldOverlay: kernel.analysisFieldOverlay,
    authoringHistory: kernel.authoringHistory,
    pendingForms: kernel.pendingForms,
    bus: kernel.bus,
    chartViewportHandoff: kernel.chartViewportHandoff,
    cameraRegistry: kernel.cameraRegistry,
    input: patch.input,
    source,
    layout: kernel.layout,
    objectMoveTool: kernel.objectMoveTool,
    projectDocument: kernel.projectDocument,
    resourceData: patch.resourceData,
    resources: kernel.resources,
    sessionScopeKey,
    isCurrentSessionScope: patch.isCurrentSessionScope ?? (sessionScopeKey
      ? () => kernel.commands?.getSessionScopeKey?.() === sessionScopeKey
      : undefined),
    selection: kernel.selection,
    sourceDetail: patch.sourceDetail,
    visualization: kernel.visualization,
    visualizationSync: kernel.visualizationSync,
    visualizationTarget: patch.visualizationTarget,
  };
}
