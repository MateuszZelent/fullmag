"use client";

import { useMemo } from "react";

import { Activity, Eye, Play, RotateCw } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type {
  EigenBranch,
  EigenSpectrumPoint,
  FmrPeakPoint,
  FrequencyResponsePoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import { Button } from "@/shared/ui/Button";



function formatOptionalFrequency(valueHz: number | null): string {
  return valueHz == null ? "-" : formatFrequencyHz(valueHz);
}

function formatMHz(valueHz: number | null): string {
  return valueHz == null ? "-" : `${formatCompact(valueHz / 1e6)} MHz`;
}

function formatCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) {
    return value.toExponential(2);
  }
  return Number(value.toPrecision(4)).toLocaleString("en-US");
}

export type FrequencyDomainModeTableAction =
  | "inspect"
  | "phase_rotated_real"
  | "real"
  | "imag"
  | "abs"
  | "phase"
  | "animate";

export type FrequencyDomainResponsePointAction =
  | "phase_rotated_real"
  | "real"
  | "imag"
  | "abs"
  | "phase"
  | "animate";

const MODE_ACTIONS: readonly {
  action: FrequencyDomainModeTableAction;
  icon: LucideIcon;
  label: string;
  title: string;
}[] = [
  {
    action: "inspect",
    icon: Eye,
    label: "Select",
    title: "Select this eigen mode for inspector controls",
  },
  {
    action: "phase_rotated_real",
    icon: RotateCw,
    label: "Rotated",
    title: "Plot this eigen mode with phase-rotated real display",
  },
  {
    action: "real",
    icon: Activity,
    label: "Real",
    title: "Plot the real part of this eigen mode",
  },
  {
    action: "imag",
    icon: Activity,
    label: "Imag",
    title: "Plot the imaginary part of this eigen mode",
  },
  {
    action: "abs",
    icon: Activity,
    label: "Abs",
    title: "Plot the complex magnitude of this eigen mode",
  },
  {
    action: "phase",
    icon: RotateCw,
    label: "Phase",
    title: "Plot the phase of this eigen mode",
  },
  {
    action: "animate",
    icon: Play,
    label: "Animate",
    title: "Animate this eigen mode by advancing the phase",
  },
];

const RESPONSE_ACTIONS: readonly {
  action: FrequencyDomainResponsePointAction;
  icon: LucideIcon;
  label: string;
  title: string;
}[] = [
  {
    action: "phase_rotated_real",
    icon: RotateCw,
    label: "Rotated",
    title: "Plot this response field with phase-rotated real display",
  },
  {
    action: "real",
    icon: Activity,
    label: "Real",
    title: "Plot the real part of this response field",
  },
  {
    action: "imag",
    icon: Activity,
    label: "Imag",
    title: "Plot the imaginary part of this response field",
  },
  {
    action: "abs",
    icon: Activity,
    label: "Abs",
    title: "Plot the complex magnitude of this response field",
  },
  {
    action: "phase",
    icon: RotateCw,
    label: "Phase",
    title: "Plot the phase of this response field",
  },
  {
    action: "animate",
    icon: Play,
    label: "Animate",
    title: "Animate this response field by advancing the phase",
  },
];

