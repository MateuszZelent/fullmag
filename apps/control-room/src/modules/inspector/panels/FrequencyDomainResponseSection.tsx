"use client";

import React from "react";
import { type InspectorPanelProps } from "../inspectorRegistry";
import { InspectorSection } from "../primitives/InspectorSection";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { Button } from "@/shared/ui/Button";
import { Activity } from "lucide-react";
import {
  formatBoolean,
  formatRecordField,
  formatScalar,
  isFrequencyDomainKind,
  fmrPeakKey,
  fmrPeakLabel,
} from "./frequency-domain/FrequencyDomainHelpers";

interface FrequencyDomainResponseSectionProps {
  selection: InspectorPanelProps["selection"];
  inspectorState: any;
  setInspectorState: (patch: any) => void;
  data: any;
  responseSweep: any;
  responseProgress: any;
  responseCancelRequested: any;
  manifestPhysics: any;
}

export function FrequencyDomainResponseSection({
  selection,
  inspectorState,
  setInspectorState,
  data,
  responseSweep,
  responseProgress,
  responseCancelRequested,
  manifestPhysics,
}: FrequencyDomainResponseSectionProps) {
  const { kind } = selection;
  const { selectedFmrPeakKey } = inspectorState;

  const showResponseSolver = isFrequencyDomainKind(
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

  const showExcitationWorkflow = isFrequencyDomainKind(
    kind,
    "study.stage.frequency_response.excitation",
    "study.stage.frequency_response.setup",
  );

  const showFrequencySweepWorkflow = isFrequencyDomainKind(
    kind,
    "study.stage.frequency_response.frequency_sweep",
    "study.stage.frequency_response.setup",
  );

  const showFmrSpectrumWorkbench = isFrequencyDomainKind(
    kind,
    "results.frequency_domain.fmr",
    "results.frequency_domain.fmr_response_sweep",
    "results.frequency_domain.response_map",
    "results.frequency_domain.comparison",
  );

  const excitation = data?.response.excitation ?? {};
  const frequencySweep = data?.response.frequency_sweep ?? {};

  const peaks = responseSweep?.data?.peaks ?? [];
  const selectedFmrPeak = peaks.find(
    (peak: any) => fmrPeakKey(peak) === selectedFmrPeakKey,
  );

  return (
    <>
      {showResponseSolver ? (
        <InspectorSection title="Driven Response Solver" badge={data?.response.status ?? "unknown"}>
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
        </InspectorSection>
      ) : null}

      {showExcitationWorkflow ? (
        <InspectorSection title="Excitation Workflow" badge="stage draft">
          <FieldRow label="Excitation model" value={excitation.model ?? "not configured"} />
          <FieldRow label="Excitation orientation" value={excitation.orientation ?? "not configured"} />
          <FormField
            disabled
            label="Excitation amplitude"
            value={excitation.amplitude != null ? String(excitation.amplitude) : "not configured"}
          />
        </InspectorSection>
      ) : null}

      {showFrequencySweepWorkflow ? (
        <InspectorSection title="Frequency Sweep Workflow" badge="stage draft">
          <FieldRow label="Sweep mode" value={frequencySweep.mode ?? "not configured"} />
          {frequencySweep.mode === "sweep" ? (
            <>
              <FieldRow
                label="Start frequency"
                value={formatScalar(frequencySweep.start_frequency_hz, " Hz")}
              />
              <FieldRow
                label="Stop frequency"
                value={formatScalar(frequencySweep.stop_frequency_hz, " Hz")}
              />
              <FieldRow label="Steps" value={String(frequencySweep.steps ?? 0)} />
            </>
          ) : (
            <FieldRow label="Frequencies" value={String(frequencySweep.frequencies?.length ?? 0)} />
          )}
        </InspectorSection>
      ) : null}

      {showFmrSpectrumWorkbench && (
        <InspectorSection title="FMR Spectrum Workbench" badge="active">
          <FieldRow label="FMR Status" value={responseSweep.status} />
          {selectedFmrPeak ? (
            <>
              <FieldRow label="Peak Frequency" value={formatScalar(selectedFmrPeak.frequency_hz, " Hz")} />
              <FieldRow label="Peak Amplitude" value={formatScalar(selectedFmrPeak.amplitude)} />
            </>
          ) : null}
        </InspectorSection>
      )}

      {peaks.length > 0 ? (
        <InspectorSection title="FMR Peaks" badge={peaks.length > 0 ? "ready" : "missing"}>
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
                {peaks.map((peak: any, index: number) => {
                  const key = fmrPeakKey(peak);
                  const isSelected = key === selectedFmrPeakKey;
                  return (
                    <tr key={key} data-selected={isSelected ? "true" : undefined}>
                      <td>{index + 1}</td>
                      <td>{formatScalar(peak.frequency_hz, " Hz")}</td>
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
        </InspectorSection>
      ) : null}

      {responseSweep.data && (
        <InspectorSection title="Driven Response Chart" badge={responseSweep.data?.status ?? responseSweep.status}>
          <div className="fm-frequency-domain-chart">
            <div className="fm-frequency-domain-chart__header">
              <span>Driven Response</span>
              <small>{responseSweep.data.frequencies?.length ?? 0} points</small>
            </div>
            <div className="fm-frequency-domain-chart__canvas">
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <Activity className="mr-2 animate-pulse" size={16} />
                Driven response curves plotted.
              </div>
            </div>
          </div>
        </InspectorSection>
      )}
    </>
  );
}
export default FrequencyDomainResponseSection;
