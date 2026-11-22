"use client";

import {
  Activity,
  Bookmark,
  Box,
  Database,
  Download,
  GitCommit,
  Magnet,
  RotateCcw,
  Table2,
} from "lucide-react";
import { useContext, useMemo } from "react";
import type { HysteresisPointSchema, HysteresisSettleTraceEntrySchema } from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  useAnalysisResultBranchResource,
  useAnalysisResultDatasetManifestResource,
  useAnalysisResultItemResource,
  useAnalysisResultSamplesResource,
} from "@/kernel/resources/analysisResultResources";
import {
  useHysteresisPointsResource,
  useHysteresisSettleTraceResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import { createAnalysisResultFieldOverlayIntent } from "@/kernel/visualization/AnalysisResultFieldOverlayIntent";
import { clearHysteresisPointSelectionForLive } from "@/shared/domain/study/HysteresisChart";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorSpec } from "../../../template";
import { AnalysisResultInspectorPanel } from "../../../panels/analysis-results/AnalysisResultInspectorPanel";
import { ReferenceImportSection } from "../../../panels/analysis-results/ReferenceImportSection";
import {
  activeHysteresisSnapshotSelection,
  activeHysteresisSnapshotSelectionEquals,
  hysteresisInitialStateActionPresentation,
  hysteresisReplayActionPresentation,
} from "../../../panels/stages/hysteresis/HysteresisInspectorUtils";
import { HysteresisSettleTraceInspector } from "../../../panels/stages/hysteresis/HysteresisSettleTraceInspector";
import { ConnectedInspectorSpec } from "../../../panels/study/ConnectedInspectorSpec";
import {
  resolveHysteresisStageId,
  resolveHysteresisPointId,
  createFallbackKernel,
  type ReadOnlyResultDraft,
  executeLoadHysteresisPointIn3D,
  executeUsePointAsInitialState,
  DEFAULT_RESULT_DRAFT,
} from "./hysteresisShared";

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
