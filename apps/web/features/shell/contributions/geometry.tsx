/**
 * Geometry tab ribbon contributions.
 */

import {
  AlignVerticalSpaceAround,
  Box,
  Circle,
  CircleDashed,
  Cylinder,
  Disc,
  Minus,
  Shapes,
  Square,
} from "lucide-react";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";

function buildGeometryGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  return [
    {
      id: "geometry-primitives",
      title: "Primitives",
      subtitle: "3D solids",
      tone: "authoring",
      actions: [
        {
          id: "geometry-add-box",
          icon: <Box size={20} />,
          label: "Cuboid",
          tooltip: "Create a new box-like ferromagnetic body",
          action: () => ctx.run({ id: "geometry.add-preset", preset: "box" }),
          iconColor: "text-emerald-400",
        },
        {
          id: "geometry-add-cylinder",
          icon: <Cylinder size={20} />,
          label: "Cylinder",
          tooltip: "Create a new cylindrical ferromagnetic body",
          action: () => ctx.run({ id: "geometry.add-preset", preset: "cylinder" }),
          iconColor: "text-cyan-400",
        },
        {
          id: "geometry-add-sphere",
          icon: <Circle size={20} />,
          label: "Sphere",
          tooltip: "Create a new spherical ferromagnetic body",
          action: () => ctx.run({ id: "geometry.add-preset", preset: "sphere" }),
          iconColor: "text-violet-400",
        },
        {
          id: "geometry-add-ring",
          icon: <CircleDashed size={20} />,
          label: "Donut",
          tooltip: "Create a ring / torus-like ferromagnetic body",
          action: () => ctx.run({ id: "geometry.add-preset", preset: "ring" }),
          iconColor: "text-amber-400",
        },
      ],
    },
    {
      id: "geometry-components",
      title: "Components",
      subtitle: "Common micromagnetic parts",
      tone: "neutral",
      actions: [
        {
          id: "geometry-add-disk",
          icon: <Disc size={20} />,
          label: "Disk",
          tooltip: "Create a thin circular disk",
          action: () => ctx.run({ id: "geometry.add-preset", preset: "disk" }),
          iconColor: "text-sky-400",
        },
        {
          id: "geometry-add-pillar",
          icon: <AlignVerticalSpaceAround size={20} />,
          label: "Pillar",
          tooltip: "Create a vertical pillar",
          action: () => ctx.run({ id: "geometry.add-preset", preset: "pillar" }),
          iconColor: "text-fuchsia-400",
        },
        {
          id: "geometry-add-thin-film",
          icon: <Square size={20} />,
          label: "Thin Film",
          tooltip: "Create an extended thin-film body",
          action: () => ctx.run({ id: "geometry.add-preset", preset: "thin_film" }),
          iconColor: "text-emerald-400",
        },
        {
          id: "geometry-add-nanowire",
          icon: <Minus size={20} />,
          label: "Nanowire",
          tooltip: "Create a long wire-like component",
          action: () => ctx.run({ id: "geometry.add-preset", preset: "nanowire" }),
          iconColor: "text-rose-400",
        },
      ],
    },
    {
      id: "geometry-scene",
      title: "Scene",
      subtitle: "Open existing authoring panels",
      tone: "neutral",
      actions: [
        {
          id: "geometry-open-objects",
          icon: <Shapes size={20} />,
          label: "Objects",
          tooltip: "Open the object list in the model builder",
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
  ];
}

registerRibbonContribution({
  tab: "geometry",
  priority: 0,
  buildGroups: buildGeometryGroups,
});
