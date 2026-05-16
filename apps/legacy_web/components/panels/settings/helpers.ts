import { fmtSI } from "../../runs/control-room/shared";
import type { SolverPlanSummary } from "../../runs/control-room/types";

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function asVec3Tuple(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value;
  if ([x, y, z].some((component) => typeof component !== "number" || !Number.isFinite(component))) {
    return null;
  }
  return [x, y, z];
}

export interface BuilderContractSummary {
  sourceKind: string | null;
  entrypointKind: string | null;
  scriptApiSurface: string | null;
  rewriteStrategy: string | null;
  phase: string | null;
  editableScopes: string[];
}

export interface BuilderUniverseSummary {
  mode: string | null;
  size: [number, number, number] | null;
  center: [number, number, number] | null;
  padding: [number, number, number] | null;
  airbox_hmax: number | null;
}

export function readBuilderModel(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  const problemMeta = asRecord(metadata?.problem_meta);
  const runtimeMetadata = asRecord(problemMeta?.runtime_metadata);
  return asRecord(runtimeMetadata?.model_builder);
}

export function readBuilderContract(metadata: Record<string, unknown> | null): BuilderContractSummary | null {
  const builderModel = readBuilderModel(metadata);
  const problemMeta = asRecord(metadata?.problem_meta);
  const runtimeMetadata = asRecord(problemMeta?.runtime_metadata);
  const scriptSync = asRecord(runtimeMetadata?.script_sync);
  if (!builderModel && !scriptSync) return null;
  return {
    sourceKind:
      (typeof builderModel?.source_kind === "string" ? builderModel.source_kind : null)
      ?? (typeof scriptSync?.source_kind === "string" ? scriptSync.source_kind : null),
    entrypointKind:
      (typeof builderModel?.entrypoint_kind === "string" ? builderModel.entrypoint_kind : null)
      ?? (typeof scriptSync?.entrypoint_kind === "string" ? scriptSync.entrypoint_kind : null),
    scriptApiSurface:
      (typeof builderModel?.script_api_surface === "string" ? builderModel.script_api_surface : null),
    rewriteStrategy: typeof scriptSync?.rewrite_strategy === "string" ? scriptSync.rewrite_strategy : null,
    phase: typeof scriptSync?.phase === "string" ? scriptSync.phase : null,
    editableScopes:
      asStringList(builderModel?.editable_scopes).length > 0
        ? asStringList(builderModel?.editable_scopes)
        : asStringList(scriptSync?.editable_scopes),
  };
}

export function readBuilderUniverse(metadata: Record<string, unknown> | null): BuilderUniverseSummary | null {
  const builderModel = readBuilderModel(metadata);
  const problem = asRecord(builderModel?.problem);
  const universe = asRecord(problem?.universe);
  if (!universe) return null;
  return {
    mode: asString(universe.mode),
    size: asVec3Tuple(universe.size),
    center: asVec3Tuple(universe.center),
    padding: asVec3Tuple(universe.padding),
    airbox_hmax:
      typeof universe.airbox_hmax === "number" && Number.isFinite(universe.airbox_hmax)
        ? universe.airbox_hmax
        : null,
  };
}

export function humanizeToken(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatVector(value: [number, number, number] | null, unit: string): string {
  if (!value) return "—";
  return value.map((component) => fmtSI(component, unit)).join(" · ");
}

export function formatGrid(value: [number, number, number] | null): string {
  if (!value) return "—";
  return value.map((component) => Math.round(component).toLocaleString()).join(" × ");
}

export function studyKindForPlan(plan: SolverPlanSummary | null): string {
  if (!plan) return "—";
  return plan.relaxation ? "Relaxation" : "Time evolution";
}

export function timestepModeForPlan(plan: SolverPlanSummary | null): string {
  if (!plan) return "—";
  if (plan.adaptive) return "Adaptive";
  if (plan.fixedTimestep != null) return "Fixed";
  return "Backend default";
}

export function precessionModeForPlan(plan: SolverPlanSummary | null): string {
  if (!plan) return "—";
  const algorithm = plan?.relaxation?.algorithm;
  if (!algorithm) return "Enabled";
  if (algorithm === "llg_overdamped") return "Disabled";
  if (algorithm === "projected_gradient_bb" || algorithm === "nonlinear_cg") return "N/A";
  return "Algorithm-dependent";
}
