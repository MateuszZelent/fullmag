import type { ModuleManifest } from "@/kernel/types";

export const viewport2dManifest: ModuleManifest = {
  id: "viewport-2d",
  title: "2D Cross-Section",
  version: "0.1.0",
  slots: ["viewport-aux"],
  component: () => import("./Viewport2DModule"),
  contributes: {
    commands: [
      {
        id: "viewport-2d.fit",
        title: "Fit 2D Cross-Section",
        group: "viewport-2d",
        category: "Viewport",
        scope: "viewport",
        isEnabled: (context) => Boolean(context.bus && context.layout),
        disabledReason: () => "2D viewport services are unavailable.",
        run: (context) => {
          context.layout?.setFocusedSlot("viewport-aux");
          context.bus?.emit("viewport-2d:fit-requested", {
            source: "command",
          });
          return { status: "completed" };
        },
      },
      {
        id: "viewport-2d.toggle",
        title: "Toggle 2D Cross-Section",
        group: "viewport-2d",
        category: "Viewport",
        scope: "workspace",
        isEnabled: (context) => Boolean(context.layout),
        disabledReason: () => "Workspace layout service is unavailable.",
        isActive: (context) => context.layout?.get().focusedSlot === "viewport-aux",
        run: (context) => {
          const currentSlot = context.layout?.get().focusedSlot;
          context.layout?.setFocusedSlot(
            currentSlot === "viewport-aux" ? "viewport-main" : "viewport-aux",
          );
          return { status: "completed" };
        },
      },
    ],
  },
  emits: ["viewport-2d:fit-requested"],
  listens: ["viewport-2d:fit-requested"],
};
