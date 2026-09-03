"use client";

import type { ReactNode } from "react";
import { Binary, Cpu, Download, FunctionSquare, Layers3, Magnet, Play, Save, ScanLine, Sparkles, Waves, Zap } from "lucide-react";
import type { StudyPrimitiveStageKind } from "@/lib/study-builder/types";

interface StageBuilderRibbonProps {
  onAddPrimitive: (
    kind: StudyPrimitiveStageKind,
    placement: "append" | "before" | "after",
  ) => void;
  onAddMacro: (
    kind:
      | "hysteresis_loop"
      | "field_sweep_relax"
      | "field_sweep_relax_snapshot"
      | "relax_run"
      | "relax_eigenmodes"
      | "parameter_sweep",
    placement: "append" | "before" | "after",
  ) => void;
  selectedNodeId: string | null;
  onDuplicateSelected: () => void;
  onToggleSelectedEnabled: () => void;
}

interface RibbonActionButtonProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  accent?: "default" | "violet" | "emerald" | "amber";
}

function RibbonActionButton({
  icon,
  label,
  onClick,
  disabled = false,
  accent = "default",
}: RibbonActionButtonProps) {
  const accentClass =
    accent === "violet"
      ? "border-violet-500/25 bg-violet-500/10 text-violet-200 hover:bg-violet-500/15"
      : accent === "emerald"
        ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15"
        : accent === "amber"
          ? "border-amber-500/25 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15"
          : "border-border/40 bg-background/60 text-foreground hover:bg-accent/60";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex min-h-20 min-w-[5.5rem] flex-col items-center justify-center gap-2 rounded-md border px-3 py-2 text-center text-[0.68rem] font-medium transition disabled:opacity-40 ${accentClass}`}
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="leading-tight">{label}</span>
    </button>
  );
}

function RibbonGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 border-r border-border/30 pr-4 last:border-r-0 last:pr-0">
      <div className="text-[0.6rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export default function StageBuilderRibbon({
  onAddPrimitive,
  onAddMacro,
  selectedNodeId,
  onDuplicateSelected,
  onToggleSelectedEnabled,
}: StageBuilderRibbonProps) {
  const hasSelection = Boolean(selectedNodeId);
  const placement = hasSelection ? "after" : "append";

  return (
    <div className="rounded-lg border border-border/40 bg-background/35 p-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex flex-wrap gap-4">
          <RibbonGroup title="Add Stage">
            <RibbonActionButton icon={<Waves className="size-4" />} label="Relax" onClick={() => onAddPrimitive("relax", placement)} accent="emerald" />
            <RibbonActionButton icon={<Play className="size-4" />} label="Run" onClick={() => onAddPrimitive("run", placement)} accent="emerald" />
            <RibbonActionButton icon={<Sparkles className="size-4" />} label="Eigenmodes" onClick={() => onAddPrimitive("eigenmodes", placement)} accent="emerald" />
            <RibbonActionButton icon={<Zap className="size-4" />} label="Set Field" onClick={() => onAddPrimitive("set_field", placement)} />
            <RibbonActionButton icon={<Cpu className="size-4" />} label="Set Current" onClick={() => onAddPrimitive("set_current", placement)} />
          </RibbonGroup>

          <RibbonGroup title="State And Export">
            <RibbonActionButton icon={<Save className="size-4" />} label="Save State" onClick={() => onAddPrimitive("save_state", placement)} />
            <RibbonActionButton icon={<Download className="size-4" />} label="Load State" onClick={() => onAddPrimitive("load_state", placement)} />
            <RibbonActionButton icon={<ScanLine className="size-4" />} label="Export" onClick={() => onAddPrimitive("export", placement)} />
          </RibbonGroup>

          <RibbonGroup title="Composite">
            <RibbonActionButton icon={<Magnet className="size-4" />} label="Hysteresis Loop" onClick={() => onAddMacro("hysteresis_loop", placement)} accent="violet" />
            <RibbonActionButton icon={<FunctionSquare className="size-4" />} label="Field Sweep + Relax" onClick={() => onAddMacro("field_sweep_relax", placement)} accent="violet" />
            <RibbonActionButton icon={<FunctionSquare className="size-4" />} label="Field Sweep + Snapshot" onClick={() => onAddMacro("field_sweep_relax_snapshot", placement)} accent="violet" />
            <RibbonActionButton icon={<Layers3 className="size-4" />} label="Relax -> Run" onClick={() => onAddMacro("relax_run", placement)} accent="violet" />
            <RibbonActionButton icon={<Binary className="size-4" />} label="Relax -> Eigenmodes" onClick={() => onAddMacro("relax_eigenmodes", placement)} accent="violet" />
            <RibbonActionButton icon={<FunctionSquare className="size-4" />} label="Parameter Sweep" onClick={() => onAddMacro("parameter_sweep", placement)} accent="violet" />
          </RibbonGroup>
        </div>

        <div className="flex flex-col gap-2 xl:min-w-[16rem]">
          <div className="text-[0.6rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Selection
          </div>
          <div className="rounded-md border border-border/35 bg-background/50 p-3">
            <div className="text-[0.72rem] text-foreground">
              {hasSelection
                ? "New stages will be inserted after the selected node. Use the card actions for before/after control."
                : "No stage selected. New stages will be appended to the end of the pipeline."}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onDuplicateSelected}
                disabled={!hasSelection}
                className="rounded border border-border/40 px-2.5 py-1.5 text-[0.68rem] disabled:opacity-40"
              >
                Duplicate Selected
              </button>
              <button
                type="button"
                onClick={onToggleSelectedEnabled}
                disabled={!hasSelection}
                className="rounded border border-border/40 px-2.5 py-1.5 text-[0.68rem] disabled:opacity-40"
              >
                Enable / Disable
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
