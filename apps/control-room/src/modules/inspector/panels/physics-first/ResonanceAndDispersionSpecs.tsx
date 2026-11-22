"use client";

import type { EChartsOption } from "echarts";
import {
  Activity,
  Box,
  Compass,
  Download,
  GitBranch,
  GitCommit,
  LineChart,
  Pin,
  Play,
  Radar,
  Sparkles,
  Waves,
} from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";

import { PIN_MODE_VISUALIZATION_COMMAND } from "@/kernel/analysis-modules/postprocessingCommandContributions";
import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  useFrequencyDomainEigenBranchesResource,
  useFrequencyDomainEigenDispersionResource,
  useFrequencyDomainEigenFieldSweepResource,
  useFrequencyDomainEigenModeFieldMetaResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainFmrKittelFitResource,
  useFrequencyDomainFmrResonanceFitsResource,
  useFrequencyDomainManifestResource,
  useFrequencyDomainResponseFieldMetaResource,
  useFrequencyDomainResponseSweepResource,
} from "@/kernel/resources/studyRuntimeResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { navigatorFieldSweepFromResource } from "@/modules/results-navigator/public";
import {
  minMaxFinite,
  ScientificEChart,
  type ResolvedChartThemePalette,
} from "@/shared/charts/ScientificEChart";
import {
  buildEigenBranchesModel,
  buildEigenDispersionChartModel,
  buildEigenDispersionPointSelectionRef,
  buildEigenSpectrumChartModel,
  buildFmrModalDrivenComparisonModel,
  buildFmrPeakTableModel,
  buildFrequencyResponseChartModel,
  buildFrequencyResponsePointSelectionRef,
  eigenModeFieldAvailable,
  frequencyDomainManifestPayload,
  type EigenBranch,
  type EigenDispersionPoint,
  type FrequencyResponsePoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import { Button } from "@/shared/ui/Button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Slider } from "@/shared/ui/Slider";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorRowSpec, InspectorSpec } from "../../template";
import { ReferenceImportSection } from "../analysis-results/ReferenceImportSection";
import { EigenBranchInspectorPanel } from "../frequency-domain/EigenBranchInspectorPanel";
import { EigenDispersionInspectorPanel } from "../frequency-domain/EigenDispersionInspectorPanel";
import { EigenModeInspectorPanel } from "../frequency-domain/EigenModeInspectorPanel";
import { FmrModalSpectrumInspectorPanel } from "../frequency-domain/FmrModalSpectrumInspectorPanel";
import { FmrResponseSweepInspectorPanel } from "../frequency-domain/FmrResponseSweepInspectorPanel";
import { EigenFieldSweepInspectorPanel } from "../frequency-domain/FrequencyDomainFieldSweepPanel";
import {
  EigenBranchesInspectorPanel,
  EigenDiagnosticsInspectorPanel,
  EigenKPathInspectorPanel,
  EigenModeFieldResourceInspectorPanel,
  EigenModesInspectorPanel,
  EigenModesVisualizationInspectorPanel,
  EigenOverviewInspectorPanel,
  EigenProvenanceInspectorPanel,
  EigenSpectrumInspectorPanel,
  EigenStudyInspectorPanel,
  FmrComparisonInspectorContent,
  FmrOverviewInspectorPanel,
  FmrPeakInspectorPanel,
  FmrPeaksInspectorPanel,
  FrequencyDomainCalculationModesInspectorPanel,
  FrequencyDomainDispersionInspectorPanel,
  FrequencyDomainOverviewInspectorPanel,
  FrequencyDomainResponseMapInspectorPanel,
  FrequencyDomainRunInspectorPanel,
  FrequencyResponseCancelRequestedInspectorPanel,
  FrequencyResponseDiagnosticsInspectorPanel,
  FrequencyResponseFieldResourceInspectorPanel,
  FrequencyResponseFieldsInspectorPanel,
  FrequencyResponseFrequencyPointsInspectorPanel,
  FrequencyResponseObservableInspectorPanel,
  FrequencyResponseObservablesInspectorPanel,
  FrequencyResponseOverviewInspectorPanel,
  FrequencyResponsePointInspectorPanel,
  FrequencyResponseProgressInspectorPanel,
  FrequencyResponseProvenanceInspectorPanel,
  FrequencyResponseStudyInspectorPanel,
  FrequencyResponseSweepInspectorPanel,
} from "../frequency-domain/FrequencyDomainResultInspectors";
import { buildFrequencyResponsePlotCommandInput } from "../frequency-domain/FrequencyResponseInspectorPanels.model";
import {
  FrequencyDomainResponseChart,
  FrequencyDomainSpectrumChart,
} from "../FrequencyDomainCharts";
import { FrequencyDomainBranchTable } from "../FrequencyDomainTables";
import { ConnectedInspectorSpec } from "../study/ConnectedInspectorSpec";

interface ReadOnlySpectralResultDraft {
  phaseDeg: number;
  animateMode: boolean;
  animationSpeedHz: number;
  amplitudeScale: number;
  displayObservable: string;
}

const DEFAULT_SPECTRAL_RESULT_DRAFT: ReadOnlySpectralResultDraft = {
  phaseDeg: 0,
  animateMode: false,
  animationSpeedHz: 1,
  amplitudeScale: 0.15,
  displayObservable: "amplitude",
};

const DISPERSION_POINT_KINDS = new Set([
  "results.dispersion.modal.relation",
  "results.dispersion.modal.branches",
  "results.dispersion.modal.mode_at_k",
  "results.eigen.dispersion",
]);

function copyCsvText(csv: string): void {
  void navigator.clipboard?.writeText(csv).catch(() => undefined);
}

function frequencyDomainRef(selection: Selection) {
  return selection.ref?.type === "frequency-domain" ? selection.ref : null;
}

const OMITTED_STATUS_FACET_RE = /^(?:unavail\w*|unkn\w*|n\/a)$/i;

function buildRefProvenanceRows(
  selection: Selection,
): InspectorRowSpec<ReadOnlySpectralResultDraft>[] {
  const ref = frequencyDomainRef(selection);
  if (!ref) return [];
  return [
    ...(ref.availability && !OMITTED_STATUS_FACET_RE.test(ref.availability.trim())
      ? [
          {
            type: "readonly" as const,
            label: "Availability",
            format: () => ref.availability!,
          },
        ]
      : []),
    ...(ref.executionState && !OMITTED_STATUS_FACET_RE.test(ref.executionState.trim())
      ? [
          {
            type: "readonly" as const,
            label: "Execution state",
            format: () => ref.executionState!,
          },
        ]
      : []),
    ...(ref.resourceState && !OMITTED_STATUS_FACET_RE.test(ref.resourceState.trim())
      ? [
          {
            type: "readonly" as const,
            label: "Resource state",
            format: () => ref.resourceState!,
          },
        ]
      : []),
    ...(ref.studyProduct
      ? [
          {
            type: "readonly" as const,
            label: "Study product",
            format: () => ref.studyProduct!,
          },
        ]
      : []),
    ...(ref.kContextKind
      ? [
          {
            type: "readonly" as const,
            label: "k context",
            format: () => ref.kContextKind!,
          },
        ]
      : []),
    ...(ref.analysisRunId
      ? [
          {
            type: "readonly" as const,
            label: "Run",
            mono: true,
            format: () => ref.analysisRunId!,
          },
        ]
      : []),
    ...(ref.analysisStageId
      ? [
          {
            type: "readonly" as const,
            label: "Stage",
            mono: true,
            format: () => ref.analysisStageId!,
          },
        ]
      : []),
    ...(ref.equilibriumId
      ? [
          {
            type: "readonly" as const,
            label: "Equilibrium",
            mono: true,
            format: () => ref.equilibriumId!,
          },
        ]
      : []),
    ...(ref.normalization
      ? [
          {
            type: "readonly" as const,
            label: "Normalization",
            mono: true,
            format: () => ref.normalization!,
          },
        ]
      : []),
    ...(ref.artifactRevision != null
      ? [
          {
            type: "readonly" as const,
            label: "Artifact revision",
            mono: true,
            format: () => String(ref.artifactRevision),
          },
        ]
      : []),
    ...(ref.resourceRef
      ? [
          {
            type: "readonly" as const,
            label: "Resource",
            mono: true,
            format: () => ref.resourceRef!,
          },
        ]
      : []),
    ...(ref.contractGap
      ? [
          {
            type: "readonly" as const,
            label: "Contract gap",
            format: () => ref.contractGap!,
          },
        ]
      : []),
  ];
}

export function resolveSelectedDispersionPoint(
  selection: Selection,
  points: readonly EigenDispersionPoint[],
): EigenDispersionPoint | null {
  if (!selection.kind || !DISPERSION_POINT_KINDS.has(selection.kind)) return null;
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  if (ref?.sampleIndex == null || ref.modeIndex == null) return null;
  return (
    points.find(
      (pt) =>
        pt.sampleIndex === ref.sampleIndex && pt.rawModeIndex === ref.modeIndex,
    ) ?? null
  );
}

export function estimateGroupVelocityMPerS(
  points: readonly EigenDispersionPoint[],
  target: EigenDispersionPoint,
): number | null {
  const branchPts = points
    .filter((pt) =>
      target.branchId
        ? pt.branchId === target.branchId
        : pt.rawModeIndex === target.rawModeIndex,
    )
    .toSorted((a, b) => a.pathS - b.pathS);
  const idx = branchPts.findIndex(
    (pt) =>
      pt.sampleIndex === target.sampleIndex &&
      pt.rawModeIndex === target.rawModeIndex,
  );
  if (idx < 0 || branchPts.length < 2) return null;
  const left = branchPts[Math.max(0, idx - 1)]!;
  const right = branchPts[Math.min(branchPts.length - 1, idx + 1)]!;
  const dk = right.pathS - left.pathS;
  if (!Number.isFinite(dk) || Math.abs(dk) < 1e-12) return null;
  const dOmega = 2 * Math.PI * (right.frequencyHz - left.frequencyHz);
  return dOmega / dk;
}

function BranchDispersionAndGroupVelocityChart({
  onSelectPoint,
  points,
}: {
  onSelectPoint?: (pt: EigenDispersionPoint) => void;
  points: readonly EigenDispersionPoint[];
}) {
  const grouped = useMemo(() => {
    const groups = new Map<string, EigenDispersionPoint[]>();
    for (const pt of points) {
      const key = pt.branchId ?? `mode_${pt.rawModeIndex}`;
      const list = groups.get(key) ?? [];
      list.push(pt);
      groups.set(key, list);
    }
    return Array.from(groups.entries()).map(([key, pts]) => ({
      key,
      points: pts.toSorted((a, b) => a.pathS - b.pathS),
    }));
  }, [points]);

  const buildOption = useMemo(
    () => (palette: ResolvedChartThemePalette): EChartsOption => {
      const dispSeries = grouped.map((group, idx) => ({
        type: "line" as const,
        name: group.key,
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: group.points.map((pt) => ({
          point: pt,
          value: [pt.pathS * 1e-6, pt.frequencyHz * 1e-9],
        })),
        showSymbol: true,
        symbolSize: 5,
        lineStyle: { color: palette.series[idx % palette.series.length] },
      }));
      const vgSeries = grouped.map((group, idx) => ({
        type: "line" as const,
        name: `${group.key} vg`,
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: group.points.flatMap((pt) => {
          const vg = estimateGroupVelocityMPerS(group.points, pt);
          return vg === null ? [] : [[pt.pathS * 1e-6, vg * 1e-3]];
        }),
        showSymbol: false,
        lineStyle: {
          color: palette.series[(idx + 1) % palette.series.length],
          type: "dashed" as const,
        },
      }));
      return {
        grid: [
          { left: 48, right: 14, top: 18, height: "38%" },
          { left: 48, right: 14, top: "62%", height: "28%" },
        ],
        xAxis: [
          {
            type: "value",
            gridIndex: 0,
            axisLabel: { show: false },
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
          {
            type: "value",
            gridIndex: 1,
            name: "k (rad/um)",
            nameLocation: "middle",
            nameGap: 22,
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
        ],
        yAxis: [
          {
            type: "value",
            gridIndex: 0,
            name: "f (GHz)",
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
          {
            type: "value",
            gridIndex: 1,
            name: "vg (km/s)",
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
        ],
        series: [...dispSeries, ...vgSeries],
      };
    },
    [grouped],
  );

  if (points.length === 0) {
    return (
      <EmptyState
        description="Run a k-path Eigenmodes stage to populate f_n(k) and group velocity vg(k)."
        heading="No dispersion points recorded"
      />
    );
  }
  return (
    <ScientificEChart
      ariaLabel="Spin-wave dispersion f(k) and group velocity vg(k)"
      height={220}
      optionBuilder={buildOption}
      onPointSelect={(params) => {
        if (!onSelectPoint) return;
        const group = grouped[params.seriesIndex];
        const pt = group?.points[params.dataIndex];
        if (pt) onSelectPoint(pt);
      }}
    />
  );
}

function ModeHarmonicPhaseControls({
  onPhaseChangeDeg,
}: {
  onPhaseChangeDeg?: (deg: number) => void;
}) {
  const kernel = useContext(KernelContext);
  const [phaseDeg, setPhaseDeg] = useState(0);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    if (!animating || typeof requestAnimationFrame === "undefined") return;
    let rafId = 0;
    const step = () => {
      setPhaseDeg((prev) => {
        const next = (prev + 3) % 360;
        onPhaseChangeDeg?.(next);
        kernel?.analysisFieldOverlay?.update({
          visualizationPhaseRad: (next * Math.PI) / 180,
        });
        return next;
      });
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [animating, kernel, onPhaseChangeDeg]);

  const applyPhase = (deg: number) => {
    const clamped = ((deg % 360) + 360) % 360;
    setPhaseDeg(clamped);
    onPhaseChangeDeg?.(clamped);
    // Pure local GPU/overlay phase rotation — zero HTTP fetches!
    kernel?.analysisFieldOverlay?.update({
      visualizationPhaseRad: (clamped * Math.PI) / 180,
    });
  };

  return (
    <div className="rounded border border-fm-border p-2.5 grid gap-2.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Animate 3D Mode Shape</span>
        <Switch
          aria-label="Animate 3D Mode Shape"
          checked={animating}
          onCheckedChange={setAnimating}
        />
      </div>
      <div className="grid gap-1">
        <div className="flex items-center justify-between tabular-nums">
          <span className="text-fm-muted">Harmonic phase Re(delta_m · e^(-i phi))</span>
          <span>{phaseDeg.toFixed(0)} deg</span>
        </div>
        <Slider
          aria-label="Harmonic phase angle"
          max={360}
          min={0}
          step={1}
          value={[phaseDeg]}
          valueText={(v) => `${v} degrees`}
          onValueChange={(vals) => applyPhase(vals[0] ?? 0)}
        />
      </div>
    </div>
  );
}

function makeSimplePhysicsResultSpec({
  breadcrumbs,
  commitMode = "readOnly",
  extraMenuActions,
  facts,
  id,
  kindLabel,
  notices,
  onResetDisplay,
  primaryHeaderAction,
  rows,
  sectionTitle,
  stateLabel = "Published",
  title,
}: {
  breadcrumbs: readonly string[];
  commitMode?: "readOnly" | "liveViewport";
  extraMenuActions?: InspectorSpec<ReadOnlySpectralResultDraft>["header"]["extraMenuActions"];
  facts: ReadonlyArray<{ id: string; label: string; value: string }>;
  id: string;
  kindLabel: string;
  notices?: InspectorSpec<ReadOnlySpectralResultDraft>["notices"];
  onResetDisplay?: () => void;
  primaryHeaderAction?: InspectorSpec<ReadOnlySpectralResultDraft>["header"]["primaryHeaderAction"];
  rows: InspectorSpec<ReadOnlySpectralResultDraft>["sections"][number]["rows"];
  sectionTitle: string;
  stateLabel?: string;
  title: string;
}): InspectorSpec<ReadOnlySpectralResultDraft> {
  return {
    id,
    header: {
      breadcrumbs: breadcrumbs.map((b, idx) => ({ id: `b-${idx}`, label: b })),
      ...(primaryHeaderAction ? { primaryHeaderAction } : {}),
      ...(extraMenuActions ? { extraMenuActions } : {}),
    },
    identity: {
      domain: "physics",
      icon: Waves,
      title: () => title,
      kindLabel,
      statePill: () => ({ tone: "ok", label: stateLabel }),
    },
    facts: () => facts,
    ...(notices ? { notices } : {}),
    sections: [
      {
        id: "primary",
        title: sectionTitle,
        icon: Activity,
        defaultOpen: true,
        live: commitMode === "liveViewport",
        rows,
      },
    ],
    commitBar:
      commitMode === "liveViewport"
        ? {
            mode: "liveViewport",
            hasOverrides: () => false,
            onResetDisplay: () => onResetDisplay?.(),
          }
        : { mode: "readOnly" },
  };
}

export function ResultsOverviewInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const isFrequencyDomainRun =
    ref?.kind === "results.frequency_domain.run" ||
    Boolean(selection.nodeId?.includes("frequency-domain:run"));
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.root:${selection.nodeId ?? "root"}`,
        breadcrumbs: ["Results", "Overview"],
        title: selection.label || "Results",
        kindLabel: "Physics-first simulation outputs",
        facts: [
          { id: "families", label: "Families", value: "Dynamics · Resonance · Dispersion" },
          { id: "storage", label: "Format", value: "Zarr v3 & JSON manifests" },
        ],
        sectionTitle: isFrequencyDomainRun
          ? "Frequency-Domain Run & Result Families"
          : "Published Result Families",
        rows: [
          ...(kernel && isFrequencyDomainRun
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => <FrequencyDomainRunInspectorPanel selection={selection} />,
                },
              ]
            : []),
          {
            type: "readonly",
            label: "Context node",
            mono: true,
            format: () => selection.nodeId ?? "—",
          },
          {
            type: "readonly",
            label: "Time-domain dynamics",
            format: () => "Observation frames, scalar tables, and FFT spectra",
          },
          {
            type: "readonly",
            label: "Linearized spectra",
            format: () => "Modal eigenfrequencies, driven FMR susceptibility, and k-resolved dispersion",
          },
          {
            type: "readonly",
            label: "Selection source",
            format: () => selection.moduleSource,
          },
          ...buildRefProvenanceRows(selection),
        ],
      }),
    [isFrequencyDomainRun, kernel, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export const ResultsRootTemplateInspectorPanel = ResultsOverviewInspectorPanel;

export function DynamicsResultTemplateInspector({ selection }: InspectorPanelProps) {
  const ref = frequencyDomainRef(selection);
  const isLegacySpectralFeature =
    ref?.kind === "results.time_domain.spectral_feature" || Boolean(ref?.pointId);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.dynamics.root:${selection.nodeId ?? "dyn"}`,
        breadcrumbs: ["Results", "Dynamics"],
        title: selection.label || "Dynamics",
        kindLabel: isLegacySpectralFeature
          ? "Legacy time-domain spectral feature"
          : "Time-domain trajectories & observation frames",
        facts: [
          { id: "axis", label: "Primary axis", value: "Physical time t (s)" },
          { id: "handoff", label: "Spectral handoff", value: "Windowed FFT" },
          ...(typeof ref?.frequencyHz === "number"
            ? [{ id: "freq", label: "Frequency", value: formatFrequencyHz(ref.frequencyHz) }]
            : []),
        ],
        notices: ref?.contractGap
          ? () => [{ id: "gap", tone: "warn", text: ref.contractGap! }]
          : undefined,
        sectionTitle: "Time-domain observables & spectral handoff",
        rows: [
          ...(isLegacySpectralFeature
            ? [
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
                  label: "Source artifact",
                  mono: true,
                  format: () => ref?.artifactPath ?? "time-domain FFT",
                },
              ]
            : []),
          {
            type: "readonly",
            label: "Primary axis",
            format: () => "Time t; published SI/display unit is shown by the dataset",
          },
          {
            type: "readonly",
            label: "Published traces",
            format: () => "Magnetization <m>, energy terms, and max torque",
          },
          {
            type: "readonly",
            label: "Saved 3D states",
            format: () => "State snapshots appear when runtime publishes observation frames",
          },
          {
            type: "readonly",
            label: "Temporal Spectrum",
            format: () => "FFT of a published time trace; distinct from linearized eigenmodes",
          },
          {
            type: "readonly",
            label: "Spin-Wave Spectrum",
            format: () => "S(k, f) when wavevector-resolved samples are published",
          },
          ...buildRefProvenanceRows(selection),
        ],
      }),
    [isLegacySpectralFeature, ref, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function ResonanceOverviewResultInspector({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const isCalcModes =
    ref?.kind === "results.frequency_domain.calculation_modes" ||
    Boolean(selection.nodeId?.includes("calculation-modes"));
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.resonance.root:${selection.nodeId ?? "res"}`,
        breadcrumbs: ["Results", "Resonance & FMR"],
        title: selection.label || "Resonance & FMR",
        kindLabel: "Uniform & confined k = 0 spectral products",
        facts: [
          { id: "modal", label: "Modal lane", value: "Eigenfrequencies & modes" },
          { id: "driven", label: "Driven lane", value: "Harmonic susceptibility chi(f)" },
        ],
        notices: ref?.contractGap
          ? () => [{ id: "gap", tone: "warn", text: ref.contractGap! }]
          : undefined,
        sectionTitle: "Resonance Product Overview & FMR Workbench",
        rows: [
          {
            type: "readonly",
            label: "Modal lane",
            format: () =>
              "Eigenfrequency Spectrum and complex Mode Shapes linearized about equilibrium",
          },
          {
            type: "readonly",
            label: "Driven lane",
            format: () =>
              "FMR Response Spectrum when RF magnetic drive & observable evidence are published",
          },
          {
            type: "readonly",
            label: "FMR naming gate",
            format: () => "Requires published RF excitation or modal coupling evidence",
          },
          {
            type: "readonly",
            label: "Comparison boundary",
            format: () =>
              "Matching equilibrium, geometry/mesh, k context, units, and observable definition",
          },
          ...buildRefProvenanceRows(selection),
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <div className="grid min-w-0 gap-3">
                      {isCalcModes ? (
                        <FrequencyDomainCalculationModesInspectorPanel selection={selection} />
                      ) : null}
                      <FrequencyDomainOverviewInspectorPanel selection={selection} />
                      <FmrOverviewInspectorPanel selection={selection} />
                    </div>
                  ),
                },
              ]
            : []),
        ],
      }),
    [isCalcModes, kernel, ref, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function ResonanceModalStageResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedResonanceModalStageResultInspector {...props} />
  ) : (
    <ResonanceModalStageResultView {...props} hasManifest={false} />
  );
}

function ConnectedResonanceModalStageResultInspector(props: InspectorPanelProps) {
  const manifest = useFrequencyDomainManifestResource();
  return (
    <ResonanceModalStageResultView
      {...props}
      hasManifest={Boolean(manifest.data?.result_manifest?.payload)}
    />
  );
}

function ResonanceModalStageResultView({
  hasManifest,
  selection,
}: InspectorPanelProps & { hasManifest: boolean }) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const rev = hasManifest ? "Verified" : "Ready";
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.resonance.modal.stage:${selection.nodeId ?? "stage"}`,
        breadcrumbs: ["Results", "Resonance & FMR", selection.label || "Modal Stage"],
        title: selection.label || "Modal Eigenmodes Stage Result",
        kindLabel: "Linearized modal stage provenance",
        stateLabel: rev,
        facts: [
          { id: "lane", label: "Lane", value: "Modal eigenmodes (k = 0)" },
          { id: "manifest", label: "Manifest", value: rev },
        ],
        notices: ref?.contractGap
          ? () => [{ id: "gap", tone: "warn", text: ref.contractGap! }]
          : undefined,
        sectionTitle: "Equilibrium, Study Contract & Operator Provenance",
        rows: [
          {
            type: "readonly",
            label: "Operator",
            format: () => "Linearized LLG tangent-plane operator",
          },
          ...buildRefProvenanceRows(selection),
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <div className="grid min-w-0 gap-3">
                      <EigenStudyInspectorPanel selection={selection} />
                      <EigenOverviewInspectorPanel selection={selection} />
                      <EigenProvenanceInspectorPanel
                        canonicalFamily="FMR modal lane · k = 0"
                        linksTitle="FMR Modal Provenance Links"
                        selection={selection}
                        title="FMR Modal Provenance"
                      />
                      <EigenDiagnosticsInspectorPanel selection={selection} />
                    </div>
                  ),
                },
              ]
            : []),
        ],
      }),
    [kernel, ref, rev, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

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

export function ResonanceModalSpectrumResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedResonanceModalSpectrumResultInspector {...props} />
  ) : (
    <ResonanceModalSpectrumResultView {...props} spectrumData={null} />
  );
}

