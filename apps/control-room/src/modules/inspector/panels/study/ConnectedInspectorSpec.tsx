"use client";

import { useCallback, useContext, useState, type ReactNode } from "react";

import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import type { CommandId } from "@/kernel/commands/commandTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

import { inspectorFitCommandId } from "../../inspectorFitCommand";
import {
  InspectorTemplate,
  useInspectorSpecController,
  type InspectorSpec,
  type UnitOption,
  type UseInspectorSpecControllerOptions,
} from "../../template";

export const MU0_SI = 4 * Math.PI * 1e-7;
export const ELEMENTARY_CHARGE_J_PER_EV = 1.602176634e-19;
export const GYROMAGNETIC_RAD_PER_S_T = 1.7595e11;

export const TIME_UNITS_SI: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "fs", toSiFactor: 1e-15 },
  { unit: "ps", toSiFactor: 1e-12 },
  { unit: "ns", toSiFactor: 1e-9 },
  { unit: "µs", toSiFactor: 1e-6 },
  { unit: "ms", toSiFactor: 1e-3 },
  { unit: "s", toSiFactor: 1 },
];

export const FREQUENCY_UNITS_SI: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "Hz", toSiFactor: 1 },
  { unit: "MHz", toSiFactor: 1e6 },
  { unit: "GHz", toSiFactor: 1e9 },
  { unit: "THz", toSiFactor: 1e12 },
];

export const FIELD_TESLA_UNITS_SI: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "µT", toSiFactor: 1e-6 },
  { unit: "mT", toSiFactor: 1e-3 },
  { unit: "T", toSiFactor: 1 },
  { unit: "Oe", toSiFactor: 1e-4 },
  { unit: "kA/m", toSiFactor: MU0_SI * 1e3 },
];

export const FIELD_APM_UNITS_SI: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "A/m", toSiFactor: 1 },
  { unit: "kA/m", toSiFactor: 1e3 },
  { unit: "mT", toSiFactor: 1e-3 / MU0_SI },
  { unit: "T", toSiFactor: 1 / MU0_SI },
  { unit: "Oe", toSiFactor: 1e-4 / MU0_SI },
];

export const TORQUE_APM_UNITS_SI: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "mT", toSiFactor: 1e-3 / MU0_SI },
  { unit: "T", toSiFactor: 1 / MU0_SI },
  { unit: "A/m", toSiFactor: 1 },
  {
    unit: "deg/ns",
    toSiFactor:
      (Math.PI / 180) * 1e9 / (GYROMAGNETIC_RAD_PER_S_T * MU0_SI),
  },
];

export const ENERGY_JOULE_UNITS_SI: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "J", toSiFactor: 1 },
  { unit: "fJ", toSiFactor: 1e-15 },
  { unit: "aJ", toSiFactor: 1e-18 },
  { unit: "eV", toSiFactor: ELEMENTARY_CHARGE_J_PER_EV },
];

export const LENGTH_UNITS_SI: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "pm", toSiFactor: 1e-12 },
  { unit: "nm", toSiFactor: 1e-9 },
  { unit: "µm", toSiFactor: 1e-6 },
  { unit: "mm", toSiFactor: 1e-3 },
  { unit: "m", toSiFactor: 1 },
];

export const WAVEVECTOR_UNITS_SI: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "rad/µm", toSiFactor: 1e6 },
  { unit: "1/µm", toSiFactor: 2 * Math.PI * 1e6 },
  { unit: "rad/nm", toSiFactor: 1e9 },
  { unit: "rad/m", toSiFactor: 1 },
];

export const ANGLE_RAD_UNITS_SI: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "deg", toSiFactor: Math.PI / 180 },
  { unit: "rad", toSiFactor: 1 },
];

export const MEMORY_BYTES_UNITS_SI: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "MiB", toSiFactor: 1024 * 1024 },
  { unit: "GiB", toSiFactor: 1024 * 1024 * 1024 },
  { unit: "MB", toSiFactor: 1e6 },
  { unit: "GB", toSiFactor: 1e9 },
];

