import type { ModuleManifest } from "@/kernel/types";

import { commandPaletteStore } from "./commandPaletteStore";

export const overlayManifest: ModuleManifest = {
  id: "command-palette",
  title: "Command Palette",
  version: "0.1.0",
  slots: ["overlay"],
  component: () => import("./CommandPaletteModule"),
  contributes: {
    commands: [
      {
        id: "workspace.command-palette",
        title: "Command Palette",
        group: "workspace",
        category: "Window",
        scope: "global",
        shortcut: "Ctrl+Shift+P",
        run: () => {
          commandPaletteStore.toggle();
          return { status: "completed" };
        },
      },
    ],
  },
  listens: ["command:submitted"],
};
