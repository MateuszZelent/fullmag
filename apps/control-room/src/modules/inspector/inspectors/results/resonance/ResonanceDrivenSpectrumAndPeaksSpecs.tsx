"use client";

import { Download } from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainFmrResonanceFitsResource,
  useFrequencyDomainManifestResource,
  useFrequencyDomainResponseSweepResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  buildFmrPeakTableModel,
  buildFrequencyResponseChartModel,
  buildFrequencyResponsePointSelectionRef,
  frequencyDomainManifestPayload,
  type FrequencyResponsePoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import { Button } from "@/shared/ui/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import { ReferenceImportSection } from "../../../panels/analysis-results/ReferenceImportSection";
import { FmrResponseSweepInspectorPanel } from "../../../panels/frequency-domain/FmrResponseSweepInspectorPanel";
import {
  FmrPeakInspectorPanel,
  FmrPeaksInspectorPanel,
  FrequencyResponseFrequencyPointsInspectorPanel,
  FrequencyResponseObservableInspectorPanel,
  FrequencyResponseObservablesInspectorPanel,
  FrequencyResponseSweepInspectorPanel,
} from "../frequency-domain";
import { buildFrequencyResponsePlotCommandInput } from "../../../panels/frequency-domain/FrequencyResponseInspectorPanels.model";
import { FrequencyDomainResponseChart } from "../../../panels/FrequencyDomainCharts";
import { ConnectedInspectorSpec } from "../../../panels/study/ConnectedInspectorSpec";
import {
  frequencyDomainRef,
  copyCsvText,
  makeSimplePhysicsResultSpec,
  buildRefProvenanceRows,
  DEFAULT_SPECTRAL_RESULT_DRAFT,
} from "./resonanceShared";

export function ResonanceDrivenSpectrumResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedResonanceDrivenSpectrum {...props} />
  ) : (
    <ResonanceDrivenSpectrumView {...props} manifestData={null} sweepData={null} />
  );
}

function ConnectedResonanceDrivenSpectrum(props: InspectorPanelProps) {
  const sweepRes = useFrequencyDomainResponseSweepResource();
  const manifestRes = useFrequencyDomainManifestResource();
  return (
    <ResonanceDrivenSpectrumView
      {...props}
      manifestData={manifestRes.data ?? null}
      sweepData={sweepRes.data ?? null}
    />
  );
}

