"use client";

import type { ReactNode } from "react";
import {
  CommandCtx,
  ModelCtx,
  TransportCtx,
  ViewportCtx,
  type CommandContextValue,
  type ModelContextValue,
  type TransportContextValue,
  type ViewportContextValue,
} from "./context-hooks";

interface ControlRoomContextProvidersProps {
  children: ReactNode;
  transportValue: TransportContextValue;
  viewportValue: ViewportContextValue;
  commandValue: CommandContextValue;
  modelValue: ModelContextValue;
}

export function ControlRoomContextProviders({
  children,
  transportValue,
  viewportValue,
  commandValue,
  modelValue,
}: ControlRoomContextProvidersProps) {
  return (
    <TransportCtx.Provider value={transportValue}>
      <ViewportCtx.Provider value={viewportValue}>
        <CommandCtx.Provider value={commandValue}>
          <ModelCtx.Provider value={modelValue}>{children}</ModelCtx.Provider>
        </CommandCtx.Provider>
      </ViewportCtx.Provider>
    </TransportCtx.Provider>
  );
}
