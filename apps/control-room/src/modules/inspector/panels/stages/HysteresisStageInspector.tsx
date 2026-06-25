"use client";

import type { ReactElement } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  useHysteresisBookmarksResource,
  useHysteresisBranchesResource,
  useHysteresisExecutionTreeResource,
  useHysteresisFamilyResource,
  useHysteresisMetricsResource,
  useHysteresisMinorLoopsResource,
  useHysteresisOrientationResource,
  useHysteresisPointResource,
  useHysteresisPointsResource,
  useHysteresisAdaptiveRefinementResource,
  useHysteresisProgressResource,
  useHysteresisProtocolResource,
  useHysteresisReversalFieldsResource,
  useHysteresisSaturationResource,
  useHysteresisSettlePipelineResource,
  useHysteresisStagePlanResource,
  useHysteresisSettleTraceResource,
  useHysteresisStageSaturationResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import { hysteresisTargetMetadataFromOrientation } from "@/shared/domain/study/HysteresisChart";

import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";
import { HysteresisAngularFamilyInspector } from "./hysteresis/HysteresisAngularFamilyInspector";
import { HysteresisBookmarksInspector } from "./hysteresis/HysteresisBookmarksInspector";
import { HysteresisAdaptiveRefinementInspector } from "./hysteresis/HysteresisAdaptiveRefinementInspector";
import { HysteresisBranchDetailInspector } from "./hysteresis/HysteresisBranchDetailInspector";
import { HysteresisBranchesInspector } from "./hysteresis/HysteresisBranchesInspector";
import { HysteresisCurrentFieldInspector } from "./hysteresis/HysteresisCurrentFieldInspector";
import { HysteresisExecutionNodeInspector } from "./hysteresis/HysteresisExecutionNodeInspector";
import { HysteresisLiveProgressInspector } from "./hysteresis/HysteresisLiveProgressInspector";
import { HysteresisMetricsInspector } from "./hysteresis/HysteresisMetricsInspector";
import { HysteresisOrientationInspector } from "./hysteresis/HysteresisOrientationInspector";
import { HysteresisPlanInspector } from "./hysteresis/HysteresisPlanInspector";
import { HysteresisPointBucketInspector } from "./hysteresis/HysteresisPointBucketInspector";
import { HysteresisPointDetailInspector } from "./hysteresis/HysteresisPointDetailInspector";
import { HysteresisPointsInspector } from "./hysteresis/HysteresisPointsInspector";
import { HysteresisProtocolInspector } from "./hysteresis/HysteresisProtocolInspector";
import { HysteresisSaturationInspector } from "./hysteresis/HysteresisSaturationInspector";
import { HysteresisSettlePipelineInspector } from "./hysteresis/HysteresisSettlePipelineInspector";
import { HysteresisSettleTraceInspector } from "./hysteresis/HysteresisSettleTraceInspector";
import { HysteresisSnapshotsInspector } from "./hysteresis/HysteresisSnapshotsInspector";
import { HysteresisTransitionsInspector } from "./hysteresis/HysteresisTransitionsInspector";
import {
  activeHysteresisPointSelection,
  activeHysteresisPointSelectionEquals,
  activeHysteresisBranchSelection,
  activeHysteresisBranchSelectionEquals,
  activeHysteresisExecutionNodeSelection,
  activeHysteresisExecutionNodeSelectionEquals,
  activeHysteresisSnapshotSelection,
  activeHysteresisSnapshotSelectionEquals,
  type HysteresisInspectorView,
  hysteresisInitialStateActionPresentation,
} from "./hysteresis/HysteresisInspectorUtils";

export { hysteresisInitialStateActionPresentation };

export interface HysteresisStageInspectorProps extends StageInspectorFrameProps {
  view?: HysteresisInspectorView;
}

