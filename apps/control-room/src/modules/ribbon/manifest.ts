import type { ModuleManifest } from "@/kernel/types";

import { RIBBON_COMMANDS } from "./ribbonCommands";

export const ribbonManifest: ModuleManifest = {
  id: "ribbon",
  title: "Ribbon",
  version: "0.1.0",
  slots: ["ribbon"],
  component: () => import("./RibbonModule"),
  contributes: {
    commands: RIBBON_COMMANDS,
  },
};
