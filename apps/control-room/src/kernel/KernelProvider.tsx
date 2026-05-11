"use client";

import { useMemo, type ReactNode } from "react";

import { ControlRoomApi } from "./api/ControlRoomApi";
import { CommandRegistry } from "./commands/CommandRegistry";
import { EventBus } from "./events/EventBus";
import type { KernelEventMap } from "./events/eventTypes";
import { KernelContext } from "./KernelContext";
import { LayoutController } from "./layout/LayoutController";
import { ModuleRegistry } from "./module/ModuleRegistry";
import { RealtimeInvalidationBridge } from "./realtime/RealtimeInvalidationBridge";
import { ResourceInvalidationController } from "./resources/ResourceInvalidationController";
import { SelectionController } from "./selection/SelectionController";
import type { KernelApi } from "./types";
import { ALL_MODULES } from "@/modules";

interface KernelProviderProps {
  children: ReactNode;
}

function createKernel(): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const api = new ControlRoomApi();
  const commands = new CommandRegistry();
  commands.attach(bus);

  const modules = new ModuleRegistry();
  const resources = new ResourceInvalidationController(bus);
  const realtime = new RealtimeInvalidationBridge(resources);
  const selection = new SelectionController(bus);
  const layout = new LayoutController(bus);

  // Register modules and auto-register their contributed commands.
  for (const manifest of ALL_MODULES) {
    modules.register(manifest);
    if (manifest.contributes?.commands) {
      for (const cmd of manifest.contributes.commands) {
        commands.register(cmd);
      }
    }
  }

  return { api, bus, commands, modules, realtime, resources, selection, layout };
}

export function KernelProvider({ children }: KernelProviderProps) {
  const kernel = useMemo(() => createKernel(), []);

  return (
    <KernelContext.Provider value={kernel}>{children}</KernelContext.Provider>
  );
}
