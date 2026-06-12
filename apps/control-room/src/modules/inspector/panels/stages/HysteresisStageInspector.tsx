"use client";

import type { ReactElement } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  useHysteresisBranchesResource,
  useHysteresisExecutionTreeResource,
  useHysteresisMetricsResource,
  useHysteresisMinorLoopsResource,
  useHysteresisOrientationResource,
  useHysteresisPointsResource,
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
import { HysteresisBranchesInspector } from "./hysteresis/HysteresisBranchesInspector";
import { HysteresisCurrentFieldInspector } from "./hysteresis/HysteresisCurrentFieldInspector";
import { HysteresisLiveProgressInspector } from "./hysteresis/HysteresisLiveProgressInspector";
import { HysteresisMetricsInspector } from "./hysteresis/HysteresisMetricsInspector";
import { HysteresisPlanInspector } from "./hysteresis/HysteresisPlanInspector";
import { HysteresisPointsInspector } from "./hysteresis/HysteresisPointsInspector";
import { HysteresisProtocolInspector } from "./hysteresis/HysteresisProtocolInspector";
import { HysteresisSaturationInspector } from "./hysteresis/HysteresisSaturationInspector";
import { HysteresisSettlePipelineInspector } from "./hysteresis/HysteresisSettlePipelineInspector";
import { HysteresisSettleTraceInspector } from "./hysteresis/HysteresisSettleTraceInspector";
import { HysteresisSnapshotsInspector } from "./hysteresis/HysteresisSnapshotsInspector";
import {
  activeHysteresisPointSelection,
  activeHysteresisPointSelectionEquals,
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

  const pointsRes = useHysteresisPointsResource(stageId);
  const stagePlanRes = useHysteresisStagePlanResource(stageId);
  const protocolRes = useHysteresisProtocolResource(stageId);
  const settlePipelineRes = useHysteresisSettlePipelineResource(stageId);
  const executionTreeRes = useHysteresisExecutionTreeResource(stageId, {
    after: 1,
    before: 1,
  });
  const metricsRes = useHysteresisMetricsResource(stageId);
  const branchesRes = useHysteresisBranchesResource(stageId);
  const minorLoopsRes = useHysteresisMinorLoopsResource(stageId);
  const reversalFieldsRes = useHysteresisReversalFieldsResource(stageId);
  const progressRes = useHysteresisProgressResource(stageId);
  const stageSaturationRes = useHysteresisStageSaturationResource(stageId);
  const saturationRes = useHysteresisSaturationResource(stageId, {
    enabled: stageSaturationRes.data?.result_status === "available",
  });
  const orientationRes = useHysteresisOrientationResource(stageId);
  const settleTraceRes = useHysteresisSettleTraceResource(
    stageId,
    activePoint?.pointId,
    { enabled: activePoint?.pointId != null },
  );

  const points = Array.isArray(pointsRes.data) ? pointsRes.data : [];
  const stagePlan = stagePlanRes.data;
  const protocol = protocolRes.data;
  const settlePipeline = settlePipelineRes.data;
  const executionTree = executionTreeRes.data;
  const branches = Array.isArray(branchesRes.data) ? branchesRes.data : [];
  const minorLoops = Array.isArray(minorLoopsRes.data) ? minorLoopsRes.data : [];
  const reversalFields = Array.isArray(reversalFieldsRes.data) ? reversalFieldsRes.data : [];
  const metrics = metricsRes.data;
  const progress = progressRes.data;
  const stageSaturation = stageSaturationRes.data;
  const saturation = stageSaturation?.result ?? saturationRes.data;
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
    "current-field": <HysteresisCurrentFieldInspector progress={progress} />,
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
    plan: <HysteresisPlanInspector draft={props.draft} stagePlan={stagePlan} />,
    points: (
      <HysteresisPointsInspector
        kernel={kernel}
        points={points}
        progress={progress}
        stageId={stageId}
        targetMetadata={targetMetadata}
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
    snapshots: <HysteresisSnapshotsInspector draft={props.draft} points={points} />,
    "settle-trace": (
      <HysteresisSettleTraceInspector
        activePoint={activePoint}
        settleTrace={settleTrace}
        settleTraceStatus={settleTraceRes.status}
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
      {panels.saturation}
      <HysteresisSettlePipelineInspector
        draft={props.draft}
        executionTree={executionTree}
        settlePipeline={settlePipeline}
      />
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
    </>
  );
}
