"use client";

import { Magnet } from "lucide-react";
import { useContext, useMemo, type ReactElement } from "react";

import { KernelContext } from "@/kernel/KernelContext";
import {
  useHysteresisAdaptiveRefinementResource,
  useHysteresisBookmarksResource,
  useHysteresisBranchesResource,
  useHysteresisExecutionTreeResource,
  useHysteresisFamilyResource,
  useHysteresisMetricsResource,
  useHysteresisMinorLoopsResource,
  useHysteresisOrientationResource,
  useHysteresisPointResource,
  useHysteresisPointsResource,
  useHysteresisProgressResource,
  useHysteresisProtocolResource,
  useHysteresisReversalFieldsResource,
  useHysteresisSaturationResource,
  useHysteresisSettlePipelineResource,
  useHysteresisSettleTraceResource,
  useHysteresisStagePlanResource,
  useHysteresisStageSaturationResource,
  useHysteresisStageSettleTraceResource,
} from "@/kernel/resources/studyRuntimeResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import {
  hysteresisTargetMetadataFromOrientation,
} from "@/shared/domain/study/HysteresisChart";

import type { InspectorFact, InspectorSpec } from "../../../template";
import type { StudyStageDraft } from "../../../panels/StudyStageAuthoringModel";
import { useKernelStudyAuthoring } from "../../../panels/study/useConnectedStudyAuthoring";
import {
  HysteresisAdaptiveRefinementInspector,
} from "../../../panels/stages/hysteresis/HysteresisAdaptiveRefinementInspector";
import {
  HysteresisAngularFamilyInspector,
} from "../../../panels/stages/hysteresis/HysteresisAngularFamilyInspector";
import {
  HysteresisBookmarksInspector,
} from "../../../panels/stages/hysteresis/HysteresisBookmarksInspector";
import {
  HysteresisBranchDetailInspector,
} from "../../../panels/stages/hysteresis/HysteresisBranchDetailInspector";
import {
  HysteresisBranchesInspector,
} from "../../../panels/stages/hysteresis/HysteresisBranchesInspector";
import {
  HysteresisCurrentFieldInspector,
} from "../../../panels/stages/hysteresis/HysteresisCurrentFieldInspector";
import {
  HysteresisExecutionNodeInspector,
} from "../../../panels/stages/hysteresis/HysteresisExecutionNodeInspector";
import {
  activeHysteresisBranchSelection,
  activeHysteresisExecutionNodeSelection,
  activeHysteresisPointSelection,
  activeHysteresisSnapshotSelection,
  resolveHysteresisInspectorView,
  type HysteresisInspectorView,
} from "../../../panels/stages/hysteresis/HysteresisInspectorUtils";
import {
  HysteresisLiveProgressInspector,
} from "../../../panels/stages/hysteresis/HysteresisLiveProgressInspector";
import {
  HysteresisMetricsInspector,
} from "../../../panels/stages/hysteresis/HysteresisMetricsInspector";
import {
  HysteresisOrientationInspector,
} from "../../../panels/stages/hysteresis/HysteresisOrientationInspector";
import {
  HysteresisPlanInspector,
} from "../../../panels/stages/hysteresis/HysteresisPlanInspector";
import {
  HysteresisPointBucketInspector,
} from "../../../panels/stages/hysteresis/HysteresisPointBucketInspector";
import {
  HysteresisPointDetailInspector,
} from "../../../panels/stages/hysteresis/HysteresisPointDetailInspector";
import {
  HysteresisPointsInspector,
} from "../../../panels/stages/hysteresis/HysteresisPointsInspector";
import {
  HysteresisProtocolInspector,
} from "../../../panels/stages/hysteresis/HysteresisProtocolInspector";
import {
  HysteresisSaturationInspector,
} from "../../../panels/stages/hysteresis/HysteresisSaturationInspector";
import {
  HysteresisSettlePipelineInspector,
} from "../../../panels/stages/hysteresis/HysteresisSettlePipelineInspector";
import {
  HysteresisSettleTraceInspector,
} from "../../../panels/stages/hysteresis/HysteresisSettleTraceInspector";
import {
  HysteresisSnapshotsInspector,
} from "../../../panels/stages/hysteresis/HysteresisSnapshotsInspector";
import {
  HysteresisTransitionsInspector,
} from "../../../panels/stages/hysteresis/HysteresisTransitionsInspector";
import {
  hasKernelResourceRuntime,
  StageSpecHost,
} from "../../../panels/stages/StageSharedControls";
import { stageBreadcrumbs, resolveStageMeta } from "./stageShared";
export function resolveSelectionHysteresisView(
  selection: Selection,
): HysteresisInspectorView {
  const fromNode = resolveHysteresisInspectorView(selection.nodeId);
  if (fromNode !== "overview") return fromNode;
  if (selection.ref?.type === "hysteresis-snapshot") return "snapshots";
  if (selection.ref?.type === "study-stage") {
    if (selection.ref.hysteresisExecutionNodeId) return "execution-node";
    if (selection.ref.hysteresisPointId != null) return "point-detail";
  }
  return "overview";
}