export function formatFrequencyCompact(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return "—";
  if (hz >= 1e12) return `${(hz / 1e12).toFixed(2)} THz`;
  if (hz >= 1e9) return `${(hz / 1e9).toFixed(2)} GHz`;
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(2)} MHz`;
  return `${hz.toFixed(1)} Hz`;
}

export function formatTimeCompact(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 s";
  if (seconds < 1e-12) return `${(seconds * 1e15).toFixed(1)} fs`;
  if (seconds < 1e-9) return `${(seconds * 1e12).toFixed(2)} ps`;
  if (seconds < 1e-6) return `${(seconds * 1e9).toFixed(2)} ns`;
  if (seconds < 1e-3) return `${(seconds * 1e6).toFixed(2)} µs`;
  return `${seconds.toFixed(3)} s`;
}

export function formatBytesBinary(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  const kib = 1024;
  if (bytes >= gib) return `${(bytes / gib).toFixed(2)} GiB`;
  if (bytes >= mib) return `${(bytes / mib).toFixed(1)} MiB`;
  if (bytes >= kib) return `${(bytes / kib).toFixed(1)} KiB`;
  return `${Math.round(bytes)} B`;
}

export interface PipelineStripStep {
  id: string;
  index: number;
  label: string;
  kind: string;
  status?: "ready" | "completed" | "running" | "stale" | "failed";
  selection?: Omit<Selection, "moduleSource">;
}

export function PipelineStrip({
  steps,
  currentIndex,
  onSelectStep,
}: {
  steps: readonly PipelineStripStep[];
  currentIndex?: number;
  onSelectStep?: (step: PipelineStripStep) => void;
}) {
  if (steps.length === 0) return null;
  return (
    <div
      aria-label="Study pipeline sequence"
      className="fm-pipeline-strip"
      data-slot="pipeline-strip"
      role="list"
    >
      {steps.map((step) => {
        const active = currentIndex === step.index;
        return (
          <Button
            key={step.id}
            className="fm-pipeline-step"
            data-active={active ? "true" : "false"}
            data-status={step.status ?? "ready"}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => onSelectStep?.(step)}
          >
            <span aria-hidden="true" className="fm-pipeline-step__dot" />
            <span>{`${step.index + 1}. ${step.label}`}</span>
          </Button>
        );
      })}
    </div>
  );
}

export interface SamplingPlanCardProps {
  durationS: number;
  tablePeriodS: number | null;
  tableSourceStageId?: string | null;
  tableColumnCount?: number;
  fieldSnapshotFrames?: number;
  fieldEveryS?: number | null;
  activeNodeCount?: number;
  sincCutoffHz?: number | null;
  onEditTableClock?: () => void;
  onAddFieldAutosave?: () => void;
}

export function computeSamplingPlanMetrics({
  durationS,
  tablePeriodS,
  tableColumnCount = 6,
  fieldSnapshotFrames,
  fieldEveryS,
  activeNodeCount = 65536,
}: {
  durationS: number;
  tablePeriodS: number | null;
  tableColumnCount?: number;
  fieldSnapshotFrames?: number;
  fieldEveryS?: number | null;
  activeNodeCount?: number;
}) {
  const validDuration = Number.isFinite(durationS) && durationS > 0 ? durationS : 0;
  const validPeriod =
    tablePeriodS !== null && Number.isFinite(tablePeriodS) && tablePeriodS > 0
      ? tablePeriodS
      : null;
  const nyquistHz = validPeriod ? 1 / (2 * validPeriod) : null;
  const deltaFHz = validDuration > 0 ? 1 / validDuration : null;
  const tableSamples =
    validDuration > 0 && validPeriod ? Math.floor(validDuration / validPeriod) : 0;
  const computedFieldFrames =
    fieldSnapshotFrames ??
    (validDuration > 0 && fieldEveryS && fieldEveryS > 0
      ? Math.floor(validDuration / fieldEveryS) + 1
      : 0);
  const tableBytes = tableSamples * tableColumnCount * 8;
  const fieldBytes = computedFieldFrames * activeNodeCount * 3 * 4;
  const totalZarrBytes = tableBytes + fieldBytes;
  return {
    nyquistHz,
    deltaFHz,
    tableSamples,
    fieldFrames: computedFieldFrames,
    totalZarrBytes,
  };
}

export function SamplingPlanCard({
  durationS,
  tablePeriodS,
  tableSourceStageId,
  tableColumnCount = 6,
  fieldSnapshotFrames,
  fieldEveryS,
  activeNodeCount = 65536,
  sincCutoffHz,
  onEditTableClock,
  onAddFieldAutosave,
}: SamplingPlanCardProps) {
  const metrics = computeSamplingPlanMetrics({
    durationS,
    tablePeriodS,
    tableColumnCount,
    fieldSnapshotFrames,
    fieldEveryS,
    activeNodeCount,
  });

  return (
    <div
      className="fm-math-equation"
      data-slot="sampling-plan-card"
    >
      <p className="fm-math-equation__caption">
        Effective sampling plan (Nyquist band &amp; Zarr v3 estimate)
      </p>
      <dl className="fm-math-equation__terms">
        <div className="fm-math-equation__term">
          <dt>Δt_sample</dt>
          <dd>
            {tablePeriodS && tablePeriodS > 0
              ? `${formatTimeCompact(tablePeriodS)}${tableSourceStageId ? ` (from ${tableSourceStageId})` : ""} · N = ${metrics.tableSamples.toLocaleString("en-US")}`
              : "No table clock active before this Run"}
          </dd>
        </div>
        {metrics.nyquistHz !== null ? (
          <div className="fm-math-equation__term">
            <dt>f_Nyq</dt>
            <dd>
              {formatFrequencyCompact(metrics.nyquistHz)}
              {metrics.deltaFHz !== null
                ? ` · Δf = ${formatFrequencyCompact(metrics.deltaFHz)}`
                : ""}
              {sincCutoffHz && sincCutoffHz > 0
                ? ` (f_c = ${formatFrequencyCompact(sincCutoffHz)})`
                : ""}
            </dd>
          </div>
        ) : null}
        <div className="fm-math-equation__term">
          <dt>3D snapshots</dt>
          <dd>
            {metrics.fieldFrames > 0
              ? `${metrics.fieldFrames.toLocaleString("en-US")} frames${fieldEveryS ? ` every ${formatTimeCompact(fieldEveryS)}` : ""}`
              : "Scalar table only (0 spatial field frames)"}
          </dd>
        </div>
        <div className="fm-math-equation__term">
          <dt>Est. Zarr</dt>
          <dd>{`~${formatBytesBinary(metrics.totalZarrBytes)} (Zarr v3 chunks)`}</dd>
        </div>
      </dl>
      {onEditTableClock || onAddFieldAutosave ? (
        <div className="fm-inspector-notice__actions">
          {onEditTableClock ? (
            <Button size="sm" type="button" variant="secondary" onClick={onEditTableClock}>
              Configure Table Clock
            </Button>
          ) : null}
          {onAddFieldAutosave ? (
            <Button size="sm" type="button" variant="ghost" onClick={onAddFieldAutosave}>
              + Add Field Autosave
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface ConnectedInspectorSpecProps<TDraft extends object> {
  spec: InspectorSpec<TDraft>;
  selection: Selection;
  baseline: TDraft;
  serverFieldErrors?: Readonly<Record<string, string | null | undefined>>;
  options?: UseInspectorSpecControllerOptions<TDraft>;
  onAfterFieldChange?: <K extends keyof TDraft & string>(
    key: K,
    value: TDraft[K],
    nextDraft: TDraft,
  ) => void;
  className?: string;
}

/**
 * Connects an `InspectorSpec<TDraft>` to `useInspectorSpecController` + `InspectorTemplate`
 * with optional `KernelContext` integration so views work identically inside the live
 * workspace shell and in isolated DOM unit tests.
 */
export function ConnectedInspectorSpec<TDraft extends object>({
  spec,
  selection,
  baseline,
  serverFieldErrors,
  options,
  onAfterFieldChange,
  className,
}: ConnectedInspectorSpecProps<TDraft>): ReactNode {
  const kernel = useContext(KernelContext);
  const controller = useInspectorSpecController(
    spec,
    selection,
    baseline,
    serverFieldErrors,
    options,
  );
  const [codePreview, setCodePreview] = useState<{
    title: string;
    code: string;
  } | null>(null);

  const handleSelectNode = useCallback(
    (next: Omit<Selection, "moduleSource">) => {
      kernel?.selection.set(next, "inspector");
    },
    [kernel],
  );

  const handleFitView = useCallback(
    (commandId?: CommandId) => {
      if (!kernel) return;
      const resolvedId =
        commandId ??
        inspectorFitCommandId(kernel.layout.get().activeViewportMainModuleId);
      void kernel.commands.execute(
        resolvedId,
        createCommandContext("inspector", kernel),
      );
    },
    [kernel],
  );

  const handleHideInspector = useCallback(() => {
    if (!kernel) return;
    void kernel.commands.execute(
      "panels:inspector:toggle",
      createCommandContext("inspector", kernel),
    );
  }, [kernel]);

  return (
    <>
      <InspectorTemplate
        activeModeTabId={controller.activeModeTabId}
        animationKey={controller.animationKey}
        appliedFlash={controller.appliedFlash}
        applyError={controller.applyError}
        applying={controller.applying}
        baseline={controller.baseline}
        className={className}
        dirtyFields={controller.dirtyFields}
        displayUnits={controller.displayUnits}
        draft={controller.draft}
        forceShowErrors={controller.forceShowErrors}
        invalidFields={controller.invalidFields}
        selection={selection}
        spec={spec}
        touchedFields={controller.touchedFields}
        onActiveModeTabChange={controller.setActiveModeTabId}
        onApply={controller.requestApply}
        onDisplayUnitChange={controller.setDisplayUnit}
        onFieldChange={(key, value) => {
          controller.setField(key, value);
          onAfterFieldChange?.(key, value, { ...controller.draft, [key]: value });
        }}
        onFieldTouch={controller.touchField}
        onFitView={handleFitView}
        onFocusField={(key) => controller.focusField(key as keyof TDraft & string)}
        onHideInspector={handleHideInspector}
        onOpenCodePreview={(title, _language, code) => setCodePreview({ title, code })}
        onParseErrorChange={controller.setParseError}
        onPatchDraft={controller.patchDraft}
        onResetDisplay={controller.resetDisplay}
        onRevertAll={controller.revertAll}
        onRevertField={controller.revertField}
        onSelectNode={handleSelectNode}
      />
      <Dialog
        open={codePreview !== null}
        onOpenChange={(open) => {
          if (!open) setCodePreview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{codePreview?.title ?? "Python DSL"}</DialogTitle>
            <DialogDescription>
              Equivalent Fullmag Python authoring snippet for the current draft.
            </DialogDescription>
          </DialogHeader>
          <pre className="fm-inspector-code-preview">
            <code>{codePreview?.code ?? ""}</code>
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}
