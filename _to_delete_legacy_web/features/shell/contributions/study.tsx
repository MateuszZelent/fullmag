/**
 * Study tab ribbon contributions.
 */

import {
  Cog, ListChecks, Target, Play, Sparkles, Magnet,
  FunctionSquare, Layers3, Binary, Zap, Plus, RefreshCw, Calculator,
  Pause, Square, SkipForward,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";

function buildStudyGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  const studyNode = ctx.studyNodeContext;
  const hasStageSelection = studyNode?.kind === "study-stage";
  const placement = hasStageSelection ? "after" : "append";
  const canRun = ctx.can({ id: "solver.control", action: "run" });
  const canComputeFields = ctx.can({ id: "solver.control", action: "compute_fields" });
  const canPause = ctx.can({ id: "solver.control", action: "pause" });
  const canStop = ctx.can({ id: "solver.control", action: "stop" });
  const canSkip = ctx.can({ id: "solver.control", action: "skip" });

  return [
    {
      id: "study-nav",
      title: "Study",
      subtitle: "Navigate",
      tone: "neutral",
      actions: [
        {
          id: "study-overview",
          icon: <Cog size={20} />,
          label: "Overview",
          tooltip: "Study root and authoring summary",
          active:
            studyNode?.kind === "study-root" ||
            studyNode?.kind === "simulation-root",
          iconColor: "text-muted-foreground",
          action: () =>
            ctx.run({ id: "navigation.select-node", nodeId: "study" }),
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
      subtitle: hasStageSelection ? "Insert after selection" : "Append to pipeline",
      tone: "authoring",
      actions: [
        {
          id: "study-add-relax",
          icon: <Target size={20} />,
          label: "Add Relax",
          tooltip: hasStageSelection
            ? "Insert Relax after the selected stage"
            : "Append Relax at the end of the stage sequence",
          iconColor: "text-amber-400",
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
          label: "Add Run",
          tooltip: hasStageSelection
            ? "Insert Run after the selected stage"
            : "Append Run at the end of the stage sequence",
          iconColor: "text-cyan-400",
          action: () =>
            ctx.run({ id: "study.add-primitive", kind: "run", placement }),
        },
        {
          id: "study-add-eigen",
          icon: <Sparkles size={20} />,
          label: "Add Eigensolve",
          tooltip: hasStageSelection
            ? "Insert Eigensolve after the selected stage"
            : "Append Eigensolve at the end of the stage sequence",
          iconColor: "text-violet-400",
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
      subtitle: "Reusable workflows",
      tone: "compose",
      actions: [
        {
          id: "study-add-hysteresis",
          icon: <Magnet size={20} />,
          label: "Hysteresis",
          tooltip: hasStageSelection
            ? "Insert Hysteresis Loop after the selected stage"
            : "Append Hysteresis Loop at the end of the stage sequence",
          iconColor: "text-violet-400",
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
      id: "study-compute",
      title: "Compute",
      subtitle: "Execute pipeline",
      tone: "compute",
      actions: [
        {
          id: "study-compute-fields",
          icon: <Calculator size={20} />,
          label: "Fields",
          tooltip: canComputeFields
            ? "Compute current-state fields without running relaxation"
            : ctx.runDisabledReason ?? "Field computation is unavailable",
          disabled: !canComputeFields,
          action: () => ctx.run({ id: "solver.control", action: "compute_fields" }),
          iconColor: "text-emerald-400",
        },
        {
          id: "study-compute-run",
          icon: <Play size={20} fill="currentColor" />,
          label: "Compute",
          tooltip: canRun
            ? ctx.runLabel === "Resume"
              ? "Resume the staged compute pipeline"
              : "Materialize and execute the current study pipeline"
            : ctx.runDisabledReason ?? "Compute is unavailable",
          shortcut: "F5",
          accent: true,
          disabled: !canRun,
          action: () => ctx.run({ id: "solver.control", action: "run" }),
          iconColor: "text-cyan-400",
        },
        {
          id: "study-compute-pause",
          icon: <Pause size={20} fill="currentColor" />,
          label: "Pause",
          tooltip: canPause ? "Pause study execution" : ctx.pauseDisabledReason ?? "Pause is unavailable",
          disabled: !canPause,
          action: () => ctx.run({ id: "solver.control", action: "pause" }),
          iconColor: "text-amber-500",
        },
        {
          id: "study-compute-stop",
          icon: <Square size={20} fill="currentColor" />,
          label: "Stop",
          tooltip: canStop ? "Stop study execution" : ctx.stopDisabledReason ?? "Stop is unavailable",
          disabled: !canStop,
          action: () => ctx.run({ id: "solver.control", action: "stop" }),
          iconColor: "text-rose-500",
        },
        {
          id: "study-compute-skip",
          icon: <SkipForward size={20} />,
          label: "Skip",
          tooltip: canSkip ? "Skip the active stage when supported by runtime" : ctx.skipDisabledReason ?? "Skip is unavailable",
          disabled: !canSkip,
          action: () => ctx.run({ id: "solver.control", action: "skip" }),
          iconColor: "text-violet-400",
        },
      ],
    },
    {
      id: "study-selection",
      title: "Selection",
      subtitle: "Edit selected stage",
      tone: "selection",
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
          iconColor: "text-muted-foreground",
        },
      ],
    },
    {
      id: "builder-sync",
      title: "Sync",
      subtitle: "Rewrite script",
      tone: "sync",
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
          disabled: !ctx.can({ id: "script.sync" }),
          action: () => ctx.run({ id: "script.sync" }),
          iconColor: "text-emerald-400",
        },
      ],
    },
  ];
}

registerRibbonContribution({
  tab: "study",
  priority: 0,
  buildGroups: buildStudyGroups,
});
