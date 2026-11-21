"use client";

import {
  Activity,
  ArrowRight,
  Atom,
  BookOpen,
  Compass,
  Link2,
  Plus,
  Sliders,
  Thermometer,
  Zap,
} from "lucide-react";
import { createElement, useCallback, useMemo } from "react";

import {
  MODEL_COUPLINGS_PATH,
  MODEL_OBJECT_INTERACTION_PATH,
  MODEL_PHYSICS_GRAPH_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
} from "@/kernel/api/apiPaths";
import type {
  AuthoringTransactionRequest,
  JsonObject,
  ObjectInteractionKind,
} from "@/kernel/api/apiTypes";

type SceneCoupling = Extract<AuthoringTransactionRequest, { kind: "create_coupling" }>["coupling"];
type SceneCouplingPatch = Extract<AuthoringTransactionRequest, { kind: "patch_coupling" }>["patch"];
type SceneCouplingEndpoint = SceneCoupling["source"];
type SceneCouplingParameters = SceneCoupling["parameters"];
import { useKernel } from "@/kernel/KernelContext";
import {
  publishCommittedSceneResource,
  useModelCouplingsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { usePhysicsGraphResource } from "@/kernel/resources/physicsGraphResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorFact,
  InspectorNotice,
  InspectorSpec,
} from "../../template";
import { orthogonalizeAxisGramSchmidt, validateBornCubicStability } from "../material/ObjectMaterialSpec";
import {
  ANISOTROPY_UNITS,
  buildObjectSelection,
  buildRootSelection,
  DMI_UNITS,
  ELASTIC_MODULUS_UNITS,
  EXCHANGE_UNITS,
  fallbackRevision,
  FIELD_TESLA_UNITS,
  InspectorShortcutCards,
  INTERLAYER_UNITS,
  MAGNETOELASTIC_B_UNITS,
  normalizeVector3,
  type SceneObjectItem as SceneObject,
  SpecInspectorHost,
  TEMPERATURE_UNITS,
  vectorNorm,
} from "../model-roots/SpecInspectorHost";

/* ── 1. ObjectPhysicsInspectorPanel (`object.physics` + redirected `object.physics.scope`) ── */

interface ObjectInteractionToggleRow {
  kind:
    | "exchange"
    | "uniaxial_anisotropy"
    | "cubic_anisotropy"
    | "interfacial_dmi"
    | "bulk_dmi"
    | "magnetoelastic";
  label: string;
  subtitle: string;
  enabled: boolean;
}

interface ScopedModuleLink {
  id: string;
  kind: string;
  label: string;
  selection: Omit<Selection, "moduleSource">;
}

interface ObjectPhysicsMatrixDraft {
  objectId: string;
  objectName: string;
  exists: boolean;
  interactions: readonly ObjectInteractionToggleRow[];
  transportAndSpinLinks: readonly ScopedModuleLink[];
  demagGlobalEnabled: boolean;
}

function readObjectInteractionEnabled(
  sceneObj: SceneObject | undefined,
  matProps: Record<string, unknown>,
  studyRec: Record<string, unknown> | null,
  kind: ObjectInteractionToggleRow["kind"],
): boolean {
  if (kind === "exchange" && studyRec?.exchange_enabled === false) {
    return false;
  }
  const stack = (sceneObj as unknown as { physics_stack?: unknown[] } | undefined)?.physics_stack;
  if (Array.isArray(stack)) {
    let lastMatch: Record<string, unknown> | null = null;
    for (const entry of stack) {
      if (entry && typeof entry === "object") {
        const rec = entry as Record<string, unknown>;
        if (String(rec.kind ?? "").trim().toLowerCase() === kind) {
          lastMatch = rec;
        }
      }
    }
    if (lastMatch) {
      return lastMatch.enabled !== false;
    }
  }
  if (kind === "exchange") {
    return typeof matProps.Aex === "number" ? matProps.Aex > 0 : true;
  }
  if (kind === "interfacial_dmi") {
    return typeof matProps.Dind === "number" && Math.abs(matProps.Dind) > 0;
  }
  if (kind === "bulk_dmi") {
    return typeof matProps.Dbulk === "number" && Math.abs(matProps.Dbulk) > 0;
  }
  return false;
}

