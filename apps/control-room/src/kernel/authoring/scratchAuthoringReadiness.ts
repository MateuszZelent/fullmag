import type {
  ModelReadinessCheck,
  ModelReadinessResource,
} from "../api/apiTypes";

const CHECK_ORDER = [
  "geometry",
  "material",
  "texture",
  "interactions",
  "discretization",
  "study",
] as const;

const CHECK_LABELS: Record<(typeof CHECK_ORDER)[number], string> = {
  discretization: "Discretization",
  geometry: "Geometry",
  interactions: "Interactions",
  material: "Material",
  study: "Study",
  texture: "Initial magnetization",
};

export function toChecklist(
  readiness: ModelReadinessResource,
): ModelReadinessCheck[] {
  const checksById = new Map(readiness.checks.map((check) => [check.id, check]));
  return CHECK_ORDER.flatMap((id) => {
    const check = checksById.get(id);
    return check ? [{ ...check, label: CHECK_LABELS[id] }] : [];
  });
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
