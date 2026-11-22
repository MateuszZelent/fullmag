"use client";

import {
  Activity,
  Bookmark,
  Box,
  Database,
  Download,
  ExternalLink,
  GitCommit,
  Magnet,
  RotateCcw,
  Sigma,
  Table2,
} from "lucide-react";
import { useCallback, useContext, useMemo, useState } from "react";

import type {
  HysteresisMetricsSchema,
  HysteresisPointSchema,
  HysteresisSettleTraceEntrySchema,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  useAnalysisResultBranchResource,
  useAnalysisResultDatasetManifestResource,
  useAnalysisResultItemResource,
  useAnalysisResultSamplesResource,
} from "@/kernel/resources/analysisResultResources";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import {
  useHysteresisPointsResource,
  useHysteresisProgressResource,
  useHysteresisSettleTraceResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import type { KernelApi } from "@/kernel/types";
import { createAnalysisResultFieldOverlayIntent } from "@/kernel/visualization/AnalysisResultFieldOverlayIntent";
import { minMaxFinite } from "@/shared/charts/ScientificEChart";
import {
  buildHysteresisLoadPointIn3DInput,
  clearHysteresisPointSelectionForLive,
  HysteresisChart,
  hysteresisPointTargetMetadata,
  hysteresisPointVectorResourceRef,
} from "@/shared/domain/study/HysteresisChart";
import { readStudyStageSource } from "@/shared/domain/study/studyStageSource";
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

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import type { InspectorSpec } from "../../template";
import { AnalysisResultInspectorPanel } from "../analysis-results/AnalysisResultInspectorPanel";
import { buildAnalysisResultInspectorModel } from "../analysis-results/analysisResultInspectorModel";
import { ReferenceImportSection } from "../analysis-results/ReferenceImportSection";
import { HysteresisDiagnosticTableSheet } from "../stages/HysteresisDiagnosticTableSheet";
import {
  activeHysteresisPointSelection,
  activeHysteresisSnapshotSelection,
  activeHysteresisSnapshotSelectionEquals,
  hysteresisInitialStateActionPresentation,
  hysteresisReplayActionPresentation,
} from "../stages/hysteresis/HysteresisInspectorUtils";
import { HysteresisMetricsInspector } from "../stages/hysteresis/HysteresisMetricsInspector";
import { HysteresisSettleTraceInspector } from "../stages/hysteresis/HysteresisSettleTraceInspector";
import { ConnectedInspectorSpec } from "../study/ConnectedInspectorSpec";

interface ReadOnlyResultDraft {
  branchFilter: string;
}

const DEFAULT_RESULT_DRAFT: ReadOnlyResultDraft = { branchFilter: "all" };

type HysteresisBucket = "all" | "snapshots" | "transitions" | "bookmarks";

const HYSTERESIS_DATASET_COLUMNS: ReadonlyArray<{
  column: string;
  meaning: string;
  unit: string;
}> = [
  { column: "point_id", unit: "index", meaning: "Monotonic sweep sample index" },
  { column: "field_value_mT", unit: "mT", meaning: "Applied external field projection" },
  { column: "m_parallel", unit: "1", meaning: "Normalized magnetization along measurement axis" },
  { column: "m_oop", unit: "1", meaning: "Out-of-plane normalized magnetization" },
  { column: "m_ip", unit: "1", meaning: "In-plane normalized magnetization magnitude" },
  { column: "m_avg", unit: "(1, 1, 1)", meaning: "Volume-averaged magnetization vector [mx, my, mz]" },
  { column: "branch_id", unit: "id", meaning: "Sweep branch identifier (descending / ascending / minor)" },
  { column: "protocol_role", unit: "role", meaning: "Protocol role (major, virgin, coercive, reversal)" },
  { column: "settle_status", unit: "state", meaning: "Equilibrium solver convergence status" },
  { column: "snapshot_id", unit: "id", meaning: "Saved 3D spatial magnetization snapshot handle" },
];

function createFallbackKernel(selection: InspectorPanelProps["selection"]): KernelApi {
  return {
    commands: {
      execute: () => Promise.resolve({ status: "completed" }),
      getSessionScopeKey: () => "fallback",
      refresh: () => undefined,
    },
    selection: {
      clear: () => undefined,
      get: () => selection,
      set: () => undefined,
      subscribe: () => () => undefined,
    },
  } as unknown as KernelApi;
}

export function resolveHysteresisStageId(
  selection: InspectorPanelProps["selection"],
  sceneData?: SceneResource | Record<string, unknown> | null,
): string | null {
  const ref = selection.ref;
  if (ref) {
    if ("stageId" in ref && typeof ref.stageId === "string" && ref.stageId.trim()) {
      return ref.stageId.trim();
    }
    if (
      "analysisStageId" in ref &&
      typeof ref.analysisStageId === "string" &&
      ref.analysisStageId.trim()
    ) {
      return ref.analysisStageId.trim();
    }
  }
  const nodeId = selection.nodeId ?? "";
  const stageMarker = ":stage:";
  const markerIdx = nodeId.indexOf(stageMarker);
  if (markerIdx >= 0) {
    const tail = nodeId.slice(markerIdx + stageMarker.length).split(":")[0];
    if (tail) return tail;
  }
  if (nodeId.startsWith("results:hysteresis:")) {
    const seg = nodeId.slice("results:hysteresis:".length).split(":")[0];
    if (seg && seg !== "root" && seg !== "dataset" && seg !== "point") {
      return seg;
    }
  }
  if (!sceneData || typeof sceneData !== "object") {
    return null;
  }
  const sceneRec = sceneData as Record<string, unknown>;
  const source = readStudyStageSource(sceneRec.study);
  if (source.kind === "pipeline" || source.kind === "flat") {
    for (const entry of source.entries) {
      const payloadKind =
        typeof entry.payload.kind === "string" ? entry.payload.kind : null;
      if (
        entry.stageKind === "hysteresis" ||
        entry.stageKind === "macro:hysteresis" ||
        payloadKind === "hysteresis"
      ) {
        const payloadId =
          typeof entry.payload.id === "string" && entry.payload.id.trim()
            ? entry.payload.id.trim()
            : null;
        if (payloadId) return payloadId;
        if (entry.queueId && entry.queueId.trim()) return entry.queueId.trim();
      }
    }
  }
  const studyObj =
    (sceneRec.study_pipeline as { stages?: unknown } | undefined) ??
    (sceneRec.study as { stages?: unknown } | undefined);
  if (Array.isArray(studyObj?.stages)) {
    const hystStage = studyObj.stages.find(
      (s): s is { id: string; kind: string } =>
        Boolean(
          s &&
            typeof s === "object" &&
            (s as { kind?: unknown }).kind === "hysteresis" &&
            typeof (s as { id?: unknown }).id === "string" &&
            (s as { id: string }).id.trim().length > 0,
        ),
    );
    if (hystStage) return hystStage.id.trim();
  }
  return null;
}

export function resolveHysteresisPointId(
  selection: InspectorPanelProps["selection"],
  stageId: string | null,
): number | null {
  const ref = selection.ref;
  const candidate =
    (ref && "pointId" in ref && typeof ref.pointId === "number"
      ? ref.pointId
      : undefined) ??
    (ref && "hysteresisPointId" in ref && typeof ref.hysteresisPointId === "number"
      ? ref.hysteresisPointId
      : undefined) ??
    activeHysteresisPointSelection(selection, stageId)?.pointId;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return candidate;
  }
  const match = selection.nodeId?.match(/:point:(\d+)(?:$|:)/);
  if (match?.[1] !== undefined) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function computeDerivedMetricsFromPoints(
  points: readonly HysteresisPointSchema[],
): {
  metrics: HysteresisMetricsSchema | null;
  reversalFields: HysteresisPointSchema[];
  transitionIds: Set<number>;
} {
  if (points.length === 0) {
    return { metrics: null, reversalFields: [], transitionIds: new Set() };
  }
  let hcMinus: number | null = null;
  let hcPlus: number | null = null;
  let mrPlus: number | null = null;
  let mrMinus: number | null = null;
  let maxChi: number | null = null;
  let loopArea = 0;
  const switchingCandidates: NonNullable<
    HysteresisMetricsSchema["switching_field_candidates"]
  > = [];
  const reversalFields: HysteresisPointSchema[] = [];
  const jumps: Array<{ id: number; dm: number }> = [];

  for (let i = 0; i < points.length; i += 1) {
    const pt = points[i]!;
    if (pt.protocol_role === "reversal") {
      reversalFields.push(pt);
    } else if (i > 0 && i < points.length - 1) {
      const dPrev = pt.field_value_mT - points[i - 1]!.field_value_mT;
      const dNext = points[i + 1]!.field_value_mT - pt.field_value_mT;
      if (dPrev * dNext < 0) {
        reversalFields.push(pt);
      }
    }
    if (Math.abs(pt.field_value_mT) < 1e-3) {
      if (pt.m_parallel >= 0) {
        mrPlus = mrPlus === null ? pt.m_parallel : Math.max(mrPlus, pt.m_parallel);
      } else {
        mrMinus = mrMinus === null ? pt.m_parallel : Math.min(mrMinus, pt.m_parallel);
      }
    }
    if (i > 0) {
      const prev = points[i - 1]!;
      const dH = pt.field_value_mT - prev.field_value_mT;
      const dm = pt.m_parallel - prev.m_parallel;
      loopArea += 0.5 * (pt.m_parallel + prev.m_parallel) * dH;
      jumps.push({ id: pt.point_id, dm: Math.abs(dm) });
      if (Math.abs(dH) > 1e-9) {
        const chi = Math.abs(dm / dH);
        if (maxChi === null || chi > maxChi) maxChi = chi;
        if (Math.abs(dm) >= 0.15) {
          switchingCandidates.push({
            branch_id: pt.branch_id ?? "major",
            field_value_mT: 0.5 * (pt.field_value_mT + prev.field_value_mT),
            point_id_after: pt.point_id,
            point_id_before: prev.point_id,
            susceptibility_per_mT: chi,
          });
        }
      }
      if (prev.field_value_mT * pt.field_value_mT <= 0 && prev.field_value_mT !== pt.field_value_mT) {
        const fracH = Math.abs(prev.field_value_mT) / Math.abs(dH);
        const mr = prev.m_parallel + fracH * dm;
        if (mr >= 0) mrPlus = mrPlus === null ? mr : Math.max(mrPlus, mr);
        else mrMinus = mrMinus === null ? mr : Math.min(mrMinus, mr);
      }
      if (prev.m_parallel * pt.m_parallel <= 0 && prev.m_parallel !== pt.m_parallel) {
        const frac = Math.abs(prev.m_parallel) / Math.abs(pt.m_parallel - prev.m_parallel);
        const hc = prev.field_value_mT + frac * dH;
        if (hc < 0) hcMinus = hcMinus === null ? hc : Math.min(hcMinus, hc);
        else hcPlus = hcPlus === null ? hc : Math.max(hcPlus, hc);
      }
    }
  }

  const hc =
    hcPlus !== null && hcMinus !== null
      ? 0.5 * (Math.abs(hcPlus) + Math.abs(hcMinus))
      : hcPlus !== null
        ? Math.abs(hcPlus)
        : hcMinus !== null
          ? Math.abs(hcMinus)
          : null;
  const heb =
    hcPlus !== null && hcMinus !== null ? 0.5 * (hcPlus + hcMinus) : null;

  const convergedCount = points.filter(
    (p) => (p.settle_status ?? p.status) === "converged" || p.status === "completed",
  ).length;
  const warningCount = points.filter((p) => (p.warning_count ?? 0) > 0).length;
  const nonConvergedCount = Math.max(0, points.length - convergedCount);
  const maxAbsM = points.reduce((acc, p) => Math.max(acc, Math.abs(p.m_parallel)), 0);

  const transitionIds = new Set(
    jumps
      .filter((j) => j.dm > 0.05)
      .toSorted((a, b) => b.dm - a.dm)
      .slice(0, 12)
      .map((j) => j.id),
  );

  const metrics: HysteresisMetricsSchema = {
    H_c: hc,
    H_c_minus: hcMinus,
    H_c_plus: hcPlus,
    H_eb: heb,
    M_r_minus: mrMinus,
    M_r_plus: mrPlus,
    convergence_quality_summary: {
      converged_points: convergedCount,
      non_converged_points: nonConvergedCount,
      status: nonConvergedCount === 0 ? "converged" : "partial",
      total_points: points.length,
      warning_points: warningCount,
    },
    loop_area: points.length >= 2 ? Math.abs(loopArea) : 0,
    max_differential_susceptibility: maxChi,
    saturation_status: maxAbsM >= 0.95 ? "saturated" : "sub-saturated",
    switching_field_candidates: switchingCandidates.slice(0, 4),
  };

  return { metrics, reversalFields, transitionIds };
}

function executeLoadHysteresisPointIn3D(
  kernel: KernelApi,
  stageId: string,
  point: HysteresisPointSchema,
): void {
  const metadata = hysteresisPointTargetMetadata(point, {});
  void kernel.commands.execute(
    "hysteresis.load-point-in-3d",
    createCommandContext("inspector", kernel),
    {
      ...buildHysteresisLoadPointIn3DInput({
        point,
        stageId,
        targetMetadata: metadata,
        yAxisKey: "m_parallel",
      }),
      fieldOrientation: metadata.fieldOrientation ?? null,
      fieldRevision: metadata.fieldRevision ?? null,
      fieldVal: point.field_value_mT,
      mVal: point.m_parallel,
      measurementAxis: metadata.measurementAxis ?? null,
      meshIdentity: metadata.meshIdentity ?? null,
      pointId: point.point_id,
      snapshotId: point.snapshot_id ?? null,
      snapshotResourceRef: hysteresisPointVectorResourceRef(point),
      snapshotStorageReason: point.snapshot_storage_reason ?? null,
      snapshotStorageStatus: point.snapshot_storage_status ?? null,
      stageId,
    },
  );
}

function executeUsePointAsInitialState(
  kernel: KernelApi,
  stageId: string,
  point: HysteresisPointSchema,
): void {
  if (!point.snapshot_id) return;
  void kernel.commands.execute(
    "hysteresis.use-point-as-initial-state",
    createCommandContext("inspector", kernel),
    {
      snapshotArtifactRef: point.snapshot_json_artifact_ref ?? null,
      snapshotId: point.snapshot_id,
      snapshotResourceRef: point.snapshot_resource_ref ?? null,
      stageId,
    },
  );
}

function HysteresisInteractiveExplorerBlock({
  activeSnapshot,
  bookmarkedIds,
  branchFilter,
  bucket,
  kernel,
  onBranchFilterChange,
  onBucketChange,
  onOpenSheet,
  onToggleBookmark,
  points,
  progress,
  revision,
  stageId,
}: {
  activeSnapshot: ReturnType<typeof activeHysteresisSnapshotSelection>;
  bookmarkedIds: ReadonlySet<number>;
  branchFilter: string;
  bucket: HysteresisBucket;
  kernel: KernelApi;
  onBranchFilterChange: (next: string) => void;
  onBucketChange: (next: HysteresisBucket) => void;
  onOpenSheet: () => void;
  onToggleBookmark: (point: HysteresisPointSchema) => void;
  points: readonly HysteresisPointSchema[];
  progress: ReturnType<typeof useHysteresisProgressResource>["data"] | null;
  revision: string | number | null;
  stageId: string | null;
}) {
  const branches = useMemo(() => {
    const unique = new Set<string>();
    for (const pt of points) {
      if (pt.branch_id) unique.add(pt.branch_id);
    }
    return Array.from(unique);
  }, [points]);

  const { metrics, reversalFields, transitionIds } = useMemo(
    () => computeDerivedMetricsFromPoints(points),
    [points],
  );

  const branchFilteredPoints = useMemo(
    () =>
      branchFilter === "all"
        ? points
        : points.filter((pt) => pt.branch_id === branchFilter),
    [branchFilter, points],
  );

  const visiblePoints = useMemo(() => {
    if (bucket === "snapshots") {
      return branchFilteredPoints.filter((pt) => Boolean(pt.snapshot_id));
    }
    if (bucket === "transitions") {
      return branchFilteredPoints.filter(
        (pt) =>
          transitionIds.has(pt.point_id) ||
          pt.protocol_role === "coercive" ||
          pt.protocol_role === "reversal",
      );
    }
    if (bucket === "bookmarks") {
      return branchFilteredPoints.filter((pt) => bookmarkedIds.has(pt.point_id));
    }
    return branchFilteredPoints;
  }, [bookmarkedIds, branchFilteredPoints, bucket, transitionIds]);

  const handleExportLoopCsv = useCallback(() => {
    if (!stageId) return;
    void kernel.commands.execute(
      "hysteresis.export-loop-csv",
      createCommandContext("inspector", kernel),
      { points: branchFilteredPoints, stageId },
    );
  }, [branchFilteredPoints, kernel, stageId]);

  const handleReturnToLive = useCallback(() => {
    if (stageId) {
      clearHysteresisPointSelectionForLive(kernel, stageId, "inspector");
    }
    void kernel.commands.execute(
      "hysteresis.return-to-live",
      createCommandContext("inspector", kernel),
      { stageId },
    );
  }, [kernel, stageId]);

  const handleContinueToNextStage = useCallback(() => {
    if (!stageId) return;
    void kernel.commands.execute(
      "hysteresis.continue-to-next-stage",
      createCommandContext("inspector", kernel),
      { stageId },
    );
  }, [kernel, stageId]);

  const canContinueToNextStage =
    Boolean(stageId) &&
    (progress !== null ? progress.status === "completed" : points.length > 0);

  return (
    <div className="grid min-w-0 gap-3">
      {stageId ? (
        <HysteresisChart
          commandSource="inspector"
          data={{
            points: branchFilteredPoints,
            pointsRevision: revision == null ? null : String(revision),
            progress: progress ?? null,
          }}
          kernel={kernel}
          stageId={stageId}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          aria-label="Export loop CSV"
          disabled={!stageId || branchFilteredPoints.length === 0}
          disabledReason="Complete a Hysteresis stage to export loop points as CSV"
          size="sm"
          type="button"
          variant="secondary"
          onClick={handleExportLoopCsv}
        >
          <Download aria-hidden="true" size={13} />
          <span>Export Loop CSV</span>
        </Button>
        <Button
          aria-label="Continue to next stage"
          disabled={!canContinueToNextStage}
          disabledReason="Complete the Hysteresis stage before continuing to another stage"
          size="sm"
          type="button"
          variant="secondary"
          onClick={handleContinueToNextStage}
        >
          <span>Continue to Next Stage</span>
        </Button>
        {activeSnapshot ? (
          <Button
            aria-label="Return 3D viewport to live field"
            size="sm"
            type="button"
            variant="secondary"
            onClick={handleReturnToLive}
          >
            <RotateCcw aria-hidden="true" size={13} />
            <span>Return to Live</span>
          </Button>
        ) : null}
      </div>

      <HysteresisMetricsInspector metrics={metrics ?? undefined} reversalFields={reversalFields} />

      <div className="rounded border border-fm-border p-2.5 grid gap-2.5 text-xs">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <span className="font-medium flex items-center gap-1.5">
            <Table2 aria-hidden="true" size={14} />
            <span>Field Points ({visiblePoints.length})</span>
          </span>
          <Select value={branchFilter} onValueChange={onBranchFilterChange}>
            <SelectTrigger aria-label="Branch filter" className="min-w-[8.5rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="fm-inspector-select-content">
              <SelectItem value="all">All branches</SelectItem>
              {branches.map((branch) => (
                <SelectItem key={branch} value={branch}>
                  {branch}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <SegmentedControl
          aria-label="Hysteresis point view filter"
          options={[
            { label: `All (${branchFilteredPoints.length})`, value: "all" },
            {
              label: `Snapshots (${branchFilteredPoints.filter((p) => Boolean(p.snapshot_id)).length})`,
              value: "snapshots",
            },
            { label: `Transitions (${transitionIds.size})`, value: "transitions" },
            { label: `Bookmarks (${bookmarkedIds.size})`, value: "bookmarks" },
          ]}
          value={bucket}
          onValueChange={(next) => onBucketChange(next as HysteresisBucket)}
        />

        {visiblePoints.length === 0 ? (
          <EmptyState
            description="Complete a Hysteresis sweep or switch the active filter to inspect recorded field states."
            heading="No matching sweep points"
            size="compact"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs tabular-nums border-collapse">
              <thead>
                <tr className="border-b border-fm-border text-fm-muted">
                  <th className="py-1 px-1.5">mu0 H (mT)</th>
                  <th className="py-1 px-1.5">m_parallel</th>
                  <th className="py-1 px-1.5">Branch</th>
                  <th className="py-1 px-1.5">3D</th>
                </tr>
              </thead>
              <tbody>
                {visiblePoints.slice(0, 30).map((pt) => {
                  const replay = hysteresisReplayActionPresentation(
                    pt.snapshot_id,
                    pt.snapshot_storage_status,
                    pt.snapshot_storage_reason,
                  );
                  return (
                    <tr
                      className="border-b border-fm-border-subtle cursor-pointer"
                      key={pt.point_id}
                      onClick={() => {
                        if (!stageId) return;
                        kernel.selection.set(
                          {
                            kind: "results.hysteresis.point",
                            label: `Point #${pt.point_id} (${pt.field_value_mT.toFixed(2)} mT)`,
                            nodeId: `results:hysteresis:${stageId}:point:${pt.point_id}`,
                            objectId: null,
                            ref: {
                              hysteresisPointId: pt.point_id,
                              kind: "study.stage.hysteresis",
                              nodeId: `results:hysteresis:${stageId}:point:${pt.point_id}`,
                              stageId,
                              stageIndex: 0,
                              type: "study-stage",
                            },
                          },
                          "inspector",
                        );
                      }}
                      onDoubleClick={() => onToggleBookmark(pt)}
                    >
                      <td className="py-1 px-1.5">{pt.field_value_mT.toFixed(2)}</td>
                      <td className="py-1 px-1.5">{pt.m_parallel.toFixed(4)}</td>
                      <td className="py-1 px-1.5 truncate max-w-[84px]">
                        {pt.branch_id ?? "major"}
                      </td>
                      <td
                        className="py-1 px-1.5"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Button
                          aria-label={`Load point ${pt.point_id} snapshot in 3D`}
                          disabled={!stageId || replay.disabled}
                          disabledReason={replay.title}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            if (stageId) executeLoadHysteresisPointIn3D(kernel, stageId, pt);
                          }}
                        >
                          <Box aria-hidden="true" size={12} />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={onOpenSheet}
        >
          Open Full 15-Column Diagnostic Table…
        </Button>
      </div>
    </div>
  );
}

export function HysteresisRootResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedHysteresisRootResultInspector {...props} />
  ) : (
    <HysteresisRootResultView {...props} points={[]} progress={null} revision={null} />
  );
}

function ConnectedHysteresisRootResultInspector(props: InspectorPanelProps) {
  const directStageId = resolveHysteresisStageId(props.selection);
  const scene = useSceneResource({ enabled: !directStageId });
  const stageId =
    directStageId ?? resolveHysteresisStageId(props.selection, scene.data ?? null);
  const pointsRes = useHysteresisPointsResource(stageId ?? undefined, {
    enabled: Boolean(stageId),
  });
  const progressRes = useHysteresisProgressResource(stageId ?? undefined, {
    enabled: Boolean(stageId),
  });
  const activeSnapshot = useSelectionSelector(
    (sel) => (sel ? activeHysteresisSnapshotSelection(sel, stageId ?? undefined) : null),
    { isEqual: activeHysteresisSnapshotSelectionEquals },
  );
  const points = useMemo(
    () => (Array.isArray(pointsRes.data?.points) ? pointsRes.data.points : []),
    [pointsRes.data],
  );
  return (
    <HysteresisRootResultView
      {...props}
      activeSnapshot={activeSnapshot}
      points={points}
      progress={progressRes.data ?? null}
      resolvedStageId={stageId}
      revision={pointsRes.revision ?? null}
    />
  );
}

function HysteresisRootResultView({
  activeSnapshot = null,
  points,
  progress,
  resolvedStageId,
  revision,
  selection,
}: InspectorPanelProps & {
  activeSnapshot?: ReturnType<typeof activeHysteresisSnapshotSelection>;
  points: HysteresisPointSchema[];
  progress: ReturnType<typeof useHysteresisProgressResource>["data"] | null;
  resolvedStageId?: string | null;
  revision: string | number | null;
}) {
  const kernelFromCtx = useContext(KernelContext);
  const kernel = useMemo(
    () => kernelFromCtx ?? createFallbackKernel(selection),
    [kernelFromCtx, selection],
  );
  const stageId =
    resolvedStageId !== undefined ? resolvedStageId : resolveHysteresisStageId(selection);
  const [branchFilter, setBranchFilter] = useState("all");
  const [bucket, setBucket] = useState<HysteresisBucket>("all");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<number>>(() => new Set());

  const sheetPoints = useMemo(
    () =>
      branchFilter === "all"
        ? points
        : points.filter((pt) => pt.branch_id === branchFilter),
    [branchFilter, points],
  );

  const toggleBookmark = useCallback(
    (point: HysteresisPointSchema) => {
      setBookmarkedIds((prev) => {
        const next = new Set(prev);
        if (next.has(point.point_id)) next.delete(point.point_id);
        else next.add(point.point_id);
        return next;
      });
      if (stageId && kernelFromCtx) {
        void kernelFromCtx.commands.execute(
          "hysteresis.bookmark-point",
          createCommandContext("inspector", kernelFromCtx),
          { point, stageId },
        );
      }
    },
    [kernelFromCtx, stageId],
  );

  const fdRef = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const arRef = selection.ref?.type === "analysis-result" ? selection.ref : null;
  const runLabel = arRef?.runId ?? fdRef?.analysisRunId ?? "Active";

  const spec = useMemo<InspectorSpec<ReadOnlyResultDraft>>(
    () => ({
      id: `results.hysteresis.root:${selection.nodeId ?? stageId ?? "root"}`,
      header: {
        breadcrumbs: [
          { id: "results", label: "Results" },
          { id: "hysteresis", label: "Hysteresis" },
        ],
        extraMenuActions: [
          {
            id: "open-15-col-sheet",
            label: "Open Full 15-Column Diagnostic Table…",
            icon: Table2,
            onSelect: () => setSheetOpen(true),
          },
        ],
      },
      identity: {
        domain: "physics",
        icon: Magnet,
        title: () => selection.label || "Hysteresis Results",
        kindLabel: "Branch-resolved field-sweep datasets",
        entityId: stageId ?? selection.nodeId ?? undefined,
        statePill: () =>
          points.length > 0
            ? { label: `${points.length} points`, tone: "ok" }
            : { label: "Published family", tone: "neutral" },
      },
      facts: () => [
        { id: "run", label: "Run", value: runLabel },
        ...(stageId ? [{ id: "stage", label: "Stage", value: stageId }] : []),
        { id: "pts", label: "Recorded points", value: String(points.length) },
        {
          id: "snaps",
          label: "3D snapshots",
          value: String(points.filter((p) => Boolean(p.snapshot_id)).length),
        },
      ],
      notices: () => [
        ...(fdRef?.contractGap
          ? [{ id: "contract-gap", tone: "warn" as const, text: fdRef.contractGap }]
          : []),
        ...(fdRef?.availability === "unsupported"
          ? [
              {
                id: "unsupported",
                tone: "warn" as const,
                text: "This result product is not supported by the published runtime contract.",
              },
            ]
          : []),
        ...(fdRef?.availability === "unavailable"
          ? [
              {
                id: "not-published",
                tone: "info" as const,
                text: "The typed hysteresis result resource is not yet published.",
              },
            ]
          : []),
      ],
      sections: [
        {
          id: "interactive-loop",
          title: "Loop Curve, Metrics & Field Points",
          icon: Sigma,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <HysteresisInteractiveExplorerBlock
                  activeSnapshot={activeSnapshot}
                  bookmarkedIds={bookmarkedIds}
                  branchFilter={branchFilter}
                  bucket={bucket}
                  kernel={kernel}
                  points={points}
                  progress={progress}
                  revision={revision}
                  stageId={stageId}
                  onBranchFilterChange={setBranchFilter}
                  onBucketChange={setBucket}
                  onOpenSheet={() => setSheetOpen(true)}
                  onToggleBookmark={toggleBookmark}
                />
              ),
            },
          ],
        },
        {
          id: "sweep-semantics",
          title: "Field sweep semantics & provenance",
          icon: GitCommit,
          defaultOpen: points.length === 0,
          rows: [
            {
              type: "readonly",
              label: "Product",
              format: () => fdRef?.studyProduct ?? arRef?.focus ?? "hysteresis_loop",
            },
            {
              type: "readonly",
              label: "Field axis",
              format: () => {
                const bounds = minMaxFinite(points.map((p) => p.field_value_mT));
                return bounds
                  ? `${bounds.min.toFixed(2)} to ${bounds.max.toFixed(2)} mT`
                  : "Applied field H or B in published sweep units";
              },
            },
            {
              type: "readonly",
              label: "Magnetization observable",
              format: () =>
                "Normalized m_parallel, m_oop, m_ip, and volume-averaged vector [mx, my, mz]",
            },
            {
              type: "readonly",
              label: "Branch and turning-point data",
              format: () =>
                "Major/minor branches, reversals, coercive crossings, and adaptive steps",
            },
            {
              type: "readonly",
              label: "Dataset / resource",
              mono: true,
              format: () => fdRef?.resourceRef ?? arRef?.datasetId ?? "—",
            },
            {
              type: "readonly",
              label: "Run",
              mono: true,
              format: () => arRef?.runId ?? fdRef?.analysisRunId ?? "—",
            },
            {
              type: "readonly",
              label: "Stage",
              mono: true,
              format: () => stageId ?? "—",
            },
            {
              type: "readonly",
              label: "Equilibrium",
              mono: true,
              format: () => fdRef?.equilibriumId ?? "—",
            },
            {
              type: "readonly",
              label: "Dataset revision",
              mono: true,
              format: () =>
                String(revision ?? arRef?.datasetRevision ?? fdRef?.artifactRevision ?? "—"),
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      activeSnapshot,
      arRef,
      bookmarkedIds,
      branchFilter,
      bucket,
      fdRef,
      kernel,
      points,
      progress,
      revision,
      runLabel,
      selection,
      stageId,
      toggleBookmark,
    ],
  );

  return (
    <>
      <ConnectedInspectorSpec
        baseline={DEFAULT_RESULT_DRAFT}
        selection={selection}
        spec={spec}
      />
      <HysteresisDiagnosticTableSheet
        open={sheetOpen}
        points={sheetPoints}
        stageId={stageId ?? "hysteresis"}
        onBookmarkPoint={toggleBookmark}
        onExportCsv={(exportPts) => {
          if (!stageId) return;
          void kernel.commands.execute(
            "hysteresis.export-loop-csv",
            createCommandContext("inspector", kernel),
            { points: exportPts, stageId },
          );
        }}
        onLoadPointIn3D={(pt) => {
          if (stageId) executeLoadHysteresisPointIn3D(kernel, stageId, pt);
        }}
        onOpenChange={setSheetOpen}
        onUsePointAsInitialState={(pt) => {
          if (stageId) executeUsePointAsInitialState(kernel, stageId, pt);
        }}
      />
    </>
  );
}

export function HysteresisDatasetResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedHysteresisDatasetResultInspector {...props} />
  ) : (
    <HysteresisDatasetResultView {...props} manifest={null} points={[]} revision={null} />
  );
}

function ConnectedHysteresisDatasetResultInspector(props: InspectorPanelProps) {
  const stageId = resolveHysteresisStageId(props.selection);
  const arRef =
    props.selection.ref?.type === "analysis-result" ? props.selection.ref : null;
  const pointsRes = useHysteresisPointsResource(stageId ?? undefined, {
    enabled: Boolean(stageId),
  });
  const manifestRes = useAnalysisResultDatasetManifestResource(
    arRef?.runId,
    arRef?.datasetId,
    { enabled: Boolean(arRef?.runId && arRef?.datasetId) },
  );
  const activeSnapshot = useSelectionSelector(
    (sel) => (sel ? activeHysteresisSnapshotSelection(sel, stageId ?? undefined) : null),
    { isEqual: activeHysteresisSnapshotSelectionEquals },
  );
  const points = useMemo(
    () => (Array.isArray(pointsRes.data?.points) ? pointsRes.data.points : []),
    [pointsRes.data],
  );
  return (
    <HysteresisDatasetResultView
      {...props}
      activeSnapshot={activeSnapshot}
      manifest={manifestRes.data ?? null}
      points={points}
      revision={pointsRes.revision ?? arRef?.datasetRevision ?? null}
    />
  );
}

function HysteresisDatasetResultView({
  activeSnapshot = null,
  manifest,
  points,
  revision,
  selection,
}: InspectorPanelProps & {
  activeSnapshot?: ReturnType<typeof activeHysteresisSnapshotSelection>;
  manifest: ReturnType<typeof useAnalysisResultDatasetManifestResource>["data"] | null;
  points: HysteresisPointSchema[];
  revision: string | number | null;
}) {
  const kernelFromCtx = useContext(KernelContext);
  const kernel = useMemo(
    () => kernelFromCtx ?? createFallbackKernel(selection),
    [kernelFromCtx, selection],
  );
  const stageId = resolveHysteresisStageId(selection);
  const arRef = selection.ref?.type === "analysis-result" ? selection.ref : null;
  const [branchFilter, setBranchFilter] = useState("all");
  const [bucket, setBucket] = useState<HysteresisBucket>("all");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<number>>(() => new Set());

  const branches = useMemo(() => {
    const unique = new Set<string>();
    for (const pt of points) {
      if (pt.branch_id) unique.add(pt.branch_id);
    }
    return Array.from(unique);
  }, [points]);

  const filteredPoints = useMemo(
    () =>
      branchFilter === "all"
        ? points
        : points.filter((pt) => pt.branch_id === branchFilter),
    [branchFilter, points],
  );

  const manifestModel = useMemo(
    () =>
      manifest
        ? buildAnalysisResultInspectorModel({ item: null, manifest })
        : null,
    [manifest],
  );

  const toggleBookmark = useCallback(
    (point: HysteresisPointSchema) => {
      setBookmarkedIds((prev) => {
        const next = new Set(prev);
        if (next.has(point.point_id)) next.delete(point.point_id);
        else next.add(point.point_id);
        return next;
      });
      if (stageId && kernelFromCtx) {
        void kernelFromCtx.commands.execute(
          "hysteresis.bookmark-point",
          createCommandContext("inspector", kernelFromCtx),
          { point, stageId },
        );
      }
    },
    [kernelFromCtx, stageId],
  );

  const openInAnalysis = useCallback(() => {
    kernelFromCtx?.layout?.setActiveViewportMainModule?.("analysis-plots");
    kernelFromCtx?.layout?.setFocusedSlot?.("viewport-main");
    if (kernelFromCtx) {
      void kernelFromCtx.commands.execute(
        "workspace.focus-selection",
        createCommandContext("inspector", kernelFromCtx),
      );
    }
  }, [kernelFromCtx]);

  const exportDatasetCsv = useCallback(() => {
    if (!stageId) return;
    void kernel.commands.execute(
      "hysteresis.export-loop-csv",
      createCommandContext("inspector", kernel),
      { points: filteredPoints, stageId },
    );
  }, [filteredPoints, kernel, stageId]);

  const spec = useMemo<InspectorSpec<ReadOnlyResultDraft>>(
    () => ({
      id: `results.hysteresis.dataset:${selection.nodeId ?? stageId ?? "dataset"}`,
      header: {
        breadcrumbs: [
          { id: "results", label: "Results" },
          { id: "hysteresis", label: "Hysteresis" },
          { id: "dataset", label: selection.label || "Loop Dataset" },
        ],
        ...(kernelFromCtx
          ? {
              primaryHeaderAction: {
                label: "Open in Analysis",
                icon: ExternalLink,
                onRun: () => openInAnalysis(),
              },
            }
          : {}),
        extraMenuActions: [
          {
            id: "open-15-col-sheet",
            label: "Open Full 15-Column Diagnostic Table…",
            icon: Table2,
            onSelect: () => setSheetOpen(true),
          },
          {
            id: "export-loop-csv",
            label: "Export Loop CSV",
            icon: Download,
            disabledReason:
              !stageId || filteredPoints.length === 0
                ? "No sweep points available to export"
                : undefined,
            onSelect: () => exportDatasetCsv(),
          },
        ],
      },
      identity: {
        domain: "physics",
        icon: Database,
        title: () => manifest?.title || selection.label || "Hysteresis Loop Dataset",
        kindLabel: "Branch-filtered magnetization sweep dataset",
        entityId: arRef?.datasetId ?? stageId ?? undefined,
        statePill: () =>
          points.length > 0
            ? { label: `${points.length} points`, tone: "ok" }
            : { label: manifest?.status?.completeness ?? "Published", tone: "neutral" },
      },
      facts: () => [
        { id: "pts", label: "Points", value: String(points.length) },
        { id: "branches", label: "Branches", value: String(branches.length) },
        {
          id: "states",
          label: "3D states",
          value: String(points.filter((p) => Boolean(p.snapshot_id)).length),
        },
        ...(stageId ? [{ id: "stage", label: "Stage", value: stageId }] : []),
      ],
      sections: [
        {
          id: "dataset-explorer",
          title: "Loop Curve, Branch Filter & Points",
          icon: Table2,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <div className="grid min-w-0 gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      type="button"
                      variant="primary"
                      onClick={openInAnalysis}
                    >
                      <ExternalLink aria-hidden="true" size={13} />
                      <span>Open in Analysis</span>
                    </Button>
                    <Button
                      disabled={!stageId || filteredPoints.length === 0}
                      disabledReason="No sweep points available to export"
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={exportDatasetCsv}
                    >
                      <Download aria-hidden="true" size={13} />
                      <span>Export CSV</span>
                    </Button>
                  </div>
                  <HysteresisInteractiveExplorerBlock
                    activeSnapshot={activeSnapshot}
                    bookmarkedIds={bookmarkedIds}
                    branchFilter={branchFilter}
                    bucket={bucket}
                    kernel={kernel}
                    points={points}
                    progress={null}
                    revision={revision}
                    stageId={stageId}
                    onBranchFilterChange={setBranchFilter}
                    onBucketChange={setBucket}
                    onOpenSheet={() => setSheetOpen(true)}
                    onToggleBookmark={toggleBookmark}
                  />
                </div>
              ),
            },
          ],
        },
        {
          id: "dataset-manifest",
          title: "Dataset Manifest & Columns",
          icon: Database,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Dataset ID",
              mono: true,
              format: () => arRef?.datasetId ?? manifest?.dataset_id ?? stageId ?? "—",
            },
            {
              type: "readonly",
              label: "Run",
              mono: true,
              format: () => arRef?.runId ?? manifest?.run_id ?? "—",
            },
            {
              type: "readonly",
              label: "Stage",
              mono: true,
              format: () => stageId ?? manifest?.stage_id ?? "—",
            },
            {
              type: "readonly",
              label: "Dataset revision",
              mono: true,
              format: () => String(revision ?? manifest?.dataset_revision ?? "—"),
            },
            {
              type: "custom",
              wide: true,
              render: () => (
                <div className="grid min-w-0 gap-2">
                  {manifestModel && manifestModel.axes.length > 0 ? (
                    <InspectorGroup title="Published axes">
                      {manifestModel.axes.map((ax) => (
                        <FieldRow
                          key={ax.label}
                          label={ax.label}
                          value={ax.value === "Unavailable" ? "—" : ax.value}
                        />
                      ))}
                    </InspectorGroup>
                  ) : null}
                  {manifestModel && manifestModel.provenance.length > 0 ? (
                    <InspectorGroup title="Published provenance">
                      {manifestModel.provenance.map((row) => (
                        <FieldRow
                          key={`${row.label}:${row.value}`}
                          label={row.label}
                          mono={row.mono}
                          value={row.value === "Unavailable" ? "—" : row.value}
                        />
                      ))}
                    </InspectorGroup>
                  ) : null}
                  {manifestModel && manifestModel.sources.length > 0 ? (
                    <InspectorGroup title="Source artifacts">
                      {manifestModel.sources.map((row) => (
                        <FieldRow
                          key={`${row.label}:${row.value}`}
                          label={row.label}
                          mono={row.mono}
                          value={row.value === "Unavailable" ? "—" : row.value}
                        />
                      ))}
                    </InspectorGroup>
                  ) : null}
                  <InspectorGroup
                    badge={`${HYSTERESIS_DATASET_COLUMNS.length} cols`}
                    title="Tabular column schema"
                  >
                    {HYSTERESIS_DATASET_COLUMNS.map((col) => (
                      <FieldRow
                        key={col.column}
                        label={`${col.column} [${col.unit}]`}
                        value={col.meaning}
                      />
                    ))}
                  </InspectorGroup>
                </div>
              ),
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      activeSnapshot,
      arRef?.datasetId,
      arRef?.runId,
      bookmarkedIds,
      branchFilter,
      branches.length,
      bucket,
      exportDatasetCsv,
      filteredPoints.length,
      kernel,
      kernelFromCtx,
      manifest,
      manifestModel,
      openInAnalysis,
      points,
      revision,
      selection.label,
      selection.nodeId,
      stageId,
      toggleBookmark,
    ],
  );

  return (
    <>
      <ConnectedInspectorSpec
        baseline={DEFAULT_RESULT_DRAFT}
        selection={selection}
        spec={spec}
      />
      <HysteresisDiagnosticTableSheet
        open={sheetOpen}
        points={filteredPoints}
        stageId={stageId ?? "hysteresis"}
        onBookmarkPoint={toggleBookmark}
        onExportCsv={(exportPts) => {
          if (!stageId) return;
          void kernel.commands.execute(
            "hysteresis.export-loop-csv",
            createCommandContext("inspector", kernel),
            { points: exportPts, stageId },
          );
        }}
        onLoadPointIn3D={(pt) => {
          if (stageId) executeLoadHysteresisPointIn3D(kernel, stageId, pt);
        }}
        onOpenChange={setSheetOpen}
        onUsePointAsInitialState={(pt) => {
          if (stageId) executeUsePointAsInitialState(kernel, stageId, pt);
        }}
      />
    </>
  );
}

export function HysteresisPointResultInspector(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  return kernel ? (
    <ConnectedHysteresisPointResultInspector {...props} />
  ) : (
    <HysteresisPointResultView
      {...props}
      points={[]}
      settleTrace={[]}
      settleTraceStatus="idle"
    />
  );
}

function ConnectedHysteresisPointResultInspector(props: InspectorPanelProps) {
  const stageId = resolveHysteresisStageId(props.selection);
  const requestedPointId = resolveHysteresisPointId(props.selection, stageId);
  // <= 2 HTTP hooks: points + settle trace!
  const pointsRes = useHysteresisPointsResource(stageId ?? undefined, {
    enabled: Boolean(stageId),
  });
  const settleTraceRes = useHysteresisSettleTraceResource(
    stageId ?? undefined,
    requestedPointId ?? undefined,
    { enabled: Boolean(stageId) && requestedPointId !== null },
  );
  const activeSnapshot = useSelectionSelector(
    (sel) => (sel ? activeHysteresisSnapshotSelection(sel, stageId ?? undefined) : null),
    { isEqual: activeHysteresisSnapshotSelectionEquals },
  );
  const points = useMemo(
    () => (Array.isArray(pointsRes.data?.points) ? pointsRes.data.points : []),
    [pointsRes.data],
  );
  const settleTrace = useMemo(
    () => (Array.isArray(settleTraceRes.data) ? settleTraceRes.data : []),
    [settleTraceRes.data],
  );
  return (
    <HysteresisPointResultView
      {...props}
      activeSnapshotId={activeSnapshot?.snapshotId ?? null}
      points={points}
      settleTrace={settleTrace}
      settleTraceStatus={settleTraceRes.status}
    />
  );
}

function HysteresisPointResultView({
  activeSnapshotId = null,
  points,
  selection,
  settleTrace,
  settleTraceStatus,
}: InspectorPanelProps & {
  activeSnapshotId?: string | null;
  points: HysteresisPointSchema[];
  settleTrace: HysteresisSettleTraceEntrySchema[];
  settleTraceStatus: string;
}) {
  const kernelFromCtx = useContext(KernelContext);
  const kernel = useMemo(
    () => kernelFromCtx ?? createFallbackKernel(selection),
    [kernelFromCtx, selection],
  );
  const stageId = resolveHysteresisStageId(selection);
  const explicitPointId = resolveHysteresisPointId(selection, stageId);
  const point = useMemo(
    () =>
      explicitPointId !== null
        ? (points.find((p) => p.point_id === explicitPointId) ?? null)
        : null,
    [explicitPointId, points],
  );
  const displayPointId = point?.point_id ?? explicitPointId ?? 0;

  const replayAction = useMemo(
    () =>
      hysteresisReplayActionPresentation(
        point?.snapshot_id,
        point?.snapshot_storage_status,
        point?.snapshot_storage_reason,
      ),
    [point?.snapshot_id, point?.snapshot_storage_reason, point?.snapshot_storage_status],
  );
  const initialStateAction = useMemo(
    () =>
      hysteresisInitialStateActionPresentation(
        point?.snapshot_id,
        point?.snapshot_storage_status,
        point?.snapshot_storage_reason,
      ),
    [point?.snapshot_id, point?.snapshot_storage_reason, point?.snapshot_storage_status],
  );
  const snapshotLoaded =
    activeSnapshotId !== null && activeSnapshotId === point?.snapshot_id;

  const spec = useMemo<InspectorSpec<ReadOnlyResultDraft>>(
    () => ({
      id: `results.hysteresis.point:${stageId ?? "stage"}:${displayPointId}`,
      header: {
        breadcrumbs: [
          { id: "results", label: "Results" },
          { id: "hysteresis", label: "Hysteresis" },
          { id: "point", label: `Point ${displayPointId}` },
        ],
        ...(point && stageId && !replayAction.disabled && kernelFromCtx
          ? {
              primaryHeaderAction: {
                label: "Load Snapshot in 3D",
                icon: Box,
                onRun: () => {
                  executeLoadHysteresisPointIn3D(kernelFromCtx, stageId, point);
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Activity,
        title: () =>
          point
            ? `Point #${point.point_id} (${point.field_value_mT.toFixed(2)} mT)`
            : `Hysteresis Point #${displayPointId}`,
        kindLabel: "Single equilibrium field-sweep state",
        entityId: point?.snapshot_id ?? `pt_${displayPointId}`,
        statePill: () =>
          point
            ? { label: point.settle_status ?? point.status, tone: "ok" }
            : { label: "Selected", tone: "neutral" },
      },
      facts: () => [
        {
          id: "field",
          label: "Applied field",
          value: point ? `${point.field_value_mT.toFixed(3)} mT` : "—",
        },
        {
          id: "m-par",
          label: "m_parallel",
          value: point ? point.m_parallel.toFixed(6) : "—",
        },
        {
          id: "branch",
          label: "Branch",
          value: point?.branch_id ?? "major",
        },
        {
          id: "snap",
          label: "3D snapshot",
          value:
            point?.snapshot_storage_status ??
            (point?.snapshot_id ? "available" : "not saved"),
        },
      ],
      notices: () =>
        explicitPointId !== null && point === null
          ? [
              {
                id: "point-pending",
                tone: "info" as const,
                text: `Point #${explicitPointId} is selected, but its calculated point record is not available yet.`,
              },
            ]
          : [],
      sections: [
        {
          id: "point-actions-and-vector",
          title: "Magnetization Projection, Vector & 3D Actions",
          icon: Magnet,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Point index",
              mono: true,
              format: () => String(displayPointId),
            },
            {
              type: "readonly",
              label: "Parallel projection (M_parallel)",
              mono: true,
              format: () => (point ? point.m_parallel.toFixed(6) : "—"),
            },
            {
              type: "readonly",
              label: "Out-of-plane component (M_oop)",
              mono: true,
              format: () => (point ? point.m_oop.toFixed(6) : "—"),
            },
            {
              type: "readonly",
              label: "In-plane magnitude (M_ip)",
              mono: true,
              format: () => (point ? point.m_ip.toFixed(6) : "—"),
            },
            {
              type: "readonly",
              label: "Average vector (M_avg)",
              mono: true,
              format: () =>
                point && Array.isArray(point.m_avg) && point.m_avg.length === 3
                  ? point.m_avg.map((v) => v.toFixed(6)).join(", ")
                  : "—",
            },
            {
              type: "custom",
              wide: true,
              render: () => (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Hysteresis point actions">
                  <Button
                    aria-label="Load Snapshot in 3D"
                    disabled={!point || !stageId || replayAction.disabled}
                    disabledReason={replayAction.title}
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={() => {
                      if (point && stageId) executeLoadHysteresisPointIn3D(kernel, stageId, point);
                    }}
                  >
                    <Box aria-hidden="true" size={13} />
                    <span>Load Snapshot in 3D</span>
                  </Button>
                  <Button
                    aria-label="Use as Initial State"
                    disabled={!point || !stageId || initialStateAction.disabled}
                    disabledReason={initialStateAction.title}
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      if (point && stageId) executeUsePointAsInitialState(kernel, stageId, point);
                    }}
                  >
                    <span>Use as Initial</span>
                  </Button>
                  <Button
                    aria-label="Compare point in chart"
                    disabled={!point || !stageId}
                    disabledReason="Point record is not loaded yet"
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      if (!point || !stageId) return;
                      void kernel.commands.execute(
                        "hysteresis.compare-point",
                        createCommandContext("inspector", kernel),
                        { point, stageId },
                      );
                    }}
                  >
                    <span>Compare</span>
                  </Button>
                  <Button
                    aria-label="Bookmark point"
                    disabled={!point || !stageId}
                    disabledReason="Point record is not loaded yet"
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      if (!point || !stageId) return;
                      void kernel.commands.execute(
                        "hysteresis.bookmark-point",
                        createCommandContext("inspector", kernel),
                        { point, stageId },
                      );
                    }}
                  >
                    <Bookmark aria-hidden="true" size={13} />
                    <span>Bookmark</span>
                  </Button>
                  <Button
                    aria-label="Export point CSV"
                    disabled={!point || !stageId}
                    disabledReason="Point record is not loaded yet"
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      if (!point || !stageId) return;
                      void kernel.commands.execute(
                        "hysteresis.export-point-csv",
                        createCommandContext("inspector", kernel),
                        { point, stageId },
                      );
                    }}
                  >
                    <Download aria-hidden="true" size={13} />
                    <span>Export CSV</span>
                  </Button>
                  {snapshotLoaded ? (
                    <Button
                      aria-label="Return 3D viewport to live field"
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        if (stageId) {
                          clearHysteresisPointSelectionForLive(kernel, stageId, "inspector");
                        }
                        void kernel.commands.execute(
                          "hysteresis.return-to-live",
                          createCommandContext("inspector", kernel),
                          { stageId },
                        );
                      }}
                    >
                      <RotateCcw aria-hidden="true" size={13} />
                      <span>Return to Live</span>
                    </Button>
                  ) : null}
                </div>
              ),
            },
          ],
        },
        {
          id: "settle-provenance",
          title: "Settle Solver, Snapshot Status & Trace",
          icon: GitCommit,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Settle status",
              format: () => point?.settle_status ?? point?.status ?? "—",
            },
            ...(point?.terminal_settle_reason
              ? [
                  {
                    type: "readonly" as const,
                    label: "Stop reason",
                    format: () => point.terminal_settle_reason!,
                  },
                ]
              : []),
            ...(point?.warning_count != null && point.warning_count > 0
              ? [
                  {
                    type: "readonly" as const,
                    label: "Warnings",
                    format: () => String(point.warning_count),
                  },
                ]
              : []),
            {
              type: "readonly",
              label: "Snapshot ID",
              mono: true,
              format: () => point?.snapshot_id ?? "not saved",
            },
            ...(point?.snapshot_storage_status
              ? [
                  {
                    type: "readonly" as const,
                    label: "Snapshot storage status",
                    format: () => point.snapshot_storage_status!,
                  },
                ]
              : []),
            ...(point?.snapshot_storage_reason
              ? [
                  {
                    type: "readonly" as const,
                    label: "Snapshot detail",
                    format: () => point.snapshot_storage_reason!,
                  },
                ]
              : []),
            {
              type: "readonly",
              label: "Protocol role",
              format: () => point?.protocol_role ?? "major",
            },
            {
              type: "readonly",
              label: "Schedule source",
              format: () =>
                point?.adaptive_inserted ? "Adaptive refinement" : "Planned grid",
            },
            {
              type: "readonly",
              label: "Owner stage",
              mono: true,
              format: () => stageId ?? "—",
            },
            {
              type: "custom",
              wide: true,
              render: () => (
                <HysteresisSettleTraceInspector
                  activePoint={{
                    fieldValueMt: point?.field_value_mT ?? 0,
                    pointId: displayPointId,
                    snapshotId: point?.snapshot_id ?? null,
                  }}
                  settleTrace={settleTrace}
                  settleTraceStatus={settleTraceStatus}
                />
              ),
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      displayPointId,
      explicitPointId,
      initialStateAction.disabled,
      initialStateAction.title,
      kernel,
      kernelFromCtx,
      point,
      replayAction.disabled,
      replayAction.title,
      settleTrace,
      settleTraceStatus,
      snapshotLoaded,
      stageId,
    ],
  );

  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function AnalysisResultTemplateInspectorPanel(
  props: InspectorPanelProps,
) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedAnalysisResultTemplateInspectorPanel {...props} />;
  }
  return <AnalysisResultTemplateFallbackView {...props} />;
}

function ConnectedAnalysisResultTemplateInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const ref = selection.ref?.type === "analysis-result" ? selection.ref : null;
  const manifest = useAnalysisResultDatasetManifestResource(
    ref?.runId,
    ref?.datasetId,
    { enabled: Boolean(ref) },
  );
  const samples = useAnalysisResultSamplesResource(ref?.runId, ref?.datasetId, {
    enabled: Boolean(ref),
    query: { limit: 24 },
  });
  const branch = useAnalysisResultBranchResource(
    ref?.runId,
    ref?.datasetId,
    ref?.branchId,
    { enabled: Boolean(ref?.focus === "branch" && ref?.branchId) },
  );
  const item = useAnalysisResultItemResource(
    ref?.runId,
    ref?.datasetId,
    ref?.itemId,
    { enabled: Boolean(ref?.itemId) },
  );

  const hasFieldOverlay = Boolean(ref && createAnalysisResultFieldOverlayIntent(ref));
  const completeness =
    item.data?.status?.completeness ??
    branch.data?.status?.completeness ??
    manifest.data?.status?.completeness ??
    manifest.status;
  const residualL2 = item.data?.quality?.residual_relative_l2;
  const axesCount = manifest.data?.axes?.length;
  const sampleItems = useMemo(
    () => samples.data?.items ?? [],
    [samples.data?.items],
  );

  const spec = useMemo<InspectorSpec<ReadOnlyResultDraft>>(
    () => ({
      id: `analysis.result:${selection.nodeId ?? ref?.itemId ?? ref?.datasetId ?? "item"}`,
      header: {
        breadcrumbs: [
          { id: "results", label: "Results" },
          { id: "dataset", label: manifest.data?.title || selection.label || ref?.datasetId || "Result" },
        ],
      },
      identity: {
        domain: "physics",
        icon: Database,
        title: () =>
          selection.label ||
          ref?.itemId ||
          ref?.sampleId ||
          manifest.data?.title ||
          ref?.datasetId ||
          "Analysis Result",
        kindLabel: "Run-scoped published result dataset",
        entityId: ref?.itemId ?? ref?.datasetId ?? selection.nodeId ?? undefined,
        statePill: () => ({
          label: completeness || "Published",
          tone: completeness === "complete" || completeness === "ready" ? "ok" : "neutral",
        }),
      },
      facts: () => [
        { id: "focus", label: "Focus", value: ref?.focus ?? "dataset" },
        { id: "status", label: "Status", value: completeness || "ready" },
        ...(typeof residualL2 === "number" && Number.isFinite(residualL2)
          ? [{ id: "res", label: "Residual L2", value: residualL2.toExponential(2) }]
          : []),
        ...(typeof axesCount === "number"
          ? [{ id: "axes", label: "Axes", value: String(axesCount) }]
          : []),
      ],
      sections: [
        ...(sampleItems.length > 1
          ? [
              {
                id: "sample-selector",
                title: `Dataset Samples (${sampleItems.length})`,
                icon: Table2,
                defaultOpen: false,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Analysis result samples">
                        {sampleItems.map((smp) => {
                          const active = smp.sample_id === ref?.sampleId;
                          const coordLabel =
                            smp.coordinates
                              ?.map((c) => `${c.axis_id}=${c.label ?? c.token}`)
                              .join(" · ") || smp.sample_id;
                          return (
                            <Button
                              key={smp.sample_id}
                              size="sm"
                              type="button"
                              variant={active ? "primary" : "secondary"}
                              onClick={() => {
                                if (!ref || !kernel) return;
                                kernel.selection.set(
                                  {
                                    kind: "analysis.result",
                                    label: coordLabel,
                                    nodeId: `${ref.nodeId}:sample:${smp.sample_id}`,
                                    objectId: null,
                                    ref: {
                                      ...ref,
                                      focus: "sample",
                                      sampleId: smp.sample_id,
                                    },
                                  },
                                  "inspector",
                                );
                              }}
                            >
                              {coordLabel}
                            </Button>
                          );
                        })}
                      </div>
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          id: "full-analysis-result",
          title: "Result Dataset, 3D Field Overlay & Provenance",
          icon: Database,
          defaultOpen: true,
          live: hasFieldOverlay,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <div className="grid min-w-0 gap-3">
                  <AnalysisResultInspectorPanel
                    embedded
                    emptyPlaceholder="—"
                    selection={selection}
                  />
                  <ReferenceImportSection />
                </div>
              ),
            },
          ],
        },
      ],
      commitBar: hasFieldOverlay
        ? {
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
          }
        : { mode: "readOnly" },
    }),
    [
      axesCount,
      completeness,
      hasFieldOverlay,
      kernel,
      manifest.data?.title,
      ref,
      residualL2,
      sampleItems,
      selection,
    ],
  );

  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

function AnalysisResultTemplateFallbackView({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "analysis-result" ? selection.ref : null;
  const spec = useMemo<InspectorSpec<ReadOnlyResultDraft>>(
    () => ({
      id: `analysis.result:${selection.nodeId ?? "item"}`,
      header: {
        breadcrumbs: [
          { id: "results", label: "Results" },
          { id: "dataset", label: selection.label || ref?.datasetId || "Result" },
        ],
      },
      identity: {
        domain: "physics",
        icon: Database,
        title: () =>
          selection.label || ref?.itemId || ref?.datasetId || "Analysis Result",
        kindLabel: "Run-scoped published result dataset",
        entityId: ref?.datasetId ?? selection.nodeId ?? undefined,
        statePill: () => ({
          label: ref ? "Published" : "Selected",
          tone: ref ? "ok" : "neutral",
        }),
      },
      facts: () => [
        { id: "run", label: "Run", value: ref?.runId ?? "Active" },
        { id: "stage", label: "Stage", value: ref?.stageId ?? "—" },
        { id: "focus", label: "Focus", value: ref?.focus ?? "dataset" },
        { id: "rev", label: "Revision", value: ref?.datasetRevision ?? "Current" },
      ],
      sections: [
        {
          id: "result-summary",
          title: "Dataset Identity & Provenance",
          icon: GitCommit,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Dataset ID",
              mono: true,
              format: () => ref?.datasetId ?? "—",
            },
            {
              type: "readonly",
              label: "Sample / Item",
              mono: true,
              format: () => ref?.itemId ?? ref?.sampleId ?? "Dataset root",
            },
            {
              type: "readonly",
              label: "Selection source",
              format: () => selection.moduleSource,
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [ref, selection.label, selection.moduleSource, selection.nodeId],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_RESULT_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}
