import type {
  JsonObject,
  MaterialPropertiesResource,
  MaterialReferenceResource,
  MaterialResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";

import {
  ELECTRON_GAMMA_PER_G,
  MU0_SI,
  normalizeVector3,
  type SceneObjectItem as SceneObject,
  vectorNorm,
} from "../../../panels/model-roots/SpecInspectorHost";
import {
  MaterialAssignmentAfterCreateError,
  normalizeMaterialRef,
} from "../../../panels/ObjectMaterialPanelModel";

/* ── Curated 9-Material Built-In Reference Catalog (Volume III §3.2) ── */

export interface BuiltInReferenceMaterial {
  readonly id: string;
  readonly name: string;
  readonly category: "Ferromagnets & Ferrimagnets" | "Non-magnetic Conductors";
  readonly ms: number;
  readonly aex: number;
  readonly alpha: number;
  readonly landeG: number;
  readonly ku1: number;
  readonly ku2: number;
  readonly kc1: number;
  readonly kc2: number;
  readonly dind: number;
  readonly dbulk: number;
  readonly sigma: number;
  readonly density: number;
}

export const REFERENCE_MATERIALS_CATALOG: readonly BuiltInReferenceMaterial[] = [
  {
    id: "preset-permalloy",
    name: "Permalloy (Ni80Fe20)",
    category: "Ferromagnets & Ferrimagnets",
    ms: 8.0e5,
    aex: 13e-12,
    alpha: 0.008,
    landeG: 2.1,
    ku1: 0,
    ku2: 0,
    kc1: 0,
    kc2: 0,
    dind: 0,
    dbulk: 0,
    sigma: 6.25e6,
    density: 8700,
  },
  {
    id: "preset-cofeb",
    name: "CoFeB (Co20Fe60B20)",
    category: "Ferromagnets & Ferrimagnets",
    ms: 1.15e6,
    aex: 19e-12,
    alpha: 0.004,
    landeG: 2.09,
    ku1: 8.5e5,
    ku2: 0,
    kc1: 0,
    kc2: 0,
    dind: 0,
    dbulk: 0,
    sigma: 0.8e6,
    density: 8200,
  },
  {
    id: "preset-yig",
    name: "YIG (Y3Fe5O12)",
    category: "Ferromagnets & Ferrimagnets",
    ms: 1.4e5,
    aex: 3.7e-12,
    alpha: 0.0001,
    landeG: 2.0,
    ku1: 0,
    ku2: 0,
    kc1: -610,
    kc2: 0,
    dind: 0,
    dbulk: 0,
    sigma: 0,
    density: 5170,
  },
  {
    id: "preset-iron",
    name: "Iron (bcc Fe)",
    category: "Ferromagnets & Ferrimagnets",
    ms: 1.71e6,
    aex: 21e-12,
    alpha: 0.002,
    landeG: 2.09,
    ku1: 0,
    ku2: 0,
    kc1: 4.8e4,
    kc2: 5.0e3,
    dind: 0,
    dbulk: 0,
    sigma: 1.0e7,
    density: 7874,
  },
  {
    id: "preset-cobalt",
    name: "Cobalt (hcp Co)",
    category: "Ferromagnets & Ferrimagnets",
    ms: 1.42e6,
    aex: 30e-12,
    alpha: 0.01,
    landeG: 2.18,
    ku1: 4.5e5,
    ku2: 1.5e5,
    kc1: 0,
    kc2: 0,
    dind: 0,
    dbulk: 0,
    sigma: 1.6e7,
    density: 8900,
  },
  {
    id: "preset-nickel",
    name: "Nickel (fcc Ni)",
    category: "Ferromagnets & Ferrimagnets",
    ms: 4.84e5,
    aex: 8.6e-12,
    alpha: 0.025,
    landeG: 2.21,
    ku1: 0,
    ku2: 0,
    kc1: -5.7e3,
    kc2: -2.3e3,
    dind: 0,
    dbulk: 0,
    sigma: 1.43e7,
    density: 8908,
  },
  {
    id: "preset-platinum",
    name: "Platinum (Pt)",
    category: "Non-magnetic Conductors",
    ms: 0,
    aex: 0,
    alpha: 0,
    landeG: 2.0,
    ku1: 0,
    ku2: 0,
    kc1: 0,
    kc2: 0,
    dind: 0,
    dbulk: 0,
    sigma: 9.4e6,
    density: 21450,
  },
  {
    id: "preset-beta-tantalum",
    name: "\u03b2-Tantalum (\u03b2-Ta)",
    category: "Non-magnetic Conductors",
    ms: 0,
    aex: 0,
    alpha: 0,
    landeG: 2.0,
    ku1: 0,
    ku2: 0,
    kc1: 0,
    kc2: 0,
    dind: 0,
    dbulk: 0,
    sigma: 0.53e6,
    density: 16690,
  },
  {
    id: "preset-copper",
    name: "Copper (Cu)",
    category: "Non-magnetic Conductors",
    ms: 0,
    aex: 0,
    alpha: 0,
    landeG: 2.0,
    ku1: 0,
    ku2: 0,
    kc1: 0,
    kc2: 0,
    dind: 0,
    dbulk: 0,
    sigma: 5.96e7,
    density: 8960,
  },
];

/* ── Pure Physics & Validation Helpers (Exported for Unit Tests) ── */

export function computeExchangeLengthMeters(ms: number, aex: number): number | null {
  if (!Number.isFinite(ms) || !Number.isFinite(aex) || ms <= 0 || aex <= 0) {
    return null;
  }
  return Math.sqrt((2 * aex) / (MU0_SI * ms * ms));
}

export function computeAnisotropyFieldTesla(
  ms: number | null | undefined,
  ku1: number,
): number | null {
  if (
    typeof ms !== "number" ||
    !Number.isFinite(ms) ||
    ms <= 0 ||
    !Number.isFinite(ku1)
  ) {
    return null;
  }
  return (2 * ku1) / ms;
}

export function formatAnisotropyFieldReadout(draft: {
  uniaxialEnabled: boolean;
  msSet: boolean;
  ms: number;
  ku1: number;
}): string {
  const bkTesla = draft.msSet ? computeAnisotropyFieldTesla(draft.ms, draft.ku1) : null;
  if (bkTesla === null) {
    return "Requires active Ms > 0";
  }
  return `${Number(bkTesla.toPrecision(4))} T (${(bkTesla * 1e3).toFixed(1)} mT)`;
}

export function classifyUniaxialAnisotropyRegime(
  ku1: number,
  ku2: number,
): { label: string; coneAngleDeg: number | null } {
  if (!Number.isFinite(ku1) || !Number.isFinite(ku2)) {
    return { label: "Isotropic", coneAngleDeg: null };
  }
  if (Math.abs(ku1) < 1e-12 && Math.abs(ku2) < 1e-12) {
    return { label: "Isotropic (Ku1 = Ku2 = 0)", coneAngleDeg: null };
  }
  // Cosine convention (docs/physics/fem_anisotropy_uniaxial.md):
  // E(θ) = -Ku1 cos²θ - Ku2 cos⁴θ = -Ku1 c² - Ku2 c⁴, c = m·u ∈ [0, 1].
  // Stationary point: dE/d(c²) = -Ku1 - 2 Ku2 c² = 0 => c² = -Ku1 / (2 Ku2),
  // local minimum requires d²E/d(c²)² = -2 Ku2 > 0 <=> Ku2 < 0.
  if (ku2 < 0) {
    const cosSq = -ku1 / (2 * ku2);
    if (cosSq > 0 && cosSq < 1) {
      const deg = (Math.acos(Math.sqrt(cosSq)) * 180) / Math.PI;
      return {
        label: `Easy cone (\u03b8 = ${deg.toFixed(1)}\u00b0)`,
        coneAngleDeg: deg,
      };
    }
  }
  // Compare boundary energies E(c²=0) = 0 vs E(c²=1) = -(Ku1 + Ku2).
  const boundarySum = ku1 + ku2;
  if (boundarySum > 1e-12) {
    return { label: "Easy axis", coneAngleDeg: null };
  }
  if (boundarySum < -1e-12) {
    return { label: "Easy plane", coneAngleDeg: null };
  }
  return { label: "Degenerate (Ku1 + Ku2 = 0)", coneAngleDeg: null };
}

export function buildUniaxialInteractionPayload(draft: {
  uniaxialEnabled: boolean;
  ku1: number;
  ku2: number;
  uniaxialAxis: readonly [number, number, number];
}): {
  enabled: boolean;
  present: boolean;
  params: { ku1: number; ku2: number; axis: [number, number, number] };
} {
  const axis = normalizeVector3(draft.uniaxialAxis, [0, 0, 1]);
  const hasNonZeroConstants = Math.abs(draft.ku1) > 0 || Math.abs(draft.ku2) > 0;
  return {
    enabled: draft.uniaxialEnabled,
    present: draft.uniaxialEnabled || hasNonZeroConstants,
    params: {
      ku1: draft.ku1,
      ku2: draft.ku2,
      axis,
    },
  };
}

export function orthogonalizeAxisGramSchmidt(
  c1: readonly [number, number, number],
  c2: readonly [number, number, number],
): [number, number, number] {
  const u1 = normalizeVector3(c1, [1, 0, 0]);
  const dot = c2[0] * u1[0] + c2[1] * u1[1] + c2[2] * u1[2];
  const proj: [number, number, number] = [
    c2[0] - dot * u1[0],
    c2[1] - dot * u1[1],
    c2[2] - dot * u1[2],
  ];
  if (vectorNorm(proj) < 1e-9) {
    const candidate: [number, number, number] =
      Math.abs(u1[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const altDot =
      candidate[0] * u1[0] + candidate[1] * u1[1] + candidate[2] * u1[2];
    return normalizeVector3([
      candidate[0] - altDot * u1[0],
      candidate[1] - altDot * u1[1],
      candidate[2] - altDot * u1[2],
    ]);
  }
  return normalizeVector3(proj, [0, 1, 0]);
}

export function validateBornCubicStability(
  c11: number,
  c12: number,
  c44: number,
): string | null {
  if (!Number.isFinite(c11) || c11 <= 0) {
    return "Born stability requires C11 > 0.";
  }
  if (!Number.isFinite(c44) || c44 <= 0) {
    return "Born stability requires shear modulus C44 > 0.";
  }
  if (!Number.isFinite(c12) || c11 - c12 <= 0) {
    return "Born tetragonal shear stability requires C11 - C12 > 0.";
  }
  if (c11 + 2 * c12 <= 0) {
    return "Born bulk modulus stability requires C11 + 2\u00b7C12 > 0.";
  }
  return null;
}

/* ── Unified Material Draft Model ── */

export interface UnifiedObjectMaterialDraft {
  objectId: string;
  objectName: string;
  exists: boolean;
  isMagneticBody: boolean;
  materialId: string | null;
  newMaterialId: string;
  materialName: string;
  pendingNewMaterial: boolean;
  sharedWithObjects: readonly string[];
  // Intrinsic magnetic & LLG (with nullable presence flags)
  msSet: boolean;
  ms: number;
  aexSet: boolean;
  aex: number;
  alpha: number;
  gamma: number;
  landeG: number;
  // Uniaxial anisotropy (with P0 Ku2!)
  uniaxialEnabled: boolean;
  ku1: number;
  ku2: number;
  uniaxialAxis: readonly [number, number, number];
  // Cubic anisotropy
  cubicEnabled: boolean;
  kc1: number;
  kc2: number;
  kc3: number;
  cubicAxis1: readonly [number, number, number];
  cubicAxis2: readonly [number, number, number];
  // Chiral DMI (with explicit 0 vs unset null presence flags)
  dindSet: boolean;
  dind: number;
  dbulkSet: boolean;
  dbulk: number;
  // Electrical, mechanical & magnetoelastic
  sigma: number;
  density: number;
  magnetoelasticEnabled: boolean;
  b1: number;
  b2: number;
  c11: number;
  c12: number;
  c44: number;
  // Explicit opt-in physics module activation on Apply (default false, ADR 0086)
  activateRequiredPhysics: boolean;
}

export interface RevisionConflictState {
  readonly message: string;
  readonly conflictedRevision: number | null;
  readonly pendingAssignmentError: MaterialAssignmentAfterCreateError | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstFiniteNumber(
  candidates: readonly unknown[],
  predicate?: (n: number) => boolean,
): number | null {
  for (const candidate of candidates) {
    const n = finiteNumberOrNull(candidate);
    if (n !== null && (!predicate || predicate(n))) {
      return n;
    }
  }
  return null;
}

function resolveOptionalParam(
  value: number,
  prevValue: number,
  isSet: boolean,
  wasSet: boolean,
): number | null {
  if (!isSet && wasSet) return null;
  if (isSet) return value;
  if (value !== prevValue) return value;
  return null;
}

export function resolveMaterialPropertiesFromDraft(
  draft: Pick<
    UnifiedObjectMaterialDraft,
    "msSet" | "ms" | "aexSet" | "aex" | "alpha" | "dindSet" | "dind" | "dbulkSet" | "dbulk"
  >,
  prev?: Pick<
    UnifiedObjectMaterialDraft,
    "msSet" | "ms" | "aexSet" | "aex" | "alpha" | "dindSet" | "dind" | "dbulkSet" | "dbulk"
  >,
): MaterialPropertiesResource {
  const rawMs = resolveOptionalParam(
    draft.ms,
    prev?.ms ?? draft.ms,
    draft.msSet,
    prev?.msSet ?? draft.msSet,
  );
  const rawAex = resolveOptionalParam(
    draft.aex,
    prev?.aex ?? draft.aex,
    draft.aexSet,
    prev?.aexSet ?? draft.aexSet,
  );
  const rawDind = resolveOptionalParam(
    draft.dind,
    prev?.dind ?? draft.dind,
    draft.dindSet,
    prev?.dindSet ?? draft.dindSet,
  );
  const rawDbulk = resolveOptionalParam(
    draft.dbulk,
    prev?.dbulk ?? draft.dbulk,
    draft.dbulkSet,
    prev?.dbulkSet ?? draft.dbulkSet,
  );
  return {
    Ms: rawMs !== null && rawMs > 0 ? rawMs : null,
    Aex: rawAex !== null && rawAex >= 0 ? rawAex : null,
    alpha: draft.alpha,
    Dind: rawDind,
    Dbulk: rawDbulk,
  };
}

export function buildConstitutiveMergePatch(
  constitutiveKey: string,
  draft: Pick<
    UnifiedObjectMaterialDraft,
    | "objectId"
    | "isMagneticBody"
    | "gamma"
    | "landeG"
    | "sigma"
    | "density"
    | "magnetoelasticEnabled"
    | "b1"
    | "b2"
    | "c11"
    | "c12"
    | "c44"
  >,
  currentTransports?: SceneResource["current_transports"],
  syncTransportSigma = false,
): JsonObject {
  let updatedCurrentTransports: SceneResource["current_transports"] | undefined;
  if (
    syncTransportSigma &&
    Array.isArray(currentTransports) &&
    currentTransports.length > 0 &&
    draft.objectId
  ) {
    let touched = false;
    const mapped = currentTransports.map((entry) => {
      const rec = asRecord(entry);
      const mats = Array.isArray(rec?.materials) ? rec.materials : null;
      if (!rec || !mats) return entry;
      let entryTouched = false;
      const nextMats = mats.map((assignment) => {
        const assignRec = asRecord(assignment);
        const regionRec = asRecord(assignRec?.region);
        const matRec = asRecord(assignRec?.material);
        if (
          regionRec?.object_id === draft.objectId &&
          !regionRec.region_id &&
          matRec &&
          typeof matRec.sigma_Spm === "number"
        ) {
          entryTouched = true;
          touched = true;
          return {
            ...assignRec,
            material: {
              ...matRec,
              sigma_Spm: draft.sigma,
            },
          };
        }
        return assignment;
      });
      return entryTouched ? ({ ...rec, materials: nextMats } as typeof entry) : entry;
    });
    if (touched) {
      updatedCurrentTransports = mapped;
    }
  }

  return {
    study: {
      ...(draft.isMagneticBody && Number.isFinite(draft.gamma) && draft.gamma > 0
        ? { solver: { gamma: String(draft.gamma) } }
        : {}),
      visualization_hint: {
        material_constitutive: {
          [constitutiveKey]: {
            gamma: draft.gamma,
            lande_g: draft.landeG,
            conductivity: draft.sigma,
            density: draft.density,
            magnetoelastic: {
              enabled: draft.magnetoelasticEnabled,
              b1: draft.b1,
              b2: draft.b2,
              c11: draft.c11,
              c12: draft.c12,
              c44: draft.c44,
            },
          },
        },
      },
    },
    ...(updatedCurrentTransports ? { current_transports: updatedCurrentTransports } : {}),
  } as unknown as JsonObject;
}

function readInteractionEntry(
  sceneObj: SceneObject | undefined,
  kind: string,
): { enabled: boolean; params: Record<string, unknown> } | null {
  const stack = (sceneObj as unknown as { physics_stack?: unknown[] } | undefined)?.physics_stack;
  if (!Array.isArray(stack)) return null;
  let matched: Record<string, unknown> | null = null;
  for (const raw of stack) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    if (String(rec.kind ?? "").trim().toLowerCase() === kind) {
      matched = rec;
    }
  }
  if (!matched) return null;
  const params =
    matched.params && typeof matched.params === "object" && !Array.isArray(matched.params)
      ? (matched.params as Record<string, unknown>)
      : matched;
  return {
    enabled: matched.enabled !== false,
    params,
  };
}

function readVec3(
  value: unknown,
  fallback: readonly [number, number, number],
): [number, number, number] {
  if (
    Array.isArray(value) &&
    value.length >= 3 &&
    value.every((c) => typeof c === "number" && Number.isFinite(c))
  ) {
    return [value[0] as number, value[1] as number, value[2] as number];
  }
  return [fallback[0], fallback[1], fallback[2]];
}

export function suggestNewMaterialId(
  seedName: string,
  existingIds: ReadonlySet<string>,
): string {
  const slug = seedName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const base = `mat:${slug || "custom-material"}`;
  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function readCurrentTransportSigma(
  scene: SceneResource | null | undefined,
  objectId: string,
): number | null {
  if (!objectId || !Array.isArray(scene?.current_transports)) return null;
  for (const entry of scene.current_transports) {
    const rec = asRecord(entry);
    if (!rec) continue;
    if (Array.isArray(rec.materials)) {
      for (const assignment of rec.materials) {
        const assignRec = asRecord(assignment);
        const regionRec = asRecord(assignRec?.region);
        const matRec = asRecord(assignRec?.material);
        if (regionRec?.object_id === objectId && !regionRec.region_id) {
          const sigma = finiteNumberOrNull(matRec?.sigma_Spm);
          if (sigma !== null && sigma >= 0) return sigma;
        }
      }
    }
    if (Array.isArray(rec.domain)) {
      const matchesDomain = rec.domain.some((d) => asRecord(d)?.object_id === objectId);
      const cond = finiteNumberOrNull(rec.conductivity_s_per_m);
      if (matchesDomain && cond !== null && cond >= 0) return cond;
    }
  }
  return null;
}

function readSpinTorqueLandeG(
  scene: SceneResource | null | undefined,
  objectId: string,
): number | null {
  if (!objectId || !Array.isArray(scene?.spin_torques)) return null;
  for (const entry of scene.spin_torques) {
    const rec = asRecord(entry);
    const targetRec = asRecord(rec?.target);
    if (targetRec?.object_id === objectId) {
      const g = finiteNumberOrNull(rec?.lande_g);
      if (g !== null && g > 0) return g;
    }
  }
  return null;
}

export function buildBaselineMaterialDraft(
  objectId: string,
  fallbackLabel: string,
  scene: SceneResource | null | undefined,
  authoritativeMaterial?: MaterialResource | null,
  authoritativeUniaxial?: {
    present: boolean;
    enabled: boolean;
    params: Record<string, unknown>;
    scene_revision: number;
  } | null,
): UnifiedObjectMaterialDraft {
  const sceneObj = scene?.objects?.find((o) => o.id === objectId);
  const role = sceneObj?.role?.trim().toLowerCase() ?? "magnet";
  const isMagneticBody =
    role !== "conductor" &&
    role !== "auxiliary" &&
    role !== "spacer_dielectric" &&
    role !== "antenna";
  const matId = normalizeMaterialRef(sceneObj?.material_ref ?? "");
  const sceneMat = matId ? scene?.materials?.find((m) => m.id === matId) : undefined;
  const sceneRevision = scene?.revision ?? 0;
  const preferAuthoritativeMat =
    Boolean(authoritativeMaterial) &&
    authoritativeMaterial?.id === matId &&
    (authoritativeMaterial.scene_revision >= sceneRevision || !sceneMat);
  const sceneProps = (sceneMat?.properties ?? {}) as Record<string, unknown>;
  const authProps = preferAuthoritativeMat
    ? (authoritativeMaterial?.properties as unknown as Record<string, unknown>)
    : null;
  const props: Record<string, unknown> = authProps
    ? { ...sceneProps, ...authProps }
    : sceneProps;

  const existingIds = new Set((scene?.materials ?? []).map((m) => m.id));
  const objectDisplayName = sceneObj?.name?.trim() || fallbackLabel || objectId || "Object";
  const defaultNewId = suggestNewMaterialId(objectDisplayName, existingIds);

  const sharedWithObjects = matId
    ? (scene?.objects ?? [])
        .filter((o) => normalizeMaterialRef(o.material_ref ?? "") === matId)
        .map((o) => o.name?.trim() || o.id)
    : [];

  const stackUniaxial = readInteractionEntry(sceneObj, "uniaxial_anisotropy");
  const useAuthUniaxial =
    Boolean(authoritativeUniaxial) &&
    ((authoritativeUniaxial?.scene_revision ?? 0) >= sceneRevision || !stackUniaxial) &&
    (authoritativeUniaxial?.present || !stackUniaxial);
  const uniaxial = useAuthUniaxial && authoritativeUniaxial
    ? authoritativeUniaxial.present
      ? {
          enabled: authoritativeUniaxial.enabled,
          params: authoritativeUniaxial.params,
        }
      : null
    : stackUniaxial;
  const cubic = readInteractionEntry(sceneObj, "cubic_anisotropy");
  const stackMagneto = readInteractionEntry(sceneObj, "magnetoelastic");

  const studyRec = asRecord(scene?.study);
  const constitutiveMap = asRecord(asRecord(studyRec?.visualization_hint)?.material_constitutive);
  const matConstitutive =
    (matId ? asRecord(constitutiveMap?.[matId]) : null) ??
    (objectId ? asRecord(constitutiveMap?.[objectId]) : null) ??
    asRecord(asRecord(sceneObj?.visualization_hint)?.material_constitutive);
  const matMagneto = asRecord(matConstitutive?.magnetoelastic) ?? asRecord(props.magnetoelastic);

  const solverGammaStr = asRecord(studyRec?.solver)?.gamma;
  const parsedSolverGamma =
    typeof solverGammaStr === "string" && solverGammaStr.trim().length > 0
      ? Number(solverGammaStr)
      : Number.NaN;
  const solverGamma =
    Number.isFinite(parsedSolverGamma) && parsedSolverGamma > 0 ? parsedSolverGamma : null;
  const transportSigma = readCurrentTransportSigma(scene, objectId);
  const torqueLandeG = readSpinTorqueLandeG(scene, objectId);

  const explicitLandeG = firstFiniteNumber(
    [matConstitutive?.lande_g, props.lande_g, torqueLandeG],
    (n) => n > 0,
  );
  const explicitGamma = firstFiniteNumber(
    [matConstitutive?.gamma, props.gamma, solverGamma],
    (n) => n > 0,
  );
  const gamma = explicitGamma ?? (explicitLandeG ?? 2.1) * ELECTRON_GAMMA_PER_G;
  const landeG = explicitLandeG ?? gamma / ELECTRON_GAMMA_PER_G;

  const sigma =
    firstFiniteNumber(
      [
        matConstitutive?.conductivity,
        matConstitutive?.sigma,
        props.conductivity,
        props.sigma,
        transportSigma,
      ],
      (n) => n >= 0,
    ) ?? 6.25e6;

  const density =
    firstFiniteNumber([matConstitutive?.density, props.density], (n) => n >= 0) ?? 8700;

  const magnetoelasticEnabled =
    typeof matMagneto?.enabled === "boolean"
      ? matMagneto.enabled
      : typeof props.magnetoelastic_enabled === "boolean"
        ? props.magnetoelastic_enabled
        : Boolean(stackMagneto?.enabled);

  const b1 = firstFiniteNumber([matMagneto?.b1, props.b1, stackMagneto?.params.b1]) ?? -12.5e6;
  const b2 = firstFiniteNumber([matMagneto?.b2, props.b2, stackMagneto?.params.b2]) ?? -4.3e6;
  const c11 =
    firstFiniteNumber([matMagneto?.c11, props.c11, stackMagneto?.params.c11], (n) => n > 0) ??
    210e9;
  const c12 = firstFiniteNumber([matMagneto?.c12, props.c12, stackMagneto?.params.c12]) ?? 130e9;
  const c44 =
    firstFiniteNumber([matMagneto?.c44, props.c44, stackMagneto?.params.c44], (n) => n > 0) ??
    80e9;

  const ku1 = firstFiniteNumber([uniaxial?.params.ku1, props.Ku1]) ?? 0;
  const ku2 = firstFiniteNumber([uniaxial?.params.ku2, props.Ku2]) ?? 0;
  const kc1 = firstFiniteNumber([cubic?.params.kc1, props.Kc1]) ?? 0;
  const kc2 = firstFiniteNumber([cubic?.params.kc2, props.Kc2]) ?? 0;
  const kc3 = firstFiniteNumber([cubic?.params.kc3, props.Kc3]) ?? 0;

  const hasAssignedMaterial = Boolean(sceneMat || (preferAuthoritativeMat && authoritativeMaterial));
  const explicitMs = finiteNumberOrNull(props.Ms);
  const explicitAex = finiteNumberOrNull(props.Aex);
  const explicitDind = finiteNumberOrNull(props.Dind);
  const explicitDbulk = finiteNumberOrNull(props.Dbulk);

  const msSet = hasAssignedMaterial ? explicitMs !== null && explicitMs > 0 : isMagneticBody;
  const aexSet = hasAssignedMaterial ? explicitAex !== null && explicitAex >= 0 : isMagneticBody;
  const dindSet = explicitDind !== null;
  const dbulkSet = explicitDbulk !== null;

  const resolvedMatName =
    (preferAuthoritativeMat ? authoritativeMaterial?.name : undefined)?.trim() ||
    sceneMat?.name?.trim() ||
    matId ||
    `Material (${objectDisplayName})`;

  return {
    objectId,
    objectName: objectDisplayName,
    exists: Boolean(sceneObj),
    isMagneticBody,
    materialId: matId,
    newMaterialId: defaultNewId,
    materialName: resolvedMatName,
    pendingNewMaterial: false,
    sharedWithObjects,
    msSet,
    ms: explicitMs !== null && explicitMs > 0 ? explicitMs : isMagneticBody ? 8.0e5 : 0,
    aexSet,
    aex: explicitAex !== null && explicitAex >= 0 ? explicitAex : isMagneticBody ? 13e-12 : 0,
    alpha: finiteNumberOrNull(props.alpha) ?? 0.008,
    gamma,
    landeG,
    uniaxialEnabled: Boolean(
      uniaxial ? uniaxial.enabled : Math.abs(ku1) > 0 || Math.abs(ku2) > 0,
    ),
    ku1,
    ku2,
    uniaxialAxis: readVec3(uniaxial?.params.axis, [0, 0, 1]),
    cubicEnabled: Boolean(cubic ? cubic.enabled : Math.abs(kc1) > 0 || Math.abs(kc2) > 0),
    kc1,
    kc2,
    kc3,
    cubicAxis1: readVec3(cubic?.params.axis1 ?? cubic?.params.c1, [1, 0, 0]),
    cubicAxis2: readVec3(cubic?.params.axis2 ?? cubic?.params.c2, [0, 1, 0]),
    dindSet,
    dind: explicitDind ?? 0,
    dbulkSet,
    dbulk: explicitDbulk ?? 0,
    sigma,
    density,
    magnetoelasticEnabled,
    b1,
    b2,
    c11,
    c12,
    c44,
    activateRequiredPhysics: false,
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return "Material authoring request failed.";
}

export function isRevisionConflictError(error: unknown): boolean {
  if (error instanceof MaterialAssignmentAfterCreateError) {
    return isRevisionConflictError(error.cause);
  }
  if (error instanceof ControlRoomApiError && error.status === 409) {
    return true;
  }
  if (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { status?: unknown }).status === 409
  ) {
    return true;
  }
  return /revision_conflict|revision mismatch|\b409\b/i.test(errorMessage(error));
}

export function formatReferencesSummary(
  references: readonly MaterialReferenceResource[] | null | undefined,
): string {
  if (!references || references.length === 0) return "None";
  return references
    .map((ref) =>
      [ref.label, ref.citation, ref.url]
        .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
        .join(" \u2014 ") || "Reference",
    )
    .join("; ");
}
