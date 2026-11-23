"use client";

import type { EChartsOption } from "echarts";
import { Activity, Waves } from "lucide-react";
import {
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { KernelContext } from "@/kernel/KernelContext";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { ScientificEChart, type ResolvedChartThemePalette } from "@/shared/charts/ScientificEChart";
import type { EigenDispersionPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Slider } from "@/shared/ui/Slider";
import { Switch } from "@/shared/ui/Switch";
import type { InspectorRowSpec, InspectorSpec } from "../../../template";

export interface ReadOnlySpectralResultDraft {
  phaseDeg: number;
  animateMode: boolean;
  animationSpeedHz: number;
  amplitudeScale: number;
  displayObservable: string;
}

export const DEFAULT_SPECTRAL_RESULT_DRAFT: ReadOnlySpectralResultDraft = {
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

export function copyCsvText(csv: string): void {
  void navigator.clipboard?.writeText(csv).catch(() => undefined);
}

export function frequencyDomainRef(selection: Selection) {
  return selection.ref?.type === "frequency-domain" ? selection.ref : null;
}

const OMITTED_STATUS_FACET_RE = /^(?:unavail\w*|unkn\w*|n\/a)$/i;

export function buildRefProvenanceRows(
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

export function BranchDispersionAndGroupVelocityChart({
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

export function ModeHarmonicPhaseControls({
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

export function makeSimplePhysicsResultSpec({
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
