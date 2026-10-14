export type SessionDiscretization = "fdm" | "fem";

type LaneSelectionProjection = {
  backend?: unknown;
  discretization?: unknown;
};

export type SessionDiscretizationCapabilitiesProjection = {
  active_lane?: {
    authored?: LaneSelectionProjection | null;
    resolved?: LaneSelectionProjection | null;
  } | null;
  active_lane_discretization?: unknown;
};

export interface SessionDiscretizationStatus {
  capabilities?: SessionDiscretizationCapabilitiesProjection | null;
  domain?: { discretization?: unknown } | null;
  domainDiscretization?: unknown;
}

export function projectFlatActiveLaneDiscretization(
  capabilities: unknown,
): { value: unknown } | null {
  if (!capabilities || typeof capabilities !== "object") return null;
  if (
    !Object.prototype.hasOwnProperty.call(
      capabilities,
      "active_lane_discretization",
    )
  ) {
    return null;
  }
  return {
    value: (capabilities as { active_lane_discretization?: unknown })
      .active_lane_discretization,
  };
}

export function hasSessionActiveLaneDeclaration(
  status: SessionDiscretizationStatus | null | undefined,
): boolean {
  const capabilities = status?.capabilities;
  return Boolean(
    capabilities &&
      (Object.prototype.hasOwnProperty.call(capabilities, "active_lane") ||
        projectFlatActiveLaneDiscretization(capabilities) !== null),
  );
}

function normalizeDiscretization(value: unknown): SessionDiscretization | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "fdm" || normalized === "fem" ? normalized : null;
}

/**
 * Resolves the live session's solver lane. A present active-lane field is
 * authoritative even when its resolved lane is null or malformed; DomainMeta
 * is only a compatibility source for status payloads that predate active_lane.
 * A flattened lane value is used only when the nested active_lane field is
 * absent from the projected status.
 */
export function resolveSessionDiscretization(
  status: SessionDiscretizationStatus | null | undefined,
): SessionDiscretization | null {
  const capabilities = status?.capabilities;
  if (
    capabilities &&
    Object.prototype.hasOwnProperty.call(capabilities, "active_lane")
  ) {
    return normalizeDiscretization(
      capabilities.active_lane?.resolved?.discretization,
    );
  }
  if (
    capabilities &&
    Object.prototype.hasOwnProperty.call(
      capabilities,
      "active_lane_discretization",
    )
  ) {
    return normalizeDiscretization(capabilities.active_lane_discretization);
  }
  if (
    status?.domain &&
    Object.prototype.hasOwnProperty.call(status.domain, "discretization")
  ) {
    return normalizeDiscretization(status.domain.discretization);
  }
  return normalizeDiscretization(status?.domainDiscretization);
}

export function selectSessionDiscretization(status: {
  data: SessionDiscretizationStatus | null;
}): SessionDiscretization | null {
  return resolveSessionDiscretization(status.data);
}


export interface SessionAuthoringMethodDescription {
  method: SessionDiscretization | null;
  state: "known" | "loading" | "missing" | "conflict";
  reason: string | null;
}

/** Accepted model intent is independent of the engine executing a run. */
export function describeSessionAuthoringDiscretization(
  status: SessionDiscretizationStatus | null | undefined,
): SessionAuthoringMethodDescription {
  if (!status) return { method: null, state: "loading", reason: "Loading the model method." };
  const lane = status.capabilities?.active_lane;
  if (lane && Object.prototype.hasOwnProperty.call(lane, "authored")) {
    const authored = lane.authored;
    const discretization = normalizeDiscretization(authored?.discretization);
    const backendToken = typeof authored?.backend === "string" ? authored.backend.trim().toLowerCase() : null;
    // Legacy public status identities named the device with the method.
    const backend = normalizeDiscretization(backendToken)
      ?? (backendToken === "cpu-fdm" || backendToken === "gpu-fdm" ? "fdm" : null)
      ?? (backendToken === "cpu-fem" || backendToken === "gpu-fem" ? "fem" : null);
    if (authored?.backend != null && !backend) {
      return {
        method: null,
        state: backendToken === "auto" ? "missing" : "conflict",
        reason: "Choose an explicit FEM or FDM method in Study settings before configuring the domain.",
      };
    }
    if (backend && discretization && backend !== discretization) {
      return { method: null, state: "conflict", reason: "The published model method is inconsistent. Review Study settings and model diagnostics." };
    }
    const method = backend ?? discretization;
    return method
      ? { method, state: "known", reason: null }
      : { method: null, state: "missing", reason: "Choose FEM or FDM in Study settings before configuring the domain." };
  }
  // Compatibility for statuses predating authored identity. Explicit runtime
  // unresolved still does not fall through to a retained domain artifact.
  const method = resolveSessionDiscretization(status);
  return method
    ? { method, state: "known", reason: null }
    : { method: null, state: "missing", reason: "The model method is unavailable. Review Study settings and session diagnostics." };
}

export function resolveSessionAuthoringDiscretization(
  status: SessionDiscretizationStatus | null | undefined,
): SessionDiscretization | null {
  return describeSessionAuthoringDiscretization(status).method;
}
