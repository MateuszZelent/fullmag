import type { VisualizationTargetSettings } from "./ObjectVisualizationController";

/** Shared Catppuccin chart tokens used to distinguish field-free primitives. */
export const FERROMAGNETIC_PRIMITIVE_COLOR_TOKENS = [
  "--fm-chart-blue",
  "--fm-chart-green",
  "--fm-chart-yellow",
  "--fm-chart-red",
  "--fm-chart-mauve",
  "--fm-chart-peach",
  "--fm-chart-teal",
  "--fm-chart-sky",
  "--fm-chart-pink",
  "--fm-chart-lavender",
  "--fm-chart-flamingo",
  "--fm-chart-rosewater",
] as const;

const MAGNETIC_SURFACE_TOKEN = "var(--fm-surface-magnetic)";

/** Presentation role only; this helper never enables or infers physics. */
export function isFerromagneticPrimitiveRole(
  role: string | null | undefined,
): boolean {
  const normalizedRole = role?.trim().toLowerCase();
  return (
    normalizedRole === undefined ||
    normalizedRole === "" ||
    normalizedRole === "magnet" ||
    normalizedRole === "magnetic" ||
    normalizedRole === "magnetic_object"
  );
}

/**
 * Assign stable, distinct palette slots for a scene snapshot. Hash collisions
 * probe forward in deterministic order; beyond the finite palette, slots repeat.
 */
export function createPrimitiveSurfaceColorAssignments(
  objectIds: readonly string[],
): ReadonlyMap<string, number> {
  const entries = [...new Set(objectIds.filter(Boolean))]
    .map((objectId) => ({ objectId, hash: stableObjectIdHash(objectId) }))
    .sort((left, right) =>
      left.hash - right.hash || compareObjectIds(left.objectId, right.objectId),
    );
  const assignments = new Map<string, number>();
  const occupied = new Set<number>();
  const paletteSize = FERROMAGNETIC_PRIMITIVE_COLOR_TOKENS.length;

  for (const { objectId, hash } of entries) {
    const initialIndex = hash % paletteSize;
    let paletteIndex = initialIndex;
    for (let probe = 0; probe < paletteSize; probe += 1) {
      const candidate = (initialIndex + probe) % paletteSize;
      if (!occupied.has(candidate)) {
        paletteIndex = candidate;
        break;
      }
    }
    occupied.add(paletteIndex);
    assignments.set(objectId, paletteIndex);
  }

  return assignments;
}

/** Presentation only; the authored role never determines solver physics. */
export function resolvePrimitiveSurfaceColor(
  role: string | null | undefined,
  settings: Pick<VisualizationTargetSettings, "primitiveMonoColor" | "shaderMonoColor" | "surfaceColorSource">,
  objectId?: string,
  assignments?: ReadonlyMap<string, number>,
): {
  color: string;
  source:
    | "primitive"
    | "solid-shader"
    | "magnetic-palette"
    | "magnetic-theme"
    | "antenna-theme"
    | "object-theme";
  paletteIndex?: number;
} {
  const solid = settings.surfaceColorSource === "solid";
  const requested = solid ? settings.shaderMonoColor : settings.primitiveMonoColor;
  if (requested && !requested.startsWith("var(")) {
    return { color: requested, source: solid ? "solid-shader" : "primitive" };
  }
  const requestedPaletteIndex = requested
    ? paletteIndexForToken(requested)
    : undefined;
  if (requestedPaletteIndex !== undefined) {
    return {
      color: requested,
      paletteIndex: requestedPaletteIndex,
      source: solid ? "solid-shader" : "primitive",
    };
  }

  if (
    (!requested || requested === MAGNETIC_SURFACE_TOKEN) &&
    isFerromagneticPrimitiveRole(role) &&
    objectId
  ) {
    const paletteIndex = assignments
      ? assignments.get(objectId)
      : createPrimitiveSurfaceColorAssignments([objectId]).get(objectId);
    if (paletteIndex !== undefined) {
      return {
        color: `var(${FERROMAGNETIC_PRIMITIVE_COLOR_TOKENS[paletteIndex]})`,
        paletteIndex,
        source: "magnetic-palette",
      };
    }
  }

  if (
    !solid &&
    !objectId &&
    (role === "magnetic" || role === "magnetic_object")
  ) {
    return { color: "var(--fm-surface-3)", source: "object-theme" };
  }

  if (
    requested === MAGNETIC_SURFACE_TOKEN &&
    (solid || role !== "antenna")
  ) {
    return { color: requested, source: "magnetic-theme" };
  }
  return role === "antenna"
    ? { color: "var(--fm-surface-antenna)", source: "antenna-theme" }
    : { color: "var(--fm-surface-3)", source: "object-theme" };
}

function paletteIndexForToken(color: string): number | undefined {
  const token = /^var\((--fm-chart-[a-z0-9-]+)\)$/.exec(color)?.[1];
  if (!token) return undefined;
  const paletteIndex = FERROMAGNETIC_PRIMITIVE_COLOR_TOKENS.indexOf(
    token as (typeof FERROMAGNETIC_PRIMITIVE_COLOR_TOKENS)[number],
  );
  return paletteIndex >= 0 ? paletteIndex : undefined;
}

function stableObjectIdHash(objectId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < objectId.length; index += 1) {
    hash = Math.imul(hash ^ objectId.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

function compareObjectIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
