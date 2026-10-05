"use client";

import { useEffect, useSyncExternalStore } from "react";

import { Button } from "@/shared/ui/Button";

import type { DevelopmentBackendResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import type { DevelopmentBackendBuildActionSnapshot } from "../development/DevelopmentBackendBuildActionService";
import type { DevelopmentRestartActionSnapshot } from "../development/DevelopmentRestartActionService";
import { useDevelopmentBackendResource } from "../resources/developmentBackendResource";
import type { ResourceResult } from "../resources/resourceTypes";
import {
  useDevelopmentWorkspacePaused,
  useDevelopmentWorkspacePublicationError,
} from "../development/useDevelopmentWorkspacePaused";

type DevelopmentBackendView = {
  action: "retry" | "restart" | "reconcile" | null;
  message: string;
  state: "waiting" | "building" | "ready" | "failed" | "unknown";
} | null;

const NO_RESTART_SNAPSHOT: DevelopmentRestartActionSnapshot = {
  state: "idle", requestId: null, message: null, busy: false,
};
const NO_BUILD_SNAPSHOT: DevelopmentBackendBuildActionSnapshot = {
  state: "idle", requestId: null, message: null, busy: false,
};
const noSubscription = () => () => {};
const noRestartSnapshot = () => NO_RESTART_SNAPSHOT;
const noBuildSnapshot = () => NO_BUILD_SNAPSHOT;

export function DevelopmentBackendBanner() {
  const kernel = useKernel();
  const service = kernel.developmentWorkspace?.restartAction;
  const buildService = kernel.developmentWorkspace?.buildAction;
  const restart = useSyncExternalStore(
    service?.subscribe ?? noSubscription,
    service?.getSnapshot ?? noRestartSnapshot,
    noRestartSnapshot,
  );
  const build = useSyncExternalStore(
    buildService?.subscribe ?? noSubscription,
    buildService?.getSnapshot ?? noBuildSnapshot,
    noBuildSnapshot,
  );
  const resource = useDevelopmentBackendResource();
  const paused = useDevelopmentWorkspacePaused();
  const publicationError = useDevelopmentWorkspacePublicationError();
  const buildBlocksRestart = buildService?.blocksWorkspaceTransition() ?? false;
  const canRestart = (service?.canStart(kernel, resource) ?? false) && !buildBlocksRestart;
  const backend = resource.status === "ready" && !resource.error && !resource.refreshError
    ? resource.data
    : null;
  useEffect(() => {
    if (
      resource.status === "ready" &&
      !resource.error &&
      !resource.refreshError &&
      resource.data
    ) {
      buildService?.observeBackend(resource.data);
    }
  }, [buildService, resource.data, resource.error, resource.refreshError, resource.status]);

  const restartView = resolveRestartView(restart, canRestart, resource);
  const backendView = resolveDevelopmentBackendView(resource, canRestart);
  const terminalBuildView: DevelopmentBackendView =
    (build.state === "ready" || build.state === "failed") &&
    build.requestId !== null &&
    backend?.build_request_id === build.requestId
      ? {
          action: backendView?.action ?? null,
          message: build.message ?? "The requested backend build reached a terminal result.",
          state: build.state,
        }
      : null;
  const view: DevelopmentBackendView = publicationError
    ? { action: null, message: publicationError, state: "failed" }
    : restartView ?? terminalBuildView ?? backendView ??
      (build.state === "idle"
        ? null
        : { action: null, message: "Checking the existing backend build request.", state: "unknown" });
  const activeBuildRequest = ["submitting", "pending", "building", "unknown"].includes(build.state);
  const activeRestartRequest = ["checking", "capturing", "pending", "unknown", "hydrating"].includes(restart.state);
  const publicRequestPending = backend?.state === "waiting" && backend.build_request_id != null;
  const canStartBuild = Boolean(
    buildService &&
      !paused &&
      !publicationError &&
      !activeRestartRequest &&
      !build.busy &&
      !activeBuildRequest &&
      !publicRequestPending &&
      backend != null &&
      backend.build_available === true &&
      backend.state !== "building",
  );
  const canReconcileBuild = Boolean(
    buildService &&
      !build.busy &&
      ["pending", "building", "unknown"].includes(build.state),
  );
  const canRetrySameBuild = Boolean(
    buildService &&
      !build.busy &&
      build.state === "unknown",
  );

  if (!view) return null;

  return (
    <section
      aria-live="polite"
      className="pointer-events-auto my-1 mr-3 flex max-w-[min(34rem,calc(100vw-1.5rem))] shrink-0 self-end flex-wrap items-center gap-x-3 gap-y-1 rounded-fm-control border border-fm-border bg-fm-surface px-3 py-2 text-fm-xs text-fm-secondary shadow-fm-control"
      data-development-backend-state={view.state}
      data-development-build-request-state={build.state}
      data-development-restart-state={restart.state}
      data-development-restart-busy={restart.busy}
      role="status"
    >
      <span className="font-medium text-fm-primary">Development backend</span>
      <span>{view.message}</span>
      {build.message && !terminalBuildView ? <span>{build.message}</span> : null}
      {canStartBuild ? (
        <Button
          disabled={!canStartBuild}
          onClick={() => {
            if (backend) void buildService?.start(kernel.api, backend);
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          Build backend
        </Button>
      ) : null}
      {canReconcileBuild ? (
        <Button
          disabled={build.busy}
          onClick={() => { void buildService?.reconcile(); }}
          size="sm"
          type="button"
          variant="secondary"
        >
          Check build request
        </Button>
      ) : null}
      {canRetrySameBuild ? (
        <Button
          disabled={build.busy}
          onClick={() => { void buildService?.retrySameRequest(); }}
          size="sm"
          type="button"
          variant="secondary"
        >
          Retry same build request
        </Button>
      ) : null}
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
        message: data.build_request_id
          ? "A manual backend build request is waiting for the native watcher."
          : "Waiting for a manual backend build request.",
        state: "waiting",
      };
    case "building":
      return {
        action: null,
        message: "Building backend development changes.",
        state: "building",
      };
    case "ready": {
      const buildIsCurrent =
        data.ready_build?.source_sha256 != null &&
        data.ready_build.source_sha256 === data.current_build?.source_sha256;
      return {
        action: canRestart ? "restart" : null,
        message: canRestart
          ? "A backend build is ready to apply. Restart remains a separate workspace action."
          : buildIsCurrent
            ? "The current backend already matches the ready build."
            : "A backend build is ready, but restart is unavailable for this workspace.",
        state: "ready",
      };
    }
    case "failed":
      return {
        action: null,
        message: "The latest backend build failed. You can submit another manual build request.",
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
