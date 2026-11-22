"use client";

import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { SceneResource } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { useRuntimeCommandControlResourceData } from "@/kernel/resources/studyRuntimeResources";
import { ScientificEChart } from "@/shared/charts/ScientificEChart";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";

import {
  buildFieldDrivePreviewChartOption,
  createPiecewiseWaypoint,
  resolveDraftNyquistHz,
  type FieldDriveSpecDraft,
  type PiecewiseWaypointRow,
} from "./fieldDriveShared";

/* ── Controlled Sub-Components (Shared UI Primitives Only) ── */

export function AddRunStageButton({ scene }: { scene: SceneResource | null }) {
  const kernel = useKernel();
  const hasResourceSubscription = typeof kernel.resources?.subscribe === "function";
  const runtimeResourceData = useRuntimeCommandControlResourceData({
    enabled: hasResourceSubscription,
  });
  const context = useMemo(
    () =>
      createCommandContext("inspector", kernel, {
        resourceData: {
          ...runtimeResourceData,
          ...(scene ? { [MODEL_SCENE_PATH]: scene } : {}),
        },
        feedback: "foreground",
        sourceDetail: "FieldDriveSpec.empty-stages",
      }),
    [kernel, runtimeResourceData, scene],
  );

  const hasRegistryLookup = typeof kernel.commands.get === "function";
  const command = hasRegistryLookup ? kernel.commands.get("study.add-run-stage") : null;
  if (hasRegistryLookup && !command) return null;

  const enabled =
    typeof kernel.commands.isEnabled === "function"
      ? kernel.commands.isEnabled("study.add-run-stage", context)
      : true;
  const disabledReason = !enabled ? (command?.disabledReason?.(context) ?? null) : null;

  return (
    <Button
      disabled={!enabled}
      disabledReason={disabledReason}
      size="sm"
      type="button"
      variant="secondary"
      onClick={() => {
        void kernel.commands.execute("study.add-run-stage", context);
      }}
    >
      <Plus aria-hidden="true" size={12} />
      <span>Add run stage</span>
    </Button>
  );
}

export function FieldDrivePreviewWidget({
  draft,
  onDomainChange,
  scene,
}: {
  draft: FieldDriveSpecDraft;
  onDomainChange: (domain: "time" | "spectrum") => void;
  scene: SceneResource | null;
}) {
  const nyquistHz = resolveDraftNyquistHz(scene, draft);
  return (
    <div className="flex flex-col gap-2" data-slot="field-drive-preview">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[var(--fm-text-muted)]">
          Interactive excitation preview
        </span>
        <SegmentedControl
          aria-label="Excitation preview domain"
          options={[
            { value: "time", label: "Time B(t)" },
            { value: "spectrum", label: "Spectrum |B(f)|" },
          ]}
          value={draft.previewDomain}
          onValueChange={(next) => onDomainChange(next as "time" | "spectrum")}
        />
      </div>
      <ScientificEChart
        ariaLabel="Field drive waveform and spectrum preview"
        className="w-full rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)]"
        height={176}
        optionBuilder={() => buildFieldDrivePreviewChartOption(draft, nyquistHz)}
      />
    </div>
  );
}

