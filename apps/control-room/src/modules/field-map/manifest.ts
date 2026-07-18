import type { ModuleManifest } from "@/kernel/types";

import { fieldMapCommands } from "./fieldMapCommands";

export const fieldMapManifest: ModuleManifest = {
  id: "field-map",
  title: "2D View",
  version: "1.0.0",
  slots: ["viewport-main"],
  component: () => import("./FieldMapModule"),
  contributes: { commands: fieldMapCommands },
};
