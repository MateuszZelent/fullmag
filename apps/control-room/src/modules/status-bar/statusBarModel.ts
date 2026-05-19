export interface StatusBarRunReadback {
  requested_backend?: string | null;
  requested_device?: string | null;
  resolved_backend?: string | null;
  resolved_device?: string | null;
  resolved_engine_id?: string | null;
  resolved_runtime_family?: string | null;
}

export interface StatusBarEngineModel {
  detail: string;
  label: string;
  state: "active" | "pending" | "resolved";
  title: string;
}

export function buildStatusBarEngineModel(
  run: StatusBarRunReadback | null | undefined,
  solverState?: string | null,
): StatusBarEngineModel {
  if (!run) {
    return {
      detail: "awaiting run",
      label: "Engine pending",
      state: "pending",
      title: "No active run metadata is available yet.",
    };
  }

  const engineId = normalizeToken(run.resolved_engine_id);
  const resolvedBackend = normalizeToken(run.resolved_backend);
  const resolvedDevice = normalizeToken(run.resolved_device);
  const requestedBackend = normalizeToken(run.requested_backend);
  const requestedDevice = normalizeToken(run.requested_device);
  const backend = resolvedBackend ?? requestedBackend;
  const device = resolvedDevice ?? requestedDevice;
  const heading = formatBackendDevice(backend, device);
  const engine = engineId ? describeEngine(engineId) : null;
  const family = normalizeToken(run.resolved_runtime_family);
  const hasResolvedRuntime =
    Boolean(engineId) || Boolean(family) || Boolean(resolvedBackend) || Boolean(resolvedDevice);
  const detail =
    engine?.detail ??
    (family
      ? humanizeToken(family)
      : hasResolvedRuntime
        ? "runtime resolved"
        : pendingRuntimeDetail(requestedBackend, requestedDevice));
  const state =
    hasResolvedRuntime && solverState?.toLowerCase() === "running"
      ? "active"
      : hasResolvedRuntime
        ? "resolved"
        : "pending";

  return {
    detail,
    label: heading,
    state,
    title: [
      `requested_backend=${requestedBackend ?? "unresolved"}`,
      `requested_device=${requestedDevice ?? "unresolved"}`,
      `resolved_backend=${resolvedBackend ?? "unresolved"}`,
      `resolved_device=${resolvedDevice ?? "unresolved"}`,
      `resolved_engine_id=${engineId ?? "unresolved"}`,
      `resolved_runtime_family=${family ?? "unresolved"}`,
    ].join("\n"),
  };
}

export function formatRuntimeBundleVersionLabel(value: string): string {
  const token = normalizeToken(value);
  if (!token) return "runtime unavailable";
  return isIsoCalendarDate(token) ? `Backend built ${token}` : token;
}

function describeEngine(engineId: string): { detail: string } | null {
  switch (engineId) {
    case "fem_cpu_native":
      return { detail: "native MFEM/hypre" };
    case "fem_native_gpu":
      return { detail: "native MFEM/CUDA" };
    case "fem_cpu_baseline_internal":
      return { detail: "Rust FEM baseline" };
    case "fdm_cpu_reference":
      return { detail: "Rust FDM reference" };
    case "fdm_cuda":
      return { detail: "native CUDA" };
    case "fdm_multilayer_cpu_reference":
      return { detail: "Rust multilayer reference" };
    case "fdm_multilayer_cuda":
      return { detail: "native CUDA multilayer" };
    default:
      return { detail: humanizeToken(engineId) };
  }
}

function formatBackendDevice(
  backend: string | null,
  device: string | null,
): string {
  if (isAutoToken(backend) && isAutoToken(device)) return "Runtime auto";

  const backendLabel = backend && !isAutoToken(backend) ? backend.toUpperCase() : "Runtime";
  const deviceLabel = device && !isAutoToken(device) ? device.toUpperCase() : null;

  return deviceLabel
    ? `${backendLabel} ${deviceLabel}`
    : isAutoToken(device)
      ? `${backendLabel} auto`
      : backendLabel;
}

function normalizeToken(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function humanizeToken(value: string): string {
  return value.replaceAll(/[-_]+/g, " ");
}

function pendingRuntimeDetail(
  requestedBackend: string | null,
  requestedDevice: string | null,
): string {
  return isAutoToken(requestedBackend) && isAutoToken(requestedDevice)
    ? "selection pending"
    : "resolution pending";
}

function isAutoToken(value: string | null): boolean {
  return value?.toLowerCase() === "auto";
}

function isIsoCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
