import type { ModuleManifest } from "@/kernel/types";

import { fieldMapCommands } from "./fieldMapCommands";
import { fieldMapToolCommands } from "./fieldMapToolCommands";
import { fieldMapViewCommands } from "./fieldMapViewCommands";

export const fieldMapManifest: ModuleManifest = {
  id: "field-map",
  title: "2D View",
  version: "1.0.0",
  slots: ["viewport-main"],
  component: () => import("./FieldMapModule"),
  contributes: { commands: [...fieldMapCommands, ...fieldMapViewCommands, ...fieldMapToolCommands] },
};
