/**
 * User-facing copy for planar data-plane failures. The API reports stable
 * `code: detail` messages; the stage shows a short explanation and keeps the
 * raw message as technical detail instead of printing it as the headline.
 */

export type PlanarErrorKind = "superseded" | "pending" | "unsupported" | "empty" | "failed";

export interface PlanarErrorCopy {
  code: string | null;
  kind: PlanarErrorKind;
  /** Short sentence for the stage. */
  message: string;
  /** Raw API message, shown on demand. */
  technical: string;
}

const UNSUPPORTED_CODES = new Set([
  "missing_fdm_membership",
  "planar_scope_unsupported",
  "planar_vector_unsupported",
  "snapshot_quantity_unsupported",
  "target_unsupported",
  "unsupported_artifact_carrier",
  "unsupported_element_order",
  "unsupported_planar_operator",
  "unsupported_planar_surface",
]);

const EMPTY_CODES = new Set(["empty_target"]);
const PENDING_CODES = new Set(["quantity_not_materialized"]);

export function planarErrorCode(error: unknown): string | null {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z][a-z0-9_]*$/.test(code) && code !== "conflict") {
      return code;
    }
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /^([a-z][a-z0-9_]*):/.exec(message)?.[1] ?? null;
}

/** A 409 for a revision or sample the solver has already replaced. */
export function isSupersededPlanarError(error: unknown): boolean {
  const code = planarErrorCode(error);
  return code !== null && code.startsWith("stale_") && code !== "stale_mesh_scope";
}

export function describePlanarError(error: unknown): PlanarErrorCopy {
  const technical =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Planar field unavailable.";
  const code = planarErrorCode(error);
  if (isSupersededPlanarError(error)) {
    return {
      code,
      kind: "superseded",
      message: "A newer solver step replaced this sample; refreshing.",
      technical,
    };
  }
  if (code !== null && PENDING_CODES.has(code)) {
    return {
      code,
      kind: "pending",
      message: "This quantity has no published data yet. It appears after the solver saves a step.",
      technical,
    };
  }
  if (code !== null && EMPTY_CODES.has(code)) {
    return {
      code,
      kind: "empty",
      message: "The section does not cut the selected target. Move the section or choose another target.",
      technical,
    };
  }
  if (code !== null && (UNSUPPORTED_CODES.has(code) || code.startsWith("unsupported_"))) {
    return {
      code,
      kind: "unsupported",
      message: "This 2D view cannot be sampled for the current model and selection.",
      technical,
    };
  }
  return {
    code,
    kind: "failed",
    message: "The planar field could not be loaded.",
    technical,
  };
}
