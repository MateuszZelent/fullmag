"use client";

import type { EChartsOption } from "echarts";
import {
  Box,
  Download,
  GitCommit,
  Pin,
  Play,
  Waves,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
} from "react";
import { PIN_MODE_VISUALIZATION_COMMAND } from "@/kernel/analysis-modules/postprocessingCommandContributions";
import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  useFrequencyDomainFmrKittelFitResource,
  useFrequencyDomainResponseFieldMetaResource,
  useFrequencyDomainResponseSweepResource,
} from "@/kernel/resources/studyRuntimeResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { ScientificEChart, type ResolvedChartThemePalette } from "@/shared/charts/ScientificEChart";
import { buildFrequencyResponseChartModel } from "@/shared/domain/analysis/frequencyDomainChartModels";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorSpec } from "../../../template";
import {
  FrequencyResponseFieldResourceInspectorPanel,
  FrequencyResponseFieldsInspectorPanel,
  FrequencyResponsePointInspectorPanel,
} from "../frequency-domain";
import { ConnectedInspectorSpec } from "../../../panels/study/ConnectedInspectorSpec";
import {
  copyCsvText,
  makeSimplePhysicsResultSpec,
  DEFAULT_SPECTRAL_RESULT_DRAFT,
  ModeHarmonicPhaseControls,
  frequencyDomainRef,
  type ReadOnlySpectralResultDraft,
  buildRefProvenanceRows,
} from "./resonanceShared";

export function ResonanceKittelFitResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedResonanceKittelFit {...props} />
  ) : (
    <ResonanceKittelFitView
      {...props}
      artifactMeta={null}
      payload={null}
      resourceStatus="idle"
    />
  );
}

function ConnectedResonanceKittelFit(props: InspectorPanelProps) {
  const kittelRes = useFrequencyDomainFmrKittelFitResource();
  return (
    <ResonanceKittelFitView
      {...props}
      artifactMeta={kittelRes.data ?? null}
      payload={
        (kittelRes.data?.payload as Record<string, unknown> | undefined) ?? null
      }
      resourceStatus={kittelRes.status}
    />
  );
}

function KittelDispersionFitChart({ payload }: { payload: Record<string, unknown> }) {
  const samples = useMemo(
    () =>
      Array.isArray(payload.samples)
        ? (payload.samples as Array<Record<string, unknown>>)
        : Array.isArray(payload.points)
          ? (payload.points as Array<Record<string, unknown>>)
          : [],
    [payload],
  );

  const buildOption = useMemo(
    () => (palette: ResolvedChartThemePalette): EChartsOption => {
      const measured = samples.flatMap((pt) => {
        const bVal =
          typeof pt.bias_field_t === "number"
            ? pt.bias_field_t * 1e3
            : typeof pt.bias_field_a_per_m === "number"
              ? pt.bias_field_a_per_m * 4 * Math.PI * 1e-4
              : null;
        const fGhz =
          typeof pt.frequency_hz === "number"
            ? pt.frequency_hz * 1e-9
            : typeof pt.resonance_frequency_hz === "number"
              ? pt.resonance_frequency_hz * 1e-9
              : null;
        return bVal !== null && fGhz !== null ? [[bVal, fGhz]] : [];
      });
      const fitted = samples.flatMap((pt) => {
        const bVal =
          typeof pt.bias_field_t === "number"
            ? pt.bias_field_t * 1e3
            : typeof pt.bias_field_a_per_m === "number"
              ? pt.bias_field_a_per_m * 4 * Math.PI * 1e-4
              : null;
        const fFitGhz =
          typeof pt.fitted_frequency_hz === "number"
            ? pt.fitted_frequency_hz * 1e-9
            : null;
        return bVal !== null && fFitGhz !== null ? [[bVal, fFitGhz]] : [];
      });
      return {
        grid: { left: 48, right: 14, top: 18, bottom: 32 },
        xAxis: {
          type: "value",
          name: "mu0 H (mT)",
          nameLocation: "middle",
          nameGap: 22,
          splitLine: { lineStyle: { color: palette.borderSubtle } },
        },
        yAxis: {
          type: "value",
          name: "f_res (GHz)",
          splitLine: { lineStyle: { color: palette.borderSubtle } },
        },
        series: [
          {
            type: "scatter",
            name: "Solved f_res",
            symbolSize: 7,
            itemStyle: { color: palette.series[0] },
            data: measured,
          },
          ...(fitted.length > 0
            ? [
                {
                  type: "line" as const,
                  name: "Kittel fit",
                  showSymbol: false,
                  lineStyle: { color: palette.series[1] },
                  data: fitted,
                },
              ]
            : []),
        ],
      };
    },
    [samples],
  );

  if (samples.length === 0) return null;
  return (
    <ScientificEChart
      ariaLabel="Kittel resonance frequency vs bias field f_res(H)"
      height={190}
      optionBuilder={buildOption}
    />
  );
}

