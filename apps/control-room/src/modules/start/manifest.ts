import type { ModuleManifest } from "@/kernel/types";

import { START_COMMANDS } from "./model/startCommands";

export const startScreenManifest: ModuleManifest = {
  id: "start-screen",
  title: "Start Screen",
  version: "0.1.0",
  slots: ["start-screen"],
  component: () => import("./StartScreen").then((module) => ({ default: module.StartScreen })),
  contributes: {
    commands: [...START_COMMANDS],
  },
  emits: ["workspace:new-problem-requested"],
};
