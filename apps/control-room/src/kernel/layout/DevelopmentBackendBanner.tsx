"use client";

import { Button } from "@/shared/ui/Button";

import type { DevelopmentBackendResource } from "../api/apiTypes";
import { useDevelopmentBackendResource } from "../resources/developmentBackendResource";
import type { ResourceResult } from "../resources/resourceTypes";
import { useDevelopmentWorkspacePublicationError } from "../development/useDevelopmentWorkspacePaused";

type DevelopmentBackendView = {
  action: "retry" | null;
  message: string;
  state: "waiting" | "building" | "ready" | "failed" | "unknown";
} | null;

export function DevelopmentBackendBanner() {
  const resource = useDevelopmentBackendResource();
  const publicationError = useDevelopmentWorkspacePublicationError();
  const view: DevelopmentBackendView = publicationError
    ? { action: null, message: publicationError, state: "failed" }
    : resolveDevelopmentBackendView(resource);

  if (!view) return null;

  return (
    <section
      aria-live="polite"
      className="pointer-events-auto my-1 mr-3 flex max-w-[min(34rem,calc(100vw-1.5rem))] shrink-0 self-end flex-wrap items-center gap-x-3 gap-y-1 rounded-fm-control border border-fm-border bg-fm-surface px-3 py-2 text-fm-xs text-fm-secondary shadow-fm-control"
      data-development-backend-state={view.state}
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
    </section>
  );
}

function resolveDevelopmentBackendView(
  resource: ResourceResult<DevelopmentBackendResource>,
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

  return viewForDevelopmentBackendState(data);
}

function viewForDevelopmentBackendState(
  data: DevelopmentBackendResource,
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
        action: null,
        message: "Backend build is ready. Restart is not available yet.",
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
