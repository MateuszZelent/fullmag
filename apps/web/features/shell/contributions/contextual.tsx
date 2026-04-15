/**
 * Contextual ribbon tab contributions.
 *
 * These groups appear when the tree selection activates a contextual
 * tab (e.g. Mesh Quality, Interface, Plot, Table, etc).
 */

import {
  RefreshCw, BarChart3, ListChecks, Layers3, Target, Ruler,
  Shapes, Eye, Camera, Download, Columns2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";

// ---------------------------------------------------------------------------
// Mesh Quality
// ---------------------------------------------------------------------------

function buildMeshQualityGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  return [
    {
      id: "ctx-mesh-quality",
      title: "Mesh Quality",
      actions: [
        {
          id: "ctx-mesh-open-quality",
          icon: <BarChart3 size={20} />,
          label: "Quality",
          tooltip: "Open mesh quality diagnostics",
          disabled: !ctx.can({ id: "mesh.open-quality" }),
          action: () => ctx.run({ id: "mesh.open-quality" }),
          iconColor: "text-emerald-400",
        },
        {
          id: "ctx-mesh-open-pipeline",
          icon: <ListChecks size={20} />,
          label: "Pipeline",
          tooltip: "Open mesh pipeline diagnostics",
          disabled: !ctx.can({ id: "mesh.open-pipeline" }),
          action: () => ctx.run({ id: "mesh.open-pipeline" }),
          iconColor: "text-amber-400",
        },
        {
          id: "ctx-mesh-build",
          icon: (
            <RefreshCw
              size={20}
              className={cn(ctx.meshGenerating && "animate-spin")}
            />
          ),
          label: ctx.meshGenerating ? "Building..." : "Rebuild",
          tooltip: "Rebuild selected mesh target",
          disabled: !ctx.can({ id: "mesh.build-selected" }),
          action: () => ctx.run({ id: "mesh.build-selected" }),
          iconColor: "text-emerald-400",
        },
      ],
    },
  ];
}

registerRibbonContribution({
  tab: "mesh-quality",
  priority: 0,
  buildGroups: buildMeshQualityGroups,
});

// ---------------------------------------------------------------------------
// Interface (placeholder)
// ---------------------------------------------------------------------------

function buildInterfaceGroups(_ctx: RibbonBuildContext): RibbonGroup[] {
  return [
    {
      id: "ctx-interface",
      title: "Interface",
      tone: "neutral",
      actions: [
        {
          id: "ctx-interface-coupling",
          icon: <Layers3 size={20} />,
          label: "Coupling",
          tooltip: "Interface coupling authoring will land in next pass",
          disabled: true,
          iconColor: "text-muted-foreground",
        },
        {
          id: "ctx-interface-bc",
          icon: <Target size={20} />,
          label: "Boundary BC",
          tooltip: "Boundary condition authoring will land in next pass",
          disabled: true,
          iconColor: "text-muted-foreground",
        },
      ],
    },
  ];
}

registerRibbonContribution({
  tab: "interface",
  priority: 0,
  buildGroups: buildInterfaceGroups,
});

// ---------------------------------------------------------------------------
// Work Plane (placeholder)
// ---------------------------------------------------------------------------

function buildWorkPlaneGroups(_ctx: RibbonBuildContext): RibbonGroup[] {
  return [
    {
      id: "ctx-work-plane",
      title: "Work Plane",
      tone: "neutral",
      actions: [
        {
          id: "ctx-work-plane-transform",
          icon: <Ruler size={20} />,
          label: "Transform",
          tooltip: "Work-plane transform tools will land in next pass",
          disabled: true,
          iconColor: "text-muted-foreground",
        },
        {
          id: "ctx-work-plane-sketch",
          icon: <Shapes size={20} />,
          label: "Sketch",
          tooltip: "Sketch tools will land in next pass",
          disabled: true,
          iconColor: "text-muted-foreground",
        },
      ],
    },
  ];
}

registerRibbonContribution({
  tab: "work-plane",
  priority: 0,
  buildGroups: buildWorkPlaneGroups,
});

// ---------------------------------------------------------------------------
// Plot
// ---------------------------------------------------------------------------

function buildPlotGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  const firstAvailable = (ctx.quickPreviewTargets ?? []).find(
    (target) => target.available,
  );
  return [
    {
      id: "ctx-plot",
      title: "Plot",
      actions: [
        {
          id: "ctx-plot-quantity",
          icon: <Eye size={20} />,
          label: firstAvailable?.shortLabel ?? "Quantity",
          tooltip: "Switch to first available quantity",
          disabled:
            !firstAvailable ||
            !ctx.can({
              id: "preview.select-quantity",
              quantityId: firstAvailable?.id ?? "m",
            }),
          action: () => {
            if (!firstAvailable) return;
            ctx.run({
              id: "preview.select-quantity",
              quantityId: firstAvailable.id,
            });
          },
          iconColor: "text-sky-400",
        },
        {
          id: "ctx-plot-capture",
          icon: <Camera size={20} />,
          label: "Capture",
          tooltip: "Capture current plot/viewport",
          disabled: !ctx.can({ id: "capture.viewport" }),
          action: () => ctx.run({ id: "capture.viewport" }),
          iconColor: "text-violet-400",
        },
        {
          id: "ctx-plot-export",
          icon: <Download size={20} />,
          label: "Export",
          tooltip: "Export current results",
          disabled: !ctx.can({ id: "export.results" }),
          action: () => ctx.run({ id: "export.results" }),
          iconColor: "text-cyan-400",
        },
      ],
    },
  ];
}

registerRibbonContribution({
  tab: "plot",
  priority: 0,
  buildGroups: buildPlotGroups,
});

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function buildTableGroups(_ctx: RibbonBuildContext): RibbonGroup[] {
  return [
    {
      id: "ctx-table",
      title: "Table",
      tone: "neutral",
      actions: [
        {
          id: "ctx-table-open",
          icon: <Columns2 size={20} />,
          label: "Table View",
          tooltip: "Table tooling will be moved here in next pass",
          disabled: true,
          iconColor: "text-muted-foreground",
        },
        {
          id: "ctx-table-export",
          icon: <Download size={20} />,
          label: "Export CSV",
          tooltip: "CSV export policy will be wired to results tables",
          disabled: true,
          iconColor: "text-muted-foreground",
        },
      ],
    },
  ];
}

registerRibbonContribution({
  tab: "table",
  priority: 0,
  buildGroups: buildTableGroups,
});