function ConnectedResonanceModalSpectrumResultInspector(props: InspectorPanelProps) {
  const spectrumRes = useFrequencyDomainEigenSpectrumResource();
  return (
    <ResonanceModalSpectrumResultView
      {...props}
      spectrumData={spectrumRes.data ?? null}
    />
  );
}

function ResonanceModalSpectrumResultView({
  selection,
  spectrumData,
}: InspectorPanelProps & { spectrumData: Parameters<typeof buildEigenSpectrumChartModel>[0] }) {
  const kernel = useContext(KernelContext);
  const model = useMemo(
    () => buildEigenSpectrumChartModel(spectrumData),
    [spectrumData],
  );
  const bounds = useMemo(
    () => minMaxFinite(model.points.map((p) => p.frequencyHz)),
    [model.points],
  );

  const exportSpectrumCsv = useCallback(() => {
    const header =
      "sample_index,raw_mode_index,frequency_hz,imaginary_frequency_hz,damping_rate_hz,residual_norm,mode_field_id";
    const rows = model.points.map((pt) =>
      [
        pt.sampleIndex,
        pt.rawModeIndex,
        pt.frequencyHz,
        pt.imaginaryFrequencyHz ?? "",
        pt.dampingRateHz ?? "",
        pt.residualNorm ?? "",
        pt.modeFieldId ?? "",
      ].join(","),
    );
    copyCsvText([header, ...rows].join("\n"));
  }, [model.points]);

  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.resonance.modal.spectrum:${selection.nodeId ?? "spec"}`,
        breadcrumbs: ["Results", "Resonance & FMR", "Eigenfrequency Spectrum"],
        title: selection.label || "Eigenfrequency Spectrum",
        kindLabel: "Modal eigenfrequencies & damping linewidths",
        extraMenuActions: [
          {
            id: "export-spectrum-csv",
            label: "Export Spectrum CSV",
            icon: Download,
            disabledReason:
              model.points.length === 0 ? "No solved eigenmodes to export" : undefined,
            onSelect: () => exportSpectrumCsv(),
          },
        ],
        facts: [
          { id: "count", label: "Modes", value: String(model.points.length) },
          {
            id: "span",
            label: "Frequency span",
            value: bounds
              ? `${formatFrequencyHz(bounds.min)} – ${formatFrequencyHz(bounds.max)}`
              : "—",
          },
        ],
        sectionTitle: "Modal Spectrum Workbench",
        rows: [
          {
            type: "readonly",
            label: "Computed eigenmodes",
            format: () => `${model.points.length} modes ranked by Re(f)`,
          },
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <div className="grid min-w-0 gap-3">
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={model.points.length === 0}
                          disabledReason="No solved eigenmodes to export"
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={exportSpectrumCsv}
                        >
                          <Download aria-hidden="true" size={13} />
                          <span>Export Spectrum CSV</span>
                        </Button>
                      </div>
                      <EigenSpectrumInspectorPanel selection={selection} />
                      <FmrModalSpectrumInspectorPanel selection={selection} />
                      <ReferenceImportSection />
                    </div>
                  ),
                },
              ]
            : model.points.length > 0
              ? [
                  {
                    type: "custom" as const,
                    label: "Eigenfrequency spectrum",
                    wide: true,
                    render: () => <FrequencyDomainSpectrumChart model={model} />,
                  },
                ]
              : []),
        ],
      }),
    [bounds, exportSpectrumCsv, kernel, model, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function ResonanceModeShapesResultInspector({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.resonance.modal.modes:${selection.nodeId ?? "modes"}`,
        breadcrumbs: ["Results", "Resonance & FMR", "Mode Shapes"],
        title: selection.label || "Spatial Mode Shapes",
        kindLabel: "Complex eigenvector catalog",
        commitMode: "liveViewport",
        onResetDisplay: () => {
          if (!kernel) return;
          void kernel.commands.execute(
            "analysis.frequency-domain.stop-3d-animation",
            createCommandContext("inspector", kernel),
          );
          kernel.analysisFieldOverlay?.update({ visualizationPhaseRad: 0 });
        },
        facts: [{ id: "encoding", label: "Encoding", value: "Complex tangent vector" }],
        sectionTitle: "3D Mode Profiles & Eigenmode Browser",
        rows: [
          {
            type: "custom",
            label: "Harmonic phase preview",
            wide: true,
            render: () => <ModeHarmonicPhaseControls />,
          },
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <div className="grid min-w-0 gap-3">
                      <EigenModesInspectorPanel selection={selection} />
                      <EigenModesVisualizationInspectorPanel selection={selection} />
                    </div>
                  ),
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

function ModalModeResultInspectorShared(props: {
  breadcrumbsPrefix: readonly [string, string];
  defaultTitle: string;
  idPrefix: string;
  kindLabel: string;
  onPhaseChangeDeg?: (deg: number) => void;
  selection: Selection;
}) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedModalModeResultInspectorShared {...props} />;
  }
  return <ModalModeResultInspectorView {...props} resolvedFieldId={frequencyDomainRef(props.selection)?.fieldId ?? null} />;
}