function ResonanceKittelFitView({
  artifactMeta,
  payload,
  resourceStatus,
  selection,
}: InspectorPanelProps & {
  artifactMeta: ReturnType<typeof useFrequencyDomainFmrKittelFitResource>["data"] | null;
  payload: Record<string, unknown> | null;
  resourceStatus: string;
}) {
  const hasFit = Boolean(payload);
  const meffT =
    typeof payload?.mu0_m_eff_t === "number"
      ? `${payload.mu0_m_eff_t.toFixed(4)} T`
      : typeof payload?.m_eff_a_per_m === "number"
        ? `${(payload.m_eff_a_per_m * 4 * Math.PI * 1e-7).toFixed(4)} T`
        : null;
  const gammaGhzPerT =
    typeof payload?.gamma_over_2pi_ghz_per_t === "number"
      ? `${payload.gamma_over_2pi_ghz_per_t.toFixed(3)} GHz/T`
      : typeof payload?.gamma_over_2pi_hz_per_t === "number"
        ? `${(payload.gamma_over_2pi_hz_per_t * 1e-9).toFixed(3)} GHz/T`
        : null;
  const anisotropyFieldMt =
    typeof payload?.mu0_h_k_t === "number"
      ? `${(payload.mu0_h_k_t * 1e3).toFixed(2)} mT`
      : typeof payload?.b_k_t === "number"
        ? `${(payload.b_k_t * 1e3).toFixed(2)} mT`
        : typeof payload?.h_k_a_per_m === "number"
          ? `${(payload.h_k_a_per_m * 4 * Math.PI * 1e-4).toFixed(2)} mT`
          : null;
  const deltaH0Mt =
    typeof payload?.mu0_delta_h0_t === "number"
      ? `${(payload.mu0_delta_h0_t * 1e3).toFixed(3)} mT`
      : typeof payload?.delta_h0_a_per_m === "number"
        ? `${(payload.delta_h0_a_per_m * 4 * Math.PI * 1e-4).toFixed(3)} mT`
        : null;
  const alphaGilbert =
    typeof payload?.alpha_gilbert === "number"
      ? payload.alpha_gilbert.toExponential(4)
      : typeof payload?.gilbert_damping === "number"
        ? payload.gilbert_damping.toExponential(4)
        : null;
  const fitR2 =
    typeof payload?.r_squared === "number"
      ? payload.r_squared.toFixed(5)
      : typeof payload?.rms_residual_hz === "number"
        ? `RMS ${formatFrequencyHz(payload.rms_residual_hz)}`
        : null;

  const exportKittelCsv = useCallback(() => {
    if (!payload) return;
    copyCsvText(JSON.stringify(payload, null, 2));
  }, [payload]);

  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.resonance.kittel_fit:${selection.nodeId ?? "kittel"}`,
        breadcrumbs: ["Results", "Resonance & FMR", "Kittel Extraction"],
        title: selection.label || "Kittel Dispersion & Effective Magnetization Fit",
        kindLabel: "Extracted gamma/(2pi), M_eff, and H_k from f_res(H)",
        stateLabel: hasFit ? "Fitted" : resourceStatus === "idle" ? "Ready" : resourceStatus,
        facts: [
          {
            id: "law",
            label: "Relation",
            value: "f = (gamma/2pi) sqrt((B + B_k)(B + B_k + mu0 M_eff))",
          },
          ...(meffT ? [{ id: "meff", label: "mu0 M_eff", value: meffT }] : []),
          ...(gammaGhzPerT ? [{ id: "gamma", label: "gamma/2pi", value: gammaGhzPerT }] : []),
        ],
        sectionTitle: "Extracted Ferromagnetic Resonance Parameters",
        rows: [
          {
            type: "readonly",
            label: "Effective magnetization (mu0 M_eff)",
            mono: true,
            format: () => meffT ?? "—",
          },
          {
            type: "readonly",
            label: "Gyromagnetic ratio gamma/(2pi)",
            mono: true,
            format: () => gammaGhzPerT ?? "—",
          },
          {
            type: "readonly",
            label: "Anisotropy field (mu0 H_k)",
            mono: true,
            format: () => anisotropyFieldMt ?? "—",
          },
          {
            type: "readonly",
            label: "Inhomogeneous broadening (mu0 Delta H_0)",
            mono: true,
            format: () => deltaH0Mt ?? "—",
          },
          {
            type: "readonly",
            label: "Effective Gilbert damping alpha",
            mono: true,
            format: () => alphaGilbert ?? "—",
          },
          {
            type: "readonly",
            label: "Fit residual / R^2",
            mono: true,
            format: () => fitR2 ?? "—",
          },
          {
            type: "readonly",
            label: "Source run / stage / revision",
            mono: true,
            format: () =>
              artifactMeta
                ? `${artifactMeta.run_id ?? "—"} / ${artifactMeta.stage_id ?? "—"} / ${artifactMeta.revision ?? "—"}`
                : "—",
          },
          ...(payload
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <div className="grid gap-2">
                      <KittelDispersionFitChart payload={payload} />
                      <div>
                        <Button
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={exportKittelCsv}
                        >
                          <Download aria-hidden="true" size={13} />
                          <span>Export Kittel Fit JSON</span>
                        </Button>
                      </div>
                    </div>
                  ),
                },
              ]
            : []),
        ],
      }),
    [
      alphaGilbert,
      anisotropyFieldMt,
      artifactMeta,
      deltaH0Mt,
      exportKittelCsv,
      fitR2,
      gammaGhzPerT,
      hasFit,
      meffT,
      payload,
      resourceStatus,
      selection.label,
      selection.nodeId,
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

export function ResonanceResponseFieldsResultInspector({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.resonance.driven.fields:${selection.nodeId ?? "rfields"}`,
        breadcrumbs: ["Results", "Resonance & FMR", "Response Fields"],
        title: selection.label || "Driven Spatial Response Fields",
        kindLabel: "Saved harmonic magnetization fields delta_m(r, f)",
        commitMode: "liveViewport",
        onResetDisplay: () => {
          if (!kernel) return;
          void kernel.commands.execute(
            "analysis.frequency-domain.stop-3d-animation",
            createCommandContext("inspector", kernel),
          );
          kernel.analysisFieldOverlay?.update({ visualizationPhaseRad: 0 });
        },
        facts: [{ id: "encoding", label: "Field type", value: "Complex 3D vector" }],
        sectionTitle: "Harmonic Field Snapshots & 3D Activation",
        rows: [
          {
            type: "custom",
            label: "Phase animation",
            wide: true,
            render: () => <ModeHarmonicPhaseControls />,
          },
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => <FrequencyResponseFieldsInspectorPanel selection={selection} />,
                },
              ]
            : []),
        ],
      }),
    [kernel, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function DrivenResponseFieldInspectorShared(props: {
  breadcrumbsPrefix: readonly [string, string];
  defaultTitle: string;
  idPrefix: string;
  kindLabel: string;
  onPhaseChangeDeg?: (deg: number) => void;
  selection: Selection;
}) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(props.selection);
  const isLegacyDsf =
    ref?.kind === "results.time_domain.dsf_point" ||
    Boolean(
      props.selection.nodeId?.includes("dsf_point") ||
        props.selection.nodeId?.includes("legacy:dsf") ||
        props.selection.nodeId?.includes("legacy%3Adsf"),
    );
  if (kernel && !isLegacyDsf) {
    return <ConnectedDrivenResponseFieldInspectorShared {...props} />;
  }
  return (
    <DrivenResponseFieldInspectorView
      {...props}
      isLegacyDsfPoint={isLegacyDsf}
      resolvedFieldId={ref?.fieldId ?? null}
    />
  );
}

