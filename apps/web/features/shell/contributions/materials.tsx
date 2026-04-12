/**
 * Materials tab ribbon contributions.
 */

import { FlaskConical } from "lucide-react";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";

function buildMaterialsGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  const objectId = ctx.selectedObjectId;
  const hasObject = Boolean(objectId);
  return [
    {
      id: "material-object",
      title: "Materials",
      actions: [
        {
          id: "open-material-panel",
          icon: <FlaskConical size={20} />,
          label: "Material",
          tooltip: hasObject
            ? "Open material constants for selected object"
            : "Select object in tree first",
          disabled: !hasObject,
          action: () => {
            if (!objectId) return;
            ctx.run({ id: "navigation.select-node", nodeId: `mat-${objectId}` });
          },
          iconColor: "text-amber-400",
        },
      ],
    },
  ];
}

registerRibbonContribution({
  tab: "materials",
  priority: 0,
  buildGroups: buildMaterialsGroups,
});
