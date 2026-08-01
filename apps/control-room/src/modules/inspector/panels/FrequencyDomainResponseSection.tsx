"use client";

import type { InspectorPanelProps } from "../inspectorTypes";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { FieldRow } from "../primitives/FieldRow";
import { Button } from "@/shared/ui/Button";
import {
  formatBoolean,
  formatScalar,
  isExactFrequencyDomainKind,
  fmrPeakKey,
} from "./frequency-domain/FrequencyDomainHelpers";
import type { FrequencyDomainInspectorState } from "./FrequencyDomainInspectorPanel";
import {
  useFrequencyDomainManifestResource,
  useFrequencyDomainResponseSweepResource,
} from "@/kernel/resources/studyRuntimeResources";
import type { FmrPeakPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";

type ResponseSweepResource = ReturnType<typeof useFrequencyDomainResponseSweepResource>;
type ResponseSweepData = {
  frequencies?: readonly unknown[];
  peaks?: FmrPeakPoint[];
  status?: string;
};

interface FrequencyDomainResponseSectionProps {
  selection: InspectorPanelProps["selection"];
  inspectorState: FrequencyDomainInspectorState;
  setInspectorState: (patch: Partial<FrequencyDomainInspectorState>) => void;
  data: ReturnType<typeof useFrequencyDomainManifestResource>["data"];
  responseSweep: ResponseSweepResource;
}

export function FrequencyDomainResponseSection({
  selection,
  inspectorState,
  setInspectorState,
  data,
  responseSweep,
}: FrequencyDomainResponseSectionProps) {
  const kind = selection.kind ?? "";
  const { selectedFmrPeakKey } = inspectorState;
  const responseSweepData = responseSweep.data as unknown as ResponseSweepData | null;

  const showResponseSolver = isExactFrequencyDomainKind(
    kind,
    "results.frequency_response.root",
    "results.frequency_response.study",
    "results.frequency_response.provenance",
    "results.frequency_response.sweep",
    "results.frequency_response.frequency_points",
    "results.frequency_response.frequency_point",
    "results.frequency_response.observables",
    "results.frequency_response.observable",
    "resources.analysis.frequency_response.sweep",
    "resources.analysis.frequency_response.frequency_point",
    "resources.analysis.frequency_response.field",
    "resources.analysis.frequency_response.observables",
    "resources.analysis.frequency_response.diagnostics",
    "jobs.frequency_domain.response_frequency",
    "diagnostics.frequency_domain.periodic_floquet",
    "study.stage.frequency_response",
    "study.stage.frequency_response.setup",
    "study.stage.frequency_response.solver",
    "study.stage.frequency_response.outputs",
    "study.stage.frequency_response.diagnostics",
  );

  const showFmrSpectrumWorkbench = isExactFrequencyDomainKind(
    kind,
    "results.frequency_domain.fmr",
    "results.frequency_domain.fmr_response_sweep",
    "results.frequency_domain.response_map",
    "results.frequency_domain.comparison",
  );
  const peaks = responseSweepData?.peaks ?? [];
  const selectedFmrPeak = peaks.find(
    (peak: FmrPeakPoint) => fmrPeakKey(peak) === selectedFmrPeakKey,
  );

  return (
    <>
      {showResponseSolver ? (
        <InspectorGroup title="Driven Response Solver" badge={data?.response.status ?? "unknown"}>
          <FieldRow
            label="Study kind"
            value={data?.response.study_kind ?? "frequency_response"}
          />
          <FieldRow
            label="Driven response"
            value={formatBoolean(data?.response.driven_response_available)}
          />
          <FieldRow label="GPU lane" value={formatBoolean(data?.response.gpu_available)} />
          <FieldRow label="Reason" value={data?.response.reason ?? "not reported"} />
        </InspectorGroup>
      ) : null}

      {showFmrSpectrumWorkbench && (
        <InspectorGroup title="FMR Spectrum Workbench" badge="active">
          <FieldRow label="FMR Status" value={responseSweep.status} />
          {selectedFmrPeak ? (
            <>
              <FieldRow label="Peak Frequency" value={formatScalar(selectedFmrPeak.frequencyHz, " Hz")} />
              <FieldRow label="Peak Amplitude" value={formatScalar(selectedFmrPeak.amplitude)} />
            </>
          ) : null}
        </InspectorGroup>
      )}

      {peaks.length > 0 ? (
        <InspectorGroup title="FMR Peaks" badge={peaks.length > 0 ? "ready" : "missing"}>
          <div className="fm-frequency-domain-table-wrap">
            <table className="fm-frequency-domain-table">
              <thead>
                <tr>
                  <th>Peak #</th>
                  <th>Frequency</th>
                  <th>Amplitude</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {peaks.map((peak: FmrPeakPoint, index: number) => {
                  const key = fmrPeakKey(peak);
                  const isSelected = key === selectedFmrPeakKey;
                  return (
                    <tr key={key} data-selected={isSelected ? "true" : undefined}>
                      <td>{index + 1}</td>
                      <td>{formatScalar(peak.frequencyHz, " Hz")}</td>
                      <td>{formatScalar(peak.amplitude)}</td>
                      <td className="fm-frequency-domain-table__actions">
                        <Button
                          aria-pressed={isSelected}
                          size="sm"
                          title="Select peak"
                          type="button"
                          variant={isSelected ? "primary" : "secondary"}
                          onClick={() => setInspectorState({ selectedFmrPeakKey: key })}
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
export default FrequencyDomainResponseSection;
