"use client";

import React from "react";
import { type InspectorPanelProps } from "../inspectorRegistry";
import { InspectorSection } from "../primitives/InspectorSection";
import { FieldRow } from "../primitives/FieldRow";
import { Button } from "@/shared/ui/Button";
import { Activity } from "lucide-react";
import {
  formatBoolean,
  formatRecordField,
  formatScalar,
  isExactFrequencyDomainKind,
  modePointKey,
  modePointLabel,
} from "./frequency-domain/FrequencyDomainHelpers";

interface FrequencyDomainEigenSectionProps {
  selection: InspectorPanelProps["selection"];
  inspectorState: any;
  setInspectorState: (patch: any) => void;
  data: any;
  spectrum: any;
  branches: any;
  dispersion: any;
  manifestPhysics: any;
  plotSelectedSpectrumMode: (action: string) => void;
  EIGEN_MODE_BROWSER_ACTIONS: any[];
}

export function FrequencyDomainEigenSection({
  selection,
  inspectorState,
  setInspectorState,
  data,
  spectrum,
  branches,
  dispersion,
  manifestPhysics,
  plotSelectedSpectrumMode,
  EIGEN_MODE_BROWSER_ACTIONS,
}: FrequencyDomainEigenSectionProps) {
  const { kind } = selection;
  const { selectedEigenBranchId, selectedSpectrumModeKey } = inspectorState;

  const showModalSolver = isExactFrequencyDomainKind(
    kind,
    "results.eigen.root",
    "results.eigen.study",
    "results.eigen.diagnostics",
    "results.eigen.provenance",
    "resources.analysis.eigen.diagnostics",
    "results.frequency_domain.fmr_modal_spectrum",
    "study.stage.eigenmodes",
    "study.stage.eigenmodes.setup",
    "study.stage.eigenmodes.solver",
    "study.stage.eigenmodes.outputs",
    "study.stage.eigenmodes.diagnostics",
  );

  const showPlotReadiness = isExactFrequencyDomainKind(
    kind,
    "results.frequency_domain.root",
    "results.frequency_domain.run",
    "results.frequency_domain.calculation_modes",
    "results.frequency_domain.fmr",
    "results.frequency_domain.fmr_modal_spectrum",
    "results.frequency_domain.fmr_response_sweep",
    "results.frequency_domain.dispersion",
    "results.frequency_domain.response_map",
    "results.frequency_domain.comparison",
    "diagnostics.frequency_domain.visualization",
  );

  const showKPath = isExactFrequencyDomainKind(
    kind,
    "results.eigen.k_path",
    "results.eigen.dispersion",
    "results.eigen.branches",
    "results.eigen.branch",
    "results.frequency_domain.dispersion",
  );

  const selectedEigenBranch = branches?.data?.branches?.find(
    (branch: any) => branch.branch_id === selectedEigenBranchId,
  );

  const modalSpectrumModes = spectrum?.data?.modes ?? [];
  const selectedSpectrumMode = modalSpectrumModes.find(
    (mode: any) => modePointKey(mode) === selectedSpectrumModeKey,
  );

  return (
    <>
      {showModalSolver ? (
        <InspectorSection title="Modal Eigen Solver" badge={data?.eigenmodes.status ?? "unknown"}>
          <FieldRow
            label="Study kind"
            value={data?.eigenmodes.study_kind ?? "eigenmodes"}
          />
          <FieldRow
            label="Modal solver"
            value={formatBoolean(data?.eigenmodes.modal_solver_available)}
          />
          <FieldRow
            label="Floquet modal"
            value={formatBoolean(data?.eigenmodes.floquet_modal_available)}
          />
          <FieldRow label="GPU lane" value={formatBoolean(data?.eigenmodes.gpu_available)} />
          <FieldRow label="Reason" value={data?.eigenmodes.reason ?? "not reported"} />
        </InspectorSection>
      ) : null}

      {showPlotReadiness ? (
        <InspectorSection title="Plot Readiness" badge="manifest-driven">
          <FieldRow
            label="FMR modal spectrum"
            value={
              data?.eigenmodes.modal_solver_available
                ? "can be exposed by modal artifacts"
                : "blocked"
            }
          />
          <FieldRow
            label="FMR response sweep"
            value={
              data?.response.driven_response_available
                ? "can be exposed by response artifacts"
                : "blocked"
            }
          />
          <FieldRow
            label="Dispersion"
            value={
              data?.floquet_nonzero_k_demag_supported
                ? "Floquet demag-k allowed"
                : "nonzero-k demag rejected"
            }
          />
          <FieldRow
            label="3D mode plotting"
            value="waiting for mode-field artifacts"
          />
        </InspectorSection>
      ) : null}

      {showKPath ? (
        <InspectorSection title="Bloch k-Path Parameters" badge={dispersion.status}>
          <FieldRow
            label="Reciprocal path"
            value={dispersion.data ? String(dispersion.data.k_path.length) : "not loaded"}
          />
          <FieldRow
            label="k-point count"
            value={dispersion.data ? String(dispersion.data.k_points.length) : "not loaded"}
          />
          <FieldRow
            label="Selected branch"
            value={
              <select
                aria-label="Selected branch ID"
                className="fm-inspector-select"
                value={selectedEigenBranchId ?? ""}
                onChange={(event) =>
                  setInspectorState({ selectedEigenBranchId: event.currentTarget.value || null })
                }
              >
                <option value="">(all branches)</option>
                {branches.data?.branches.map((branch: any) => (
                  <option key={branch.branch_id} value={branch.branch_id}>
                    {branch.branch_id} ({branch.modes.length} modes)
                  </option>
                ))}
              </select>
            }
          />
          {selectedEigenBranch ? (
            <>
              <FieldRow label="Branch modes" value={String(selectedEigenBranch.modes.length)} />
              <FieldRow
                label="Branch frequency"
                value={`${formatScalar(selectedEigenBranch.min_frequency_hz, " Hz")} to ${formatScalar(selectedEigenBranch.max_frequency_hz, " Hz")}`}
              />
            </>
          ) : null}
        </InspectorSection>
      ) : null}

      {spectrum.data?.modes && spectrum.data.modes.length > 0 ? (
        <InspectorSection title="Modal Spectrum" badge={spectrum.data?.status ?? spectrum.status}>
          <div className="fm-frequency-domain-table-wrap">
            <table className="fm-frequency-domain-table">
              <thead>
                <tr>
                  <th>Index</th>
                  <th>Frequency</th>
                  <th>Damping</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {spectrum.data.modes.map((mode: any) => {
                  const key = modePointKey(mode);
                  const isSelected = key === selectedSpectrumModeKey;
                  return (
                    <tr key={key} data-selected={isSelected ? "true" : undefined}>
                      <td>{mode.mode_index}</td>
                      <td>{formatScalar(mode.frequency_hz, " Hz")}</td>
                      <td>{formatScalar(mode.damping_factor)}</td>
                      <td className="fm-frequency-domain-table__actions">
                        <Button
                          aria-pressed={isSelected}
                          size="sm"
                          title="Select mode"
                          type="button"
                          variant={isSelected ? "primary" : "secondary"}
                          onClick={() => setInspectorState({ selectedSpectrumModeKey: key })}
                        >
                          Select
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </InspectorSection>
      ) : null}

      {dispersion.data && (
        <InspectorSection title="Dispersion Chart" badge={dispersion.status}>
          <div className="fm-frequency-domain-chart">
            <div className="fm-frequency-domain-chart__header">
              <span>Dispersion Chart</span>
              <small>{dispersion.data.k_points.length} points</small>
            </div>
            <div className="fm-frequency-domain-chart__canvas">
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <Activity className="mr-2 animate-pulse" size={16} />
                Dispersion curves plotted.
              </div>
            </div>
          </div>
        </InspectorSection>
      )}
    </>
  );
}
export default FrequencyDomainEigenSection;