function ConnectedDrivenResponseFieldInspectorShared(props: {
  breadcrumbsPrefix: readonly [string, string];
  defaultTitle: string;
  idPrefix: string;
  kindLabel: string;
  onPhaseChangeDeg?: (deg: number) => void;
  selection: Selection;
}) {
  const ref = frequencyDomainRef(props.selection);
  const freqIdx = ref?.frequencyIndex ?? null;
  const fieldMeta = useFrequencyDomainResponseFieldMetaResource(freqIdx);
  const sweepRes = useFrequencyDomainResponseSweepResource();
  const resolvedFieldId = useMemo(() => {
    if (ref?.fieldId) return ref.fieldId;
    if (fieldMeta.data?.field_id) return fieldMeta.data.field_id;
    const pts = buildFrequencyResponseChartModel(sweepRes.data).points;
    const matched =
      freqIdx != null
        ? pts.find((pt) => pt.frequencyIndex === freqIdx)
        : typeof ref?.frequencyHz === "number"
          ? pts.find((pt) => Math.abs(pt.frequencyHz - ref.frequencyHz!) < 1)
          : null;
    return matched?.fieldId ?? null;
  }, [fieldMeta.data?.field_id, freqIdx, ref, sweepRes.data]);

  return (
    <DrivenResponseFieldInspectorView
      {...props}
      isLegacyDsfPoint={false}
      resolvedFieldId={resolvedFieldId}
    />
  );
}