function ConnectedModalModeResultInspectorShared(props: {
  breadcrumbsPrefix: readonly [string, string];
  defaultTitle: string;
  idPrefix: string;
  kindLabel: string;
  onPhaseChangeDeg?: (deg: number) => void;
  selection: Selection;
}) {
  const ref = frequencyDomainRef(props.selection);
  const sampleIndex = ref?.sampleIndex ?? null;
  const modeIndex = ref?.modeIndex ?? null;
  const fieldMeta = useFrequencyDomainEigenModeFieldMetaResource(sampleIndex, modeIndex);
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const resolvedFieldId = useMemo(() => {
    if (ref?.fieldId) return ref.fieldId;
    if (fieldMeta.data?.field_id) return fieldMeta.data.field_id;
    const pts = buildEigenSpectrumChartModel(spectrum.data).points;
    const matched = pts.find(
      (pt) => pt.sampleIndex === sampleIndex && pt.rawModeIndex === modeIndex,
    );
    return matched && eigenModeFieldAvailable(matched) ? matched.modeFieldId ?? null : null;
  }, [fieldMeta.data?.field_id, modeIndex, ref?.fieldId, sampleIndex, spectrum.data]);

  return <ModalModeResultInspectorView {...props} resolvedFieldId={resolvedFieldId} />;
}