function resolveHysteresisStageIdFromSelection(
  selection: Selection,
  fallbackStageId: string,
): string {
  if (selection.ref?.type === "study-stage" && selection.ref.stageId) {
    return selection.ref.stageId;
  }
  if (selection.ref?.type === "hysteresis-snapshot" && selection.ref.stageId) {
    return selection.ref.stageId;
  }
  const match = selection.nodeId?.match(/:stage:([^:]+):/);
  return match?.[1] ?? fallbackStageId;
}

const NOOP_HYSTERESIS_KERNEL = {
  commands: {
    execute: () => Promise.resolve({ status: "completed" }),
    getSessionScopeKey: () => null,
  },
  selection: {
    clear: () => undefined,
    get: () => null,
    set: () => undefined,
    subscribe: () => () => undefined,
  },
} as unknown as KernelApi;


export function ConnectedHysteresisChildInspectorPanel({
  selection,
  view,
}: {
  selection: Selection;
  view: Exclude<HysteresisInspectorView, "overview">;
}) {
  const kernel = useContext(KernelContext)!;
  const { selectedStageDraft } = useKernelStudyAuthoring(selection);
  const { stageId: fallbackStageId } = resolveStageMeta(selection, "hysteresis");
  const stageId = resolveHysteresisStageIdFromSelection(
    selection,
    selectedStageDraft?.stageId || fallbackStageId,
  );
  const hasSimulationApi =
    hasKernelResourceRuntime(kernel) &&
    Boolean(
      (
        kernel.api as
          | { analysis?: { hysteresis?: unknown } }
          | undefined
      )?.analysis?.hysteresis,
    );

  if (!hasSimulationApi) {
    return (
      <HysteresisChildInspectorFrame
        content={renderHysteresisSubView({
          draft: selectedStageDraft,
          kernel,
          selection,
          stageId,
          view,
        })}
        selection={selection}
        stageId={stageId}
        view={view}
      />
    );
  }

  return (
    <LoadedHysteresisChildResources
      draft={selectedStageDraft}
      kernel={kernel}
      selection={selection}
      stageId={stageId}
      view={view}
    />
  );
}

