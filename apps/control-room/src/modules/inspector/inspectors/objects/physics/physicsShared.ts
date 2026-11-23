import type {
  AuthoringTransactionRequest,
  ObjectInteractionKind,
  PhysicsGraphModuleResource,
} from "@/kernel/api/apiTypes";
import type { ActiveLaneOperationId } from "@/kernel/resources/useActiveLaneCapabilities";
import {
  findInteractionSpec,
  type InteractionDiscretization,
  type InteractionSpec,
  type PhysicsInteractionId,
} from "@/shared/domain/physics/interactions";
import type { Selection } from "@/kernel/selection/selectionTypes";

import type { SceneObjectItem as SceneObject } from "../../../panels/model-roots/SpecInspectorHost";

export type SceneCoupling = Extract<
  AuthoringTransactionRequest,
  { kind: "create_coupling" }
>["coupling"];
export type SceneCouplingPatch = Extract<
  AuthoringTransactionRequest,
  { kind: "patch_coupling" }
>["patch"];
export type SceneCouplingEndpoint = SceneCoupling["source"];
export type SceneCouplingParameters = SceneCoupling["parameters"];
export type SceneCouplingCapabilityPolicy = NonNullable<
  SceneCoupling["capability_policy"]
>;

export type BackendWritableObjectInteractionKind =
  | "exchange"
  | "demag"
  | "uniaxial_anisotropy"
  | "cubic_anisotropy"
  | "interfacial_dmi"
  | "bulk_dmi";

export interface ObjectInteractionToggleRow {
  kind:
    | "exchange"
    | "uniaxial_anisotropy"
    | "cubic_anisotropy"
    | "interfacial_dmi"
    | "bulk_dmi"
    | "magnetoelastic";
  label: string;
  subtitle: string;
  present: boolean;
  enabled: boolean;
  required: boolean;
  writable: boolean;
  disabledReason: string | null;
}

export interface ScopedPhysicsModuleLink {
  id: string;
  kind: string;
  label: string;
  selection: Omit<Selection, "moduleSource">;
}

export interface ObjectPhysicsMatrixDraft {
  objectId: string;
  objectName: string;
  exists: boolean;
  interactions: readonly ObjectInteractionToggleRow[];
  transportAndSpinLinks: readonly ScopedPhysicsModuleLink[];
  demagGlobalEnabled: boolean;
  discretization: InteractionDiscretization;
}

export const ROTATED_DMI_EXCHANGE_ERROR =
  "RotatedInterfacialDmi with open magnetic boundaries requires Exchange for the coupled natural boundary condition";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRevisionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; status?: unknown };
  return (
    candidate.status === 409 &&
    (candidate.code === "revision_conflict" ||
      candidate.code === "scene_revision_conflict" ||
      candidate.code == null)
  );
}

