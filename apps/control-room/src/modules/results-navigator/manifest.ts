import type { ModuleManifest } from "@/kernel/types";

export const resultsNavigatorManifest: ModuleManifest = {
  activationTab: "results",
  id: "results-navigator",
  title: "Results",
  version: "0.1.0",
  slots: ["panel-left"],
  component: () => import("./ResultsNavigatorModule"),
  emits: ["workspace:selection-changed"],
};