function ResonanceDrivenSpectrumView({
  manifestData,
  selection,
  sweepData,
}: InspectorPanelProps & {
  manifestData: ReturnType<typeof useFrequencyDomainManifestResource>["data"] | null;
  sweepData: Parameters<typeof buildFrequencyResponseChartModel>[0];
}) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const manifestPayload = useMemo(() => {
    const raw = frequencyDomainManifestPayload(manifestData ?? undefined);
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  }, [manifestData]);
  const chartModel = useMemo(
    () => buildFrequencyResponseChartModel(sweepData, manifestPayload),
    [manifestPayload, sweepData],
  );
  const [selectedSeriesId, setSelectedSeriesId] = useState<string>("all");

  const filteredChartModel = useMemo(() => {
    if (selectedSeriesId === "all" || chartModel.series.length === 0) {
      return chartModel;
    }
    const matching = chartModel.series.filter(
      (s) => s.id === selectedSeriesId || s.label === selectedSeriesId,
    );
    return matching.length > 0 ? { ...chartModel, series: matching } : chartModel;
  }, [chartModel, selectedSeriesId]);

  const exportSweepCsv = useCallback(() => {
    const header =
      "frequency_index,frequency_hz,observable_id,amplitude,phase_rad,absorbed_power_density,residual_norm,field_id";
    const rows = chartModel.points.map((pt) =>
      [
        pt.frequencyIndex ?? "",
        pt.frequencyHz,
        pt.observableId,
        pt.amplitude ?? "",
        pt.phaseRad ?? "",
        pt.absorbedPowerDensity ?? "",
        pt.residualNorm ?? "",
        pt.fieldId ?? "",
      ].join(","),
    );
    copyCsvText([header, ...rows].join("\n"));
  }, [chartModel.points]);

  const selectResponsePoint = useCallback(
    (point: FrequencyResponsePoint): void => {
      if (!kernel) return;
      const responseRef = buildFrequencyResponsePointSelectionRef(point, {
        analysisRunId: ref?.analysisRunId,
        analysisStageId: ref?.analysisStageId,
        calculationMode: "fmr_response",
        resourceRef: ref?.resourceRef,
      });
      kernel.selection.set(
        {
          kind: responseRef.kind,
          label: `${point.observableId} ${formatFrequencyHz(point.frequencyHz)}`,
          nodeId: responseRef.nodeId,
          objectId: null,
          ref: responseRef,
        },
        "inspector",
      );
    },
    [kernel, ref?.analysisRunId, ref?.analysisStageId, ref?.resourceRef],
  );

  const plotResponsePoint = useCallback(
    (point: FrequencyResponsePoint): void => {
      if (!kernel || !point.fieldId) return;
      void kernel.commands.execute(
        "analysis.frequency-response.plot-response-field-3d",
        createCommandContext("inspector", kernel, {
          sourceDetail: "results.resonance.driven.spectrum",
        }),
        buildFrequencyResponsePlotCommandInput({
          fieldId: point.fieldId,
          frequencyIndex: point.frequencyIndex,
          label: `${point.observableId} ${formatFrequencyHz(point.frequencyHz)}`,
          phaseRad: point.phaseRad ?? 0,
          view: "phase_rotated_real",
        }),
      );
    },
    [kernel],
  );

  const isSingleObservableFocus =
    ref?.kind === "results.frequency_response.observable" || Boolean(ref?.observableId);
  const isObservablesCollectionFocus =
    ref?.kind === "results.frequency_response.observables";
  const isFrequencyPointsFocus =
    ref?.kind === "results.resonance.driven.frequency_points" ||
    ref?.kind === "results.frequency_response.frequency_points";

  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.resonance.driven.spectrum:${selection.nodeId ?? "dspec"}`,
        breadcrumbs: ["Results", "Resonance & FMR", "Driven Response Spectrum"],
        title: selection.label || "Driven Susceptibility Spectrum",
        kindLabel: "Complex chi'(f), chi''(f) & absorbed power",
        extraMenuActions: [
          {
            id: "export-sweep-csv",
            label: "Export Sweep CSV",
            icon: Download,
            disabledReason:
              chartModel.points.length === 0 ? "No solved sweep points to export" : undefined,
            onSelect: () => exportSweepCsv(),
          },
        ],
        facts: [
          { id: "pts", label: "Frequencies", value: String(chartModel.points.length) },
          { id: "series", label: "Series", value: String(chartModel.series.length) },
        ],
        sectionTitle: "Harmonic Sweep & Susceptibility Workbench",
        rows: [
          {
            type: "custom",
            label: "Observable / component",
            wide: true,
            render: () => (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Select value={selectedSeriesId} onValueChange={setSelectedSeriesId}>
                  <SelectTrigger aria-label="Displayed observable series" className="min-w-[12rem]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="fm-inspector-select-content">
                    <SelectItem value="all">All observable series</SelectItem>
                    {chartModel.series.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  disabled={chartModel.points.length === 0}
                  disabledReason="No solved sweep points to export"
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={exportSweepCsv}
                >
                  <Download aria-hidden="true" size={13} />
                  <span>Export Sweep CSV</span>
                </Button>
              </div>
            ),
          },
          ...(filteredChartModel.points.length > 0 && !kernel
            ? [
                {
                  type: "custom" as const,
                  label: "Driven response chart",
                  wide: true,
                  render: () => (
                    <FrequencyDomainResponseChart model={filteredChartModel} />
                  ),
                },
              ]
            : []),
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <div className="grid min-w-0 gap-3">
                      {selectedSeriesId !== "all" && filteredChartModel.points.length > 0 ? (
                        <FrequencyDomainResponseChart
                          model={filteredChartModel}
                          onPlotPoint={plotResponsePoint}
                          onSelectPoint={selectResponsePoint}
                        />
                      ) : null}
                      {isSingleObservableFocus ? (
                        <FrequencyResponseObservableInspectorPanel selection={selection} />
                      ) : null}
                      {isObservablesCollectionFocus ? (
                        <FrequencyResponseObservablesInspectorPanel selection={selection} />
                      ) : null}
                      {isFrequencyPointsFocus ? (
                        <FrequencyResponseFrequencyPointsInspectorPanel selection={selection} />
                      ) : null}
                      <FrequencyResponseSweepInspectorPanel selection={selection} />
                      <FmrResponseSweepInspectorPanel selection={selection} />
                      <ReferenceImportSection />
                    </div>
                  ),
                },
              ]
            : []),
          ...buildRefProvenanceRows(selection),
        ],
      }),
    [
      chartModel.points.length,
      chartModel.series,
      exportSweepCsv,
      filteredChartModel,
      isFrequencyPointsFocus,
      isObservablesCollectionFocus,
      isSingleObservableFocus,
      kernel,
      plotResponsePoint,
      selectResponsePoint,
      selectedSeriesId,
      selection,
    ],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function ResonanceDrivenPeaksResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedResonanceDrivenPeaks {...props} />
  ) : (
    <ResonanceDrivenPeaksView
      {...props}
      manifestData={null}
      responseSweep={null}
      spectrum={null}
    />
  );
}

function ConnectedResonanceDrivenPeaks(props: InspectorPanelProps) {
  const sweepRes = useFrequencyDomainResponseSweepResource();
  const spectrumRes = useFrequencyDomainEigenSpectrumResource();
  const manifestRes = useFrequencyDomainManifestResource();
  return (
    <ResonanceDrivenPeaksView
      {...props}
      manifestData={manifestRes.data ?? null}
      responseSweep={sweepRes.data ?? null}
      spectrum={spectrumRes.data ?? null}
    />
  );
}

function ResonanceDrivenPeaksView({
  manifestData,
  responseSweep,
  selection,
  spectrum,
}: InspectorPanelProps & {
  manifestData: ReturnType<typeof useFrequencyDomainManifestResource>["data"] | null;
  responseSweep: Parameters<typeof buildFmrPeakTableModel>[0]["responseSweep"];
  spectrum: Parameters<typeof buildFmrPeakTableModel>[0]["spectrum"];
}) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const manifestPayload = useMemo(() => {
    const raw = frequencyDomainManifestPayload(manifestData ?? undefined);
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  }, [manifestData]);
  const peakTable = useMemo(
    () => buildFmrPeakTableModel({ manifestPayload, responseSweep, spectrum }),
    [manifestPayload, responseSweep, spectrum],
  );
  const hasPeaks = peakTable.peaks.length > 0;
  const isSinglePeak =
    ref?.fmrPeakIndex != null ||
    ref?.kind === "results.frequency_domain.fmr_peak" ||
    Boolean(selection.nodeId?.includes(":peak:"));

  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.resonance.driven.peaks:${selection.nodeId ?? "peaks"}`,
        breadcrumbs: ["Results", "Resonance & FMR", "Resonance Peaks"],
        title: selection.label || "Detected FMR Resonance Peaks",
        kindLabel: "Peak frequency f_res, prominence, FWHM & Q-factor",
        stateLabel: hasPeaks ? `${peakTable.peaks.length} peaks` : "Ready",
        facts: [
          { id: "count", label: "Peaks", value: String(peakTable.peaks.length) },
          { id: "detector", label: "Estimator", value: "Susceptibility peak finder" },
        ],
        sectionTitle: "Detected Resonance Peaks",
        rows: [
          {
            type: "readonly",
            label: "Peak metrics",
            format: () => "Resonance frequency f_r, half-power linewidth Delta f, and Q factor",
          },
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <div className="grid min-w-0 gap-3">
                      {isSinglePeak ? <FmrPeakInspectorPanel selection={selection} /> : null}
                      <FmrPeaksInspectorPanel selection={selection} />
                    </div>
                  ),
                },
              ]
            : peakTable.peaks.map((peak, idx) => ({
                type: "readonly" as const,
                label: `${peak.source} peak #${idx + 1}`,
                mono: true,
                format: () => formatFrequencyHz(peak.frequencyHz),
              }))),
        ],
      }),
    [hasPeaks, isSinglePeak, kernel, peakTable.peaks, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function ResonanceDrivenFitsResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedResonanceDrivenFits {...props} />
  ) : (
    <ResonanceDrivenFitsView
      {...props}
      artifactMeta={null}
      payload={null}
      resourceStatus="idle"
    />
  );
}

