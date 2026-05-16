import type { ModuleManifest } from "@/kernel/types";

export const inspectorManifest: ModuleManifest = {
  id: "inspector",
  title: "Inspector",
  version: "0.1.0",
  slots: ["panel-right"],
  component: () => import("./InspectorModule"),
  contributes: {
    commands: [
      {
        id: "workspace.toggle-right-panel",
        title: "Toggle Inspector Panel",
        group: "workspace",
        category: "Window",
        scope: "workspace",
        run: (ctx) => {
          ctx.layout?.togglePanel("right");
          return { status: "completed" };
        },
      },
    ],
  },
  listens: ["workspace:selection-changed"],
};
