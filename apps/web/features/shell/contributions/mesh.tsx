/**
 * Mesh tab ribbon contributions.
 */

import {
  RefreshCw, Zap, BarChart3, Ruler, Columns2, Hexagon, ListChecks,
  Eye, Grid3X3,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";

function buildMeshGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  return [
    {
      id: "mesh-build",
      title: "Build",
      actions: [
        {
          id: "build-selected",
          icon: (
            <RefreshCw
              size={20}
              className={cn(ctx.meshGenerating && "animate-spin")}
            />
          ),
          label: ctx.meshGenerating ? "Building..." : "Build Selected",
          tooltip: ctx.meshTargetLabel
            ? `Build ${ctx.meshTargetLabel}`
            : "Build the selected mesh target",
          disabled: !ctx.can({ id: "mesh.build-selected" }),
          action: () => ctx.run({ id: "mesh.build-selected" }),
          iconColor: "text-emerald-400",
        },
        {
          id: "build-all",
          icon: <Zap size={20} />,
          label: "Build All",
          tooltip: "Rebuild the full shared-domain study mesh",
          disabled: !ctx.can({ id: "mesh.build-all" }),
          action: () => ctx.run({ id: "mesh.build-all" }),
          iconColor: "text-cyan-400",
        },
        {
          id: "statistics",
          icon: <BarChart3 size={20} />,
          label: "Statistics",
          tooltip: "Open mesh quality and statistics",
          disabled: !ctx.can({ id: "mesh.open-quality" }),
          action: () => ctx.run({ id: "mesh.open-quality" }),
          iconColor: "text-emerald-400",
        },
      ],
    },
    {
      id: "mesh-size",
      title: "Size",
      actions: [
        {
          id: "size-controls",
          icon: <Ruler size={20} />,
          label: "Element Size",
          tooltip: "Open maximum, minimum and growth controls",
          disabled: !ctx.can({ id: "mesh.open-size-settings" }),
          action: () => ctx.run({ id: "mesh.open-size-settings" }),
          iconColor: "text-amber-400",
        },
        {
          id: "narrow-region",
          icon: <Columns2 size={20} />,
          label: "Transitions",
          tooltip: "Open growth-rate and narrow-region controls",
          disabled: !ctx.can({ id: "mesh.open-size-settings" }),
          action: () => ctx.run({ id: "mesh.open-size-settings" }),
          iconColor: "text-fuchsia-400",
        },
      ],
    },
    {
      id: "mesh-method",
      title: "Method",
      actions: [
        {
          id: "method-volume",
          icon: <Hexagon size={20} />,
          label: "Mesher",
          tooltip: "Open tetrahedral mesher algorithm controls",
          disabled: !ctx.can({ id: "mesh.open-method-settings" }),
          action: () => ctx.run({ id: "mesh.open-method-settings" }),
          iconColor: "text-indigo-400",
        },
        {
          id: "method-optimize",
          icon: <ListChecks size={20} />,
          label: "Quality",
          tooltip: "Open mesh quality optimization controls",
          disabled: !ctx.can({ id: "mesh.open-quality" }),
          action: () => ctx.run({ id: "mesh.open-quality" }),
          iconColor: "text-emerald-400",
        },
      ],
    },
    {
      id: "mesh-view",
      title: "View",
      actions: [
        {
          id: "mesh-inspector",
          icon: <Eye size={20} />,
          label: "Inspector",
          tooltip: "Open the mesh inspector viewport",
          disabled: !ctx.can({ id: "mesh.open-inspector" }),
          action: () => ctx.run({ id: "mesh.open-inspector" }),
          iconColor: "text-cyan-400",
        },
        {
          id: "mesh-focus",
          icon: <Grid3X3 size={20} />,
          label: "Workspace",
          tooltip: "Open the mesh workspace",
          disabled: !ctx.can({ id: "viewport.set-mode", mode: "Mesh" }),
          action: () => ctx.run({ id: "viewport.set-mode", mode: "Mesh" }),
          iconColor: "text-fuchsia-400",
        },
        {
          id: "mesh-pipeline",
          icon: <ListChecks size={20} />,
          label: "Pipeline",
          tooltip: "Open mesh pipeline diagnostics",
          disabled: !ctx.can({ id: "mesh.open-pipeline" }),
          action: () => ctx.run({ id: "mesh.open-pipeline" }),
          iconColor: "text-orange-400",
        },
      ],
    },
  ];
}

registerRibbonContribution({
  tab: "mesh",
  priority: 0,
  buildGroups: buildMeshGroups,
});
