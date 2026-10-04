"use client";

import { useSyncExternalStore } from "react";

import { Button } from "@/shared/ui/Button";

import type { DevelopmentBackendResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import type { DevelopmentRestartActionSnapshot } from "../development/DevelopmentRestartActionService";
import { useDevelopmentBackendResource } from "../resources/developmentBackendResource";
import type { ResourceResult } from "../resources/resourceTypes";
import { useDevelopmentWorkspacePublicationError } from "../development/useDevelopmentWorkspacePaused";

type DevelopmentBackendView = {
  action: "retry" | "restart" | "reconcile" | null;
  message: string;
  state: "waiting" | "building" | "ready" | "failed" | "unknown";
} | null;

const NO_RESTART_SNAPSHOT: DevelopmentRestartActionSnapshot = {
  state: "idle", requestId: null, message: null, busy: false,
};
const noSubscription = () => () => {};
const noRestartSnapshot = () => NO_RESTART_SNAPSHOT;

export function DevelopmentBackendBanner() {
  const kernel = useKernel();
  const service = kernel.developmentWorkspace?.restartAction;
  const restart = useSyncExternalStore(
    service?.subscribe ?? noSubscription,
    service?.getSnapshot ?? noRestartSnapshot,
    noRestartSnapshot,
  );
  const resource = useDevelopmentBackendResource();
  const publicationError = useDevelopmentWorkspacePublicationError();
  const canRestart = service?.canStart(kernel, resource) ?? false;
  const view: DevelopmentBackendView = publicationError
    ? { action: null, message: publicationError, state: "failed" }
    : resolveRestartView(restart, canRestart, resource) ?? resolveDevelopmentBackendView(resource, canRestart);

  if (!view) return null;

  return (
    <section
      aria-live="polite"
      className="pointer-events-auto my-1 mr-3 flex max-w-[min(34rem,calc(100vw-1.5rem))] shrink-0 self-end flex-wrap items-center gap-x-3 gap-y-1 rounded-fm-control border border-fm-border bg-fm-surface px-3 py-2 text-fm-xs text-fm-secondary shadow-fm-control"
      data-development-backend-state={view.state}
      data-development-restart-state={restart.state}
      data-development-restart-busy={restart.busy}
      role="status"
    >
      <span className="font-medium text-fm-primary">Development backend</span>
      <span>{view.message}</span>
      {view.action === "retry" ? (
        <Button
          disabled={resource.status === "stale" || resource.status === "loading"}
          onClick={resource.refetch}
          size="sm"
          type="button"
          variant="secondary"
        >
          Retry
        </Button>
      ) : null}
      {view.action === "restart" ? (
        <Button
          disabled={!canRestart || restart.busy}
          onClick={() => { void service?.start(kernel, resource); }}
          size="sm"
          type="button"
          variant="secondary"
        >
          Restart backend
        </Button>
      ) : null}
      {view.action === "reconcile" ? (
        <Button
          disabled={restart.busy}
          onClick={() => { void service?.reconcile(); }}
          size="sm"
          type="button"
          variant="secondary"
        >
          Check restart
        </Button>
      ) : null}
    </section>
  );
}

function resolveRestartView(
  restart: DevelopmentRestartActionSnapshot,
  canRestart: boolean,
  resource: ResourceResult<DevelopmentBackendResource>,
): DevelopmentBackendView {
  switch (restart.state) {
    case "checking":
    case "capturing":
      return { action: null, message: "Checking and protecting the current workspace before restart.", state: "waiting" };
    case "pending":
      return { action: "reconcile", message: "Backend restart is in progress. The workspace remains protected.", state: "waiting" };
    case "unknown":
      return { action: "reconcile", message: restart.message ?? "Restart outcome is unconfirmed. Check the existing request.", state: "unknown" };
    case "hydrating":
      return { action: null, message: "Restoring the workspace into the restarted backend.", state: "waiting" };
    case "failed":
      return { action: canRestart ? "restart" : null, message: restart.message ?? "Backend restart could not be completed.", state: "failed" };
    case "restored":
      if (restart.message) return { action: null, message: restart.message, state: "failed" };
      if (resource.status === "ready" && !resource.refreshError && !resource.error
        && resource.data?.state === "ready"
        && resource.data.current_build?.source_sha256 === resource.data.ready_build?.source_sha256) {
        return { action: null, message: "Backend restarted. Workspace restored.", state: "ready" };
      }
      return null;
    case "idle":
      return null;
  }
}

function resolveDevelopmentBackendView(
  resource: ResourceResult<DevelopmentBackendResource>,
  canRestart: boolean,
): DevelopmentBackendView {
  if (resource.status === "error" || resource.refreshError) {
    return {
      action: "retry",
      message: "Status could not be checked. Retry to observe it again.",
      state: "unknown",
    };
  }

  if (resource.status === "idle" || resource.status === "loading") {
    return null;
  }

  const data = resource.data;
  if (!data) {
    return {
      action: "retry",
      message: "Status is unavailable. Retry to observe it again.",
      state: "unknown",
    };
  }

  if (
    resource.status === "ready" &&
    (!data.configured || data.state === "disabled")
  ) {
    return null;
  }

  if (resource.status === "stale") {
    return {
      action: null,
      message: "Checking the latest build status.",
      state: "unknown",
    };
  }

  return viewForDevelopmentBackendState(data, canRestart);
}

function viewForDevelopmentBackendState(
  data: DevelopmentBackendResource,
  canRestart: boolean,
): NonNullable<DevelopmentBackendView> {
  switch (data.state) {
    case "waiting":
      return {
        action: null,
        message: "Waiting for backend source changes to settle.",
        state: "waiting",
      };
    case "building":
      return {
        action: null,
        message: "Building backend development changes.",
        state: "building",
      };
    case "ready":
      return {
        action: canRestart ? "restart" : null,
        message: canRestart
          ? "Backend build is ready. Restart when your current changes are complete."
          : "Backend build is ready. Restart is not available for this workspace yet.",
        state: "ready",
      };
    case "failed":
      return {
        action: null,
        message: "The latest backend development build failed.",
        state: "failed",
      };
    case "disabled":
      return {
        action: null,
        message: "Development backend observation is disabled.",
        state: "unknown",
      };
    case "superseded":
    case "stopped":
    case "unknown":
      return {
        action: "retry",
        message: "Status is unknown. Retry to observe it again.",
        state: "unknown",
      };
  }
}
