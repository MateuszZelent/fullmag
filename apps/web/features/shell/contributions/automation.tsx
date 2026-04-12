/**
 * Automation tab ribbon contributions.
 */

import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";

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
      ],
    },
  ];
}

registerRibbonContribution({
  tab: "automation",
  priority: 0,
  buildGroups: buildAutomationGroups,
});
