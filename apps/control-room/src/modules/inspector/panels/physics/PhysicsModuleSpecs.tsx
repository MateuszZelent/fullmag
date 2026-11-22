"use client";

import {
  Activity,
  ArrowRight,
  Atom,
  BookOpen,
  Compass,
  GitBranch,
  HelpCircle,
  Link2,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sliders,
  Thermometer,
  Zap,
} from "lucide-react";
import { createElement, useCallback, useMemo, useState, type ReactElement } from "react";

import {
  MODEL_PHYSICS_GRAPH_PATH,
} from "@/kernel/api/apiPaths";
import type {
  AuthoringTransactionRequest,
  JsonObject,
  ObjectInteractionKind,
  ObjectInteractionPatchRequest,
  PhysicsGraphModuleResource,
} from "@/kernel/api/apiTypes";
import {
  authoringWriteOptions,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import { useKernel } from "@/kernel/KernelContext";
import { homeView } from "@/kernel/layout/homeView";
import {
  MODEL_COUPLINGS_RESOURCE_KEY,
  MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY,
  publishCommittedSceneResource,
  resolveMaterialResourceKey,
  resolveSceneResourceRevision,
  useModelCouplingsResource,
  useObjectInteractionResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { usePhysicsGraphResource } from "@/kernel/resources/physicsGraphResources";
import { resolveSessionDiscretization } from "@/kernel/resources/sessionDiscretization";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import {
  resolveActiveLaneOperation,
  useActiveLaneCapabilities,
  type ActiveLaneOperationId,
} from "@/kernel/resources/useActiveLaneCapabilities";
import {
  useSessionResourceIdentity,
  useSessionStatusSelector,
} from "@/kernel/resources/useSessionStatus";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  findInteractionSpec,
  interactionAvailabilityForDiscretization,
  interactionSpecsForDiscretization,
  normalizeInteractionDiscretization,
  validateInteractionDraftForDiscretization,
  type InteractionDiscretization,
  type InteractionSpec,
  type PhysicsInteractionId,
} from "@/shared/domain/physics/interactions";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Checkbox } from "@/shared/ui/Checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import { DisabledReason } from "@/shared/ui/DisabledReason";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorActionContext,
  InspectorFact,
  InspectorNotice,
  InspectorSpec,
} from "../../template";
import { resolveCouplingInspectorModel } from "../CouplingInspectorPanelModel";
import {
  orthogonalizeAxisGramSchmidt,
  validateBornCubicStability,
} from "../material/ObjectMaterialSpec";
import {
  ANISOTROPY_UNITS,
  buildObjectSelection,
  buildRootSelection,
  DMI_UNITS,
  ELASTIC_MODULUS_UNITS,
  EXCHANGE_UNITS,
  FIELD_TESLA_UNITS,
  formatAreaAuto,
  InspectorShortcutCards,
  INTERLAYER_UNITS,
  MAGNETOELASTIC_B_UNITS,
  normalizeVector3,
  type SceneObjectItem as SceneObject,
  SpecInspectorHost,
  TEMPERATURE_UNITS,
  vectorNorm,
} from "../model-roots/SpecInspectorHost";
import { commitObjectInteractionMutation } from "../PhysicsInteractionPanel.model";

type SceneCoupling = Extract<
  AuthoringTransactionRequest,
  { kind: "create_coupling" }
>["coupling"];
type SceneCouplingPatch = Extract<
  AuthoringTransactionRequest,
  { kind: "patch_coupling" }
>["patch"];
type SceneCouplingEndpoint = SceneCoupling["source"];
type SceneCouplingParameters = SceneCoupling["parameters"];
type SceneCouplingCapabilityPolicy = NonNullable<
  SceneCoupling["capability_policy"]
>;

type BackendWritableObjectInteractionKind =
  | "exchange"
  | "demag"
  | "uniaxial_anisotropy"
  | "cubic_anisotropy"
  | "interfacial_dmi"
  | "bulk_dmi";

const ROTATED_DMI_EXCHANGE_ERROR =
  "RotatedInterfacialDmi with open magnetic boundaries requires Exchange for the coupled natural boundary condition";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRevisionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; status?: unknown };
  return (
    candidate.status === 409 &&
    (candidate.code === "revision_conflict" ||
      candidate.code === "scene_revision_conflict" ||
      candidate.code == null)
  );
}

function asJsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function studyRotatedDmiNumber(studyRec: Record<string, unknown> | null): number | null {
  const value = studyRec?.rotated_interfacial_dmi;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function activeObjectScopedDmiKind(
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

function findObjectPhysicsStackEntry(
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

function activeLaneOperationIdForModule(
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

/* ── Shared Help Dialog (`PhysicsInteractionHelpDialog`) ── */

interface ModuleHelpContent {
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

function buildModuleHelpContent(
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

function PhysicsInteractionHelpDialog({
  content,
  onOpenChange,
  open,
}: {
  content: ModuleHelpContent;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="fm-physics-interaction-help-description">
        <DialogHeader>
          <DialogTitle>{content.title}</DialogTitle>
          <DialogDescription id="fm-physics-interaction-help-description">
            {content.description}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5 text-xs">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--fm-border)] pb-1">
            <span className="text-[var(--fm-text-muted)]">Scope</span>
            <span className="font-medium text-[var(--fm-text)]">{content.scope}</span>
          </div>
          <div className="flex items-center justify-between gap-2 border-b border-[var(--fm-border)] pb-1">
            <span className="text-[var(--fm-text-muted)]">Storage</span>
            <span className="font-medium text-[var(--fm-text)]">{content.storage}</span>
          </div>
          {content.fields.map((field) => (
            <div
              key={field.id}
              className="flex flex-col gap-0.5 border-b border-[var(--fm-border)] pb-1 last:border-b-0"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-[var(--fm-text)]">{field.label}</span>
                {field.unit ? (
                  <span className="font-mono text-xs text-[var(--fm-text-muted)]">
                    {field.unit}
                  </span>
                ) : null}
              </div>
              <span className="text-[var(--fm-text-muted)]">{field.description}</span>
            </div>
          ))}
        </div>
        <DialogFooter>
          {content.docsPage ? (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                onOpenChange(false);
                homeView.openDocs(content.docsPage!);
              }}
            >
              Open in documentation
            </Button>
          ) : null}
          <Button size="sm" type="button" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
  present: boolean;
  enabled: boolean;
  required: boolean;
  writable: boolean;
  disabledReason: string | null;
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
  discretization: InteractionDiscretization;
}

function readObjectInteractionState(
  sceneObj: SceneObject | undefined,
  matProps: Record<string, unknown>,
  studyRec: Record<string, unknown> | null,
  kind: ObjectInteractionToggleRow["kind"],
): { present: boolean; enabled: boolean } {
  const stackEntry = findObjectPhysicsStackEntry(sceneObj, kind);
  if (kind === "exchange") {
    const stackEnabled = stackEntry ? stackEntry.enabled !== false : typeof matProps.Aex === "number" ? matProps.Aex > 0 : true;
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
    const implicit = typeof matProps.Dind === "number" && Math.abs(matProps.Dind) > 0;
    return { present: false, enabled: implicit };
  }
  if (kind === "bulk_dmi") {
    const implicit = typeof matProps.Dbulk === "number" && Math.abs(matProps.Dbulk) > 0;
    return { present: false, enabled: implicit };
  }
  return { present: false, enabled: false };
}

export function ObjectPhysicsInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const sessionDiscretization = useSessionStatusSelector((status) =>
    resolveSessionDiscretization(status.data),
  );
  const activeLane = useActiveLaneCapabilities();
  const interactionDiscretization = normalizeInteractionDiscretization(
    sessionDiscretization,
  );
  const scene = useSceneResource();
  const physicsGraph = usePhysicsGraphResource();
  const [mutationFeedback, setMutationFeedback] = useState<{
    tone: "err" | "info";
    text: string;
  } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

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

  const studyRec = asJsonRecord(scene.data?.study);

  const resolveRowDisabledReason = useCallback(
    (kind: ObjectInteractionToggleRow["kind"]): { writable: boolean; reason: string | null } => {
      if (kind === "magnetoelastic") {
        if (interactionDiscretization === "fdm") {
          return {
            writable: false,
            reason:
              "Magnetoelastic coupling is not applicable to the executable FDM lane; use a qualified FEM lane.",
          };
        }
        return {
          writable: false,
          reason:
            "Magnetoelastic coupling is backend-supported in FEM prescribed-strain plans, but browser strain-resource authoring is deferred.",
        };
      }
      if (interactionDiscretization === "unknown") {
        return {
          writable: false,
          reason:
            "Physics interaction lane is unresolved; resolve FDM or FEM before editing.",
        };
      }
      const opId = activeLaneOperationIdForModule(kind);
      if (opId && activeLane) {
        const op = resolveActiveLaneOperation(activeLane, opId);
        if (!op.enabled) {
          return { writable: false, reason: op.reason };
        }
      }
      if (
        (kind === "interfacial_dmi" || kind === "bulk_dmi") &&
        studyRotatedDmiNumber(studyRec) !== null
      ) {
        return {
          writable: true,
          reason: null,
        };
      }
      return { writable: true, reason: null };
    },
    [activeLane, interactionDiscretization, studyRec],
  );

  const interactions = useMemo<readonly ObjectInteractionToggleRow[]>(() => {
    const defs: readonly {
      kind: ObjectInteractionToggleRow["kind"];
      label: string;
      subtitle: string;
      required: boolean;
    }[] = [
      {
        kind: "exchange",
        label: "Symmetric exchange",
        subtitle: "Heisenberg continuum stiffness Aex (∇m)²",
        required: true,
      },
      {
        kind: "uniaxial_anisotropy",
        label: "Uniaxial anisotropy",
        subtitle: "Ku1 sin²θ + Ku2 sin⁴θ along easy/cone axis û",
        required: false,
      },
      {
        kind: "cubic_anisotropy",
        label: "Cubic anisotropy",
        subtitle: "Kc1, Kc2, Kc3 along orthogonal crystal axes (ĉ1, ĉ2)",
        required: false,
      },
      {
        kind: "interfacial_dmi",
        label: "Interfacial DMI",
        subtitle: "Néel-type chiral exchange Dind with interface normal n̂",
        required: false,
      },
      {
        kind: "bulk_dmi",
        label: "Bulk DMI",
        subtitle: "Bloch-type B20 chiral exchange Dbulk (m · ∇ × m)",
        required: false,
      },
      ...(interactionDiscretization === "fdm"
        ? []
        : [
            {
              kind: "magnetoelastic" as const,
              label: "Magnetoelastic coupling",
              subtitle: "Villari / magnetostrictive coupling B1, B2 & Voigt strain",
              required: false,
            },
          ]),
    ];

    return defs.map((def) => {
      const state = readObjectInteractionState(sceneObj, matProps, studyRec, def.kind);
      const gate = resolveRowDisabledReason(def.kind);
      return {
        ...def,
        present: state.present,
        enabled: state.enabled,
        writable: gate.writable,
        disabledReason: gate.reason,
      };
    });
  }, [interactionDiscretization, matProps, resolveRowDisabledReason, sceneObj, studyRec]);

  const transportAndSpinLinks = useMemo<readonly ScopedModuleLink[]>(() => {
    const mods = physicsGraph.data?.modules ?? [];
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
      const scopes = Array.isArray(mod.applies_to) ? mod.applies_to : [];
      const targetsObject = scopes.some(
        (s) => "object_id" in s && s.object_id === objectId,
      );
      if (!targetsObject) continue;
      const id = String(mod.id ?? "");
      const label = String(mod.presentation?.label ?? id);
      const nodeId = `model:object:${objectId}:physics:module:${encodeURIComponent(id)}`;
      const selectionItem: Omit<Selection, "moduleSource"> =
        kind === "current_transport"
          ? {
              kind: "physics.current-transport",
              label,
              nodeId,
              objectId,
              ref: {
                currentTransportId: id,
                kind: "physics.current-transport",
                nodeId,
                type: "current-transport",
              },
            }
          : kind === "spin_transport"
            ? {
                kind: "physics.spin-transport",
                label,
                nodeId,
                objectId,
                ref: {
                  kind: "physics.spin-transport",
                  nodeId,
                  spinTransportId: id,
                  type: "spin-transport",
                },
              }
            : kind === "spin_torque"
              ? {
                  kind: "physics.spin-torque",
                  label,
                  nodeId,
                  objectId,
                  ref: {
                    kind: "physics.spin-torque",
                    nodeId,
                    spinTorqueId: id,
                    type: "spin-torque",
                  },
                }
              : {
                  kind: "physics.oersted-field",
                  label,
                  nodeId,
                  objectId,
                  ref: {
                    kind: "physics.oersted-field",
                    nodeId,
                    oerstedFieldId: id,
                    type: "oersted-field",
                  },
                };
      links.push({
        id,
        kind,
        label,
        selection: selectionItem,
      });
    }
    return links;
  }, [objectId, physicsGraph.data?.modules]);

  const baseline = useMemo<ObjectPhysicsMatrixDraft>(
    () => ({
      objectId,
      objectName: sceneObj?.name?.trim() || objectId || "Object",
      exists: Boolean(sceneObj),
      interactions,
      transportAndSpinLinks,
      demagGlobalEnabled: studyRec?.demag_enabled !== false,
      discretization: interactionDiscretization,
    }),
    [
      interactionDiscretization,
      interactions,
      objectId,
      sceneObj,
      studyRec?.demag_enabled,
      transportAndSpinLinks,
    ],
  );

  const patchObjectStackState = useCallback(
    async (
      kind: BackendWritableObjectInteractionKind,
      label: string,
      next: { present: boolean; enabled?: boolean },
    ) => {
      if (!objectId) return;
      if (interactionDiscretization === "unknown") {
        setMutationFeedback({
          tone: "err",
          text: "Physics interaction lane is unresolved; resolve FDM or FEM before editing.",
        });
        return;
      }
      const opId = activeLaneOperationIdForModule(kind);
      if (opId && activeLane) {
        const op = resolveActiveLaneOperation(activeLane, opId);
        if (!op.enabled) {
          setMutationFeedback({ tone: "err", text: op.reason });
          return;
        }
      }
      if (
        (kind === "interfacial_dmi" || kind === "bulk_dmi") &&
        next.present &&
        next.enabled !== false &&
        studyRotatedDmiNumber(studyRec) !== null
      ) {
        setMutationFeedback({
          tone: "err",
          text: `Object-scoped ${kind} conflicts with active study-level rotated interfacial DMI. Disable or remove the study-level term before enabling the object-scoped DMI.`,
        });
        return;
      }

      const sceneRev = resolveSceneResourceRevision(scene.data);
      const numericSceneRev =
        sceneRev !== null && Number.isFinite(Number(sceneRev))
          ? Number(sceneRev)
          : null;

      try {
        setMutationFeedback(null);
        // CRITICAL: Never send `params: {}` when toggling `enabled` or `present`!
        // Omitting `params` preserves existing `ku1/ku2/axis`, `kc1..3`, `dind/interface_normal`, `dbulk` on the backend.
        await runAuthoringMutationWithHistory(
          {
            api: kernel.api,
            authoringHistory: kernel.authoringHistory,
            sessionScopeKey,
          },
          `${label} interaction`,
          async ({ baseRevision }) => {
            const patchPayload: ObjectInteractionPatchRequest = {
              base_revision: baseRevision ?? numericSceneRev,
              present: next.present,
              ...(next.enabled !== undefined ? { enabled: next.enabled } : {}),
            };
            const committedRev = await commitObjectInteractionMutation({
              interactionKind: kind as ObjectInteractionKind,
              objectId,
              patch: () =>
                kernel.api.model.patchObjectInteraction(
                  objectId,
                  kind as ObjectInteractionKind,
                  patchPayload,
                  sessionScopeKey ? { sessionScopeKey } : undefined,
                ),
              resources: kernel.resources,
            });
            kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, committedRev);
            return committedRev;
          },
        );
      } catch (error) {
        if (isRevisionConflict(error)) {
          scene.refetch?.();
          setMutationFeedback({
            tone: "err",
            text: "Scene changed while updating this interaction. Scene refetched; review and retry.",
          });
          return;
        }
        setMutationFeedback({ tone: "err", text: errorMessage(error) });
      }
    },
    [
      activeLane,
      interactionDiscretization,
      kernel.api,
      kernel.authoringHistory,
      kernel.resources,
      objectId,
      scene,
      sessionScopeKey,
      studyRec,
    ],
  );

  const transportDisabledReason = useCallback(
    (opId: ActiveLaneOperationId): string | null => {
      if (interactionDiscretization === "unknown") {
        return "Physics interaction lane is unresolved; resolve FDM or FEM before creating resources.";
      }
      if (!activeLane) return null;
      const op = resolveActiveLaneOperation(activeLane, opId);
      return op.enabled ? null : op.reason;
    },
    [activeLane, interactionDiscretization],
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
        extraMenuActions: [
          {
            id: "interaction-help",
            label: "Interaction help",
            icon: HelpCircle,
            onSelect: () => setHelpOpen(true),
          },
        ],
      },
      identity: {
        domain: "physics",
        icon: Activity,
        title: (d) => `${d.objectName} · Physics`,
        kindLabel: "Object Hamiltonian & spintronics matrix",
        entityId: objectId ? `${objectId}:physics` : undefined,
        statePill: (d) =>
          d.discretization === "unknown"
            ? { tone: "warn", label: "Lane pending" }
            : {
                tone: "ok",
                label: `${d.interactions.filter((i) => i.enabled).length} active`,
              },
      },
      facts: (d): readonly InspectorFact[] => [
        {
          id: "lane",
          label: "Active lane",
          value: d.discretization === "unknown" ? "Pending" : d.discretization.toUpperCase(),
          tone: d.discretization === "unknown" ? "warn" : "info",
        },
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
      notices: (d): readonly InspectorNotice<ObjectPhysicsMatrixDraft>[] => {
        const list: InspectorNotice<ObjectPhysicsMatrixDraft>[] = [];
        if (d.discretization === "unknown") {
          list.push({
            id: "lane-unresolved",
            tone: "err",
            title: "Discretization lane not yet resolved",
            text: "Physics interaction lane is unresolved; resolve FDM or FEM before editing interactions.",
          });
        }
        if (mutationFeedback) {
          list.push({
            id: "mutation-feedback",
            tone: mutationFeedback.tone,
            text: mutationFeedback.text,
          });
        }
        return list;
      },
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
                    const presentReason = !row.writable
                      ? row.disabledReason
                      : row.required
                        ? `${row.label} is required and cannot be removed from the object stack.`
                        : null;
                    const toggleReason = !row.writable ? row.disabledReason : null;

                    const presentControl = (
                      <label className="flex items-center gap-1 text-xs text-[var(--fm-text-muted)]">
                        <Checkbox
                          aria-label={`Present ${row.label}`}
                          checked={row.present}
                          disabled={Boolean(presentReason)}
                          onChange={(event) => {
                            if (!row.writable || row.kind === "magnetoelastic") return;
                            const nextPresent = event.target.checked;
                            void patchObjectStackState(row.kind, row.label, {
                              present: nextPresent,
                              ...(nextPresent ? { enabled: true } : {}),
                            });
                          }}
                        />
                        <span>Present</span>
                      </label>
                    );

                    const switchControl = row.writable && row.kind !== "magnetoelastic" ? (
                      <Switch
                        aria-label={`Toggle ${row.label}`}
                        checked={row.enabled}
                        disabled={Boolean(toggleReason)}
                        onCheckedChange={(checked) => {
                          void patchObjectStackState(row.kind as BackendWritableObjectInteractionKind, row.label, {
                            present: true,
                            enabled: checked,
                          });
                        }}
                      />
                    ) : (
                      <Badge variant="secondary">Deferred</Badge>
                    );

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
                        <div className="flex shrink-0 items-center gap-2">
                          {presentReason ? (
                            <DisabledReason reason={presentReason}>
                              {presentControl}
                            </DisabledReason>
                          ) : (
                            presentControl
                          )}
                          {toggleReason ? (
                            <DisabledReason reason={toggleReason}>
                              <span>{switchControl}</span>
                            </DisabledReason>
                          ) : (
                            switchControl
                          )}
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
              render: (ctx) => {
                const ctReason = transportDisabledReason("interaction.current_transport");
                const stReason = transportDisabledReason("interaction.spin_torque");
                const oeReason = transportDisabledReason("interaction.oersted_field");

                const wrapBtn = (reason: string | null, btn: ReactElement) =>
                  reason ? <DisabledReason reason={reason}>{btn}</DisabledReason> : btn;

                return (
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
                      {wrapBtn(
                        ctReason,
                        <Button
                          disabled={Boolean(ctReason)}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            const draftNodeId = `model:object:${objectId}:current-transport:draft`;
                            ctx.selectNode({
                              kind: "physics.current-transport",
                              label: "New charge transport",
                              nodeId: draftNodeId,
                              objectId,
                              ref: {
                                kind: "physics.current-transport",
                                nodeId: draftNodeId,
                                type: "current-transport",
                              },
                            });
                          }}
                        >
                          <Plus aria-hidden="true" size={12} />
                          <span>Charge Transport</span>
                        </Button>,
                      )}
                      {wrapBtn(
                        stReason,
                        <Button
                          disabled={Boolean(stReason)}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            const draftNodeId = `model:object:${objectId}:spin-transport:draft`;
                            ctx.selectNode({
                              kind: "physics.spin-transport",
                              label: "New spin transport",
                              nodeId: draftNodeId,
                              objectId,
                              ref: {
                                draft: true,
                                kind: "physics.spin-transport",
                                nodeId: draftNodeId,
                                type: "spin-transport",
                              },
                            });
                          }}
                        >
                          <Plus aria-hidden="true" size={12} />
                          <span>Spin Transport</span>
                        </Button>,
                      )}
                      {wrapBtn(
                        stReason,
                        <Button
                          disabled={Boolean(stReason)}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            const draftNodeId = `model:object:${objectId}:spin-torque:draft`;
                            ctx.selectNode({
                              kind: "physics.spin-torque",
                              label: "New transport torque",
                              nodeId: draftNodeId,
                              objectId,
                              ref: {
                                kind: "physics.spin-torque",
                                nodeId: draftNodeId,
                                type: "spin-torque",
                              },
                            });
                          }}
                        >
                          <Plus aria-hidden="true" size={12} />
                          <span>Spin Torque</span>
                        </Button>,
                      )}
                      {wrapBtn(
                        oeReason,
                        <Button
                          disabled={Boolean(oeReason)}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            const draftNodeId = `model:object:${objectId}:oersted-field:draft`;
                            ctx.selectNode({
                              kind: "physics.oersted-field",
                              label: "New Oersted field",
                              nodeId: draftNodeId,
                              objectId,
                              ref: {
                                kind: "physics.oersted-field",
                                nodeId: draftNodeId,
                                type: "oersted-field",
                              },
                            });
                          }}
                        >
                          <Plus aria-hidden="true" size={12} />
                          <span>Oersted Field</span>
                        </Button>,
                      )}
                    </div>
                  </div>
                );
              },
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
          "Checkboxes and switches update the stack with full parameter preservation; click an arrow to configure parameters",
      },
    }),
    [
      baseline.objectName,
      mutationFeedback,
      objectId,
      patchObjectStackState,
      transportDisabledReason,
    ],
  );

  return (
    <>
      <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />
      <PhysicsInteractionHelpDialog
        content={buildModuleHelpContent("exchange", objectId)}
        open={helpOpen}
        onOpenChange={setHelpOpen}
      />
    </>
  );
}

/* ── 2. PhysicsModuleInspectorPanel (`physics.module` — All 11 Leaf Terms + Graph Provenance) ── */

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

interface GraphModuleProvenanceSummary {
  id: string;
  kind: string;
  sourcePath: string;
  activation: string;
  capabilitySummary: string;
  appliesToSummary: string;
  dependsOn: readonly string[];
}

