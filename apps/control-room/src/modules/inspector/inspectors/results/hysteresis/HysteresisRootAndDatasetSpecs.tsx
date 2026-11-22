"use client";

import {
  Database,
  Download,
  ExternalLink,
  GitCommit,
  Magnet,
  Sigma,
  Table2,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { HysteresisPointSchema } from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useAnalysisResultDatasetManifestResource } from "@/kernel/resources/analysisResultResources";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { useHysteresisPointsResource, useHysteresisProgressResource } from "@/kernel/resources/studyRuntimeResources";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import { minMaxFinite } from "@/shared/charts/ScientificEChart";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorGroup } from "../../../primitives/InspectorGroup";
import type { InspectorSpec } from "../../../template";
import { buildAnalysisResultInspectorModel } from "../../../panels/analysis-results/analysisResultInspectorModel";
import { HysteresisDiagnosticTableSheet } from "../../../panels/stages/HysteresisDiagnosticTableSheet";
import {
  activeHysteresisSnapshotSelection,
  activeHysteresisSnapshotSelectionEquals,
} from "../../../panels/stages/hysteresis/HysteresisInspectorUtils";
import { ConnectedInspectorSpec } from "../../../panels/study/ConnectedInspectorSpec";
import {
  resolveHysteresisStageId,
  createFallbackKernel,
  type HysteresisBucket,
  type ReadOnlyResultDraft,
  HysteresisInteractiveExplorerBlock,
  DEFAULT_RESULT_DRAFT,
  executeLoadHysteresisPointIn3D,
  executeUsePointAsInitialState,
  HYSTERESIS_DATASET_COLUMNS,
} from "./hysteresisShared";

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
