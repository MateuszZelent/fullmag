import {
  Box,
  Check,
  Frame,
  Info,
  Ruler,
} from "lucide-react";
import {
  registerRibbonContribution,
  type RibbonBuildContext,
  type RibbonGroup,
} from "../registry/ribbonRegistry";
import { buildViewGroup } from "./view-group";

function buildViewportDisplayGroup(ctx: RibbonBuildContext): RibbonGroup {
  return {
    id: "viewport-display",
    title: "Display",
    subtitle: "Viewport overlays",
    tone: "neutral",
    actions: [
      {
        id: "airbox-toggle",
        icon: <Box size={20} />,
        label: "Airbox",
        tooltip: ctx.airboxVisible ? "Hide airbox mesh" : "Show airbox mesh",
        active: ctx.airboxVisible,
        disabled: !ctx.can({ id: "viewport.toggle-airbox" }),
        action: () => ctx.run({ id: "viewport.toggle-airbox" }),
        iconColor: "text-sky-300",
      },
      {
        id: "axes-scope",
        icon: <Ruler size={20} />,
        label: "Axes",
        tooltip: "Choose whether scale axes describe the Universe or selected object",
        active: true,
        disabled: !ctx.can({ id: "viewport.set-axes-scope", scope: "universe" }),
        iconColor: "text-emerald-300",
        menuItems: [
          {
            id: "axes-universe",
            label: "Universe scale",
            description: "XYZ dimensions follow the full simulation Universe.",
            icon: ctx.viewportAxesScope === "universe" ? <Check size={14} /> : <Ruler size={14} />,
            active: ctx.viewportAxesScope === "universe",
            action: () => ctx.run({ id: "viewport.set-axes-scope", scope: "universe" }),
          },
          {
            id: "axes-object",
            label: "Object scale",
            description: "XYZ dimensions follow the selected object when available.",
            icon: ctx.viewportAxesScope === "object" ? <Check size={14} /> : <Ruler size={14} />,
            active: ctx.viewportAxesScope === "object",
            action: () => ctx.run({ id: "viewport.set-axes-scope", scope: "object" }),
          },
        ],
      },
      {
        id: "universe-wireframe",
        icon: <Frame size={20} />,
        label: "Universe",
        tooltip: ctx.universeWireframeVisible
          ? "Hide Universe wireframe"
          : "Show Universe wireframe",
        active: ctx.universeWireframeVisible,
        disabled: !ctx.can({ id: "viewport.toggle-universe-wireframe" }),
        action: () => ctx.run({ id: "viewport.toggle-universe-wireframe" }),
        iconColor: "text-cyan-300",
      },
      {
        id: "viewport-legend",
        icon: <Info size={20} />,
        label: "Legend",
        tooltip: ctx.viewportLegendVisible ? "Hide viewport legend" : "Show viewport legend",
        active: ctx.viewportLegendVisible,
        disabled: !ctx.can({ id: "viewport.toggle-legend" }),
        action: () => ctx.run({ id: "viewport.toggle-legend" }),
        iconColor: "text-violet-300",
      },
    ],
  };
}

registerRibbonContribution({
  tab: "view",
  priority: 0,
  buildGroups: (ctx) => [buildViewportDisplayGroup(ctx), buildViewGroup(ctx)],
});
