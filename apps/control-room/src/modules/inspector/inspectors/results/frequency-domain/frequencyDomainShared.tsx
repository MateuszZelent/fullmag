"use client";

import { modalResultModeNodeId, modalSpectrumMatchesSelection } from "@/shared/domain/analysis/modalResultNodeIdentity";
import { EmptyState } from "@/shared/ui/EmptyState";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import { Activity, Eye } from "lucide-react";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { useRenderableAnalysisFieldOverlay } from "@/kernel/visualization/AnalysisFieldOverlayController";
import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
} from "@/kernel/api/apiPaths";
import {
  buildEigenModeSelectionRef,
  eigenModeFieldAvailable,
  type EigenSpectrumPoint,
  type FmrModalDrivenComparisonPoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { Button } from "@/shared/ui/Button";
import type { FrequencyDomainCalculationModeRow } from "../../../panels/frequencyDomainInspectorModel";
import { useEigenSpectrumSummary } from "../../../panels/frequency-domain/frequencyDomainEigenFmrSummaries";
import {
  formatFmrModalPairLabel,
  formatFmrDrivenPairLabel,
  formatFmrPairFieldHandoff,
  formatFrequency,
} from "../../../panels/frequency-domain/frequencyDomainResultFormatting";

export function CalculationModeTable({
  activeMode,
  rows,
}: {
  activeMode: string;
  rows: readonly FrequencyDomainCalculationModeRow[];
}) {
  return (
    <div className="fm-frequency-domain-table-wrap">
      <table
        aria-label="Frequency-domain calculation mode table"
        className="fm-frequency-domain-table"
      >
        <thead>
          <tr>
            <th>Mode</th>
            <th>Canonical study</th>
            <th>Boundary / k</th>
            <th>Excitation / sweep</th>
            <th>Artifacts</th>
            <th>Capability</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.mode}>
              <td>
                {row.mode}
                {row.mode === activeMode ? " (active)" : ""}
              </td>
              <td>{row.canonicalStudy}</td>
              <td>
                {row.boundaryPreset}; {row.kRequirement}
              </td>
              <td>
                {row.excitationRequirement}; {row.sweepRequirement}
              </td>
              <td>{row.artifacts}</td>
              <td>{row.capabilityStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CalculationModeActions() {
  const kernel = useKernel();
  const openResult = (
    kind: string,
    label: string,
    nodeId: string,
    resourceRef: string,
  ): void => {
    kernel.selection.set(
      {
        kind,
        label,
        nodeId,
        objectId: null,
        ref: {
          kind,
          nodeId,
          resourceRef,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };

  return (
    <div className="fm-frequency-domain-table__actions">
      <Button
        aria-label="Open FMR workbench"
        className="fm-inspector-action-button"
        size="sm"
        type="button"
        variant="secondary"
        onClick={() =>
          openResult(
            "results.frequency_domain.fmr",
            "FMR",
            "results:frequency-domain:fmr",
            ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
          )
        }
      >
        <Eye size={13} aria-hidden="true" />
        <span>Open FMR workbench</span>
      </Button>
      <Button
        aria-label="Open modal spectrum"
        className="fm-inspector-action-button"
        size="sm"
        type="button"
        variant="secondary"
        onClick={() =>
          openResult(
            "results.frequency_domain.fmr_modal_spectrum",
            "FMR Modal Spectrum",
            "results:frequency-domain:fmr:modal-spectrum",
            ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
          )
        }
      >
        <Activity size={13} aria-hidden="true" />
        <span>Open modal spectrum</span>
      </Button>
      <Button
        aria-label="Open response sweep"
        className="fm-inspector-action-button"
        size="sm"
        type="button"
        variant="secondary"
        onClick={() =>
          openResult(
            "results.frequency_domain.fmr_response_sweep",
            "FMR Response Sweep",
            "results:frequency-domain:fmr:response-sweep",
            ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
          )
        }
      >
        <Activity size={13} aria-hidden="true" />
        <span>Open response sweep</span>
      </Button>
      <Button
        aria-label="Open dispersion"
        className="fm-inspector-action-button"
        size="sm"
        type="button"
        variant="secondary"
        onClick={() =>
          openResult(
            "results.frequency_domain.dispersion",
            "Dispersion",
            "results:frequency-domain:dispersion",
            ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
          )
        }
      >
        <Eye size={13} aria-hidden="true" />
        <span>Open dispersion</span>
      </Button>
    </div>
  );
}

interface ResultShortcutAction {
  kind: string;
  label: string;
  nodeId: string;
  resourceRef: string;
  title: string;
}

export function ResultShortcutActions({
  actions,
}: {
  actions: readonly ResultShortcutAction[];
}) {
  const kernel = useKernel();
  const openResult = (action: ResultShortcutAction): void => {
    kernel.selection.set(
      {
        kind: action.kind,
        label: action.label,
        nodeId: action.nodeId,
        objectId: null,
        ref: {
          kind: action.kind,
          nodeId: action.nodeId,
          resourceRef: action.resourceRef,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };

  return (
    <div className="fm-frequency-domain-table__actions">
      {actions.map((action) => (
        <Button
          aria-label={action.title}
          key={action.nodeId}
          className="fm-inspector-action-button"
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => openResult(action)}
        >
          <Eye size={13} aria-hidden="true" />
          <span>{action.title}</span>
        </Button>
      ))}
    </div>
  );
}

export function FmrComparisonPairTable({
  pairs,
}: {
  pairs: readonly FmrModalDrivenComparisonPoint[];
}) {
  if (pairs.length === 0) {
    return (
      <EmptyState className="fm-frequency-domain-table-empty" role="status" size="compact" heading="No modal-driven FMR pairs available." />
    );
  }

  return (
    <div className="fm-frequency-domain-table-wrap">
      <table
        aria-label="Frequency-domain FMR comparison table"
        className="fm-frequency-domain-table"
      >
        <thead>
          <tr>
            <th>Modal</th>
            <th>Driven</th>
            <th>Detuning</th>
            <th>Validation</th>
            <th>Field handoff</th>
          </tr>
        </thead>
        <tbody>
          {pairs.map((pair) => (
            <tr
              key={`${pair.modalPeak.frequencyHz}:${pair.modalPeak.modeRef?.sampleIndex ?? "sample"}:${pair.modalPeak.modeRef?.rawModeIndex ?? "mode"}:${pair.drivenPeak.frequencyHz}:${pair.drivenPeak.frequencyPointIndex ?? "point"}`}
            >
              <td>{formatFmrModalPairLabel(pair)}</td>
              <td>{formatFmrDrivenPairLabel(pair)}</td>
              <td>{formatFrequency(pair.detuningHz)}</td>
              <td>
                {pair.modalPeak.validationStatus} modal,{" "}
                {pair.drivenPeak.validationStatus} driven
              </td>
              <td>{formatFmrPairFieldHandoff(pair)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ProvenancePanelCopy {
  canonicalFamily?: string;
  linksBadge?: string;
  linksTitle?: string;
  title?: string;
}

export type ProvenancePanelProps = InspectorPanelProps & ProvenancePanelCopy;

export function ModalSpectrumStatus({ loading }: { loading: boolean }) {
  return (
    <EmptyState
      heading={loading ? "Loading eigenmodes…" : "Spectrum unavailable for this run and stage"}
      role="status"
      size="compact"
    />
  );
}

export function useEigenModeBrowser(
  selection: InspectorPanelProps["selection"],
  publication: ReturnType<typeof useEigenSpectrumSummary>["spectrumPublication"],
) {
  const kernel = useKernel();
  const overlay = useRenderableAnalysisFieldOverlay(kernel.analysisFieldOverlay, { ignorePhase: true });
  const owner = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const hasSpectrum = modalSpectrumMatchesSelection(publication, owner);
  const onInspect = (point: EigenSpectrumPoint): void => {
    if (!hasSpectrum) return;
    const nodeId = owner?.kind.startsWith("results.resonance.modal.") &&
      owner.analysisRunId && owner.analysisStageId &&
      point.modeFieldId && eigenModeFieldAvailable(point)
      ? modalResultModeNodeId(owner.analysisRunId, owner.analysisStageId, point.modeFieldId)
      : null;
    const ref = buildEigenModeSelectionRef(point, {
      ...owner,
      calculationMode: owner?.calculationMode === "fmr_modal" ? "fmr_modal" : "free_modes",
      nodeId,
      representation: "complex-vector-xyz",
      resourceRef: point.modeFieldResourceKey ?? undefined,
    });
    if (ref.type !== "frequency-domain") return;
    const kind = nodeId ? "results.resonance.modal.mode" : "results.eigen.mode";
    kernel.selection.set({
      kind,
      label: `Mode ${point.rawModeIndex}`,
      nodeId: ref.nodeId,
      objectId: null,
      ref: { ...ref, kind },
    }, "inspector");
  };
  const onView = (
    point: EigenSpectrumPoint,
    view: "abs" | "phase_rotated_real" = "abs",
  ): void => {
    if (!hasSpectrum || !eigenModeFieldAvailable(point) || !point.modeFieldId) return;
    void kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, { sourceDetail: "results.eigen.modes" }),
      {
        artifactGenerationId: publication?.generation_id,
        fieldId: point.modeFieldId,
        frequencyHz: point.frequencyHz,
        label: `Mode ${point.rawModeIndex} · ${formatFrequency(point.frequencyHz)}`,
        modeId: point.modeId,
        modeIndex: point.rawModeIndex,
        phaseRad: 0,
        representation: "complex-vector-xyz",
        resourceRef: point.modeFieldResourceKey,
        sampleId: point.sampleId,
        sampleIndex: point.sampleIndex,
        source: "eigen-mode",
        view,
      },
    );
  };
  const activeFieldId = overlay?.source === "eigen-mode" &&
    overlay.provenance?.runId === publication?.run_id &&
    overlay.provenance?.stageId === publication?.stage_id
    ? overlay.fieldId
    : null;
  return { activeFieldId, hasSpectrum, onInspect, onView };
}
