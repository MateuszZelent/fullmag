import type { KernelApi } from "../types";

import type { CommandContext } from "./commandTypes";

export function createCommandContext(
  source: CommandContext["source"],
  kernel: KernelApi,
): CommandContext {
  return {
    source,
    layout: kernel.layout,
    selection: kernel.selection,
  };
}
