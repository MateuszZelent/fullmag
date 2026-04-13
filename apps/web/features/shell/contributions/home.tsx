/**
 * Home tab ribbon contributions.
 */

import {
  FileText, Box, Columns2, BarChart3, Sparkles, PanelRight, Eye,
} from "lucide-react";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";

function buildHomeGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  return [
    {
      id: "project",
      title: "Project",
      tone: "neutral",
      actions: [
        {
          id: "open",
          icon: <FileText size={20} />,
          label: "Open",
          tooltip: "Open script file",
          shortcut: "Ctrl+O",
          disabled: true,
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
      ],
    },
    {
      id: "workspace-view",
      title: "Workspace",
      tone: "neutral",
      actions: [
        {
          id: "home-3d",
          icon: <Box size={20} />,
          label: "3D",
          tooltip: "Open 3D workspace",
          shortcut: "1",
          active: ctx.viewMode === "3D",
          action: () => ctx.run({ id: "viewport.set-mode", mode: "3D" }),
          iconColor: "text-indigo-400",
        },
        {
          id: "home-2d",
          icon: <Columns2 size={20} />,
          label: "2D",
          tooltip: "Open 2D workspace",
          shortcut: "2",
          active: ctx.viewMode === "2D",
          action: () => ctx.run({ id: "viewport.set-mode", mode: "2D" }),
          iconColor: "text-sky-400",
        },
        {
          id: "home-analyze",
          icon: <BarChart3 size={20} />,
          label: "Analyze",
          tooltip: "Open results and analysis workspace",
          active: ctx.viewMode === "Analyze",
          action: () => ctx.run({ id: "viewport.set-mode", mode: "Analyze" }),
          iconColor: "text-emerald-400",
        },
        {
          id: "home-panel",
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
          id: "home-focus",
          icon: <Eye size={20} />,
          label: "Focus",
          tooltip: ctx.selectedObjectId
            ? "Focus camera on selected object"
            : "Select an object to focus",
          disabled: !ctx.can({ id: "viewport.focus-selected-object" }),
          action: () => ctx.run({ id: "viewport.focus-selected-object" }),
          iconColor: "text-teal-400",
        },
      ],
    },
  ];
}

registerRibbonContribution({
  tab: "home",
  priority: 0,
  buildGroups: buildHomeGroups,
});
