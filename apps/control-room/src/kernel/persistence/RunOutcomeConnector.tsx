"use client";

import { useEffect, useRef } from "react";

import { captureRegisteredViewport3DThumbnail } from "@/modules/viewport-3d/public";

import type { LiveStatusResource } from "../api/apiTypes";
import type { ResourceResult } from "../resources/resourceTypes";
import type { KernelApi } from "../types";
import type { SessionResourceIdentity } from "../resources/sessionResourceIdentity";
import { useSessionStatusSelector } from "../resources/useSessionStatus";
import {
  INITIAL_RUN_OUTCOME_TRACKER,
  advanceRunOutcomeTracker,
  observeRunLifecycle,
  runLifecycleObservationsEqual,
  type RunOutcomeRecord,
  type RunOutcomeTracker,
} from "./runOutcome";

/** The viewport follows the status by one resource fetch; let the final frame land. */
export const RUN_OUTCOME_THUMBNAIL_SETTLE_MS = 400;

const selectRunLifecycle = (status: ResourceResult<LiveStatusResource>) =>
  observeRunLifecycle(status.data);

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recordRunOutcome(kernel: KernelApi, outcome: RunOutcomeRecord): Promise<void> {
  const controller = kernel.projectDocument;
  if (!controller) return;
  try {
    await settle(RUN_OUTCOME_THUMBNAIL_SETTLE_MS);
    const thumbnail = await captureRegisteredViewport3DThumbnail();
    await controller.recordRunOutcome(
      outcome,
      thumbnail
        ? { colouring: thumbnail.colouring, png_base64: thumbnail.pngBase64 }
        : undefined,
    );
  } catch {
    return;
  }
}

/**
 * Records a finished run in the open project. The session status is the only
 * input: a run that leaves an active solver state for a terminal one inside
 * the confirmed session produces one outcome, with a thumbnail of the viewport
 * when one is mounted. The tracker is keyed by the session so a session change
 * never attributes a run to another one.
 */
export function RunOutcomeConnector({
  kernel,
  sessionIdentity,
}: {
  kernel: KernelApi;
  sessionIdentity: SessionResourceIdentity;
}) {
  const observation = useSessionStatusSelector(selectRunLifecycle, {
    isEqual: runLifecycleObservationsEqual,
  });
  const trackerRef = useRef<RunOutcomeTracker>(INITIAL_RUN_OUTCOME_TRACKER);
  const sessionKey = `${sessionIdentity.sessionId}\u0000${sessionIdentity.sessionEpoch}`;

  useEffect(() => {
    trackerRef.current = INITIAL_RUN_OUTCOME_TRACKER;
  }, [sessionKey]);

  useEffect(() => {
    const scoped = observation?.sessionKey === sessionKey ? observation : null;
    const { outcome, tracker } = advanceRunOutcomeTracker(trackerRef.current, scoped, Date.now());
    trackerRef.current = tracker;
    if (outcome) void recordRunOutcome(kernel, outcome);
  }, [kernel, observation, sessionKey]);

  return null;
}
