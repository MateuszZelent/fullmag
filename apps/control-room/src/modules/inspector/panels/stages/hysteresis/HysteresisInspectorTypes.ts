"use client";

import type {
  HysteresisMetricsSchema,
  HysteresisMinorLoopSchema,
  HysteresisPointSchema,
  HysteresisProgressSchema,
  HysteresisBranchSchema,
  HysteresisExecutionTreeResource,
  HysteresisSaturationResultSchema,
  HysteresisSettleTraceEntrySchema,
  HysteresisSettlePipelineSchema,
  HysteresisStagePlanSchema,
  HysteresisProtocolSchema,
} from "@/kernel/api/apiTypes";
import type { KernelApi } from "@/kernel/types";
import type { HysteresisTargetMetadata } from "@/shared/domain/study/HysteresisChart";

import type { ActiveHysteresisSnapshotSelection } from "./HysteresisInspectorUtils";
import type { StageInspectorFrameProps } from "../StageInspectorFrame";

export interface HysteresisInspectorCommonProps {
  activeSnapshot: ActiveHysteresisSnapshotSelection | null;
  branches: HysteresisBranchSchema[];
  draft: StageInspectorFrameProps["draft"];
  executionTree: HysteresisExecutionTreeResource | null | undefined;
  kernel: KernelApi;
  metrics: HysteresisMetricsSchema | null | undefined;
  minorLoops: HysteresisMinorLoopSchema[];
  points: HysteresisPointSchema[];
  progress: HysteresisProgressSchema | null | undefined;
  protocol: HysteresisProtocolSchema | null | undefined;
  reversalFields: HysteresisPointSchema[];
  saturation: HysteresisSaturationResultSchema | null | undefined;
  saturationPoints: NonNullable<HysteresisSaturationResultSchema["points"]>;
  settlePipeline: HysteresisSettlePipelineSchema | null | undefined;
  settleTrace: HysteresisSettleTraceEntrySchema[];
  settleTraceStatus: string;
  stagePlan: HysteresisStagePlanSchema | null | undefined;
  stageId: string | null | undefined;
  targetMetadata: HysteresisTargetMetadata;
}
