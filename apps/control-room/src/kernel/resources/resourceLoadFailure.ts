import type { ResourceRevision } from "../api/apiTypes";
import type { KernelApi } from "../types";
import type { ResourceKey } from "./resourceTypes";

export const RESOURCE_LOAD_FAILURE_SITUATION =
  "Loading runtime resource through the v2 resource hook";

export function emitResourceLoadFailed({
  bus,
  error,
  resourceKey,
  revision,
  situation = RESOURCE_LOAD_FAILURE_SITUATION,
}: {
  bus: KernelApi["bus"];
  error: unknown;
  resourceKey: ResourceKey;
  revision: ResourceRevision | null;
  situation?: string;
}): void {
  const failure = normalizeResourceLoadFailure(error);
  bus.emit("resource:load-failed", {
    cause: failure.cause,
    errorName: failure.errorName,
    resourceKey,
    revision,
    situation,
    source: "resource-hook",
    status: failure.status,
  });
}

export function normalizeResourceLoadFailure(error: unknown): {
  cause: string;
  errorName: string;
  status: number | null;
} {
  if (error instanceof Error) {
    return {
      cause: error.message || "Resource load failed",
      errorName: error.name || "Error",
      status: resourceErrorStatus(error),
    };
  }

  return {
    cause: String(error),
    errorName: "UnknownError",
    status: resourceErrorStatus(error),
  };
}

function resourceErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return null;
  }
  const status = (error as { status: unknown }).status;
  return typeof status === "number" ? status : null;
}