export function ObjectPhysicsInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const physicsGraph = usePhysicsGraphResource();

  const objectId =
    selection.ref?.type === "scene-object"
      ? selection.ref.objectId
      : selection.objectId ?? "";

  const sceneObj = useMemo(
    () => scene.data?.objects?.find((o) => o.id === objectId),
    [objectId, scene.data?.objects],
  );
  const matProps = useMemo(() => {
    const ref = sceneObj?.material_ref;
    const mat = ref ? scene.data?.materials?.find((m) => m.id === ref) : undefined;
    return (mat?.properties ?? {}) as Record<string, unknown>;
  }, [scene.data?.materials, sceneObj?.material_ref]);

  const studyRec = (scene.data?.study ?? null) as Record<string, unknown> | null;

  const interactions = useMemo<readonly ObjectInteractionToggleRow[]>(
    () => [
      {
        kind: "exchange",
        label: "Symmetric exchange",
        subtitle: "Heisenberg continuum stiffness Aex (∇m)²",
        enabled: readObjectInteractionEnabled(sceneObj, matProps, studyRec, "exchange"),
      },
      {
        kind: "uniaxial_anisotropy",
        label: "Uniaxial anisotropy",
        subtitle: "Ku1 sin²θ + Ku2 sin⁴θ along easy/cone axis û",
        enabled: readObjectInteractionEnabled(
          sceneObj,
          matProps,
          studyRec,
          "uniaxial_anisotropy",
        ),
      },
      {
        kind: "cubic_anisotropy",
        label: "Cubic anisotropy",
        subtitle: "Kc1, Kc2, Kc3 along orthogonal crystal axes (ĉ1, ĉ2)",
        enabled: readObjectInteractionEnabled(sceneObj, matProps, studyRec, "cubic_anisotropy"),
      },
      {
        kind: "interfacial_dmi",
        label: "Interfacial DMI",
        subtitle: "Néel-type chiral exchange Dind with interface normal n̂",
        enabled: readObjectInteractionEnabled(sceneObj, matProps, studyRec, "interfacial_dmi"),
      },
      {
        kind: "bulk_dmi",
        label: "Bulk DMI",
        subtitle: "Bloch-type B20 chiral exchange Dbulk (m · ∇ × m)",
        enabled: readObjectInteractionEnabled(sceneObj, matProps, studyRec, "bulk_dmi"),
      },
      {
        kind: "magnetoelastic",
        label: "Magnetoelastic coupling",
        subtitle: "Villari / magnetostrictive coupling B1, B2 & stiffness Cij",
        enabled: readObjectInteractionEnabled(sceneObj, matProps, studyRec, "magnetoelastic"),
      },
    ],
    [matProps, sceneObj, studyRec],
  );

  const transportAndSpinLinks = useMemo<readonly ScopedModuleLink[]>(() => {
    const g = (physicsGraph.data ?? null) as Record<string, unknown> | null;
    const mods = Array.isArray(g?.modules) ? (g.modules as Record<string, unknown>[]) : [];
    const links: ScopedModuleLink[] = [];
    for (const mod of mods) {
      const kind = String(mod.kind ?? "");
      if (
        kind !== "current_transport" &&
        kind !== "spin_transport" &&
        kind !== "spin_torque" &&
        kind !== "oersted_field"
      ) {
        continue;
      }
      const scopes = Array.isArray(mod.applies_to)
        ? (mod.applies_to as Record<string, unknown>[])
        : [];
      const targetsObject = scopes.some((s) => s.object_id === objectId);
      if (!targetsObject) continue;
      const id = String(mod.id ?? "");
      const label = String(mod.label ?? mod.name ?? id);
      const nodeId = `model:object:${objectId}:physics:module:${encodeURIComponent(id)}`;
      const selectionKind =
        kind === "current_transport"
          ? ("physics.current-transport" as const)
          : kind === "spin_transport"
            ? ("physics.spin-transport" as const)
            : kind === "spin_torque"
              ? ("physics.spin-torque" as const)
              : ("physics.oersted-field" as const);
      links.push({
        id,
        kind,
        label,
        selection: {
          kind: selectionKind,
          label,
          nodeId,
          objectId,
          ref: null,
        },
      });
    }
    return links;
  }, [objectId, physicsGraph.data]);

  const baseline = useMemo<ObjectPhysicsMatrixDraft>(
    () => ({
      objectId,
      objectName: sceneObj?.name?.trim() || objectId || "Object",
      exists: Boolean(sceneObj),
      interactions,
      transportAndSpinLinks,
      demagGlobalEnabled: studyRec?.demag_enabled !== false,
    }),
    [interactions, objectId, sceneObj, studyRec?.demag_enabled, transportAndSpinLinks],
  );

  const handleToggleInteraction = useCallback(
    async (kind: ObjectInteractionToggleRow["kind"], enabled: boolean) => {
      if (!objectId) return;
      const ack = await kernel.api.model.patchObjectInteraction(
        objectId,
        kind as unknown as ObjectInteractionKind,
        {
          base_revision: scene.data?.revision ?? null,
          enabled,
          present: true,
          params: {},
        },
      );
      kernel.resources.invalidate(MODEL_SCENE_PATH, ack.scene_revision);
      kernel.resources.invalidate(MODEL_OBJECT_INTERACTION_PATH, ack.scene_revision);
      kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, ack.scene_revision);
    },
    [kernel.api.model, kernel.resources, objectId, scene.data?.revision],
  );

  const spec = useMemo<InspectorSpec<ObjectPhysicsMatrixDraft>>(
    () => ({
      id: "object.physics",
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
          { id: "physics", label: "Physics" },
        ],
        searchable: false,
      },
      identity: {
        domain: "physics",
        icon: Activity,
        title: (d) => `${d.objectName} · Physics`,
        kindLabel: "Object Hamiltonian & spintronics matrix",
        entityId: objectId ? `${objectId}:physics` : undefined,
        statePill: (d) => ({
          tone: "ok",
          label: `${d.interactions.filter((i) => i.enabled).length} active`,
        }),
      },
      facts: (d): readonly InspectorFact[] => [
        {
          id: "local",
          label: "Local terms",
          value: `${d.interactions.filter((i) => i.enabled).length} of ${d.interactions.length}`,
        },
        {
          id: "spintronics",
          label: "Transport / torque",
          value: String(d.transportAndSpinLinks.length),
        },
        {
          id: "demag",
          label: "Demag (global)",
          value: d.demagGlobalEnabled ? "Active" : "Off",
          tone: d.demagGlobalEnabled ? "ok" : undefined,
        },
      ],
      sections: [
        {
          id: "object-physics-interactions",
          title: "Local Hamiltonian interactions",
          icon: Sliders,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-col gap-1.5" data-slot="object-physics-matrix">
                  {ctx.draft.interactions.map((row) => {
                    const nodeId = `model:object:${objectId}:physics:module:${row.kind}`;
                    return (
                      <div
                        key={row.kind}
                        className="flex items-center justify-between gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] px-2.5 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-[var(--fm-text)]">
                            {row.label}
                          </div>
                          <p className="truncate text-xs text-[var(--fm-text-muted)]">
                            {row.subtitle}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Switch
                            aria-label={`Toggle ${row.label}`}
                            checked={row.enabled}
                            onCheckedChange={(checked) => {
                              void handleToggleInteraction(row.kind, checked);
                            }}
                          />
                          <Button
                            aria-label={`Configure ${row.label}`}
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() =>
                              ctx.selectNode({
                                kind: "physics.module",
                                label: row.label,
                                nodeId,
                                objectId,
                                ref: {
                                  kind: "physics.module",
                                  nodeId,
                                  physicsActivation: row.enabled ? "active" : "inactive",
                                  physicsModuleId: row.kind,
                                  physicsModuleKind: row.kind,
                                  physicsScopeKind: "object",
                                  type: "physics-module",
                                },
                              })
                            }
                          >
                            <ArrowRight aria-hidden="true" size={12} />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ),
            },
          ],
        },
        {
          id: "object-physics-transport-spin",
          title: "Charge transport, spin diffusion & torques",
          icon: Zap,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-col gap-2">
                  {ctx.draft.transportAndSpinLinks.length > 0 ? (
                    <InspectorShortcutCards
                      items={ctx.draft.transportAndSpinLinks.map((l) => ({
                        id: l.id,
                        title: l.label,
                        subtitle: l.kind.replace(/_/g, " "),
                        selection: l.selection,
                      }))}
                      onSelect={ctx.selectNode}
                    />
                  ) : null}
                  <div className="grid grid-cols-2 gap-1.5">
                    <Button
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        ctx.selectNode({
                          kind: "physics.current-transport",
                          label: "Charge transport",
                          nodeId: `model:object:${objectId}:current-transport:draft`,
                          objectId,
                          ref: null,
                        })
                      }
                    >
                      <Plus aria-hidden="true" size={12} />
                      <span>Charge Transport</span>
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        ctx.selectNode({
                          kind: "physics.spin-transport",
                          label: "Spin transport",
                          nodeId: `model:object:${objectId}:spin-transport:draft`,
                          objectId,
                          ref: null,
                        })
                      }
                    >
                      <Plus aria-hidden="true" size={12} />
                      <span>Spin Transport</span>
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        ctx.selectNode({
                          kind: "physics.spin-torque",
                          label: "Transport torque",
                          nodeId: `model:object:${objectId}:spin-torque:draft`,
                          objectId,
                          ref: null,
                        })
                      }
                    >
                      <Plus aria-hidden="true" size={12} />
                      <span>Spin Torque</span>
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        ctx.selectNode({
                          kind: "physics.oersted-field",
                          label: "Oersted Field",
                          nodeId: `model:object:${objectId}:oersted-field:draft`,
                          objectId,
                          ref: null,
                        })
                      }
                    >
                      <Plus aria-hidden="true" size={12} />
                      <span>Oersted Field</span>
                    </Button>
                  </div>
                </div>
              ),
            },
          ],
        },
        {
          id: "object-physics-global-summary",
          title: "Participating global physics",
          icon: Activity,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <InspectorShortcutCards
                  items={[
                    {
                      id: "global-physics",
                      title: "Global Physics",
                      subtitle: "Demagnetization, static Zeeman bias, thermal Brown & PBC",
                      badge: ctx.draft.demagGlobalEnabled ? "Demag On" : "Configure",
                      selection: buildRootSelection(
                        "physics.scope.global",
                        "model:physics:global",
                        "Global Physics",
                      ),
                    },
                  ]}
                  onSelect={ctx.selectNode}
                />
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "immediate",
        statusMessage: () =>
          "Switches toggle interactions immediately; click an arrow to edit child module parameters",
      },
    }),
    [baseline.objectName, handleToggleInteraction, objectId],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 2. PhysicsModuleInspectorPanel (`physics.module` — All 11 Leaf Hamiltonian Terms) ── */

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

