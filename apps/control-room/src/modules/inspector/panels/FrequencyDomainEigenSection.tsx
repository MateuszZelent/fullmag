"use client";

import type { InspectorPanelProps } from "../inspectorTypes";
import { InspectorSection } from "../primitives/InspectorSection";
import { FieldRow } from "../primitives/FieldRow";
import { Button } from "@/shared/ui/Button";
import {
  formatBoolean,
  formatScalar,
  isExactFrequencyDomainKind,
  modePointKey,
} from "./frequency-domain/FrequencyDomainHelpers";
import type { FrequencyDomainInspectorState } from "./FrequencyDomainInspectorPanel";
import {
  useFrequencyDomainEigenBranchesResource,
  useFrequencyDomainEigenDispersionResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainManifestResource,
} from "@/kernel/resources/studyRuntimeResources";

type SpectrumResource = ReturnType<typeof useFrequencyDomainEigenSpectrumResource>;
type BranchesResource = ReturnType<typeof useFrequencyDomainEigenBranchesResource>;
type SpectrumMode = {
  damping_factor?: number | null;
  frequency_hz?: number | null;
  mode_index: number;
  sample_index?: number;
};
type EigenBranch = {
  branch_id: string;
  max_frequency_hz?: number | null;
  min_frequency_hz?: number | null;
  modes?: readonly unknown[];
};
type SpectrumData = { modes?: SpectrumMode[]; status?: string };
type BranchesData = { branches?: EigenBranch[] };
type DispersionData = { k_path?: readonly unknown[]; k_points?: readonly unknown[] };

interface FrequencyDomainEigenSectionProps {
  selection: InspectorPanelProps["selection"];
  inspectorState: FrequencyDomainInspectorState;
  setInspectorState: (patch: Partial<FrequencyDomainInspectorState>) => void;
  data: ReturnType<typeof useFrequencyDomainManifestResource>["data"];
  spectrum: SpectrumResource;
  branches: BranchesResource;
  dispersion: ReturnType<typeof useFrequencyDomainEigenDispersionResource>;
}

export function FrequencyDomainEigenSection({
  selection,
  inspectorState,
  setInspectorState,
  data,
  spectrum,
  branches,
  dispersion,
}: FrequencyDomainEigenSectionProps) {
  const kind = selection.kind ?? "";
  const { selectedEigenBranchId, selectedSpectrumModeKey } = inspectorState;
  const spectrumData = spectrum.data as unknown as SpectrumData | null;
  const branchesData = branches.data as unknown as BranchesData | null;
  const dispersionData = dispersion.data as unknown as DispersionData | null;

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

  const selectedEigenBranch = branchesData?.branches?.find(
    (branch: EigenBranch) => branch.branch_id === selectedEigenBranchId,
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
            value={
              dispersionData
                ? String(dispersionData.k_path?.length ?? 0)
                : "not loaded"
            }
          />
          <FieldRow
            label="k-point count"
            value={
              dispersionData
                ? String(dispersionData.k_points?.length ?? 0)
                : "not loaded"
            }
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
                {branchesData?.branches?.map((branch: EigenBranch) => (
                  <option key={branch.branch_id} value={branch.branch_id}>
                    {branch.branch_id} ({branch.modes?.length ?? 0} modes)
                  </option>
                ))}
              </select>
            }
          />
          {selectedEigenBranch ? (
            <>
              <FieldRow label="Branch modes" value={String(selectedEigenBranch.modes?.length ?? 0)} />
              <FieldRow
                label="Branch frequency"
                value={`${formatScalar(selectedEigenBranch.min_frequency_hz, " Hz")} to ${formatScalar(selectedEigenBranch.max_frequency_hz, " Hz")}`}
              />
            </>
          ) : null}
        </InspectorSection>
      ) : null}

      {spectrumData?.modes && spectrumData.modes.length > 0 ? (
        <InspectorSection title="Modal Spectrum" badge={spectrumData.status ?? spectrum.status}>
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
                {spectrumData.modes.map((mode: SpectrumMode) => {
                  const key = modePointKey({
                    rawModeIndex: mode.mode_index,
                    sampleIndex: mode.sample_index ?? 0,
                  });
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

    </>
  );
}
export default FrequencyDomainEigenSection;
