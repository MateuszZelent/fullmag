/**
 * Home tab ribbon contributions.
 */

import {
  FileText, Box, Columns2, BarChart3, Sparkles, PanelRight, Eye,
  Play, Pause, Square, SkipForward,
} from "lucide-react";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";

function buildHomeGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  const canRun = ctx.can({ id: "solver.control", action: "run" });
  const canPause = ctx.can({ id: "solver.control", action: "pause" });
  const canStop = ctx.can({ id: "solver.control", action: "stop" });
  const canSkip = ctx.can({ id: "solver.control", action: "skip" });

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
    {
      id: "home-compute",
      title: "Compute",
      tone: "compute",
      actions: [
        {
          id: "home-compute-run",
          icon: <Play size={20} fill="currentColor" />,
          label: ctx.runLabel === "Resume" ? "Resume" : "Compute",
          tooltip: canRun
            ? ctx.runLabel === "Resume"
              ? "Resume the staged compute pipeline"
              : "Execute the current study pipeline"
            : ctx.runDisabledReason ?? "Compute is unavailable",
          shortcut: "F5",
          accent: true,
          disabled: !canRun,
          action: () => ctx.run({ id: "solver.control", action: "run" }),
          iconColor: "text-cyan-400",
        },
        {
          id: "home-compute-pause",
          icon: <Pause size={20} fill="currentColor" />,
          label: "Pause",
          tooltip: canPause ? "Pause execution" : ctx.pauseDisabledReason ?? "Pause is unavailable",
          disabled: !canPause,
          action: () => ctx.run({ id: "solver.control", action: "pause" }),
          iconColor: "text-amber-500",
        },
        {
          id: "home-compute-stop",
          icon: <Square size={20} fill="currentColor" />,
          label: "Stop",
          tooltip: canStop ? "Stop execution" : ctx.stopDisabledReason ?? "Stop is unavailable",
          disabled: !canStop,
          action: () => ctx.run({ id: "solver.control", action: "stop" }),
          iconColor: "text-rose-500",
        },
        {
          id: "home-compute-skip",
          icon: <SkipForward size={20} />,
          label: "Skip",
          tooltip: canSkip ? "Skip the active stage" : ctx.skipDisabledReason ?? "Skip is unavailable",
          disabled: !canSkip,
          action: () => ctx.run({ id: "solver.control", action: "skip" }),
          iconColor: "text-violet-400",
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