interface PhysicsModuleDraft {
  moduleId: string;
  moduleKind: CanonicalPhysicsModuleKind;
  scopeKind: "global" | "object";
  objectId: string | null;
  objectName: string;
  enabled: boolean;
  // Exchange
  aex: number;
  // Demag
  demagMethod: "fft_newell" | "fem_bem_hybrid" | "fmm";
  // Zeeman
  zeemanVectorT: readonly [number, number, number];
  // Uniaxial (with Ku2!)
  ku1: number;
  ku2: number;
  uniaxialAxis: readonly [number, number, number];
  // Cubic
  kc1: number;
  kc2: number;
  kc3: number;
  cubicAxis1: readonly [number, number, number];
  cubicAxis2: readonly [number, number, number];
  // Interfacial & Rotated DMI (with interface_normal!)
  dind: number;
  interfaceNormal: readonly [number, number, number];
  dmiRotationAngleDeg: number;
  // Bulk DMI (writable J/m^2!)
  dbulk: number;
  // Magnetoelastic (dimensionless strain without unit="1"!)
  b1: number;
  b2: number;
  c11: number;
  c12: number;
  c44: number;
  voigtExx: number;
  voigtEyy: number;
  voigtEzz: number;
  // Thermal noise
  temperatureK: number;
  rngSeed: number;
  // Periodic BC
  pbcAxes: readonly string[];
}

const effectiveFieldMath = createElement(
  "math",
  {
    display: "block",
    "aria-label": "Effective field B eff equals minus one over Ms times variational derivative of energy density E with respect to m",
  },
  createElement(
    "mrow",
    null,
    createElement("msub", null, createElement("mi", null, "B"), createElement("mtext", null, "eff")),
    createElement("mo", null, "="),
    createElement("mo", null, "\u2212"),
    createElement(
      "mfrac",
      null,
      createElement("mn", null, "1"),
      createElement("msub", null, createElement("mi", null, "M"), createElement("mi", null, "s")),
    ),
    createElement(
      "mfrac",
      null,
      createElement("mrow", null, createElement("mo", null, "\u03b4"), createElement("mi", null, "\u2130")),
      createElement("mrow", null, createElement("mo", null, "\u03b4"), createElement("mi", null, "m")),
    ),
  ),
);

function normalizePhysicsModuleKind(raw: string | null | undefined): CanonicalPhysicsModuleKind {
  const k = (raw ?? "").trim().toLowerCase();
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
  if (k.includes("cubic")) return "cubic_anisotropy";
  if (k.includes("uniaxial")) return "uniaxial_anisotropy";
  if (k.includes("rotated") && k.includes("dmi")) return "rotated_interfacial_dmi";
  if (k.includes("bulk") && k.includes("dmi")) return "bulk_dmi";
  if (k.includes("dmi")) return "interfacial_dmi";
  if (k.includes("therm")) return "thermal_noise";
  if (k.includes("pbc") || k.includes("periodic")) return "periodic_bc";
  if (k.includes("zeeman") || k.includes("external_field")) return "zeeman";
  if (k.includes("demag")) return "demag";
  if (k.includes("elastic")) return "magnetoelastic";
  return "exchange";
}

function moduleTitleForKind(kind: CanonicalPhysicsModuleKind): string {
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
  }
}

