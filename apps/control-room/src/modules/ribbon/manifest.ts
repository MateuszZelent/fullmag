import type { ModuleManifest } from "@/kernel/types";

export const ribbonManifest: ModuleManifest = {
  id: "ribbon",
  title: "Ribbon",
  version: "0.1.0",
  slots: ["ribbon"],
  component: () => import("./RibbonModule"),
};
