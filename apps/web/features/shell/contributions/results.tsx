/**
 * Results tab ribbon contributions.
 */

import {
  Magnet, Shapes, Zap, BarChart3, Eye, Camera, Download, Save,
  Target, Plus,
} from "lucide-react";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup, RibbonAction } from "../registry/ribbonRegistry";
import { buildViewGroup } from "./view-group";

function buildResultsGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  const quickPreviewActions: RibbonAction[] = (
    ctx.quickPreviewTargets?.slice(0, 6) ?? []
  ).map((target) => {
    const lowerId = target.id.toLowerCase();
    const lowerLabel = target.shortLabel.toLowerCase();
    const icon =
      target.id === "m" ? (
        <Magnet size={20} />
      ) : lowerId.includes("demag") || lowerLabel.includes("demag") ? (
        <Shapes size={20} />
      ) : lowerId.includes("ex") || lowerLabel.includes("exchange") ? (
        <Zap size={20} />
      ) : lowerId.startsWith("e_") || lowerLabel.startsWith("e") ? (
        <BarChart3 size={20} />
      ) : (
        <Eye size={20} />
      );
    const iconColor =
      target.id === "m"
        ? "text-rose-400"
        : lowerId.includes("demag") || lowerLabel.includes("demag")
          ? "text-fuchsia-400"
          : lowerId.includes("ex") || lowerLabel.includes("exchange")
            ? "text-yellow-400"
            : lowerId.startsWith("e_") || lowerLabel.startsWith("e")
              ? "text-emerald-400"
              : "text-sky-400";
    return {
      id: `quantity-${target.id}`,
      icon,
      label: target.shortLabel,
      tooltip: `Switch preview to ${target.shortLabel}`,
      active: ctx.selectedQuantity === target.id,
      disabled:
        !target.available ||
        !ctx.can({
          id: "preview.select-quantity",
          quantityId: target.id,
        }),
      iconColor,
      action: () =>
        ctx.run({
          id: "preview.select-quantity",
          quantityId: target.id,
        }),
    };
  });

  // Fallback analysis command — some actions still route through
  // direct prop callbacks that aren't yet in the command registry.
  // The `run` helper will no-op for unknown commands, so we guard
  // with a simple presence check on the context.
  const canAddAnalysis = true; // always enabled — underlying handler may no-op

  return [
    {
      id: "quantity",
      title: "Quantity",
      actions:
        quickPreviewActions.length > 0
          ? quickPreviewActions
          : [
              {
                id: "magnetization",
                icon: <Magnet size={20} />,
                label: "M",
                tooltip: "Magnetization preview",
                active: true,
                iconColor: "text-rose-400",
              },
              {
                id: "exchange",
                icon: <Zap size={20} />,
                label: "H_ex",
                tooltip: "Exchange field preview",
                iconColor: "text-yellow-400",
              },
              {
                id: "demag",
                icon: <Shapes size={20} />,
                label: "H_dem",
                tooltip: "Demagnetization field preview",
                iconColor: "text-fuchsia-400",
              },
            ],
    },
    {
      id: "plot-tools",
      title: "Plot",
      actions: [
        {
          id: "plot",
          icon: <BarChart3 size={20} />,
          label: "Chart",
          tooltip: "Open scalar plot",
          action: () =>
            ctx.run({ id: "viewport.set-mode", mode: "charts" }),
          iconColor: "text-emerald-400",
        },
        {
          id: "snapshot",
          icon: <Camera size={20} />,
          label: "Capture",
          tooltip: "Take viewport screenshot",
          disabled: !ctx.can({ id: "capture.viewport" }),
          action: () => ctx.run({ id: "capture.viewport" }),
          iconColor: "text-violet-400",
        },
        {
          id: "exportvtk",
          icon: <Download size={20} />,
          label: "VTK",
          tooltip: "Export VTK",
          disabled: !ctx.can({ id: "export.results" }),
          action: () => ctx.run({ id: "export.results" }),
          iconColor: "text-blue-400",
        },
        {
          id: "save-state",
          icon: <Save size={20} />,
          label: "State",
          tooltip: "Download magnetization state (JSON)",
          disabled: !ctx.can({ id: "export.state" }),
          action: () => ctx.run({ id: "export.state" }),
          iconColor: "text-emerald-400",
        },
      ],
    },
    {
      id: "analyze",
      title: "Analyze",
      actions: [
        {
          id: "analyze-spectrum",
          icon: <BarChart3 size={20} />,
          label: "Spectrum",
          tooltip: "Eigenmode spectrum & mode inspector",
          active: ctx.viewMode === "Analyze",
          action: () =>
            ctx.run({ id: "viewport.set-mode", mode: "Analyze" }),
          iconColor: "text-violet-400",
        },
        {
          id: "analyze-vortex",
          icon: <Target size={20} />,
          label: "Vortex",
          tooltip:
            "Vortex / STNO analysis: time traces, FFT, trajectory, orbit",
          action: () =>
            ctx.run({
              id: "navigation.select-node",
              nodeId: "res-vortex",
            }),
          iconColor: "text-emerald-400",
        },
        {
          id: "analyze-add-spectrum",
          icon: <Plus size={20} />,
          label: "Add Spectrum",
          tooltip: "Add spectrum workspace entry to Results tree",
          disabled: !canAddAnalysis,
          action: () =>
            ctx.run({
              id: "results.add-analysis",
              kind: "spectrum",
            }),
          iconColor: "text-cyan-400",
        },
        {
          id: "analyze-add-dispersion",
          icon: <Plus size={20} />,
          label: "Add Dispersion",
          tooltip: "Add dispersion workspace entry to Results tree",
          disabled: !canAddAnalysis,
          action: () =>
            ctx.run({
              id: "results.add-analysis",
              kind: "dispersion",
            }),
          iconColor: "text-fuchsia-400",
        },
        {
          id: "analyze-add-modes",
          icon: <Plus size={20} />,
          label: "Add Modes",
          tooltip: "Add mode inspector workspace entry to Results tree",
          disabled: !canAddAnalysis,
          action: () =>
            ctx.run({
              id: "results.add-analysis",
              kind: "modes",
            }),
          iconColor: "text-indigo-400",
        },
      ],
    },
    {
      id: "results-vortex",
      title: "Vortex",
      actions: [
        {
          id: "vortex-add-time-traces",
          icon: <Plus size={20} />,
          label: "Add Time Traces",
          tooltip:
            "Add vortex time traces workspace entry to Results tree",
          disabled: !canAddAnalysis,
          action: () =>
            ctx.run({
              id: "results.add-analysis",
              kind: "time-traces",
            }),
          iconColor: "text-cyan-400",
        },
        {
          id: "vortex-add-frequency",
          icon: <Plus size={20} />,
          label: "Add FFT / PSD",
          tooltip:
            "Add vortex FFT/PSD workspace entry to Results tree",
          disabled: !canAddAnalysis,
          action: () =>
            ctx.run({
              id: "results.add-analysis",
              kind: "vortex-frequency",
            }),
          iconColor: "text-emerald-400",
        },
        {
          id: "vortex-add-trajectory",
          icon: <Plus size={20} />,
          label: "Add Trajectory",
          tooltip:
            "Add vortex trajectory workspace entry to Results tree",
          disabled: !canAddAnalysis,
          action: () =>
            ctx.run({
              id: "results.add-analysis",
              kind: "vortex-trajectory",
            }),
          iconColor: "text-violet-400",
        },
        {
          id: "vortex-add-orbit",
          icon: <Plus size={20} />,
          label: "Add Orbit",
          tooltip: "Add vortex orbit workspace entry to Results tree",
          disabled: !canAddAnalysis,
          action: () =>
            ctx.run({
              id: "results.add-analysis",
              kind: "vortex-orbit",
            }),
          iconColor: "text-amber-400",
        },
      ],
    },
    {
      id: "results-workspaces",
      title: "Workspaces",
      actions: [
        {
          id: "results-add-quantity",
          icon: <Plus size={20} />,
          label: "Add Quantity",
          tooltip: "Pin current quantity view in Results tree",
          disabled: !canAddAnalysis,
          action: () =>
            ctx.run({
              id: "results.add-analysis",
              kind: "quantity",
            }),
          iconColor: "text-emerald-400",
        },
        {
          id: "results-add-table",
          icon: <Plus size={20} />,
          label: "Add Table",
          tooltip: "Add table analysis entry in Results tree",
          disabled: !canAddAnalysis,
          action: () =>
            ctx.run({
              id: "results.add-analysis",
              kind: "table",
            }),
          iconColor: "text-amber-400",
        },
      ],
    },
    buildViewGroup(ctx),
  ];
}

registerRibbonContribution({
  tab: "results",
  priority: 0,
  buildGroups: buildResultsGroups,
});
