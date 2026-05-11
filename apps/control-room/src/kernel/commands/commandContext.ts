import type { KernelApi } from "../types";

import type { CommandContext } from "./commandTypes";

export function createCommandContext(
  source: CommandContext["source"],
  kernel: KernelApi,
  patch: Partial<CommandContext> = {},
): CommandContext {
  return {
    api: kernel.api,
    source,
    layout: kernel.layout,
    resourceData: patch.resourceData,
    resources: kernel.resources,
    selection: kernel.selection,
    visualization: kernel.visualization,
  };
}
