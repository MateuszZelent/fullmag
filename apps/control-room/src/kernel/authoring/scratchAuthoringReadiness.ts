import type {
  ModelReadinessCheck,
  ModelReadinessResource,
} from "../api/apiTypes";

export const SCRATCH_AUTHORING_CHECK_ORDER = [
  "method",
  "domain",
  "geometry",
  "material",
  "texture",
  "interactions",
  "discretization",
  "study",
  "execution",
] as const;

const CHECK_LABELS: Record<(typeof SCRATCH_AUTHORING_CHECK_ORDER)[number], string> = {
  discretization: "Discretization",
  domain: "Domain",
  execution: "Execution",
  geometry: "Geometry",
  interactions: "Interactions",
  material: "Material",
  method: "Method",
  study: "Study",
  texture: "Initial magnetization",
};

export function toChecklist(
  readiness: ModelReadinessResource,
): ModelReadinessCheck[] {
  const orderById = new Map<string, number>(
    SCRATCH_AUTHORING_CHECK_ORDER.map((id, index) => [id, index]),
  );
  return readiness.checks
    .map((check, index) => ({ check, index }))
    .sort((left, right) => {
      const leftOrder = orderById.get(left.check.id);
      const rightOrder = orderById.get(right.check.id);
      if (leftOrder !== undefined && rightOrder !== undefined) {
        return leftOrder - rightOrder || left.index - right.index;
      }
      if (leftOrder !== undefined) return -1;
      if (rightOrder !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ check }) => ({
      ...check,
      label:
        orderById.has(check.id) && check.id in CHECK_LABELS
          ? CHECK_LABELS[check.id as (typeof SCRATCH_AUTHORING_CHECK_ORDER)[number]]
          : check.label,
    }));
}

export function resolveRunAvailability(
  readiness: ModelReadinessResource,
): { enabled: boolean; reason: string | null } {
  if (readiness.ready_to_run) return { enabled: true, reason: null };
  return {
    enabled: false,
    reason: readiness.blockers[0] ?? "Complete the model checklist before running.",
  };
}
