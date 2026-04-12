/**
 * Definitions tab ribbon contributions.
 */

import { Binary, FunctionSquare, Ruler } from "lucide-react";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";

function buildDefinitionsGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  return [
    {
      id: "definitions-model",
      title: "Definitions",
      actions: [
        {
          id: "definitions-parameters",
          icon: <Binary size={20} />,
          label: "Parameters",
          tooltip: "Open model parameters and global variables (coming next)",
          disabled: true,
          hidden: true,
          iconColor: "text-slate-400",
        },
        {
          id: "definitions-functions",
          icon: <FunctionSquare size={20} />,
          label: "Functions",
          tooltip: "Open global functions and dependencies (coming next)",
          disabled: true,
          hidden: true,
          iconColor: "text-slate-400",
        },
        {
          id: "definitions-coordinates",
          icon: <Ruler size={20} />,
          label: "Coordinates",
          tooltip: "Coordinate systems and frames (coming next)",
          disabled: true,
          hidden: true,
          iconColor: "text-slate-400",
        },
      ],
    },
  ];
}

registerRibbonContribution({
  tab: "definitions",
  priority: 0,
  buildGroups: buildDefinitionsGroups,
});
