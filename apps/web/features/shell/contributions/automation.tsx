/**
 * Automation tab ribbon contributions.
 */

import { RefreshCw, Save, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";
import { buildViewGroup } from "./view-group";

function buildAutomationGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  return [
    {
      id: "automation-sync",
      title: "Automation",
      actions: [
        {
          id: "automation-sync-script",
          icon: (
            <RefreshCw
              size={20}
              className={cn(ctx.scriptSyncBusy && "animate-spin")}
            />
          ),
          label: ctx.scriptSyncBusy ? "Syncing..." : "Sync Script",
          tooltip: "Rewrite Python script from current builder model",
          accent: true,
          disabled: !ctx.can({ id: "script.sync" }),
          action: () => ctx.run({ id: "script.sync" }),
        },
        {
          id: "automation-export-state",
          icon: <Save size={20} />,
          label: "Export State",
          tooltip: "Save current magnetization state (JSON)",
          disabled: !ctx.can({ id: "export.state" }),
          action: () => ctx.run({ id: "export.state" }),
          iconColor: "text-emerald-400",
        },
        {
          id: "automation-export-vtk",
          icon: <Download size={20} />,
          label: "Export VTK",
          tooltip: "Export solver data for post-processing",
          disabled: !ctx.can({ id: "export.results" }),
          action: () => ctx.run({ id: "export.results" }),
          iconColor: "text-cyan-400",
        },
      ],
    },
    buildViewGroup(ctx),
  ];
}

registerRibbonContribution({
  tab: "automation",
  priority: 0,
  buildGroups: buildAutomationGroups,
});
