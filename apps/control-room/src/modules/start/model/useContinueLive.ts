"use client";

import { useMemo } from "react";

import {
  useCheckpointCatalogResource,
  useCurrentRunResource,
  useStageExecutionResource,
} from "@/kernel/resources/studyRuntimeResources";

import { toCatalogState, type ContinueLiveInput } from "./continueModel";
import type { ComputeProbeState } from "./types";

/**
 * Live truth for the Continue card, read through the existing resource hooks
 * (no new endpoint, no fetch of its own). Both resources are idle while no
 * session is open, which the model reads as "project closed".
 */
export function useContinueLive(
  compute: ComputeProbeState,
  restoring: boolean,
): ContinueLiveInput {
  const catalog = useCheckpointCatalogResource();
  const currentRun = useCurrentRunResource();
  const run = currentRun.data;
  const stages = useStageExecutionResource().data;
  const restoreSources = useMemo(
    () =>
      (stages?.stages ?? []).flatMap((stage) =>
        stage.resume_from_checkpoint_ref ? [stage.resume_from_checkpoint_ref] : [],
      ),
    [stages],
  );

  return useMemo<ContinueLiveInput>(
    () => ({
      catalog: toCatalogState(catalog),
      run: run
        ? {
            runId: run.run_id,
            requestedDevice: run.requested_device,
            resolvedDevice: run.resolved_device,
            resolvedRuntimeFamily: run.resolved_runtime_family,
            totalSteps: run.total_steps,
            restoreSourceCheckpointIds: restoreSources,
          }
        : null,
      compute,
      restoring,
    }),
    [catalog, compute, restoring, restoreSources, run],
  );
}