export function FrequencyDomainModeTable({
  onPlotMode,
  points,
  selectedModeKey = null,
}: {
  onPlotMode: (
    point: EigenSpectrumPoint,
    action: FrequencyDomainModeTableAction,
  ) => void;
  points: readonly EigenSpectrumPoint[];
  selectedModeKey?: string | null;
}) {
  const rows = useMemo(
    () =>
      points.toSorted(
        (left, right) =>
          left.sampleIndex - right.sampleIndex ||
          left.frequencyHz - right.frequencyHz ||
          left.rawModeIndex - right.rawModeIndex,
      ),
    [points],
  );

  if (rows.length === 0) {
    return (
      <div className="fm-frequency-domain-table-empty" role="status">
        No eigen modes available for the mode table.
      </div>
    );
  }

  return (
    <div className="fm-frequency-domain-table-wrap">
      <table
        aria-label="Frequency-domain mode table"
        className="fm-frequency-domain-table"
      >
        <thead>
          <tr>
            <th className="fm-frequency-domain-table__selected-heading">
              Selected
            </th>
            <th>Sample</th>
            <th>Mode</th>
            <th>Branch</th>
            <th>Frequency</th>
            <th>Imag freq.</th>
            <th>Damping</th>
            <th>Residual</th>
            <th>Tangent leak</th>
            <th>Field</th>
            <th className="fm-frequency-domain-table__actions-heading">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((point) => {
            const modeKey = modeTablePointKey(point);
            const selected = selectedModeKey === modeKey;
            return (
              <tr
                aria-selected={selected}
                data-selected={selected ? "true" : "false"}
                data-status={point.modeFieldId ? "ready" : "missing"}
                key={modeKey}
              >
                <td className="fm-frequency-domain-table__selected-cell">
                  {selected ? "current" : "-"}
                </td>
                <td>{point.sampleIndex}</td>
                <td>{point.rawModeIndex}</td>
                <td>{point.branchId ?? "-"}</td>
                <td>{formatFrequencyHz(point.frequencyHz)}</td>
                <td>{formatOptionalFrequency(point.imaginaryFrequencyHz)}</td>
                <td>{formatMHz(point.dampingRateHz)}</td>
                <td>{formatCompact(point.residualNorm)}</td>
                <td>{formatCompact(point.tangentLeakageMax)}</td>
                <td>{point.modeFieldId ? "available" : "missing"}</td>
                <td className="fm-frequency-domain-table__actions">
                  {MODE_ACTIONS.map((entry) => {
                    const Icon = entry.icon;
                    const disabled = entry.action !== "inspect" && !point.modeFieldId;
                    return (
                      <Button
                        aria-label={`${entry.title} for sample ${point.sampleIndex} mode ${point.rawModeIndex}`}
                        className="fm-inspector-action-button"
                        disabled={disabled}
                        key={entry.action}
                        size="sm"
                        title={
                          disabled
                            ? "Mode field artifact is missing"
                            : entry.title
                        }
                        type="button"
                        variant={
                          entry.action === "phase_rotated_real"
                            ? "primary"
                            : "secondary"
                        }
                        onClick={() => onPlotMode(point, entry.action)}
                      >
                        <Icon size={13} aria-hidden="true" />
                        <span>{entry.label}</span>
                      </Button>
                    );
                  })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function modeTablePointKey(point: EigenSpectrumPoint): string {
  return `${point.sampleIndex}:${point.rawModeIndex}`;
}

export function FrequencyDomainResponsePointTable({
  onPlotResponsePoint,
  points,
}: {
  onPlotResponsePoint: (
    point: FrequencyResponsePoint,
    action: FrequencyDomainResponsePointAction,
  ) => void;
  points: readonly FrequencyResponsePoint[];
}) {
  const rows = useMemo(
    () => points.toSorted(
      (left, right) => left.frequencyHz - right.frequencyHz,
    ),
    [points],
  );

  if (rows.length === 0) {
    return (
      <div className="fm-frequency-domain-table-empty" role="status">
        No driven response frequency points available.
      </div>
    );
  }

  return (
    <div className="fm-frequency-domain-table-wrap">
      <table
        aria-label="Frequency-domain response point table"
        className="fm-frequency-domain-table"
      >
        <thead>
          <tr>
            <th>Index</th>
            <th>Observable</th>
            <th>Frequency</th>
            <th>Amplitude</th>
            <th>Phase</th>
            <th>Absorbed power</th>
            <th>Residual</th>
            <th>Field</th>
            <th className="fm-frequency-domain-table__actions-heading">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((point) => (
            <tr
              data-status={point.fieldId ? "ready" : "missing"}
              key={`${point.frequencyIndex ?? "raw"}:${point.observableId}:${point.frequencyHz}`}
            >
              <td>{point.frequencyIndex ?? "-"}</td>
              <td>{point.observableId}</td>
              <td>{formatFrequencyHz(point.frequencyHz)}</td>
              <td>{formatCompact(point.amplitude)}</td>
              <td>{formatCompact(point.phaseRad)}</td>
              <td>{formatCompact(point.absorbedPowerDensity)}</td>
              <td>{formatCompact(point.residualNorm)}</td>
              <td>{point.fieldId ? "available" : "missing"}</td>
              <td className="fm-frequency-domain-table__actions">
                {RESPONSE_ACTIONS.map((entry) => {
                  const Icon = entry.icon;
                  return (
                    <Button
                      aria-label={`${entry.title} at ${formatFrequencyHz(point.frequencyHz)}`}
                      className="fm-inspector-action-button"
                      disabled={!point.fieldId}
                      key={entry.action}
                      size="sm"
                      title={
                        point.fieldId
                          ? entry.title
                          : "Response field artifact is missing"
                      }
                      type="button"
                      variant={
                        entry.action === "phase_rotated_real"
                          ? "primary"
                          : "secondary"
                      }
                      onClick={() => onPlotResponsePoint(point, entry.action)}
                    >
                      <Icon size={13} aria-hidden="true" />
                      <span>{entry.label}</span>
                    </Button>
                  );
                })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FrequencyDomainBranchTable({
  branches,
  onSelectBranch,
  selectedBranchId = null,
}: {
  branches: readonly EigenBranch[];
  onSelectBranch?: (branch: EigenBranch) => void;
  selectedBranchId?: string | null;
}) {
  const rows = useMemo(
    () => branches.toSorted((left, right) =>
      left.branchId.localeCompare(right.branchId),
    ),
    [branches],
  );

  if (rows.length === 0) {
    return (
      <div className="fm-frequency-domain-table-empty" role="status">
        No eigen branches available.
      </div>
    );
  }

  return (
    <div className="fm-frequency-domain-table-wrap">
      <table
        aria-label="Frequency-domain branch table"
        className="fm-frequency-domain-table"
      >
        <thead>
          <tr>
            <th className="fm-frequency-domain-table__selected-heading">
              Selected
            </th>
            <th>Branch</th>
            <th>Label</th>
            <th>Points</th>
            <th>Samples</th>
            <th>Frequency range</th>
            <th>Min overlap</th>
            <th>Min confidence</th>
            <th className="fm-frequency-domain-table__actions-heading">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((branch) => {
            const selected = selectedBranchId === branch.branchId;
            return (
              <tr
                aria-selected={selected}
                data-selected={selected ? "true" : "false"}
                data-status="ready"
                key={branch.branchId}
              >
                <td className="fm-frequency-domain-table__selected-cell">
                  {selected ? "current" : "-"}
                </td>
                <td>{branch.branchId}</td>
                <td>{branch.label ?? "-"}</td>
                <td>{branch.points.length}</td>
                <td>
                  {branch.sampleMin != null && branch.sampleMax != null
                    ? `${branch.sampleMin}-${branch.sampleMax}`
                    : "-"}
                </td>
                <td>
                  {branch.frequencyMinHz != null && branch.frequencyMaxHz != null
                    ? `${formatFrequencyHz(branch.frequencyMinHz)}-${formatFrequencyHz(branch.frequencyMaxHz)}`
                    : "-"}
                </td>
                <td>{formatCompact(branch.overlapPrevMin)}</td>
                <td>{formatCompact(branch.trackingConfidenceMin)}</td>
                <td className="fm-frequency-domain-table__actions">
                  <Button
                    aria-label={`Select branch ${branch.branchId} for inspector controls`}
                    className="fm-inspector-action-button"
                    disabled={!onSelectBranch}
                    size="sm"
                    title={`Select branch ${branch.branchId} for inspector controls`}
                    type="button"
                    variant="secondary"
                    onClick={() => onSelectBranch?.(branch)}
                  >
                    <Eye aria-hidden="true" size={13} />
                    <span>Select</span>
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function FrequencyDomainFmrPeakTable({
  onPlotPeak,
  onSelectPeak,
  peaks,
}: {
  onPlotPeak: (peak: FmrPeakPoint) => void;
  onSelectPeak: (peak: FmrPeakPoint) => void;
  peaks: readonly FmrPeakPoint[];
}) {
  const rows = useMemo(
    () => peaks.toSorted((left, right) => left.frequencyHz - right.frequencyHz),
    [peaks],
  );

  if (rows.length === 0) {
    return (
      <div className="fm-frequency-domain-table-empty" role="status">
        No FMR peaks available.
      </div>
    );
  }

  return (
    <div className="fm-frequency-domain-table-wrap">
      <table
        aria-label="Frequency-domain FMR peak table"
        className="fm-frequency-domain-table"
      >
        <thead>
          <tr>
            <th>Source</th>
            <th>Frequency</th>
            <th>Mode / point</th>
            <th>Amplitude</th>
            <th>Phase</th>
            <th>Absorbed power</th>
            <th>Linewidth</th>
            <th>Q factor</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((peak) => (
            <tr
              data-status={peak.validationStatus}
              key={`${peak.source}:${peak.frequencyHz}:${peak.frequencyPointIndex ?? peak.modeRef?.rawModeIndex ?? "raw"}`}
            >
              <td>{peak.source}</td>
              <td>{formatFrequencyHz(peak.frequencyHz)}</td>
              <td>{formatPeakRef(peak)}</td>
              <td>{formatCompact(peak.amplitude)}</td>
              <td>{formatCompact(peak.phaseRad)}</td>
              <td>{formatCompact(peak.absorbedPowerDensity)}</td>
              <td>{formatMHz(peak.linewidthHz)}</td>
              <td>{formatQualityFactor(peak)}</td>
              <td>{peak.validationStatus}</td>
              <td>
                <div className="fm-frequency-domain-table__actions">
                  <Button
                    className="fm-inspector-action-button"
                    onClick={() => onSelectPeak(peak)}
                    size="sm"
                    title="Select this FMR peak for inspector controls"
                    type="button"
                    variant="secondary"
                  >
                    <Eye size={13} aria-hidden="true" />
                    <span>Select</span>
                  </Button>
                  <Button
                    className="fm-inspector-action-button"
                    disabled={!peak.fieldId}
                    onClick={() => onPlotPeak(peak)}
                    size="sm"
                    title={
                      peak.fieldId
                        ? "Plot this FMR peak field in 3D"
                        : "The 3D field artifact for this FMR peak is missing"
                    }
                    type="button"
                    variant="primary"
                  >
                    <Activity size={13} aria-hidden="true" />
                    <span>Plot 3D</span>
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatPeakRef(peak: FmrPeakPoint): string {
  if (peak.modeRef) {
    return `sample ${peak.modeRef.sampleIndex}, mode ${peak.modeRef.rawModeIndex}`;
  }
  if (peak.frequencyPointIndex != null) {
    return `frequency point ${peak.frequencyPointIndex}`;
  }
  return "-";
}

function formatQualityFactor(peak: FmrPeakPoint): string {
  if (
    peak.linewidthHz == null ||
    peak.linewidthHz <= 0 ||
    !Number.isFinite(peak.linewidthHz)
  ) {
    return "not available";
  }
  return formatCompact(peak.frequencyHz / peak.linewidthHz);
}
