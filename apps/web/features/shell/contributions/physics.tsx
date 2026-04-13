/**
 * Physics tab ribbon contributions.
 */

import {
  Magnet, Cog, Sparkles, Binary, RadioTower, Zap, FlaskConical, Plus,
} from "lucide-react";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup, RibbonMenuItem } from "../registry/ribbonRegistry";

function buildPhysicsGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  const objectId = ctx.selectedObjectId;
  const hasObject = Boolean(objectId);
  const antennaMenuItems: RibbonMenuItem[] = [
    {
      id: "manage-antennas",
      label: "Manage RF Sources",
      icon: <Cog size={14} />,
      description: "Open antenna placement and drive settings",
      action: () => ctx.run({ id: "navigation.select-node", nodeId: "antennas" }),
    },
    {
      id: "add-microstrip",
      label: "Add Microstrip",
      icon: <Plus size={14} />,
      description: "Single strip conductor over the magnetic guide",
      disabled: !ctx.can({ id: "antenna.add", kind: "MicrostripAntenna" }),
      action: () => ctx.run({ id: "antenna.add", kind: "MicrostripAntenna" }),
    },
    {
      id: "add-cpw",
      label: "Add CPW",
      icon: <Plus size={14} />,
      description: "Signal strip with symmetric return grounds",
      disabled: !ctx.can({ id: "antenna.add", kind: "CPWAntenna" }),
      action: () => ctx.run({ id: "antenna.add", kind: "CPWAntenna" }),
    },
  ];

  if ((ctx.antennaSources?.length ?? 0) > 0) {
    antennaMenuItems.push({ id: "sep-existing", label: "", separator: true });
    for (const antenna of ctx.antennaSources ?? []) {
      antennaMenuItems.push({
        id: `ant-${antenna.name}`,
        label: antenna.name,
        icon: <RadioTower size={14} />,
        description: `${antenna.kind} · ${(antenna.currentA * 1e3).toFixed(2)} mA`,
        active: ctx.selectedAntennaName === antenna.name,
        action: () =>
          ctx.run({ id: "navigation.select-node", nodeId: `ant-${antenna.name}` }),
      });
    }
  }
  return [
    {
      id: "physics-core",
      title: "Core Terms",
      tone: "neutral",
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
          iconColor: "text-muted-foreground",
        },
      ],
    },
    {
      id: "physics-add",
      title: "Optional Terms",
      tone: "compose",
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
    {
      id: "physics-rf",
      title: "RF / Antennas",
      actions: [
        {
          id: "physics-antennas",
          icon: <RadioTower size={20} />,
          label: "RF Sources",
          tooltip: "Manage microwave excitation sources and antenna geometry",
          active:
            ctx.selectedNodeId === "antennas" ||
            Boolean(ctx.selectedAntennaName),
          iconColor: "text-cyan-400",
          menuItems: antennaMenuItems,
        },
      ],
    },
  ];
}

registerRibbonContribution({
  tab: "physics",
  priority: 0,
  buildGroups: buildPhysicsGroups,
});