export function asJsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function studyRotatedDmiNumber(
  studyRec: Record<string, unknown> | null,
): number | null {
  const value = studyRec?.rotated_interfacial_dmi;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function activeObjectScopedDmiKind(
  objects: readonly SceneObject[] | undefined,
): "interfacial_dmi" | "bulk_dmi" | null {
  if (!Array.isArray(objects)) return null;
  for (const obj of objects) {
    const role = (obj as Record<string, unknown>).role;
    if (typeof role === "string" && role !== "magnet") continue;
    const stack = (obj as unknown as { physics_stack?: unknown[] }).physics_stack;
    if (!Array.isArray(stack)) continue;
    for (const entry of stack) {
      const rec = asJsonRecord(entry);
      if (!rec) continue;
      const kind = String(rec.kind ?? "").trim().toLowerCase();
      if (
        (kind === "interfacial_dmi" || kind === "bulk_dmi") &&
        rec.enabled !== false
      ) {
        return kind;
      }
    }
  }
  return null;
}

export function findObjectPhysicsStackEntry(
  sceneObj: SceneObject | undefined,
  kind: string,
): Record<string, unknown> | null {
  const stack = (sceneObj as unknown as { physics_stack?: unknown[] } | undefined)
    ?.physics_stack;
  if (!Array.isArray(stack)) return null;
  let lastMatch: Record<string, unknown> | null = null;
  for (const entry of stack) {
    const rec = asJsonRecord(entry);
    if (rec && String(rec.kind ?? "").trim().toLowerCase() === kind) {
      lastMatch = rec;
    }
  }
  return lastMatch;
}

export function readObjectInteractionState(
  sceneObj: SceneObject | undefined,
  matProps: Record<string, unknown>,
  studyRec: Record<string, unknown> | null,
  kind: ObjectInteractionToggleRow["kind"],
): { present: boolean; enabled: boolean } {
  const stackEntry = findObjectPhysicsStackEntry(sceneObj, kind);
  if (kind === "exchange") {
    const stackEnabled = stackEntry
      ? stackEntry.enabled !== false
      : typeof matProps.Aex === "number"
        ? matProps.Aex > 0
        : true;
    return {
      present: true,
      enabled: studyRec?.exchange_enabled === false ? false : stackEnabled,
    };
  }
  if (stackEntry) {
    return {
      present: true,
      enabled: stackEntry.enabled !== false,
    };
  }
  if (kind === "interfacial_dmi") {
    const implicit =
      typeof matProps.Dind === "number" && Math.abs(matProps.Dind) > 0;
    return { present: false, enabled: implicit };
  }
  if (kind === "bulk_dmi") {
    const implicit =
      typeof matProps.Dbulk === "number" && Math.abs(matProps.Dbulk) > 0;
    return { present: false, enabled: implicit };
  }
  return { present: false, enabled: false };
}

export function activeLaneOperationIdForModule(
  kind: string,
): ActiveLaneOperationId | null {
  switch (kind) {
    case "exchange":
      return "interaction.exchange";
    case "demag":
      return "interaction.demag";
    case "zeeman":
      return "interaction.zeeman";
    case "uniaxial_anisotropy":
      return "interaction.uniaxial_anisotropy";
    case "cubic_anisotropy":
      return "interaction.cubic_anisotropy";
    case "interfacial_dmi":
      return "interaction.interfacial_dmi";
    case "bulk_dmi":
      return "interaction.bulk_dmi";
    case "rotated_interfacial_dmi":
      return "interaction.rotated_interfacial_dmi";
    case "magnetoelastic":
      return "interaction.magnetoelastic";
    case "thermal_noise":
      return "interaction.thermal";
    case "current_transport":
      return "interaction.current_transport";
    case "spin_torque":
      return "interaction.spin_torque";
    case "oersted_field":
      return "interaction.oersted_field";
    default:
      return null;
  }
}

export interface ModuleHelpContent {
  title: string;
  description: string;
  scope: string;
  storage: string;
  docsPage?: string;
  fields: readonly {
    id: string;
    label: string;
    unit?: string | null;
    description: string;
  }[];
}

export function buildModuleHelpContent(
  kind: string,
  objectId: string | null,
): ModuleHelpContent {
  const knownSpec: InteractionSpec | undefined = findInteractionSpec(
    kind as PhysicsInteractionId,
    objectId,
  );
  if (knownSpec) {
    return {
      title: knownSpec.label,
      description: knownSpec.description,
      scope:
        knownSpec.scope === "global"
          ? "Global"
          : knownSpec.scope === "global_or_object_or_region"
            ? "Global, object, or region"
            : "Object or region",
      storage:
        knownSpec.storage === "object_interaction"
          ? "Object interaction resource"
          : knownSpec.storage === "study"
            ? "Study transaction"
            : "Planner / backend deferred",
      docsPage: knownSpec.docsPage,
      fields: knownSpec.fields,
    };
  }
  if (kind === "thermal_noise") {
    return {
      title: "Thermal Stochastic Field",
      description:
        "Brownian stochastic thermal fluctuation field governed by the fluctuation-dissipation theorem.",
      scope: "Global",
      storage: "Study transaction (study.thermal_noise)",
      fields: [
        {
          id: "temperature",
          label: "Bath temperature T",
          unit: "K",
          description: "Strictly positive bath temperature in kelvin.",
        },
        {
          id: "seed",
          label: "Deterministic PRNG seed",
          unit: null,
          description:
            "Optional positive decimal u64 seed (without leading zeroes); leave empty for entropy.",
        },
      ],
    };
  }
  if (kind === "periodic_bc") {
    return {
      title: "Periodic Boundary Conditions",
      description:
        "Translational periodic boundary conditions across lattice axes with truncated periodic-image magnetostatics.",
      scope: "Global",
      storage: "Study transaction (study.pbc)",
      fields: [
        {
          id: "axes",
          label: "Periodic axes [x, y, z]",
          unit: null,
          description: "Per-axis boundary condition ('periodic' or 'open').",
        },
        {
          id: "demag",
          label: "Demag periodicity",
          unit: null,
          description:
            "Truncated periodic images ('truncated_images') or open kernel when demag is disabled.",
        },
      ],
    };
  }
  return {
    title: kind,
    description: "Graph-reported physics module.",
    scope: objectId ? "Object" : "Global",
    storage: "Scene graph projection",
    fields: [],
  };
}

export type CanonicalPhysicsModuleKind =
  | "exchange"
  | "demag"
  | "zeeman"
  | "uniaxial_anisotropy"
  | "cubic_anisotropy"
  | "interfacial_dmi"
  | "bulk_dmi"
  | "rotated_interfacial_dmi"
  | "magnetoelastic"
  | "thermal_noise"
  | "periodic_bc";

export interface GraphModuleProvenanceSummary {
  id: string;
  kind: string;
  sourcePath: string;
  activation: string;
  capabilitySummary: string;
  appliesToSummary: string;
  dependsOn: readonly string[];
}

export interface PhysicsModuleDraft {
  moduleId: string;
  rawKind: string;
  moduleKind: CanonicalPhysicsModuleKind | null;
  scopeKind: "global" | "object";
  objectId: string | null;
  objectName: string;
  present: boolean;
  enabled: boolean;
  aex: number;
  hasAssignedMaterial: boolean;
  demagRealization: string;
  zeemanVectorT: readonly [number, number, number];
  ku1: number;
  ku2: number;
  uniaxialAxis: readonly [number, number, number];
  materialMs: number | null;
  kc1: number;
  kc2: number;
  kc3: number;
  cubicAxis1: readonly [number, number, number];
  cubicAxis2: readonly [number, number, number];
  dind: number;
  interfaceNormal: readonly [number, number, number];
  rotatedDmiD: number;
  dbulk: number;
  b1: number;
  b2: number;
  c11: number;
  c12: number;
  c44: number;
  voigtExx: number;
  voigtEyy: number;
  voigtEzz: number;
  voigtEyz: number;
  voigtExz: number;
  voigtExy: number;
  temperatureK: number;
  thermalSeed: string;
  pbcAxes: readonly string[];
  pbcDemag: "truncated_images" | "open";
  pbcImagesX: number;
  pbcImagesY: number;
  pbcImagesZ: number;
  provenance: GraphModuleProvenanceSummary | null;
  missingFromGraph: boolean;
}

export function resolveCanonicalPhysicsModuleKind(
  raw: string | null | undefined,
): CanonicalPhysicsModuleKind | null {
  const k = (raw ?? "").trim().toLowerCase();
  if (!k) return null;
  if (
    k === "exchange" ||
    k === "demag" ||
    k === "zeeman" ||
    k === "uniaxial_anisotropy" ||
    k === "cubic_anisotropy" ||
    k === "interfacial_dmi" ||
    k === "bulk_dmi" ||
    k === "rotated_interfacial_dmi" ||
    k === "magnetoelastic" ||
    k === "thermal_noise" ||
    k === "periodic_bc"
  ) {
    return k;
  }
  if (k === "demagnetization") return "demag";
  if (k === "external_field" || k === "zeeman_field") return "zeeman";
  if (k === "thermal" || k === "brown_noise") return "thermal_noise";
  if (k === "pbc" || k === "physics.pbc") return "periodic_bc";
  return null;
}

export function moduleTitleForKind(
  kind: CanonicalPhysicsModuleKind | null,
  rawKind: string,
): string {
  switch (kind) {
    case "exchange":
      return "Symmetric Exchange";
    case "demag":
      return "Demagnetization Field";
    case "zeeman":
      return "External Zeeman Field";
    case "uniaxial_anisotropy":
      return "Uniaxial Anisotropy";
    case "cubic_anisotropy":
      return "Cubic Anisotropy";
    case "interfacial_dmi":
      return "Interfacial DMI";
    case "bulk_dmi":
      return "Bulk Chiral DMI";
    case "rotated_interfacial_dmi":
      return "Rotated Interfacial DMI";
    case "magnetoelastic":
      return "Magnetoelastic Coupling";
    case "thermal_noise":
      return "Thermal Stochastic Field";
    case "periodic_bc":
      return "Periodic Boundary Conditions";
    case null:
      return rawKind ? `Physics Module (${rawKind})` : "Physics Module";
  }
}

export function formatGraphAppliesTo(mod: PhysicsGraphModuleResource): string {
  const scopes = mod.applies_to;
  if (!scopes || scopes.length === 0) return "Global";
  return scopes
    .map((scope) => {
      switch (scope.kind) {
        case "global":
          return "Global";
        case "object":
          return `Object · ${scope.object_id}`;
        case "region":
          return `Region · ${scope.object_id}:${scope.region_id}`;
        case "interface":
          return `Interface · ${scope.side_a.object_id}:${scope.side_a.region_id ?? "default"} ↔ ${scope.side_b.object_id}:${scope.side_b.region_id ?? "default"}`;
        case "cross_object":
          return `Cross-object · ${scope.object_ids.join(", ")}`;
        case "unresolved":
          return `Unresolved · ${scope.source_path}`;
      }
    })
    .join("; ");
}

export function formatGraphCapability(
  capability: PhysicsGraphModuleResource["capability"],
): string {
  const rec = asJsonRecord(capability);
  if (!rec) return "Declared";
  const status = typeof rec.status === "string" ? rec.status : null;
  const lane = typeof rec.lane === "string" ? rec.lane : null;
  const parts = [status, lane].filter(
    (p): p is string =>
      typeof p === "string" && p.length > 0 && !/unknown|unavailable/i.test(p),
  );
  return parts.length > 0 ? parts.join(" · ") : "Graph verified";
}

export function isRestFetchableInteractionKind(
  kind: CanonicalPhysicsModuleKind | null,
): kind is ObjectInteractionKind {
  return (
    kind === "exchange" ||
    kind === "demag" ||
    kind === "interfacial_dmi" ||
    kind === "uniaxial_anisotropy"
  );
}

export function isRequiredModuleKind(
  kind: CanonicalPhysicsModuleKind | null,
  scopeKind: "global" | "object",
): boolean {
  if (scopeKind === "global") return true;
  return kind === "exchange" || kind === "demag";
}

export interface CouplingSpecDraft {
  couplingId: string;
  exists: boolean;
  enabled: boolean;
  kind: "rkky" | "interlayer_exchange" | "exchange";
  capabilityPolicy: "" | SceneCouplingCapabilityPolicy;
  endpointAKey: string;
  endpointASurfaceSelector: string;
  endpointBKey: string;
  endpointBSurfaceSelector: string;
  jRkky: number;
  j1: number;
  j2: number;
  exchangeMode: "harmonic_mean" | "explicit" | "disabled";
  explicitAex: number;
  hasExchangeScale: boolean;
  exchangeScale: number;
}

export function encodeEndpointKey(
  ep: Record<string, unknown> | null | undefined,
  fallbackObj: string,
): { key: string; surfaceSelector: string } {
  if (!ep) return { key: `object::${fallbackObj}`, surfaceSelector: "+z" };
  const objId =
    typeof ep.object === "string" && ep.object.trim()
      ? ep.object.trim()
      : typeof ep.object_id === "string" && ep.object_id.trim()
        ? ep.object_id.trim()
        : fallbackObj;
  const kind = typeof ep.kind === "string" ? ep.kind.trim() : "";
  const selector = typeof ep.selector === "string" ? ep.selector.trim() : "";
  const regId = typeof ep.region_id === "string" ? ep.region_id.trim() : "";
  if (kind === "surface" || selector) {
    return {
      key: `surface::${objId}`,
      surfaceSelector: selector || "+z",
    };
  }
  if (kind === "region" || regId) {
    return {
      key: `region::${objId}::${regId}`,
      surfaceSelector: "+z",
    };
  }
  return {
    key: `object::${objId}`,
    surfaceSelector: "+z",
  };
}

export function decodeEndpointKey(
  key: string,
  surfaceSelector: string,
): SceneCouplingEndpoint {
  const parts = key.split("::");
  const mode = parts[0] ?? "object";
  const object = parts[1] ?? "";
  if (mode === "surface") {
    return {
      kind: "surface",
      object,
      selector: surfaceSelector.trim() || "+z",
    };
  }
  if (mode === "region" && parts[2]) {
    return {
      kind: "region",
      object,
      region_id: parts[2],
    };
  }
  return { kind: "object", object };
}

export function endpointSignature(key: string, surfaceSelector: string): string {
  return key.startsWith("surface::")
    ? `${key}::${surfaceSelector.trim() || "+z"}`
    : key;
}

export function formatEndpointResolutionStatus(
  status: string | null | undefined,
): string {
  if (!status || status === "resolution_unavailable") {
    return "Pending mesh resolution";
  }
  return status.replace(/_/g, " ");
}

export function formatToleranceMeters(tolerance: number | null | undefined): string {
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance)) {
    return "Default solver tolerance";
  }
  return `${tolerance.toExponential(3)} m`;
}

export function uniqueCouplingId(existingIds: ReadonlySet<string>): string {
  let idx = 1;
  while (existingIds.has(`coupling-${idx}`)) {
    idx += 1;
  }
  return `coupling-${idx}`;
}