interface PhysicsModuleDraft {
  moduleId: string;
  rawKind: string;
  moduleKind: CanonicalPhysicsModuleKind | null;
  scopeKind: "global" | "object";
  objectId: string | null;
  objectName: string;
  present: boolean;
  enabled: boolean;
  // Exchange (material-owned Aex when object-scoped)
  aex: number;
  hasAssignedMaterial: boolean;
  // Demag (`study.demag_realization`)
  demagRealization: string;
  // Zeeman (`study.external_field`)
  zeemanVectorT: readonly [number, number, number];
  // Uniaxial (`ku1`, `ku2`, `axis` + `Bk = 2*Ku1/Ms`)
  ku1: number;
  ku2: number;
  uniaxialAxis: readonly [number, number, number];
  materialMs: number | null;
  // Cubic (`kc1`, `kc2`, `kc3`, `axis1`, `axis2`)
  kc1: number;
  kc2: number;
  kc3: number;
  cubicAxis1: readonly [number, number, number];
  cubicAxis2: readonly [number, number, number];
  // Interfacial DMI (`dind`, `interface_normal`)
  dind: number;
  interfaceNormal: readonly [number, number, number];
  // Rotated Interfacial DMI (`study.rotated_interfacial_dmi: number | null`)
  rotatedDmiD: number;
  // Bulk DMI (`dbulk`)
  dbulk: number;
  // Magnetoelastic (all 6 Voigt strain components!)
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
  // Thermal noise (`study.thermal_noise: { temperature, seed } | null`)
  temperatureK: number;
  thermalSeed: string;
  // Periodic BC (`study.pbc: { axes, demag, image_counts? } | null`)
  pbcAxes: readonly string[];
  pbcDemag: "truncated_images" | "open";
  pbcImagesX: number;
  pbcImagesY: number;
  pbcImagesZ: number;
  // Graph provenance
  provenance: GraphModuleProvenanceSummary | null;
  missingFromGraph: boolean;
}

const effectiveFieldMath = createElement(
  "math",
  {
    display: "block",
    "aria-label":
      "Effective field B eff equals minus one over Ms times variational derivative of energy density E with respect to m",
  },
  createElement(
    "mrow",
    null,
    createElement(
      "msub",
      null,
      createElement("mi", null, "B"),
      createElement("mtext", null, "eff"),
    ),
    createElement("mo", null, "="),
    createElement("mo", null, "\u2212"),
    createElement(
      "mfrac",
      null,
      createElement("mn", null, "1"),
      createElement(
        "msub",
        null,
        createElement("mi", null, "M"),
        createElement("mi", null, "s"),
      ),
    ),
    createElement(
      "mfrac",
      null,
      createElement(
        "mrow",
        null,
        createElement("mo", null, "\u03b4"),
        createElement("mi", null, "\u2130"),
      ),
      createElement(
        "mrow",
        null,
        createElement("mo", null, "\u03b4"),
        createElement("mi", null, "m"),
      ),
    ),
  ),
);

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

