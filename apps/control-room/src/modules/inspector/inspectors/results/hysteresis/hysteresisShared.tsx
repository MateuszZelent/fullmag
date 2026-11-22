"use client";

import {
  Box,
  Download,
  RotateCcw,
  Table2,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import type {
  HysteresisMetricsSchema,
  HysteresisPointSchema,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useHysteresisProgressResource } from "@/kernel/resources/studyRuntimeResources";
import type { KernelApi } from "@/kernel/types";
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
import type { InspectorPanelProps } from "../../../inspectorTypes";
import {
  activeHysteresisPointSelection,
  activeHysteresisSnapshotSelection,
  hysteresisReplayActionPresentation,
} from "../../../panels/stages/hysteresis/HysteresisInspectorUtils";
import { HysteresisMetricsInspector } from "../../../panels/stages/hysteresis/HysteresisMetricsInspector";

export interface ReadOnlyResultDraft {
  branchFilter: string;
}

export const DEFAULT_RESULT_DRAFT: ReadOnlyResultDraft = { branchFilter: "all" };

export type HysteresisBucket = "all" | "snapshots" | "transitions" | "bookmarks";

export const HYSTERESIS_DATASET_COLUMNS: ReadonlyArray<{
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

export function createFallbackKernel(selection: InspectorPanelProps["selection"]): KernelApi {
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

export function executeLoadHysteresisPointIn3D(
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

export function executeUsePointAsInitialState(
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

export function HysteresisInteractiveExplorerBlock({
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
