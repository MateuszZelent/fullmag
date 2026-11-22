"use client";

import {
  Atom,
  BookOpen,
  Compass,
  CopyPlus,
  Cpu,
  Database,
  History,
  Magnet,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  MODEL_PHYSICS_GRAPH_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import type {
  AuthoringTransactionResponse,
  JsonObject,
  MaterialPropertiesResource,
  MaterialReferenceResource,
  MaterialResource,
  ObjectInteractionKind,
  SceneMaterialResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import {
  authoringWriteOptions,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { useKernel } from "@/kernel/KernelContext";
import { MaterialLibraryDialog } from "@/kernel/layout/MaterialLibraryDialog";
import {
  publishCommittedSceneResource,
  resolveMaterialResourceKey,
  resolveObjectInteractionResourceKey,
  useMaterialResource,
  useObjectInteractionResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionScopedResourceKey } from "@/kernel/resources/useSessionScopedResourceKey";
import {
  formatMaterialSourceChange,
  type MaterialCatalogSelection,
  materialSourceChanges,
  materialSourceStatus,
} from "@/shared/domain/material/materialLibrary";
import { Button } from "@/shared/ui/Button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/shared/ui/Popover";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorActionContext,
  InspectorFact,
  InspectorNotice,
  InspectorRowSpec,
  InspectorSpec,
} from "../../template";
import {
  ANISOTROPY_UNITS,
  buildObjectSelection,
  buildRootSelection,
  CONDUCTIVITY_UNITS,
  DENSITY_UNITS,
  DMI_UNITS,
  ELASTIC_MODULUS_UNITS,
  ELECTRON_GAMMA_PER_G,
  EXCHANGE_UNITS,
  fallbackRevision,
  GYRO_UNITS,
  MAGNETIZATION_UNITS,
  MAGNETOELASTIC_B_UNITS,
  MU0_SI,
  normalizeVector3,
  type SceneObjectItem as SceneObject,
  SpecInspectorHost,
  vectorNorm,
} from "../model-roots/SpecInspectorHost";
import {
  buildMaterialAssignmentPatch,
  createMaterialAssetThenAssign,
  independentMaterialAsset,
  magneticParameterMaterialResourceFromSceneResource,
  materialAssetFromLibraryEntry,
  MaterialAssignmentAfterCreateError,
  normalizeMaterialRef,
} from "../ObjectMaterialPanelModel";

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
  if (ku1 < 0 && ku2 > 0 && -ku1 < 2 * ku2) {
    const sinTheta = Math.sqrt(Math.max(0, Math.min(1, -ku1 / (2 * ku2))));
    const deg = (Math.asin(sinTheta) * 180) / Math.PI;
    return {
      label: `Easy cone (\u03b8 = ${deg.toFixed(1)}\u00b0)`,
      coneAngleDeg: deg,
    };
  }
  if (ku1 + ku2 > 0 && ku1 >= 0) {
    return { label: "Easy axis", coneAngleDeg: null };
  }
  if (ku1 + 2 * ku2 < 0) {
    return { label: "Easy plane", coneAngleDeg: null };
  }
  return { label: "Bistable / higher-order uniaxial", coneAngleDeg: null };
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
}

interface RevisionConflictState {
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

function suggestNewMaterialId(
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

function buildBaselineMaterialDraft(
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
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return "Material authoring request failed.";
}

function isRevisionConflictError(error: unknown): boolean {
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

function formatReferencesSummary(
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

/* ── Built-in Reference Library Popover Widget ── */

function ReferenceMaterialPickerPopover({
  ctx,
  existingIds,
  hasActiveModelMaterial,
  onOpenFullCatalog,
}: {
  ctx: InspectorActionContext<UnifiedObjectMaterialDraft>;
  existingIds: ReadonlySet<string>;
  hasActiveModelMaterial: boolean;
  onOpenFullCatalog: () => void;
}) {
  const applyPreset = (preset: BuiltInReferenceMaterial) => {
    const generatedId = suggestNewMaterialId(
      `${preset.id}-${ctx.draft.objectId || "obj"}`,
      existingIds,
    );
    const hasPositiveMs = preset.ms > 0;
    ctx.patchDraft({
      materialId: generatedId,
      newMaterialId: generatedId,
      materialName: preset.name,
      pendingNewMaterial: true,
      msSet: hasPositiveMs,
      ms: preset.ms,
      aexSet: hasPositiveMs || preset.aex > 0,
      aex: preset.aex,
      alpha: preset.alpha,
      landeG: preset.landeG,
      gamma: preset.landeG * ELECTRON_GAMMA_PER_G,
      uniaxialEnabled: Math.abs(preset.ku1) > 0 || Math.abs(preset.ku2) > 0,
      ku1: preset.ku1,
      ku2: preset.ku2,
      cubicEnabled: Math.abs(preset.kc1) > 0 || Math.abs(preset.kc2) > 0,
      kc1: preset.kc1,
      kc2: preset.kc2,
      dindSet: preset.dind !== 0,
      dind: preset.dind,
      dbulkSet: preset.dbulk !== 0,
      dbulk: preset.dbulk,
      sigma: preset.sigma,
      density: preset.density,
    });
  };

  return (
    <div className="flex flex-wrap gap-1.5" data-slot="material-assignment-actions">
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" type="button" variant="secondary">
            <Sparkles aria-hidden="true" size={12} />
            <span>Assign from Library</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-2">
          <div className="flex flex-col gap-1" data-slot="reference-materials-popover">
            <p className="px-1.5 py-1 text-xs font-semibold text-[var(--fm-text-muted)]">
              Curated reference standards (9)
            </p>
            {REFERENCE_MATERIALS_CATALOG.map((preset) => (
              <button
                key={preset.id}
                className="flex items-center justify-between rounded px-2 py-1.5 text-left text-xs text-[var(--fm-text)] hover:bg-[var(--fm-surface-3)]"
                data-preset-id={preset.id}
                type="button"
                onClick={() => applyPreset(preset)}
              >
                <span className="font-medium">{preset.name}</span>
                <span className="font-mono text-xs text-[var(--fm-text-muted)]">
                  {preset.ms > 0
                    ? `${(preset.ms / 1e3).toFixed(0)} kA/m`
                    : `${(preset.sigma / 1e6).toFixed(1)} MS/m`}
                </span>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <Button
        size="sm"
        type="button"
        variant="secondary"
        onClick={() => {
          const newId = suggestNewMaterialId(
            `custom-${ctx.draft.objectId || "mat"}`,
            existingIds,
          );
          ctx.patchDraft({
            materialId: newId,
            newMaterialId: newId,
            materialName: `Custom (${ctx.draft.objectName})`,
            pendingNewMaterial: true,
          });
        }}
      >
        <Plus aria-hidden="true" size={12} />
        <span>Create Custom</span>
      </Button>

      <Button size="sm" type="button" variant="ghost" onClick={onOpenFullCatalog}>
        <BookOpen aria-hidden="true" size={12} />
        <span>Open Full Catalog</span>
      </Button>

      {hasActiveModelMaterial ? (
        <Button size="sm" type="button" variant="ghost" onClick={onOpenFullCatalog}>
          <Database aria-hidden="true" size={12} />
          <span>Save copy to database</span>
        </Button>
      ) : null}
    </div>
  );
}

/* ── Unified ObjectMaterialInspectorPanel (`object.material`) ── */

export function ObjectMaterialInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const { sessionIdentity } = useSessionScopedResourceKey(MODEL_SCENE_PATH);
  const sessionScopeKey =
    sessionRequestScopeKey(sessionIdentity) ??
    kernel.commands?.getSessionScopeKey?.() ??
    null;
  const sessionScopeKeyRef = useRef(sessionScopeKey);
  const mountedRef = useRef(true);
  useEffect(() => {
    sessionScopeKeyRef.current = sessionScopeKey;
  }, [sessionScopeKey]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [catalogOpen, setCatalogOpen] = useState(false);
  const [conflictState, setConflictState] = useState<RevisionConflictState | null>(null);

  const objectId =
    selection.ref?.type === "scene-object"
      ? selection.ref.objectId
      : selection.objectId ?? "";

  const sceneObj = useMemo(
    () => scene.data?.objects?.find((o) => o.id === objectId),
    [objectId, scene.data?.objects],
  );
  const activeSceneMatId = normalizeMaterialRef(sceneObj?.material_ref ?? "");
  const role = sceneObj?.role?.trim().toLowerCase() ?? "magnet";
  const isMagneticBody =
    role !== "conductor" &&
    role !== "auxiliary" &&
    role !== "spacer_dielectric" &&
    role !== "antenna";

  const materialResource = useMaterialResource(activeSceneMatId);
  const uniaxialResource = useObjectInteractionResource(
    objectId || null,
    "uniaxial_anisotropy",
    { enabled: Boolean(objectId) && isMagneticBody },
  );

  const resolvedMaterialResource = useMemo<MaterialResource | null>(() => {
    if (!activeSceneMatId) return null;
    const fromScene = scene.data
      ? magneticParameterMaterialResourceFromSceneResource(activeSceneMatId, scene.data)
      : null;
    if (
      materialResource.data &&
      materialResource.data.id === activeSceneMatId &&
      (materialResource.data.scene_revision >= (scene.data?.revision ?? 0) || !fromScene)
    ) {
      return materialResource.data;
    }
    return fromScene ?? materialResource.data ?? null;
  }, [activeSceneMatId, materialResource.data, scene.data]);

  const dialogModelMaterial = useMemo<SceneMaterialResource | undefined>(() => {
    if (!activeSceneMatId) return undefined;
    const rawFromScene = scene.data?.materials?.find((m) => m.id === activeSceneMatId);
    if (resolvedMaterialResource) {
      return {
        id: resolvedMaterialResource.id,
        name: resolvedMaterialResource.name,
        properties: {
          ...(rawFromScene?.properties ?? {}),
          ...resolvedMaterialResource.properties,
        },
        references: resolvedMaterialResource.references ?? rawFromScene?.references,
        source: resolvedMaterialResource.source ?? rawFromScene?.source ?? null,
      };
    }
    return rawFromScene;
  }, [activeSceneMatId, resolvedMaterialResource, scene.data?.materials]);

  const baseline = useMemo(
    () =>
      buildBaselineMaterialDraft(
        objectId,
        selection.label ?? "Object",
        scene.data,
        resolvedMaterialResource,
        uniaxialResource.data
          ? {
              present: uniaxialResource.data.present,
              enabled: uniaxialResource.data.enabled,
              params: (uniaxialResource.data.params ?? {}) as Record<string, unknown>,
              scene_revision: uniaxialResource.data.scene_revision,
            }
          : null,
      ),
    [
      objectId,
      resolvedMaterialResource,
      scene.data,
      selection.label,
      uniaxialResource.data,
    ],
  );

  const existingMaterialIds = useMemo(
    () => new Set((scene.data?.materials ?? []).map((m) => m.id)),
    [scene.data?.materials],
  );

  const sessionMaterials = useMemo(
    () =>
      (scene.data?.materials ?? []).map((mat) => ({
        id: mat.id,
        label: mat.name || mat.id,
        subtitle:
          typeof mat.properties?.Ms === "number"
            ? `Ms = ${(mat.properties.Ms / 1e3).toFixed(0)} kA/m \u00b7 \u03b1 = ${mat.properties.alpha}`
            : `\u03b1 = ${mat.properties?.alpha ?? 0}`,
      })),
    [scene.data?.materials],
  );

  const makeHistoryContext = useCallback(() => {
    const capturedScopeKey = sessionScopeKey;
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();
    return {
      api: kernel.api,
      authoringHistory: kernel.authoringHistory,
      resourceData: scene.data ? { [MODEL_SCENE_PATH]: scene.data } : undefined,
      selection: typeof kernel.selection?.get === "function" ? kernel.selection : undefined,
      sessionScopeKey: capturedScopeKey,
      isCurrentSessionScope: () =>
        mountedRef.current &&
        sessionScopeKeyRef.current === capturedScopeKey &&
        (historyGeneration === undefined ||
          kernel.authoringHistory?.getGeneration?.() === historyGeneration),
    };
  }, [
    kernel.api,
    kernel.authoringHistory,
    kernel.selection,
    scene.data,
    sessionScopeKey,
  ]);

  const handleRefreshAndRebase = useCallback(() => {
    setConflictState(null);
    void scene.refetch?.();
    void materialResource.refetch?.();
    void uniaxialResource.refetch?.();
  }, [materialResource, scene, uniaxialResource]);

  const handleRetryFailedAssignment = useCallback(
    async (ctx: InspectorActionContext<UnifiedObjectMaterialDraft>) => {
      const pending = conflictState?.pendingAssignmentError;
      if (!pending || !objectId) return;
      const createdMaterialId = pending.materialId.trim();
      if (!createdMaterialId) return;
      const createdMaterialName =
        pending.created.committed_scene?.materials
          ?.find((m) => m.id === createdMaterialId)
          ?.name?.trim() || createdMaterialId;
      const historyContext = makeHistoryContext();
      try {
        const patchedScene = await runAuthoringMutationWithHistory(
          historyContext,
          `Assign material ${createdMaterialName}`,
          ({ baseRevision }) =>
            kernel.api.model.patchObject(
              objectId,
              buildMaterialAssignmentPatch(
                { materialRef: createdMaterialId },
                baseRevision ?? scene.data?.revision ?? pending.assignmentBaseRevision,
              ),
              sessionScopeKey ? { sessionScopeKey } : undefined,
            ),
        );
        const rev = fallbackRevision(patchedScene.revision);
        publishCommittedSceneResource(
          kernel.resources,
          patchedScene,
          rev,
          undefined,
          true,
          sessionScopeKey,
        );
        invalidateAuthoringMutationDependents(kernel.resources, "material", rev);
        kernel.resources.invalidate(
          resolveMaterialResourceKey(createdMaterialId),
          rev,
        );
        setConflictState(null);
        ctx.patchDraft({
          materialId: createdMaterialId,
          newMaterialId: createdMaterialId,
          materialName: createdMaterialName,
          pendingNewMaterial: false,
        });
        ctx.notify("Material assignment completed", createdMaterialName);
      } catch (error) {
        if (isRevisionConflictError(error)) {
          setConflictState({
            message: errorMessage(error),
            conflictedRevision: scene.data?.revision ?? null,
            pendingAssignmentError: pending,
          });
          void scene.refetch?.();
        }
      }
    },
    [
      conflictState?.pendingAssignmentError,
      kernel.api.model,
      kernel.resources,
      makeHistoryContext,
      objectId,
      scene,
      sessionScopeKey,
    ],
  );

  const handleDuplicateAndUnlink = useCallback(
    async (ctx: InspectorActionContext<UnifiedObjectMaterialDraft>) => {
      if (!objectId) return;
      const draftProperties = resolveMaterialPropertiesFromDraft(ctx.draft, baseline);
      const baseAsset = resolvedMaterialResource
        ? independentMaterialAsset(resolvedMaterialResource)
        : {
            materialId: suggestNewMaterialId(
              `mat-${objectId}`,
              existingMaterialIds,
            ),
            name: `${ctx.draft.materialName} (${ctx.draft.objectName})`,
            properties: draftProperties,
            references: [] as MaterialReferenceResource[],
            source: null,
          };
      const clonedAsset = {
        ...baseAsset,
        properties: draftProperties,
      };
      const historyContext = makeHistoryContext();
      try {
        const result = await runAuthoringMutationWithHistory(
          historyContext,
          `Duplicate & Unlink ${clonedAsset.name}`,
          async ({ baseRevision }) => {
            const initialRevision = baseRevision ?? scene.data?.revision ?? null;
            let latestScene: SceneResource;
            let latestRevision: number;
            if (ctx.draft.isMagneticBody && initialRevision !== null) {
              const assigned = await createMaterialAssetThenAssign(
                kernel.api,
                objectId,
                clonedAsset,
                initialRevision,
                historyContext.isCurrentSessionScope,
                sessionScopeKey,
              );
              latestScene = assigned.assigned;
              latestRevision = assigned.created.scene_revision;
            } else if (ctx.draft.isMagneticBody) {
              const created = await kernel.api.model.createMaterial(
                clonedAsset.materialId,
                clonedAsset.name,
                clonedAsset.properties,
                clonedAsset.references,
                authoringWriteOptions(initialRevision, sessionScopeKey),
                {
                  ...(clonedAsset.source ? { source: clonedAsset.source } : {}),
                  assignToObjectId: objectId,
                },
              );
              latestScene = created.committed_scene;
              latestRevision = created.scene_revision;
            } else {
              const created = await kernel.api.model.createMaterial(
                clonedAsset.materialId,
                clonedAsset.name,
                clonedAsset.properties,
                clonedAsset.references,
                authoringWriteOptions(initialRevision, sessionScopeKey),
                clonedAsset.source ? { source: clonedAsset.source } : undefined,
              );
              publishCommittedSceneResource(
                kernel.resources,
                created.committed_scene,
                fallbackRevision(created.scene_revision),
                undefined,
                true,
                sessionScopeKey,
              );
              try {
                const patched = await kernel.api.model.patchObject(
                  objectId,
                  buildMaterialAssignmentPatch(
                    { materialRef: clonedAsset.materialId },
                    created.scene_revision,
                  ),
                  sessionScopeKey ? { sessionScopeKey } : undefined,
                );
                latestScene = patched;
                latestRevision = patched.revision ?? created.scene_revision;
              } catch (patchErr) {
                throw new MaterialAssignmentAfterCreateError(
                  objectId,
                  clonedAsset.materialId,
                  created,
                  null,
                  patchErr,
                  sessionScopeKey,
                );
              }
            }

            if (typeof kernel.api.model.commitTransaction === "function") {
              const mergeTx = await kernel.api.model.commitTransaction(
                {
                  base_revision: latestRevision,
                  kind: "merge_patch",
                  merge_patch: buildConstitutiveMergePatch(
                    clonedAsset.materialId,
                    ctx.draft,
                  ),
                },
                sessionScopeKey ? { sessionScopeKey } : undefined,
              );
              latestScene = mergeTx.committed_scene;
              latestRevision = mergeTx.scene_revision;
            }

            return {
              committed_scene: latestScene,
              scene_revision: latestRevision,
            };
          },
        );
        const rev = result.scene_revision;
        publishCommittedSceneResource(
          kernel.resources,
          result.committed_scene,
          rev,
          undefined,
          true,
          sessionScopeKey,
        );
        invalidateAuthoringMutationDependents(kernel.resources, "material", rev);
        kernel.resources.invalidate(
          resolveMaterialResourceKey(clonedAsset.materialId),
          rev,
        );
        if (ctx.draft.materialId) {
          kernel.resources.invalidate(
            resolveMaterialResourceKey(ctx.draft.materialId),
            rev,
          );
        }
        setConflictState(null);
        ctx.patchDraft({
          materialId: clonedAsset.materialId,
          newMaterialId: clonedAsset.materialId,
          materialName: clonedAsset.name,
          pendingNewMaterial: false,
        });
        ctx.notify("Material duplicated & unlinked", clonedAsset.name);
      } catch (error) {
        if (
          isRevisionConflictError(error) ||
          error instanceof MaterialAssignmentAfterCreateError
        ) {
          setConflictState({
            message: errorMessage(error),
            conflictedRevision: scene.data?.revision ?? null,
            pendingAssignmentError:
              error instanceof MaterialAssignmentAfterCreateError ? error : null,
          });
          void scene.refetch?.();
        }
        throw error;
      }
    },
    [
      baseline,
      existingMaterialIds,
      kernel.api,
      kernel.resources,
      makeHistoryContext,
      objectId,
      resolvedMaterialResource,
      scene,
      sessionScopeKey,
    ],
  );

  const handleUseCatalogMaterial = useCallback(
    async (catalogSelection: MaterialCatalogSelection) => {
      if (!objectId) return;
      const asset = materialAssetFromLibraryEntry(catalogSelection);
      const historyContext = makeHistoryContext();
      try {
        const result = await runAuthoringMutationWithHistory(
          historyContext,
          `Use material ${asset.name}`,
          async ({ baseRevision }) => {
            const initialRevision = baseRevision ?? scene.data?.revision ?? null;
            if (isMagneticBody && initialRevision !== null) {
              const assigned = await createMaterialAssetThenAssign(
                kernel.api,
                objectId,
                asset,
                initialRevision,
                historyContext.isCurrentSessionScope,
                sessionScopeKey,
              );
              return {
                committed_scene: assigned.assigned,
                scene_revision: assigned.created.scene_revision,
              };
            }
            if (isMagneticBody) {
              const created = await kernel.api.model.createMaterial(
                asset.materialId,
                asset.name,
                asset.properties,
                asset.references,
                authoringWriteOptions(initialRevision, sessionScopeKey),
                {
                  ...(asset.source ? { source: asset.source } : {}),
                  assignToObjectId: objectId,
                },
              );
              return {
                committed_scene: created.committed_scene,
                scene_revision: created.scene_revision,
              };
            }
            const created = await kernel.api.model.createMaterial(
              asset.materialId,
              asset.name,
              asset.properties,
              asset.references,
              authoringWriteOptions(initialRevision, sessionScopeKey),
              asset.source ? { source: asset.source } : undefined,
            );
            publishCommittedSceneResource(
              kernel.resources,
              created.committed_scene,
              fallbackRevision(created.scene_revision),
              undefined,
              true,
              sessionScopeKey,
            );
            let patched: SceneResource;
            try {
              patched = await kernel.api.model.patchObject(
                objectId,
                buildMaterialAssignmentPatch(
                  { materialRef: asset.materialId },
                  created.scene_revision,
                ),
                sessionScopeKey ? { sessionScopeKey } : undefined,
              );
            } catch (patchErr) {
              throw new MaterialAssignmentAfterCreateError(
                objectId,
                asset.materialId,
                created,
                null,
                patchErr,
                sessionScopeKey,
              );
            }
            return {
              committed_scene: patched,
              scene_revision: patched.revision ?? created.scene_revision,
            };
          },
        );
        const rev = result.scene_revision;
        publishCommittedSceneResource(
          kernel.resources,
          result.committed_scene,
          rev,
          undefined,
          true,
          sessionScopeKey,
        );
        invalidateAuthoringMutationDependents(kernel.resources, "material", rev);
        kernel.resources.invalidate(resolveMaterialResourceKey(asset.materialId), rev);
        if (activeSceneMatId) {
          kernel.resources.invalidate(
            resolveMaterialResourceKey(activeSceneMatId),
            rev,
          );
        }
        setConflictState(null);
      } catch (error) {
        if (
          isRevisionConflictError(error) ||
          error instanceof MaterialAssignmentAfterCreateError
        ) {
          setConflictState({
            message: errorMessage(error),
            conflictedRevision: scene.data?.revision ?? null,
            pendingAssignmentError:
              error instanceof MaterialAssignmentAfterCreateError ? error : null,
          });
          void scene.refetch?.();
        }
        throw error;
      }
    },
    [
      activeSceneMatId,
      isMagneticBody,
      kernel.api,
      kernel.resources,
      makeHistoryContext,
      objectId,
      scene,
      sessionScopeKey,
    ],
  );

  const activeSourceSnapshot = resolvedMaterialResource?.source ?? null;
  const activeReferences = useMemo(
    () => resolvedMaterialResource?.references ?? [],
    [resolvedMaterialResource?.references],
  );

  const spec = useMemo<InspectorSpec<UnifiedObjectMaterialDraft>>(() => {
    const computeChangesForDraft = (d: UnifiedObjectMaterialDraft) => {
      if (!activeSourceSnapshot || !d.materialId || d.pendingNewMaterial) {
        return [];
      }
      return materialSourceChanges(
        resolveMaterialPropertiesFromDraft(d, baseline),
        activeReferences,
        activeSourceSnapshot,
      );
    };

    const sourceChangeRows: InspectorRowSpec<UnifiedObjectMaterialDraft>[] =
      activeSourceSnapshot
        ? [
            {
              type: "readonly",
              label: "Changes from source",
              showWhen: (d) => computeChangesForDraft(d).length > 0,
              format: (d) =>
                computeChangesForDraft(d)
                  .map((change) => formatMaterialSourceChange(change))
                  .join(" \u00b7 "),
            },
          ]
        : [];

    return {
      id: "object.material",
      header: {
        breadcrumbs: [
          {
            id: "objects",
            label: "Objects",
            selection: buildRootSelection("objects.root", "model:objects", "Objects"),
          },
          {
            id: "object",
            label: baseline.objectName,
            selection: buildObjectSelection(objectId, "object.root", baseline.objectName),
          },
          { id: "material", label: "Material" },
        ],
        canFitView: baseline.exists,
        searchable: true,
        primaryHeaderAction: {
          label: "Full Catalog",
          icon: BookOpen,
          onRun: () => setCatalogOpen(true),
        },
      },
      identity: {
        domain: "material",
        icon: Magnet,
        title: (draft) => (draft.materialId ? draft.materialName : "Unassigned Material"),
        renameFieldKey: "materialName",
        kindLabel: "Unified constitutive material",
        entityId: baseline.materialId ?? (objectId || undefined),
        statePill: (draft) =>
          !draft.materialId && !draft.pendingNewMaterial
            ? { tone: "warn", label: "Unassigned" }
            : draft.pendingNewMaterial
              ? { tone: "info", label: "Staged New" }
              : draft.sharedWithObjects.length > 1
                ? { tone: "info", label: `Shared (${draft.sharedWithObjects.length})` }
                : { tone: "ok", label: "Assigned" },
      },
      facts: (draft): readonly InspectorFact[] => {
        const lex =
          draft.msSet && draft.aexSet
            ? computeExchangeLengthMeters(draft.ms, draft.aex)
            : null;
        return [
          {
            id: "bsat",
            label: "\u03bc\u2080Ms",
            value:
              draft.msSet && draft.ms > 0
                ? `${((MU0_SI * draft.ms) * 1e3).toFixed(0)} mT`
                : null,
          },
          {
            id: "lex",
            label: "Exchange l_ex",
            value: lex !== null ? `${(lex * 1e9).toFixed(2)} nm` : null,
            tone: "info",
          },
          {
            id: "alpha",
            label: "Damping \u03b1",
            value: draft.isMagneticBody ? String(Number(draft.alpha.toPrecision(4))) : null,
          },
          {
            id: "ku",
            label: "Anisotropy",
            value: draft.uniaxialEnabled
              ? classifyUniaxialAnisotropyRegime(draft.ku1, draft.ku2).label
              : null,
          },
        ];
      },
      notices: (draft): readonly InspectorNotice<UnifiedObjectMaterialDraft>[] => {
        const list: InspectorNotice<UnifiedObjectMaterialDraft>[] = [];
        if (conflictState) {
          list.push({
            id: "material-revision-conflict",
            tone: "err",
            title: "Scene revision conflict (HTTP 409)",
            text: `${conflictState.message} Refresh and rebase onto the latest scene revision (${scene.data?.revision ?? "current"}) to apply your staged edits safely.`,
            quickFix: conflictState.pendingAssignmentError
              ? {
                  label: "Retry Assignment",
                  onApply: (ctx) => handleRetryFailedAssignment(ctx),
                }
              : {
                  label: "Refresh & Rebase",
                  onApply: () => handleRefreshAndRebase(),
                },
          });
        }
        if (draft.sharedWithObjects.length > 1 && !draft.pendingNewMaterial && draft.materialId) {
          list.push({
            id: "shared-material-guard",
            tone: "warn",
            title: `Shared across ${draft.sharedWithObjects.length} objects`,
            text: `Editing "${draft.materialName}" updates constants on: ${draft.sharedWithObjects.join(", ")}. Duplicate and unlink to isolate this object.`,
            quickFix: {
              label: "Duplicate & Unlink",
              onApply: (ctx) => handleDuplicateAndUnlink(ctx),
            },
          });
        }
        if (!draft.materialId && !draft.pendingNewMaterial) {
          list.push({
            id: "material-unassigned",
            tone: "info",
            title: baseline.materialId ? "Material will be unassigned on Apply" : "No material bound yet",
            text: baseline.materialId
              ? "Click Apply to clear material_ref on this object, or click Create Custom / Assign from Library to create a new material."
              : "Pick a reference material from the library or click Apply to create and bind a dedicated material.",
          });
        }
        return list;
      },
      sections: [
        /* ── Section 1: Assignment & Library ── */
        {
          id: "material-assignment",
          title: "Material assignment & catalog",
          icon: BookOpen,
          defaultOpen: true,
          summary: (d) => (d.materialId ? d.materialName : "Unassigned"),
          rows: [
            {
              key: "materialId",
              type: "reference",
              label: "Assigned session material",
              targetKindLabel: "Material",
              allowNone: { label: "Unassigned" },
              options: (d) => {
                const base = [...sessionMaterials];
                if (d.materialId && !base.some((m) => m.id === d.materialId)) {
                  base.unshift({
                    id: d.materialId,
                    label: d.materialName,
                    subtitle: "Staged custom / library material",
                  });
                }
                return base;
              },
              sharedUsageWarning: (d) =>
                d.sharedWithObjects.length > 1 && !d.pendingNewMaterial && d.materialId
                  ? `Shared by ${d.sharedWithObjects.length} objects`
                  : null,
              onCreateNew: (ctx) => {
                const nextId = suggestNewMaterialId(
                  `custom-${ctx.draft.objectId || "mat"}`,
                  existingMaterialIds,
                );
                ctx.patchDraft({
                  materialId: nextId,
                  newMaterialId: nextId,
                  materialName: `Custom (${ctx.draft.objectName})`,
                  pendingNewMaterial: true,
                });
              },
              onDuplicateUnlink: baseline.materialId
                ? (ctx) => handleDuplicateAndUnlink(ctx)
                : undefined,
            },
            {
              key: "newMaterialId",
              type: "text",
              mono: true,
              label: "New material ID",
              showWhen: (d) =>
                d.pendingNewMaterial || (!d.materialId && !baseline.materialId),
              validate: (v, d) => {
                if (
                  !(d.pendingNewMaterial || (!d.materialId && !baseline.materialId))
                ) {
                  return null;
                }
                const trimmed = v.trim();
                if (!trimmed) {
                  return "New material ID cannot be empty.";
                }
                if (existingMaterialIds.has(trimmed)) {
                  return `Material ID "${trimmed}" already exists in this model.`;
                }
                return null;
              },
            },
            {
              key: "materialName",
              type: "text",
              label: "Material display name",
              showWhen: (d) =>
                Boolean(d.materialId) || d.pendingNewMaterial || !baseline.materialId,
              validate: (v, d) => {
                if (!d.materialId && !d.pendingNewMaterial && baseline.materialId) {
                  return null;
                }
                return v.trim().length === 0 ? "Material name cannot be empty." : null;
              },
            },
          ],
          footer: (ctx) => (
            <div className="flex flex-col gap-2">
              <ReferenceMaterialPickerPopover
                ctx={ctx}
                existingIds={existingMaterialIds}
                hasActiveModelMaterial={Boolean(dialogModelMaterial)}
                onOpenFullCatalog={() => setCatalogOpen(true)}
              />
              {conflictState ? (
                <div
                  className="flex flex-wrap gap-1.5"
                  data-slot="material-conflict-actions"
                >
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={handleRefreshAndRebase}
                  >
                    <RefreshCw aria-hidden="true" size={12} />
                    <span>Refresh &amp; Rebase</span>
                  </Button>
                  {conflictState.pendingAssignmentError ? (
                    <Button
                      size="sm"
                      type="button"
                      variant="primary"
                      onClick={() => void handleRetryFailedAssignment(ctx)}
                    >
                      <span>Retry Assignment</span>
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ),
        },

        /* ── Section 1B: Material Source & Changes from Source Provenance ── */
        {
          id: "material-source",
          title: "Material Source",
          icon: History,
          defaultOpen: true,
          showWhen: (d) =>
            Boolean(
              d.materialId &&
                !d.pendingNewMaterial &&
                (activeSourceSnapshot !== null || activeReferences.length > 0),
            ),
          summary: (d) => {
            if (!activeSourceSnapshot) {
              return `${activeReferences.length} reference(s)`;
            }
            const status = materialSourceStatus(
              resolveMaterialPropertiesFromDraft(d, baseline),
              activeReferences,
              activeSourceSnapshot,
            );
            return status === "modified" ? "Modified in model" : "Unmodified copy";
          },
          rows: [
            {
              type: "readonly",
              label: "Origin",
              showWhen: () => activeSourceSnapshot !== null,
              format: (d) => {
                const status = materialSourceStatus(
                  resolveMaterialPropertiesFromDraft(d, baseline),
                  activeReferences,
                  activeSourceSnapshot,
                );
                return status === "modified" ? "Modified in model" : "Unmodified copy";
              },
            },
            {
              type: "readonly",
              label: "Catalog source",
              showWhen: () => activeSourceSnapshot !== null,
              format: () =>
                activeSourceSnapshot
                  ? `${activeSourceSnapshot.name} \u00b7 revision ${activeSourceSnapshot.catalog_revision}`
                  : "\u2014",
            },
            {
              type: "readonly",
              label: "Catalog entry",
              showWhen: () => activeSourceSnapshot !== null,
              format: () => {
                if (!activeSourceSnapshot) return "\u2014";
                if (activeSourceSnapshot.kind === "builtin") return "Built-in";
                if (activeSourceSnapshot.kind === "modified") return "Modified variant";
                return "Custom";
              },
            },
            {
              type: "readonly",
              label: "Published version",
              mono: true,
              showWhen: () => Boolean(activeSourceSnapshot?.version),
              format: () =>
                activeSourceSnapshot?.version
                  ? `${activeSourceSnapshot.version.family}.${activeSourceSnapshot.version.version}`
                  : "\u2014",
            },
            {
              type: "readonly",
              label: "Source project",
              showWhen: () => Boolean(activeSourceSnapshot?.version?.source_project),
              format: () => activeSourceSnapshot?.version?.source_project ?? "\u2014",
            },
            {
              type: "readonly",
              label: "Literature references",
              showWhen: () => activeReferences.length > 0,
              format: () => formatReferencesSummary(activeReferences),
            },
            ...sourceChangeRows,
          ],
        },

        /* ── Section 2: Intrinsic Magnetic & LLG Constants ── */
        {
          id: "material-intrinsic-llg",
          title: "Intrinsic magnetization, exchange & damping",
          icon: Magnet,
          defaultOpen: true,
          showWhen: (d) => d.isMagneticBody,
          summary: (d) =>
            `${d.msSet ? `Ms = ${(d.ms / 1e3).toFixed(0)} kA/m` : "Ms unset"} \u00b7 ${d.aexSet ? `Aex = ${(d.aex * 1e12).toFixed(1)} pJ/m` : "Aex unset"} \u00b7 \u03b1 = ${d.alpha}`,
          rows: [
            {
              key: "msSet",
              type: "switch",
              label: "Specify saturation magnetization (Ms)",
              structural: true,
            },
            {
              key: "ms",
              type: "quantity",
              label: "Saturation magnetization",
              symbol: (
                <>
                  M<sub>s</sub>
                </>
              ),
              symbolInfo: {
                name: "Saturation magnetization",
                definition: "Spontaneous magnetic dipole moment per unit volume.",
                siUnit: "A/m",
                typicalRange: "YIG \u2248 140 kA/m, Permalloy \u2248 800 kA/m, Fe \u2248 1.71 MA/m",
              },
              units: MAGNETIZATION_UNITS,
              defaultDisplayUnit: "kA/m",
              min: 0,
              showWhen: (d) => d.msSet,
              validate: (v, d) =>
                d.msSet && v <= 0
                  ? "Ms must be positive (> 0 A/m) when specified; turn off Specify Ms to leave unset."
                  : null,
            },
            {
              type: "readonly",
              label: "Saturation polarization",
              symbol: (
                <>
                  &mu;<sub>0</sub>M<sub>s</sub>
                </>
              ),
              mono: true,
              showWhen: (d) => d.msSet,
              format: (d) =>
                `${(MU0_SI * d.ms).toFixed(4)} T (${(MU0_SI * d.ms * 1e3).toFixed(1)} mT)`,
            },
            {
              key: "aexSet",
              type: "switch",
              label: "Specify exchange stiffness (Aex)",
              structural: true,
            },
            {
              key: "aex",
              type: "quantity",
              label: "Exchange stiffness",
              symbol: (
                <>
                  A<sub>ex</sub>
                </>
              ),
              symbolInfo: {
                name: "Heisenberg exchange stiffness",
                definition:
                  "Continuum symmetric exchange energy constant penalizing spin gradients.",
                siUnit: "J/m",
                typicalRange: "YIG \u2248 3.7 pJ/m, Permalloy \u2248 13 pJ/m, Co \u2248 30 pJ/m",
              },
              units: EXCHANGE_UNITS,
              defaultDisplayUnit: "pJ/m",
              min: 0,
              showWhen: (d) => d.aexSet,
              validate: (v, d) =>
                d.aexSet && v < 0 ? "Aex must be non-negative." : null,
            },
            {
              type: "readonly",
              label: "Magnetostatic exchange length",
              symbol: (
                <>
                  l<sub>ex</sub>
                </>
              ),
              mono: true,
              format: (d) => {
                const lex =
                  d.msSet && d.aexSet
                    ? computeExchangeLengthMeters(d.ms, d.aex)
                    : null;
                return lex !== null
                  ? `${(lex * 1e9).toFixed(2)} nm`
                  : "Requires Ms > 0 and Aex > 0";
              },
            },
            {
              key: "alpha",
              type: "number",
              label: "Gilbert damping",
              symbol: <>&alpha;</>,
              symbolInfo: {
                name: "Gilbert damping parameter",
                definition:
                  "Dimensionless viscous spin-relaxation rate in the Landau-Lifshitz-Gilbert equation.",
                siUnit: "dimensionless",
                typicalRange: "YIG \u2248 10\u207b\u2074, CoFeB \u2248 0.004, Permalloy \u2248 0.008",
              },
              min: 0,
              step: 0.001,
              validate: (v) => (v < 0 ? "Gilbert damping \u03b1 must be non-negative." : null),
            },
            {
              key: "gamma",
              type: "quantity",
              label: "Gyromagnetic ratio",
              symbol: <>&gamma;</>,
              units: GYRO_UNITS,
              defaultDisplayUnit: "GHz/T",
              min: 0,
              minExclusive: true,
              validate: (v) => (v > 0 ? null : "Gyromagnetic ratio \u03b3 must be positive."),
            },
            {
              key: "landeG",
              type: "number",
              label: "Spectroscopic Land\u00e9 factor",
              symbol: <>g</>,
              min: 0.1,
              step: 0.01,
              validate: (v) => (v >= 0.1 ? null : "Land\u00e9 factor g must be at least 0.1."),
            },
          ],
          footer: (ctx) => (
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() =>
                ctx.setField("gamma", ctx.draft.landeG * ELECTRON_GAMMA_PER_G)
              }
            >
              Sync &gamma; from Land&eacute; g (
              {(
                (ctx.draft.landeG * ELECTRON_GAMMA_PER_G) /
                (2 * Math.PI * 1e9)
              ).toFixed(2)}{" "}
              GHz/T)
            </Button>
          ),
        },

        /* ── Section 3: Uniaxial Anisotropy (with P0 Ku2 & Bk Readout!) ── */
        {
          id: "material-uniaxial-anisotropy",
          title: "Uniaxial magnetocrystalline anisotropy",
          icon: Compass,
          defaultOpen: true,
          showWhen: (d) => d.isMagneticBody,
          summary: (d) =>
            d.uniaxialEnabled
              ? `Ku1 = ${(d.ku1 / 1e3).toFixed(1)} kJ/m\u00b3 \u00b7 Ku2 = ${(d.ku2 / 1e3).toFixed(1)} kJ/m\u00b3`
              : "Disabled",
          rows: [
            {
              key: "uniaxialEnabled",
              type: "switch",
              label: "Enable uniaxial anisotropy",
              structural: true,
            },
            {
              key: "ku1",
              type: "quantity",
              label: "First-order uniaxial constant",
              symbol: (
                <>
                  K<sub>u1</sub>
                </>
              ),
              symbolInfo: {
                name: "First-order uniaxial anisotropy constant",
                definition:
                  "Leading sin\u00b2\u03b8 magnetocrystalline energy density: E_u = -Ku1 (m\u00b7u)\u00b2 - Ku2 (m\u00b7u)\u2074.",
                siUnit: "J/m\u00b3",
              },
              units: ANISOTROPY_UNITS,
              defaultDisplayUnit: "kJ/m\u00b3",
              showWhen: (d) => d.uniaxialEnabled,
            },
            {
              key: "ku2",
              type: "quantity",
              label: "Second-order uniaxial constant",
              symbol: (
                <>
                  K<sub>u2</sub>
                </>
              ),
              symbolInfo: {
                name: "Second-order uniaxial anisotropy constant",
                definition:
                  "Fourth-order sin\u2074\u03b8 uniaxial term governing easy-cone phases and PMA thermal stability.",
                siUnit: "J/m\u00b3",
                typicalRange: "hcp Co \u2248 150 kJ/m\u00b3",
              },
              units: ANISOTROPY_UNITS,
              defaultDisplayUnit: "kJ/m\u00b3",
              showWhen: (d) => d.uniaxialEnabled,
            },
            {
              key: "uniaxialAxis",
              type: "vector3",
              label: "Uniaxial symmetry axis",
              symbol: <>u&#770;</>,
              axisPresets: true,
              normalizeAction: true,
              showWhen: (d) => d.uniaxialEnabled,
              validate: (vec) =>
                vectorNorm(vec) < 1e-12 ? "Uniaxial symmetry axis must be non-zero." : null,
            },
            {
              type: "readonly",
              label: "Anisotropy field (Bk = 2\u00b7Ku1/Ms)",
              symbol: (
                <>
                  B<sub>k</sub>
                </>
              ),
              mono: true,
              showWhen: (d) => d.uniaxialEnabled,
              format: (d) => formatAnisotropyFieldReadout(d),
            },
            {
              type: "readonly",
              label: "Equilibrium anisotropy regime",
              showWhen: (d) => d.uniaxialEnabled,
              format: (d) => classifyUniaxialAnisotropyRegime(d.ku1, d.ku2).label,
            },
          ],
        },

        /* ── Section 4: Cubic Anisotropy & Chiral DMI ── */
        {
          id: "material-cubic-dmi",
          title: "Cubic anisotropy & chiral DMI",
          icon: Atom,
          defaultOpen: false,
          showWhen: (d) => d.isMagneticBody,
          summary: (d) =>
            `Kc1 = ${(d.kc1 / 1e3).toFixed(1)} kJ/m\u00b3 \u00b7 ${d.dindSet ? `Dind = ${(d.dind * 1e3).toFixed(2)} mJ/m\u00b2` : "Dind unset"}`,
          rows: [
            {
              key: "cubicEnabled",
              type: "switch",
              label: "Enable cubic anisotropy",
              structural: true,
            },
            {
              key: "kc1",
              type: "quantity",
              label: "First-order cubic constant",
              symbol: (
                <>
                  K<sub>c1</sub>
                </>
              ),
              units: ANISOTROPY_UNITS,
              defaultDisplayUnit: "kJ/m\u00b3",
              showWhen: (d) => d.cubicEnabled,
            },
            {
              key: "kc2",
              type: "quantity",
              label: "Second-order cubic constant",
              symbol: (
                <>
                  K<sub>c2</sub>
                </>
              ),
              units: ANISOTROPY_UNITS,
              defaultDisplayUnit: "kJ/m\u00b3",
              showWhen: (d) => d.cubicEnabled,
            },
            {
              key: "kc3",
              type: "quantity",
              label: "Third-order cubic constant",
              symbol: (
                <>
                  K<sub>c3</sub>
                </>
              ),
              units: ANISOTROPY_UNITS,
              defaultDisplayUnit: "kJ/m\u00b3",
              showWhen: (d) => d.cubicEnabled,
            },
            {
              key: "cubicAxis1",
              type: "vector3",
              label: "Crystal axis [100]",
              symbol: (
                <>
                  c&#770;<sub>1</sub>
                </>
              ),
              axisPresets: true,
              normalizeAction: true,
              showWhen: (d) => d.cubicEnabled,
              validate: (vec) =>
                vectorNorm(vec) < 1e-12 ? "Crystal axis c1 must be non-zero." : null,
            },
            {
              key: "cubicAxis2",
              type: "vector3",
              label: "Crystal axis [010]",
              symbol: (
                <>
                  c&#770;<sub>2</sub>
                </>
              ),
              axisPresets: true,
              normalizeAction: true,
              showWhen: (d) => d.cubicEnabled,
              validate: (vec, d) => {
                if (vectorNorm(vec) < 1e-12) return "Crystal axis c2 must be non-zero.";
                const u1 = normalizeVector3(d.cubicAxis1);
                const u2 = normalizeVector3(vec);
                const dot = Math.abs(u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2]);
                return dot > 1e-4
                  ? "Crystal axes c1 and c2 must be mutually orthogonal (c1 \u00b7 c2 = 0)."
                  : null;
              },
            },
            {
              key: "dindSet",
              type: "switch",
              label: "Specify interfacial DMI (Dind)",
              structural: true,
            },
            {
              key: "dind",
              type: "quantity",
              label: "Interfacial DMI constant",
              symbol: (
                <>
                  D<sub>ind</sub>
                </>
              ),
              units: DMI_UNITS,
              defaultDisplayUnit: "mJ/m\u00b2",
            },
            {
              key: "dbulkSet",
              type: "switch",
              label: "Specify bulk DMI (Dbulk)",
              structural: true,
            },
            {
              key: "dbulk",
              type: "quantity",
              label: "Bulk DMI constant",
              symbol: (
                <>
                  D<sub>bulk</sub>
                </>
              ),
              units: DMI_UNITS,
              defaultDisplayUnit: "mJ/m\u00b2",
            },
            {
              type: "readonly",
              label: "Chiral helical pitch",
              symbol: (
                <>
                  L<sub>D</sub>
                </>
              ),
              mono: true,
              showWhen: (d) => Math.abs(d.dind) > 1e-9 || Math.abs(d.dbulk) > 1e-9,
              format: (d) => {
                const dEff = Math.max(Math.abs(d.dind), Math.abs(d.dbulk));
                if (dEff <= 0 || !d.aexSet || d.aex <= 0) return "\u2014";
                const pitchNm = ((4 * Math.PI * d.aex) / dEff) * 1e9;
                return `${pitchNm.toFixed(1)} nm`;
              },
            },
          ],
          footer: (ctx) =>
            ctx.draft.cubicEnabled ? (
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() =>
                  ctx.setField(
                    "cubicAxis2",
                    orthogonalizeAxisGramSchmidt(ctx.draft.cubicAxis1, ctx.draft.cubicAxis2),
                  )
                }
              >
                Orthogonalize c&#8322; (Gram-Schmidt)
              </Button>
            ) : null,
        },

        /* ── Section 5: Electrical, Mechanical & Magnetoelastic ── */
        {
          id: "material-transport-elastic",
          title: "Electrical, mechanical & magnetoelastic",
          icon: Cpu,
          defaultOpen: !baseline.isMagneticBody,
          summary: (d) =>
            `\u03c3 = ${(d.sigma / 1e6).toFixed(2)} MS/m \u00b7 \u03c1 = ${d.density} kg/m\u00b3`,
          rows: [
            {
              key: "sigma",
              type: "quantity",
              label: "Electrical conductivity",
              symbol: <>&sigma;</>,
              units: CONDUCTIVITY_UNITS,
              defaultDisplayUnit: "MS/m",
              min: 0,
              validate: (v) => (v < 0 ? "Conductivity \u03c3 must be non-negative." : null),
            },
            {
              key: "density",
              type: "quantity",
              label: "Mass density",
              symbol: <>&rho;</>,
              units: DENSITY_UNITS,
              defaultDisplayUnit: "kg/m\u00b3",
              min: 0,
              validate: (v) => (v < 0 ? "Mass density \u03c1 must be non-negative." : null),
            },
            {
              key: "magnetoelasticEnabled",
              type: "switch",
              label: "Enable magnetoelastic coupling",
              structural: true,
              showWhen: (d) => d.isMagneticBody,
            },
            {
              key: "b1",
              type: "quantity",
              label: "Longitudinal coupling constant",
              symbol: (
                <>
                  B<sub>1</sub>
                </>
              ),
              units: MAGNETOELASTIC_B_UNITS,
              defaultDisplayUnit: "MJ/m\u00b3",
              showWhen: (d) => d.isMagneticBody && d.magnetoelasticEnabled,
            },
            {
              key: "b2",
              type: "quantity",
              label: "Shear coupling constant",
              symbol: (
                <>
                  B<sub>2</sub>
                </>
              ),
              units: MAGNETOELASTIC_B_UNITS,
              defaultDisplayUnit: "MJ/m\u00b3",
              showWhen: (d) => d.isMagneticBody && d.magnetoelasticEnabled,
            },
            {
              key: "c11",
              type: "quantity",
              label: "Cubic stiffness C11",
              symbol: (
                <>
                  C<sub>11</sub>
                </>
              ),
              units: ELASTIC_MODULUS_UNITS,
              defaultDisplayUnit: "GPa",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.isMagneticBody && d.magnetoelasticEnabled,
              validate: (v, d) => validateBornCubicStability(v, d.c12, d.c44),
            },
            {
              key: "c12",
              type: "quantity",
              label: "Cubic stiffness C12",
              symbol: (
                <>
                  C<sub>12</sub>
                </>
              ),
              units: ELASTIC_MODULUS_UNITS,
              defaultDisplayUnit: "GPa",
              showWhen: (d) => d.isMagneticBody && d.magnetoelasticEnabled,
              validate: (v, d) => validateBornCubicStability(d.c11, v, d.c44),
            },
            {
              key: "c44",
              type: "quantity",
              label: "Shear stiffness C44",
              symbol: (
                <>
                  C<sub>44</sub>
                </>
              ),
              units: ELASTIC_MODULUS_UNITS,
              defaultDisplayUnit: "GPa",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.isMagneticBody && d.magnetoelasticEnabled,
              validate: (v, d) => validateBornCubicStability(d.c11, d.c12, v),
            },
          ],
          footer: (ctx) =>
            ctx.draft.sharedWithObjects.length > 1 && ctx.draft.materialId ? (
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => void handleDuplicateAndUnlink(ctx)}
              >
                <CopyPlus aria-hidden="true" size={12} />
                <span>Duplicate &amp; Unlink Shared Material</span>
              </Button>
            ) : null,
        },
      ],
      commitBar: {
        mode: "staged",
        allowCleanApply: (d, base) =>
          (!base.materialId && !d.materialId) || d.pendingNewMaterial,
        cleanMessage: () => "Material constants & anisotropy match committed SceneDocument",
        lockReason: (d) => (!d.exists ? "Select an existing scene object." : null),
        onApply: async (draft, prev) => {
          if (!objectId) return false;
          const historyContext = makeHistoryContext();
          const requestScopeOptions = sessionScopeKey ? { sessionScopeKey } : undefined;

          try {
            await runAuthoringMutationWithHistory(
              historyContext,
              !draft.materialId && !draft.pendingNewMaterial && prev.materialId
                ? `Unassign material from ${draft.objectName}`
                : `Apply material ${draft.materialName.trim() || draft.objectName}`,
              async ({ baseRevision }) => {
                let latestRevision = baseRevision ?? scene.data?.revision ?? null;
                let latestCommittedScene: SceneResource | null = null;
                let materialTouched = false;
                let interactionTouched = false;
                const invalidatedMaterialIds = new Set<string>();
                if (prev.materialId) {
                  invalidatedMaterialIds.add(prev.materialId);
                }

                const isExplicitUnassign =
                  !draft.materialId && !draft.pendingNewMaterial && Boolean(prev.materialId);

                let resolvedMatId: string | null = draft.materialId;

                if (isExplicitUnassign) {
                  const patchedScene = await kernel.api.model.patchObject(
                    objectId,
                    buildMaterialAssignmentPatch({ materialRef: "" }, latestRevision),
                    requestScopeOptions,
                  );
                  latestRevision = patchedScene.revision ?? latestRevision;
                  latestCommittedScene = patchedScene;
                  materialTouched = true;
                  publishCommittedSceneResource(
                    kernel.resources,
                    patchedScene,
                    fallbackRevision(patchedScene.revision),
                    undefined,
                    true,
                    sessionScopeKey,
                  );
                } else {
                  const propertiesPayload = resolveMaterialPropertiesFromDraft(draft, prev);
                  const shouldCreateNewMaterial =
                    !resolvedMatId ||
                    draft.pendingNewMaterial ||
                    !existingMaterialIds.has(resolvedMatId);

                  if (shouldCreateNewMaterial) {
                    const customId =
                      draft.newMaterialId.trim() ||
                      resolvedMatId?.trim() ||
                      suggestNewMaterialId(
                        `mat-${objectId}`,
                        existingMaterialIds,
                      );
                    resolvedMatId = customId;
                    invalidatedMaterialIds.add(resolvedMatId);
                    const createdName =
                      draft.materialName.trim() || `Material (${draft.objectName})`;

                    if (draft.isMagneticBody) {
                      const tx: AuthoringTransactionResponse =
                        await kernel.api.model.createMaterial(
                          resolvedMatId,
                          createdName,
                          propertiesPayload,
                          [],
                          authoringWriteOptions(latestRevision, sessionScopeKey),
                          { assignToObjectId: objectId },
                        );
                      latestRevision = tx.scene_revision;
                      latestCommittedScene = tx.committed_scene;
                    } else {
                      const tx: AuthoringTransactionResponse =
                        await kernel.api.model.createMaterial(
                          resolvedMatId,
                          createdName,
                          propertiesPayload,
                          [],
                          authoringWriteOptions(latestRevision, sessionScopeKey),
                        );
                      publishCommittedSceneResource(
                        kernel.resources,
                        tx.committed_scene,
                        fallbackRevision(tx.scene_revision),
                        undefined,
                        true,
                        sessionScopeKey,
                      );
                      try {
                        const patchedScene = await kernel.api.model.patchObject(
                          objectId,
                          buildMaterialAssignmentPatch(
                            { materialRef: resolvedMatId },
                            tx.scene_revision,
                          ),
                          requestScopeOptions,
                        );
                        latestRevision = patchedScene.revision ?? tx.scene_revision;
                        latestCommittedScene = patchedScene;
                      } catch (patchErr) {
                        throw new MaterialAssignmentAfterCreateError(
                          objectId,
                          resolvedMatId,
                          tx,
                          null,
                          patchErr,
                          sessionScopeKey,
                        );
                      }
                    }
                    materialTouched = true;
                    publishCommittedSceneResource(
                      kernel.resources,
                      latestCommittedScene,
                      fallbackRevision(latestRevision),
                      undefined,
                      true,
                      sessionScopeKey,
                    );
                  } else if (resolvedMatId) {
                    invalidatedMaterialIds.add(resolvedMatId);
                    if (resolvedMatId !== prev.materialId) {
                      const patchedScene = await kernel.api.model.patchObject(
                        objectId,
                        buildMaterialAssignmentPatch(
                          { materialRef: resolvedMatId },
                          latestRevision,
                        ),
                        requestScopeOptions,
                      );
                      latestRevision = patchedScene.revision ?? latestRevision;
                      latestCommittedScene = patchedScene;
                      materialTouched = true;
                      publishCommittedSceneResource(
                        kernel.resources,
                        patchedScene,
                        fallbackRevision(patchedScene.revision),
                        undefined,
                        true,
                        sessionScopeKey,
                      );
                    }

                    const prevProperties = resolveMaterialPropertiesFromDraft(prev, prev);
                    const constantsChanged =
                      draft.materialName !== prev.materialName ||
                      propertiesPayload.Ms !== prevProperties.Ms ||
                      propertiesPayload.Aex !== prevProperties.Aex ||
                      propertiesPayload.alpha !== prevProperties.alpha ||
                      propertiesPayload.Dind !== prevProperties.Dind ||
                      propertiesPayload.Dbulk !== prevProperties.Dbulk;

                    if (constantsChanged) {
                      const tx = await kernel.api.model.patchMaterialAsset(
                        resolvedMatId,
                        {
                          name: draft.materialName.trim(),
                          properties: propertiesPayload,
                        },
                        authoringWriteOptions(latestRevision, sessionScopeKey),
                      );
                      latestRevision = tx.scene_revision;
                      latestCommittedScene = tx.committed_scene;
                      materialTouched = true;
                      publishCommittedSceneResource(
                        kernel.resources,
                        tx.committed_scene,
                        tx.scene_revision,
                        undefined,
                        true,
                        sessionScopeKey,
                      );
                    }
                  }

                  const constitutiveChanged =
                    draft.gamma !== prev.gamma ||
                    draft.landeG !== prev.landeG ||
                    draft.sigma !== prev.sigma ||
                    draft.density !== prev.density ||
                    draft.magnetoelasticEnabled !== prev.magnetoelasticEnabled ||
                    draft.b1 !== prev.b1 ||
                    draft.b2 !== prev.b2 ||
                    draft.c11 !== prev.c11 ||
                    draft.c12 !== prev.c12 ||
                    draft.c44 !== prev.c44;

                  if (
                    (constitutiveChanged ||
                      (shouldCreateNewMaterial && draft.magnetoelasticEnabled)) &&
                    typeof kernel.api.model.commitTransaction === "function"
                  ) {
                    const constitutiveKey = resolvedMatId ?? objectId;
                    const mergePatch = buildConstitutiveMergePatch(
                      constitutiveKey,
                      draft,
                      scene.data?.current_transports,
                      draft.sigma !== prev.sigma,
                    );
                    const mergeTx = await kernel.api.model.commitTransaction(
                      {
                        ...(latestRevision !== null ? { base_revision: latestRevision } : {}),
                        kind: "merge_patch",
                        merge_patch: mergePatch,
                      },
                      requestScopeOptions,
                    );
                    latestRevision = mergeTx.scene_revision;
                    latestCommittedScene = mergeTx.committed_scene;
                    materialTouched = true;
                    publishCommittedSceneResource(
                      kernel.resources,
                      mergeTx.committed_scene,
                      mergeTx.scene_revision,
                      undefined,
                      true,
                      sessionScopeKey,
                    );
                  }
                }

                // Atomically persist uniaxial anisotropy WITH lossless Ku2!
                const uniaxialChanged =
                  draft.uniaxialEnabled !== prev.uniaxialEnabled ||
                  draft.ku1 !== prev.ku1 ||
                  draft.ku2 !== prev.ku2 ||
                  JSON.stringify(draft.uniaxialAxis) !== JSON.stringify(prev.uniaxialAxis);

                if (uniaxialChanged && draft.isMagneticBody) {
                  const payload = buildUniaxialInteractionPayload(draft);
                  const ack = await kernel.api.model.patchObjectInteraction(
                    objectId,
                    "uniaxial_anisotropy",
                    {
                      base_revision: latestRevision,
                      enabled: payload.enabled,
                      present: payload.present,
                      params: payload.params,
                    },
                    requestScopeOptions,
                  );
                  latestRevision = ack.scene_revision;
                  interactionTouched = true;
                  kernel.resources.invalidate(
                    resolveObjectInteractionResourceKey(objectId, "uniaxial_anisotropy"),
                    fallbackRevision(latestRevision),
                  );
                }

                const cubicChanged =
                  draft.cubicEnabled !== prev.cubicEnabled ||
                  draft.kc1 !== prev.kc1 ||
                  draft.kc2 !== prev.kc2 ||
                  draft.kc3 !== prev.kc3 ||
                  JSON.stringify(draft.cubicAxis1) !== JSON.stringify(prev.cubicAxis1) ||
                  JSON.stringify(draft.cubicAxis2) !== JSON.stringify(prev.cubicAxis2);

                if (cubicChanged && draft.isMagneticBody) {
                  const axis1 = normalizeVector3(draft.cubicAxis1, [1, 0, 0]);
                  const axis2 = orthogonalizeAxisGramSchmidt(axis1, draft.cubicAxis2);
                  const cubicKind = "cubic_anisotropy" as unknown as ObjectInteractionKind;
                  const ack = await kernel.api.model.patchObjectInteraction(
                    objectId,
                    cubicKind,
                    {
                      base_revision: latestRevision,
                      enabled: draft.cubicEnabled,
                      present:
                        draft.cubicEnabled ||
                        Math.abs(draft.kc1) > 0 ||
                        Math.abs(draft.kc2) > 0 ||
                        Math.abs(draft.kc3) > 0,
                      params: {
                        kc1: draft.kc1,
                        kc2: draft.kc2,
                        kc3: draft.kc3,
                        axis1,
                        axis2,
                      },
                    },
                    requestScopeOptions,
                  );
                  latestRevision = ack.scene_revision;
                  interactionTouched = true;
                  const cubicResourceKey = resolveObjectInteractionResourceKey(
                    objectId,
                    "uniaxial_anisotropy",
                  ).replace("uniaxial_anisotropy", "cubic_anisotropy");
                  kernel.resources.invalidate(
                    cubicResourceKey,
                    fallbackRevision(latestRevision),
                  );
                }

                const rev = fallbackRevision(latestRevision);
                if (materialTouched) {
                  invalidateAuthoringMutationDependents(
                    kernel.resources,
                    "material",
                    rev,
                  );
                  for (const matId of invalidatedMaterialIds) {
                    kernel.resources.invalidate(resolveMaterialResourceKey(matId), rev);
                  }
                }
                if (interactionTouched) {
                  invalidateAuthoringMutationDependents(
                    kernel.resources,
                    "interaction",
                    rev,
                  );
                }
                if (materialTouched || interactionTouched) {
                  kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
                }

                return {
                  committed_scene: latestCommittedScene,
                  scene_revision: latestRevision,
                };
              },
            );
            setConflictState(null);
            return true;
          } catch (error) {
            if (
              isRevisionConflictError(error) ||
              error instanceof MaterialAssignmentAfterCreateError
            ) {
              setConflictState({
                message: errorMessage(error),
                conflictedRevision: scene.data?.revision ?? null,
                pendingAssignmentError:
                  error instanceof MaterialAssignmentAfterCreateError ? error : null,
              });
              void scene.refetch?.();
            }
            throw error;
          }
        },
      },
    };
  }, [
    activeReferences,
    activeSourceSnapshot,
    baseline,
    conflictState,
    dialogModelMaterial,
    existingMaterialIds,
    handleDuplicateAndUnlink,
    handleRefreshAndRebase,
    handleRetryFailedAssignment,
    kernel.api.model,
    kernel.resources,
    makeHistoryContext,
    objectId,
    scene,
    sessionMaterials,
    sessionScopeKey,
  ]);

  return (
    <SpecInspectorHost baseline={baseline} selection={selection} spec={spec}>
      <MaterialLibraryDialog
        modelMaterial={dialogModelMaterial}
        open={catalogOpen}
        onOpenChange={setCatalogOpen}
        onUseMaterial={
          objectId && baseline.exists ? handleUseCatalogMaterial : undefined
        }
      />
    </SpecInspectorHost>
  );
}