export function ControlledPiecewiseWaypointsEditor({
  points,
  onChange,
  onParseErrorChange,
}: {
  points: readonly PiecewiseWaypointRow[];
  onChange: (next: readonly PiecewiseWaypointRow[]) => void;
  onParseErrorChange?: (error: string | null) => void;
}) {
  const [rawByCell, setRawByCell] = useState<Record<string, { expected: number; text: string }>>(
    {},
  );

  const updateErrorState = (
    cells: Record<string, { expected: number; text: string }>,
    currentPoints: readonly PiecewiseWaypointRow[],
  ) => {
    for (const pt of currentPoints) {
      for (const field of ["time", "scale"] as const) {
        const cell = cells[`${pt._rowId}:${field}`];
        if (!cell) continue;
        if (cell.text.trim().length === 0 || !Number.isFinite(Number(cell.text))) {
          onParseErrorChange?.("Piecewise-linear points require finite numeric values.");
          return;
        }
      }
    }
    onParseErrorChange?.(null);
  };

  return (
    <div className="flex flex-col gap-1.5" data-slot="piecewise-waypoints-editor">
      <div className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-1.5 text-xs font-medium text-[var(--fm-text-muted)]">
        <span className="w-6">#</span>
        <span>Time t (ns)</span>
        <span>Scale f(t)</span>
        <span className="w-7" />
      </div>
      {points.map((pt, idx) => {
        const expectedTimeNs = Number((pt.timeS * 1e9).toPrecision(6));
        const expectedScale = pt.scale;
        const timeKey = `${pt._rowId}:time`;
        const scaleKey = `${pt._rowId}:scale`;
        const timeCell = rawByCell[timeKey];
        const scaleCell = rawByCell[scaleKey];
        const timeValue =
          timeCell && Object.is(timeCell.expected, expectedTimeNs)
            ? timeCell.text
            : String(expectedTimeNs);
        const scaleValue =
          scaleCell && Object.is(scaleCell.expected, expectedScale)
            ? scaleCell.text
            : String(expectedScale);

        const timeInvalid =
          timeValue.trim().length === 0 || !Number.isFinite(Number(timeValue));
        const scaleInvalid =
          scaleValue.trim().length === 0 || !Number.isFinite(Number(scaleValue));

        return (
          <div
            key={pt._rowId}
            className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-1.5"
          >
            <span className="w-6 font-mono text-xs text-[var(--fm-text-muted)]">
              P{idx + 1}
            </span>
            <Input
              aria-invalid={timeInvalid ? "true" : "false"}
              aria-label={`Waypoint ${idx + 1} time (ns)`}
              autoComplete="off"
              className="font-mono text-xs"
              inputMode="decimal"
              type="text"
              value={timeValue}
              onChange={(event) => {
                const nextText = event.target.value;
                const parsed = Number(nextText);
                const isValid = nextText.trim().length > 0 && Number.isFinite(parsed);
                const nextTimeS = isValid ? parsed * 1e-9 : pt.timeS;
                const nextExpectedNs = Number((nextTimeS * 1e9).toPrecision(6));
                const nextPoints = isValid
                  ? points.map((row) =>
                      row._rowId === pt._rowId ? { ...row, timeS: nextTimeS } : row,
                    )
                  : points;
                const nextCells = {
                  ...rawByCell,
                  [timeKey]: { expected: nextExpectedNs, text: nextText },
                };
                setRawByCell(nextCells);
                if (isValid) onChange(nextPoints);
                updateErrorState(nextCells, nextPoints);
              }}
            />
            <Input
              aria-invalid={scaleInvalid ? "true" : "false"}
              aria-label={`Waypoint ${idx + 1} scale`}
              autoComplete="off"
              className="font-mono text-xs"
              inputMode="decimal"
              type="text"
              value={scaleValue}
              onChange={(event) => {
                const nextText = event.target.value;
                const parsed = Number(nextText);
                const isValid = nextText.trim().length > 0 && Number.isFinite(parsed);
                const nextScale = isValid ? parsed : pt.scale;
                const nextPoints = isValid
                  ? points.map((row) =>
                      row._rowId === pt._rowId ? { ...row, scale: nextScale } : row,
                    )
                  : points;
                const nextCells = {
                  ...rawByCell,
                  [scaleKey]: { expected: nextScale, text: nextText },
                };
                setRawByCell(nextCells);
                if (isValid) onChange(nextPoints);
                updateErrorState(nextCells, nextPoints);
              }}
            />
            <Button
              aria-label={`Remove waypoint ${idx + 1}`}
              disabled={points.length <= 2}
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                const filtered = points.filter((row) => row._rowId !== pt._rowId);
                onChange(filtered);
                updateErrorState(rawByCell, filtered);
              }}
            >
              <Trash2 aria-hidden="true" size={12} />
            </Button>
          </div>
        );
      })}
      <div>
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => {
            const lastT = points[points.length - 1]?.timeS ?? 0;
            onChange([...points, createPiecewiseWaypoint(lastT + 0.5e-9, 0)]);
          }}
        >
          <Plus aria-hidden="true" size={12} />
          <span>Add waypoint</span>
        </Button>
      </div>
    </div>
  );
}
