/**
 * Study tab ribbon contributions.
 */

import {
  Cog, Columns2, ListChecks, Target, Play, Sparkles, Magnet,
  FunctionSquare, Layers3, Binary, Zap, Plus, RefreshCw, Download,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";
import { buildViewGroup } from "./view-group";

function buildStudyGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  const studyNode = ctx.studyNodeContext;
  const hasStageSelection = studyNode?.kind === "study-stage";
  const placement = hasStageSelection ? "after" : "append";

  return [
    {
      id: "study-nav",
      title: "Study",
      actions: [
        {
          id: "study-overview",
          icon: <Cog size={20} />,
          label: "Overview",
          tooltip: "Study root and authoring summary",
          active:
            studyNode?.kind === "study-root" ||
            studyNode?.kind === "simulation-root",
          iconColor: "text-slate-400",
          action: () =>
            ctx.run({ id: "navigation.select-node", nodeId: "study" }),
        },
        {
          id: "study-defaults",
          icon: <Columns2 size={20} />,
          label: "Defaults",
          tooltip: "Runtime, solver and output defaults",
          active:
            studyNode?.kind === "study-defaults" ||
            studyNode?.kind === "study-runtime-defaults" ||
            studyNode?.kind === "study-solver-defaults" ||
            studyNode?.kind === "study-physics-defaults" ||
            studyNode?.kind === "study-outputs-defaults",
          iconColor: "text-cyan-400",
          action: () =>
            ctx.run({
              id: "navigation.select-node",
              nodeId: "study-defaults",
            }),
          menuItems: [
            {
              id: "study-defaults-runtime",
              label: "Runtime Defaults",
              icon: <Play size={14} />,
              description: "Run horizon, execution mode and runtime policy",
              active: studyNode?.kind === "study-runtime-defaults",
              action: () =>
                ctx.run({
                  id: "navigation.select-node",
                  nodeId: "study-defaults-runtime",
                }),
            },
            {
              id: "study-defaults-solver",
              label: "Solver Defaults",
              icon: <Target size={14} />,
              description:
                "Integrator, relaxation and convergence defaults",
              active: studyNode?.kind === "study-solver-defaults",
              action: () =>
                ctx.run({
                  id: "navigation.select-node",
                  nodeId: "study-defaults-solver",
                }),
            },
            {
              id: "study-defaults-physics",
              label: "Physics Defaults",
              icon: <Magnet size={14} />,
              description:
                "Global Zeeman field and baseline magnetic forcing",
              active: studyNode?.kind === "study-physics-defaults",
              action: () =>
                ctx.run({
                  id: "navigation.select-node",
                  nodeId: "study-defaults-physics",
                }),
            },
            {
              id: "study-defaults-outputs",
              label: "Output Defaults",
              icon: <Download size={14} />,
              description: "Artifacts, snapshots and export policy",
              active: studyNode?.kind === "study-outputs-defaults",
              action: () =>
                ctx.run({
                  id: "navigation.select-node",
                  nodeId: "study-defaults-outputs",
                }),
            },
          ],
        },
        {
          id: "study-stages",
          icon: <ListChecks size={20} />,
          label: "Stages",
          tooltip: "Study stage sequence authoring",
          active:
            studyNode?.kind === "study-stages" ||
            studyNode?.kind === "study-stage" ||
            studyNode?.kind === "study-stage-empty",
          iconColor: "text-violet-400",
          action: () =>
            ctx.run({
              id: "navigation.select-node",
              nodeId: "study-stages",
            }),
        },
      ],
    },
    {
      id: "study-add",
      title: "Add Stage",
      actions: [
        {
          id: "study-add-relax",
          icon: <Target size={20} />,
          label: "Relax",
          tooltip: hasStageSelection
            ? "Insert Relax after the selected stage"
            : "Append Relax at the end of the stage sequence",
          accent: true,
          iconColor: "text-emerald-400",
          disabled: !ctx.can({
            id: "study.add-primitive",
            kind: "relax",
            placement,
          }),
          action: () =>
            ctx.run({
              id: "study.add-primitive",
              kind: "relax",
              placement,
            }),
        },
        {
          id: "study-add-run",
          icon: <Play size={20} />,
          label: "Run",
          tooltip: hasStageSelection
            ? "Insert Run after the selected stage"
            : "Append Run at the end of the stage sequence",
          accent: true,
          iconColor: "text-emerald-400",
          disabled: !ctx.can({
            id: "study.add-primitive",
            kind: "run",
            placement,
          }),
          action: () =>
            ctx.run({ id: "study.add-primitive", kind: "run", placement }),
        },
        {
          id: "study-add-eigen",
          icon: <Sparkles size={20} />,
          label: "Eigensolve",
          tooltip: hasStageSelection
            ? "Insert Eigensolve after the selected stage"
            : "Append Eigensolve at the end of the stage sequence",
          accent: true,
          iconColor: "text-emerald-400",
          disabled: !ctx.can({
            id: "study.add-primitive",
            kind: "eigenmodes",
            placement,
          }),
          action: () =>
            ctx.run({
              id: "study.add-primitive",
              kind: "eigenmodes",
              placement,
            }),
        },
      ],
    },
    {
      id: "study-composite",
      title: "Composite",
      actions: [
        {
          id: "study-add-hysteresis",
          icon: <Magnet size={20} />,
          label: "Hysteresis",
          tooltip: hasStageSelection
            ? "Insert Hysteresis Loop after the selected stage"
            : "Append Hysteresis Loop at the end of the stage sequence",
          iconColor: "text-violet-400",
          disabled: !ctx.can({
            id: "study.add-macro",
            kind: "hysteresis_loop",
            placement,
          }),
          action: () =>
            ctx.run({
              id: "study.add-macro",
              kind: "hysteresis_loop",
              placement,
            }),
        },
        {
          id: "study-add-field-sweep",
          icon: <FunctionSquare size={20} />,
          label: "Sweep+Relax",
          tooltip: hasStageSelection
            ? "Insert Field Sweep + Relax after the selected stage"
            : "Append Field Sweep + Relax at the end of the stage sequence",
          iconColor: "text-violet-400",
          disabled: !ctx.can({
            id: "study.add-macro",
            kind: "field_sweep_relax",
            placement,
          }),
          action: () =>
            ctx.run({
              id: "study.add-macro",
              kind: "field_sweep_relax",
              placement,
            }),
        },
        {
          id: "study-add-field-sweep-snapshot",
          icon: <FunctionSquare size={20} />,
          label: "Sweep+Snap",
          tooltip: hasStageSelection
            ? "Insert Field Sweep + Relax + Snapshot after the selected stage"
            : "Append Field Sweep + Relax + Snapshot at the end of the stage sequence",
          iconColor: "text-violet-400",
          disabled: !ctx.can({
            id: "study.add-macro",
            kind: "field_sweep_relax_snapshot",
            placement,
          }),
          action: () =>
            ctx.run({
              id: "study.add-macro",
              kind: "field_sweep_relax_snapshot",
              placement,
            }),
        },
        {
          id: "study-add-relax-run",
          icon: <Layers3 size={20} />,
          label: "Relax->Run",
          tooltip: hasStageSelection
            ? "Insert Relax -> Run after the selected stage"
            : "Append Relax -> Run at the end of the stage sequence",
          iconColor: "text-violet-400",
          disabled: !ctx.can({
            id: "study.add-macro",
            kind: "relax_run",
            placement,
          }),
          action: () =>
            ctx.run({
              id: "study.add-macro",
              kind: "relax_run",
              placement,
            }),
        },
        {
          id: "study-add-relax-eigen",
          icon: <Binary size={20} />,
          label: "Relax->Eigen",
          tooltip: hasStageSelection
            ? "Insert Relax -> Eigensolve after the selected stage"
            : "Append Relax -> Eigensolve at the end of the stage sequence",
          iconColor: "text-violet-400",
          disabled: !ctx.can({
            id: "study.add-macro",
            kind: "relax_eigenmodes",
            placement,
          }),
          action: () =>
            ctx.run({
              id: "study.add-macro",
              kind: "relax_eigenmodes",
              placement,
            }),
        },
        {
          id: "study-add-parameter-sweep",
          icon: <FunctionSquare size={20} />,
          label: "Param Sweep",
          tooltip: hasStageSelection
            ? "Insert Parameter Sweep after the selected stage"
            : "Append Parameter Sweep at the end of the stage sequence",
          iconColor: "text-violet-400",
          disabled: !ctx.can({
            id: "study.add-macro",
            kind: "parameter_sweep",
            placement,
          }),
          action: () =>
            ctx.run({
              id: "study.add-macro",
              kind: "parameter_sweep",
              placement,
            }),
        },
        {
          id: "study-add-current-sweep",
          icon: <Zap size={20} />,
          label: "Current Sweep",
          tooltip: hasStageSelection
            ? "Insert current-density sweep + time evolution after the selected stage"
            : "Append current sweep to study",
          iconColor: "text-emerald-400",
          disabled: !ctx.can({
            id: "study.add-macro",
            kind: "current_sweep_run",
            placement,
          }),
          action: () =>
            ctx.run({
              id: "study.add-macro",
              kind: "current_sweep_run",
              placement,
            }),
        },
      ],
    },
    {
      id: "study-selection",
      title: "Selection",
      actions: [
        {
          id: "study-duplicate",
          icon: <Plus size={20} />,
          label: "Duplicate",
          tooltip: hasStageSelection
            ? "Duplicate the selected stage node"
            : "Select a stage node to duplicate it",
          disabled:
            !hasStageSelection ||
            !ctx.can({ id: "study.duplicate-selected" }),
          action: () => ctx.run({ id: "study.duplicate-selected" }),
          iconColor: "text-amber-400",
        },
        {
          id: "study-toggle",
          icon: <RefreshCw size={20} />,
          label: "Enable",
          tooltip: hasStageSelection
            ? "Enable or disable the selected stage node"
            : "Select a stage node to toggle it",
          disabled:
            !hasStageSelection ||
            !ctx.can({ id: "study.toggle-selected-enabled" }),
          action: () => ctx.run({ id: "study.toggle-selected-enabled" }),
          iconColor: "text-slate-400",
        },
      ],
    },
    {
      id: "builder-sync",
      title: "Sync",
      actions: [
        {
          id: "builder-sync-script",
          icon: (
            <RefreshCw
              size={20}
              className={cn(ctx.scriptSyncBusy && "animate-spin")}
            />
          ),
          label: ctx.scriptSyncBusy ? "Syncing..." : "Sync Script",
          tooltip:
            "Rewrite the Python script from the current builder state",
          accent: true,
          disabled: !ctx.can({ id: "script.sync" }),
          action: () => ctx.run({ id: "script.sync" }),
        },
      ],
    },
    buildViewGroup(ctx),
  ];
}

registerRibbonContribution({
  tab: "study",
  priority: 0,
  buildGroups: buildStudyGroups,
});