function moduleTitleForKind(
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

function formatGraphAppliesTo(mod: PhysicsGraphModuleResource): string {
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

function formatGraphCapability(capability: PhysicsGraphModuleResource["capability"]): string {
  const rec = asJsonRecord(capability);
  if (!rec) return "Declared";
  const status = typeof rec.status === "string" ? rec.status : null;
  const lane = typeof rec.lane === "string" ? rec.lane : null;
  const parts = [status, lane].filter(
    (p): p is string => typeof p === "string" && p.length > 0 && !/unknown|unavailable/i.test(p),
  );
  return parts.length > 0 ? parts.join(" · ") : "Graph verified";
}

function isRestFetchableInteractionKind(
  kind: CanonicalPhysicsModuleKind | null,
): kind is ObjectInteractionKind {
  return (
    kind === "exchange" ||
    kind === "demag" ||
    kind === "interfacial_dmi" ||
    kind === "uniaxial_anisotropy"
  );
}

function isRequiredModuleKind(
  kind: CanonicalPhysicsModuleKind | null,
  scopeKind: "global" | "object",
): boolean {
  if (scopeKind === "global") return true;
  return kind === "exchange" || kind === "demag";
}

export function PhysicsModuleInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const sessionDiscretization = useSessionStatusSelector((status) =>
    resolveSessionDiscretization(status.data),
  );
  const activeLane = useActiveLaneCapabilities();
  const interactionDiscretization = normalizeInteractionDiscretization(
    sessionDiscretization,
  );
  const scene = useSceneResource();
  const physicsGraph = usePhysicsGraphResource();
  const [helpOpen, setHelpOpen] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const modRef = selection.ref?.type === "physics-module" ? selection.ref : null;
  const selectedGraphModule = useMemo<PhysicsGraphModuleResource | null>(() => {
    const modules = physicsGraph.data?.modules ?? [];
    if (modRef?.physicsModuleId) {
      const exact = modules.find((m) => m.id === modRef.physicsModuleId);
      if (exact) return exact;
    }
    const candidateKind = modRef?.physicsModuleKind ?? selection.nodeId?.split(":module:").at(-1);
    if (!candidateKind) return null;
    return (
      modules.find((m) => {
        if (m.kind !== candidateKind) return false;
        if (selection.objectId) {
          return m.applies_to.some(
            (s) => "object_id" in s && s.object_id === selection.objectId,
          );
        }
        return true;
      }) ?? null
    );
  }, [modRef, physicsGraph.data?.modules, selection.nodeId, selection.objectId]);

  const rawKind =
    selectedGraphModule?.kind ??
    modRef?.physicsModuleKind ??
    selection.nodeId?.split(":module:").at(-1) ??
    selection.nodeId?.split(":").at(-1) ??
    "exchange";
  const moduleKind = resolveCanonicalPhysicsModuleKind(rawKind);
  const objectId = selection.objectId ?? null;
  // `rotated_interfacial_dmi`, `zeeman`, `thermal_noise`, and `periodic_bc` are always study-scoped in SceneDocument!
  const scopeKind: "global" | "object" =
    moduleKind === "rotated_interfacial_dmi" ||
    moduleKind === "zeeman" ||
    moduleKind === "thermal_noise" ||
    moduleKind === "periodic_bc" ||
    modRef?.physicsScopeKind === "global" ||
    !objectId
      ? "global"
      : "object";

  const restInteractionKind: ObjectInteractionKind = isRestFetchableInteractionKind(moduleKind)
    ? moduleKind
    : "exchange";
  const objectInteraction = useObjectInteractionResource(
    objectId,
    restInteractionKind,
    {
      enabled: Boolean(
        objectId &&
          scopeKind === "object" &&
          isRestFetchableInteractionKind(moduleKind) &&
          interactionDiscretization !== "unknown",
      ),
    },
  );

  const sceneObj = useMemo(
    () => (objectId ? scene.data?.objects?.find((o) => o.id === objectId) : undefined),
    [objectId, scene.data?.objects],
  );
  const mat = useMemo(() => {
    const ref = sceneObj?.material_ref;
    return ref ? scene.data?.materials?.find((m) => m.id === ref) : undefined;
  }, [scene.data?.materials, sceneObj?.material_ref]);

  const demagOptions = useMemo(() => {
    const specs = interactionSpecsForDiscretization(
      interactionDiscretization === "unknown" ? "fem" : interactionDiscretization,
    );
    const demagSpec = specs.find((s) => s.id === "demag");
    const fieldOpts = demagSpec?.fields.find((f) => f.id === "method")?.options ?? [
      { value: "auto", label: "Auto" },
    ];
    const studyRec = asJsonRecord(scene.data?.study);
    const currentRealization =
      typeof studyRec?.demag_realization === "string" && studyRec.demag_realization.trim()
        ? studyRec.demag_realization.trim()
        : "auto";
    if (!fieldOpts.some((o) => o.value === currentRealization)) {
      return [
        ...fieldOpts,
        {
          value: currentRealization,
          label: `${currentRealization} (incompatible with current lane)`,
        },
      ];
    }
    return fieldOpts;
  }, [interactionDiscretization, scene.data?.study]);

  const baseline = useMemo<PhysicsModuleDraft>(() => {
    const studyRec = asJsonRecord(scene.data?.study) ?? {};
    const props = asJsonRecord(mat?.properties) ?? {};
    const matched = moduleKind ? findObjectPhysicsStackEntry(sceneObj, moduleKind) : null;
    const fetchedResource =
      scopeKind === "object" &&
      isRestFetchableInteractionKind(moduleKind) &&
      objectInteraction.status === "ready" &&
      objectInteraction.data
        ? objectInteraction.data
        : null;
    const params = asJsonRecord(fetchedResource?.params ?? matched?.params ?? matched) ?? {};

    const readV3 = (
      v: unknown,
      fb: readonly [number, number, number],
    ): [number, number, number] =>
      Array.isArray(v) && v.length >= 3
        ? [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0]
        : [fb[0], fb[1], fb[2]];

    const readStrain6 = (v: unknown): [number, number, number, number, number, number] | null =>
      Array.isArray(v) && v.length === 6
        ? [
            Number(v[0]) || 0,
            Number(v[1]) || 0,
            Number(v[2]) || 0,
            Number(v[3]) || 0,
            Number(v[4]) || 0,
            Number(v[5]) || 0,
          ]
        : null;

    // Study-level hydrations
    const demagRealization =
      typeof studyRec.demag_realization === "string" && studyRec.demag_realization.trim()
        ? studyRec.demag_realization.trim()
        : "auto";
    const extField = Array.isArray(studyRec.external_field) && studyRec.external_field.length === 3
      ? readV3(studyRec.external_field, [0, 0, 0])
      : null;
    const rotDmiVal = studyRotatedDmiNumber(studyRec);
    const thermalNoiseRec = asJsonRecord(studyRec.thermal_noise);
    const pbcRec = asJsonRecord(studyRec.pbc);
    const pbcAxesRaw = Array.isArray(pbcRec?.axes) ? pbcRec.axes : null;
    const pbcAxes = pbcAxesRaw
      ? (["x", "y", "z"] as const).filter((_, i) => pbcAxesRaw[i] === "periodic")
      : [];
    const pbcImageCounts = Array.isArray(pbcRec?.image_counts) && pbcRec.image_counts.length === 3
      ? [
          Math.max(0, Math.trunc(Number(pbcRec.image_counts[0]) || 0)),
          Math.max(0, Math.trunc(Number(pbcRec.image_counts[1]) || 0)),
          Math.max(0, Math.trunc(Number(pbcRec.image_counts[2]) || 0)),
        ]
      : [10, 10, 10];

    let present = true;
    let enabled = true;
    if (scopeKind === "global") {
      switch (moduleKind) {
        case "exchange":
          present = true;
          enabled = studyRec.exchange_enabled !== false;
          break;
        case "demag":
          present = true;
          enabled = studyRec.demag_enabled !== false;
          break;
        case "zeeman":
          present = true;
          enabled = extField !== null;
          break;
        case "rotated_interfacial_dmi":
          present = true;
          enabled = rotDmiVal !== null;
          break;
        case "thermal_noise":
          present = true;
          enabled = thermalNoiseRec !== null;
          break;
        case "periodic_bc":
          present = true;
          enabled = pbcAxes.length > 0;
          break;
        default:
          present = true;
          enabled = modRef?.physicsActivation !== "inactive";
      }
    } else {
      if (fetchedResource) {
        present =
          moduleKind === "exchange" || moduleKind === "demag"
            ? true
            : fetchedResource.present;
        enabled = fetchedResource.present
          ? fetchedResource.enabled
          : modRef?.physicsActivation === "active";
      } else if (matched) {
        present = true;
        enabled = matched.enabled !== false;
      } else if (moduleKind === "exchange" || moduleKind === "demag") {
        present = true;
        enabled = modRef?.physicsActivation !== "inactive";
      } else {
        present = modRef?.physicsActivation === "active";
        enabled = modRef?.physicsActivation === "active";
      }
    }

    const strain6 = readStrain6(params.strain);
    const provenance: GraphModuleProvenanceSummary | null = selectedGraphModule
      ? {
          id: selectedGraphModule.id,
          kind: selectedGraphModule.kind,
          sourcePath: selectedGraphModule.source_path,
          activation: selectedGraphModule.activation,
          capabilitySummary: formatGraphCapability(selectedGraphModule.capability),
          appliesToSummary: formatGraphAppliesTo(selectedGraphModule),
          dependsOn: selectedGraphModule.depends_on,
        }
      : null;

    const missingFromGraph = Boolean(
      modRef?.physicsModuleId &&
        physicsGraph.status === "ready" &&
        (physicsGraph.data?.modules?.length ?? 0) > 0 &&
        !selectedGraphModule,
    );

    return {
      moduleId: modRef?.physicsModuleId ?? rawKind,
      rawKind,
      moduleKind,
      scopeKind,
      objectId,
      objectName: sceneObj?.name?.trim() || objectId || "Global Physics",
      present,
      enabled,
      aex: typeof props.Aex === "number" ? props.Aex : 13e-12,
      hasAssignedMaterial: Boolean(mat?.id),
      demagRealization,
      zeemanVectorT: extField ?? readV3(params.field_t, [0, 0, 0.02]),
      ku1: typeof params.ku1 === "number" ? params.ku1 : 0,
      ku2: typeof params.ku2 === "number" ? params.ku2 : 0,
      uniaxialAxis: readV3(params.axis, [0, 0, 1]),
      materialMs: typeof props.Ms === "number" ? props.Ms : null,
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
            : 1.0e-3,
      interfaceNormal: readV3(params.interface_normal, [0, 0, 1]),
      rotatedDmiD: rotDmiVal ?? 0.003,
      dbulk:
        typeof params.dbulk === "number"
          ? params.dbulk
          : typeof props.Dbulk === "number"
            ? props.Dbulk
            : 1.0e-3,
      b1: typeof params.b1 === "number" ? params.b1 : -12.5e6,
      b2: typeof params.b2 === "number" ? params.b2 : -4.3e6,
      c11: typeof params.c11 === "number" ? params.c11 : 210e9,
      c12: typeof params.c12 === "number" ? params.c12 : 130e9,
      c44: typeof params.c44 === "number" ? params.c44 : 80e9,
      voigtExx: strain6 ? strain6[0] : typeof params.exx === "number" ? params.exx : 0.001,
      voigtEyy: strain6 ? strain6[1] : typeof params.eyy === "number" ? params.eyy : -0.0005,
      voigtEzz: strain6 ? strain6[2] : typeof params.ezz === "number" ? params.ezz : 0,
      voigtEyz: strain6 ? strain6[3] : typeof params.eyz === "number" ? params.eyz : 0,
      voigtExz: strain6 ? strain6[4] : typeof params.exz === "number" ? params.exz : 0,
      voigtExy: strain6 ? strain6[5] : typeof params.exy === "number" ? params.exy : 0,
      temperatureK:
        typeof thermalNoiseRec?.temperature === "number"
          ? thermalNoiseRec.temperature
          : 300,
      thermalSeed:
        typeof thermalNoiseRec?.seed === "string"
          ? thermalNoiseRec.seed
          : typeof thermalNoiseRec?.seed === "number"
            ? String(thermalNoiseRec.seed)
            : "",
      pbcAxes: pbcAxes.length > 0 ? pbcAxes : ["x"],
      pbcDemag: pbcRec?.demag === "open" ? "open" : "truncated_images",
      pbcImagesX: pbcImageCounts[0] || 10,
      pbcImagesY: pbcImageCounts[1] || 10,
      pbcImagesZ: pbcImageCounts[2] || 10,
      provenance,
      missingFromGraph,
    };
  }, [
    mat?.id,
    mat?.properties,
    modRef?.physicsActivation,
    modRef?.physicsModuleId,
    moduleKind,
    objectId,
    objectInteraction.data,
    objectInteraction.status,
    physicsGraph.data?.modules?.length,
    physicsGraph.status,
    rawKind,
    scene.data?.study,
    sceneObj,
    scopeKind,
    selectedGraphModule,
  ]);

  const evaluateConflictOrLaneError = useCallback(
    (d: PhysicsModuleDraft): string | null => {
      if (d.moduleKind === null) {
        return `Physics module kind '${d.rawKind}' has no editable authoring schema; displaying graph provenance read-only.`;
      }
      if (interactionDiscretization === "unknown") {
        return "Physics interaction lane is unresolved; resolve FDM or FEM before editing.";
      }
      if (d.moduleKind === "magnetoelastic") {
        const avail = interactionAvailabilityForDiscretization(
          "magnetoelastic",
          interactionDiscretization,
        );
        return (
          avail.reason ??
          "Magnetoelastic coupling is backend-supported in FEM prescribed-strain plans, but browser strain-resource authoring is deferred."
        );
      }
      const opId = activeLaneOperationIdForModule(d.moduleKind);
      if (opId && activeLane) {
        const op = resolveActiveLaneOperation(activeLane, opId);
        if (!op.enabled) return op.reason;
      }
      if (d.moduleKind === "demag" && d.scopeKind === "global") {
        const check = validateInteractionDraftForDiscretization(
          {
            id: "demag",
            enabled: d.enabled,
            present: true,
            values: { method: d.demagRealization },
          },
          interactionDiscretization,
        );
        if (check) return check.error;
      }

      const studyRec = asJsonRecord(scene.data?.study);
      if (d.moduleKind === "rotated_interfacial_dmi" && d.enabled) {
        const conflicting = activeObjectScopedDmiKind(scene.data?.objects);
        if (conflicting) {
          return `Rotated interfacial DMI conflicts with active object-scoped ${conflicting}. Disable or remove the object-scoped DMI before applying the study-level term.`;
        }
        if (d.rotatedDmiD !== 0 && studyRec?.exchange_enabled === false) {
          return ROTATED_DMI_EXCHANGE_ERROR;
        }
      }
      if (
        (d.moduleKind === "interfacial_dmi" || d.moduleKind === "bulk_dmi") &&
        d.scopeKind === "object" &&
        d.present &&
        d.enabled &&
        studyRotatedDmiNumber(studyRec) !== null
      ) {
        return `Object-scoped ${d.moduleKind} conflicts with active study-level rotated interfacial DMI. Disable or remove the study-level term before applying the object-scoped DMI.`;
      }
      if (
        d.moduleKind === "exchange" &&
        d.scopeKind === "global" &&
        !d.enabled
      ) {
        const rotVal = studyRotatedDmiNumber(studyRec);
        if (rotVal !== null && rotVal !== 0) {
          return ROTATED_DMI_EXCHANGE_ERROR;
        }
      }
      return null;
    },
    [activeLane, interactionDiscretization, scene.data?.objects, scene.data?.study],
  );

  const spec = useMemo<InspectorSpec<PhysicsModuleDraft>>(() => {
    const isReadOnlyModule = baseline.moduleKind === null;
    const titleLabel = moduleTitleForKind(baseline.moduleKind, baseline.rawKind);

    return {
      id: `physics.module.${baseline.moduleKind ?? baseline.rawKind}`,
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
                { id: "module", label: titleLabel },
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
                { id: "module", label: titleLabel },
              ],
        searchable: false,
        extraMenuActions: [
          {
            id: "module-help",
            label: "Interaction help",
            icon: HelpCircle,
            onSelect: () => setHelpOpen(true),
          },
          {
            id: "refresh-module",
            label: "Refresh physics state",
            icon: RefreshCw,
            onSelect: () => {
              scene.refetch?.();
              physicsGraph.refetch?.();
              objectInteraction.refetch?.();
              setMutationError(null);
            },
          },
        ],
      },
      identity: {
        domain: "physics",
        icon: baseline.moduleKind === "thermal_noise" ? Thermometer : Atom,
        title: () => titleLabel,
        kindLabel:
          scopeKind === "object" ? "Object Hamiltonian term" : "Global Hamiltonian term",
        entityId: baseline.moduleId,
        statePill: (d) => {
          if (!d.present) return { tone: "neutral", label: "Not in stack" };
          return d.enabled
            ? { tone: "ok", label: "Active" }
            : { tone: "degraded", label: "Disabled" };
        },
      },
      facts: (d): readonly InspectorFact[] => [
        {
          id: "scope",
          label: "Scope",
          value: d.provenance?.appliesToSummary ?? (d.scopeKind === "object" ? d.objectName : "Global"),
        },
        {
          id: "family",
          label: "Operator",
          value: (d.moduleKind ?? d.rawKind).replace(/_/g, " "),
        },
        ...(d.provenance
          ? [
              {
                id: "activation",
                label: "Graph state",
                value: d.provenance.activation,
                tone: d.provenance.activation === "active" ? ("ok" as const) : ("warn" as const),
              },
            ]
          : []),
      ],
      notices: (d): readonly InspectorNotice<PhysicsModuleDraft>[] => {
        const list: InspectorNotice<PhysicsModuleDraft>[] = [];
        if (d.missingFromGraph) {
          list.push({
            id: "missing-graph-module",
            tone: "warn",
            title: "Module absent from current physics graph",
            text: "The selected physics module is no longer present in the current graph revision.",
          });
        }
        const gateErr = evaluateConflictOrLaneError(d);
        if (gateErr) {
          list.push({
            id: "lane-or-conflict-error",
            tone: d.moduleKind === "magnetoelastic" ? "warn" : "err",
            text: gateErr,
          });
        }
        if (mutationError) {
          list.push({
            id: "mutation-error",
            tone: "err",
            text: mutationError,
            quickFix: {
              label: "Refresh scene",
              onApply: () => {
                scene.refetch?.();
                objectInteraction.refetch?.();
                setMutationError(null);
              },
            },
          });
        }
        return list;
      },
      sections: [
        ...(isReadOnlyModule
          ? []
          : [
              {
                id: "physics-module-params",
                title: "Interaction parameters",
                icon: Compass,
                defaultOpen: true,
                rows: [
                  {
                    key: "present" as const,
                    type: "switch" as const,
                    label: "Present in object physics stack",
                    structural: true,
                    showWhen: (d: PhysicsModuleDraft) =>
                      d.scopeKind === "object" && !isRequiredModuleKind(d.moduleKind, d.scopeKind),
                    disabledReason: (d: PhysicsModuleDraft) =>
                      isRequiredModuleKind(d.moduleKind, d.scopeKind)
                        ? "Required interaction cannot be removed."
                        : null,
                  },
                  {
                    key: "enabled" as const,
                    type: "switch" as const,
                    label: "Enable Hamiltonian term",
                    structural: true,
                    disabledReason: (d: PhysicsModuleDraft) =>
                      !d.present ? "Enable 'Present in object physics stack' first." : null,
                  },
                  /* Exchange */
                  {
                    type: "readonly" as const,
                    label: "Stiffness source",
                    showWhen: (d: PhysicsModuleDraft) =>
                      d.moduleKind === "exchange" && d.scopeKind === "global",
                    format: () =>
                      "Numeric A_ex is owned by each object's assigned material; this switch gates global exchange assembly.",
                  },
                  {
                    key: "aex" as const,
                    type: "quantity" as const,
                    label: "Material exchange stiffness",
                    symbol: (
                      <>
                        A<sub>ex</sub>
                      </>
                    ),
                    units: EXCHANGE_UNITS,
                    defaultDisplayUnit: "pJ/m",
                    min: 0,
                    showWhen: (d: PhysicsModuleDraft) =>
                      d.moduleKind === "exchange" && d.scopeKind === "object",
                    disabledReason: (d: PhysicsModuleDraft) =>
                      !d.hasAssignedMaterial
                        ? "Assign a material on Object Material before editing A_ex."
                        : null,
                  },
                  /* Demag (`study.demag_realization`) */
                  {
                    key: "demagRealization" as const,
                    type: "select" as const,
                    label: "Magnetostatic realization",
                    showWhen: (d: PhysicsModuleDraft) =>
                      d.moduleKind === "demag" && d.scopeKind === "global",
                    options: demagOptions,
                    validate: (val: string, d: PhysicsModuleDraft) => {
                      if (interactionDiscretization === "unknown") return null;
                      const res = validateInteractionDraftForDiscretization(
                        {
                          id: "demag",
                          enabled: d.enabled,
                          present: true,
                          values: { method: val },
                        },
                        interactionDiscretization,
                      );
                      return res?.error ?? null;
                    },
                  },
                  /* Zeeman */
                  {
                    key: "zeemanVectorT" as const,
                    type: "vector3" as const,
                    label: "Static external field",
                    symbol: (
                      <>
                        B<sub>ext</sub>
                      </>
                    ),
                    units: FIELD_TESLA_UNITS,
                    defaultDisplayUnit: "mT",
                    coordinateModes: ["cartesian", "spherical"] as const,
                    axisPresets: true,
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "zeeman",
                  },
                  /* Uniaxial Anisotropy (with Ku2 + Bk = 2*Ku1/Ms readout!) */
                  {
                    key: "ku1" as const,
                    type: "quantity" as const,
                    label: "First-order uniaxial constant",
                    symbol: (
                      <>
                        K<sub>u1</sub>
                      </>
                    ),
                    units: ANISOTROPY_UNITS,
                    defaultDisplayUnit: "kJ/m\u00b3",
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "uniaxial_anisotropy",
                  },
                  {
                    key: "ku2" as const,
                    type: "quantity" as const,
                    label: "Second-order uniaxial constant",
                    symbol: (
                      <>
                        K<sub>u2</sub>
                      </>
                    ),
                    units: ANISOTROPY_UNITS,
                    defaultDisplayUnit: "kJ/m\u00b3",
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "uniaxial_anisotropy",
                  },
                  {
                    key: "uniaxialAxis" as const,
                    type: "vector3" as const,
                    label: "Easy / cone symmetry axis",
                    symbol: <>u&#770;</>,
                    axisPresets: true,
                    normalizeAction: true,
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "uniaxial_anisotropy",
                    validate: (vec: readonly [number, number, number]) =>
                      vectorNorm(vec) < 1e-12 ? "Uniaxial axis must be non-zero." : null,
                  },
                  {
                    type: "readonly" as const,
                    label: "Anisotropy field (Bk = 2·Ku1/Ms)",
                    symbol: (
                      <>
                        B<sub>k</sub>
                      </>
                    ),
                    mono: true,
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "uniaxial_anisotropy",
                    format: (d: PhysicsModuleDraft) =>
                      d.present &&
                      d.enabled &&
                      Number.isFinite(d.ku1) &&
                      typeof d.materialMs === "number" &&
                      Number.isFinite(d.materialMs) &&
                      d.materialMs > 0
                        ? `${((2 * d.ku1) / d.materialMs).toPrecision(4)} T`
                        : "Requires active Ku1 and assigned Ms > 0",
                  },
                  /* Cubic Anisotropy */
                  {
                    key: "kc1" as const,
                    type: "quantity" as const,
                    label: "First-order cubic constant",
                    symbol: (
                      <>
                        K<sub>c1</sub>
                      </>
                    ),
                    units: ANISOTROPY_UNITS,
                    defaultDisplayUnit: "kJ/m\u00b3",
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "cubic_anisotropy",
                  },
                  {
                    key: "kc2" as const,
                    type: "quantity" as const,
                    label: "Second-order cubic constant",
                    symbol: (
                      <>
                        K<sub>c2</sub>
                      </>
                    ),
                    units: ANISOTROPY_UNITS,
                    defaultDisplayUnit: "kJ/m\u00b3",
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "cubic_anisotropy",
                  },
                  {
                    key: "kc3" as const,
                    type: "quantity" as const,
                    label: "Third-order cubic constant",
                    symbol: (
                      <>
                        K<sub>c3</sub>
                      </>
                    ),
                    units: ANISOTROPY_UNITS,
                    defaultDisplayUnit: "kJ/m\u00b3",
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "cubic_anisotropy",
                  },
                  {
                    key: "cubicAxis1" as const,
                    type: "vector3" as const,
                    label: "Crystal axis [100]",
                    symbol: (
                      <>
                        c&#770;<sub>1</sub>
                      </>
                    ),
                    axisPresets: true,
                    normalizeAction: true,
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "cubic_anisotropy",
                    validate: (vec: readonly [number, number, number]) =>
                      vectorNorm(vec) < 1e-12 ? "Axis c1 must be non-zero." : null,
                  },
                  {
                    key: "cubicAxis2" as const,
                    type: "vector3" as const,
                    label: "Crystal axis [010]",
                    symbol: (
                      <>
                        c&#770;<sub>2</sub>
                      </>
                    ),
                    axisPresets: true,
                    normalizeAction: true,
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "cubic_anisotropy",
                    validate: (vec: readonly [number, number, number], d: PhysicsModuleDraft) => {
                      if (vectorNorm(vec) < 1e-12) return "Axis c2 must be non-zero.";
                      const u1 = normalizeVector3(d.cubicAxis1);
                      const u2 = normalizeVector3(vec);
                      const dot = Math.abs(
                        u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2],
                      );
                      return dot > 1e-6 ? "Crystal axes c1 and c2 must be orthogonal." : null;
                    },
                  },
                  /* Interfacial DMI */
                  {
                    key: "dind" as const,
                    type: "quantity" as const,
                    label: "Interfacial DMI constant",
                    symbol: (
                      <>
                        D<sub>ind</sub>
                      </>
                    ),
                    units: DMI_UNITS,
                    defaultDisplayUnit: "mJ/m\u00b2",
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "interfacial_dmi",
                  },
                  {
                    key: "interfaceNormal" as const,
                    type: "vector3" as const,
                    label: "Symmetry-breaking interface normal",
                    symbol: <>n&#770;</>,
                    axisPresets: true,
                    normalizeAction: true,
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "interfacial_dmi",
                    validate: (vec: readonly [number, number, number]) =>
                      vectorNorm(vec) < 1e-12 ? "Interface normal must be non-zero." : null,
                  },
                  /* Rotated Interfacial DMI (`study.rotated_interfacial_dmi: number | null`) */
                  {
                    key: "rotatedDmiD" as const,
                    type: "quantity" as const,
                    label: "Rotated interfacial DMI constant",
                    symbol: <>D</>,
                    hint: "Göbel rotated DMI coefficient (D21 = D32 = D) stored on study.rotated_interfacial_dmi.",
                    units: DMI_UNITS,
                    defaultDisplayUnit: "mJ/m\u00b2",
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "rotated_interfacial_dmi",
                  },
                  /* Writable Bulk DMI (`dbulk`) */
                  {
                    key: "dbulk" as const,
                    type: "quantity" as const,
                    label: "Bulk DMI constant",
                    symbol: (
                      <>
                        D<sub>bulk</sub>
                      </>
                    ),
                    units: DMI_UNITS,
                    defaultDisplayUnit: "mJ/m\u00b2",
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "bulk_dmi",
                  },
                  /* Magnetoelastic (with all 6 Voigt strain components!) */
                  {
                    key: "b1" as const,
                    type: "quantity" as const,
                    label: "Longitudinal magnetoelastic constant",
                    symbol: (
                      <>
                        B<sub>1</sub>
                      </>
                    ),
                    units: MAGNETOELASTIC_B_UNITS,
                    defaultDisplayUnit: "MJ/m\u00b3",
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
                  },
                  {
                    key: "b2" as const,
                    type: "quantity" as const,
                    label: "Shear magnetoelastic constant",
                    symbol: (
                      <>
                        B<sub>2</sub>
                      </>
                    ),
                    units: MAGNETOELASTIC_B_UNITS,
                    defaultDisplayUnit: "MJ/m\u00b3",
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
                  },
                  {
                    key: "c11" as const,
                    type: "quantity" as const,
                    label: "Cubic stiffness C11",
                    symbol: (
                      <>
                        C<sub>11</sub>
                      </>
                    ),
                    units: ELASTIC_MODULUS_UNITS,
                    defaultDisplayUnit: "GPa",
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
                    validate: (v: number, d: PhysicsModuleDraft) =>
                      validateBornCubicStability(v, d.c12, d.c44),
                  },
                  {
                    key: "c12" as const,
                    type: "quantity" as const,
                    label: "Cubic stiffness C12",
                    symbol: (
                      <>
                        C<sub>12</sub>
                      </>
                    ),
                    units: ELASTIC_MODULUS_UNITS,
                    defaultDisplayUnit: "GPa",
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
                    validate: (v: number, d: PhysicsModuleDraft) =>
                      validateBornCubicStability(d.c11, v, d.c44),
                  },
                  {
                    key: "c44" as const,
                    type: "quantity" as const,
                    label: "Shear stiffness C44",
                    symbol: (
                      <>
                        C<sub>44</sub>
                      </>
                    ),
                    units: ELASTIC_MODULUS_UNITS,
                    defaultDisplayUnit: "GPa",
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
                    validate: (v: number, d: PhysicsModuleDraft) =>
                      validateBornCubicStability(d.c11, d.c12, v),
                  },
                  {
                    key: "voigtExx" as const,
                    type: "number" as const,
                    label: "Prescribed normal strain ε_xx",
                    symbol: (
                      <>
                        &epsilon;<sub>xx</sub>
                      </>
                    ),
                    step: 0.0001,
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
                  },
                  {
                    key: "voigtEyy" as const,
                    type: "number" as const,
                    label: "Prescribed normal strain ε_yy",
                    symbol: (
                      <>
                        &epsilon;<sub>yy</sub>
                      </>
                    ),
                    step: 0.0001,
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
                  },
                  {
                    key: "voigtEzz" as const,
                    type: "number" as const,
                    label: "Prescribed normal strain ε_zz",
                    symbol: (
                      <>
                        &epsilon;<sub>zz</sub>
                      </>
                    ),
                    step: 0.0001,
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
                  },
                  {
                    key: "voigtEyz" as const,
                    type: "number" as const,
                    label: "Prescribed shear strain ε_yz",
                    symbol: (
                      <>
                        &epsilon;<sub>yz</sub>
                      </>
                    ),
                    step: 0.0001,
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
                  },
                  {
                    key: "voigtExz" as const,
                    type: "number" as const,
                    label: "Prescribed shear strain ε_xz",
                    symbol: (
                      <>
                        &epsilon;<sub>xz</sub>
                      </>
                    ),
                    step: 0.0001,
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
                  },
                  {
                    key: "voigtExy" as const,
                    type: "number" as const,
                    label: "Prescribed shear strain ε_xy",
                    symbol: (
                      <>
                        &epsilon;<sub>xy</sub>
                      </>
                    ),
                    step: 0.0001,
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
                  },
                  /* Thermal Noise (`study.thermal_noise`) */
                  {
                    key: "temperatureK" as const,
                    type: "quantity" as const,
                    label: "Bath temperature",
                    symbol: <>T</>,
                    units: TEMPERATURE_UNITS,
                    defaultDisplayUnit: "K",
                    min: 0,
                    minExclusive: true,
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "thermal_noise",
                    validate: (v: number, d: PhysicsModuleDraft) =>
                      d.enabled && !(v > 0)
                        ? "Bath temperature must be strictly positive (T > 0 K)."
                        : null,
                  },
                  {
                    key: "thermalSeed" as const,
                    type: "text" as const,
                    mono: true,
                    label: "Deterministic PRNG seed",
                    placeholder: "Leave empty for entropy",
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "thermal_noise",
                    validate: (v: string, d: PhysicsModuleDraft) => {
                      if (!d.enabled || v.trim() === "") return null;
                      return /^[1-9][0-9]*$/.test(v.trim())
                        ? null
                        : "Seed must be a positive decimal integer without leading zeroes (e.g. 42).";
                    },
                  },
                  /* Periodic BC (`study.pbc`) */
                  {
                    key: "pbcAxes" as const,
                    type: "toggles" as const,
                    label: "Periodic translation axes",
                    structural: true,
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "periodic_bc",
                    options: [
                      { value: "x", label: "X periodic" },
                      { value: "y", label: "Y periodic" },
                      { value: "z", label: "Z periodic" },
                    ],
                    validate: (axes: readonly string[], d: PhysicsModuleDraft) =>
                      d.enabled && axes.length === 0
                        ? "Select at least one periodic axis (1D, 2D, or 3D)."
                        : null,
                  },
                  {
                    key: "pbcDemag" as const,
                    type: "segmented" as const,
                    label: "Demag boundary kernel",
                    structural: true,
                    showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "periodic_bc",
                    options: [
                      { value: "truncated_images", label: "Truncated images" },
                      { value: "open", label: "Open (no demag)" },
                    ],
                    validate: (val: string, d: PhysicsModuleDraft) => {
                      const studyRec = asJsonRecord(scene.data?.study);
                      if (
                        d.enabled &&
                        d.pbcAxes.length > 0 &&
                        studyRec?.demag_enabled !== false &&
                        val === "open"
                      ) {
                        return "Periodic axes with active demagnetization require 'Truncated images'.";
                      }
                      return null;
                    },
                  },
                  {
                    key: "pbcImagesX" as const,
                    type: "number" as const,
                    integer: true,
                    min: 1,
                    label: "Image repeats along X",
                    showWhen: (d: PhysicsModuleDraft) =>
                      d.moduleKind === "periodic_bc" &&
                      d.pbcDemag === "truncated_images" &&
                      d.pbcAxes.includes("x"),
                  },
                  {
                    key: "pbcImagesY" as const,
                    type: "number" as const,
                    integer: true,
                    min: 1,
                    label: "Image repeats along Y",
                    showWhen: (d: PhysicsModuleDraft) =>
                      d.moduleKind === "periodic_bc" &&
                      d.pbcDemag === "truncated_images" &&
                      d.pbcAxes.includes("y"),
                  },
                  {
                    key: "pbcImagesZ" as const,
                    type: "number" as const,
                    integer: true,
                    min: 1,
                    label: "Image repeats along Z",
                    showWhen: (d: PhysicsModuleDraft) =>
                      d.moduleKind === "periodic_bc" &&
                      d.pbcDemag === "truncated_images" &&
                      d.pbcAxes.includes("z"),
                  },
                ],
                footer: (ctx: InspectorActionContext<PhysicsModuleDraft>) =>
                  ctx.draft.moduleKind === "cubic_anisotropy" ? (
                    <Button
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        ctx.setField(
                          "cubicAxis2",
                          orthogonalizeAxisGramSchmidt(
                            ctx.draft.cubicAxis1,
                            ctx.draft.cubicAxis2,
                          ),
                        )
                      }
                    >
                      Orthogonalize c₂ (Gram-Schmidt)
                    </Button>
                  ) : null,
              },
            ]),
        {
          id: "physics-module-provenance",
          title: "Graph provenance & dependencies",
          icon: GitBranch,
          defaultOpen: isReadOnlyModule,
          showWhen: (d) => d.provenance !== null || isReadOnlyModule,
          rows: [
            {
              type: "readonly",
              label: "Module ID",
              mono: true,
              format: (d) => d.provenance?.id ?? d.moduleId,
            },
            {
              type: "readonly",
              label: "Source path",
              mono: true,
              showWhen: (d) => Boolean(d.provenance?.sourcePath),
              format: (d) => d.provenance?.sourcePath ?? "",
            },
            {
              type: "readonly",
              label: "Applies to",
              format: (d) =>
                d.provenance?.appliesToSummary ??
                (d.scopeKind === "object" ? `Object · ${d.objectName}` : "Global"),
            },
            {
              type: "readonly",
              label: "Activation",
              format: (d) =>
                d.provenance?.activation ?? (d.enabled ? "active" : "inactive"),
            },
            {
              type: "readonly",
              label: "Capability",
              showWhen: (d) => Boolean(d.provenance?.capabilitySummary),
              format: (d) => d.provenance?.capabilitySummary ?? "",
            },
            {
              type: "chips",
              label: "Depends on",
              showWhen: (d) => (d.provenance?.dependsOn.length ?? 0) > 0,
              items: (d) =>
                (d.provenance?.dependsOn ?? []).map((depId) => ({
                  id: depId,
                  label: depId,
                })),
            },
            {
              type: "readonly",
              label: "Depends on",
              showWhen: (d) => (d.provenance?.dependsOn.length ?? 0) === 0,
              format: () => "Independent (no upstream dependencies)",
            },
          ],
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
      commitBar: isReadOnlyModule
        ? {
            mode: "readOnly",
            statusMessage: () =>
              "Read-only physics graph module projection",
          }
        : {
            mode: "staged",
            cleanMessage: () => "Hamiltonian module parameters match ProblemIR",
            lockReason: (d) => evaluateConflictOrLaneError(d),
            onApply: async (draft, base) => {
              const gateError = evaluateConflictOrLaneError(draft);
              if (gateError) {
                setMutationError(gateError);
                return false;
              }
              setMutationError(null);

              const rawSceneRev = resolveSceneResourceRevision(scene.data);
              const sceneBaseRevision =
                rawSceneRev !== null && Number.isFinite(Number(rawSceneRev))
                  ? Number(rawSceneRev)
                  : null;

              try {
                if (draft.scopeKind === "object" && draft.objectId && draft.moduleKind) {
                  const targetObjId = draft.objectId;
                  const targetKind = draft.moduleKind as ObjectInteractionKind;

                  if (!draft.present) {
                    await runAuthoringMutationWithHistory(
                      {
                        api: kernel.api,
                        authoringHistory: kernel.authoringHistory,
                        sessionScopeKey,
                      },
                      `Remove ${titleLabel}`,
                      async ({ baseRevision }) => {
                        const rev = await commitObjectInteractionMutation({
                          interactionKind: targetKind,
                          objectId: targetObjId,
                          patch: () =>
                            kernel.api.model.patchObjectInteraction(
                              targetObjId,
                              targetKind,
                              {
                                base_revision:
                                  baseRevision ??
                                  objectInteraction.data?.scene_revision ??
                                  sceneBaseRevision,
                                present: false,
                              },
                              sessionScopeKey ? { sessionScopeKey } : undefined,
                            ),
                          resources: kernel.resources,
                        });
                        kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
                        return rev;
                      },
                    );
                    return true;
                  }

                  if (draft.moduleKind === "exchange") {
                    await runAuthoringMutationWithHistory(
                      {
                        api: kernel.api,
                        authoringHistory: kernel.authoringHistory,
                        sessionScopeKey,
                      },
                      "Exchange interaction",
                      async ({ baseRevision }) => {
                        let currentRev =
                          baseRevision ??
                          objectInteraction.data?.scene_revision ??
                          sceneBaseRevision;
                        if (mat?.id && draft.aex !== base.aex) {
                          const matOptions = authoringWriteOptions(
                            currentRev,
                            sessionScopeKey,
                          );
                          const matResp = await kernel.api.model.patchMaterialAsset(
                            mat.id,
                            {
                              properties: {
                                ...(asJsonRecord(mat.properties) ?? {}),
                                Aex: draft.aex,
                              },
                            },
                            matOptions,
                          );
                          currentRev = acknowledgedAuthoringSceneRevision(matResp);
                          publishCommittedSceneResource(
                            kernel.resources,
                            matResp.committed_scene,
                            currentRev,
                            undefined,
                            true,
                            sessionScopeKey,
                            kernel.api.resourceCacheScope,
                          );
                          kernel.resources.invalidate(
                            resolveMaterialResourceKey(mat.id),
                            currentRev,
                          );
                          invalidateAuthoringMutationDependents(
                            kernel.resources,
                            "material",
                            currentRev,
                          );
                        }
                        const rev = await commitObjectInteractionMutation({
                          interactionKind: "exchange",
                          objectId: targetObjId,
                          patch: () =>
                            kernel.api.model.patchObjectInteraction(
                              targetObjId,
                              "exchange",
                              {
                                base_revision: currentRev,
                                enabled: draft.enabled,
                                present: true,
                              },
                              sessionScopeKey ? { sessionScopeKey } : undefined,
                            ),
                          resources: kernel.resources,
                        });
                        kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
                        return rev;
                      },
                    );
                    return true;
                  }

                  let params: JsonObject = {};
                  switch (draft.moduleKind) {
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
                        interface_normal: normalizeVector3(
                          draft.interfaceNormal,
                          [0, 0, 1],
                        ),
                      };
                      break;
                    case "bulk_dmi":
                      params = { dbulk: draft.dbulk };
                      break;
                    default:
                      params = {};
                  }

                  await runAuthoringMutationWithHistory(
                    {
                      api: kernel.api,
                      authoringHistory: kernel.authoringHistory,
                      sessionScopeKey,
                    },
                    `${titleLabel} interaction`,
                    async ({ baseRevision }) => {
                      const rev = await commitObjectInteractionMutation({
                        interactionKind: targetKind,
                        objectId: targetObjId,
                        patch: () =>
                          kernel.api.model.patchObjectInteraction(
                            targetObjId,
                            targetKind,
                            {
                              base_revision:
                                baseRevision ??
                                objectInteraction.data?.scene_revision ??
                                sceneBaseRevision,
                              enabled: draft.enabled,
                              present: true,
                              params,
                            },
                            sessionScopeKey ? { sessionScopeKey } : undefined,
                          ),
                        resources: kernel.resources,
                      });
                      kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
                      return rev;
                    },
                  );
                  return true;
                }

                // Study-scoped commit via canonical `merge_patch`
                const studyRec = asJsonRecord(scene.data?.study);
                const studyPatch: JsonObject = {};
                if (draft.moduleKind === "exchange") {
                  studyPatch.exchange_enabled = draft.enabled;
                } else if (draft.moduleKind === "demag") {
                  studyPatch.demag_enabled = draft.enabled;
                  studyPatch.demag_realization =
                    draft.demagRealization === "auto"
                      ? null
                      : draft.demagRealization;
                } else if (draft.moduleKind === "zeeman") {
                  studyPatch.external_field = draft.enabled
                    ? [...draft.zeemanVectorT]
                    : null;
                } else if (draft.moduleKind === "rotated_interfacial_dmi") {
                  if (!draft.enabled) {
                    studyPatch.rotated_interfacial_dmi = null;
                    if (studyRec?.rotated_interfacial_dmi_object_ids != null) {
                      studyPatch.rotated_interfacial_dmi_object_ids = null;
                    }
                  } else {
                    studyPatch.rotated_interfacial_dmi = draft.rotatedDmiD;
                  }
                } else if (draft.moduleKind === "thermal_noise") {
                  studyPatch.thermal_noise = draft.enabled
                    ? {
                        temperature: draft.temperatureK,
                        seed: draft.thermalSeed.trim()
                          ? draft.thermalSeed.trim()
                          : null,
                      }
                    : null;
                } else if (draft.moduleKind === "periodic_bc") {
                  studyPatch.pbc = draft.enabled
                    ? {
                        axes: [
                          draft.pbcAxes.includes("x") ? "periodic" : "open",
                          draft.pbcAxes.includes("y") ? "periodic" : "open",
                          draft.pbcAxes.includes("z") ? "periodic" : "open",
                        ],
                        demag: draft.pbcDemag,
                        ...(draft.pbcDemag === "truncated_images"
                          ? {
                              image_counts: [
                                draft.pbcAxes.includes("x") ? draft.pbcImagesX : 0,
                                draft.pbcAxes.includes("y") ? draft.pbcImagesY : 0,
                                draft.pbcAxes.includes("z") ? draft.pbcImagesZ : 0,
                              ],
                            }
                          : {}),
                      }
                    : null;
                }

                await runAuthoringMutationWithHistory(
                  {
                    api: kernel.api,
                    authoringHistory: kernel.authoringHistory,
                    sessionScopeKey,
                  },
                  `${titleLabel} interaction`,
                  async ({ baseRevision }) => {
                    const tx = await kernel.api.model.commitTransaction(
                      {
                        kind: "merge_patch",
                        base_revision: baseRevision ?? sceneBaseRevision ?? 0,
                        merge_patch: { study: studyPatch },
                      },
                      sessionScopeKey ? { sessionScopeKey } : undefined,
                    );
                    const rev = acknowledgedAuthoringSceneRevision(tx);
                    publishCommittedSceneResource(
                      kernel.resources,
                      tx.committed_scene,
                      rev,
                      undefined,
                      true,
                      sessionScopeKey,
                      kernel.api.resourceCacheScope,
                    );
                    invalidateAuthoringMutationDependents(
                      kernel.resources,
                      "interaction",
                      rev,
                    );
                    kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
                    return tx;
                  },
                );
                return true;
              } catch (error) {
                if (isRevisionConflict(error)) {
                  scene.refetch?.();
                  objectInteraction.refetch?.();
                  setMutationError(
                    "Scene changed while applying this interaction. Draft preserved; scene refetched. Review and retry.",
                  );
                  return false;
                }
                setMutationError(errorMessage(error));
                return false;
              }
            },
            onRevert: () => setMutationError(null),
          },
    };
  }, [
    baseline.moduleId,
    baseline.moduleKind,
    baseline.objectName,
    baseline.rawKind,
    demagOptions,
    evaluateConflictOrLaneError,
    interactionDiscretization,
    kernel.api,
    kernel.authoringHistory,
    kernel.resources,
    mat,
    mutationError,
    objectId,
    objectInteraction,
    physicsGraph,
    scene,
    scopeKind,
    sessionScopeKey,
  ]);

  return (
    <>
      <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />
      <PhysicsInteractionHelpDialog
        content={buildModuleHelpContent(
          baseline.moduleKind ?? baseline.rawKind,
          objectId,
        )}
        open={helpOpen}
        onOpenChange={setHelpOpen}
      />
    </>
  );
}

