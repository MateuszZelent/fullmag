import { resolveSessionAuthoringDiscretization } from "@/kernel/resources/sessionDiscretization";
import {
  formatRuntimeUserSolvePhaseLabel,
  type RuntimeUserSolvePhase,
} from "@/kernel/runtime/runtimeStateDisplay";

export interface StatusBarRunReadback {
  requested_backend?: string | null;
  requested_device?: string | null;
  requested_precision?: string | null;
  resolved_backend?: string | null;
  resolved_device?: string | null;
  resolved_precision?: string | null;
  resolved_engine_id?: string | null;
  resolved_runtime_family?: string | null;
  resolved_fallback?: {
    occurred?: boolean | null;
    original_engine?: string | null;
    fallback_engine?: string | null;
    reason?: string | null;
    message?: string | null;
  } | null;
}

export interface StatusBarMethodReadback {
  capabilities?: {
    active_lane?: {
      authored?: { discretization?: string; backend?: string } | null;
      requested?: { discretization?: string; backend?: string };
      resolved?: { discretization?: string } | null;
    } | null;
  };
  domain?: { discretization?: string | null };
}

export interface StatusBarMethodModel {
  label: string;
  state: "resolved" | "pending" | "unknown";
  method: "fdm" | "fem" | null;
  title: string;
}

export function statusBarMethodModelsEqual(
  previous: StatusBarMethodModel,
  next: StatusBarMethodModel,
): boolean {
  return previous.label === next.label
    && previous.method === next.method
    && previous.state === next.state
    && previous.title === next.title;
}

export function buildStatusBarMethodModel(
  status: StatusBarMethodReadback | null | undefined,
): StatusBarMethodModel {
  const method = resolveSessionAuthoringDiscretization(status);
  const requested = status?.capabilities?.active_lane?.requested;
  const request = normalizeToken(requested?.discretization ?? requested?.backend)?.toLowerCase();
  if (method) {
    return {
      label: method.toUpperCase(),
      state: "resolved",
      method,
      title: `Model method: ${method.toUpperCase()}. Requested: ${request ?? "unavailable"}. Engine execution is shown separately.`,
    };
  }
  if (request === "fdm" || request === "fem" || request === "auto") {
    return {
      label: request === "auto" ? "Method auto" : `${request.toUpperCase()} requested`,
      state: "pending",
      method: null,
      title: "Simulation method resolution is pending. Requested selection is retained; no resolved method is assumed.",
    };
  }
  return {
    label: status ? "Method unavailable" : "No simulation",
    state: "unknown",
    method: null,
    title: status ? "No resolved simulation method is available." : "Create or open a simulation to select FEM or FDM.",
  };
}

export interface StatusBarEngineModel {
  /** True when the runtime holds a prepared model and waits for an explicit Compute. */
  awaitingCompute: boolean;
  detail: string;
  label: string;
  state: "active" | "pending" | "resolved";
  title: string;
  /** `warning` when the resolved execution does not honour the requested intent. */
  tone: "neutral" | "warning";
}

export interface StatusBarMeshModelInput {
  activeBuildStatus?: string | null;
  manifestSourceSceneRevision?: number | string | null;
  meshBuildRevision: number | string | null;
  meshRevision: number | string | null;
  sceneRevision?: number | string | null;
}

export interface StatusBarMeshModel {
  label: string;
  state: "building" | "current" | "not-built" | "stale" | "unknown";
  title: string;
}

const ACTIVE_MESH_BUILD_STATUSES = new Set([
  "active",
  "building",
  "generating",
  "pending",
  "queued",
  "running",
  "started",
]);