function ConnectedResonanceDrivenFits(props: InspectorPanelProps) {
  const fitsRes = useFrequencyDomainFmrResonanceFitsResource();
  return (
    <ResonanceDrivenFitsView
      {...props}
      artifactMeta={fitsRes.data ?? null}
      payload={
        (fitsRes.data?.payload as Record<string, unknown> | undefined) ?? null
      }
      resourceStatus={fitsRes.status}
    />
  );
}

function ResonanceDrivenFitsView({
  artifactMeta,
  payload,
  resourceStatus,
  selection,
}: InspectorPanelProps & {
  artifactMeta: ReturnType<typeof useFrequencyDomainFmrResonanceFitsResource>["data"] | null;
  payload: Record<string, unknown> | null;
  resourceStatus: string;
}) {
  const ref = frequencyDomainRef(selection);
  const fitsArray = useMemo(
    () =>
      Array.isArray(payload?.fits)
        ? (payload.fits as Array<Record<string, unknown>>)
        : [],
    [payload],
  );
  const [selectedFitIdx, setSelectedFitIdx] = useState<number>(0);

  const activeFit = useMemo(() => {
    if (fitsArray.length === 0) return null;
    if (ref?.pointId) {
      const byId = fitsArray.find((f) => String(f.fit_id ?? "") === ref.pointId);
      if (byId) return byId;
    }
    return fitsArray[Math.min(selectedFitIdx, fitsArray.length - 1)] ?? null;
  }, [fitsArray, ref, selectedFitIdx]);

  const exportFitsCsv = useCallback(() => {
    const header =
      "fit_id,observable_id,resonance_frequency_hz,frequency_uncertainty_hz,linewidth_fwhm_hz,linewidth_uncertainty_hz,quality_factor,symmetric_amplitude,antisymmetric_amplitude,r_squared";
    const rows = fitsArray.map((rec, idx) =>
      [
        rec.fit_id ?? `fit_${idx}`,
        rec.observable_id ?? "",
        rec.resonance_frequency_hz ?? "",
        rec.resonance_frequency_uncertainty_hz ?? rec.frequency_uncertainty_hz ?? "",
        rec.linewidth_fwhm_hz ?? "",
        rec.linewidth_uncertainty_hz ?? "",
        rec.quality_factor ?? "",
        rec.symmetric_amplitude ?? rec.amplitude_symmetric ?? "",
        rec.antisymmetric_amplitude ?? rec.amplitude_antisymmetric ?? "",
        rec.r_squared ?? rec.residual_norm ?? "",
      ].join(","),
    );
    copyCsvText([header, ...rows].join("\n"));
  }, [fitsArray]);

  const hasFits = Boolean(payload);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.resonance.driven.fits:${selection.nodeId ?? "fits"}`,
        breadcrumbs: ["Results", "Resonance & FMR", "Lorentzian Resonance Fits"],
        title: selection.label || "Lorentzian Susceptibility Fits",
        kindLabel: "Symmetric & antisymmetric Lorentzian decomposition",
        stateLabel: hasFits ? "Fitted" : resourceStatus === "idle" ? "Ready" : resourceStatus,
        facts: [
          { id: "count", label: "Fits", value: String(fitsArray.length) },
          { id: "model", label: "Fit model", value: "Complex Lorentzian + baseline" },
          ...(artifactMeta?.revision
            ? [{ id: "rev", label: "Revision", value: String(artifactMeta.revision) }]
            : []),
        ],
        sectionTitle: "Fitted Resonance Parameters",
        rows: [
          {
            type: "readonly",
            label: "Linewidth convention",
            format: () => "Full-width at half-maximum Delta f (Hz) and Gilbert damping proxy",
          },
          {
            type: "readonly",
            label: "Source run / stage",
            mono: true,
            format: () =>
              artifactMeta?.run_id || artifactMeta?.stage_id
                ? `${artifactMeta?.run_id ?? "—"} / ${artifactMeta?.stage_id ?? "—"}`
                : "—",
          },
          ...(fitsArray.length > 0
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <div className="grid gap-2.5 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Select
                          value={String(Math.min(selectedFitIdx, fitsArray.length - 1))}
                          onValueChange={(v) => setSelectedFitIdx(Number(v))}
                        >
                          <SelectTrigger aria-label="Select resonance fit">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="fm-inspector-select-content">
                            {fitsArray.map((rec, idx) => {
                              const f0 =
                                typeof rec.resonance_frequency_hz === "number"
                                  ? formatFrequencyHz(rec.resonance_frequency_hz)
                                  : `Fit #${idx + 1}`;
                              return (
                                <SelectItem key={String(rec.fit_id ?? idx)} value={String(idx)}>
                                  {`${String(rec.fit_id ?? `Fit #${idx + 1}`)} · ${f0}`}
                                </SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={exportFitsCsv}
                        >
                          <Download aria-hidden="true" size={13} />
                          <span>Export Fits CSV</span>
                        </Button>
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs tabular-nums border-collapse">
                          <thead>
                            <tr className="border-b border-fm-border text-fm-muted">
                              <th className="py-1 px-1.5">Fit</th>
                              <th className="py-1 px-1.5">f_res</th>
                              <th className="py-1 px-1.5">FWHM</th>
                              <th className="py-1 px-1.5">Q</th>
                            </tr>
                          </thead>
                          <tbody>
                            {fitsArray.map((rec, idx) => {
                              const f0 =
                                typeof rec.resonance_frequency_hz === "number"
                                  ? formatFrequencyHz(rec.resonance_frequency_hz)
                                  : "—";
                              const df =
                                typeof rec.linewidth_fwhm_hz === "number"
                                  ? formatFrequencyHz(rec.linewidth_fwhm_hz)
                                  : "—";
                              const qVal =
                                typeof rec.quality_factor === "number"
                                  ? rec.quality_factor.toFixed(1)
                                  : typeof rec.resonance_frequency_hz === "number" &&
                                      typeof rec.linewidth_fwhm_hz === "number" &&
                                      rec.linewidth_fwhm_hz > 0
                                    ? (rec.resonance_frequency_hz / rec.linewidth_fwhm_hz).toFixed(1)
                                    : "—";
                              return (
                                <tr
                                  className="border-b border-fm-border-subtle cursor-pointer"
                                  key={String(rec.fit_id ?? idx)}
                                  onClick={() => setSelectedFitIdx(idx)}
                                >
                                  <td className="py-1 px-1.5 font-mono">
                                    {String(rec.fit_id ?? `#${idx + 1}`)}
                                  </td>
                                  <td className="py-1 px-1.5">{f0}</td>
                                  <td className="py-1 px-1.5">{df}</td>
                                  <td className="py-1 px-1.5">{qVal}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ),
                },
              ]
            : []),
          ...(activeFit
            ? [
                {
                  type: "readonly" as const,
                  label: "Selected fit ID",
                  mono: true,
                  format: () => String(activeFit.fit_id ?? `fit_${selectedFitIdx}`),
                },
                {
                  type: "readonly" as const,
                  label: "Resonance frequency f_res",
                  mono: true,
                  format: () => {
                    const f0 =
                      typeof activeFit.resonance_frequency_hz === "number"
                        ? formatFrequencyHz(activeFit.resonance_frequency_hz)
                        : "—";
                    const sigma =
                      typeof activeFit.resonance_frequency_uncertainty_hz === "number"
                        ? ` ± ${formatFrequencyHz(activeFit.resonance_frequency_uncertainty_hz)}`
                        : "";
                    return `${f0}${sigma}`;
                  },
                },
                {
                  type: "readonly" as const,
                  label: "Linewidth FWHM",
                  mono: true,
                  format: () => {
                    const df =
                      typeof activeFit.linewidth_fwhm_hz === "number"
                        ? formatFrequencyHz(activeFit.linewidth_fwhm_hz)
                        : "—";
                    const sigma =
                      typeof activeFit.linewidth_uncertainty_hz === "number"
                        ? ` ± ${formatFrequencyHz(activeFit.linewidth_uncertainty_hz)}`
                        : "";
                    return `${df}${sigma}`;
                  },
                },
                {
                  type: "readonly" as const,
                  label: "Symmetric / antisymmetric weight",
                  mono: true,
                  format: () => {
                    const sym = activeFit.symmetric_amplitude ?? activeFit.amplitude_symmetric;
                    const asym = activeFit.antisymmetric_amplitude ?? activeFit.amplitude_antisymmetric;
                    const sStr = typeof sym === "number" ? sym.toExponential(3) : "—";
                    const aStr = typeof asym === "number" ? asym.toExponential(3) : "—";
                    return `${sStr} / ${aStr}`;
                  },
                },
                {
                  type: "readonly" as const,
                  label: "Goodness of fit (R^2 / residual)",
                  mono: true,
                  format: () => {
                    if (typeof activeFit.r_squared === "number") {
                      return `R^2 = ${activeFit.r_squared.toFixed(5)}`;
                    }
                    if (typeof activeFit.residual_norm === "number") {
                      return activeFit.residual_norm.toExponential(3);
                    }
                    return "—";
                  },
                },
              ]
            : []),
        ],
      }),
    [
      activeFit,
      artifactMeta,
      exportFitsCsv,
      fitsArray,
      hasFits,
      resourceStatus,
      selectedFitIdx,
      selection,
    ],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}