export function HysteresisStageInspector(props: HysteresisStageInspectorProps) {
  const kernel = useKernel();
  const stageId = props.stage?.stageId;
  const view = props.view ?? "overview";
  const activeSnapshot = useSelectionSelector(
    (selection) => activeHysteresisSnapshotSelection(selection, stageId),
    { isEqual: activeHysteresisSnapshotSelectionEquals },
  );
  const activePoint = useSelectionSelector(
    (selection) => activeHysteresisPointSelection(selection, stageId),
    { isEqual: activeHysteresisPointSelectionEquals },
  );
  const activeBranch = useSelectionSelector(
    (selection) => activeHysteresisBranchSelection(selection, stageId),
    { isEqual: activeHysteresisBranchSelectionEquals },
  );
  const activeExecutionNode = useSelectionSelector(
    (selection) => activeHysteresisExecutionNodeSelection(selection, stageId),
    { isEqual: activeHysteresisExecutionNodeSelectionEquals },
  );

  const pointsRes = useHysteresisPointsResource(stageId);
  const stagePlanRes = useHysteresisStagePlanResource(stageId);
  const protocolRes = useHysteresisProtocolResource(stageId);
  const settlePipelineRes = useHysteresisSettlePipelineResource(stageId);
  const executionTreeRes = useHysteresisExecutionTreeResource(stageId, {
    after: 1,
    before: 1,
  });
  const angularFamilyRes = useHysteresisFamilyResource(stageId);
  const metricsRes = useHysteresisMetricsResource(stageId);
  const bookmarksRes = useHysteresisBookmarksResource(stageId);
  const branchesRes = useHysteresisBranchesResource(stageId);
  const minorLoopsRes = useHysteresisMinorLoopsResource(stageId);
  const reversalFieldsRes = useHysteresisReversalFieldsResource(stageId);
  const progressRes = useHysteresisProgressResource(stageId);
  const stageSaturationRes = useHysteresisStageSaturationResource(stageId);
  const saturationRes = useHysteresisSaturationResource(stageId, {
    enabled: stageSaturationRes.data?.result_status === "available",
  });
  const adaptiveRefinementRes = useHysteresisAdaptiveRefinementResource(stageId);
  const orientationRes = useHysteresisOrientationResource(stageId);
  const pointDetailRes = useHysteresisPointResource(stageId, activePoint?.pointId, {
    enabled: activePoint?.pointId != null,
  });
  const settleTraceRes = useHysteresisSettleTraceResource(
    stageId,
    activePoint?.pointId,
    { enabled: activePoint?.pointId != null },
  );

  const points = Array.isArray(pointsRes.data?.points) ? pointsRes.data.points : [];
  const stagePlan = stagePlanRes.data;
  const protocol = protocolRes.data;
  const settlePipeline = settlePipelineRes.data;
  const executionTree = executionTreeRes.data;
  const angularFamily = angularFamilyRes.data;
  const bookmarks = bookmarksRes.data;
  const branches = Array.isArray(branchesRes.data) ? branchesRes.data : [];
  const minorLoops = Array.isArray(minorLoopsRes.data) ? minorLoopsRes.data : [];
  const reversalFields = Array.isArray(reversalFieldsRes.data) ? reversalFieldsRes.data : [];
  const metrics = metricsRes.data;
  const progress = progressRes.data;
  const stageSaturation = stageSaturationRes.data;
  const saturation = stageSaturation?.result ?? saturationRes.data;
  const adaptiveRefinement = adaptiveRefinementRes.data;
  const saturationPoints = Array.isArray(saturation?.points) ? saturation.points : [];
  const settleTrace = Array.isArray(settleTraceRes.data) ? settleTraceRes.data : [];
  const targetMetadata = hysteresisTargetMetadataFromOrientation(orientationRes.data);

  const panels = {
    branches: (
      <HysteresisBranchesInspector
        branches={branches}
        draft={props.draft}
        minorLoops={minorLoops}
      />
    ),
    "branch-detail": (
      <HysteresisBranchDetailInspector
        activeBranch={activeBranch}
        branches={branches}
        minorLoops={minorLoops}
      />
    ),
    "current-field": <HysteresisCurrentFieldInspector progress={progress} />,
    "adaptive-refinement": (
      <HysteresisAdaptiveRefinementInspector
        adaptiveRefinement={adaptiveRefinement}
      />
    ),
    "angular-family": (
      <HysteresisAngularFamilyInspector angularFamily={angularFamily} />
    ),
    "execution-node": (
      <HysteresisExecutionNodeInspector
        activeExecutionNode={activeExecutionNode}
        executionTree={executionTree}
      />
    ),
    "point-detail": (
      <HysteresisPointDetailInspector
        activePoint={activePoint}
        kernel={kernel}
        pointDetail={pointDetailRes.data}
        points={points}
        progress={progress}
        stageId={stageId}
        targetMetadata={targetMetadata}
      />
    ),
    "live-run": (
      <HysteresisLiveProgressInspector
        activeSnapshot={activeSnapshot}
        kernel={kernel}
        points={points}
        progress={progress}
        stageId={stageId}
      />
    ),
    metrics: (
      <HysteresisMetricsInspector
        metrics={metrics}
        reversalFields={reversalFields}
      />
    ),
    plan: (
      <HysteresisPlanInspector
        adaptiveRefinement={adaptiveRefinement}
        draft={props.draft}
        stagePlan={stagePlan}
      />
    ),
    orientation: (
      <HysteresisOrientationInspector
        draft={props.draft}
        orientation={orientationRes.data}
        targetMetadata={targetMetadata}
      />
    ),
    points: (
      <HysteresisPointsInspector
        activeSnapshot={activeSnapshot}
        kernel={kernel}
        points={points}
        progress={progress}
        stageId={stageId}
        targetMetadata={targetMetadata}
      />
    ),
    "points-completed": (
      <HysteresisPointBucketInspector
        bucket="completed"
        kernel={kernel}
        points={points}
        progress={progress}
        stageId={stageId}
        targetMetadata={targetMetadata}
      />
    ),
    "points-queued": (
      <HysteresisPointBucketInspector
        bucket="queued"
        kernel={kernel}
        points={points}
        progress={progress}
        stageId={stageId}
        targetMetadata={targetMetadata}
      />
    ),
    "points-planned": (
      <HysteresisPointBucketInspector
        bucket="planned"
        kernel={kernel}
        points={points}
        progress={progress}
        stageId={stageId}
        targetMetadata={targetMetadata}
      />
    ),
    "points-bookmarks": (
      <HysteresisBookmarksInspector
        bookmarks={bookmarks}
        executionTree={executionTree}
      />
    ),
    protocol: (
      <HysteresisProtocolInspector
        draft={props.draft}
        protocol={protocol}
      />
    ),
    saturation: (
      <HysteresisSaturationInspector
        draft={props.draft}
        metrics={metrics}
        saturation={saturation}
        saturationPoints={saturationPoints}
      />
    ),
    "settle-pipeline": (
      <HysteresisSettlePipelineInspector
        draft={props.draft}
        executionTree={executionTree}
        onUpdateDraft={props.onUpdateDraft}
        settlePipeline={settlePipeline}
      />
    ),
    snapshots: (
      <HysteresisSnapshotsInspector
        activeSnapshot={activeSnapshot}
        draft={props.draft}
        kernel={kernel}
        points={points}
        stageId={stageId}
        targetMetadata={targetMetadata}
      />
    ),
    "settle-trace": (
      <HysteresisSettleTraceInspector
        activePoint={activePoint}
        settleTrace={settleTrace}
        settleTraceStatus={settleTraceRes.status}
      />
    ),
    transitions: (
      <HysteresisTransitionsInspector
        activePoint={activePoint}
        kernel={kernel}
        points={points}
        progress={progress}
        stageId={stageId}
      />
    ),
  } satisfies Record<Exclude<HysteresisInspectorView, "overview">, ReactElement>;

  if (view !== "overview") {
    return (
      <>
        {panels[view]}
        <StageInspectorFrame
          {...props}
          expectedKind="hysteresis"
          kindLabel="Hysteresis"
        />
      </>
    );
  }

  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="hysteresis"
        kindLabel="Hysteresis"
      />
      {panels.plan}
      {panels.protocol}
      {panels.orientation}
      {panels.saturation}
      {panels["adaptive-refinement"]}
      {panels["angular-family"]}
      {panels["settle-pipeline"]}
      <HysteresisSettleTraceInspector
        activePoint={activePoint}
        settleTrace={settleTrace}
        settleTraceStatus={settleTraceRes.status}
      />
      {panels["live-run"]}
      {panels.branches}
      {panels.metrics}
      {panels.points}
      {panels.snapshots}
      {panels.transitions}
    </>
  );
}
