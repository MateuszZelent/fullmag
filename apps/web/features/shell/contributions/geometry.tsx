/**
 * Geometry tab ribbon contributions.
 */

import { Shapes, Box, FileText } from "lucide-react";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";

function buildGeometryGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  return [
    {
      id: "geometry-model",
      title: "Objects",
      tone: "neutral",
      actions: [
        {
          id: "geometry-open-objects",
          icon: <Shapes size={20} />,
          label: "Objects",
          tooltip: "Open object list in Model Builder",
          action: () => ctx.run({ id: "navigation.select-node", nodeId: "objects" }),
          iconColor: "text-emerald-400",
        },
        {
          id: "geometry-open-universe",
          icon: <Box size={20} />,
          label: "Universe",
          tooltip: "Open universe and airbox settings",
          action: () => ctx.run({ id: "navigation.select-node", nodeId: "universe" }),
          iconColor: "text-cyan-400",
        },
      ],
    },
    {
      id: "geometry-import",
      title: "Import",
      actions: [
        {
          id: "geometry-import-stl",
          icon: <FileText size={20} />,
          label: "Import STL",
          tooltip: "Import geometry asset (coming next)",
          disabled: true,
          hidden: true,
          iconColor: "text-muted-foreground",
        },
      ],
    },
  ];
}

registerRibbonContribution({
  tab: "geometry",
  priority: 0,
  buildGroups: buildGeometryGroups,
});