export function buildStatusBarMeshModel(
  input: StatusBarMeshModelInput,
): StatusBarMeshModel {
  const meshRevision = formatRevision(input.meshRevision);
  const meshBuildRevision = formatRevision(input.meshBuildRevision);
  const sceneRevision = formatRevision(input.sceneRevision);
  const sourceSceneRevision = formatRevision(input.manifestSourceSceneRevision);
  const activeStatus = normalizeToken(input.activeBuildStatus)?.toLowerCase() ?? null;
  const title = [
    `mesh_revision=${meshRevision ?? "unavailable"}`,
    `mesh_build_revision=${meshBuildRevision ?? "unavailable"}`,
    `scene_revision=${sceneRevision ?? "unavailable"}`,
    `manifest_source_scene_revision=${sourceSceneRevision ?? "unavailable"}`,
    `active_build_status=${activeStatus ?? "none"}`,
  ].join("\n");

  if (activeStatus && ACTIVE_MESH_BUILD_STATUSES.has(activeStatus)) {
    return {
      label: `Mesh rev ${meshRevision ?? "none"} | build rev ${meshBuildRevision ?? "pending"} | building`,
      state: "building",
      title,
    };
  }

  if (meshRevision === null) {
    return {
      label: "Mesh revision unavailable",
      state: "unknown",
      title,
    };
  }

  if (meshRevision === "0") {
    return { label: "Mesh not built", state: "not-built", title };
  }

  if (sceneRevision && sourceSceneRevision && sceneRevision === sourceSceneRevision) {
    return {
      label: `Mesh rev ${meshRevision} | build rev ${meshBuildRevision ?? "unknown"} | current`,
      state: "current",
      title,
    };
  }

  if (sceneRevision && sourceSceneRevision && sceneRevision !== sourceSceneRevision) {
    return {
      label: `Mesh rev ${meshRevision} | scene rev ${sceneRevision} | stale`,
      state: "stale",
      title,
    };
  }

  return {
    label: `Mesh rev ${meshRevision} | provenance unknown`,
    state: "unknown",
    title,
  };
}

