/**
 * Materials tab ribbon contributions.
 */

import { Magnet, FlaskConical, Sparkles, Binary } from "lucide-react";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";
import { buildViewGroup } from "./view-group";

function buildMaterialsGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  const objectId = ctx.selectedObjectId;
  const hasObject = Boolean(objectId);
  return [
    {
      id: "material-object",
      title: "Object",
      actions: [
        {
          id: "open-magnetic-params",
          icon: <Magnet size={20} />,
          label: "Magnetic Params",
          tooltip: hasObject
            ? "Open magnetic interaction stack for selected object"
            : "Select object in tree first",
          disabled: !hasObject,
          action: () => {
            if (!objectId) return;
            ctx.run({ id: "navigation.select-node", nodeId: `physobj-${objectId}` });
          },
          iconColor: "text-violet-400",
        },
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
    {
      id: "material-add",
      title: "Add Interaction",
      actions: [
        {
          id: "add-dmi",
          icon: <Sparkles size={20} />,
          label: "Add DMI",
          tooltip: hasObject
            ? "Add interfacial DMI interaction"
            : "Select object in tree first",
          disabled:
            !hasObject ||
            !ctx.can({
              id: "object.add-interaction",
              objectId: objectId ?? "",
              kind: "interfacial_dmi",
            }),
          action: () => {
            if (!objectId) return;
            ctx.run({ id: "object.add-interaction", objectId, kind: "interfacial_dmi" });
            ctx.run({ id: "navigation.select-node", nodeId: `physobj-${objectId}` });
          },
          iconColor: "text-cyan-400",
        },
        {
          id: "add-ku",
          icon: <Binary size={20} />,
          label: "Add Ku",
          tooltip: hasObject
            ? "Add uniaxial anisotropy interaction"
            : "Select object in tree first",
          disabled:
            !hasObject ||
            !ctx.can({
              id: "object.add-interaction",
              objectId: objectId ?? "",
              kind: "uniaxial_anisotropy",
            }),
          action: () => {
            if (!objectId) return;
            ctx.run({ id: "object.add-interaction", objectId, kind: "uniaxial_anisotropy" });
            ctx.run({ id: "navigation.select-node", nodeId: `physobj-${objectId}` });
          },
          iconColor: "text-rose-400",
        },
      ],
    },
    buildViewGroup(ctx),
  ];
}

registerRibbonContribution({
  tab: "materials",
  priority: 0,
  buildGroups: buildMaterialsGroups,
});