function LoadedHysteresisChildResources({
  draft,
  kernel,
  selection,
  stageId,
  view,
}: {
  draft: StudyStageDraft | null;
  kernel: KernelApi;
  selection: Selection;
  stageId: string;
  view: Exclude<HysteresisInspectorView, "overview">;
}) {
  const activePoint = activeHysteresisPointSelection(selection, stageId);

  const needPoints = [
    "point-detail",
    "live-run",
    "points",
    "points-completed",
    "points-queued",
    "points-planned",
    "snapshots",
    "transitions",
  ].includes(view);
  const needExecutionTree = [
    "execution-node",
    "points-bookmarks",
    "settle-pipeline",
  ].includes(view);
  const needBranches = view === "branches" || view === "branch-detail";
  const needProgress = [
    "current-field",
    "point-detail",
    "live-run",
    "points",
    "points-completed",
    "points-queued",
    "points-planned",
    "transitions",
  ].includes(view);
  const needOrientation = [
    "orientation",
    "point-detail",
    "points",
    "points-completed",
    "points-queued",
    "points-planned",
    "snapshots",
  ].includes(view);

  const pointsRes = useHysteresisPointsResource(stageId, { enabled: needPoints });
  const stagePlanRes = useHysteresisStagePlanResource(stageId, {
    enabled: view === "plan",
  });
  const protocolRes = useHysteresisProtocolResource(stageId, {
    enabled: view === "protocol",
  });
  const settlePipelineRes = useHysteresisSettlePipelineResource(stageId, {
    enabled: view === "settle-pipeline",
  });
  const executionTreeRes = useHysteresisExecutionTreeResource(stageId, {
    after: 1,
    before: 1,
    enabled: needExecutionTree,
  });
  const angularFamilyRes = useHysteresisFamilyResource(stageId, {
    enabled: view === "angular-family",
  });
  const metricsRes = useHysteresisMetricsResource(stageId, {
    enabled: view === "metrics" || view === "saturation",
  });
  const bookmarksRes = useHysteresisBookmarksResource(stageId, {
    enabled: view === "points-bookmarks",
  });
  const branchesRes = useHysteresisBranchesResource(stageId, {
    enabled: needBranches,
  });
  const minorLoopsRes = useHysteresisMinorLoopsResource(stageId, {
    enabled: needBranches,
  });
  const reversalFieldsRes = useHysteresisReversalFieldsResource(stageId, {
    enabled: view === "metrics",
  });
  const progressRes = useHysteresisProgressResource(stageId, {
    enabled: needProgress,
  });
  const stageSaturationRes = useHysteresisStageSaturationResource(stageId, {
    enabled: view === "saturation",
  });
  const saturationRes = useHysteresisSaturationResource(stageId, {
    enabled:
      view === "saturation" &&
      stageSaturationRes.data?.result_status === "available",
  });
  const adaptiveRefinementRes = useHysteresisAdaptiveRefinementResource(stageId, {
    enabled: view === "adaptive-refinement" || view === "plan",
  });
  const orientationRes = useHysteresisOrientationResource(stageId, {
    enabled: needOrientation,
  });
  const pointDetailRes = useHysteresisPointResource(stageId, activePoint?.pointId, {
    enabled: view === "point-detail" && activePoint?.pointId != null,
  });
  const settleTraceRes = useHysteresisSettleTraceResource(
    stageId,
    activePoint?.pointId,
    { enabled: view === "settle-trace" && activePoint?.pointId != null },
  );
  const stageSettleTraceRes = useHysteresisStageSettleTraceResource(stageId, {
    enabled: view === "settle-trace" && activePoint?.pointId == null,
  });

  const saturation =
    stageSaturationRes.data?.result ?? saturationRes.data?.saturation;
  const settleTrace =
    activePoint?.pointId != null
      ? Array.isArray(settleTraceRes.data)
        ? settleTraceRes.data
        : []
      : Array.isArray(stageSettleTraceRes.data?.settle_trace)
        ? stageSettleTraceRes.data.settle_trace
        : [];
  const settleTraceStatus =
    activePoint?.pointId != null
      ? settleTraceRes.status
      : stageSettleTraceRes.status;

  const content = renderHysteresisSubView({
    adaptiveRefinement: adaptiveRefinementRes.data?.adaptive_refinement,
    angularFamily: angularFamilyRes.data,
    bookmarks: bookmarksRes.data,
    branches: Array.isArray(branchesRes.data?.branches)
      ? branchesRes.data.branches
      : [],
    draft,
    executionTree: executionTreeRes.data,
    kernel,
    metrics: metricsRes.data?.metrics,
    minorLoops: Array.isArray(minorLoopsRes.data?.minor_loops)
      ? minorLoopsRes.data.minor_loops
      : [],
    orientation: orientationRes.data,
    pointDetail: pointDetailRes.data,
    points: Array.isArray(pointsRes.data?.points) ? pointsRes.data.points : [],
    progress: progressRes.data,
    protocol: protocolRes.data,
    reversalFields: Array.isArray(reversalFieldsRes.data?.reversal_fields)
      ? reversalFieldsRes.data.reversal_fields
      : [],
    saturation,
    settlePipeline: settlePipelineRes.data,
    settleTrace,
    settleTraceStatus,
    stageId,
    stagePlan: stagePlanRes.data,
    selection,
    view,
  });

  return (
    <HysteresisChildInspectorFrame
      content={content}
      selection={selection}
      stageId={stageId}
      view={view}
    />
  );
}

export function StandaloneHysteresisChildInspectorPanel({
  selection,
  view,
}: {
  selection: Selection;
  view: Exclude<HysteresisInspectorView, "overview">;
}) {
  const { stageId: fallbackStageId } = resolveStageMeta(selection, "hysteresis");
  const stageId = resolveHysteresisStageIdFromSelection(
    selection,
    fallbackStageId,
  );
  const content = renderHysteresisSubView({
    draft: null,
    kernel: NOOP_HYSTERESIS_KERNEL,
    selection,
    stageId,
    view,
  });
  return (
    <HysteresisChildInspectorFrame
      content={content}
      selection={selection}
      stageId={stageId}
      view={view}
    />
  );
}

