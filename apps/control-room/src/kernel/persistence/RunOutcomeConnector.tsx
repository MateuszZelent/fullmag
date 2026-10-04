"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

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

const NO_PROJECT_DOCUMENT_SNAPSHOT = () => null;
const NO_PROJECT_DOCUMENT_SUBSCRIBE = () => () => undefined;

/** The viewport follows the status by one resource fetch; let the final frame land. */
export const RUN_OUTCOME_THUMBNAIL_SETTLE_MS = 400;

const selectRunLifecycle = (status: ResourceResult<LiveStatusResource>) =>
  observeRunLifecycle(status.data);

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recordRunOutcome(
  kernel: KernelApi,
  outcome: RunOutcomeRecord,
  releaseReservation: () => void,
): Promise<void> {
  try {
    const controller = kernel.projectDocument;
    if (!controller) return;
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
  } finally {
    releaseReservation();
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
  paused,
}: {
  kernel: KernelApi;
  sessionIdentity: SessionResourceIdentity;
  paused: boolean;
}) {
  const observation = useSessionStatusSelector(selectRunLifecycle, {
    isEqual: runLifecycleObservationsEqual,
  });
  const trackerRef = useRef<RunOutcomeTracker>(INITIAL_RUN_OUTCOME_TRACKER);
  const sessionKey = `${sessionIdentity.sessionId}\u0000${sessionIdentity.sessionEpoch}`;
  const documentSnapshot = useSyncExternalStore(
    kernel.projectDocument?.subscribe ?? NO_PROJECT_DOCUMENT_SUBSCRIBE,
    kernel.projectDocument?.getSnapshot ?? NO_PROJECT_DOCUMENT_SNAPSHOT,
    NO_PROJECT_DOCUMENT_SNAPSHOT,
  );

  useEffect(() => {
    trackerRef.current = INITIAL_RUN_OUTCOME_TRACKER;
  }, [sessionKey]);

  useEffect(() => {
    const host = kernel.developmentWorkspace?.getSnapshot();
    if (paused || host?.paused || (host && host.kernel !== kernel)) return;

    const controller = kernel.projectDocument;
    const releaseReservation = controller?.tryReserveRunOutcome();
    if (controller && !releaseReservation) return;

    let reservationTransferred = false;
    try {
      const scoped = observation?.sessionKey === sessionKey ? observation : null;
      const { outcome, tracker } = advanceRunOutcomeTracker(trackerRef.current, scoped, Date.now());
      trackerRef.current = tracker;
      if (outcome) {
        reservationTransferred = true;
        void recordRunOutcome(kernel, outcome, releaseReservation ?? (() => undefined));
      }
    } finally {
      if (!reservationTransferred) releaseReservation?.();
    }
  }, [documentSnapshot, kernel, observation, paused, sessionKey]);

  return null;
}