/* ── 3. CouplingInspectorPanel (`physics.coupling` — RKKY, Interlayer J1+J2, Direct Exchange) ── */

interface CouplingSpecDraft {
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

function encodeEndpointKey(
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

function decodeEndpointKey(
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

function endpointSignature(key: string, surfaceSelector: string): string {
  return key.startsWith("surface::")
    ? `${key}::${surfaceSelector.trim() || "+z"}`
    : key;
}

function formatEndpointResolutionStatus(status: string | null | undefined): string {
  if (!status || status === "resolution_unavailable") {
    return "Pending mesh resolution";
  }
  return status.replace(/_/g, " ");
}

function formatToleranceMeters(tolerance: number | null | undefined): string {
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance)) {
    return "Default solver tolerance";
  }
  return `${tolerance.toExponential(3)} m`;
}

function uniqueCouplingId(existingIds: ReadonlySet<string>): string {
  let idx = 1;
  while (existingIds.has(`coupling-${idx}`)) {
    idx += 1;
  }
  return `coupling-${idx}`;
}

export function CouplingInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const scene = useSceneResource();
  const couplingsResource = useModelCouplingsResource();
  const [mutationError, setMutationError] = useState<string | null>(null);

  const isDraftRoute = Boolean(
    selection.nodeId?.endsWith(":draft") ||
      (selection.ref?.type === "physics-coupling" && !selection.ref.couplingId),
  );