function renderHysteresisSubView({
  adaptiveRefinement,
  angularFamily,
  bookmarks,
  branches = [],
  draft,
  executionTree,
  kernel,
  metrics,
  minorLoops = [],
  orientation,
  pointDetail,
  points = [],
  progress,
  protocol,
  reversalFields = [],
  saturation,
  selection,
  settlePipeline,
  settleTrace = [],
  settleTraceStatus = "idle",
  stageId,
  stagePlan,
  view,
}: {
  adaptiveRefinement?: Parameters<
    typeof HysteresisAdaptiveRefinementInspector
  >[0]["adaptiveRefinement"];
  angularFamily?: Parameters<
    typeof HysteresisAngularFamilyInspector
  >[0]["angularFamily"];
  bookmarks?: Parameters<typeof HysteresisBookmarksInspector>[0]["bookmarks"];
  branches?: Parameters<typeof HysteresisBranchesInspector>[0]["branches"];
  draft: StudyStageDraft | null;
  executionTree?: Parameters<
    typeof HysteresisExecutionNodeInspector
  >[0]["executionTree"];
  kernel: KernelApi;
  metrics?: Parameters<typeof HysteresisMetricsInspector>[0]["metrics"];
  minorLoops?: Parameters<typeof HysteresisBranchesInspector>[0]["minorLoops"];
  orientation?: Parameters<
    typeof HysteresisOrientationInspector
  >[0]["orientation"];
  pointDetail?: Parameters<
    typeof HysteresisPointDetailInspector
  >[0]["pointDetail"];
  points?: Parameters<typeof HysteresisPointsInspector>[0]["points"];
  progress?: Parameters<typeof HysteresisLiveProgressInspector>[0]["progress"];
  protocol?: Parameters<typeof HysteresisProtocolInspector>[0]["protocol"];
  reversalFields?: Parameters<
    typeof HysteresisMetricsInspector
  >[0]["reversalFields"];
  saturation?: Parameters<typeof HysteresisSaturationInspector>[0]["saturation"];
  selection: Selection;
  settlePipeline?: Parameters<
    typeof HysteresisSettlePipelineInspector
  >[0]["settlePipeline"];
  settleTrace?: Parameters<
    typeof HysteresisSettleTraceInspector
  >[0]["settleTrace"];
  settleTraceStatus?: Parameters<
    typeof HysteresisSettleTraceInspector
  >[0]["settleTraceStatus"];
  stageId: string;
  stagePlan?: Parameters<typeof HysteresisPlanInspector>[0]["stagePlan"];
  view: Exclude<HysteresisInspectorView, "overview">;
}): ReactElement {
  const activeSnapshot = activeHysteresisSnapshotSelection(selection, stageId);
  const activePoint = activeHysteresisPointSelection(selection, stageId);
  const activeBranch = activeHysteresisBranchSelection(selection, stageId);
  const activeExecutionNode = activeHysteresisExecutionNodeSelection(
    selection,
    stageId,
  );
  const targetMetadata = hysteresisTargetMetadataFromOrientation(orientation);
  const saturationPoints = Array.isArray(saturation?.points)
    ? saturation.points
    : [];
  const readOnlySettleDraft = draft
    ? { ...draft, kind: "unsupported" as const }
    : null;

  switch (view) {
    case "branches":
      return (
        <HysteresisBranchesInspector
          branches={branches}
          draft={draft}
          minorLoops={minorLoops}
        />
      );
    case "branch-detail":
      return (
        <HysteresisBranchDetailInspector
          activeBranch={activeBranch}
          branches={branches}
          minorLoops={minorLoops}
        />
      );
    case "current-field":
      return <HysteresisCurrentFieldInspector progress={progress} />;
    case "adaptive-refinement":
      return (
        <HysteresisAdaptiveRefinementInspector
          adaptiveRefinement={adaptiveRefinement}
        />
      );
    case "angular-family":
      return <HysteresisAngularFamilyInspector angularFamily={angularFamily} />;
    case "execution-node":
      return (
        <HysteresisExecutionNodeInspector
          activeExecutionNode={activeExecutionNode}
          executionTree={executionTree}
        />
      );
    case "point-detail":
      return (
        <HysteresisPointDetailInspector
          activePoint={activePoint}
          kernel={kernel}
          pointDetail={pointDetail}
          points={points}
          progress={progress}
          stageId={stageId}
          targetMetadata={targetMetadata}
        />
      );
    case "live-run":
      return (
        <HysteresisLiveProgressInspector
          activeSnapshot={activeSnapshot}
          kernel={kernel}
          points={points}
          progress={progress}
          stageId={stageId}
        />
      );
    case "metrics":
      return (
        <HysteresisMetricsInspector
          metrics={metrics}
          reversalFields={reversalFields}
        />
      );
    case "plan":
      return (
        <HysteresisPlanInspector
          adaptiveRefinement={adaptiveRefinement}
          draft={draft}
          stagePlan={stagePlan}
        />
      );
    case "orientation":
      return (
        <HysteresisOrientationInspector
          draft={draft}
          orientation={orientation}
          targetMetadata={targetMetadata}
        />
      );
    case "points":
      return (
        <HysteresisPointsInspector
          activeSnapshot={activeSnapshot}
          kernel={kernel}
          points={points}
          progress={progress}
          stageId={stageId}
          targetMetadata={targetMetadata}
        />
      );
    case "points-completed":
      return (
        <HysteresisPointBucketInspector
          bucket="completed"
          kernel={kernel}
          points={points}
          progress={progress}
          stageId={stageId}
          targetMetadata={targetMetadata}
        />
      );
    case "points-queued":
      return (
        <HysteresisPointBucketInspector
          bucket="queued"
          kernel={kernel}
          points={points}
          progress={progress}
          stageId={stageId}
          targetMetadata={targetMetadata}
        />
      );
    case "points-planned":
      return (
        <HysteresisPointBucketInspector
          bucket="planned"
          kernel={kernel}
          points={points}
          progress={progress}
          stageId={stageId}
          targetMetadata={targetMetadata}
        />
      );
    case "points-bookmarks":
      return (
        <HysteresisBookmarksInspector
          bookmarks={bookmarks}
          executionTree={executionTree}
        />
      );
    case "protocol":
      return (
        <HysteresisProtocolInspector draft={draft} protocol={protocol} />
      );
    case "saturation":
      return (
        <HysteresisSaturationInspector
          draft={draft}
          metrics={metrics}
          saturation={saturation}
          saturationPoints={saturationPoints}
        />
      );
    case "settle-pipeline":
      return (
        <HysteresisSettlePipelineInspector
          draft={readOnlySettleDraft}
          executionTree={executionTree}
          onUpdateDraft={() => undefined}
          settlePipeline={settlePipeline}
        />
      );
    case "snapshots":
      return (
        <HysteresisSnapshotsInspector
          activeSnapshot={activeSnapshot}
          draft={draft}
          kernel={kernel}
          points={points}
          stageId={stageId}
          targetMetadata={targetMetadata}
        />
      );
    case "settle-trace":
      return (
        <HysteresisSettleTraceInspector
          activePoint={activePoint}
          settleTrace={settleTrace}
          settleTraceStatus={settleTraceStatus}
        />
      );
    case "transitions":
      return (
        <HysteresisTransitionsInspector
          activePoint={activePoint}
          kernel={kernel}
          points={points}
          progress={progress}
          stageId={stageId}
        />
      );
  }
}