function ModalModeResultInspectorView({
  breadcrumbsPrefix,
  defaultTitle,
  idPrefix,
  kindLabel,
  onPhaseChangeDeg,
  resolvedFieldId,
  selection,
}: {
  breadcrumbsPrefix: readonly [string, string];
  defaultTitle: string;
  idPrefix: string;
  kindLabel: string;
  onPhaseChangeDeg?: (deg: number) => void;
  resolvedFieldId: string | null;
  selection: Selection;
}) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const fieldId = resolvedFieldId;
  const isModeFieldResource = ref?.kind === "results.eigen.mode_field";

  const activateModeIn3D = useCallback(async () => {
    if (!kernel || !fieldId) return;
    await kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, { sourceDetail: idPrefix }),
      {
        fieldId,
        label: selection.label || defaultTitle,
        phaseRad: 0,
        source: "eigen-mode",
        view: "phase_rotated_real",
      },
    );
  }, [defaultTitle, fieldId, idPrefix, kernel, selection.label]);

  const pinModeVisualization = useCallback(() => {
    if (!kernel || !fieldId) return;
    void kernel.commands.execute(
      PIN_MODE_VISUALIZATION_COMMAND,
      createCommandContext("inspector", kernel, { sourceDetail: idPrefix }),
    );
  }, [fieldId, idPrefix, kernel]);

  const spec = useMemo<InspectorSpec<ReadOnlySpectralResultDraft>>(
    () => ({
      id: `${idPrefix}:${selection.nodeId ?? "mode"}`,
      header: {
        breadcrumbs: [
          { id: "b0", label: breadcrumbsPrefix[0] },
          { id: "b1", label: breadcrumbsPrefix[1] },
          { id: "mode", label: selection.label || defaultTitle },
        ],
        ...(kernel
          ? {
              ...(fieldId
                ? {
                    primaryHeaderAction: {
                      label: "Load in 3D",
                      icon: Box,
                      onRun: activateModeIn3D,
                    },
                  }
                : {}),
              extraMenuActions: [
                {
                  id: "pin-mode-viz",
                  label: "Pin Mode Visualization",
                  icon: Pin,
                  disabledReason: !fieldId
                    ? "Mode field payload is required to pin a 3D visualization"
                    : undefined,
                  onSelect: () => pinModeVisualization(),
                },
              ],
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Sparkles,
        title: () =>
          selection.label ||
          (ref?.modeIndex != null ? `Eigenmode #${ref.modeIndex + 1}` : defaultTitle),
        kindLabel,
        entityId: fieldId ?? ref?.modeId ?? undefined,
        statePill: () => ({
          tone: fieldId ? "ok" : "neutral",
          label: fieldId ? "3D field ready" : "Selected",
        }),
      },
      facts: () => [
        {
          id: "freq",
          label: "Frequency",
          value:
            typeof ref?.frequencyHz === "number"
              ? formatFrequencyHz(ref.frequencyHz)
              : "Published",
        },
        {
          id: "mode-idx",
          label: "Mode index",
          value: ref?.modeIndex != null ? String(ref.modeIndex + 1) : "1",
        },
        ...(ref?.sampleIndex != null
          ? [{ id: "sample", label: "Sample", value: String(ref.sampleIndex) }]
          : []),
      ],
      sections: [
        {
          id: "phase-animation",
          title: "3D Mode Shape Animation & Controls",
          icon: Play,
          defaultOpen: true,
          live: true,
          rows: [
            {
              type: "custom",
              label: "GPU harmonic phase rotation",
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
                        {isModeFieldResource ? (
                          <EigenModeFieldResourceInspectorPanel selection={selection} />
                        ) : null}
                        <EigenModeInspectorPanel selection={selection} />
                      </div>
                    ),
                  },
                ]
              : []),
            ...buildRefProvenanceRows(selection),
          ],
        },
      ],
      commitBar: {
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
      activateModeIn3D,
      breadcrumbsPrefix,
      defaultTitle,
      fieldId,
      idPrefix,
      isModeFieldResource,
      kernel,
      kindLabel,
      onPhaseChangeDeg,
      pinModeVisualization,
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

export function ResonanceModalModeResultInspector({
  onPhaseChangeDeg,
  selection,
}: InspectorPanelProps & { onPhaseChangeDeg?: (deg: number) => void }) {
  return (
    <ModalModeResultInspectorShared
      breadcrumbsPrefix={["Results", "Resonance & FMR"]}
      defaultTitle="Mode Shape"
      idPrefix="results.resonance.modal.mode"
      kindLabel="Complex spatial eigenmode profile"
      selection={selection}
      onPhaseChangeDeg={onPhaseChangeDeg}
    />
  );
}

export function ResonanceModalCouplingResultInspector({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.resonance.modal.coupling:${selection.nodeId ?? "cpl"}`,
        breadcrumbs: ["Results", "Resonance & FMR", "RF Coupling"],
        title: selection.label || "Modal RF Coupling & Oscillator Strength",
        kindLabel: "Uniform drive overlap |<h_rf | delta_m>|^2",
        facts: [
          { id: "gate", label: "Qualification", value: "FMR-active overlap" },
          { id: "obs", label: "Observable", value: ref?.observableId ?? "rf coupling" },
        ],
        notices: ref?.contractGap
          ? () => [{ id: "gap", tone: "warn", text: ref.contractGap! }]
          : undefined,
        sectionTitle: "Published RF Coupling Weights",
        rows: [
          {
            type: "readonly",
            label: "Observable evidence",
            mono: true,
            format: () => ref?.observableId ?? "rf coupling observable",
          },
          {
            type: "readonly",
            label: "Physical meaning",
            format: () => "Modal drive overlap / oscillator-strength evidence",
          },
          {
            type: "readonly",
            label: "FMR naming gate",
            format: () => "FMR-active because the manifest publishes coupling evidence",
          },
          {
            type: "readonly",
            label: "Visualization handoff",
            format: () => "Select a mode field to inspect phase-resolved 3D data",
          },
          ...buildRefProvenanceRows(selection),
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => <EigenModesInspectorPanel selection={selection} />,
                },
              ]
            : []),
        ],
      }),
    [kernel, ref, selection],
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

function DrivenResponseFieldInspectorShared(props: {
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

export function DispersionOverviewResultInspector({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.dispersion.root:${selection.nodeId ?? "disp"}`,
        breadcrumbs: ["Results", "Dispersion & k-resolved"],
        title: selection.label || "Dispersion & k-Resolved Response",
        kindLabel: "Spin-wave branches f_n(k) and driven maps A(k, f)",
        facts: [
          { id: "modal", label: "Modal", value: "Bloch / Floquet f_n(k)" },
          { id: "driven", label: "Driven", value: "Susceptibility map chi(k, f)" },
        ],
        notices: ref?.contractGap
          ? () => [{ id: "gap", tone: "warn", text: ref.contractGap! }]
          : undefined,
        sectionTitle: "Wavevector-Resolved Products",
        rows: [
          {
            type: "readonly",
            label: "Modal relation",
            format: () => "Modal relation fₙ(k) from eigenfrequency branches",
          },
          {
            type: "readonly",
            label: "Driven map",
            format: () =>
              "Driven map A(k,f), χ(k,f), or P_abs(k,f); not a modal dispersion relation",
          },
          {
            type: "readonly",
            label: "Group velocity",
            format: () => "Computed as vg = d omega / dk along continuous k-path segments",
          },
          ...buildRefProvenanceRows(selection),
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <FrequencyDomainDispersionInspectorPanel selection={selection} />
                  ),
                },
              ]
            : []),
        ],
      }),
    [kernel, ref, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function DispersionModalStageResultInspector({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.dispersion.modal.stage:${selection.nodeId ?? "mstage"}`,
        breadcrumbs: ["Results", "Dispersion", selection.label || "Modal Stage"],
        title: selection.label || "Modal Dispersion Stage",
        kindLabel: "Bloch / Floquet modal stage provenance",
        facts: [{ id: "bc", label: "Boundary", value: "Floquet periodic" }],
        notices: ref?.contractGap
          ? () => [{ id: "gap", tone: "warn", text: ref.contractGap! }]
          : undefined,
        sectionTitle: "Stage Contract & Provenance",
        rows: [
          {
            type: "readonly",
            label: "Operator",
            format: () => "Wavevector-parameterized linearized LLG operator L(k)",
          },
          ...buildRefProvenanceRows(selection),
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <div className="grid min-w-0 gap-3">
                      <EigenStudyInspectorPanel selection={selection} />
                      <EigenProvenanceInspectorPanel
                        canonicalFamily="Modal dispersion lane · f_n(k)"
                        linksTitle="Modal Dispersion Provenance Links"
                        selection={selection}
                        title="Modal Dispersion Provenance"
                      />
                    </div>
                  ),
                },
              ]
            : []),
        ],
      }),
    [kernel, ref, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function DispersionDrivenStageResultInspector({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.dispersion.driven.stage:${selection.nodeId ?? "dstage"}`,
        breadcrumbs: ["Results", "Dispersion", selection.label || "Driven Stage"],
        title: selection.label || "Driven k-Resolved Stage",
        kindLabel: "Wavevector-resolved harmonic response provenance",
        facts: [{ id: "bc", label: "Boundary", value: "Floquet periodic" }],
        notices: ref?.contractGap
          ? () => [{ id: "gap", tone: "warn", text: ref.contractGap! }]
          : undefined,
        sectionTitle: "Driven Stage Contract & Provenance",
        rows: [
          {
            type: "readonly",
            label: "Excitation",
            format: () => "Spatial-harmonic RF drive across k-grid / k-path",
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
                      <FrequencyResponseProvenanceInspectorPanel
                        canonicalFamily="Driven response-map lane · A(k,f)"
                        linksTitle="Driven Response-Map Provenance Links"
                        selection={selection}
                        title="Driven Response-Map Provenance"
                      />
                    </div>
                  ),
                },
              ]
            : []),
        ],
      }),
    [kernel, ref, selection],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function DispersionKSamplingResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedDispersionKSampling {...props} />
  ) : (
    <DispersionKSamplingView {...props} points={[]} />
  );
}

