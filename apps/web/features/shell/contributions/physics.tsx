/**
 * Physics tab ribbon contributions.
 */

import {
  Magnet, Cog, Sparkles, Binary, RadioTower, Zap, FlaskConical,
} from "lucide-react";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";
import { buildViewGroup } from "./view-group";

function buildPhysicsGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  const objectId = ctx.selectedObjectId;
  const hasObject = Boolean(objectId);
  return [
    {
      id: "physics-core",
      title: "Core Terms",
      actions: [
        {
          id: "open-obj-physics",
          icon: <Magnet size={20} />,
          label: "Object Physics",
          tooltip: hasObject
            ? "Open per-object magnetic interaction stack"
            : "Select object in tree first",
          disabled: !hasObject,
          action: () => {
            if (!objectId) return;
            ctx.run({ id: "navigation.select-node", nodeId: `physobj-${objectId}` });
          },
          iconColor: "text-violet-400",
        },
        {
          id: "open-global-physics",
          icon: <Cog size={20} />,
          label: "Global Physics",
          tooltip: "Open global physics status panel",
          action: () => ctx.run({ id: "navigation.select-node", nodeId: "physics" }),
          iconColor: "text-slate-400",
        },
      ],
    },
    {
      id: "physics-add",
      title: "Optional Terms",
      actions: [
        {
          id: "physics-add-dmi",
          icon: <Sparkles size={20} />,
          label: "DMI",
          tooltip: hasObject
            ? "Add interfacial DMI to selected object"
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
          id: "physics-add-uni",
          icon: <Binary size={20} />,
          label: "Uniaxial Ku",
          tooltip: hasObject
            ? "Add uniaxial anisotropy to selected object"
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
    {
      id: "physics-drive",
      title: "Drive / STT",
      actions: [
        {
          id: "physics-oersted",
          icon: <RadioTower size={20} />,
          label: "Oersted",
          tooltip: "Configure Oersted field from current-carrying pillar",
          action: () => ctx.run({ id: "navigation.select-node", nodeId: "physics" }),
          iconColor: "text-amber-400",
        },
        {
          id: "physics-stt",
          icon: <Zap size={20} />,
          label: "Spin Torque",
          tooltip: "Configure spin-transfer torque (Slonczewski or Zhang–Li)",
          action: () => ctx.run({ id: "navigation.select-node", nodeId: "physics" }),
          iconColor: "text-emerald-400",
        },
        {
          id: "physics-thermal",
          icon: <FlaskConical size={20} />,
          label: "Thermal",
          tooltip: "Enable Brown thermal noise at given temperature",
          action: () => ctx.run({ id: "navigation.select-node", nodeId: "physics" }),
          iconColor: "text-orange-400",
        },
      ],
    },
    buildViewGroup(ctx),
  ];
}

registerRibbonContribution({
  tab: "physics",
  priority: 0,
  buildGroups: buildPhysicsGroups,
});