export function buildStatusBarEngineModel(
  run: StatusBarRunReadback | null | undefined,
  solverState?: string | null,
  userSolvePhase?: RuntimeUserSolvePhase | null,
): StatusBarEngineModel {
  const phase = userSolvePhase ?? null;
  const awaitingCompute = phase === "awaiting_user_solve";
  if (!run) {
    if (phase) {
      return {
        awaitingCompute,
        detail: phase === "preparing_model"
          ? "Compute held until preparation is published"
          : "explicit Compute required",
        label: formatRuntimeUserSolvePhaseLabel(phase),
        state: "pending",
        title: phase === "preparing_model"
          ? "The runtime reported accepted_preparation_pending. Compute stays held until the prepared model is published."
          : "The model is materialized and the runtime waits for an explicit Compute. Nothing is solved automatically.",
        tone: "neutral",
      };
    }
    const state = solverState?.trim().toLowerCase();
    if (state && !["idle", "awaiting_command", "ready", "loading"].includes(state)) {
      return {
        awaitingCompute: false,
        detail: state === "running" ? "run in progress" : "run metadata unavailable",
        label: "Engine metadata pending",
        state: "pending",
        title: `Solver state: ${state}. Engine metadata has not been received; the method selection is shown separately.`,
        tone: "neutral",
      };
    }
    return {
      awaitingCompute: false,
      detail: "no active run",
      label: "Engine not started",
      state: "pending",
      title: "The simulation method is selected separately. No active engine run has started.",
      tone: "neutral",
    };
  }

  const engineId = normalizeToken(run.resolved_engine_id);
  const resolvedBackend = normalizeToken(run.resolved_backend);
  const resolvedDevice = normalizeToken(run.resolved_device);
  const resolvedPrecision = normalizeToken(run.resolved_precision);
  const requestedBackend = normalizeToken(run.requested_backend);
  const requestedDevice = normalizeToken(run.requested_device);
  const requestedPrecision = normalizeToken(run.requested_precision);
  const engine = engineId ? describeEngine(engineId) : null;
  const family = normalizeToken(run.resolved_runtime_family);
  const fallback = normalizeFallback(run.resolved_fallback);
  const hasResolvedRuntime =
    Boolean(engineId) || Boolean(family) || Boolean(resolvedBackend) || Boolean(resolvedDevice);
  const tokens: ExecutionIntentTokens = {
    requestedBackend,
    requestedDevice,
    requestedPrecision,
    resolvedBackend,
    resolvedDevice,
    resolvedPrecision,
  };
  const mismatch = describeExecutionMismatch(tokens);
  const label = formatRequestedResolvedLabel(tokens, hasResolvedRuntime);
  const executionDetail =
    fallback?.detail ??
    mismatch?.detail ??
    engine?.detail ??
    (family
      ? humanizeToken(family)
      : hasResolvedRuntime
        ? "runtime resolved"
        : pendingRuntimeDetail(requestedBackend, requestedDevice));
  const detail = phase
    ? `${formatRuntimeUserSolvePhaseLabel(phase)} · ${executionDetail}`
    : executionDetail;
  const state =
    hasResolvedRuntime && solverState?.toLowerCase() === "running"
      ? "active"
      : hasResolvedRuntime
        ? "resolved"
        : "pending";

  return {
    awaitingCompute,
    detail,
    label,
    state,
    title: [
      `requested_backend=${requestedBackend ?? "unresolved"}`,
      `requested_device=${requestedDevice ?? "unresolved"}`,
      `requested_precision=${requestedPrecision ?? "unpublished"}`,
      `resolved_backend=${resolvedBackend ?? "unresolved"}`,
      `resolved_device=${resolvedDevice ?? "unresolved"}`,
      `resolved_precision=${resolvedPrecision ?? "unpublished"}`,
      `resolved_engine_id=${engineId ?? "unresolved"}`,
      `resolved_runtime_family=${family ?? "unresolved"}`,
      `resolved_fallback=${fallback?.title ?? "none"}`,
      ...(mismatch ? [`execution_mismatch=${mismatch.title}`] : []),
      ...(phase ? [`user_solve_phase=${phase}`] : []),
    ].join("\n"),
    tone: mismatch || fallback ? "warning" : "neutral",
  };
}

interface ExecutionIntentTokens {
  requestedBackend: string | null;
  requestedDevice: string | null;
  requestedPrecision: string | null;
  resolvedBackend: string | null;
  resolvedDevice: string | null;
  resolvedPrecision: string | null;
}

/**
 * Requested → resolved label. The requested side stays visible whenever it
 * differs from the resolved side, including `auto` (e.g. "auto → FEM GPU"),
 * so a resolved execution never hides the user's intent. Precision is shown
 * only when the readback publishes it.
 */
function formatRequestedResolvedLabel(
  tokens: ExecutionIntentTokens,
  hasResolvedRuntime: boolean,
): string {
  const requestedLabel = formatExecutionSide(
    tokens.requestedBackend,
    tokens.requestedDevice,
    tokens.requestedPrecision,
  );
  if (!hasResolvedRuntime) return requestedLabel;
  const resolvedLabel = formatExecutionSide(
    tokens.resolvedBackend ?? concreteToken(tokens.requestedBackend),
    tokens.resolvedDevice ?? concreteToken(tokens.requestedDevice),
    tokens.resolvedPrecision,
  );
  const requestedIsAuto =
    isAutoToken(tokens.requestedBackend) || isAutoToken(tokens.requestedDevice);
  const differs =
    requestedIsAuto ||
    (tokens.resolvedBackend !== null &&
      !sameToken(tokens.requestedBackend, tokens.resolvedBackend)) ||
    (tokens.resolvedDevice !== null &&
      !sameToken(tokens.requestedDevice, tokens.resolvedDevice)) ||
    (tokens.resolvedPrecision !== null &&
      tokens.requestedPrecision !== null &&
      !sameToken(tokens.requestedPrecision, tokens.resolvedPrecision));
  if (!differs) return resolvedLabel;
  const intent =
    isAutoToken(tokens.requestedBackend) && isAutoToken(tokens.requestedDevice)
      ? "auto"
      : requestedLabel;
  return `${intent} → ${resolvedLabel}`;
}

