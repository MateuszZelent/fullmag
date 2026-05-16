/**
 * Shared "View" ribbon group — appended to most tabs.
 */

import {
  Box, Columns2, PanelRight, Eye, Sparkles,
} from "lucide-react";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";

export function buildViewGroup(ctx: RibbonBuildContext): RibbonGroup {
  return {
    id: "view",
    title: "View",
    tone: "neutral",
    actions: [
      {
        id: "3d",
        icon: <Box size={20} />,
        label: "3D",
        tooltip: "3D view",
        shortcut: "1",
        active: ctx.viewMode === "3D",
        action: () => ctx.run({ id: "viewport.set-mode", mode: "3D" }),
        iconColor: "text-indigo-400",
      },
      {
        id: "2d",
        icon: <Columns2 size={20} />,
        label: "2D",
        tooltip: "2D view",
        shortcut: "2",
        active: ctx.viewMode === "2D",
        action: () => ctx.run({ id: "viewport.set-mode", mode: "2D" }),
        iconColor: "text-sky-400",
      },
      {
        id: "visualization-preset",
        icon: <Sparkles size={20} />,
        label: "3D Visual",
        tooltip: "Create new visualization preset",
        disabled: !ctx.can({ id: "visualization.create-preset" }),
        action: () => ctx.run({ id: "visualization.create-preset" }),
        iconColor: "text-amber-300",
      },
      {
        id: "sidebar",
        icon: <PanelRight size={20} />,
        label: "Panel",
        tooltip: "Toggle sidebar",
        shortcut: "Ctrl+B",
        active: ctx.sidebarVisible,
        disabled: !ctx.can({ id: "viewport.toggle-sidebar" }),
        action: () => ctx.run({ id: "viewport.toggle-sidebar" }),
        iconColor: "text-muted-foreground",
      },
      {
        id: "eye",
        icon: <Eye size={20} />,
        label: "Focus",
        tooltip: ctx.selectedObjectId
          ? "Focus camera on selected object"
          : "Select an object to focus",
        disabled: !ctx.can({ id: "viewport.focus-selected-object" }),
        iconColor: "text-teal-400",
        action: () => ctx.run({ id: "viewport.focus-selected-object" }),
      },
    ],
  };
}
