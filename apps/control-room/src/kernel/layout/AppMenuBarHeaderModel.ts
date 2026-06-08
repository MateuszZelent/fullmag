import {
  EXPECTED_API_CONTRACT_VERSION,
  SESSION_STATUS_PATH,
} from "@/kernel/api/apiPaths";
import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
import {
  formatRuntimeStateLabel,
  resolveEffectiveRuntimeState,
} from "@/kernel/runtime/runtimeStateDisplay";

export interface HeaderSessionDisplay {
  connectionLabel: string;
  indicatorLabel: string;
  indicatorStatus: "connected" | "connecting" | "error";
  sessionBadge: string;
  subtitle: string;
}

export interface HeaderSessionSource {
  data: {
    session?: { name?: unknown } | null;
    solver?: { state?: unknown } | null;
  } | null;
  error?: Error | null;
  refetch?: () => void;
  status: ResourceStatus;
}

export interface ApiConnectionErrorDetails {
  apiBase: string;
  errorMessage: string;
  errorName: string;
  errorStack: string | null;
  expectedContractVersion: string;
  httpStatus: number | null;
  lastRequest: RequestDiagnosticEntry | null;
  requestUrl: string;
  resourceKey: string;
}

const HYDRATING_HEADER_SESSION_SOURCE: HeaderSessionSource = {
  data: null,
  error: null,
  status: "loading",
};

export function selectHeaderSessionSource(
  status: HeaderSessionSource,
): HeaderSessionSource {
  return {
    data: status.data
      ? {
          session: { name: status.data.session?.name },
          solver: { state: status.data.solver?.state },
        }
      : null,
    error: status.error ?? null,
    refetch: status.refetch,
    status: status.status,
  };
}

export function headerSessionSourceEquals(
  previous: HeaderSessionSource,
  next: HeaderSessionSource,
): boolean {
  return (
    previous.status === next.status &&
    previous.error === next.error &&
    previous.data?.session?.name === next.data?.session?.name &&
    previous.data?.solver?.state === next.data?.solver?.state
  );
}

export function resolveHydrationSafeHeaderSessionSource(
  status: HeaderSessionSource,
  hydrated: boolean,
): HeaderSessionSource {
  return hydrated ? status : HYDRATING_HEADER_SESSION_SOURCE;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function resolveHeaderSessionDisplay(
  status: HeaderSessionSource,
  detailedRuntimeState?: string | null,
): HeaderSessionDisplay {
  const hasSessionData = status.data !== null;
  const connected =
    status.status === "ready" || (status.status === "stale" && hasSessionData);
  const failed = status.status === "error";
  const runtimeState = resolveEffectiveRuntimeState({
    detailedRuntimeState,
    sessionSolverState: status.data?.solver?.state,
  });

  return {
    connectionLabel: connected ? "Local API" : "API pending",
    indicatorLabel: failed
      ? "Session status unavailable"
      : connected
        ? "Session connected"
        : "Session connecting",
    indicatorStatus: failed ? "error" : connected ? "connected" : "connecting",
    sessionBadge: runtimeState
      ? formatRuntimeStateLabel(runtimeState)
      : status.status,
    subtitle: readString(
      status.data?.session?.name,
      connected ? "Unnamed session" : "Loading session",
    ),
  };
}

function errorHttpStatus(error: Error): number | null {
  const status = (error as Error & { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function resolveResourceUrl(apiBase: string, path: string): string {
  try {
    return new URL(path, `${apiBase.replace(/\/+$/, "")}/`).toString();
  } catch {
    return `${apiBase.replace(/\/+$/, "")}${path}`;
  }
}

export function latestRequestForPath(
  entries: readonly RequestDiagnosticEntry[],
  path: string,
): RequestDiagnosticEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.path === path && entry.direction === "rx") return entry;
  }

  return null;
}

export function resolveApiConnectionErrorDetails({
  apiBase,
  error,
  latestRequest,
}: {
  apiBase: string;
  error: Error;
  latestRequest?: RequestDiagnosticEntry | null;
}): ApiConnectionErrorDetails {
  return {
    apiBase,
    errorMessage: error.message,
    errorName: error.name,
    errorStack: error.stack ?? null,
    expectedContractVersion: EXPECTED_API_CONTRACT_VERSION,
    httpStatus: errorHttpStatus(error),
    lastRequest: latestRequest ?? null,
    requestUrl: resolveResourceUrl(apiBase, SESSION_STATUS_PATH),
    resourceKey: "session:status",
  };
}