function formatExecutionSide(
  backend: string | null,
  device: string | null,
  precision: string | null,
): string {
  const heading = formatBackendDevice(backend, device);
  return precision ? `${heading} ${precision.toLowerCase()}` : heading;
}

/**
 * A concrete requested backend/device/precision that resolved to something
 * else is a mismatch even when no `resolved_fallback` record is published.
 * Requested GPU resolved elsewhere violates forced-GPU intent; it is not a
 * neutral "resolved" state.
 */
function describeExecutionMismatch(
  tokens: ExecutionIntentTokens,
): { detail: string; title: string } | null {
  const parts: string[] = [];
  let detail: string | null = null;
  const requestedDevice = lowerConcrete(tokens.requestedDevice);
  const resolvedDevice = lowerConcrete(tokens.resolvedDevice);
  if (requestedDevice && resolvedDevice && requestedDevice !== resolvedDevice) {
    parts.push(`device ${requestedDevice}->${resolvedDevice}`);
    detail = requestedDevice === "gpu"
      ? `requested GPU not honoured (resolved ${resolvedDevice.toUpperCase()})`
      : `requested ${requestedDevice.toUpperCase()}, resolved ${resolvedDevice.toUpperCase()}`;
  }
  const requestedBackend = lowerConcrete(tokens.requestedBackend);
  const resolvedBackend = lowerConcrete(tokens.resolvedBackend);
  if (requestedBackend && resolvedBackend && requestedBackend !== resolvedBackend) {
    parts.push(`backend ${requestedBackend}->${resolvedBackend}`);
    detail ??= `requested ${requestedBackend.toUpperCase()}, resolved ${resolvedBackend.toUpperCase()}`;
  }
  const requestedPrecision = lowerConcrete(tokens.requestedPrecision);
  const resolvedPrecision = lowerConcrete(tokens.resolvedPrecision);
  if (requestedPrecision && resolvedPrecision && requestedPrecision !== resolvedPrecision) {
    parts.push(`precision ${requestedPrecision}->${resolvedPrecision}`);
    detail ??= `requested ${requestedPrecision}, resolved ${resolvedPrecision}`;
  }
  return detail ? { detail, title: parts.join("; ") } : null;
}

function concreteToken(value: string | null): string | null {
  return value && !isAutoToken(value) ? value : null;
}

function lowerConcrete(value: string | null): string | null {
  return concreteToken(value)?.toLowerCase() ?? null;
}

function sameToken(left: string | null, right: string | null): boolean {
  return (left?.toLowerCase() ?? null) === (right?.toLowerCase() ?? null);
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

function formatRevision(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
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

function normalizeFallback(
  fallback:
    | StatusBarRunReadback["resolved_fallback"]
    | null
    | undefined,
): { detail: string; title: string } | null {
  if (!fallback?.occurred) return null;
  const original = normalizeToken(fallback.original_engine);
  const target = normalizeToken(fallback.fallback_engine);
  const reason = normalizeToken(fallback.reason);
  const message = normalizeToken(fallback.message);
  const targetLabel = target ? describeEngine(target)?.detail ?? humanizeToken(target) : "fallback";
  const detail = `fallback to ${targetLabel}`;
  const title = [
    original ? `original_engine=${original}` : null,
    target ? `fallback_engine=${target}` : null,
    reason ? `reason=${reason}` : null,
    message ? `message=${message}` : null,
  ]
    .filter(Boolean)
    .join("; ");
  return { detail, title: title || "occurred" };
}

function isAutoToken(value: string | null): boolean {
  return value?.toLowerCase() === "auto";
}

function isIsoCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