  const existingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of couplingsResource.data?.couplings ?? []) {
      if (item.coupling_id) ids.add(item.coupling_id);
    }
    for (const item of scene.data?.couplings ?? []) {
      const rec = asJsonRecord(item);
      const id = typeof rec?.coupling_id === "string" ? rec.coupling_id : typeof rec?.id === "string" ? rec.id : null;
      if (id) ids.add(id);
    }
    return ids;
  }, [couplingsResource.data?.couplings, scene.data?.couplings]);

  const requestedCouplingId = useMemo(() => {
    if (isDraftRoute) return uniqueCouplingId(existingIds);
    if (selection.ref?.type === "physics-coupling" && selection.ref.couplingId) {
      return selection.ref.couplingId;
    }
    const tail = selection.nodeId?.split(":").at(-1);
    return tail && tail !== "couplings" ? tail : uniqueCouplingId(existingIds);
  }, [existingIds, isDraftRoute, selection.nodeId, selection.ref]);

  const diagModel = useMemo(
    () =>
      resolveCouplingInspectorModel(
        selection.ref?.type === "physics-coupling"
          ? selection
          : {
              ...selection,
              ref: {
                couplingId: requestedCouplingId,
                kind: "physics.coupling",
                nodeId: selection.nodeId ?? `model:physics:couplings:${requestedCouplingId}`,
                type: "physics-coupling",
              },
            },
        couplingsResource.data ?? null,
      ),
    [couplingsResource.data, requestedCouplingId, selection],
  );

  const endpointOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const obj of scene.data?.objects ?? []) {
      if (obj.role === "airbox" || obj.role === "air" || obj.role === "antenna") continue;
      const objLabel = obj.name ?? obj.id;
      opts.push({
        value: `object::${obj.id}`,
        label: `${objLabel} (whole object)`,
      });
      for (const reg of obj.regions ?? []) {
        opts.push({
          value: `region::${obj.id}::${reg.region_id}`,
          label: `${objLabel} / ${reg.name ?? reg.region_id}`,
        });
      }
      opts.push({
        value: `surface::${obj.id}`,
        label: `${objLabel} (surface selector)`,
      });
    }
    return opts;
  }, [scene.data?.objects]);

  const matchedSceneRecord = useMemo(() => {
    for (const item of scene.data?.couplings ?? []) {
      const rec = asJsonRecord(item);
      if (rec && (rec.coupling_id === requestedCouplingId || rec.id === requestedCouplingId)) {
        return rec;
      }
    }
    return null;
  }, [requestedCouplingId, scene.data?.couplings]);

  const matchedResourceRecord = useMemo(() => {
    const list =
      couplingsResource.data?.couplings ??
      (couplingsResource.data as { items?: unknown[] } | null)?.items ??
      [];
    for (const item of list) {
      const rec = asJsonRecord(item);
      if (rec && (rec.coupling_id === requestedCouplingId || rec.id === requestedCouplingId)) {
        return rec;
      }
    }
    return null;
  }, [couplingsResource.data, requestedCouplingId]);

  const baseline = useMemo<CouplingSpecDraft>(() => {
    const objectOnlyOpts = endpointOptions.filter((o) => o.value.startsWith("object::"));
    const fallbackAObj = (objectOnlyOpts[0]?.value ?? "object::layer-a").split("::")[1]!;
    const fallbackBObj = (
      objectOnlyOpts[1]?.value ??
      objectOnlyOpts[0]?.value ??
      "object::layer-b"
    ).split("::")[1]!;

    const exists = !isDraftRoute && Boolean(matchedResourceRecord || matchedSceneRecord);
    // CRITICAL: `CouplingResource` uses `coupling_kind` & `params`; `SceneCoupling` uses `kind` & `parameters`!
    const rawKind = String(
      matchedResourceRecord?.coupling_kind ??
        matchedResourceRecord?.kind ??
        matchedSceneRecord?.kind ??
        matchedSceneRecord?.coupling_kind ??
        "rkky",
    );
    const kind: CouplingSpecDraft["kind"] =
      rawKind === "interlayer_exchange" || rawKind === "exchange" ? rawKind : "rkky";

    const params =
      asJsonRecord(
        matchedSceneRecord?.parameters ??
          matchedResourceRecord?.params ??
          matchedResourceRecord?.parameters ??
          matchedSceneRecord?.params ??
          matchedResourceRecord ??
          matchedSceneRecord,
      ) ?? {};

    const rawPolicy =
      matchedSceneRecord?.capability_policy ?? matchedResourceRecord?.capability_policy;
    const capabilityPolicy: CouplingSpecDraft["capabilityPolicy"] =
      rawPolicy === "require_runtime" || rawPolicy === "authored_only" ? rawPolicy : "";

    const encodedA = encodeEndpointKey(
      asJsonRecord(
        matchedSceneRecord?.source ??
          matchedResourceRecord?.source ??
          matchedSceneRecord?.endpoint_a ??
          matchedResourceRecord?.endpoint_a ??
          matchedSceneRecord?.side_a,
      ),
      fallbackAObj,
    );
    const encodedB = encodeEndpointKey(
      asJsonRecord(
        matchedSceneRecord?.target ??
          matchedResourceRecord?.target ??
          matchedSceneRecord?.endpoint_b ??
          matchedResourceRecord?.endpoint_b ??
          matchedSceneRecord?.side_b,
      ),
      fallbackBObj,
    );

    const hasScale = typeof params.scale === "number" && Number.isFinite(params.scale);

    return {
      couplingId: requestedCouplingId,
      exists,
      enabled: (matchedResourceRecord ?? matchedSceneRecord)?.enabled !== false,
      kind,
      capabilityPolicy,
      endpointAKey: encodedA.key,
      endpointASurfaceSelector: encodedA.surfaceSelector,
      endpointBKey: encodedB.key,
      endpointBSurfaceSelector: encodedB.surfaceSelector,
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
      hasExchangeScale: hasScale,
      exchangeScale: hasScale ? (params.scale as number) : 1,
    };
  }, [
    endpointOptions,
    isDraftRoute,
    matchedResourceRecord,
    matchedSceneRecord,
    requestedCouplingId,
  ]);

  const allEndpointOptionsFor = useCallback(
    (currentKey: string) => {
      if (endpointOptions.some((o) => o.value === currentKey)) {
        return endpointOptions;
      }
      const fallbackList =
        endpointOptions.length > 0
          ? endpointOptions
          : [
              { value: "object::layer-a", label: "Layer A (whole object)" },
              { value: "object::layer-b", label: "Layer B (whole object)" },
            ];
      if (fallbackList.some((o) => o.value === currentKey)) return fallbackList;
      return [...fallbackList, { value: currentKey, label: currentKey.replace(/::/g, " / ") }];
    },
    [endpointOptions],
  );

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
          {
            id: "coupling",
            label: baseline.exists ? baseline.couplingId : "New coupling",
          },
        ],
        searchable: false,
        extraMenuActions: [
          {
            id: "refresh-couplings",
            label: "Refresh coupling diagnostics",
            icon: RefreshCw,
            onSelect: () => {
              scene.refetch?.();
              couplingsResource.refetch?.();
              setMutationError(null);
            },
          },
        ],
        ...(baseline.exists
          ? {
              deleteAction: {
                label: "Delete Coupling",
                confirmTitle: (d) => `Delete coupling "${d.couplingId}"?`,
                confirmDescription:
                  "This removes the surface exchange / RKKY coupling between the two endpoints.",
                onDelete: async (ctx) => {
                  const rawRev =
                    couplingsResource.data?.scene_revision ??
                    resolveSceneResourceRevision(scene.data);
                  const numericRev =
                    rawRev !== null && rawRev !== undefined && Number.isFinite(Number(rawRev))
                      ? Number(rawRev)
                      : undefined;
                  const response = await runAuthoringMutationWithHistory(
                    {
                      api: kernel.api,
                      authoringHistory: kernel.authoringHistory,
                      sessionScopeKey,
                    },
                    `Delete coupling ${baseline.couplingId}`,
                    async ({ baseRevision }) => {
                      const opts = authoringWriteOptions(
                        baseRevision ?? numericRev,
                        sessionScopeKey,
                      );
                      return opts
                        ? kernel.api.model.deleteCoupling(baseline.couplingId, opts)
                        : kernel.api.model.deleteCoupling(baseline.couplingId);
                    },
                  );
                  const rev = acknowledgedAuthoringSceneRevision(response);
                  publishCommittedSceneResource(
                    kernel.resources,
                    response.committed_scene,
                    rev,
                    undefined,
                    true,
                    sessionScopeKey,
                    kernel.api.resourceCacheScope,
                  );
                  kernel.resources.invalidate(MODEL_COUPLINGS_RESOURCE_KEY, rev);
                  kernel.resources.invalidate(MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY, rev);
                  kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
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
        title: (d) =>
          d.exists ? `${d.couplingId}` : `New coupling (${d.couplingId})`,
        kindLabel: "Inter-surface magnetic coupling",
        entityId: baseline.couplingId,
        statePill: (d) => {
          if (!d.exists) return { tone: "info", label: "New draft" };
          if (diagModel.blockerReason) return { tone: "err", label: "Blocked" };
          return d.enabled
            ? { tone: "ok", label: "Active" }
            : { tone: "degraded", label: "Disabled" };
        },
      },
      facts: (d): readonly InspectorFact[] => [
        {
          id: "kind",
          label: "Model",
          value:
            d.kind === "rkky"
              ? "RKKY"
              : d.kind === "interlayer_exchange"
                ? "Interlayer J1 + J2"
                : "Direct exchange",
        },
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
              : d.kind === "interlayer_exchange"
                ? d.j1 < 0
                  ? "Antiferromagnetic J1"
                  : d.j1 > 0
                    ? "Ferromagnetic J1"
                    : "Biquadratic J2"
                : d.exchangeMode.replace(/_/g, " "),
        },
        ...(d.exists && diagModel.mode === "found"
          ? [
              {
                id: "status",
                label: "Realization",
                value: diagModel.realizationStatus.replace(/_/g, " "),
                tone: diagModel.blockerReason ? ("err" as const) : ("info" as const),
              },
            ]
          : []),
      ],
      notices: (d): readonly InspectorNotice<CouplingSpecDraft>[] => {
        const list: InspectorNotice<CouplingSpecDraft>[] = [];
        if (
          endpointSignature(d.endpointAKey, d.endpointASurfaceSelector) ===
          endpointSignature(d.endpointBKey, d.endpointBSurfaceSelector)
        ) {
          list.push({
            id: "identical-endpoints",
            tone: "err",
            title: "Distinct endpoints required",
            text: "Endpoint A and Endpoint B must reference two distinct magnetic objects, regions, or surface selectors.",
          });
        }
        if (d.exists && diagModel.blockerReason) {
          list.push({
            id: "coupling-blocker",
            tone: "err",
            title: "Coupling realization blocked",
            text: diagModel.blockerReason,
          });
        }
        if (
          !isDraftRoute &&
          !d.exists &&
          couplingsResource.status === "ready"
        ) {
          list.push({
            id: "missing-coupling",
            tone: "warn",
            text: "Selected coupling is not present in the current model resource; applying will create it.",
          });
        }
        if (mutationError) {
          list.push({
            id: "coupling-mutation-error",
            tone: "err",
            text: mutationError,
            quickFix: {
              label: "Refresh couplings",
              onApply: () => {
                scene.refetch?.();
                couplingsResource.refetch?.();
                setMutationError(null);
              },
            },
          });
        }
        return list;
      },
      sections: [
        {
          id: "coupling-endpoints",
          title: "Coupled magnetic endpoints",
          icon: Link2,
          defaultOpen: true,
          rows: [
            {
              key: "couplingId",
              type: "text",
              mono: true,
              label: "Coupling ID",
              showWhen: (d) => !d.exists,
              validate: (v, d) => {
                if (d.exists) return null;
                if (!v.trim()) return "Coupling ID is required.";
                if (existingIds.has(v.trim())) {
                  return `Coupling '${v.trim()}' already exists.`;
                }
                return null;
              },
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
              key: "capabilityPolicy",
              type: "select",
              label: "Runtime capability policy",
              options: [
                { value: "", label: "Default runtime policy" },
                { value: "require_runtime", label: "Require runtime capability" },
                { value: "authored_only", label: "Authored intent only" },
              ],
            },
            {
              key: "endpointAKey",
              type: "select",
              label: "Source endpoint (A)",
              structural: true,
              options: allEndpointOptionsFor(baseline.endpointAKey),
              validate: (v, d) =>
                endpointSignature(v, d.endpointASurfaceSelector) ===
                endpointSignature(d.endpointBKey, d.endpointBSurfaceSelector)
                  ? "Source endpoint must differ from Target endpoint."
                  : null,
            },
            {
              key: "endpointASurfaceSelector",
              type: "text",
              mono: true,
              label: "Source surface selector",
              placeholder: "+z",
              showWhen: (d) => d.endpointAKey.startsWith("surface::"),
              validate: (v, d) =>
                d.endpointAKey.startsWith("surface::") && !v.trim()
                  ? "Surface selector is required for surface endpoints."
                  : null,
            },
            {
              key: "endpointBKey",
              type: "select",
              label: "Target endpoint (B)",
              structural: true,
              options: allEndpointOptionsFor(baseline.endpointBKey),
              validate: (v, d) =>
                endpointSignature(d.endpointAKey, d.endpointASurfaceSelector) ===
                endpointSignature(v, d.endpointBSurfaceSelector)
                  ? "Target endpoint must differ from Source endpoint."
                  : null,
            },
            {
              key: "endpointBSurfaceSelector",
              type: "text",
              mono: true,
              label: "Target surface selector",
              placeholder: "-z",
              showWhen: (d) => d.endpointBKey.startsWith("surface::"),
              validate: (v, d) =>
                d.endpointBKey.startsWith("surface::") && !v.trim()
                  ? "Surface selector is required for surface endpoints."
                  : null,
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
              symbol: (
                <>
                  J<sub>RKKY</sub>
                </>
              ),
              hint: "Negative values favor antiparallel (synthetic antiferromagnet) alignment.",
              units: INTERLAYER_UNITS,
              defaultDisplayUnit: "mJ/m\u00b2",
              showWhen: (d) => d.kind === "rkky",
            },
            {
              key: "j1",
              type: "quantity",
              label: "Bilinear interlayer constant",
              symbol: (
                <>
                  J<sub>1</sub>
                </>
              ),
              units: INTERLAYER_UNITS,
              defaultDisplayUnit: "mJ/m\u00b2",
              showWhen: (d) => d.kind === "interlayer_exchange",
            },
            {
              key: "j2",
              type: "quantity",
              label: "Biquadratic 90° constant",
              symbol: (
                <>
                  J<sub>2</sub>
                </>
              ),
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
              symbol: (
                <>
                  A<sub>int</sub>
                </>
              ),
              units: EXCHANGE_UNITS,
              defaultDisplayUnit: "pJ/m",
              min: 0,
              showWhen: (d) => d.kind === "exchange" && d.exchangeMode === "explicit",
            },
            {
              key: "hasExchangeScale",
              type: "switch",
              label: "Apply dimensionless exchange scale",
              structural: true,
              showWhen: (d) => d.kind === "exchange" && d.exchangeMode !== "disabled",
            },
            {
              key: "exchangeScale",
              type: "number",
              label: "Exchange scale factor",
              step: 0.05,
              showWhen: (d) =>
                d.kind === "exchange" &&
                d.exchangeMode !== "disabled" &&
                d.hasExchangeScale,
            },
          ],
        },
        {
          id: "coupling-mesh-diagnostics",
          title: "Endpoint resolution & diagnostics",
          icon: ShieldAlert,
          defaultOpen: true,
          live: true,
          showWhen: (d) => d.exists && diagModel.mode === "found",
          rows: [
            {
              type: "readonly",
              label: "Realization status",
              format: () => diagModel.realizationStatus.replace(/_/g, " "),
            },
            {
              type: "readonly",
              label: "Runtime policy",
              format: () =>
                diagModel.realizationStatus.includes("requires")
                  ? "Requires backend capability"
                  : "Authored intent",
            },
            {
              type: "readonly",
              label: "Source resolution",
              format: () =>
                `${diagModel.source?.label ?? "Source"} (${diagModel.source?.kind ?? "object"}) · ${formatEndpointResolutionStatus(diagModel.source?.resolutionStatus)}`,
            },
            {
              type: "readonly",
              label: "Source matched faces & area",
              mono: true,
              format: () => {
                const faces =
                  diagModel.source?.resolvedFaceCount !== null &&
                  diagModel.source?.resolvedFaceCount !== undefined
                    ? `${diagModel.source.resolvedFaceCount} faces`
                    : "Faces pending";
                const area =
                  formatAreaAuto(diagModel.source?.area) ??
                  (typeof diagModel.source?.area === "number"
                    ? `${diagModel.source.area.toExponential(4)} m\u00b2`
                    : "Area pending");
                return `${faces} · ${area}`;
              },
            },
            {
              type: "readonly",
              label: "Source detail & tolerance",
              format: () =>
                `${diagModel.source?.resolutionReason ?? "No blocker"} · tol ${formatToleranceMeters(diagModel.source?.tolerance)}`,
            },
            {
              type: "readonly",
              label: "Target resolution",
              format: () =>
                `${diagModel.target?.label ?? "Target"} (${diagModel.target?.kind ?? "object"}) · ${formatEndpointResolutionStatus(diagModel.target?.resolutionStatus)}`,
            },
            {
              type: "readonly",
              label: "Target matched faces & area",
              mono: true,
              format: () => {
                const faces =
                  diagModel.target?.resolvedFaceCount !== null &&
                  diagModel.target?.resolvedFaceCount !== undefined
                    ? `${diagModel.target.resolvedFaceCount} faces`
                    : "Faces pending";
                const area =
                  formatAreaAuto(diagModel.target?.area) ??
                  (typeof diagModel.target?.area === "number"
                    ? `${diagModel.target.area.toExponential(4)} m\u00b2`
                    : "Area pending");
                return `${faces} · ${area}`;
              },
            },
            {
              type: "readonly",
              label: "Target detail & tolerance",
              format: () =>
                `${diagModel.target?.resolutionReason ?? "No blocker"} · tol ${formatToleranceMeters(diagModel.target?.tolerance)}`,
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        allowCleanApply: (d) => !d.exists,
        applyLabel: (d) => (d.exists ? "Apply" : "Create Coupling"),
        cleanMessage: () => "Surface coupling matches committed SceneDocument",
        onApply: async (draft) => {
          setMutationError(null);
          const source = decodeEndpointKey(
            draft.endpointAKey,
            draft.endpointASurfaceSelector,
          );
          const target = decodeEndpointKey(
            draft.endpointBKey,
            draft.endpointBSurfaceSelector,
          );
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
                    ...(draft.exchangeMode !== "disabled" && draft.hasExchangeScale
                      ? { scale: draft.exchangeScale }
                      : {}),
                  };

          const rawRev =
            couplingsResource.data?.scene_revision ??
            resolveSceneResourceRevision(scene.data);
          const numericRev =
            rawRev !== null && rawRev !== undefined && Number.isFinite(Number(rawRev))
              ? Number(rawRev)
              : undefined;

          try {
            if (draft.exists) {
              const patchPayload: SceneCouplingPatch = {
                enabled: draft.enabled,
                kind: draft.kind,
                source,
                target,
                parameters,
                capability_policy: draft.capabilityPolicy || null,
              };
              const tx = await runAuthoringMutationWithHistory(
                {
                  api: kernel.api,
                  authoringHistory: kernel.authoringHistory,
                  sessionScopeKey,
                },
                `Update coupling ${baseline.couplingId}`,
                async ({ baseRevision }) => {
                  const opts = authoringWriteOptions(
                    baseRevision ?? numericRev,
                    sessionScopeKey,
                  );
                  return opts
                    ? kernel.api.model.patchCoupling(
                        baseline.couplingId,
                        patchPayload,
                        opts,
                      )
                    : kernel.api.model.patchCoupling(
                        baseline.couplingId,
                        patchPayload,
                      );
                },
              );
              const rev = acknowledgedAuthoringSceneRevision(tx);
              publishCommittedSceneResource(
                kernel.resources,
                tx.committed_scene,
                rev,
                undefined,
                true,
                sessionScopeKey,
                kernel.api.resourceCacheScope,
              );
              kernel.resources.invalidate(MODEL_COUPLINGS_RESOURCE_KEY, rev);
              kernel.resources.invalidate(MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY, rev);
              kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
            } else {
              const nextId = draft.couplingId.trim();
              const createPayload: SceneCoupling = {
                coupling_id: nextId,
                enabled: draft.enabled,
                kind: draft.kind,
                source,
                target,
                parameters,
                ...(draft.capabilityPolicy
                  ? { capability_policy: draft.capabilityPolicy }
                  : {}),
              };
              const tx = await runAuthoringMutationWithHistory(
                {
                  api: kernel.api,
                  authoringHistory: kernel.authoringHistory,
                  sessionScopeKey,
                },
                `Create coupling ${nextId}`,
                async ({ baseRevision }) => {
                  const opts = authoringWriteOptions(
                    baseRevision ?? numericRev,
                    sessionScopeKey,
                  );
                  return opts
                    ? kernel.api.model.createCoupling(createPayload, opts)
                    : kernel.api.model.createCoupling(createPayload);
                },
              );
              const rev = acknowledgedAuthoringSceneRevision(tx);
              publishCommittedSceneResource(
                kernel.resources,
                tx.committed_scene,
                rev,
                undefined,
                true,
                sessionScopeKey,
                kernel.api.resourceCacheScope,
              );
              kernel.resources.invalidate(MODEL_COUPLINGS_RESOURCE_KEY, rev);
              kernel.resources.invalidate(MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY, rev);
              kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
              const createdNodeId = `model:physics:couplings:${nextId}`;
              kernel.selection.set(
                {
                  kind: "physics.coupling",
                  label: nextId,
                  nodeId: createdNodeId,
                  objectId: null,
                  ref: {
                    couplingId: nextId,
                    kind: "physics.coupling",
                    nodeId: createdNodeId,
                    type: "physics-coupling",
                  },
                },
                "inspector",
              );
            }
            return true;
          } catch (error) {
            if (isRevisionConflict(error)) {
              scene.refetch?.();
              couplingsResource.refetch?.();
              setMutationError(
                "Scene changed while applying this coupling. Draft preserved; scene refetched. Review and retry.",
              );
              return false;
            }
            setMutationError(errorMessage(error));
            return false;
          }
        },
        onRevert: () => setMutationError(null),
      },
    }),
    [
      allEndpointOptionsFor,
      baseline.couplingId,
      baseline.endpointAKey,
      baseline.endpointBKey,
      baseline.exists,
      couplingsResource,
      diagModel,
      existingIds,
      isDraftRoute,
      kernel.api,
      kernel.authoringHistory,
      kernel.resources,
      kernel.selection,
      mutationError,
      scene,
      sessionScopeKey,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
