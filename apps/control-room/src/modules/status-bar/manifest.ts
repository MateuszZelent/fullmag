import type { ModuleManifest } from "@/kernel/types";

export const statusBarManifest: ModuleManifest = {
  id: "status-bar",
  title: "Status Bar",
  version: "0.1.0",
  slots: ["status-bar"],
  component: () => import("./StatusBarModule"),
};
