import type { ModuleManifest } from "@/kernel/types";

export const appMenuManifest: ModuleManifest = {
  id: "app-menu",
  title: "App Menu",
  version: "0.1.0",
  slots: ["app-menu"],
  component: () => import("./AppMenuModule"),
};
