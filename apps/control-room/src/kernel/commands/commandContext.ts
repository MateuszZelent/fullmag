import type { KernelApi } from "../types";

import type { CommandContext } from "./commandTypes";

export function createCommandContext(
  source: CommandContext["source"],
  kernel: KernelApi,
  patch: Partial<CommandContext> = {},
): CommandContext {
  return {
    api: kernel.api,
    analysisFieldOverlay: kernel.analysisFieldOverlay,
    bus: kernel.bus,
    chartViewportHandoff: kernel.chartViewportHandoff,
    cameraRegistry: kernel.cameraRegistry,
    input: patch.input,
    source,
    layout: kernel.layout,
    resourceData: patch.resourceData,
    resources: kernel.resources,
    selection: kernel.selection,
    sourceDetail: patch.sourceDetail,
    visualization: kernel.visualization,
    visualizationSync: kernel.visualizationSync,
    visualizationTarget: patch.visualizationTarget,
  };
}
