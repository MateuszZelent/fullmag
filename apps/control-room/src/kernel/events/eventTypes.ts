import type { ModuleId, SlotId } from "../types";

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
  "command:submitted": {
    commandId: string;
  };
  "command:completed": {
    commandId: string;
    status: "completed" | "failed" | "cancelled";
  };
}