function HysteresisChildInspectorFrame({
  content,
  selection,
  stageId,
  view,
}: {
  content: ReactElement;
  selection: Selection;
  stageId: string;
  view: Exclude<HysteresisInspectorView, "overview">;
}) {
  const titleLabel = selection.label ?? `Hysteresis (${view})`;
  const baseline = useMemo(() => ({ stageId, view }), [stageId, view]);
  const spec = useMemo<InspectorSpec<{ stageId: string; view: string }>>(
    () => ({
      id: "study.stage.action.hysteresis",
      header: { breadcrumbs: stageBreadcrumbs(titleLabel) },
      identity: {
        domain: "study",
        icon: Magnet,
        title: () => titleLabel,
        kindLabel: `Hysteresis ${view.replace(/-/g, " ")} detail`,
        entityId: stageId,
        statePill: () => ({ tone: "info", label: "Read-only" }),
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "stage", label: "Stage ID", value: d.stageId },
        { id: "view", label: "Sub-panel", value: d.view.replace(/-/g, " ") },
      ],
      sections: [
        {
          id: "hysteresis-detail",
          title: "Hysteresis Execution Detail",
          icon: Magnet,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => content,
            },
          ],
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () =>
          "Edit hysteresis loop parameters on the parent Hysteresis stage node",
      },
    }),
    [content, stageId, titleLabel, view],
  );

  return <StageSpecHost baseline={baseline} selection={selection} spec={spec} />;
}

export { HysteresisStageInspectorPanel } from "../../../panels/stages/HysteresisStageSpec";
