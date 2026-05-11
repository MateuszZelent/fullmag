"use client";

import { useMemo, type ReactNode } from "react";

import { CommandRegistry } from "./commands/CommandRegistry";
import { EventBus } from "./events/EventBus";
import type { KernelEventMap } from "./events/eventTypes";
import { KernelContext } from "./KernelContext";
import { ModuleRegistry } from "./module/ModuleRegistry";
import type { KernelApi } from "./types";
import { ALL_MODULES } from "@/modules";

interface KernelProviderProps {
  children: ReactNode;
}

function createKernel(): KernelApi {
  const modules = new ModuleRegistry();
  for (const manifest of ALL_MODULES) {
    modules.register(manifest);
  }

  return {
    bus: new EventBus<KernelEventMap>(),
    commands: new CommandRegistry(),
    modules,
  };
}

export function KernelProvider({ children }: KernelProviderProps) {
  const kernel = useMemo(() => createKernel(), []);

  return (
    <KernelContext.Provider value={kernel}>{children}</KernelContext.Provider>
  );
}
