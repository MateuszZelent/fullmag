import type { SceneCurrentTransport, SceneSpinTorque } from "@/kernel/api/apiTypes";
import { isKnownCurrentTransport } from "@/shared/domain/physics/transportRecognition";

export interface SpinAuthoringInitialScope {
  objectId: string;
  regionId?: string | null;
}

export interface TorqueDraft {
  beta: string;
  compatibilityOrigin: string;
  currentDensity: string;
  currentSource: string;
  degree: string;
  drive: string;
  epsilonPrime: string;
  fixedLayerPosition: string;
  formulaVersion: string;
  freeLayerThickness: string;
  id: string;
  kind: "zhang_li" | "slonczewski" | "prescribed_sot";
  landeG: string;
  lambdaAsymmetry: string;
  operatorVersion: string;
  rawSpinPolarization: string;
  realization: string;
  schemaVersion: string;
  spinPolarization: string;
  stackNormal: string;
  target: string;
  timeExpression: string;
  xiDl: string;
  xiFl: string;
}

export function parseVector(value: string, label: string): number[] {
  const parsed = value.split(/[\s,]+/).filter(Boolean).map(Number);
  if (parsed.length !== 3 || parsed.some((entry) => !Number.isFinite(entry))) throw new Error(`${label} requires three finite components.`);
  return parsed;
}

export function finite(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite.`);
  return parsed;
}

export function optionalJson(value: string): unknown | undefined {
  return value.trim() ? JSON.parse(value) : undefined;
}

function optionalVector(value: string, label: string): number[] | undefined {
  return value.trim() ? parseVector(value, label) : undefined;
}

export function buildTorque(draft: TorqueDraft): SceneSpinTorque {
  if (!draft.id.trim()) throw new Error("Torque id is required.");
  if (draft.kind === "zhang_li") return {
    kind: draft.kind,
    id: draft.id,
    formula_version: draft.formulaVersion as never,
    schema_version: draft.schemaVersion.trim() || undefined,
    operator_version: draft.operatorVersion.trim() ? draft.operatorVersion as never : undefined,
    target: optionalJson(draft.target) as never,
    current_density: optionalVector(draft.currentDensity, "Current density"),
    current_source: draft.currentSource.trim() ? draft.currentSource : undefined,
    degree: finite(draft.degree, "Degree"),
    beta: finite(draft.beta, "Beta"),
    lande_g: draft.landeG.trim() ? finite(draft.landeG, "Landé g factor") : undefined,
  };
  if (draft.kind === "slonczewski") return {
    kind: draft.kind,
    id: draft.id,
    current_density: optionalVector(draft.currentDensity, "Current density"),
    current_source: draft.currentSource.trim() ? draft.currentSource : undefined,
    degree: finite(draft.degree, "Degree"),
    epsilon_prime: finite(draft.epsilonPrime, "Epsilon prime"),
    fixed_layer_position: draft.fixedLayerPosition.trim() || undefined,
    formula_version: draft.formulaVersion as never,
    free_layer_thickness_m: draft.freeLayerThickness.trim() ? finite(draft.freeLayerThickness, "Free-layer thickness") : undefined,
    lambda_asymmetry: finite(draft.lambdaAsymmetry, "Lambda asymmetry"),
    realization: optionalJson(draft.realization) as never,
    schema_version: draft.schemaVersion.trim() || undefined,
    spin_polarization: parseVector(draft.spinPolarization, "Spin polarization"),
    stack_normal: optionalVector(draft.stackNormal, "Stack normal"),
    target: optionalJson(draft.target) as never,
    ...(draft.formulaVersion !== "slonczewski.fullmag.v2"
      || draft.currentSource.trim()
      || !draft.timeExpression.trim()
      ? {}
      : { time_expression: optionalJson(draft.timeExpression) as Record<string, unknown> }),
  };
  return {
    kind: draft.kind,
    id: draft.id,
    compatibility_origin: optionalJson(draft.compatibilityOrigin) as never,
    drive: JSON.parse(draft.drive),
    formula_version: draft.formulaVersion as never,
    free_layer_thickness_m: finite(draft.freeLayerThickness, "Free-layer thickness"),
    raw_spin_polarization: optionalVector(draft.rawSpinPolarization, "Raw spin polarization"),
    schema_version: draft.schemaVersion as never,
    target: optionalJson(draft.target) as never,
    xi_dl: finite(draft.xiDl, "Damping-like efficiency"),
    xi_fl: finite(draft.xiFl, "Field-like efficiency"),
  };
}

export function resolveOerstedCurrentSource(
  currents: readonly SceneCurrentTransport[],
  scope: SpinAuthoringInitialScope | null,
): string | null {
  if (!scope) return null;
  const matches = currents.flatMap((current) => {
    if (!isKnownCurrentTransport(current)) return [];
    const domain = current.domain ?? [];
    const exactDomainMatch = domain.some((region) =>
      region.object_id === scope.objectId
      && (scope.regionId ? region.region_id === scope.regionId : true),
    );
    const legacyObjectMatch = !scope.regionId
      && domain.length === 0
      && current.solve_region === scope.objectId;
    return exactDomainMatch || legacyObjectMatch ? [current.name.trim()] : [];
  }).filter(Boolean);
  return matches.length === 1 ? matches[0] : null;
}

export function torqueModelPatch(draft: TorqueDraft, kind: TorqueDraft["kind"]): Partial<TorqueDraft> {
  if (kind === "zhang_li") {
    return { kind, formulaVersion: "zhang_li.legacy_fullmag.v0", schemaVersion: "", operatorVersion: "", landeG: "" };
  }
  if (kind === "slonczewski") {
    return { kind, formulaVersion: "slonczewski.fullmag.v2", schemaVersion: "" };
  }
  return {
    kind,
    formulaVersion: "prescribed_sot.fullmag.v1",
    schemaVersion: "prescribed_sot.v1",
    freeLayerThickness: draft.freeLayerThickness || "1e-9",
  };
}
