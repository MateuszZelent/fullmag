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

/**
 * Rounded hue angles shared by the existing Catppuccin Mocha and Latte chart
 * colors. Keep these aligned with the token values in design/styles/theme.css.
 */
const PRIMITIVE_COLOR_HUE_DEGREES = {
  "--fm-chart-blue": 219,
  "--fm-chart-green": 112,
  "--fm-chart-yellow": 38,
  "--fm-chart-red": 345,
  "--fm-chart-mauve": 267,
  "--fm-chart-peach": 23,
  "--fm-chart-teal": 177,
  "--fm-chart-sky": 193,
  "--fm-chart-pink": 316,
  "--fm-chart-lavender": 231,
  "--fm-chart-flamingo": 0,
  "--fm-chart-rosewater": 10,
} satisfies Record<(typeof FERROMAGNETIC_PRIMITIVE_COLOR_TOKENS)[number], number>;

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
 * Assign stable, distinct palette slots for a scene snapshot. The first object
 * keeps its hashed slot; later objects maximize their minimum hue distance from
 * assigned colors, with a hash-seeded cyclic tie-break. Beyond the finite
 * palette, slots repeat.
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
    if (occupied.size > 0 && occupied.size < paletteSize) {
      let bestMinimumHueDistance = -1;
      for (let probe = 0; probe < paletteSize; probe += 1) {
        const candidate = (initialIndex + probe) % paletteSize;
        if (occupied.has(candidate)) continue;

        const minimumHueDistance = minimumAssignedHueDistance(
          candidate,
          occupied,
        );
        if (minimumHueDistance > bestMinimumHueDistance) {
          paletteIndex = candidate;
          bestMinimumHueDistance = minimumHueDistance;
        }
      }
    } else if (occupied.size === 0) {
      // Keep the first scene object anchored to its stable hash slot.
      paletteIndex = initialIndex;
    }
    occupied.add(paletteIndex);
    assignments.set(objectId, paletteIndex);
  }

  return assignments;
}

function minimumAssignedHueDistance(
  candidateIndex: number,
  assignedIndices: ReadonlySet<number>,
): number {
  let minimumDistance = Number.POSITIVE_INFINITY;
  for (const assignedIndex of assignedIndices) {
    const candidateToken = FERROMAGNETIC_PRIMITIVE_COLOR_TOKENS[candidateIndex]!;
    const assignedToken = FERROMAGNETIC_PRIMITIVE_COLOR_TOKENS[assignedIndex]!;
    const distance = circularHueDistance(
      PRIMITIVE_COLOR_HUE_DEGREES[candidateToken],
      PRIMITIVE_COLOR_HUE_DEGREES[assignedToken],
    );
    minimumDistance = Math.min(minimumDistance, distance);
  }
  return minimumDistance;
}

function circularHueDistance(left: number, right: number): number {
  const difference = Math.abs(left - right);
  return Math.min(difference, 360 - difference);
}

/** Resolve the editable primitive preference independently of a solid-shader override. */
export function primitiveMonoColorForRole(
  role: string | null | undefined,
  requested: string | undefined,
): string {
  return role === "antenna" && (!requested || requested.startsWith("var("))
    ? "var(--fm-surface-antenna)"
    : requested ?? "";
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
  if (requested !== undefined && requestedPaletteIndex !== undefined) {
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