function ConnectedDispersionKSampling(props: InspectorPanelProps) {
  const dispRes = useFrequencyDomainEigenDispersionResource();
  const points = useMemo(
    () => buildEigenDispersionChartModel(dispRes.data ?? null).points,
    [dispRes.data],
  );
  return <DispersionKSamplingView {...props} points={points} />;
}

function DispersionKSamplingView({
  points,
  selection,
}: InspectorPanelProps & { points: readonly EigenDispersionPoint[] }) {
  const kernel = useContext(KernelContext);
  const uniqueSamples = useMemo(() => {
    const byIdx = new Map<number, EigenDispersionPoint>();
    for (const pt of points) {
      if (!byIdx.has(pt.sampleIndex)) byIdx.set(pt.sampleIndex, pt);
    }
    return Array.from(byIdx.values()).toSorted((a, b) => a.sampleIndex - b.sampleIndex);
  }, [points]);

  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.dispersion.k_sampling:${selection.nodeId ?? "ksamp"}`,
        breadcrumbs: ["Results", "Dispersion", "Wavevector Sampling"],
        title: selection.label || "Wavevector Sampling Path",
        kindLabel: "Brillouin / spin-wave k-space coordinates",
        facts: [
          { id: "unit", label: "SI unit", value: "rad/m" },
          { id: "samples", label: "k-samples", value: String(uniqueSamples.length) },
        ],
        sectionTitle: "k-Space Vertices, High-Symmetry Labels & Wavevector Table",
        rows: [
          {
            type: "readonly",
            label: "Path arc-length s",
            format: () => "Monotonic cumulative wavevector distance in rad/m",
          },
          ...(uniqueSamples.length > 0
            ? [
                {
                  type: "custom" as const,
                  label: "Wavevector sample table",
                  wide: true,
                  render: () => (
                    <div className="overflow-x-auto text-xs">
                      <table className="w-full text-left tabular-nums border-collapse">
                        <thead>
                          <tr className="border-b border-fm-border text-fm-muted">
                            <th className="py-1 px-1.5">Sample</th>
                            <th className="py-1 px-1.5">Label</th>
                            <th className="py-1 px-1.5">k (rad/um)</th>
                            <th className="py-1 px-1.5">s (rad/um)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {uniqueSamples.map((smp) => (
                            <tr
                              className="border-b border-fm-border-subtle"
                              key={smp.sampleIndex}
                            >
                              <td className="py-1 px-1.5">{smp.sampleIndex}</td>
                              <td className="py-1 px-1.5">{smp.sampleLabel ?? "—"}</td>
                              <td className="py-1 px-1.5 font-mono">
                                {smp.wavevectorKf
                                  ? smp.wavevectorKf
                                      .map((v) => (v * 1e-6).toFixed(2))
                                      .join(", ")
                                  : "—"}
                              </td>
                              <td className="py-1 px-1.5">
                                {(smp.pathS * 1e-6).toFixed(3)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
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
                  render: () => <EigenKPathInspectorPanel selection={selection} />,
                },
              ]
            : []),
        ],
      }),
    [kernel, selection, uniqueSamples],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function DispersionRelationResultInspector(
  props: InspectorPanelProps & {
    onSelectDispersionSelection?: (next: Omit<Selection, "moduleSource">) => void;
    testDispersionPoints?: readonly EigenDispersionPoint[];
  },
) {
  const kernel = useContext(KernelContext);
  if (props.testDispersionPoints || !kernel) {
    return (
      <DispersionRelationResultView
        {...props}
        points={props.testDispersionPoints ?? []}
      />
    );
  }
  return <ConnectedDispersionRelationResultInspector {...props} />;
}

function ConnectedDispersionRelationResultInspector(
  props: InspectorPanelProps & {
    onSelectDispersionSelection?: (next: Omit<Selection, "moduleSource">) => void;
  },
) {
  const dispRes = useFrequencyDomainEigenDispersionResource();
  const points = useMemo(
    () => buildEigenDispersionChartModel(dispRes.data ?? null).points,
    [dispRes.data],
  );
  return (
    <DispersionRelationResultView
      {...props}
      hostFullMasterPanel
      points={points}
    />
  );
}

function DispersionRelationResultView({
  hostFullMasterPanel = false,
  onSelectDispersionSelection,
  points,
  selection,
}: InspectorPanelProps & {
  hostFullMasterPanel?: boolean;
  onSelectDispersionSelection?: (next: Omit<Selection, "moduleSource">) => void;
  points: readonly EigenDispersionPoint[];
}) {
  const kernel = useContext(KernelContext);

  const selectedPoint = useMemo(
    () => resolveSelectedDispersionPoint(selection, points),
    [points, selection],
  );
  const selectedVg = useMemo(
    () => (selectedPoint ? estimateGroupVelocityMPerS(points, selectedPoint) : null),
    [points, selectedPoint],
  );

  const handleSelectPoint = useCallback(
    (pt: EigenDispersionPoint) => {
      const ownerRef = frequencyDomainRef(selection);
      const rawRef = buildEigenDispersionPointSelectionRef(pt, {
        analysisRunId: ownerRef?.analysisRunId,
        analysisStageId: ownerRef?.analysisStageId,
        artifactPath: ownerRef?.artifactPath,
        artifactRevision: ownerRef?.artifactRevision,
        calculationMode: "dispersion_modal",
        datasetId: ownerRef?.datasetId,
        datasetRevision: ownerRef?.datasetRevision,
      });
      // Dispersion P0 #1 fix: preserve canonical physics-first selection.kind!
      const canonicalKind =
        selection.kind === "results.dispersion.modal.relation" ||
        selection.kind === "results.dispersion.modal.branches"
          ? selection.kind
          : "results.dispersion.modal.relation";
      const nextRef =
        rawRef.type === "frequency-domain"
          ? {
              ...rawRef,
              kind: canonicalKind,
              modeIndex: pt.rawModeIndex,
              sampleIndex: pt.sampleIndex,
            }
          : rawRef;
      const nextSelection: Omit<Selection, "moduleSource"> = {
        kind: canonicalKind,
        label: `k sample ${pt.sampleIndex}, mode ${pt.rawModeIndex}`,
        nodeId: selection.nodeId ?? `disp:${pt.sampleIndex}:${pt.rawModeIndex}`,
        objectId: null,
        ref: nextRef,
      };
      onSelectDispersionSelection?.(nextSelection);
      kernel?.selection.set(nextSelection, "inspector");
    },
    [kernel, onSelectDispersionSelection, selection],
  );

  const activateSelectedModeIn3D = useCallback(() => {
    if (!kernel || !selectedPoint || !eigenModeFieldAvailable(selectedPoint) || !selectedPoint.modeFieldId) {
      return;
    }
    void kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.dispersion.modal.relation",
      }),
      {
        fieldId: selectedPoint.modeFieldId,
        label: `k sample ${selectedPoint.sampleIndex}, mode ${selectedPoint.rawModeIndex}`,
        phaseRad: 0,
        source: "eigen-mode",
        view: "phase_rotated_real",
      },
    );
  }, [kernel, selectedPoint]);

  const fBounds = useMemo(
    () => minMaxFinite(points.map((p) => p.frequencyHz)),
    [points],
  );

  const spec = useMemo<InspectorSpec<ReadOnlySpectralResultDraft>>(
    () => ({
      id: `results.dispersion.modal.relation:${selection.nodeId ?? "rel"}`,
      header: {
        breadcrumbs: [
          { id: "res", label: "Results" },
          { id: "disp", label: "Dispersion" },
          { id: "rel", label: selection.label || "Dispersion Relation f_n(k)" },
        ],
        ...(kernel && selectedPoint && eigenModeFieldAvailable(selectedPoint) && selectedPoint.modeFieldId
          ? {
              primaryHeaderAction: {
                label: "Activate in 3D",
                icon: Box,
                onRun: () => activateSelectedModeIn3D(),
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: LineChart,
        title: () => selection.label || "Spin-Wave Dispersion Relation",
        kindLabel: "Modal dispersion f_n(k) and group velocity vg(k)",
        statePill: () => ({
          tone: points.length > 0 ? "ok" : "neutral",
          label: points.length > 0 ? `${points.length} samples` : "Empty",
        }),
      },
      facts: () => [
        { id: "samples", label: "Points", value: String(points.length) },
        {
          id: "f-span",
          label: "Band",
          value: fBounds
            ? `${formatFrequencyHz(fBounds.min)} – ${formatFrequencyHz(fBounds.max)}`
            : "—",
        },
        ...(selectedPoint
          ? [
              {
                id: "sel-f",
                label: "Selected f",
                value: formatFrequencyHz(selectedPoint.frequencyHz),
              },
              {
                id: "sel-vg",
                label: "Group velocity",
                value:
                  selectedVg != null
                    ? `${(selectedVg * 1e-3).toFixed(2)} km/s`
                    : "0.00 km/s",
              },
            ]
          : []),
      ],
      sections: [
        {
          id: "dispersion-chart",
          title: "Dispersion f(k) & Group Velocity vg(k)",
          icon: Waves,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Two-panel dispersion chart",
              wide: true,
              render: () => (
                <BranchDispersionAndGroupVelocityChart
                  points={points}
                  onSelectPoint={handleSelectPoint}
                />
              ),
            },
            ...(points.length > 0 && !hostFullMasterPanel
              ? [
                  {
                    type: "custom" as const,
                    label: "Sample selector",
                    wide: true,
                    render: () => (
                      <div className="flex flex-wrap gap-1.5">
                        {points.map((pt) => (
                          <Button
                            aria-label={`Select dispersion point sample ${pt.sampleIndex} mode ${pt.rawModeIndex}`}
                            key={`${pt.sampleIndex}:${pt.rawModeIndex}`}
                            size="sm"
                            type="button"
                            variant={
                              selectedPoint?.sampleIndex === pt.sampleIndex &&
                              selectedPoint?.rawModeIndex === pt.rawModeIndex
                                ? "primary"
                                : "secondary"
                            }
                            onClick={() => handleSelectPoint(pt)}
                          >
                            k#{pt.sampleIndex} · {(pt.frequencyHz * 1e-9).toFixed(2)} GHz
                          </Button>
                        ))}
                      </div>
                    ),
                  },
                ]
              : []),
            ...(hostFullMasterPanel && kernel
              ? [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <div className="grid min-w-0 gap-3">
                        <EigenDispersionInspectorPanel
                          selection={selection}
                          onSelectDispersionSelection={onSelectDispersionSelection}
                        />
                        <ReferenceImportSection />
                      </div>
                    ),
                  },
                ]
              : []),
          ],
        },
        ...(!hostFullMasterPanel
          ? [
              {
                id: "selected-dispersion-point",
                title: "Selected (k, omega) Point",
                icon: Compass,
                defaultOpen: true,
                rows: selectedPoint
                  ? [
                      {
                        type: "readonly" as const,
                        label: "Wavevector coordinate k",
                        mono: true,
                        format: () => `${(selectedPoint.pathS * 1e-6).toFixed(3)} rad/um`,
                      },
                      {
                        type: "readonly" as const,
                        label: "Wavevector components (kx, ky, kz)",
                        mono: true,
                        format: () =>
                          selectedPoint.wavevectorKf
                            ? `${selectedPoint.wavevectorKf
                                .map((v) => (v * 1e-6).toFixed(3))
                                .join(", ")} rad/um`
                            : "—",
                      },
                      {
                        type: "readonly" as const,
                        label: "Eigenfrequency f",
                        mono: true,
                        format: () => `${(selectedPoint.frequencyHz * 1e-9).toFixed(4)} GHz`,
                      },
                      {
                        type: "readonly" as const,
                        label: "Linewidth (FWHM)",
                        mono: true,
                        format: () =>
                          selectedPoint.linewidthHz != null
                            ? formatFrequencyHz(selectedPoint.linewidthHz)
                            : "—",
                      },
                      {
                        type: "readonly" as const,
                        label: "Group velocity vg",
                        mono: true,
                        format: () =>
                          selectedVg != null
                            ? `${(selectedVg * 1e-3).toFixed(3)} km/s`
                            : "—",
                      },
                      {
                        type: "readonly" as const,
                        label: "Branch provenance",
                        mono: true,
                        format: () => selectedPoint.branchId ?? "—",
                      },
                      {
                        type: "readonly" as const,
                        label: "Residual",
                        mono: true,
                        format: () =>
                          selectedPoint.residualNorm != null
                            ? selectedPoint.residualNorm.toExponential(3)
                            : "—",
                      },
                    ]
                  : [
                      {
                        type: "readonly" as const,
                        label: "Selection",
                        format: () =>
                          "Click any point on f_n(k) to inspect k, f, and group velocity vg",
                      },
                    ],
              },
            ]
          : []),
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      activateSelectedModeIn3D,
      fBounds,
      handleSelectPoint,
      hostFullMasterPanel,
      kernel,
      onSelectDispersionSelection,
      points,
      selectedPoint,
      selectedVg,
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

export function DispersionBranchesResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedDispersionBranches {...props} />
  ) : (
    <DispersionBranchesView {...props} branchesData={null} dispersionData={null} />
  );
}

function ConnectedDispersionBranches(props: InspectorPanelProps) {
  const branchesRes = useFrequencyDomainEigenBranchesResource();
  const dispersionRes = useFrequencyDomainEigenDispersionResource();
  return (
    <DispersionBranchesView
      {...props}
      branchesData={branchesRes.data ?? null}
      dispersionData={dispersionRes.data ?? null}
    />
  );
}

function DispersionBranchesView({
  branchesData,
  dispersionData,
  selection,
}: InspectorPanelProps & {
  branchesData: Parameters<typeof buildEigenBranchesModel>[0];
  dispersionData: Parameters<typeof buildEigenBranchesModel>[1];
}) {
  const kernel = useContext(KernelContext);
  const ref = frequencyDomainRef(selection);
  const branchModel = useMemo(
    () => buildEigenBranchesModel(branchesData, dispersionData),
    [branchesData, dispersionData],
  );
  const dispersionPoints = useMemo(
    () => buildEigenDispersionChartModel(dispersionData ?? null).points,
    [dispersionData],
  );
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(
    ref?.branchId ?? null,
  );
  const activeBranchId =
    selectedBranchId ?? ref?.branchId ?? branchModel.branches[0]?.branchId ?? null;

  const branchSelection = useMemo<Selection>(() => {
    if (!activeBranchId) return selection;
    return {
      ...selection,
      ref: {
        ...(ref ?? {
          kind: selection.kind ?? "results.dispersion.modal.branches",
          nodeId: selection.nodeId ?? `results:eigen:branch:${activeBranchId}`,
          type: "frequency-domain" as const,
        }),
        branchId: activeBranchId,
      },
    };
  }, [activeBranchId, ref, selection]);

  const selectedBranchPoints = useMemo(
    () =>
      activeBranchId
        ? dispersionPoints.filter((pt) => pt.branchId === activeBranchId)
        : dispersionPoints,
    [activeBranchId, dispersionPoints],
  );

  const selectBranch = useCallback(
    (branch: EigenBranch) => {
      setSelectedBranchId(branch.branchId);
      kernel?.selection.set(
        {
          kind: "results.dispersion.modal.branches",
          label: branch.label ?? `Branch ${branch.branchId}`,
          nodeId: selection.nodeId ?? `results:eigen:branch:${branch.branchId}`,
          objectId: null,
          ref: {
            ...(ref ?? {
              kind: "results.dispersion.modal.branches",
              nodeId: selection.nodeId ?? `results:eigen:branch:${branch.branchId}`,
              type: "frequency-domain" as const,
            }),
            branchId: branch.branchId,
          },
        },
        "inspector",
      );
    },
    [kernel, ref, selection.nodeId],
  );

  const hasBranches = branchModel.branches.length > 0;
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.dispersion.modal.branches:${selection.nodeId ?? "branches"}`,
        breadcrumbs: ["Results", "Dispersion", "Mode Branches"],
        title: selection.label || "Tracked Spin-Wave Branches",
        kindLabel: "Eigenvector-overlap tracked dispersion branches",
        stateLabel: hasBranches
          ? `${branchModel.branches.length} branches`
          : "Ready",
        facts: [
          {
            id: "count",
            label: "Branches",
            value: String(branchModel.branches.length),
          },
          { id: "tracker", label: "Tracking", value: "Mode overlap continuity" },
        ],
        sectionTitle: "Branch Continuity, Group Velocity & Samples",
        rows: [
          {
            type: "readonly",
            label: "Branch tracking",
            format: () => "Tracks branch identity across k steps via complex mode overlap",
          },
          ...(selectedBranchPoints.length > 0
            ? [
                {
                  type: "custom" as const,
                  label: "Branch dispersion & group velocity",
                  wide: true,
                  render: () => (
                    <BranchDispersionAndGroupVelocityChart points={selectedBranchPoints} />
                  ),
                },
              ]
            : []),
          ...(hasBranches
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <FrequencyDomainBranchTable
                      branches={branchModel.branches}
                      onSelectBranch={selectBranch}
                    />
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
                      <EigenBranchesInspectorPanel selection={branchSelection} />
                      <EigenBranchInspectorPanel selection={branchSelection} />
                    </div>
                  ),
                },
              ]
            : []),
        ],
      }),
    [
      branchModel.branches,
      branchSelection,
      hasBranches,
      kernel,
      selectBranch,
      selectedBranchPoints,
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

export function DispersionModesAtKResultInspector({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.dispersion.modal.modes_at_k:${selection.nodeId ?? "modes_k"}`,
        breadcrumbs: ["Results", "Dispersion", "Modes at k"],
        title: selection.label || "Spatial Modes at Wavevector k",
        kindLabel: "Bloch envelope & phase-modulated 3D modes",
        commitMode: "liveViewport",
        onResetDisplay: () => {
          if (!kernel) return;
          void kernel.commands.execute(
            "analysis.frequency-domain.stop-3d-animation",
            createCommandContext("inspector", kernel),
          );
          kernel.analysisFieldOverlay?.update({ visualizationPhaseRad: 0 });
        },
        facts: [{ id: "form", label: "Envelope", value: "u_{n,k}(r) exp(i k·r)" }],
        sectionTitle: "Bloch Mode Shapes & 3D Activation",
        rows: [
          {
            type: "custom",
            label: "3D Bloch phase animation",
            wide: true,
            render: () => <ModeHarmonicPhaseControls />,
          },
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => <EigenModesInspectorPanel selection={selection} />,
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

export function DispersionModeAtKResultInspector({
  onPhaseChangeDeg,
  selection,
}: InspectorPanelProps & { onPhaseChangeDeg?: (deg: number) => void }) {
  return (
    <ModalModeResultInspectorShared
      breadcrumbsPrefix={["Results", "Dispersion"]}
      defaultTitle="Bloch Eigenmode Profile"
      idPrefix="results.dispersion.modal.mode_at_k"
      kindLabel="Wavevector-resolved 3D mode profile"
      selection={selection}
      onPhaseChangeDeg={onPhaseChangeDeg}
    />
  );
}

export function DispersionResponseMapResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedDispersionResponseMap {...props} />
  ) : (
    <DispersionResponseMapView {...props} payload={null} />
  );
}

function ConnectedDispersionResponseMap(props: InspectorPanelProps) {
  const mapRes = useFrequencyDomainResponseSweepResource();
  const payload = (mapRes.data?.payload ?? null) as Record<string, unknown> | null;
  return <DispersionResponseMapView {...props} payload={payload} />;
}

function ResponseMapHeatmapChart({
  observable,
  points,
  sliceMode,
}: {
  observable: string;
  points: ReadonlyArray<Record<string, unknown>>;
  sliceMode: string;
}) {
  const buildOption = useMemo(
    () => (palette: ResolvedChartThemePalette): EChartsOption => {
      const kSet = new Set<number>();
      const fSet = new Set<number>();
      for (const pt of points) {
        const k = typeof pt.k_rad_per_m === "number" ? Number((pt.k_rad_per_m * 1e-6).toFixed(3)) : 0;
        const f = typeof pt.frequency_hz === "number" ? Number((pt.frequency_hz * 1e-9).toFixed(3)) : 0;
        kSet.add(k);
        fSet.add(f);
      }
      const kVals = Array.from(kSet).toSorted((a, b) => a - b);
      const fVals = Array.from(fSet).toSorted((a, b) => a - b);
      const resolvePointValue = (pt: Record<string, unknown>): number => {
        const rawVal =
          observable === "imag"
            ? (pt.absorbed_power_density ?? pt.imag ?? pt.amplitude)
            : observable === "real"
              ? (pt.real ?? pt.amplitude)
              : pt.amplitude;
        return typeof rawVal === "number" && Number.isFinite(rawVal) ? rawVal : 0;
      };
      if (sliceMode === "fixed_k") {
        const targetK = kVals[0] ?? 0;
        const slicePts = points
          .filter((pt) => {
            const k = typeof pt.k_rad_per_m === "number" ? Number((pt.k_rad_per_m * 1e-6).toFixed(3)) : 0;
            return k === targetK;
          })
          .map((pt) => [
            typeof pt.frequency_hz === "number" ? pt.frequency_hz * 1e-9 : 0,
            resolvePointValue(pt),
          ]);
        return {
          grid: { left: 48, right: 18, top: 16, bottom: 34 },
          xAxis: {
            type: "value",
            name: "f (GHz)",
            nameLocation: "middle",
            nameGap: 22,
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
          yAxis: {
            type: "value",
            name: observable,
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
          series: [
            {
              type: "line",
              data: slicePts,
              lineStyle: { color: palette.series[0] ?? palette.textPrimary },
              showSymbol: true,
              symbolSize: 5,
            },
          ],
        };
      }
      if (sliceMode === "fixed_f") {
        const targetF = fVals[0] ?? 0;
        const slicePts = points
          .filter((pt) => {
            const f = typeof pt.frequency_hz === "number" ? Number((pt.frequency_hz * 1e-9).toFixed(3)) : 0;
            return f === targetF;
          })
          .map((pt) => [
            typeof pt.k_rad_per_m === "number" ? pt.k_rad_per_m * 1e-6 : 0,
            resolvePointValue(pt),
          ]);
        return {
          grid: { left: 48, right: 18, top: 16, bottom: 34 },
          xAxis: {
            type: "value",
            name: "k (rad/um)",
            nameLocation: "middle",
            nameGap: 22,
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
          yAxis: {
            type: "value",
            name: observable,
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
          series: [
            {
              type: "line",
              data: slicePts,
              lineStyle: { color: palette.series[0] ?? palette.textPrimary },
              showSymbol: true,
              symbolSize: 5,
            },
          ],
        };
      }
      const data = points.map((pt) => {
        const k = typeof pt.k_rad_per_m === "number" ? Number((pt.k_rad_per_m * 1e-6).toFixed(3)) : 0;
        const f = typeof pt.frequency_hz === "number" ? Number((pt.frequency_hz * 1e-9).toFixed(3)) : 0;
        return [kVals.indexOf(k), fVals.indexOf(f), resolvePointValue(pt)];
      });
      const zRange = minMaxFinite(data.map((d) => d[2] ?? 0));
      return {
        grid: { left: 48, right: 18, top: 16, bottom: 34 },
        xAxis: {
          type: "category",
          name: "k (rad/um)",
          nameLocation: "middle",
          nameGap: 22,
          data: kVals.map(String),
        },
        yAxis: {
          type: "category",
          name: "f (GHz)",
          data: fVals.map(String),
        },
        visualMap: {
          min: 0,
          max: Math.max(1e-9, zRange?.max ?? 0),
          show: false,
          inRange: { color: [palette.borderSubtle, palette.series[0] ?? palette.textPrimary] },
        },
        series: [
          {
            type: "heatmap",
            data,
          },
        ],
      };
    },
    [observable, points, sliceMode],
  );

  if (points.length === 0) return null;
  return (
    <ScientificEChart
      ariaLabel="Spin-wave driven response map A(k, f)"
      height={200}
      optionBuilder={buildOption}
    />
  );
}

function DispersionResponseMapView({
  payload,
  selection,
}: InspectorPanelProps & { payload: Record<string, unknown> | null }) {
  const kernel = useContext(KernelContext);
  const [mapObservable, setMapObservable] = useState("amplitude");
  const [sliceMode, setSliceMode] = useState("2d_map");

  const mapPoints = useMemo(
    () =>
      Array.isArray(payload?.points)
        ? (payload.points as Array<Record<string, unknown>>)
        : [],
    [payload],
  );
  const kSampleCount = useMemo(() => {
    if (Array.isArray(payload?.k_samples)) return payload.k_samples.length;
    const ks = new Set(
      mapPoints.flatMap((p) => (typeof p.k_rad_per_m === "number" ? [p.k_rad_per_m] : [])),
    );
    return ks.size;
  }, [mapPoints, payload]);

  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.dispersion.driven.response_map:${selection.nodeId ?? "rmap"}`,
        breadcrumbs: ["Results", "Dispersion", "Driven Response Map"],
        title: selection.label || "Driven Spin-Wave Response Map A(k, f)",
        kindLabel: "2D wavevector-frequency susceptibility & power map",
        stateLabel: payload ? "Published" : "Ready",
        facts: [
          { id: "axes", label: "Axes", value: "(k [rad/m], f [GHz])" },
          {
            id: "ksamples",
            label: "k-samples",
            value: kSampleCount > 0 ? String(kSampleCount) : "Published",
          },
        ],
        sectionTitle: "Response Map Controls & 2D Heatmap",
        rows: [
          {
            type: "custom",
            label: "Map observable & slice view",
            wide: true,
            render: () => (
              <div className="grid gap-2.5">
                <Select value={mapObservable} onValueChange={setMapObservable}>
                  <SelectTrigger aria-label="Map observable">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="fm-inspector-select-content">
                    <SelectItem value="amplitude">Response amplitude |A(k, f)|</SelectItem>
                    <SelectItem value="imag">Absorbed power P_abs(k, f)</SelectItem>
                    <SelectItem value="real">Dispersive component Re chi(k, f)</SelectItem>
                  </SelectContent>
                </Select>
                <SegmentedControl
                  aria-label="Response map slice mode"
                  options={[
                    { label: "2D Map", value: "2d_map" },
                    { label: "Fixed-k Slice", value: "fixed_k" },
                    { label: "Fixed-f Slice", value: "fixed_f" },
                  ]}
                  value={sliceMode}
                  onValueChange={setSliceMode}
                />
                {mapPoints.length > 0 ? (
                  <ResponseMapHeatmapChart
                    observable={mapObservable}
                    points={mapPoints}
                    sliceMode={sliceMode}
                  />
                ) : null}
              </div>
            ),
          },
          ...buildRefProvenanceRows(selection),
          ...(kernel
            ? [
                {
                  type: "custom" as const,
                  wide: true,
                  render: () => (
                    <FrequencyDomainResponseMapInspectorPanel selection={selection} />
                  ),
                },
              ]
            : []),
        ],
      }),
    [kSampleCount, kernel, mapObservable, mapPoints, payload, selection, sliceMode],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function DispersionResponseFieldAtKResultInspector({
  onPhaseChangeDeg,
  selection,
}: InspectorPanelProps & { onPhaseChangeDeg?: (deg: number) => void }) {
  return (
    <DrivenResponseFieldInspectorShared
      breadcrumbsPrefix={["Results", "Dispersion"]}
      defaultTitle="Driven Response Field at (k, f)"
      idPrefix="results.dispersion.driven.field_at_k"
      kindLabel="Steady-state Floquet spatial field delta_m(r; k, f)"
      selection={selection}
      onPhaseChangeDeg={onPhaseChangeDeg}
    />
  );
}

export function LegacyTimeDomainSpectralFeatureInspector({
  selection,
}: InspectorPanelProps) {
  const ref = frequencyDomainRef(selection);
  const spec = useMemo<InspectorSpec<ReadOnlySpectralResultDraft>>(
    () => ({
      id: `results.time_domain.spectral_feature:${selection.nodeId ?? "legacy"}`,
      header: {
        breadcrumbs: [
          { id: "res", label: "Results" },
          { id: "dyn", label: "Dynamics" },
          { id: "feat", label: selection.label || "Spectral Feature" },
        ],
      },
      identity: {
        domain: "physics",
        icon: Radar,
        title: () => selection.label || ref?.pointId || "Time-Domain FFT Peak",
        kindLabel: "FFT spectral feature from time trajectory",
        statePill: () => ({ tone: "info", label: "FFT trace" }),
      },
      facts: () => [
        {
          id: "freq",
          label: "Frequency",
          value:
            typeof ref?.frequencyHz === "number"
              ? formatFrequencyHz(ref.frequencyHz)
              : "—",
        },
        {
          id: "bin",
          label: "FFT bin",
          value: ref?.frequencyIndex != null ? String(ref.frequencyIndex) : "—",
        },
      ],
      sections: [
        {
          id: "fft-detail",
          title: "Windowed FFT Peak",
          icon: GitBranch,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Selected item",
              mono: true,
              format: () => ref?.pointId ?? selection.nodeId ?? "—",
            },
            {
              type: "readonly",
              label: "Sample",
              mono: true,
              format: () => ref?.sampleId ?? "—",
            },
            {
              type: "readonly",
              label: "Source artifact",
              mono: true,
              format: () => ref?.artifactPath ?? "time-domain FFT",
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [ref, selection.label, selection.nodeId],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function LegacyTimeDomainDsfPointInspector({
  selection,
}: InspectorPanelProps) {
  const ref = frequencyDomainRef(selection);
  const spec = useMemo(
    () =>
      makeSimplePhysicsResultSpec({
        id: `results.time_domain.dsf_point:${selection.nodeId ?? "dsf"}`,
        breadcrumbs: ["Results", "Dynamics", selection.label || "DSF Point"],
        title: selection.label || ref?.pointId || "Dynamical Structure Factor S(k, f)",
        kindLabel: "Time-domain spin-wave spectrum sample",
        facts: [
          {
            id: "freq",
            label: "Frequency",
            value:
              typeof ref?.frequencyHz === "number"
                ? formatFrequencyHz(ref.frequencyHz)
                : "—",
          },
          {
            id: "k",
            label: "Wavevector",
            value:
              typeof ref?.kPathCoordinateRadPerM === "number"
                ? `${(ref.kPathCoordinateRadPerM * 1e-6).toFixed(2)} rad/um`
                : "—",
          },
        ],
        sectionTitle: "DSF Sample Provenance",
        rows: [
          {
            type: "readonly",
            label: "Selected item",
            mono: true,
            format: () => ref?.pointId ?? selection.nodeId ?? "—",
          },
          {
            type: "readonly",
            label: "Sample",
            mono: true,
            format: () => ref?.sampleId ?? "—",
          },
          {
            type: "readonly",
            label: "Transform",
            format: () => "2D space-time FFT S(k, f) from sampled magnetization",
          },
        ],
      }),
    [ref, selection.label, selection.nodeId],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_SPECTRAL_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}
