"use client";

import type { InputHTMLAttributes, ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Settings2 } from "lucide-react";
import { humanizeToken } from "@/components/panels/settings/helpers";
import { INTEGRATOR_PROFILES, RELAXATION_PROFILES } from "@/components/panels/settings/profiles";
import SelectField from "@/components/ui/SelectField";
import TextField from "@/components/ui/TextField";
import type { ScriptBuilderStageState } from "@/lib/session/types";
import {
  humanizeStudyPipelineNodeKind,
  summarizeMaterializedStage,
  summarizeStudyPipelineNode,
} from "@/lib/study-builder/summaries";
import type { StudyPipelineDiagnostic, StudyPipelineNode } from "@/lib/study-builder/types";
import StageSummaryChip from "./StageSummaryChip";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-border/30 bg-background/45">
      <div className="border-b border-border/30 px-3 py-2 text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {title}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-[0.68rem] text-muted-foreground">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`rounded border border-border/40 bg-background px-2.5 py-1.5 text-[0.74rem] text-foreground outline-none focus:border-primary/60 ${props.className ?? ""}`}
    />
  );
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[0.72rem] text-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 rounded border-border/40 bg-background"
      />
      {label}
    </label>
  );
}

const INTEGRATOR_OPTIONS = Object.entries(INTEGRATOR_PROFILES).map(([value, profile]) => ({
  value,
  label: profile.label,
}));

const RELAX_ALGORITHM_OPTIONS = Object.entries(RELAXATION_PROFILES).map(([value, profile]) => ({
  value,
  label: profile.label,
}));

const EIGEN_TARGET_OPTIONS = [
  { value: "lowest", label: "Lowest" },
  { value: "nearest", label: "Nearest" },
];

const EIGEN_EQUILIBRIUM_SOURCE_OPTIONS = [
  { value: "relax", label: "Relaxed initial state" },
  { value: "provided", label: "Provided initial state" },
  { value: "artifact", label: "State artifact" },
];

const EIGEN_NORMALIZATION_OPTIONS = [
  { value: "unit_l2", label: "Unit L2" },
  { value: "unit_max_amplitude", label: "Unit max amplitude" },
];

const EIGEN_DAMPING_POLICY_OPTIONS = [
  { value: "ignore", label: "Ignore damping" },
  { value: "include", label: "Include damping" },
];

const EIGEN_SPIN_WAVE_BC_OPTIONS = [
  { value: "free", label: "Free" },
  { value: "pinned", label: "Pinned" },
  { value: "periodic", label: "Periodic" },
  { value: "floquet", label: "Floquet" },
  { value: "surface_anisotropy", label: "Surface anisotropy" },
];

interface EigenBcCarrier {
  eigen_spin_wave_bc?: unknown;
  eigen_spin_wave_bc_config?: unknown;
}

function eigenBcConfig(stage: EigenBcCarrier): Record<string, unknown> {
  const config: Record<string, unknown> =
    stage.eigen_spin_wave_bc_config && typeof stage.eigen_spin_wave_bc_config === "object"
      ? { ...stage.eigen_spin_wave_bc_config }
      : {};
  if (typeof config.kind !== "string" || !config.kind) {
    config.kind = stage.eigen_spin_wave_bc || "free";
  }
  return config;
}

function patchEigenBcConfig(
  stage: EigenBcCarrier,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...eigenBcConfig(stage), ...patch };
  return {
    eigen_spin_wave_bc: String(next.kind ?? stage.eigen_spin_wave_bc ?? "free"),
    eigen_spin_wave_bc_config: next,
  };
}

interface StageInspectorProps {
  node: StudyPipelineNode | null;
  onRename: (value: string) => void;
  onToggleEnabled: () => void;
  onPatchConfig: (patch: Record<string, unknown>) => void;
  onPatchNotes: (value: string) => void;
  compiledStages: ScriptBuilderStageState[];
  diagnostics: StudyPipelineDiagnostic[];
}