export function PhysicsModuleInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const physicsGraph = usePhysicsGraphResource();

  const modRef = selection.ref?.type === "physics-module" ? selection.ref : null;
  const rawKind =
    modRef?.physicsModuleKind ??
    selection.nodeId?.split(":module:").at(-1) ??
    selection.label ??
    "exchange";
  const moduleKind = normalizePhysicsModuleKind(rawKind);
  const objectId = selection.objectId ?? null;
  const scopeKind: "global" | "object" =
    modRef?.physicsScopeKind === "global" || !objectId ? "global" : "object";

  const sceneObj = useMemo(
    () => (objectId ? scene.data?.objects?.find((o) => o.id === objectId) : undefined),
    [objectId, scene.data?.objects],
  );
  const mat = useMemo(() => {
    const ref = sceneObj?.material_ref;
    return ref ? scene.data?.materials?.find((m) => m.id === ref) : undefined;
  }, [scene.data?.materials, sceneObj?.material_ref]);

  const baseline = useMemo<PhysicsModuleDraft>(() => {
    const rawStudy = scene.data?.study as unknown;
    const studyRec: Record<string, unknown> =
      rawStudy && typeof rawStudy === "object" && !Array.isArray(rawStudy)
        ? (rawStudy as Record<string, unknown>)
        : {};
    const props = (mat?.properties ?? {}) as Record<string, unknown>;
    const stack = ((sceneObj as unknown as { physics_stack?: Record<string, unknown>[] })
      ?.physics_stack ?? []);
    const matched = stack.find(
      (s) => String(s.kind ?? "").trim().toLowerCase() === moduleKind,
    );
    const params = ((matched?.params ?? matched ?? {}) as Record<string, unknown>);

    const readV3 = (
      v: unknown,
      fb: readonly [number, number, number],
    ): [number, number, number] =>
      Array.isArray(v) && v.length >= 3
        ? [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0]
        : [fb[0], fb[1], fb[2]];

    const pbcRec = (studyRec.periodic_boundary_conditions ?? null) as Record<string, unknown> | null;
    const pbcAxes: string[] = [];
    if (pbcRec?.x) pbcAxes.push("x");
    if (pbcRec?.y) pbcAxes.push("y");
    if (pbcRec?.z) pbcAxes.push("z");

    return {
      moduleId: modRef?.physicsModuleId ?? moduleKind,
      moduleKind,
      scopeKind,
      objectId,
      objectName: sceneObj?.name?.trim() || objectId || "Global Physics",
      enabled: matched ? matched.enabled !== false : modRef?.physicsActivation !== "inactive",
      aex:
        typeof params.aex === "number"
          ? params.aex
          : typeof props.Aex === "number"
            ? props.Aex
            : 13e-12,
      demagMethod: "fft_newell",
      zeemanVectorT: readV3(studyRec.external_field ?? params.field_t, [0, 0, 0.02]),
      ku1: typeof params.ku1 === "number" ? params.ku1 : 4.5e5,
      ku2: typeof params.ku2 === "number" ? params.ku2 : 0,
      uniaxialAxis: readV3(params.axis, [0, 0, 1]),
      kc1: typeof params.kc1 === "number" ? params.kc1 : 4.8e4,
      kc2: typeof params.kc2 === "number" ? params.kc2 : 5.0e3,
      kc3: typeof params.kc3 === "number" ? params.kc3 : 0,
      cubicAxis1: readV3(params.axis1 ?? params.c1, [1, 0, 0]),
      cubicAxis2: readV3(params.axis2 ?? params.c2, [0, 1, 0]),
      dind:
        typeof params.dind === "number"
          ? params.dind
          : typeof props.Dind === "number"
            ? props.Dind
            : 1.5e-3,
      interfaceNormal: readV3(params.interface_normal, [0, 0, 1]),
      dmiRotationAngleDeg: typeof params.rotation_deg === "number" ? params.rotation_deg : 0,
      dbulk:
        typeof params.dbulk === "number"
          ? params.dbulk
          : typeof props.Dbulk === "number"
            ? props.Dbulk
            : 0.5e-3,
      b1: typeof params.b1 === "number" ? params.b1 : -12.5e6,
      b2: typeof params.b2 === "number" ? params.b2 : -4.3e6,
      c11: typeof params.c11 === "number" ? params.c11 : 210e9,
      c12: typeof params.c12 === "number" ? params.c12 : 130e9,
      c44: typeof params.c44 === "number" ? params.c44 : 80e9,
      voigtExx: typeof params.exx === "number" ? params.exx : 0.001,
      voigtEyy: typeof params.eyy === "number" ? params.eyy : -0.0005,
      voigtEzz: typeof params.ezz === "number" ? params.ezz : 0,
      temperatureK:
        typeof studyRec.temperature_k === "number" ? studyRec.temperature_k : 300,
      rngSeed: typeof studyRec.thermal_seed === "number" ? studyRec.thermal_seed : 42,
      pbcAxes: pbcAxes.length > 0 ? pbcAxes : ["x"],
    };
  }, [mat?.properties, modRef?.physicsActivation, modRef?.physicsModuleId, moduleKind, objectId, scene.data?.study, sceneObj, scopeKind]);

  void physicsGraph;

  const spec = useMemo<InspectorSpec<PhysicsModuleDraft>>(
    () => ({
      id: `physics.module.${moduleKind}`,
      header: {
        breadcrumbs:
          scopeKind === "object" && objectId
            ? [
                {
                  id: "object",
                  label: baseline.objectName,
                  selection: buildObjectSelection(objectId, "object.root", baseline.objectName),
                },
                {
                  id: "physics",
                  label: "Physics",
                  selection: buildObjectSelection(objectId, "object.physics", "Physics"),
                },
                { id: "module", label: moduleTitleForKind(moduleKind) },
              ]
            : [
                {
                  id: "global",
                  label: "Global Physics",
                  selection: buildRootSelection(
                    "physics.scope.global",
                    "model:physics:global",
                    "Global Physics",
                  ),
                },
                { id: "module", label: moduleTitleForKind(moduleKind) },
              ],
        searchable: false,
      },
      identity: {
        domain: "physics",
        icon: moduleKind === "thermal_noise" ? Thermometer : Atom,
        title: () => moduleTitleForKind(moduleKind),
        kindLabel: scopeKind === "object" ? "Object Hamiltonian term" : "Global Hamiltonian term",
        entityId: baseline.moduleId,
        statePill: (d) =>
          d.enabled ? { tone: "ok", label: "Active" } : { tone: "degraded", label: "Disabled" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "scope", label: "Scope", value: d.scopeKind === "object" ? d.objectName : "Global" },
        { id: "family", label: "Operator", value: d.moduleKind.replace(/_/g, " ") },
      ],
      sections: [
        {
          id: "physics-module-params",
          title: "Interaction parameters",
          icon: Compass,
          defaultOpen: true,
          rows: [
            {
              key: "enabled",
              type: "switch",
              label: "Enable Hamiltonian term",
            },
            /* Exchange */
            {
              key: "aex",
              type: "quantity",
              label: "Exchange stiffness",
              symbol: <>A<sub>ex</sub></>,
              units: EXCHANGE_UNITS,
              defaultDisplayUnit: "pJ/m",
              min: 0,
              showWhen: (d) => d.moduleKind === "exchange",
            },
            /* Demag */
            {
              key: "demagMethod",
              type: "select",
              label: "Magnetostatic kernel formulation",
              showWhen: (d) => d.moduleKind === "demag",
              options: [
                { value: "fft_newell", label: "Exact Newell tensor FFT (FDM)" },
                { value: "fem_bem_hybrid", label: "Fredkin-Koehler FEM/BEM hybrid" },
                { value: "fmm", label: "Fast multipole open-boundary" },
              ],
            },
            /* Zeeman */
            {
              key: "zeemanVectorT",
              type: "vector3",
              label: "Static external field",
              symbol: <>B<sub>ext</sub></>,
              units: FIELD_TESLA_UNITS,
              defaultDisplayUnit: "mT",
              coordinateModes: ["cartesian", "spherical"],
              axisPresets: true,
              showWhen: (d) => d.moduleKind === "zeeman",
            },
            /* Uniaxial Anisotropy (with Ku2!) */
            {
              key: "ku1",
              type: "quantity",
              label: "First-order uniaxial constant",
              symbol: <>K<sub>u1</sub></>,
              units: ANISOTROPY_UNITS,
              defaultDisplayUnit: "kJ/m\u00b3",
              showWhen: (d) => d.moduleKind === "uniaxial_anisotropy",
            },
            {
              key: "ku2",
              type: "quantity",
              label: "Second-order uniaxial constant",
              symbol: <>K<sub>u2</sub></>,
              units: ANISOTROPY_UNITS,
              defaultDisplayUnit: "kJ/m\u00b3",
              showWhen: (d) => d.moduleKind === "uniaxial_anisotropy",
            },
            {
              key: "uniaxialAxis",
              type: "vector3",
              label: "Easy / cone symmetry axis",
              symbol: <>u&#770;</>,
              axisPresets: true,
              normalizeAction: true,
              showWhen: (d) => d.moduleKind === "uniaxial_anisotropy",
              validate: (vec) =>
                vectorNorm(vec) < 1e-12 ? "Uniaxial axis must be non-zero." : null,
            },
            /* Cubic Anisotropy */
            {
              key: "kc1",
              type: "quantity",
              label: "First-order cubic constant",
              symbol: <>K<sub>c1</sub></>,
              units: ANISOTROPY_UNITS,
              defaultDisplayUnit: "kJ/m\u00b3",
              showWhen: (d) => d.moduleKind === "cubic_anisotropy",
            },
            {
              key: "kc2",
              type: "quantity",
              label: "Second-order cubic constant",
              symbol: <>K<sub>c2</sub></>,
              units: ANISOTROPY_UNITS,
              defaultDisplayUnit: "kJ/m\u00b3",
              showWhen: (d) => d.moduleKind === "cubic_anisotropy",
            },
            {
              key: "kc3",
              type: "quantity",
              label: "Third-order cubic constant",
              symbol: <>K<sub>c3</sub></>,
              units: ANISOTROPY_UNITS,
              defaultDisplayUnit: "kJ/m\u00b3",
              showWhen: (d) => d.moduleKind === "cubic_anisotropy",
            },
            {
              key: "cubicAxis1",
              type: "vector3",
              label: "Crystal axis [100]",
              symbol: <>c&#770;<sub>1</sub></>,
              axisPresets: true,
              normalizeAction: true,
              showWhen: (d) => d.moduleKind === "cubic_anisotropy",
              validate: (vec) => (vectorNorm(vec) < 1e-12 ? "Axis c1 must be non-zero." : null),
            },
            {
              key: "cubicAxis2",
              type: "vector3",
              label: "Crystal axis [010]",
              symbol: <>c&#770;<sub>2</sub></>,
              axisPresets: true,
              normalizeAction: true,
              showWhen: (d) => d.moduleKind === "cubic_anisotropy",
              validate: (vec, d) => {
                if (vectorNorm(vec) < 1e-12) return "Axis c2 must be non-zero.";
                const u1 = normalizeVector3(d.cubicAxis1);
                const u2 = normalizeVector3(vec);
                const dot = Math.abs(u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2]);
                return dot > 1e-4 ? "Crystal axes c1 and c2 must be orthogonal." : null;
              },
            },
            /* Interfacial DMI & Rotated Interfacial DMI */
            {
              key: "dind",
              type: "quantity",
              label: "Interfacial DMI constant",
              symbol: <>D<sub>ind</sub></>,
              units: DMI_UNITS,
              defaultDisplayUnit: "mJ/m\u00b2",
              showWhen: (d) =>
                d.moduleKind === "interfacial_dmi" || d.moduleKind === "rotated_interfacial_dmi",
            },
            {
              key: "interfaceNormal",
              type: "vector3",
              label: "Symmetry-breaking interface normal",
              symbol: <>n&#770;</>,
              axisPresets: true,
              normalizeAction: true,
              showWhen: (d) =>
                d.moduleKind === "interfacial_dmi" || d.moduleKind === "rotated_interfacial_dmi",
              validate: (vec) =>
                vectorNorm(vec) < 1e-12 ? "Interface normal must be non-zero." : null,
            },
            {
              key: "dmiRotationAngleDeg",
              type: "number",
              label: "In-plane DMI frame rotation",
              unitSuffix: "\u00b0",
              showWhen: (d) => d.moduleKind === "rotated_interfacial_dmi",
            },
            /* Writable Bulk DMI (J/m^2!) */
            {
              key: "dbulk",
              type: "quantity",
              label: "Bulk DMI constant",
              symbol: <>D<sub>bulk</sub></>,
              units: DMI_UNITS,
              defaultDisplayUnit: "mJ/m\u00b2",
              showWhen: (d) => d.moduleKind === "bulk_dmi",
            },
            /* Magnetoelastic (Voigt strains strictly dimensionless without unit="1"!) */
            {
              key: "b1",
              type: "quantity",
              label: "Longitudinal magnetoelastic constant",
              symbol: <>B<sub>1</sub></>,
              units: MAGNETOELASTIC_B_UNITS,
              defaultDisplayUnit: "MJ/m\u00b3",
              showWhen: (d) => d.moduleKind === "magnetoelastic",
            },
            {
              key: "b2",
              type: "quantity",
              label: "Shear magnetoelastic constant",
              symbol: <>B<sub>2</sub></>,
              units: MAGNETOELASTIC_B_UNITS,
              defaultDisplayUnit: "MJ/m\u00b3",
              showWhen: (d) => d.moduleKind === "magnetoelastic",
            },
            {
              key: "c11",
              type: "quantity",
              label: "Cubic stiffness C11",
              symbol: <>C<sub>11</sub></>,
              units: ELASTIC_MODULUS_UNITS,
              defaultDisplayUnit: "GPa",
              showWhen: (d) => d.moduleKind === "magnetoelastic",
              validate: (v, d) => validateBornCubicStability(v, d.c12, d.c44),
            },
            {
              key: "c12",
              type: "quantity",
              label: "Cubic stiffness C12",
              symbol: <>C<sub>12</sub></>,
              units: ELASTIC_MODULUS_UNITS,
              defaultDisplayUnit: "GPa",
              showWhen: (d) => d.moduleKind === "magnetoelastic",
              validate: (v, d) => validateBornCubicStability(d.c11, v, d.c44),
            },
            {
              key: "c44",
              type: "quantity",
              label: "Shear stiffness C44",
              symbol: <>C<sub>44</sub></>,
              units: ELASTIC_MODULUS_UNITS,
              defaultDisplayUnit: "GPa",
              showWhen: (d) => d.moduleKind === "magnetoelastic",
              validate: (v, d) => validateBornCubicStability(d.c11, d.c12, v),
            },
            {
              key: "voigtExx",
              type: "number",
              label: "Prescribed normal strain ε_xx",
              symbol: <>&epsilon;<sub>xx</sub></>,
              step: 0.0001,
              showWhen: (d) => d.moduleKind === "magnetoelastic",
            },
            {
              key: "voigtEyy",
              type: "number",
              label: "Prescribed normal strain ε_yy",
              symbol: <>&epsilon;<sub>yy</sub></>,
              step: 0.0001,
              showWhen: (d) => d.moduleKind === "magnetoelastic",
            },
            {
              key: "voigtEzz",
              type: "number",
              label: "Prescribed normal strain ε_zz",
              symbol: <>&epsilon;<sub>zz</sub></>,
              step: 0.0001,
              showWhen: (d) => d.moduleKind === "magnetoelastic",
            },
            /* Thermal Noise */
            {
              key: "temperatureK",
              type: "quantity",
              label: "Bath temperature",
              symbol: <>T</>,
              units: TEMPERATURE_UNITS,
              defaultDisplayUnit: "K",
              min: 0,
              showWhen: (d) => d.moduleKind === "thermal_noise",
            },
            {
              key: "rngSeed",
              type: "number",
              integer: true,
              label: "Deterministic PRNG seed",
              min: 0,
              showWhen: (d) => d.moduleKind === "thermal_noise",
            },
            /* Periodic BC */
            {
              key: "pbcAxes",
              type: "toggles",
              label: "Periodic translation axes",
              showWhen: (d) => d.moduleKind === "periodic_bc",
              options: [
                { value: "x", label: "X periodic" },
                { value: "y", label: "Y periodic" },
                { value: "z", label: "Z periodic" },
              ],
              validate: (axes, d) =>
                d.enabled && axes.length === 0
                  ? "Select at least one periodic axis (1D, 2D, or 3D)."
                  : null,
            },
          ],
          footer: (ctx) =>
            ctx.draft.moduleKind === "cubic_anisotropy" ? (
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
        {
          id: "physics-module-formulation",
          title: "Variational effective-field operator",
          icon: BookOpen,
          defaultOpen: false,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <div className="fm-math-equation rounded border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2">
                  {effectiveFieldMath}
                </div>
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Hamiltonian module parameters match ProblemIR",
        onApply: async (draft) => {
          if (draft.scopeKind === "object" && draft.objectId) {
            let params: Record<string, unknown> = {};
            switch (draft.moduleKind) {
              case "exchange":
                params = { aex: draft.aex };
                break;
              case "uniaxial_anisotropy":
                params = {
                  ku1: draft.ku1,
                  ku2: draft.ku2,
                  axis: normalizeVector3(draft.uniaxialAxis, [0, 0, 1]),
                };
                break;
              case "cubic_anisotropy":
                params = {
                  kc1: draft.kc1,
                  kc2: draft.kc2,
                  kc3: draft.kc3,
                  axis1: normalizeVector3(draft.cubicAxis1, [1, 0, 0]),
                  axis2: normalizeVector3(draft.cubicAxis2, [0, 1, 0]),
                };
                break;
              case "interfacial_dmi":
                params = {
                  dind: draft.dind,
                  interface_normal: normalizeVector3(draft.interfaceNormal, [0, 0, 1]),
                };
                break;
              case "bulk_dmi":
                params = { dbulk: draft.dbulk };
                break;
              case "magnetoelastic":
                params = {
                  b1: draft.b1,
                  b2: draft.b2,
                  c11: draft.c11,
                  c12: draft.c12,
                  c44: draft.c44,
                  exx: draft.voigtExx,
                  eyy: draft.voigtEyy,
                  ezz: draft.voigtEzz,
                };
                break;
              default:
                params = {};
            }
            const ack = await kernel.api.model.patchObjectInteraction(
              draft.objectId,
              draft.moduleKind as unknown as ObjectInteractionKind,
              {
                base_revision: scene.data?.revision ?? null,
                enabled: draft.enabled,
                present: true,
                params: params as JsonObject,
              },
            );
            kernel.resources.invalidate(MODEL_SCENE_PATH, ack.scene_revision);
            kernel.resources.invalidate(MODEL_OBJECT_INTERACTION_PATH, ack.scene_revision);
            kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, ack.scene_revision);
            return true;
          }

          // Global scope commit via commitTransaction merge_patch (StudyRuntimePatchRequest only accepts compute settings)
          const studyPatch: JsonObject = {};
          if (draft.moduleKind === "demag") {
            studyPatch.demag_enabled = draft.enabled;
          } else if (draft.moduleKind === "zeeman") {
            studyPatch.external_field = draft.enabled ? [...draft.zeemanVectorT] : null;
          } else if (draft.moduleKind === "thermal_noise") {
            studyPatch.temperature_k = draft.enabled ? draft.temperatureK : 0;
            studyPatch.thermal_seed = draft.rngSeed;
          } else if (draft.moduleKind === "periodic_bc") {
            studyPatch.periodic_boundary_conditions = draft.enabled
              ? {
                  x: draft.pbcAxes.includes("x"),
                  y: draft.pbcAxes.includes("y"),
                  z: draft.pbcAxes.includes("z"),
                }
              : null;
          } else if (draft.moduleKind === "rotated_interfacial_dmi") {
            studyPatch.rotated_interfacial_dmi_enabled = draft.enabled;
          }
          const tx = await kernel.api.model.commitTransaction({
            kind: "merge_patch",
            base_revision: scene.data?.revision ?? 0,
            merge_patch: { study: studyPatch },
          });
          publishCommittedSceneResource(
            kernel.resources,
            tx.committed_scene,
            tx.scene_revision,
          );
          const rev = fallbackRevision(tx.scene_revision);
          kernel.resources.invalidate(MODEL_STUDY_PATH, rev);
          kernel.resources.invalidate(MODEL_SCENE_PATH, rev);
          kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
          return true;
        },
      },
    }),
    [
      baseline.moduleId,
      baseline.objectName,
      kernel.api.model,
      kernel.resources,
      moduleKind,
      objectId,
      scene.data?.revision,
      scopeKind,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 3. CouplingInspectorPanel (`physics.coupling` — RKKY, Interlayer J1+J2, Exchange) ── */

interface CouplingSpecDraft {
  couplingId: string;
  exists: boolean;
  name: string;
  enabled: boolean;
  kind: "rkky" | "interlayer_exchange" | "exchange";
  endpointAKey: string;
  endpointBKey: string;
  jRkky: number;
  j1: number;
  j2: number;
  exchangeMode: "harmonic_mean" | "explicit" | "disabled";
  explicitAex: number;
}

function encodeEndpointKey(ep: Record<string, unknown> | null | undefined, fallbackObj: string): string {
  if (!ep) return `${fallbackObj}::`;
  const objId =
    typeof ep.object === "string"
      ? ep.object
      : typeof ep.object_id === "string"
        ? ep.object_id
        : fallbackObj;
  const regId = typeof ep.region_id === "string" ? ep.region_id : "";
  return `${objId}::${regId}`;
}

function decodeEndpointKey(key: string): SceneCouplingEndpoint {
  const [object = "", region_id = ""] = key.split("::");
  return region_id
    ? { kind: "region", object, region_id }
    : { kind: "object", object };
}

export function CouplingInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const couplingsResource = useModelCouplingsResource();

  const couplingId =
    selection.ref?.type === "physics-coupling"
      ? selection.ref.couplingId
      : selection.nodeId?.split(":").at(-1) ?? "coupling-1";

  const endpointOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const obj of scene.data?.objects ?? []) {
      if (obj.role === "airbox" || obj.role === "air" || obj.role === "antenna") continue;
      opts.push({
        value: `${obj.id}::`,
        label: `${obj.name ?? obj.id} (whole object)`,
      });
      for (const reg of obj.regions ?? []) {
        opts.push({
          value: `${obj.id}::${reg.region_id}`,
          label: `${obj.name ?? obj.id} / ${reg.name ?? reg.region_id}`,
        });
      }
    }
    return opts;
  }, [scene.data?.objects]);

  const matchedRecord = useMemo(() => {
    const list =
      (couplingsResource.data as { couplings?: unknown[]; items?: unknown[] } | null)
        ?.couplings ??
      (couplingsResource.data as { items?: unknown[] } | null)?.items ??
      scene.data?.couplings ??
      [];
    return (
      (list.find((item) => {
        const rec = item as Record<string, unknown>;
        return rec.coupling_id === couplingId || rec.id === couplingId;
      }) as Record<string, unknown> | undefined) ?? null
    );
  }, [couplingId, couplingsResource.data, scene.data?.couplings]);

  const baseline = useMemo<CouplingSpecDraft>(() => {
    const fallbackA = endpointOptions[0]?.value ?? "layer-a::";
    const fallbackB = endpointOptions[1]?.value ?? endpointOptions[0]?.value ?? "layer-b::";
    const rawKind = String(matchedRecord?.kind ?? "rkky");
    const kind: CouplingSpecDraft["kind"] =
      rawKind === "interlayer_exchange" || rawKind === "exchange" ? rawKind : "rkky";
    const params = ((matchedRecord?.parameters ??
      matchedRecord?.params ??
      matchedRecord ??
      {}) as Record<string, unknown>);
    return {
      couplingId,
      exists: Boolean(matchedRecord),
      name: String(matchedRecord?.name ?? selection.label ?? couplingId),
      enabled: matchedRecord?.enabled !== false,
      kind,
      endpointAKey: encodeEndpointKey(
        (matchedRecord?.source ?? matchedRecord?.endpoint_a ?? matchedRecord?.side_a) as Record<
          string,
          unknown
        > | null,
        fallbackA.split("::")[0]!,
      ),
      endpointBKey: encodeEndpointKey(
        (matchedRecord?.target ?? matchedRecord?.endpoint_b ?? matchedRecord?.side_b) as Record<
          string,
          unknown
        > | null,
        fallbackB.split("::")[0]!,
      ),
      jRkky:
        typeof params.j1 === "number" && kind === "rkky"
          ? params.j1
          : typeof params.j_rkky === "number"
            ? params.j_rkky
            : typeof params.sigma === "number"
              ? params.sigma
              : -1.0e-3,
      j1: typeof params.j1 === "number" ? params.j1 : -1.0e-3,
      j2: typeof params.j2 === "number" ? params.j2 : -0.2e-3,
      exchangeMode:
        params.mode === "explicit" || params.mode === "disabled"
          ? params.mode
          : "harmonic_mean",
      explicitAex:
        typeof params.inter_exchange === "number"
          ? params.inter_exchange
          : typeof params.aex === "number"
            ? params.aex
            : 10e-12,
    };
  }, [couplingId, endpointOptions, matchedRecord, selection.label]);

  const spec = useMemo<InspectorSpec<CouplingSpecDraft>>(
    () => ({
      id: "physics.coupling",
      header: {
        breadcrumbs: [
          {
            id: "couplings",
            label: "Couplings",
            selection: buildRootSelection(
              "physics.couplings",
              "model:physics:couplings",
              "Couplings",
            ),
          },
          { id: "coupling", label: baseline.name },
        ],
        searchable: false,
        ...(baseline.exists
          ? {
              deleteAction: {
                label: "Delete Coupling",
                confirmTitle: (d) => `Delete coupling "${d.name}"?`,
                confirmDescription:
                  "This removes the surface exchange / RKKY coupling between the two endpoints.",
                onDelete: async (ctx) => {
                  const tx = await kernel.api.model.deleteCoupling(couplingId, {
                    baseRevision: scene.data?.revision ?? undefined,
                  });
                  publishCommittedSceneResource(
                    kernel.resources,
                    tx.committed_scene,
                    tx.scene_revision,
                  );
                  kernel.resources.invalidate(MODEL_COUPLINGS_PATH, tx.scene_revision);
                  ctx.selectNode(
                    buildRootSelection(
                      "physics.couplings",
                      "model:physics:couplings",
                      "Couplings",
                    ),
                  );
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Link2,
        title: (d) => d.name,
        renameFieldKey: "name",
        kindLabel: "Inter-surface magnetic coupling",
        entityId: couplingId,
        statePill: (d) =>
          d.enabled ? { tone: "ok", label: "Active" } : { tone: "degraded", label: "Disabled" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "kind", label: "Model", value: d.kind.replace(/_/g, " ") },
        {
          id: "regime",
          label: "Character",
          value:
            d.kind === "rkky"
              ? d.jRkky < 0
                ? "Antiferromagnetic (AF)"
                : d.jRkky > 0
                  ? "Ferromagnetic (FM)"
                  : "Uncoupled"
              : null,
        },
      ],
      notices: (d): readonly InspectorNotice<CouplingSpecDraft>[] =>
        d.endpointAKey === d.endpointBKey
          ? [
              {
                id: "identical-endpoints",
                tone: "err",
                title: "Distinct endpoints required",
                text: "Endpoint A and Endpoint B must reference two distinct magnetic objects or regions.",
              },
            ]
          : [],
      sections: [
        {
          id: "coupling-endpoints",
          title: "Coupled magnetic endpoints",
          icon: Link2,
          defaultOpen: true,
          rows: [
            {
              key: "name",
              type: "text",
              label: "Coupling name",
              validate: (v) => (v.trim().length === 0 ? "Coupling name is required." : null),
            },
            {
              key: "enabled",
              type: "switch",
              label: "Coupling active",
            },
            {
              key: "kind",
              type: "segmented",
              label: "Coupling Hamiltonian",
              structural: true,
              options: [
                { value: "rkky", label: "RKKY" },
                { value: "interlayer_exchange", label: "J1 + J2" },
                { value: "exchange", label: "Direct" },
              ],
            },
            {
              key: "endpointAKey",
              type: "select",
              label: "Endpoint A",
              options:
                endpointOptions.length > 0
                  ? endpointOptions
                  : [{ value: "layer-a::", label: "Layer A" }],
              validate: (v, d) =>
                v === d.endpointBKey ? "Endpoint A must differ from Endpoint B." : null,
            },
            {
              key: "endpointBKey",
              type: "select",
              label: "Endpoint B",
              options:
                endpointOptions.length > 0
                  ? endpointOptions
                  : [{ value: "layer-b::", label: "Layer B" }],
              validate: (v, d) =>
                v === d.endpointAKey ? "Endpoint B must differ from Endpoint A." : null,
            },
          ],
        },
        {
          id: "coupling-parameters",
          title: "Interfacial coupling strength",
          icon: Atom,
          defaultOpen: true,
          rows: [
            {
              key: "jRkky",
              type: "quantity",
              label: "RKKY bilinear constant",
              symbol: <>J<sub>RKKY</sub></>,
              hint: "Negative values favor antiparallel (synthetic antiferromagnet) alignment.",
              units: INTERLAYER_UNITS,
              defaultDisplayUnit: "mJ/m\u00b2",
              showWhen: (d) => d.kind === "rkky",
            },
            {
              key: "j1",
              type: "quantity",
              label: "Bilinear interlayer constant",
              symbol: <>J<sub>1</sub></>,
              units: INTERLAYER_UNITS,
              defaultDisplayUnit: "mJ/m\u00b2",
              showWhen: (d) => d.kind === "interlayer_exchange",
            },
            {
              key: "j2",
              type: "quantity",
              label: "Biquadratic 90° constant",
              symbol: <>J<sub>2</sub></>,
              units: INTERLAYER_UNITS,
              defaultDisplayUnit: "mJ/m\u00b2",
              showWhen: (d) => d.kind === "interlayer_exchange",
            },
            {
              key: "exchangeMode",
              type: "segmented",
              label: "Interface stiffness rule",
              structural: true,
              showWhen: (d) => d.kind === "exchange",
              options: [
                { value: "harmonic_mean", label: "Harmonic mean" },
                { value: "explicit", label: "Explicit A_int" },
                { value: "disabled", label: "Decoupled" },
              ],
            },
            {
              key: "explicitAex",
              type: "quantity",
              label: "Explicit interface stiffness",
              symbol: <>A<sub>int</sub></>,
              units: EXCHANGE_UNITS,
              defaultDisplayUnit: "pJ/m",
              min: 0,
              showWhen: (d) => d.kind === "exchange" && d.exchangeMode === "explicit",
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Surface coupling matches committed SceneDocument",
        onApply: async (draft) => {
          const source = decodeEndpointKey(draft.endpointAKey);
          const target = decodeEndpointKey(draft.endpointBKey);
          const parameters: SceneCouplingParameters =
            draft.kind === "rkky"
              ? { kind: "rkky", j1: draft.jRkky }
              : draft.kind === "interlayer_exchange"
                ? { kind: "interlayer_exchange", j1: draft.j1, j2: draft.j2 }
                : {
                    kind: "exchange",
                    mode: draft.exchangeMode,
                    ...(draft.exchangeMode === "explicit"
                      ? { inter_exchange: draft.explicitAex }
                      : {}),
                  };

          if (draft.exists) {
            const patchPayload: SceneCouplingPatch = {
              enabled: draft.enabled,
              kind: draft.kind,
              source,
              target,
              parameters,
            };
            const tx = await kernel.api.model.patchCoupling(
              couplingId,
              patchPayload,
              { baseRevision: scene.data?.revision ?? undefined },
            );
            publishCommittedSceneResource(
              kernel.resources,
              tx.committed_scene,
              tx.scene_revision,
            );
            kernel.resources.invalidate(MODEL_COUPLINGS_PATH, tx.scene_revision);
            kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, tx.scene_revision);
          } else {
            const createPayload: SceneCoupling = {
              coupling_id: couplingId,
              enabled: draft.enabled,
              kind: draft.kind,
              source,
              target,
              parameters,
            };
            const tx = await kernel.api.model.createCoupling(
              createPayload,
              { baseRevision: scene.data?.revision ?? undefined },
            );
            publishCommittedSceneResource(
              kernel.resources,
              tx.committed_scene,
              tx.scene_revision,
            );
            kernel.resources.invalidate(MODEL_COUPLINGS_PATH, tx.scene_revision);
            kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, tx.scene_revision);
          }
          return true;
        },
      },
    }),
    [
      baseline.exists,
      baseline.name,
      couplingId,
      endpointOptions,
      kernel.api.model,
      kernel.resources,
      scene.data?.revision,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
