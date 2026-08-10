"use client";

import type { InspectorPanelProps } from "../inspectorTypes";
import { InspectorGroup } from "../primitives/InspectorGroup";
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
import {
  readEigenBranchesPayload,
  readEigenDispersionPayload,
  readEigenSpectrumPayload,
} from "@/shared/domain/analysis/frequencyDomainChartModels";

type SpectrumResource = ReturnType<typeof useFrequencyDomainEigenSpectrumResource>;
type BranchesResource = ReturnType<typeof useFrequencyDomainEigenBranchesResource>;

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
  const spectrumData = readEigenSpectrumPayload(spectrum.data?.payload);
  const branchesData = readEigenBranchesPayload(branches.data?.payload);
  const dispersionData = readEigenDispersionPayload(dispersion.data);
  const modeFieldCount =
    spectrumData?.modes.filter((mode) => Boolean(mode.modeFieldId)).length ?? 0;

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

  const showSpectrumTable = isExactFrequencyDomainKind(
    kind,
    "results.eigen.spectrum",
    "resources.analysis.eigen.spectrum",
    "results.frequency_domain.fmr_modal_spectrum",
    "results.frequency_domain.fmr",
  );

  const selectedEigenBranch = branchesData?.branches?.find(
    (branch) => branch.branchId === selectedEigenBranchId,
  );

  return (
    <>
      {showModalSolver ? (
        <InspectorGroup title="Modal Eigen Solver" badge={data?.eigenmodes.status ?? "unknown"}>
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
        </InspectorGroup>
      ) : null}

      {showPlotReadiness ? (
        <InspectorGroup title="Plot Readiness" badge="manifest-driven">
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
            value={
              modeFieldCount > 0
                ? `${modeFieldCount} mode-field payload(s) ready`
                : "waiting for mode-field artifacts"
            }
          />
        </InspectorGroup>
      ) : null}

      {showKPath ? (
        <InspectorGroup title="Bloch k-Path Parameters" badge={dispersion.status}>
          <FieldRow
            label="Reciprocal path"
            value={
              dispersionData
                ? String(dispersionData.kPath.length)
                : "not loaded"
            }
          />
          <FieldRow
            label="k-point count"
            value={
              dispersionData
                ? String(dispersionData.kPoints.length)
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
                {branchesData?.branches.map((branch) => (
                  <option key={branch.branchId} value={branch.branchId}>
                    {branch.branchId} ({branch.modes.length} modes)
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
                value={`${formatScalar(selectedEigenBranch.minFrequencyHz, " Hz")} to ${formatScalar(selectedEigenBranch.maxFrequencyHz, " Hz")}`}
              />
            </>
          ) : null}
        </InspectorGroup>
      ) : null}

      {showSpectrumTable && spectrumData?.modes && spectrumData.modes.length > 0 ? (
        <InspectorGroup title="Modal Spectrum" badge={spectrum.status}>
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
                {spectrumData.modes.map((mode) => {
                  const key = modePointKey({
                    rawModeIndex: mode.rawModeIndex,
                    sampleIndex: mode.sampleIndex,
                  });
                  const isSelected = key === selectedSpectrumModeKey;
                  return (
                    <tr key={key} data-selected={isSelected ? "true" : undefined}>
                      <td>{mode.displayModeIndex}</td>
                      <td>{formatScalar(mode.frequencyHz, " Hz")}</td>
                      <td>{formatScalar(mode.dampingRateHz)}</td>
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
        </InspectorGroup>
      ) : null}

    </>
  );
}
export default FrequencyDomainEigenSection;
