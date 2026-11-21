"use client";

import {
  Atom,
  BookOpen,
  Compass,
  CopyPlus,
  Cpu,
  Magnet,
  Plus,
  Sparkles,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  MODEL_MATERIAL_PATH,
  MODEL_OBJECT_INTERACTION_PATH,
  MODEL_PHYSICS_GRAPH_PATH,
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import type {
  ObjectInteractionKind,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { MaterialLibraryDialog } from "@/kernel/layout/MaterialLibraryDialog";
import { useKernel } from "@/kernel/KernelContext";
import {
  publishCommittedSceneResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
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
    // Pick deterministic orthogonal basis vector when c1 and c2 are collinear
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
    return "Born bulk modulus stability requires C11 + 2·C12 > 0.";
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
  materialName: string;
  pendingNewMaterial: boolean;
  sharedWithObjects: readonly string[];
  // Intrinsic magnetic & LLG
  ms: number;
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
  // Chiral DMI
  dind: number;
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

function buildBaselineMaterialDraft(
  objectId: string,
  fallbackLabel: string,
  scene: SceneResource | null | undefined,
): UnifiedObjectMaterialDraft {
  const sceneObj = scene?.objects?.find((o) => o.id === objectId);
  const role = sceneObj?.role?.trim().toLowerCase() ?? "magnet";
  const isMagneticBody =
    role !== "conductor" && role !== "auxiliary" && role !== "spacer_dielectric" && role !== "antenna";
  const matId = sceneObj?.material_ref?.trim() || null;
  const mat = matId ? scene?.materials?.find((m) => m.id === matId) : undefined;
  const props = (mat?.properties ?? {}) as Record<string, unknown>;

  const sharedWithObjects = matId
    ? (scene?.objects ?? [])
        .filter((o) => o.material_ref === matId)
        .map((o) => o.name?.trim() || o.id)
    : [];

  const uniaxial = readInteractionEntry(sceneObj, "uniaxial_anisotropy");
  const cubic = readInteractionEntry(sceneObj, "cubic_anisotropy");
  const magneto = readInteractionEntry(sceneObj, "magnetoelastic");

  const landeG =
    typeof props.lande_g === "number" && Number.isFinite(props.lande_g) ? props.lande_g : 2.1;
  const gamma =
    typeof props.gamma === "number" && Number.isFinite(props.gamma)
      ? props.gamma
      : landeG * ELECTRON_GAMMA_PER_G;

  const ku1 =
    typeof uniaxial?.params.ku1 === "number"
      ? uniaxial.params.ku1
      : typeof props.Ku1 === "number"
        ? props.Ku1
        : 0;
  const ku2 =
    typeof uniaxial?.params.ku2 === "number"
      ? uniaxial.params.ku2
      : typeof props.Ku2 === "number"
        ? props.Ku2
        : 0;

  const kc1 =
    typeof cubic?.params.kc1 === "number"
      ? cubic.params.kc1
      : typeof props.Kc1 === "number"
        ? props.Kc1
        : 0;
  const kc2 =
    typeof cubic?.params.kc2 === "number"
      ? cubic.params.kc2
      : typeof props.Kc2 === "number"
        ? props.Kc2
        : 0;
  const kc3 =
    typeof cubic?.params.kc3 === "number"
      ? cubic.params.kc3
      : typeof props.Kc3 === "number"
        ? props.Kc3
        : 0;

  return {
    objectId,
    objectName: sceneObj?.name?.trim() || fallbackLabel || objectId || "Object",
    exists: Boolean(sceneObj),
    isMagneticBody,
    materialId: matId,
    materialName: mat?.name?.trim() || matId || "Custom Material",
    pendingNewMaterial: false,
    sharedWithObjects,
    ms: typeof props.Ms === "number" && Number.isFinite(props.Ms) ? props.Ms : isMagneticBody ? 8.0e5 : 0,
    aex: typeof props.Aex === "number" && Number.isFinite(props.Aex) ? props.Aex : isMagneticBody ? 13e-12 : 0,
    alpha: typeof props.alpha === "number" && Number.isFinite(props.alpha) ? props.alpha : 0.008,
    gamma,
    landeG: gamma / ELECTRON_GAMMA_PER_G,
    uniaxialEnabled: Boolean(uniaxial ? uniaxial.enabled : Math.abs(ku1) > 0 || Math.abs(ku2) > 0),
    ku1,
    ku2,
    uniaxialAxis: readVec3(uniaxial?.params.axis, [0, 0, 1]),
    cubicEnabled: Boolean(cubic ? cubic.enabled : Math.abs(kc1) > 0 || Math.abs(kc2) > 0),
    kc1,
    kc2,
    kc3,
    cubicAxis1: readVec3(cubic?.params.axis1 ?? cubic?.params.c1, [1, 0, 0]),
    cubicAxis2: readVec3(cubic?.params.axis2 ?? cubic?.params.c2, [0, 1, 0]),
    dind: typeof props.Dind === "number" && Number.isFinite(props.Dind) ? props.Dind : 0,
    dbulk: typeof props.Dbulk === "number" && Number.isFinite(props.Dbulk) ? props.Dbulk : 0,
    sigma: typeof props.conductivity === "number" ? props.conductivity : 6.25e6,
    density: typeof props.density === "number" ? props.density : 8700,
    magnetoelasticEnabled: Boolean(magneto?.enabled),
    b1: typeof magneto?.params.b1 === "number" ? magneto.params.b1 : -12.5e6,
    b2: typeof magneto?.params.b2 === "number" ? magneto.params.b2 : -4.3e6,
    c11: typeof magneto?.params.c11 === "number" ? magneto.params.c11 : 210e9,
    c12: typeof magneto?.params.c12 === "number" ? magneto.params.c12 : 130e9,
    c44: typeof magneto?.params.c44 === "number" ? magneto.params.c44 : 80e9,
  };
}

/* ── Built-in Reference Library Popover Widget ── */

function ReferenceMaterialPickerPopover({
  ctx,
  onOpenFullCatalog,
}: {
  ctx: InspectorActionContext<UnifiedObjectMaterialDraft>;
  onOpenFullCatalog: () => void;
}) {
  const applyPreset = (preset: BuiltInReferenceMaterial) => {
    const generatedId = `${preset.id}-${ctx.draft.objectId || "obj"}`;
    ctx.patchDraft({
      materialId: generatedId,
      materialName: preset.name,
      pendingNewMaterial: true,
      ms: preset.ms,
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
      dind: preset.dind,
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
                  {preset.ms > 0 ? `${(preset.ms / 1e3).toFixed(0)} kA/m` : `${(preset.sigma / 1e6).toFixed(1)} MS/m`}
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
          const newId = `custom-${ctx.draft.objectId || "mat"}-${Date.now().toString(36)}`;
          ctx.patchDraft({
            materialId: newId,
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
    </div>
  );
}

/* ── Unified ObjectMaterialInspectorPanel (`object.material`) ── */

export function ObjectMaterialInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const [catalogOpen, setCatalogOpen] = useState(false);

  const objectId =
    selection.ref?.type === "scene-object"
      ? selection.ref.objectId
      : selection.objectId ?? "";

  const baseline = useMemo(
    () => buildBaselineMaterialDraft(objectId, selection.label ?? "Object", scene.data),
    [objectId, scene.data, selection.label],
  );

  const sessionMaterials = useMemo(
    () =>
      (scene.data?.materials ?? []).map((mat) => ({
        id: mat.id,
        label: mat.name || mat.id,
        subtitle:
          typeof mat.properties?.Ms === "number"
            ? `Ms = ${(mat.properties.Ms / 1e3).toFixed(0)} kA/m · α = ${mat.properties.alpha}`
            : `α = ${mat.properties?.alpha ?? 0}`,
      })),
    [scene.data?.materials],
  );

  const handleDuplicateAndUnlink = useCallback(
    async (ctx: InspectorActionContext<UnifiedObjectMaterialDraft>) => {
      if (!objectId) return;
      const clonedId = `mat-${objectId}-${Date.now().toString(36)}`;
      const clonedName = `${ctx.draft.materialName} (${ctx.draft.objectName})`;
      const tx = await kernel.api.model.createMaterial(
        clonedId,
        clonedName,
        {
          Ms: ctx.draft.ms,
          Aex: ctx.draft.aex,
          alpha: ctx.draft.alpha,
          Dind: ctx.draft.dind || null,
          Dbulk: ctx.draft.dbulk || null,
        },
        [],
        { baseRevision: scene.data?.revision ?? undefined },
        { assignToObjectId: objectId },
      );
      publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
      ctx.patchDraft({
        materialId: clonedId,
        materialName: clonedName,
        pendingNewMaterial: false,
      });
      ctx.notify("Material duplicated & unlinked", clonedName);
    },
    [kernel.api.model, kernel.resources, objectId, scene.data?.revision],
  );

  const spec = useMemo<InspectorSpec<UnifiedObjectMaterialDraft>>(
    () => ({
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
          !draft.materialId
            ? { tone: "warn", label: "Unassigned" }
            : draft.sharedWithObjects.length > 1
              ? { tone: "info", label: `Shared (${draft.sharedWithObjects.length})` }
              : { tone: "ok", label: "Assigned" },
      },
      facts: (draft): readonly InspectorFact[] => {
        const lex = computeExchangeLengthMeters(draft.ms, draft.aex);
        return [
          {
            id: "bsat",
            label: "\u03bc\u2080Ms",
            value:
              draft.ms > 0 ? `${((MU0_SI * draft.ms) * 1e3).toFixed(0)} mT` : null,
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
        if (draft.sharedWithObjects.length > 1 && !draft.pendingNewMaterial) {
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
        if (!draft.materialId) {
          list.push({
            id: "material-unassigned",
            tone: "info",
            title: "No material bound yet",
            text: "Pick a reference material from the library or click Apply to create and bind a dedicated material.",
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
              allowNone: { label: "Unassigned (create on Apply)" },
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
                d.sharedWithObjects.length > 1 && !d.pendingNewMaterial
                  ? `Shared by ${d.sharedWithObjects.length} objects`
                  : null,
              onDuplicateUnlink: (ctx) => handleDuplicateAndUnlink(ctx),
            },
            {
              key: "materialName",
              type: "text",
              label: "Material display name",
              validate: (v) => (v.trim().length === 0 ? "Material name cannot be empty." : null),
            },
          ],
          footer: (ctx) => (
            <ReferenceMaterialPickerPopover
              ctx={ctx}
              onOpenFullCatalog={() => setCatalogOpen(true)}
            />
          ),
        },

        /* ── Section 2: Intrinsic Magnetic & LLG Constants ── */
        {
          id: "material-intrinsic-llg",
          title: "Intrinsic magnetization, exchange & damping",
          icon: Magnet,
          defaultOpen: true,
          showWhen: (d) => d.isMagneticBody,
          summary: (d) =>
            `Ms = ${(d.ms / 1e3).toFixed(0)} kA/m · Aex = ${(d.aex * 1e12).toFixed(1)} pJ/m · α = ${d.alpha}`,
          rows: [
            {
              key: "ms",
              type: "quantity",
              label: "Saturation magnetization",
              symbol: <>M<sub>s</sub></>,
              symbolInfo: {
                name: "Saturation magnetization",
                definition: "Spontaneous magnetic dipole moment per unit volume.",
                siUnit: "A/m",
                typicalRange: "YIG ≈ 140 kA/m, Permalloy ≈ 800 kA/m, Fe ≈ 1.71 MA/m",
              },
              units: MAGNETIZATION_UNITS,
              defaultDisplayUnit: "kA/m",
              min: 0,
              validate: (v) => (v < 0 ? "Ms must be non-negative." : null),
            },
            {
              type: "readonly",
              label: "Saturation polarization",
              symbol: <>&mu;<sub>0</sub>M<sub>s</sub></>,
              mono: true,
              format: (d) =>
                `${(MU0_SI * d.ms).toFixed(4)} T (${(MU0_SI * d.ms * 1e3).toFixed(1)} mT)`,
            },
            {
              key: "aex",
              type: "quantity",
              label: "Exchange stiffness",
              symbol: <>A<sub>ex</sub></>,
              symbolInfo: {
                name: "Heisenberg exchange stiffness",
                definition: "Continuum symmetric exchange energy constant penalizing spin gradients.",
                siUnit: "J/m",
                typicalRange: "YIG ≈ 3.7 pJ/m, Permalloy ≈ 13 pJ/m, Co ≈ 30 pJ/m",
              },
              units: EXCHANGE_UNITS,
              defaultDisplayUnit: "pJ/m",
              min: 0,
              validate: (v) => (v < 0 ? "Aex must be non-negative." : null),
            },
            {
              type: "readonly",
              label: "Magnetostatic exchange length",
              symbol: <>l<sub>ex</sub></>,
              mono: true,
              format: (d) => {
                const lex = computeExchangeLengthMeters(d.ms, d.aex);
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
                definition: "Dimensionless viscous spin-relaxation rate in the Landau-Lifshitz-Gilbert equation.",
                siUnit: "dimensionless",
                typicalRange: "YIG ≈ 10⁻⁴, CoFeB ≈ 0.004, Permalloy ≈ 0.008",
              },
              min: 0,
              step: 0.001,
              validate: (v) => (v < 0 ? "Gilbert damping α must be non-negative." : null),
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
              validate: (v) => (v > 0 ? null : "Gyromagnetic ratio γ must be positive."),
            },
            {
              key: "landeG",
              type: "number",
              label: "Spectroscopic Landé factor",
              symbol: <>g</>,
              min: 0.1,
              step: 0.01,
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
              Sync γ from Landé g ({(ctx.draft.landeG * ELECTRON_GAMMA_PER_G / (2 * Math.PI * 1e9)).toFixed(2)} GHz/T)
            </Button>
          ),
        },

        /* ── Section 3: Uniaxial Anisotropy (with P0 Ku2 Restoration!) ── */
        {
          id: "material-uniaxial-anisotropy",
          title: "Uniaxial magnetocrystalline anisotropy",
          icon: Compass,
          defaultOpen: true,
          showWhen: (d) => d.isMagneticBody,
          summary: (d) =>
            d.uniaxialEnabled
              ? `Ku1 = ${(d.ku1 / 1e3).toFixed(1)} kJ/m³ · Ku2 = ${(d.ku2 / 1e3).toFixed(1)} kJ/m³`
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
              symbol: <>K<sub>u1</sub></>,
              symbolInfo: {
                name: "First-order uniaxial anisotropy constant",
                definition: "Leading sin²θ magnetocrystalline energy density: E_u = -Ku1 (m·u)² - Ku2 (m·u)⁴.",
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
              symbol: <>K<sub>u2</sub></>,
              symbolInfo: {
                name: "Second-order uniaxial anisotropy constant",
                definition: "Fourth-order sin⁴θ uniaxial term governing easy-cone phases and PMA thermal stability.",
                siUnit: "J/m\u00b3",
                typicalRange: "hcp Co ≈ 150 kJ/m³",
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
            `Kc1 = ${(d.kc1 / 1e3).toFixed(1)} kJ/m³ · Dind = ${(d.dind * 1e3).toFixed(2)} mJ/m²`,
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
              symbol: <>K<sub>c1</sub></>,
              units: ANISOTROPY_UNITS,
              defaultDisplayUnit: "kJ/m\u00b3",
              showWhen: (d) => d.cubicEnabled,
            },
            {
              key: "kc2",
              type: "quantity",
              label: "Second-order cubic constant",
              symbol: <>K<sub>c2</sub></>,
              units: ANISOTROPY_UNITS,
              defaultDisplayUnit: "kJ/m\u00b3",
              showWhen: (d) => d.cubicEnabled,
            },
            {
              key: "kc3",
              type: "quantity",
              label: "Third-order cubic constant",
              symbol: <>K<sub>c3</sub></>,
              units: ANISOTROPY_UNITS,
              defaultDisplayUnit: "kJ/m\u00b3",
              showWhen: (d) => d.cubicEnabled,
            },
            {
              key: "cubicAxis1",
              type: "vector3",
              label: "Crystal axis [100]",
              symbol: <>c&#770;<sub>1</sub></>,
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
              symbol: <>c&#770;<sub>2</sub></>,
              axisPresets: true,
              normalizeAction: true,
              showWhen: (d) => d.cubicEnabled,
              validate: (vec, d) => {
                if (vectorNorm(vec) < 1e-12) return "Crystal axis c2 must be non-zero.";
                const u1 = normalizeVector3(d.cubicAxis1);
                const u2 = normalizeVector3(vec);
                const dot = Math.abs(u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2]);
                return dot > 1e-4
                  ? "Crystal axes c1 and c2 must be mutually orthogonal (c1 · c2 = 0)."
                  : null;
              },
            },
            {
              key: "dind",
              type: "quantity",
              label: "Interfacial DMI constant",
              symbol: <>D<sub>ind</sub></>,
              units: DMI_UNITS,
              defaultDisplayUnit: "mJ/m\u00b2",
            },
            {
              key: "dbulk",
              type: "quantity",
              label: "Bulk DMI constant",
              symbol: <>D<sub>bulk</sub></>,
              units: DMI_UNITS,
              defaultDisplayUnit: "mJ/m\u00b2",
            },
            {
              type: "readonly",
              label: "Chiral helical pitch",
              symbol: <>L<sub>D</sub></>,
              mono: true,
              showWhen: (d) => Math.abs(d.dind) > 1e-9 || Math.abs(d.dbulk) > 1e-9,
              format: (d) => {
                const dEff = Math.max(Math.abs(d.dind), Math.abs(d.dbulk));
                if (dEff <= 0 || d.aex <= 0) return "\u2014";
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
                Orthogonalize c₂ (Gram-Schmidt)
              </Button>
            ) : null,
        },

        /* ── Section 5: Electrical, Mechanical & Magnetoelastic ── */
        {
          id: "material-transport-elastic",
          title: "Electrical, mechanical & magnetoelastic",
          icon: Cpu,
          defaultOpen: !baseline.isMagneticBody,
          summary: (d) => `σ = ${(d.sigma / 1e6).toFixed(2)} MS/m · ρ = ${d.density} kg/m³`,
          rows: [
            {
              key: "sigma",
              type: "quantity",
              label: "Electrical conductivity",
              symbol: <>&sigma;</>,
              units: CONDUCTIVITY_UNITS,
              defaultDisplayUnit: "MS/m",
              min: 0,
            },
            {
              key: "density",
              type: "quantity",
              label: "Mass density",
              symbol: <>&rho;</>,
              units: DENSITY_UNITS,
              defaultDisplayUnit: "kg/m\u00b3",
              min: 0,
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
              symbol: <>B<sub>1</sub></>,
              units: MAGNETOELASTIC_B_UNITS,
              defaultDisplayUnit: "MJ/m\u00b3",
              showWhen: (d) => d.isMagneticBody && d.magnetoelasticEnabled,
            },
            {
              key: "b2",
              type: "quantity",
              label: "Shear coupling constant",
              symbol: <>B<sub>2</sub></>,
              units: MAGNETOELASTIC_B_UNITS,
              defaultDisplayUnit: "MJ/m\u00b3",
              showWhen: (d) => d.isMagneticBody && d.magnetoelasticEnabled,
            },
            {
              key: "c11",
              type: "quantity",
              label: "Cubic stiffness C11",
              symbol: <>C<sub>11</sub></>,
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
              symbol: <>C<sub>12</sub></>,
              units: ELASTIC_MODULUS_UNITS,
              defaultDisplayUnit: "GPa",
              showWhen: (d) => d.isMagneticBody && d.magnetoelasticEnabled,
              validate: (v, d) => validateBornCubicStability(d.c11, v, d.c44),
            },
            {
              key: "c44",
              type: "quantity",
              label: "Shear stiffness C44",
              symbol: <>C<sub>44</sub></>,
              units: ELASTIC_MODULUS_UNITS,
              defaultDisplayUnit: "GPa",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.isMagneticBody && d.magnetoelasticEnabled,
              validate: (v, d) => validateBornCubicStability(d.c11, d.c12, v),
            },
          ],
          footer: (ctx) =>
            ctx.draft.sharedWithObjects.length > 1 ? (
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
        cleanMessage: () => "Material constants & anisotropy match committed SceneDocument",
        lockReason: (d) => (!d.exists ? "Select an existing scene object." : null),
        onApply: async (draft, prev) => {
          if (!objectId) return false;
          let latestRevision = scene.data?.revision ?? null;
          const existingIds = new Set((scene.data?.materials ?? []).map((m) => m.id));
          let resolvedMatId = draft.materialId;

          const propertiesPayload = {
            Ms: draft.ms,
            Aex: draft.aex,
            alpha: draft.alpha,
            Dind: draft.dind !== 0 ? draft.dind : null,
            Dbulk: draft.dbulk !== 0 ? draft.dbulk : null,
          };

          if (!resolvedMatId || draft.pendingNewMaterial || !existingIds.has(resolvedMatId)) {
            resolvedMatId = resolvedMatId || `mat-${objectId}-${Date.now().toString(36)}`;
            const tx = await kernel.api.model.createMaterial(
              resolvedMatId,
              draft.materialName.trim() || `Material (${draft.objectName})`,
              propertiesPayload,
              [],
              { baseRevision: latestRevision ?? undefined },
              { assignToObjectId: objectId },
            );
            latestRevision = tx.scene_revision;
            publishCommittedSceneResource(
              kernel.resources,
              tx.committed_scene,
              tx.scene_revision,
            );
          } else {
            if (resolvedMatId !== prev.materialId) {
              const patchedScene = await kernel.api.model.patchObject(objectId, {
                base_revision: latestRevision,
                material_ref: resolvedMatId,
              });
              latestRevision = patchedScene.revision ?? latestRevision;
              publishCommittedSceneResource(
                kernel.resources,
                patchedScene,
                fallbackRevision(patchedScene.revision),
              );
            }
            const constantsChanged =
              draft.materialName !== prev.materialName ||
              draft.ms !== prev.ms ||
              draft.aex !== prev.aex ||
              draft.alpha !== prev.alpha ||
              draft.dind !== prev.dind ||
              draft.dbulk !== prev.dbulk;
            if (constantsChanged) {
              const tx = await kernel.api.model.patchMaterialAsset(
                resolvedMatId,
                {
                  name: draft.materialName.trim(),
                  properties: {
                    Ms: draft.ms,
                    Aex: draft.aex,
                    alpha: draft.alpha,
                    Dind: draft.dind !== 0 ? draft.dind : null,
                    Dbulk: draft.dbulk !== 0 ? draft.dbulk : null,
                  },
                },
                { baseRevision: latestRevision ?? undefined },
              );
              latestRevision = tx.scene_revision;
              publishCommittedSceneResource(
                kernel.resources,
                tx.committed_scene,
                tx.scene_revision,
              );
            }
          }

          // P0 closure: atomically persist uniaxial anisotropy WITH lossless Ku2!
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
            );
            latestRevision = ack.scene_revision;
          }

          const cubicChanged =
            draft.cubicEnabled !== prev.cubicEnabled ||
            draft.kc1 !== prev.kc1 ||
            draft.kc2 !== prev.kc2 ||
            draft.kc3 !== prev.kc3 ||
            JSON.stringify(draft.cubicAxis1) !== JSON.stringify(prev.cubicAxis1) ||
            JSON.stringify(draft.cubicAxis2) !== JSON.stringify(prev.cubicAxis2);

          if (cubicChanged && draft.isMagneticBody) {
            const ack = await kernel.api.model.patchObjectInteraction(
              objectId,
              "cubic_anisotropy" as unknown as ObjectInteractionKind,
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
                  axis1: normalizeVector3(draft.cubicAxis1, [1, 0, 0]),
                  axis2: normalizeVector3(draft.cubicAxis2, [0, 1, 0]),
                },
              },
            );
            latestRevision = ack.scene_revision;
          }

          const rev = fallbackRevision(latestRevision);
          kernel.resources.invalidate(MODEL_SCENE_PATH, rev);
          kernel.resources.invalidate(MODEL_MATERIAL_PATH, rev);
          kernel.resources.invalidate(MODEL_OBJECT_INTERACTION_PATH, rev);
          kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
          kernel.resources.invalidate(MODEL_READINESS_PATH, rev);
          return true;
        },
      },
    }),
    [
      baseline.exists,
      baseline.isMagneticBody,
      baseline.materialId,
      baseline.objectName,
      handleDuplicateAndUnlink,
      kernel.api.model,
      kernel.resources,
      objectId,
      scene.data?.materials,
      scene.data?.revision,
      sessionMaterials,
    ],
  );

  return (
    <SpecInspectorHost baseline={baseline} selection={selection} spec={spec}>
      <MaterialLibraryDialog open={catalogOpen} onOpenChange={setCatalogOpen} />
    </SpecInspectorHost>
  );
}
