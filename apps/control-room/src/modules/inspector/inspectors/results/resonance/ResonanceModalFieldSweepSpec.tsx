"use client";

import type { EChartsOption } from "echarts";
import {
  useContext,
  useMemo,
  useState,
} from "react";
import { KernelContext } from "@/kernel/KernelContext";
import {
  useFrequencyDomainEigenFieldSweepResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainResponseSweepResource,
} from "@/kernel/resources/studyRuntimeResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { navigatorFieldSweepFromResource } from "@/modules/results-navigator/public";
import { ScientificEChart, type ResolvedChartThemePalette } from "@/shared/charts/ScientificEChart";
import { buildFmrModalDrivenComparisonModel } from "@/shared/domain/analysis/frequencyDomainChartModels";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import { EigenFieldSweepInspectorPanel } from "../../../panels/frequency-domain/FrequencyDomainFieldSweepPanel";
import {
  FmrComparisonInspectorContent,
  FrequencyResponseCancelRequestedInspectorPanel,
  FrequencyResponseDiagnosticsInspectorPanel,
  FrequencyResponseOverviewInspectorPanel,
  FrequencyResponseProgressInspectorPanel,
  FrequencyResponseProvenanceInspectorPanel,
  FrequencyResponseStudyInspectorPanel,
} from "../../../panels/frequency-domain/FrequencyDomainResultInspectors";
import { ConnectedInspectorSpec } from "../../../panels/study/ConnectedInspectorSpec";
import {
  frequencyDomainRef,
  makeSimplePhysicsResultSpec,
  buildRefProvenanceRows,
  DEFAULT_SPECTRAL_RESULT_DRAFT,
} from "./resonanceShared";

export function ResonanceDrivenStageResultInspector({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const isCancelRequested =
    ref?.kind === "results.frequency_response.cancel_requested" ||
    Boolean(selection.nodeId?.includes("cancel-requested"));
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.resonance.driven.stage:${selection.nodeId ?? "stage"}`,
        breadcrumbs: ["Results", "Resonance & FMR", selection.label || "Driven Stage"],
        title: selection.label || "Driven Response Stage Result",
        kindLabel: "Harmonic frequency-response stage provenance",
        facts: [
          { id: "lane", label: "Lane", value: "Driven RF susceptibility" },
          { id: "regime", label: "Wavevector", value: "Gamma (k = 0)" },
        ],
        notices: ref?.contractGap
          ? () => [{ id: "gap", tone: "warn", text: ref.contractGap! }]
          : undefined,
        sectionTitle: "Excitation, Sweep Progress & Solver Provenance",
        rows: [
          {
            type: "readonly",
            label: "Harmonic convention",
            format: () => "exp(-i omega t) steady-state linear response",
          },
          ...buildRefProvenanceRows(selection),
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <div className="grid min-w-0 gap-3">
                      <FrequencyResponseStudyInspectorPanel selection={selection} />
                      <FrequencyResponseOverviewInspectorPanel selection={selection} />
                      <FrequencyResponseProgressInspectorPanel selection={selection} />
                      {isCancelRequested ? (
                        <FrequencyResponseCancelRequestedInspectorPanel selection={selection} />
                      ) : null}
                      <FrequencyResponseProvenanceInspectorPanel
                        canonicalFamily="FMR driven lane · A(0,f)"
                        linksTitle="FMR Driven Provenance Links"
                        selection={selection}
                        title="FMR Driven Provenance"
                      />
                      <FrequencyResponseDiagnosticsInspectorPanel selection={selection} />
                    </div>
                  ),
                },
              ]
            : []),
        ],
      }),
    [isCancelRequested, kernel, ref, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function ResonanceModalFieldSweepResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedResonanceModalFieldSweep {...props} />
  ) : (
    <ResonanceModalFieldSweepView {...props} sweepResource={null} />
  );
}

function ConnectedResonanceModalFieldSweep(props: InspectorPanelProps) {
  const sweepRes = useFrequencyDomainEigenFieldSweepResource();
  return (
    <ResonanceModalFieldSweepView
      {...props}
      sweepResource={sweepRes.data ?? null}
    />
  );
}

function FieldSweepFrequencyChart({
  samples,
}: {
  samples: NonNullable<ReturnType<typeof navigatorFieldSweepFromResource>>["samples"];
}) {
  const buildOption = useMemo(
    () => (palette: ResolvedChartThemePalette): EChartsOption => {
      const modeIndices = new Set<number>();
      for (const s of samples) {
        for (const m of s.modes) modeIndices.add(m.rawModeIndex);
      }
      const series = Array.from(modeIndices)
        .toSorted((a, b) => a - b)
        .map((mIdx, idx) => ({
          type: "line" as const,
          name: `Mode ${mIdx}`,
          showSymbol: true,
          symbolSize: 5,
          lineStyle: { color: palette.series[idx % palette.series.length] },
          data: samples.flatMap((s) => {
            const match = s.modes.find((m) => m.rawModeIndex === mIdx);
            if (!match || match.frequencyHz === null) return [];
            const bMt = s.biasFieldMu0T
              ? Math.hypot(...s.biasFieldMu0T) * 1e3
              : s.sampleIndex;
            return [[bMt, match.frequencyHz * 1e-9]];
          }),
        }));
      return {
        grid: { left: 48, right: 14, top: 18, bottom: 32 },
        xAxis: {
          type: "value",
          name: "mu0 |H| (mT)",
          nameLocation: "middle",
          nameGap: 22,
          splitLine: { lineStyle: { color: palette.borderSubtle } },
        },
        yAxis: {
          type: "value",
          name: "f (GHz)",
          splitLine: { lineStyle: { color: palette.borderSubtle } },
        },
        series,
      };
    },
    [samples],
  );

  if (samples.length === 0) return null;
  return (
    <ScientificEChart
      ariaLabel="Eigenfrequency bias-field sweep f_n(H)"
      height={190}
      optionBuilder={buildOption}
    />
  );
}

function ResonanceModalFieldSweepView({
  selection,
  sweepResource,
}: InspectorPanelProps & {
  sweepResource: ReturnType<typeof useFrequencyDomainEigenFieldSweepResource>["data"] | null;
}) {
  const kernel = useContext(KernelContext);
  const typedSweep = useMemo(
    () => navigatorFieldSweepFromResource(sweepResource ?? undefined),
    [sweepResource],
  );
  const [selectedSampleId, setSelectedSampleId] = useState<string | null>(null);
  const effectiveSelection = useMemo<Selection>(() => {
    if (!selectedSampleId) return selection;
    const baseRef = frequencyDomainRef(selection);
    return {
      ...selection,
      ref: {
        ...(baseRef ?? {
          kind: selection.kind ?? "results.resonance.modal.field_sweep",
          nodeId: selection.nodeId ?? "results:field-sweep",
          type: "frequency-domain" as const,
        }),
        sampleId: selectedSampleId,
      },
    };
  }, [selectedSampleId, selection]);

  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.resonance.modal.field_sweep:${selection.nodeId ?? "fsw"}`,
        breadcrumbs: ["Results", "Resonance & FMR", "Bias Field Sweep"],
        title: selection.label || "Modal Bias-Field Sweep f_n(H)",
        kindLabel: "Eigenfrequency evolution across static bias field",
        stateLabel: typedSweep ? "Published" : "Selected",
        facts: [
          { id: "regime", label: "Wavevector", value: "Gamma (k = 0)" },
          {
            id: "samples",
            label: "Samples",
            value: typedSweep ? String(typedSweep.samples.length) : "—",
          },
        ],
        sectionTitle: "Field-Dependent Mode Branches",
        rows: [
          {
            type: "readonly",
            label: "Continuation tracking",
            format: () =>
              "Tracks f_n(H) branches across bias-field steps for Kittel & soft-mode analysis",
          },
          ...(typedSweep && typedSweep.samples.length > 0
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <div className="grid gap-2">
                      <FieldSweepFrequencyChart samples={typedSweep.samples} />
                      <Select
                        value={
                          selectedSampleId ?? typedSweep.samples[0]?.sampleId ?? ""
                        }
                        onValueChange={setSelectedSampleId}
                      >
                        <SelectTrigger aria-label="Bias-field sample">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="fm-inspector-select-content">
                          {typedSweep.samples.map((smp) => (
                            <SelectItem key={smp.sampleId} value={smp.sampleId}>
                              {smp.sampleId}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
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
                    <EigenFieldSweepInspectorPanel selection={effectiveSelection} />
                  ),
                },
              ]
            : []),
        ],
      }),
    [effectiveSelection, kernel, selectedSampleId, selection.label, selection.nodeId, typedSweep],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function FrequencyDomainComparisonResultInspector(
  props: InspectorPanelProps,
) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedFrequencyDomainComparison {...props} />
  ) : (
    <FrequencyDomainComparisonView {...props} pairCount={0} />
  );
}

