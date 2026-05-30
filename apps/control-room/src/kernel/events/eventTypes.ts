import type { ModuleId, SlotId } from "../types";
import type { LayoutState } from "../layout/layoutTypes";

export interface KernelEventMap {
  "session:status-changed": {
    status: "idle" | "connecting" | "connected" | "disconnected" | "error";
  };
  "workspace:module-activated": {
    moduleId: ModuleId;
    slotId: SlotId;
  };
  "workspace:selection-changed": {
    selectionId: string | null;
    source: ModuleId;
  };
  "workspace:layout-changed": {
    state: LayoutState;
  };
  "workspace:focus-changed": {
    state: LayoutState;
  };
  "footer:tab-requested": {
    reason?: string;
    tab: "engine" | "logs" | "telemetry";
  };
  "viewport-2d:fit-requested": {
    source: "command" | "viewport";
  };
  "command:submitted": {
    commandId: string;
  };
  "command:completed": {
    commandId: string;
    status: "completed" | "failed" | "cancelled";
  };
  "resource:invalidated": {
    resourceKey: string;
    revision: string | number;
  };
}
