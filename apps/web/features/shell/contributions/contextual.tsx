/**
 * Contextual ribbon tab contributions.
 *
 * These groups appear when the tree selection activates a contextual
 * tab (e.g. Selected Ferromagnet, Mesh Quality, Plot, Table, etc).
 */

import {
  FlaskConical, Magnet, Sparkles, Binary, Move, RefreshCw,
  Maximize2, BarChart3, ListChecks, Layers3, Target, Ruler,
  Shapes, Eye, Camera, Download, Columns2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";

// ---------------------------------------------------------------------------
// Selected Ferromagnet
// ---------------------------------------------------------------------------

function buildSelectedFerromagnetGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  const objectId = ctx.selectedObjectId ?? "";
  if (!objectId) return [];

  return [
    {
      id: "ctx-ferromagnet",
      title: "Selected Ferromagnet",
      actions: [
        {
          id: "ctx-open-material",
          icon: <FlaskConical size={20} />,
          label: "Material",
          tooltip: "Open material constants for selected ferromagnet",
          action: () =>
            ctx.run({
              id: "navigation.select-node",
              nodeId: `mat-${objectId}`,
            }),
          iconColor: "text-amber-400",
        },
        {
          id: "ctx-open-physics",
          icon: <Magnet size={20} />,
          label: "Interactions",
          tooltip: "Open magnetic interactions stack",
          action: () =>
            ctx.run({
              id: "navigation.select-node",
              nodeId: `physobj-${objectId}`,
            }),
          iconColor: "text-violet-400",
        },
        {
          id: "ctx-add-dmi",
          icon: <Sparkles size={20} />,
          label: "Add DMI",
          tooltip: "Add interfacial DMI interaction",
          disabled: !ctx.can({
            id: "object.add-interaction",
            objectId,
            kind: "interfacial_dmi",
          }),
          action: () =>
            ctx.run({
              id: "object.add-interaction",
              objectId,
              kind: "interfacial_dmi",
            }),
          iconColor: "text-cyan-400",
        },
        {
          id: "ctx-add-ku",
          icon: <Binary size={20} />,
          label: "Add Ku",
          tooltip: "Add uniaxial anisotropy interaction",
          disabled: !ctx.can({
            id: "object.add-interaction",
            objectId,
            kind: "uniaxial_anisotropy",
          }),
          action: () =>
            ctx.run({
              id: "object.add-interaction",
              objectId,
              kind: "uniaxial_anisotropy",
            }),
          iconColor: "text-rose-400",
        },
      ],
    },
    {
      id: "ctx-magnetization",
      title: "Magnetization",
      actions: [
        {
          id: "ctx-mag-uniform",
          icon: <Magnet size={20} />,
          label: "Uniform",
          tooltip: "Assign uniform magnetization texture to selected object",
          action: () => {
            ctx.run({
              id: "object.assign-magnetization-preset",
              objectId,
              kind: "uniform",
            });
            ctx.run({
              id: "navigation.select-node",
              nodeId: `mag-${objectId}`,
            });
          },
          iconColor: "text-sky-400",
        },
        {
          id: "ctx-mag-vortex",
          icon: <Sparkles size={20} />,
          label: "Vortex",
          tooltip: "Assign vortex texture to selected object",
          action: () => {
            ctx.run({
              id: "object.assign-magnetization-preset",
              objectId,
              kind: "vortex",
            });
            ctx.run({
              id: "navigation.select-node",
              nodeId: `mag-${objectId}`,
            });
          },
          iconColor: "text-violet-400",
        },
        {
          id: "ctx-mag-bloch",
          icon: <Target size={20} />,
          label: "Bloch Sky",
          tooltip: "Assign Bloch skyrmion texture to selected object",
          action: () => {
            ctx.run({
              id: "object.assign-magnetization-preset",
              objectId,
              kind: "bloch_skyrmion",
            });
            ctx.run({
              id: "navigation.select-node",
              nodeId: `mag-${objectId}`,
            });
          },
          iconColor: "text-cyan-400",
        },
        {
          id: "ctx-mag-neel",
          icon: <Target size={20} />,
          label: "Neel Sky",
          tooltip: "Assign Néel skyrmion texture to selected object",
          action: () => {
            ctx.run({
              id: "object.assign-magnetization-preset",
              objectId,
              kind: "neel_skyrmion",
            });
            ctx.run({
              id: "navigation.select-node",
              nodeId: `mag-${objectId}`,
            });
          },
          iconColor: "text-emerald-400",
        },
        {
          id: "ctx-mag-move",
          icon: <Move size={20} />,
          label: "Move",
          tooltip: "Enable texture translate gizmo",
          action: () => {
            ctx.run({
              id: "object.set-texture-transform-mode",
              objectId,
              mode: "translate",
            });
            ctx.run({
              id: "navigation.select-node",
              nodeId: `mag-${objectId}-transform`,
            });
          },
          iconColor: "text-amber-400",
        },
        {
          id: "ctx-mag-rotate",
          icon: <RefreshCw size={20} />,
          label: "Rotate",
          tooltip: "Enable texture rotate gizmo",
          action: () => {
            ctx.run({
              id: "object.set-texture-transform-mode",
              objectId,
              mode: "rotate",
            });
            ctx.run({
              id: "navigation.select-node",
              nodeId: `mag-${objectId}-transform`,
            });
          },
          iconColor: "text-fuchsia-400",
        },
        {
          id: "ctx-mag-scale",
          icon: <Maximize2 size={20} />,
          label: "Scale",
          tooltip: "Enable texture scale gizmo",
          action: () => {
            ctx.run({
              id: "object.set-texture-transform-mode",
              objectId,
              mode: "scale",
            });
            ctx.run({
              id: "navigation.select-node",
              nodeId: `mag-${objectId}-transform`,
            });
          },
          iconColor: "text-indigo-400",
        },
      ],
    },
  ];
}

registerRibbonContribution({
  tab: "selected-ferromagnet",
  priority: 0,
  buildGroups: buildSelectedFerromagnetGroups,
});

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
