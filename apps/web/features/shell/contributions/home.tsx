/**
 * Home tab ribbon contributions.
 */

import {
  FileText, Play, Pause, Square, Target, Shapes, FlaskConical,
  Hexagon, Cog, RadioTower, Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup, RibbonMenuItem } from "../registry/ribbonRegistry";
import { buildViewGroup } from "./view-group";

function buildHomeGroups(ctx: RibbonBuildContext): RibbonGroup[] {
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
      id: "script",
      title: "Script",
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
          id: ctx.runAction ?? "run",
          icon: <Play size={20} fill="currentColor" />,
          label: ctx.runLabel ?? "Run",
          tooltip:
            ctx.runLabel === "Resume"
              ? "Resume the paused solver stage"
              : "Run simulation",
          shortcut: "F5",
          accent: true,
          disabled: !ctx.can({ id: "solver.control", action: "run" }),
          action: () => ctx.run({ id: "solver.control", action: "run" }),
        },
      ],
    },
    {
      id: "additions",
      title: "Additions",
      actions: [
        {
          id: "geometry",
          icon: <Shapes size={20} />,
          label: "Objects",
          tooltip: "Add new geometric objects",
          iconColor: "text-emerald-400",
          menuItems: [
            {
              id: "add-box",
              label: "Add Box",
              icon: <Shapes size={14} />,
              description: "Rectangular cuboid (coming next)",
              disabled: true,
              hidden: true,
            },
            {
              id: "add-cylinder",
              label: "Add Cylinder",
              icon: <Shapes size={14} />,
              description: "Standard cylinder (coming next)",
              disabled: true,
              hidden: true,
            },
            { separator: true, id: "sep-geo", label: "" },
            {
              id: "import-stl",
              label: "Import STL...",
              icon: <FileText size={14} />,
              description: "Load external mesh (coming next)",
              disabled: true,
              hidden: true,
            },
          ],
        },
        {
          id: "material",
          icon: <FlaskConical size={20} />,
          label: "Material",
          tooltip: "Material properties",
          disabled: true,
          iconColor: "text-amber-400",
        },
        {
          id: "antenna",
          icon: <RadioTower size={20} />,
          label: "Antennas",
          tooltip: "Add and select microwave RF sources",
          active:
            ctx.selectedNodeId === "antennas" ||
            Boolean(ctx.selectedAntennaName),
          iconColor: "text-cyan-400",
          menuItems: antennaMenuItems,
        },
        {
          id: "mesh",
          icon: <Hexagon size={20} />,
          label: "Mesh",
          tooltip: "Mesh / geometry view",
          active: ctx.viewMode === "Mesh",
          action: () => ctx.run({ id: "viewport.set-mode", mode: "Mesh" }),
          iconColor: "text-fuchsia-400",
        },
      ],
    },
    {
      id: "solver",
      title: "Solver",
      actions: [
        {
          id: "relax",
          icon: <Target size={20} />,
          label: "Relax",
          tooltip: "Run relaxation to equilibrium",
          disabled: !ctx.can({ id: "solver.control", action: "relax" }),
          action: () => ctx.run({ id: "solver.control", action: "relax" }),
          iconColor: "text-indigo-400",
        },
        {
          id: ctx.runAction ?? "run",
          icon: <Play size={20} fill="currentColor" />,
          label: ctx.runLabel ?? "Run",
          tooltip:
            ctx.runLabel === "Resume"
              ? "Resume the paused solver stage"
              : "Run until the configured stop time",
          accent: true,
          disabled: !ctx.can({ id: "solver.control", action: "run" }),
          action: () => ctx.run({ id: "solver.control", action: "run" }),
        },
        {
          id: "pause",
          icon: <Pause size={20} fill="currentColor" />,
          label: "Pause",
          tooltip: "Pause solver",
          disabled: !ctx.can({ id: "solver.control", action: "pause" }),
          action: () => ctx.run({ id: "solver.control", action: "pause" }),
          iconColor: "text-amber-500",
        },
        {
          id: "stop",
          icon: <Square size={20} fill="currentColor" />,
          label: "Stop",
          tooltip: "Stop solver",
          disabled: !ctx.can({ id: "solver.control", action: "stop" }),
          action: () => ctx.run({ id: "solver.control", action: "stop" }),
          iconColor: "text-rose-500",
        },
      ],
    },
    buildViewGroup(ctx),
  ];
}

registerRibbonContribution({
  tab: "home",
  priority: 0,
  buildGroups: buildHomeGroups,
});
