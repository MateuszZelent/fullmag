"use client";

import type {
  EigenBranch,
  EigenSpectrumPoint,
  FmrPeakPoint,
  FrequencyResponsePoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";

function formatFrequency(valueHz: number): string {
  const abs = Math.abs(valueHz);
  if (abs >= 1e9) return `${formatCompact(valueHz / 1e9)} GHz`;
  if (abs >= 1e6) return `${formatCompact(valueHz / 1e6)} MHz`;
  return `${formatCompact(valueHz)} Hz`;
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
  label: string;
  title: string;
}[] = [
  {
    action: "inspect",
    label: "Select",
    title: "Select this eigen mode for inspector controls",
  },
  {
    action: "phase_rotated_real",
    label: "Plot rotated",
    title: "Plot this eigen mode with phase-rotated real display",
  },
  {
    action: "real",
    label: "Plot real",
    title: "Plot the real part of this eigen mode",
  },
  {
    action: "imag",
    label: "Plot imag",
    title: "Plot the imaginary part of this eigen mode",
  },
  {
    action: "abs",
    label: "Plot abs",
    title: "Plot the complex magnitude of this eigen mode",
  },
  {
    action: "phase",
    label: "Plot phase",
    title: "Plot the phase of this eigen mode",
  },
  {
    action: "animate",
    label: "Animate",
    title: "Animate this eigen mode by advancing the phase",
  },
];

const RESPONSE_ACTIONS: readonly {
  action: FrequencyDomainResponsePointAction;
  label: string;
  title: string;
}[] = [
  {
    action: "phase_rotated_real",
    label: "Plot rotated",
    title: "Plot this response field with phase-rotated real display",
  },
  {
    action: "real",
    label: "Plot real",
    title: "Plot the real part of this response field",
  },
  {
    action: "imag",
    label: "Plot imag",
    title: "Plot the imaginary part of this response field",
  },
  {
    action: "abs",
    label: "Plot abs",
    title: "Plot the complex magnitude of this response field",
  },
  {
    action: "phase",
    label: "Plot phase",
    title: "Plot the phase of this response field",
  },
  {
    action: "animate",
    label: "Animate",
    title: "Animate this response field by advancing the phase",
  },
];

export function FrequencyDomainModeTable({
  onPlotMode,
  points,
}: {
  onPlotMode: (
    point: EigenSpectrumPoint,
    action: FrequencyDomainModeTableAction,
  ) => void;
  points: readonly EigenSpectrumPoint[];
}) {
  const rows = [...points].sort(
    (left, right) =>
      left.sampleIndex - right.sampleIndex ||
      left.frequencyHz - right.frequencyHz ||
      left.rawModeIndex - right.rawModeIndex,
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
            <th>Sample</th>
            <th>Mode</th>
            <th>Branch</th>
            <th>Frequency</th>
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
          {rows.map((point) => (
            <tr
              data-status={point.modeFieldId ? "ready" : "missing"}
              key={`${point.sampleIndex}:${point.rawModeIndex}`}
            >
              <td>{point.sampleIndex}</td>
              <td>{point.rawModeIndex}</td>
              <td>{point.branchId ?? "-"}</td>
              <td>{formatFrequency(point.frequencyHz)}</td>
              <td>{formatMHz(point.dampingRateHz)}</td>
              <td>{formatCompact(point.residualNorm)}</td>
              <td>{formatCompact(point.tangentLeakageMax)}</td>
              <td>{point.modeFieldId ? "available" : "missing"}</td>
              <td className="fm-frequency-domain-table__actions">
                {MODE_ACTIONS.map((entry) => (
                  <button
                    className="fm-inspector-action-button"
                    disabled={entry.action !== "inspect" && !point.modeFieldId}
                    key={entry.action}
                    title={
                      point.modeFieldId || entry.action === "inspect"
                        ? entry.title
                        : "Mode field artifact is missing"
                    }
                    type="button"
                    onClick={() => onPlotMode(point, entry.action)}
                  >
                    {entry.label}
                  </button>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
  const rows = [...points].sort(
    (left, right) => left.frequencyHz - right.frequencyHz,
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
              <td>{formatFrequency(point.frequencyHz)}</td>
              <td>{formatCompact(point.amplitude)}</td>
              <td>{formatCompact(point.phaseRad)}</td>
              <td>{formatCompact(point.absorbedPowerDensity)}</td>
              <td>{formatCompact(point.residualNorm)}</td>
              <td>{point.fieldId ? "available" : "missing"}</td>
              <td className="fm-frequency-domain-table__actions">
                {RESPONSE_ACTIONS.map((entry) => (
                  <button
                    className="fm-inspector-action-button"
                    disabled={!point.fieldId}
                    key={entry.action}
                    title={
                      point.fieldId
                        ? entry.title
                        : "Response field artifact is missing"
                    }
                    type="button"
                    onClick={() => onPlotResponsePoint(point, entry.action)}
                  >
                    {entry.label}
                  </button>
                ))}
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
}: {
  branches: readonly EigenBranch[];
}) {
  const rows = [...branches].sort((left, right) =>
    left.branchId.localeCompare(right.branchId),
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
            <th>Branch</th>
            <th>Label</th>
            <th>Points</th>
            <th>Samples</th>
            <th>Frequency range</th>
            <th>Min overlap</th>
            <th>Min confidence</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((branch) => (
            <tr data-status="ready" key={branch.branchId}>
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
                  ? `${formatFrequency(branch.frequencyMinHz)}-${formatFrequency(branch.frequencyMaxHz)}`
                  : "-"}
              </td>
              <td>{formatCompact(branch.overlapPrevMin)}</td>
              <td>{formatCompact(branch.trackingConfidenceMin)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FrequencyDomainFmrPeakTable({
  peaks,
}: {
  peaks: readonly FmrPeakPoint[];
}) {
  const rows = [...peaks].sort((left, right) => left.frequencyHz - right.frequencyHz);

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
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((peak) => (
            <tr
              data-status={peak.validationStatus}
              key={`${peak.source}:${peak.frequencyHz}:${peak.frequencyPointIndex ?? peak.modeRef?.rawModeIndex ?? "raw"}`}
            >
              <td>{peak.source}</td>
              <td>{formatFrequency(peak.frequencyHz)}</td>
              <td>{formatPeakRef(peak)}</td>
              <td>{formatCompact(peak.amplitude)}</td>
              <td>{formatCompact(peak.phaseRad)}</td>
              <td>{formatCompact(peak.absorbedPowerDensity)}</td>
              <td>{formatMHz(peak.linewidthHz)}</td>
              <td>{peak.validationStatus}</td>
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