function DrivenResponseFieldInspectorView({
  breadcrumbsPrefix,
  defaultTitle,
  idPrefix,
  isLegacyDsfPoint,
  kindLabel,
  onPhaseChangeDeg,
  resolvedFieldId,
  selection,
}: {
  breadcrumbsPrefix: readonly [string, string];
  defaultTitle: string;
  idPrefix: string;
  isLegacyDsfPoint: boolean;
  kindLabel: string;
  onPhaseChangeDeg?: (deg: number) => void;
  resolvedFieldId: string | null;
  selection: Selection;
}) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const fieldId = resolvedFieldId;
  const isFieldResource =
    ref?.kind === "resources.analysis.frequency_response.field";

  const activateResponseFieldIn3D = useCallback(async () => {
    if (!kernel || !fieldId) return;
    await kernel.commands.execute(
      "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, { sourceDetail: idPrefix }),
      {
        fieldId,
        frequencyIndex: ref?.frequencyIndex,
        label: selection.label || defaultTitle,
        phaseRad: 0,
        source: "frequency-response",
        view: "phase_rotated_real",
      },
    );
  }, [defaultTitle, fieldId, idPrefix, kernel, ref?.frequencyIndex, selection.label]);

  const pinVisualization = useCallback(() => {
    if (!kernel || !fieldId) return;
    void kernel.commands.execute(
      PIN_MODE_VISUALIZATION_COMMAND,
      createCommandContext("inspector", kernel, { sourceDetail: idPrefix }),
    );
  }, [fieldId, idPrefix, kernel]);

  const spec = useMemo<InspectorSpec<ReadOnlySpectralResultDraft>>(
    () => ({
      id: `${idPrefix}:${selection.nodeId ?? "rfield"}`,
      header: {
        breadcrumbs: [
          { id: "b0", label: breadcrumbsPrefix[0] },
          { id: "b1", label: breadcrumbsPrefix[1] },
          { id: "leaf", label: selection.label || defaultTitle },
        ],
        ...(kernel && !isLegacyDsfPoint
          ? {
              ...(fieldId
                ? {
                    primaryHeaderAction: {
                      label: "Load in 3D",
                      icon: Box,
                      onRun: activateResponseFieldIn3D,
                    },
                  }
                : {}),
              extraMenuActions: [
                {
                  id: "pin-response-viz",
                  label: "Pin Mode Visualization",
                  icon: Pin,
                  disabledReason: !fieldId
                    ? "Response field payload is required to pin a 3D visualization"
                    : undefined,
                  onSelect: () => pinVisualization(),
                },
              ],
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Waves,
        title: () => selection.label || ref?.pointId || defaultTitle,
        kindLabel: isLegacyDsfPoint
          ? "Time-domain dynamical structure factor S(k, f) sample"
          : kindLabel,
        entityId: fieldId ?? ref?.pointId ?? undefined,
        statePill: () => ({
          tone: isLegacyDsfPoint ? "info" : fieldId ? "ok" : "neutral",
          label: isLegacyDsfPoint ? "DSF sample" : fieldId ? "3D field ready" : "Selected",
        }),
      },
      facts: () => [
        {
          id: "freq",
          label: "Drive frequency",
          value:
            typeof ref?.frequencyHz === "number"
              ? formatFrequencyHz(ref.frequencyHz)
              : "Published",
        },
        ...(typeof ref?.kPathCoordinateRadPerM === "number"
          ? [
              {
                id: "k",
                label: "Wavevector",
                value: `${(ref.kPathCoordinateRadPerM * 1e-6).toFixed(2)} rad/um`,
              },
            ]
          : []),
      ],
      sections: [
        ...(isLegacyDsfPoint
          ? [
              {
                id: "legacy-dsf",
                title: "DSF Sample Provenance",
                icon: GitCommit,
                defaultOpen: true,
                rows: [
                  {
                    type: "readonly" as const,
                    label: "Selected item",
                    mono: true,
                    format: () => ref?.pointId ?? selection.nodeId ?? "—",
                  },
                  {
                    type: "readonly" as const,
                    label: "Sample",
                    mono: true,
                    format: () => ref?.sampleId ?? "—",
                  },
                  {
                    type: "readonly" as const,
                    label: "Frequency",
                    mono: true,
                    format: () =>
                      typeof ref?.frequencyHz === "number" && Number.isFinite(ref.frequencyHz)
                        ? `${ref.frequencyHz.toExponential(6)} Hz`
                        : "—",
                  },
                  {
                    type: "readonly" as const,
                    label: "Frequency bin",
                    mono: true,
                    format: () =>
                      ref?.frequencyIndex != null ? String(ref.frequencyIndex) : "—",
                  },
                  {
                    type: "readonly" as const,
                    label: "Wavevector context",
                    format: () => ref?.kContextKind ?? "—",
                  },
                  {
                    type: "readonly" as const,
                    label: "Wavevector",
                    mono: true,
                    format: () =>
                      typeof ref?.kPathCoordinateRadPerM === "number" &&
                      Number.isFinite(ref.kPathCoordinateRadPerM)
                        ? `${ref.kPathCoordinateRadPerM.toExponential(6)} rad/m`
                        : "—",
                  },
                  {
                    type: "readonly" as const,
                    label: "Field payload",
                    format: () => "Not published by legacy reader",
                  },
                  {
                    type: "readonly" as const,
                    label: "Canonical dataset",
                    format: () => "Not published; keep this selection legacy/partial",
                  },
                  ...buildRefProvenanceRows(selection),
                ],
              },
            ]
          : [
              {
                id: "response-field-controls",
                title: "3D Harmonic Phase Animation & Response Field",
                icon: Play,
                defaultOpen: true,
                live: true,
                rows: [
                  {
                    type: "custom" as const,
                    label: "Harmonic phase",
                    wide: true,
                    render: () => (
                      <ModeHarmonicPhaseControls onPhaseChangeDeg={onPhaseChangeDeg} />
                    ),
                  },
                  ...(kernel
                    ? [
                        {
                          type: "custom" as const,
                          wide: true,
                          render: () => (
                            <div className="grid min-w-0 gap-3">
                              {isFieldResource ? (
                                <FrequencyResponseFieldResourceInspectorPanel
                                  selection={selection}
                                />
                              ) : null}
                              <FrequencyResponsePointInspectorPanel selection={selection} />
                            </div>
                          ),
                        },
                      ]
                    : []),
                  ...buildRefProvenanceRows(selection),
                ],
              },
            ]),
      ],
      commitBar: isLegacyDsfPoint
        ? { mode: "readOnly" }
        : {
            mode: "liveViewport",
            hasOverrides: () => false,
            onResetDisplay: () => {
              if (!kernel) return;
              void kernel.commands.execute(
                "analysis.frequency-domain.stop-3d-animation",
                createCommandContext("inspector", kernel),
              );
              kernel.analysisFieldOverlay?.update({ visualizationPhaseRad: 0 });
            },
          },
    }),
    [
      activateResponseFieldIn3D,
      breadcrumbsPrefix,
      defaultTitle,
      fieldId,
      idPrefix,
      isFieldResource,
      isLegacyDsfPoint,
      kernel,
      kindLabel,
      onPhaseChangeDeg,
      pinVisualization,
      ref,
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

export function ResonanceResponseFieldResultInspector({
  onPhaseChangeDeg,
  selection,
}: InspectorPanelProps & { onPhaseChangeDeg?: (deg: number) => void }) {
  return (
    <DrivenResponseFieldInspectorShared
      breadcrumbsPrefix={["Results", "Resonance & FMR"]}
      defaultTitle="Harmonic Response Field"
      idPrefix="results.resonance.driven.field"
      kindLabel="Steady-state spatial response delta_m(r, f)"
      selection={selection}
      onPhaseChangeDeg={onPhaseChangeDeg}
    />
  );
}