function ConnectedFrequencyDomainComparison(props: InspectorPanelProps) {
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const responseSweep = useFrequencyDomainResponseSweepResource();
  const cmpModel = useMemo(
    () =>
      buildFmrModalDrivenComparisonModel({
        responseSweep: responseSweep.data,
        spectrum: spectrum.data,
      }),
    [responseSweep.data, spectrum.data],
  );
  return (
    <FrequencyDomainComparisonView
      {...props}
      pairCount={cmpModel.pairs.length}
    />
  );
}

function FrequencyDomainComparisonView({
  pairCount,
  selection,
}: InspectorPanelProps & { pairCount: number }) {
  const kernel = useContext(KernelContext);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.frequency_domain.comparison:${selection.nodeId ?? "cmp"}`,
        breadcrumbs: ["Results", "Resonance & FMR", "Modal vs Driven Comparison"],
        title: selection.label || "Modal vs Driven Spectrum Comparison",
        kindLabel: "Cross-lane eigenfrequency and susceptibility alignment",
        stateLabel: pairCount > 0 ? `${pairCount} matched` : "Published",
        facts: [
          { id: "pairs", label: "Matched pairs", value: String(pairCount) },
          { id: "guard", label: "Compatibility", value: "Same equilibrium & mesh" },
        ],
        sectionTitle: "Cross-Validation & Overlay Comparison",
        rows: [
          {
            type: "readonly",
            label: "Alignment rule",
            format: () =>
              "Overlays FMR-active modal eigenfrequencies onto driven Im chi(f) peaks",
          },
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => <FmrComparisonInspectorContent selection={selection} />,
                },
              ]
            : []),
        ],
      }),
    [kernel, pairCount, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}
