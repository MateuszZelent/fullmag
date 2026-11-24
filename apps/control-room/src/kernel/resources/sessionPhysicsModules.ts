import type {
  SceneResource,
  StageExecutionResource,
} from "@/kernel/api/apiTypes";
import { resolveCanonicalQuantityId } from "@/kernel/api/quantityIds";

export interface SessionPhysicsModules {
  /** True when the session includes AC/DC microwave antennas, conductors, or antenna solve stages. */
  readonly acDcActive: boolean;
  /** True when the session includes eigenmodes or frequency-domain solver stages. */
  readonly eigensolveActive: boolean;
}

const AC_DC_OBJECT_ROLES = new Set(["antenna", "conductor", "electrode"]);

const EIGENSOLVE_STAGE_KINDS = new Set([
  "eigenmodes",
  "flat_eigenmodes",
  "frequency_response",
  "flat_frequency_response",
]);

const CONDUCTOR_ONLY_QUANTITY_IDS = new Set([
  "V_electric",
  "J_charge",
  "spin_potential",
  "spin_current_tensor",
]);

const AC_DC_FIELD_QUANTITY_IDS = new Set([
  "H_ant",
  "H_oe",
  "H_ant_basis",
  "H_ant_source_spectrum",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isEigensolveStageKind(kind: string | null | undefined): boolean {
  if (!kind) return false;
  return EIGENSOLVE_STAGE_KINDS.has(kind.trim().toLowerCase());
}

export function isConductorOnlyQuantityId(
  quantityId: string | null | undefined,
): boolean {
  if (!quantityId) return false;
  const canonical = resolveCanonicalQuantityId(quantityId);
  return (
    CONDUCTOR_ONLY_QUANTITY_IDS.has(quantityId) ||
    CONDUCTOR_ONLY_QUANTITY_IDS.has(canonical)
  );
}

export function isAcDcOnlyQuantityId(
  quantityId: string | null | undefined,
): boolean {
  if (!quantityId) return false;
  const canonical = resolveCanonicalQuantityId(quantityId);
  return (
    isConductorOnlyQuantityId(quantityId) ||
    AC_DC_FIELD_QUANTITY_IDS.has(quantityId) ||
    AC_DC_FIELD_QUANTITY_IDS.has(canonical)
  );
}

export function sceneObjectIsAcDcRole(
  candidate: unknown,
): boolean {
  const record = asRecord(candidate);
  if (!record) return false;
  const role =
    typeof record.role === "string" ? record.role.trim().toLowerCase() : "";
  if (AC_DC_OBJECT_ROLES.has(role)) return true;
  const hint = asRecord(record.visualization_hint);
  const hintRole =
    typeof hint?.role === "string" ? hint.role.trim().toLowerCase() : "";
  if (AC_DC_OBJECT_ROLES.has(hintRole)) return true;
  if (Array.isArray(record.tags)) {
    for (const tag of record.tags) {
      if (
        typeof tag === "string" &&
        (tag === "role:antenna" ||
          tag === "role:conductor" ||
          tag === "role:electrode")
      ) {
        return true;
      }
    }
  }
  return false;
}

export function hasSessionAcDcAntennaModule({
  scene,
  stageExecution,
  hasActiveAntennaStage = false,
}: {
  scene?: SceneResource | null;
  stageExecution?: StageExecutionResource | null;
  hasActiveAntennaStage?: boolean;
}): boolean {
  if (hasActiveAntennaStage) return true;
  if (stageExecution?.stages?.some((stage) => Boolean(stage.antenna_solve_stage_id?.trim()))) {
    return true;
  }
  if (!scene) return false;
  if ((scene.objects ?? []).some((obj) => sceneObjectIsAcDcRole(obj))) {
    return true;
  }
  if ((scene.antenna_field_solve_stages?.length ?? 0) > 0) return true;
  if ((scene.antenna_port_modes?.length ?? 0) > 0) return true;
  if ((scene.current_transports?.length ?? 0) > 0) return true;
  const rawMaskAntennas = asRecord(scene)?.mask_antennas;
  if (Array.isArray(rawMaskAntennas) && rawMaskAntennas.length > 0) return true;
  return false;
}

export function hasSessionEigensolveModule({
  scene,
  stageExecution,
  solverStageKind,
  hasActiveEigensolveStage = false,
}: {
  scene?: SceneResource | null;
  stageExecution?: StageExecutionResource | null;
  solverStageKind?: string | null;
  hasActiveEigensolveStage?: boolean;
}): boolean {
  if (hasActiveEigensolveStage) return true;
  if (isEigensolveStageKind(solverStageKind)) return true;
  if (isEigensolveStageKind(stageExecution?.active_stage_kind)) return true;
  if (
    stageExecution?.stages?.some((stage) => isEigensolveStageKind(stage.kind))
  ) {
    return true;
  }
  const study = asRecord(scene?.study);
  const stages = Array.isArray(study?.stages) ? study.stages : [];
  for (const stage of stages) {
    const record = asRecord(stage);
    const kind =
      typeof record?.kind === "string"
        ? record.kind
        : typeof record?.type === "string"
          ? record.type
          : null;
    if (isEigensolveStageKind(kind)) return true;
  }
  return false;
}

export function resolveSessionPhysicsModules(input: {
  scene?: SceneResource | null;
  stageExecution?: StageExecutionResource | null;
  solverStageKind?: string | null;
  hasActiveAntennaStage?: boolean;
  hasActiveEigensolveStage?: boolean;
}): SessionPhysicsModules {
  return {
    acDcActive: hasSessionAcDcAntennaModule(input),
    eigensolveActive: hasSessionEigensolveModule(input),
  };
}