export default function StageInspector({
  node,
  onRename,
  onToggleEnabled,
  onPatchConfig,
  onPatchNotes,
  compiledStages,
  diagnostics,
}: StageInspectorProps) {
  if (!node) {
    return (
      <div className="rounded-lg border border-border/40 bg-background/40 p-4 text-xs text-muted-foreground">
        Select a stage in the Study tree or pipeline canvas to inspect its settings.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/40 bg-background/35 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Settings
          </div>
          <div className="mt-1 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Settings2 className="size-4 text-muted-foreground" />
            {node.label}
          </div>
          <div className="mt-1 text-[0.72rem] leading-relaxed text-muted-foreground">
            {summarizeStudyPipelineNode(node)}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          <StageSummaryChip
            label={humanizeStudyPipelineNodeKind(node)}
            tone={node.node_kind === "macro" ? "violet" : "default"}
          />
          <StageSummaryChip
            label={node.source === "script_imported" ? "Script Imported" : "UI Authored"}
            tone={node.source === "script_imported" ? "amber" : "emerald"}
          />
        </div>
      </div>

      <Section title="Selection">
        <div className="grid grid-cols-1 gap-3 @[720px]:grid-cols-2">
          <Field label="Label">
            <Input value={node.label} onChange={(event) => onRename(event.target.value)} />
          </Field>
          <Field label="Status">
            <div className="flex h-[2.15rem] items-center">
              <button
                type="button"
                onClick={onToggleEnabled}
                className="rounded border border-border/40 px-2.5 py-1.5 text-[0.72rem]"
              >
                {node.enabled ? "Disable node" : "Enable node"}
              </button>
            </div>
          </Field>
        </div>
      </Section>

      {node.node_kind === "primitive" ? (
        <Section title="Stage Parameters">
          <div className="grid grid-cols-1 gap-3 @[720px]:grid-cols-2">
            <Field label="Stage kind">
              <Input value={humanizeToken(node.stage_kind)} readOnly />
            </Field>
            <Field label="Entrypoint">
              <Input value={String(node.payload.entrypoint_kind ?? node.stage_kind)} readOnly />
            </Field>

            {(node.stage_kind === "relax" || node.stage_kind === "run") && (
              <div className="md:col-span-2">
                <SelectField
                  label="Integrator"
                  value={String(node.payload.integrator ?? "rk45")}
                  options={INTEGRATOR_OPTIONS}
                  onchange={(value) => onPatchConfig({ integrator: value })}
                />
              </div>
            )}

            {node.stage_kind === "run" ? (
              <>
                <TextField
                  label="Run until [s]"
                  value={String(node.payload.until_seconds ?? "")}
                  onchange={(event) => onPatchConfig({ until_seconds: event.target.value })}
                  mono
                />
                <TextField
                  label="Fixed dt [s]"
                  value={String(node.payload.fixed_timestep ?? "")}
                  onchange={(event) => onPatchConfig({ fixed_timestep: event.target.value })}
                  mono
                />
              </>
            ) : null}

            {node.stage_kind === "relax" ? (
              <>
                <div className="md:col-span-2">
                  <SelectField
                    label="Relax algorithm"
                    value={String(node.payload.relax_algorithm ?? "llg_overdamped")}
                    options={RELAX_ALGORITHM_OPTIONS}
                    onchange={(value) => onPatchConfig({ relax_algorithm: value })}
                  />
                </div>
                <TextField
                  label="Torque tolerance"
                  value={String(node.payload.torque_tolerance ?? "1e-6")}
                  onchange={(event) => onPatchConfig({ torque_tolerance: event.target.value })}
                  mono
                />
                <TextField
                  label="Energy tolerance"
                  value={String(node.payload.energy_tolerance ?? "")}
                  onchange={(event) => onPatchConfig({ energy_tolerance: event.target.value })}
                  mono
                />
                <TextField
                  label="Max steps"
                  value={String(node.payload.max_steps ?? "5000")}
                  onchange={(event) => onPatchConfig({ max_steps: event.target.value })}
                  mono
                />
                <TextField
                  label="Fixed dt [s]"
                  value={String(node.payload.fixed_timestep ?? "")}
                  onchange={(event) => onPatchConfig({ fixed_timestep: event.target.value })}
                  mono
                />
              </>
            ) : null}

            {node.stage_kind === "eigenmodes" ? (
              <>
                <TextField
                  label="Mode count"
                  value={String(node.payload.eigen_count ?? "10")}
                  onchange={(event) => onPatchConfig({ eigen_count: event.target.value })}
                  mono
                />
                <SelectField
                  label="Target"
                  value={String(node.payload.eigen_target ?? "lowest")}
                  options={EIGEN_TARGET_OPTIONS}
                  onchange={(value) => onPatchConfig({ eigen_target: value })}
                />
                <SelectField
                  label="Equilibrium source"
                  value={String(node.payload.eigen_equilibrium_source ?? "relax")}
                  options={EIGEN_EQUILIBRIUM_SOURCE_OPTIONS}
                  onchange={(value) => onPatchConfig({ eigen_equilibrium_source: value })}
                />
                <SelectField
                  label="Normalization"
                  value={String(node.payload.eigen_normalization ?? "unit_l2")}
                  options={EIGEN_NORMALIZATION_OPTIONS}
                  onchange={(value) => onPatchConfig({ eigen_normalization: value })}
                />
                <SelectField
                  label="Damping policy"
                  value={String(node.payload.eigen_damping_policy ?? "ignore")}
                  options={EIGEN_DAMPING_POLICY_OPTIONS}
                  onchange={(value) => onPatchConfig({ eigen_damping_policy: value })}
                />
                <TextField
                  label="Target frequency"
                  value={String(node.payload.eigen_target_frequency ?? "")}
                  onchange={(event) => onPatchConfig({ eigen_target_frequency: event.target.value })}
                  mono
                />
                <TextField
                  label="k-vector"
                  value={String(node.payload.eigen_k_vector ?? "")}
                  onchange={(event) => onPatchConfig({ eigen_k_vector: event.target.value })}
                  mono
                />
                <SelectField
                  label="Spin-wave BC"
                  value={String(node.payload.eigen_spin_wave_bc ?? "free")}
                  options={EIGEN_SPIN_WAVE_BC_OPTIONS}
                  onchange={(value) =>
                    onPatchConfig({
                      eigen_spin_wave_bc: value,
                      ...patchEigenBcConfig(node.payload as EigenBcCarrier, { kind: value }),
                    })
                  }
                />
                <div className="md:col-span-2">
                  <Checkbox
                    label="Include demag in eigenproblem"
                    checked={Boolean(node.payload.eigen_include_demag)}
                    onChange={(checked) => onPatchConfig({ eigen_include_demag: checked })}
                  />
                </div>
              </>
            ) : null}

            {node.stage_kind === "set_field" ? (
              <>
                <Field label="Field axis">
                  <Input
                    value={String(node.payload.axis ?? "z")}
                    onChange={(event) => onPatchConfig({ axis: event.target.value })}
                  />
                </Field>
                <Field label="Field amplitude [mT]">
                  <Input
                    value={String(node.payload.field_mT ?? "50")}
                    onChange={(event) => onPatchConfig({ field_mT: event.target.value })}
                  />
                </Field>
              </>
            ) : null}

            {node.stage_kind === "set_current" ? (
              <>
                <Field label="Direction">
                  <Input
                    value={String(node.payload.direction ?? "x")}
                    onChange={(event) => onPatchConfig({ direction: event.target.value })}
                  />
                </Field>
                <Field label="Current density">
                  <Input
                    value={String(node.payload.current_density ?? "1e10")}
                    onChange={(event) => onPatchConfig({ current_density: event.target.value })}
                  />
                </Field>
              </>
            ) : null}

            {node.stage_kind === "save_state" || node.stage_kind === "load_state" ? (
              <Field label="Artifact name">
                <Input
                  value={String(node.payload.artifact_name ?? "state_snapshot")}
                  onChange={(event) => onPatchConfig({ artifact_name: event.target.value })}
                />
              </Field>
            ) : null}

            {node.stage_kind === "export" ? (
              <>
                <Field label="Quantity">
                  <Input
                    value={String(node.payload.quantity ?? "magnetization")}
                    onChange={(event) => onPatchConfig({ quantity: event.target.value })}
                  />
                </Field>
                <Field label="Format">
                  <Input
                    value={String(node.payload.format ?? "json")}
                    onChange={(event) => onPatchConfig({ format: event.target.value })}
                  />
                </Field>
              </>
            ) : null}
          </div>
        </Section>
      ) : null}

      {node.node_kind === "macro" ? (
        <Section title="Macro Parameters">
          <div className="grid grid-cols-1 gap-3 @[720px]:grid-cols-2">
            {node.macro_kind === "field_sweep_relax" || node.macro_kind === "field_sweep_relax_snapshot" ? (
              <>
                <Field label="Start [mT]">
                  <Input
                    type="number"
                    value={Number(node.config.start_mT ?? -100)}
                    onChange={(event) => onPatchConfig({ start_mT: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Stop [mT]">
                  <Input
                    type="number"
                    value={Number(node.config.stop_mT ?? 100)}
                    onChange={(event) => onPatchConfig({ stop_mT: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Steps">
                  <Input
                    type="number"
                    min={1}
                    value={Number(node.config.steps ?? 11)}
                    onChange={(event) => onPatchConfig({ steps: Math.max(1, Number(event.target.value)) })}
                  />
                </Field>
                <Field label="Axis">
                  <Input
                    value={String(node.config.axis ?? "z")}
                    onChange={(event) => onPatchConfig({ axis: event.target.value })}
                  />
                </Field>
                <div className="md:col-span-2">
                  <Checkbox
                    label="Relax after each field step"
                    checked={node.config.relax_each !== false}
                    onChange={(checked) => onPatchConfig({ relax_each: checked })}
                  />
                </div>
                <div className="md:col-span-2">
                  <Checkbox
                    label="Save snapshot at each step"
                    checked={Boolean(node.config.save_point_state ?? (node.macro_kind === "field_sweep_relax_snapshot"))}
                    onChange={(checked) => onPatchConfig({ save_point_state: checked })}
                  />
                </div>
              </>
            ) : null}

            {node.macro_kind === "hysteresis_loop" ? (
              <>
                <Field label="Sweep quantity">
                  <Input
                    value={String(node.config.quantity ?? "b_ext")}
                    onChange={(event) => onPatchConfig({ quantity: event.target.value })}
                  />
                </Field>
                <Field label="Axis">
                  <Input
                    value={String(node.config.axis ?? "z")}
                    onChange={(event) => onPatchConfig({ axis: event.target.value })}
                  />
                </Field>
                <Field label="Start [mT]">
                  <Input
                    type="number"
                    value={Number(node.config.start_mT ?? -100)}
                    onChange={(event) => onPatchConfig({ start_mT: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Stop [mT]">
                  <Input
                    type="number"
                    value={Number(node.config.stop_mT ?? 100)}
                    onChange={(event) => onPatchConfig({ stop_mT: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Points">
                  <Input
                    type="number"
                    min={2}
                    value={Number(node.config.steps ?? 21)}
                    onChange={(event) => onPatchConfig({ steps: Math.max(2, Number(event.target.value)) })}
                  />
                </Field>
                <div className="md:col-span-2">
                  <Checkbox
                    label="Relax after each sweep point"
                    checked={node.config.relax_each !== false}
                    onChange={(checked) => onPatchConfig({ relax_each: checked })}
                  />
                </div>
                <div className="md:col-span-2">
                  <Checkbox
                    label="Save a state snapshot at each point"
                    checked={Boolean(node.config.save_point_state)}
                    onChange={(checked) => onPatchConfig({ save_point_state: checked })}
                  />
                </div>
              </>
            ) : null}

            {node.macro_kind === "relax_run" ? (
              <Field label="Run until [s]">
                <Input
                  value={String(node.config.run_until_seconds ?? "1e-9")}
                  onChange={(event) => onPatchConfig({ run_until_seconds: event.target.value })}
                />
              </Field>
            ) : null}

            {node.macro_kind === "relax_eigenmodes" ? (
              <>
                <Field label="Mode count">
                  <Input
                    value={String(node.config.eigen_count ?? "10")}
                    onChange={(event) => onPatchConfig({ eigen_count: event.target.value })}
                  />
                </Field>
                <div className="md:col-span-2">
                  <Checkbox
                    label="Include demag in eigenproblem"
                    checked={Boolean(node.config.eigen_include_demag ?? true)}
                    onChange={(checked) => onPatchConfig({ eigen_include_demag: checked })}
                  />
                </div>
              </>
            ) : null}

            {node.macro_kind === "parameter_sweep" ? (
              <>
                <Field label="Parameter">
                  <Input
                    value={String(node.config.parameter ?? "b_ext")}
                    onChange={(event) => onPatchConfig({ parameter: event.target.value })}
                  />
                </Field>
                <Field label="Axis">
                  <Input
                    value={String(node.config.axis ?? "z")}
                    onChange={(event) => onPatchConfig({ axis: event.target.value })}
                  />
                </Field>
                <Field label="Start">
                  <Input
                    value={String(node.config.start_mT ?? node.config.start_value ?? -100)}
                    onChange={(event) => onPatchConfig({ start_mT: event.target.value })}
                  />
                </Field>
                <Field label="Stop">
                  <Input
                    value={String(node.config.stop_mT ?? node.config.stop_value ?? 100)}
                    onChange={(event) => onPatchConfig({ stop_mT: event.target.value })}
                  />
                </Field>
                <Field label="Steps">
                  <Input
                    type="number"
                    min={1}
                    value={Number(node.config.steps ?? 11)}
                    onChange={(event) => onPatchConfig({ steps: Math.max(1, Number(event.target.value)) })}
                  />
                </Field>
                <Field label="Solve kind">
                  <Input
                    value={String(node.config.solve_kind ?? "run_relax")}
                    onChange={(event) => onPatchConfig({ solve_kind: event.target.value })}
                  />
                </Field>
                <Field label="Run until [s]">
                  <Input
                    value={String(node.config.run_until_seconds ?? "1e-12")}
                    onChange={(event) => onPatchConfig({ run_until_seconds: event.target.value })}
                  />
                </Field>
                <div className="md:col-span-2">
                  <Checkbox
                    label="Save a state snapshot at each point"
                    checked={Boolean(node.config.save_point_state)}
                    onChange={(checked) => onPatchConfig({ save_point_state: checked })}
                  />
                </div>
              </>
            ) : null}
          </div>
        </Section>
      ) : null}

      <Section title="Notes">
        <textarea
          value={node.notes ?? ""}
          onChange={(event) => onPatchNotes(event.target.value)}
          className="min-h-24 w-full rounded border border-border/40 bg-background px-2.5 py-2 text-[0.74rem] text-foreground outline-none focus:border-primary/60"
          placeholder="Optional design notes for this stage..."
        />
      </Section>

      <Section title="Compiled Expansion Preview">
        {compiledStages.length === 0 ? (
          <div className="text-[0.72rem] text-muted-foreground">
            This node currently does not materialize to backend stages.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {compiledStages.map((stage, index) => (
              <div
                key={`${stage.kind}-${index}-${stage.entrypoint_kind}`}
                className="rounded border border-border/30 px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[0.72rem] font-semibold text-foreground">
                    {index + 1}. {humanizeToken(stage.kind)}
                  </span>
                  <CheckCircle2 className="size-3.5 text-emerald-400" />
                </div>
                <div className="mt-1 text-[0.68rem] text-muted-foreground">
                  {summarizeMaterializedStage(stage)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Warnings">
        {diagnostics.length === 0 ? (
          <div className="flex items-center gap-2 text-[0.72rem] text-emerald-400">
            <CheckCircle2 className="size-4" />
            No stage-specific validation issues.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {diagnostics.map((item) => (
              <div
                key={item.id}
                className="rounded border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-[0.72rem] text-amber-200"
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <div>
                    <div>{item.message}</div>
                    {item.suggestion ? (
                      <div className="mt-1 text-[0.68rem] text-amber-100/80">{item.suggestion}</div>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
