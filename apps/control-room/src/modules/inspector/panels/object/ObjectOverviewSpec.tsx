"use client";

import {
  Activity,
  ArrowRight,
  Atom,
  Box,
  Compass,
  Eye,
  Grid3x3,
  Layers,
  LayoutGrid,
  Magnet,
  Radio,
  Shield,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

import {
  MODEL_FROZEN_SPINS_PATH,
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import type { JsonObject, ObjectMetricsResource, SceneResource } from "@/kernel/api/apiTypes";
import {
  authoringWriteOptions,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import { patchObjectGeometryTransaction } from "@/kernel/authoring/geometryLifecycleCommands";
import {
  geometryDraftGeometryEquals,
  geometryDraftTranslationEquals,
  geometryObjectEditSessionTargetKey,
  resolveCommittedGeometryObjectDraft,
} from "@/kernel/authoring/object-edit/objectEditDraftModel";
import type { ObjectEditSessionController } from "@/kernel/authoring/object-edit/ObjectEditSessionController";
import type {
  GeometryObjectDraft,
  ObjectEditSessionSnapshot,
} from "@/kernel/authoring/object-edit/objectEditTypes";
import { canonicalDraftInSelectedUnits } from "@/kernel/authoring/object-edit/quantityDraftFields";
import {
  deleteObjectWithHistory,
  patchObjectIdentityWithHistory,
} from "@/kernel/authoring/objectGeneralMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { resolveObjectExtensionsSectionModel } from "@/kernel/object-extensions/ObjectExtensionsSectionModel";
import { useObjectExtensionActivation } from "@/kernel/object-extensions/useObjectExtensionActivation";
import {
  FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY,
  frozenSpinsDefinitionResourceKey,
  useFrozenSpinsCollectionResource,
} from "@/kernel/resources/frozenSpinsResources";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  publishCommittedSceneResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useObjectMetricsResource } from "@/kernel/resources/studyRuntimeResources";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import { hasEmptyObjectMagneticModel } from "@/shared/domain/physics/objectMagneticModel";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorFact,
  InspectorNotice,
  InspectorSpec,
  InspectorTone,
} from "../../template";
import {
  buildGeometryDraftPatch,
  buildTransformDraftPatch,
  mergeGeometryDescriptor,
} from "../geometryObjectPanelModel";
import {
  buildObjectSelection,
  buildRootSelection,
  fallbackRevision,
  formatSpanAuto,
  formatVolumeAuto,
  InspectorShortcutCards,
  type InspectorShortcutCardItem,
  type SceneObjectItem as SceneObject,
  SpecInspectorHost,
} from "../model-roots/SpecInspectorHost";
import { initialAbsorbingBoundary } from "@/shared/domain/physics/absorbingBoundary";
import {
  objectEditMetadataEquals,
  rebaseDirtyDraftOntoUnchangedObject,
  reconcileObjectEditAck,
  reconcileObjectIdentityAck,
} from "../objectEditAckReconciliation";

/* ── Safe Optional `objectEditSession` Subscription ── */

const EMPTY_OBJECT_EDIT_SNAPSHOT: ObjectEditSessionSnapshot<GeometryObjectDraft> = {
  applyOperationId: null,
  dirty: false,
  draft: null,
  editVersion: 0,
  identity: null,
};
const NOOP_SUBSCRIBE = () => () => undefined;
const GET_EMPTY_SNAPSHOT = () => EMPTY_OBJECT_EDIT_SNAPSHOT;

function useOptionalObjectEditSnapshot(
  controller: ObjectEditSessionController<GeometryObjectDraft> | undefined,
): ObjectEditSessionSnapshot<GeometryObjectDraft> {
  return useSyncExternalStore(
    controller ? controller.subscribe : NOOP_SUBSCRIBE,
    controller ? controller.getSnapshot : GET_EMPTY_SNAPSHOT,
    controller ? controller.getServerSnapshot : GET_EMPTY_SNAPSHOT,
  );
}

/* ── Pure Helpers ── */

type CanonicalObjectRole = "magnetic_body" | "conductor" | "spacer_dielectric" | "antenna";

interface FormattedObjectMetrics {
  readonly statusLabel: string;
  readonly sample: string;
  readonly source: string;
  readonly magnetization: string;
  readonly exchange: string;
  readonly demag: string;
  readonly zeeman: string;
  readonly anisotropy: string;
  readonly dmi: string;
  readonly total: string;
}

interface ObjectOverviewDraft {
  objectId: string;
  exists: boolean;
  antennaWithoutMagnetization: boolean;
  name: string;
  regionName: string;
  role: CanonicalObjectRole;
  visible: boolean;
  notes: string;
  geometryKind: string;
  spanText: string | null;
  volumeText: string | null;
  materialLabel: string;
  regionCount: number;
  meshState: { tone: InspectorTone; label: string };
  hasSal: boolean;
  hasFrozenSpins: boolean;
  frozenConstraintId: string | null;
  hasTopologicalCharge: boolean;
  dependentCouplingCount: number;
  metrics: FormattedObjectMetrics;
}

function normalizeRole(sceneObj: SceneObject | undefined): CanonicalObjectRole {
  const raw = sceneObj?.role?.trim().toLowerCase() ?? "magnet";
  if (raw === "antenna") return "antenna";
  if (raw === "conductor") return "conductor";
  if (raw === "auxiliary" || raw === "spacer_dielectric") return "spacer_dielectric";
  return "magnetic_body";
}

function roleToApiValue(role: CanonicalObjectRole): string {
  if (role === "antenna") return "antenna";
  if (role === "conductor") return "conductor";
  if (role === "spacer_dielectric") return "auxiliary";
  return "magnet";
}

function roleKindLabel(role: CanonicalObjectRole): string {
  switch (role) {
    case "antenna":
      return "Antenna object";
    case "conductor":
      return "Conductor object";
    case "spacer_dielectric":
      return "Dielectric spacer";
    default:
      return "Magnetic object";
  }
}

function optionalObjectReference(value: string): string | null {
  const normalized = value.trim();
  return normalized && normalized.toLowerCase() !== "unassigned" ? normalized : null;
}

function selectorReferencesObject(selector: unknown, targetObjectId: string): boolean {
  if (!selector || typeof selector !== "object" || !targetObjectId) return false;
  const rec = selector as Record<string, unknown>;
  if (
    (rec.kind === "in_object" || rec.kind === "in_region") &&
    rec.object_id === targetObjectId
  ) {
    return true;
  }
  if (rec.kind === "not") {
    const inner = rec.expression ?? rec.operand ?? rec.selector;
    return selectorReferencesObject(inner, targetObjectId);
  }
  if (rec.kind === "and" || rec.kind === "or" || rec.kind === "xor") {
    const children = rec.expressions ?? rec.operands ?? rec.items;
    return (
      Array.isArray(children) &&
      children.some((child) => selectorReferencesObject(child, targetObjectId))
    );
  }
  return false;
}

function formatEnergyJoules(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toExponential(6)} J`
    : "\u2014";
}

function formatObjectMetrics(
  metrics: ObjectMetricsResource | null | undefined,
  fetchStatus: string,
): FormattedObjectMetrics {
  if (!metrics) {
    return {
      statusLabel: fetchStatus === "loading" ? "Loading" : "Awaiting sample",
      sample: "Initial / awaiting solver sample",
      source: "\u2014",
      magnetization: "\u2014",
      exchange: "\u2014",
      demag: "\u2014",
      zeeman: "\u2014",
      anisotropy: "\u2014",
      dmi: "\u2014",
      total: "\u2014",
    };
  }
  const step = typeof metrics.step === "number" && Number.isFinite(metrics.step) ? metrics.step : null;
  const time =
    typeof metrics.time_seconds === "number" && Number.isFinite(metrics.time_seconds)
      ? metrics.time_seconds
      : null;
  const avg = metrics.magnetization_average;
  const hasAvg =
    avg &&
    typeof avg.mx === "number" &&
    Number.isFinite(avg.mx) &&
    typeof avg.my === "number" &&
    Number.isFinite(avg.my) &&
    typeof avg.mz === "number" &&
    Number.isFinite(avg.mz);

  return {
    statusLabel: metrics.has_solver_sample ? "Computed" : "Initial",
    sample:
      step !== null && time !== null
        ? `step ${step} @ ${time.toExponential(6)} s`
        : "Initial state",
    source:
      typeof metrics.source === "string" && metrics.source.trim().length > 0
        ? metrics.source
        : "\u2014",
    magnetization: hasAvg
      ? `(${avg.mx.toFixed(6)}, ${avg.my.toFixed(6)}, ${avg.mz.toFixed(6)})`
      : "\u2014",
    exchange: formatEnergyJoules(metrics.energies?.exchange),
    demag: formatEnergyJoules(metrics.energies?.demag),
    zeeman: formatEnergyJoules(metrics.energies?.zeeman),
    anisotropy: formatEnergyJoules(metrics.energies?.anisotropy),
    dmi: formatEnergyJoules(metrics.energies?.dmi),
    total: formatEnergyJoules(metrics.energies?.total),
  };
}

function estimateGeometryMetrics(
  sceneObj: SceneObject | undefined,
): { kind: string; spanText: string | null; volumeText: string | null } {
  const geom = (sceneObj?.geometry ?? null) as Record<string, unknown> | null;
  const kind =
    (typeof geom?.geometry_kind === "string" && geom.geometry_kind) ||
    (typeof geom?.kind === "string" && geom.kind) ||
    "Primitive";
  const params = (geom?.geometry_params ?? null) as Record<string, unknown> | null;
  if (!params) {
    return { kind, spanText: null, volumeText: null };
  }
  const lower = kind.toLowerCase();
  if (lower === "box" && Array.isArray(params.size) && params.size.length >= 3) {
    const sx = Number(params.size[0]) || 0;
    const sy = Number(params.size[1]) || 0;
    const sz = Number(params.size[2]) || 0;
    return {
      kind,
      spanText: formatSpanAuto([sx, sy, sz]),
      volumeText: formatVolumeAuto(sx * sy * sz),
    };
  }
  if (lower === "cylinder" && typeof params.radius === "number" && typeof params.height === "number") {
    const r = params.radius;
    const h = params.height;
    return {
      kind,
      spanText: formatSpanAuto([2 * r, 2 * r, h]),
      volumeText: formatVolumeAuto(Math.PI * r * r * h),
    };
  }
  if (lower === "sphere" && typeof params.radius === "number") {
    const r = params.radius;
    return {
      kind,
      spanText: formatSpanAuto([2 * r, 2 * r, 2 * r]),
      volumeText: formatVolumeAuto((4 / 3) * Math.PI * r * r * r),
    };
  }
  if (lower === "ellipsoid" && Array.isArray(params.radii ?? params.size)) {
    const arr = (params.radii ?? params.size) as unknown[];
    const rx = Number(arr[0]) || 0;
    const ry = Number(arr[1]) || 0;
    const rz = Number(arr[2]) || 0;
    const isRadii = Array.isArray(params.radii);
    const span: [number, number, number] = isRadii ? [2 * rx, 2 * ry, 2 * rz] : [rx, ry, rz];
    const vol = isRadii
      ? (4 / 3) * Math.PI * rx * ry * rz
      : (Math.PI / 6) * rx * ry * rz;
    return {
      kind,
      spanText: formatSpanAuto(span),
      volumeText: formatVolumeAuto(vol),
    };
  }
  if (lower === "archwaveguide" || lower === "arch_waveguide") {
    const l = Number(params.length) || 0;
    const w = Number(params.width) || 0;
    const h = Number(params.height) || 0;
    const ah = Number(params.arch_height) || 0;
    return {
      kind: "ArchWaveguide",
      spanText: l > 0 && w > 0 && h > 0 ? formatSpanAuto([l, w, h + ah]) : null,
      volumeText: l > 0 && w > 0 && h > 0 ? formatVolumeAuto(l * w * h) : null,
    };
  }
  return { kind, spanText: null, volumeText: null };
}

function resolveMeshPill(tags: unknown): { tone: InspectorTone; label: string } {
  const list = Array.isArray(tags) ? tags : [];
  if (list.includes("validation:blocked") || list.includes("mesh:failed")) {
    return { tone: "err", label: "Mesh failed" };
  }
  if (list.includes("mesh:building")) {
    return { tone: "live", label: "Meshing" };
  }
  if (list.includes("mesh:dirty")) {
    return { tone: "stale", label: "Mesh stale" };
  }
  if (list.includes("mesh:ready")) {
    return { tone: "ok", label: "Mesh ready" };
  }
  return { tone: "info", label: "Authored" };
}

function reconcileGeneralGeometryAck(
  current: Parameters<typeof reconcileObjectEditAck>[0],
  submitted: Parameters<typeof reconcileObjectEditAck>[1],
  canonical: Parameters<typeof reconcileObjectEditAck>[2],
): ReturnType<typeof reconcileObjectEditAck> {
  return reconcileObjectEditAck(
    current,
    {
      ...submitted,
      material: canonical.material,
      name: canonical.name,
      notes: canonical.notes,
      region: canonical.region,
    },
    canonical,
  );
}

function invalidateObjectOverviewResources(
  resources: ReturnType<typeof useKernel>["resources"],
  revision: number | string,
  committedScene?: SceneResource | null,
  sessionScopeKey?: string | null,
  resourceCacheScope?: string | null,
  options?: { metadataOnly?: boolean },
): void {
  if (committedScene) {
    publishCommittedSceneResource(
      resources,
      committedScene,
      revision,
      undefined,
      true,
      sessionScopeKey,
      resourceCacheScope,
    );
  } else {
    resources.invalidate(MODEL_SCENE_PATH, revision);
  }
  if (options?.metadataOnly) {
    resources.invalidate(MODEL_SCENE_PATH, revision);
    resources.invalidate(MODEL_READINESS_PATH, revision);
    resources.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
    return;
  }
  if (typeof revision === "number") {
    invalidateAuthoringMutationDependents(resources, "geometry", revision);
  } else {
    resources.invalidate(MODEL_GEOMETRY_VALIDATION_PATH, revision);
    resources.invalidate(MODEL_GEOMETRY_DIAGNOSTICS_PATH, revision);
    resources.invalidate(MODEL_READINESS_PATH, revision);
    resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, revision);
    resources.invalidate(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY, revision);
  }
}

/* ── ObjectOverviewInspectorPanel (`object.root`) ── */

export function ObjectOverviewInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const frozenSpins = useFrozenSpinsCollectionResource({ enabled: true });
  const extensionActivation = useObjectExtensionActivation();

  const currentSessionScopeKey =
    scene.sessionScopeKey ?? kernel.commands?.getSessionScopeKey?.() ?? null;

  const objectId =
    selection.ref?.type === "scene-object"
      ? selection.ref.objectId
      : (selection.objectId ?? "");

  const sceneObject = useMemo(
    () => scene.data?.objects?.find((entry) => entry.id === objectId),
    [objectId, scene.data?.objects],
  );

  const antennaWithoutMagnetization = Boolean(
    sceneObject?.role === "antenna" && hasEmptyObjectMagneticModel(sceneObject),
  );

  const objectMetrics = useObjectMetricsResource(
    sceneObject && !antennaWithoutMagnetization ? objectId : null,
  );

  /* ── `kernel.objectEditSession` Coordination ── */
  const editSession = kernel.objectEditSession;
  const editSnapshot = useOptionalObjectEditSnapshot(editSession);
  const targetKey = geometryObjectEditSessionTargetKey(currentSessionScopeKey, {
    mode: "committed",
    objectId,
  });
  const sessionMatchesTarget = Boolean(
    editSession &&
      editSnapshot.identity?.targetKey === targetKey &&
      editSnapshot.identity?.objectId === objectId,
  );
  const editIdentity = sessionMatchesTarget ? editSnapshot.identity : null;
  const objectEditDraft = sessionMatchesTarget ? editSnapshot.draft : null;

  const canonicalGeometryDraft = useMemo(
    () =>
      sceneObject ? resolveCommittedGeometryObjectDraft(scene.data, objectId) : null,
    [objectId, scene.data, sceneObject],
  );

  useLayoutEffect(() => {
    if (!editSession || !sceneObject || !canonicalGeometryDraft) return;
    const identity = editSession.activate(
      {
        objectId,
        sessionScopeKey: currentSessionScopeKey,
        targetKey,
      },
      canonicalGeometryDraft,
    );
    const currentDraft = editSession.getSnapshot().draft;
    const sameBaseRevision =
      typeof currentDraft?.baseRevision === "number" &&
      Number.isFinite(currentDraft.baseRevision) &&
      typeof canonicalGeometryDraft.baseRevision === "number" &&
      Number.isFinite(canonicalGeometryDraft.baseRevision) &&
      currentDraft.baseRevision === canonicalGeometryDraft.baseRevision;
    const hasOnlyMetadataDrift = Boolean(
      currentDraft &&
        geometryDraftGeometryEquals(currentDraft, canonicalGeometryDraft) &&
        geometryDraftTranslationEquals(currentDraft, canonicalGeometryDraft) &&
        !objectEditMetadataEquals(currentDraft, canonicalGeometryDraft),
    );
    if (sameBaseRevision && !hasOnlyMetadataDrift) {
      return;
    }
    const nextCanonical = canonicalDraftInSelectedUnits(
      canonicalGeometryDraft,
      currentDraft ?? canonicalGeometryDraft,
    );
    if (hasOnlyMetadataDrift) {
      editSession.reset(identity, nextCanonical);
      return;
    }
    editSession.refreshCanonical(
      identity,
      nextCanonical,
      rebaseDirtyDraftOntoUnchangedObject,
    );
  }, [
    canonicalGeometryDraft,
    currentSessionScopeKey,
    editSession,
    objectId,
    sceneObject,
    targetKey,
  ]);

  const geometryDraftChanged = Boolean(
    objectEditDraft &&
      canonicalGeometryDraft &&
      !geometryDraftGeometryEquals(objectEditDraft, canonicalGeometryDraft),
  );
  const transformDraftChanged = Boolean(
    objectEditDraft &&
      canonicalGeometryDraft &&
      !geometryDraftTranslationEquals(objectEditDraft, canonicalGeometryDraft),
  );
  // `ObjectOverviewSpec` stages identity fields (`name`, `notes`, `regionName`)
  // in `useInspectorSpecController`, not in `objectEditSession`. Only staged
  // 3D placement or geometry changes belong to the placement banner / Apply
  // Placement action.
  const objectEditDraftDirty = geometryDraftChanged || transformDraftChanged;

  useEffect(() => {
    if (editSession && editIdentity) {
      editSession.setDirty(editIdentity, objectEditDraftDirty);
    }
  }, [editIdentity, editSession, objectEditDraftDirty]);

  const placementGestureActive = Boolean(
    editSession?.hasActiveGesture(currentSessionScopeKey),
  );
  const sceneWritePending = Boolean(
    editSession?.hasPendingWrite(currentSessionScopeKey),
  );
  const ownObjectApplyPending = Boolean(
    sessionMatchesTarget && editSnapshot.applyOperationId !== null,
  );
  const sceneMutationLockReason = placementGestureActive
    ? "Finish or cancel the active 3D placement gesture before applying or reverting scene changes."
    : sceneWritePending && !ownObjectApplyPending
      ? "Another scene-changing action is pending in this session."
      : null;

  const materialLabel = useMemo(() => {
    const ref = sceneObject?.material_ref?.trim();
    if (!ref) return "Unassigned";
    const found = scene.data?.materials?.find((m) => m.id === ref);
    return found?.name?.trim() || ref;
  }, [scene.data?.materials, sceneObject?.material_ref]);

  const objectFrozen = useMemo(() => {
    const definitions = frozenSpins.data?.definitions ?? [];
    // Prefer direct in_object match first, then any compound selector referencing objectId
    const direct = definitions.find((def) => {
      const sel = def.selector as Record<string, unknown> | undefined;
      return sel?.kind === "in_object" && sel.object_id === objectId;
    });
    if (direct) return direct;
    return definitions.find((def) => selectorReferencesObject(def.selector, objectId)) ?? null;
  }, [frozenSpins.data?.definitions, objectId]);

  const dependentCouplingCount = useMemo(() => {
    return (scene.data?.couplings ?? []).filter((cpl) => {
      const rec = cpl as unknown as Record<string, unknown>;
      const a = (rec.source ?? rec.endpoint_a ?? rec.side_a ?? null) as Record<
        string,
        unknown
      > | null;
      const b = (rec.target ?? rec.endpoint_b ?? rec.side_b ?? null) as Record<
        string,
        unknown
      > | null;
      return (
        a?.object === objectId ||
        b?.object === objectId ||
        a?.object_id === objectId ||
        b?.object_id === objectId
      );
    }).length;
  }, [objectId, scene.data?.couplings]);

  const extensionsModel = useMemo(
    () => resolveObjectExtensionsSectionModel(selection, extensionActivation.activation),
    [extensionActivation.activation, selection],
  );
  const hasTopologicalCharge = Boolean(
    extensionsModel.extensions.find((ext) => ext.id === "topological_charge")?.enabled,
  );

  const formattedMetrics = useMemo(
    () => formatObjectMetrics(objectMetrics.data, objectMetrics.status),
    [objectMetrics.data, objectMetrics.status],
  );

  const baseline = useMemo<ObjectOverviewDraft>(() => {
    const role = normalizeRole(sceneObject);
    const metrics = estimateGeometryMetrics(sceneObject);
    const salRec = (sceneObject?.absorbing_boundary ?? null) as Record<string, unknown> | null;
    const hasSal = Boolean(
      salRec &&
        (Array.isArray(salRec.layers) ? salRec.layers.length > 0 : Object.keys(salRec).length > 0),
    );
    const canonicalRegionName =
      typeof sceneObject?.region_name === "string" ? sceneObject.region_name : "";
    return {
      objectId,
      exists: Boolean(sceneObject),
      antennaWithoutMagnetization,
      name: sceneObject?.name?.trim() || selection.label || objectId || "Object",
      regionName: canonicalRegionName,
      role,
      visible: sceneObject?.visible !== false,
      notes: sceneObject?.notes ?? "",
      geometryKind: metrics.kind,
      spanText: metrics.spanText,
      volumeText: metrics.volumeText,
      materialLabel,
      regionCount: sceneObject?.regions?.length ?? 0,
      meshState: resolveMeshPill(sceneObject?.tags),
      hasSal,
      hasFrozenSpins: Boolean(objectFrozen && objectFrozen.enabled !== false),
      frozenConstraintId: objectFrozen?.id ?? null,
      hasTopologicalCharge,
      dependentCouplingCount,
      metrics: formattedMetrics,
    };
  }, [
    antennaWithoutMagnetization,
    dependentCouplingCount,
    formattedMetrics,
    hasTopologicalCharge,
    materialLabel,
    objectFrozen,
    objectId,
    sceneObject,
    selection.label,
  ]);

  const buildAuthoringContext = useCallback(() => {
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();
    const baseCtx = createCommandContext("inspector", kernel, {
      resourceData: scene.data ? { [MODEL_SCENE_PATH]: scene.data } : undefined,
      sourceDetail: "ObjectOverviewInspectorPanel",
      ...(currentSessionScopeKey ? { sessionScopeKey: currentSessionScopeKey } : {}),
      isCurrentSessionScope: () => {
        const activeScope = kernel.commands?.getSessionScopeKey?.();
        if (currentSessionScopeKey && activeScope && activeScope !== currentSessionScopeKey) {
          return false;
        }
        return (
          historyGeneration === undefined ||
          kernel.authoringHistory?.getGeneration?.() === historyGeneration
        );
      },
    });
    return typeof kernel.selection?.get === "function"
      ? baseCtx
      : { ...baseCtx, selection: undefined };
  }, [currentSessionScopeKey, kernel, scene.data]);

  const handleToggleSal = useCallback(
    async (enabled: boolean) => {
      if (!objectId || sceneMutationLockReason) return;
      const baseRevision = scene.data?.revision ?? null;
      const context = buildAuthoringContext();
      const updated = await runAuthoringMutationWithHistory(
        context,
        `${enabled ? "Enable" : "Disable"} absorbing boundary ${objectId}`,
        async ({ baseRevision: capturedRev }) => {
          const commitRev = capturedRev ?? baseRevision;
          return kernel.api.model.patchObject(
            objectId,
            {
              base_revision: commitRev,
              absorbing_boundary: enabled ? initialAbsorbingBoundary() : null,
            },
            authoringWriteOptions(commitRev, currentSessionScopeKey),
          );
        },
      );
      if (context.isCurrentSessionScope?.() === false) return;
      const rev = fallbackRevision(updated.revision ?? baseRevision);
      publishCommittedSceneResource(
        kernel.resources,
        updated,
        rev,
        undefined,
        false,
        currentSessionScopeKey,
        kernel.api.resourceCacheScope,
      );
      if (typeof rev === "number") {
        invalidateAuthoringMutationDependents(kernel.resources, "material", rev);
      } else {
        kernel.resources.invalidate(MODEL_SCENE_PATH, rev);
      }
    },
    [
      buildAuthoringContext,
      currentSessionScopeKey,
      kernel.api.model,
      kernel.api.resourceCacheScope,
      kernel.resources,
      objectId,
      scene.data?.revision,
      sceneMutationLockReason,
    ],
  );

  const handleToggleFrozenSpins = useCallback(
    async (enabled: boolean) => {
      if (!objectId || sceneMutationLockReason) return;
      const expectedRev = frozenSpins.data?.revision ?? scene.data?.revision ?? 0;
      const context = buildAuthoringContext();
      const reqOptions = currentSessionScopeKey
        ? { sessionScopeKey: currentSessionScopeKey }
        : undefined;

      if (objectFrozen) {
        const res = await runAuthoringMutationWithHistory(
          context,
          `${enabled ? "Enable" : "Disable"} Frozen Spins ${objectFrozen.id}`,
          async ({ baseRevision: capturedRev }) => {
            const payload = {
              expected_revision: capturedRev ?? expectedRev,
              definition: { ...objectFrozen, enabled },
            };
            return reqOptions
              ? kernel.api.model.frozenSpins.patch(objectFrozen.id, payload, reqOptions)
              : kernel.api.model.frozenSpins.patch(objectFrozen.id, payload);
          },
        );
        const nextRev = fallbackRevision(res?.revision ?? expectedRev + 1);
        kernel.resources.invalidate(MODEL_FROZEN_SPINS_PATH, nextRev);
        kernel.resources.invalidate(frozenSpinsDefinitionResourceKey(objectFrozen.id), nextRev);
        kernel.resources.invalidate(FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY, "");
      } else if (enabled) {
        const id = `frozen-${objectId}`;
        const res = await runAuthoringMutationWithHistory(
          context,
          `Create Frozen Spins ${id}`,
          async ({ baseRevision: capturedRev }) => {
            const payload = {
              expected_revision: capturedRev ?? expectedRev,
              definition: {
                id,
                name: `Frozen Spins (${sceneObject?.name ?? objectId})`,
                enabled: true,
                schema_version: "fullmag.frozen-spins.v1" as const,
                selector: { kind: "in_object" as const, object_id: objectId },
                reference: { kind: "capture_current_at_activation" as const },
                membership: { kind: "static" as const },
                activation: { kind: "all_stages" as const },
              },
            };
            return reqOptions
              ? kernel.api.model.frozenSpins.create(payload, reqOptions)
              : kernel.api.model.frozenSpins.create(payload);
          },
        );
        const nextRev = fallbackRevision(res?.revision ?? expectedRev + 1);
        kernel.resources.invalidate(MODEL_FROZEN_SPINS_PATH, nextRev);
        kernel.resources.invalidate(frozenSpinsDefinitionResourceKey(id), nextRev);
      }
    },
    [
      buildAuthoringContext,
      currentSessionScopeKey,
      frozenSpins.data?.revision,
      kernel.api.model.frozenSpins,
      kernel.resources,
      objectFrozen,
      objectId,
      scene.data?.revision,
      sceneMutationLockReason,
      sceneObject?.name,
    ],
  );

  const handleToggleTopologicalCharge = useCallback(
    (enabled: boolean) => {
      if (!objectId) return;
      extensionActivation.setEnabled(objectId, "topological_charge", enabled);
    },
    [extensionActivation, objectId],
  );

  const childCards = useMemo<readonly InspectorShortcutCardItem[]>(() => {
    if (!objectId) return [];
    if (baseline.role === "antenna") {
      return [
        {
          id: "antenna-geometry",
          icon: Box,
          domain: "geometry",
          title: "Geometry",
          subtitle: "Conductor topology & dimensions",
          badge: baseline.geometryKind,
          selection: buildObjectSelection(objectId, "object.antenna.geometry", "Geometry", {
            objectRole: "antenna",
          }),
        },
        {
          id: "antenna-root",
          icon: Radio,
          domain: "physics",
          title: "Antenna",
          subtitle: "Ports, current excitation, field solve & target projection",
          selection: buildObjectSelection(objectId, "object.antenna", "Antenna", {
            objectRole: "antenna",
          }),
        },
        {
          id: "mesh",
          icon: Grid3x3,
          domain: "mesh",
          title: "Mesh",
          subtitle: "Object mesh policy & build report",
          badge: baseline.meshState.label,
          tone: baseline.meshState.tone,
          selection: buildObjectSelection(objectId, "object.mesh", "Mesh", {
            objectRole: "antenna",
          }),
        },
        {
          id: "visualization",
          icon: Eye,
          domain: "visualization",
          title: "Visualization",
          subtitle: "3D surface, wireframe & field display",
          selection: buildObjectSelection(objectId, "object.visualization", "Visualization", {
            objectRole: "antenna",
          }),
        },
      ];
    }

    const rawInitMag = (sceneObject as Record<string, unknown> | undefined)
      ?.initial_magnetization as Record<string, unknown> | null | undefined;
    const textureKind =
      rawInitMag?.preset_kind ??
      rawInitMag?.kind ??
      (sceneObject?.magnetization_ref ? "Assigned" : "Unassigned");

    return [
      {
        id: "geometry",
          icon: Box,
          domain: "geometry",
        title: "Geometry",
        subtitle: baseline.spanText
          ? `${baseline.geometryKind} \u00b7 ${baseline.spanText}`
          : `${baseline.geometryKind} shape, transform & CSG`,
        badge: baseline.geometryKind,
        selection: buildObjectSelection(objectId, "object.geometry", "Geometry"),
      },
      {
        id: "material",
          icon: Magnet,
          domain: "material",
        title: "Material",
        subtitle: "Intrinsic magnetic, exchange, anisotropy & transport constants",
        badge: baseline.materialLabel,
        tone: baseline.materialLabel === "Unassigned" ? "warn" : "ok",
        selection: buildObjectSelection(objectId, "object.material", "Material"),
      },
      {
        id: "magnetic-texture",
          icon: Compass,
          domain: "material",
        title: "Magnetic Texture",
        subtitle: "Initial magnetization m\u2080 preset, placement & field file",
        badge: String(textureKind),
        selection: buildObjectSelection(objectId, "object.magnetic-texture", "Magnetic Texture"),
      },
      {
        id: "regions",
          icon: LayoutGrid,
          domain: "definition",
        title: "Regions",
        subtitle: "Sub-volumes, precedence stack & spatial overrides",
        badge: `${baseline.regionCount}`,
        selection: buildObjectSelection(objectId, "object.regions", "Regions"),
      },
      {
        id: "physics",
          icon: Atom,
          domain: "physics",
        title: "Physics",
        subtitle: "Active Hamiltonian interactions, spin torques & transport",
        selection: buildObjectSelection(objectId, "object.physics", "Physics"),
      },
      {
        id: "mesh",
          icon: Grid3x3,
          domain: "mesh",
        title: "Mesh",
        subtitle: "Element sizing policy & discretization quality",
        badge: baseline.meshState.label,
        tone: baseline.meshState.tone,
        selection: buildObjectSelection(objectId, "object.mesh", "Mesh"),
      },
      {
        id: "visualization",
          icon: Eye,
          domain: "visualization",
        title: "Visualization",
        subtitle: "Surface shading, vector glyphs & opacity in 3D viewport",
        selection: buildObjectSelection(objectId, "object.visualization", "Visualization"),
      },
    ];
  }, [
    baseline.geometryKind,
    baseline.materialLabel,
    baseline.meshState.label,
    baseline.meshState.tone,
    baseline.regionCount,
    baseline.role,
    baseline.spanText,
    objectId,
    sceneObject,
  ]);

  const applyPendingObjectEditSession = useCallback(
    async (canonicalScene?: SceneResource | null): Promise<boolean> => {
      if (!editSession) return true;
      const snapshot = editSession.getSnapshot();
      const identity = snapshot.identity;
      if (
        !identity ||
        identity.targetKey !== targetKey ||
        identity.objectId !== objectId ||
        !snapshot.draft
      ) {
        return true;
      }
      const applyScene = canonicalScene ?? scene.data;
      const applyCanonicalDraft = resolveCommittedGeometryObjectDraft(applyScene, objectId);
      if (!applyCanonicalDraft) return false;

      const hasGeomOrTranslationChanges =
        !geometryDraftGeometryEquals(snapshot.draft, applyCanonicalDraft) ||
        !geometryDraftTranslationEquals(snapshot.draft, applyCanonicalDraft);
      if (!hasGeomOrTranslationChanges) return true;

      const operation = editSession.beginApply(identity);
      if (!operation) return false;

      const submittedDraft = operation.submittedDraft;
      const submittedBaseRevision =
        typeof applyScene?.revision === "number"
          ? applyScene.revision
          : submittedDraft.baseRevision;
      const submittedObject = applyScene?.objects?.find(
        (candidate) => candidate.id === operation.identity.objectId,
      );
      if (
        typeof submittedBaseRevision !== "number" ||
        !Number.isFinite(submittedBaseRevision) ||
        !submittedObject?.geometry
      ) {
        editSession.reject(operation);
        throw new Error("Canonical object geometry or scene revision is unavailable.");
      }

      const submittedGeometryChanged = !geometryDraftGeometryEquals(
        submittedDraft,
        applyCanonicalDraft,
      );
      const submittedGeometry = buildGeometryDraftPatch(submittedDraft);
      if (submittedGeometryChanged && (submittedGeometry.error || !submittedGeometry.geometry)) {
        editSession.reject(operation);
        throw new Error(submittedGeometry.error ?? "Invalid geometry draft.");
      }
      const submittedTransform = buildTransformDraftPatch(
        submittedDraft,
        submittedObject.transform,
      );
      if (submittedTransform.error || !submittedTransform.transform) {
        editSession.reject(operation);
        throw new Error(submittedTransform.error ?? "Invalid transform draft.");
      }
      const submittedGeometryPayload = submittedGeometryChanged
        ? mergeGeometryDescriptor(
            submittedObject.geometry as unknown as JsonObject,
            submittedGeometry.geometry as JsonObject,
          )
        : (submittedObject.geometry as unknown as JsonObject);

      try {
        const historyContext = buildAuthoringContext();
        const reqOptions = currentSessionScopeKey
          ? { sessionScopeKey: currentSessionScopeKey }
          : undefined;
        const response = await runAuthoringMutationWithHistory(
          historyContext,
          `Edit geometry and placement ${submittedDraft.name}`,
          () =>
            patchObjectGeometryTransaction(
              kernel.api,
              operation.identity.objectId,
              {
                base_revision: submittedBaseRevision,
                geometry: submittedGeometryPayload,
                transform: submittedTransform.transform as JsonObject,
              },
              reqOptions,
            ),
        );
        if (historyContext.isCurrentSessionScope?.() === false) {
          editSession.reject(operation);
          return false;
        }
        const nextRevision = acknowledgedAuthoringSceneRevision(response);
        const resolvedAck = resolveCommittedGeometryObjectDraft(
          response.committed_scene,
          operation.identity.objectId,
        );
        if (!resolvedAck) {
          editSession.reject(operation);
          return false;
        }
        const acknowledgedDraft = {
          ...resolvedAck,
          baseRevision: nextRevision,
        };
        const acked = editSession.acknowledge(
          operation,
          acknowledgedDraft,
          reconcileGeneralGeometryAck,
          { reconcileUnchangedDraft: true },
        );
        if (!acked) return false;
        invalidateObjectOverviewResources(
          kernel.resources,
          nextRevision,
          response.committed_scene,
          currentSessionScopeKey,
          kernel.api.resourceCacheScope,
        );
        return true;
      } catch (error) {
        editSession.reject(operation);
        throw error;
      }
    },
    [
      buildAuthoringContext,
      currentSessionScopeKey,
      editSession,
      kernel.api,
      kernel.resources,
      objectId,
      scene.data,
      targetKey,
    ],
  );

  const spec = useMemo<InspectorSpec<ObjectOverviewDraft>>(
    () => ({
      id: "object.overview",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          {
            id: "objects",
            label: "Objects",
            selection: buildRootSelection("objects.root", "model:objects", "Objects"),
          },
          { id: "object", label: baseline.name },
        ],
        canFitView: baseline.exists,
        searchable: true,
        ...(baseline.exists
          ? {
              deleteAction: {
                label: "Delete Object",
                confirmTitle: (draft) => `Delete object "${draft.name}"?`,
                confirmDescription:
                  baseline.dependentCouplingCount > 0 || baseline.regionCount > 0
                    ? `Deleting "${baseline.name}" removes ${baseline.regionCount} authored region(s) and invalidates ${baseline.dependentCouplingCount} referencing coupling(s).`
                    : `Deleting "${baseline.name}" permanently removes it from the session model.`,
                onDelete: async (ctx) => {
                  if (sceneMutationLockReason) {
                    throw new Error(sceneMutationLockReason);
                  }
                  if (objectEditDraftDirty) {
                    throw new Error(
                      "Apply or revert pending geometry/placement changes before deleting this object.",
                    );
                  }
                  const mutationToken = editSession
                    ? editSession.beginSceneMutation(currentSessionScopeKey, objectId)
                    : Symbol("delete-object");
                  if (mutationToken === null) {
                    throw new Error("Another scene-changing action is pending in this session.");
                  }
                  try {
                    const context = buildAuthoringContext();
                    const response = await deleteObjectWithHistory(context, {
                      baseRevision: scene.data?.revision ?? null,
                      name: baseline.name,
                      objectId,
                    });
                    if (context.isCurrentSessionScope?.() === false) return;
                    invalidateObjectOverviewResources(
                      kernel.resources,
                      fallbackRevision(response.scene_revision),
                      response.committed_scene,
                      currentSessionScopeKey,
                      kernel.api.resourceCacheScope,
                    );
                    ctx.selectNode(
                      buildRootSelection("objects.root", "model:objects", "Objects"),
                    );
                  } finally {
                    if (editSession && typeof mutationToken === "number") {
                      editSession.endSceneMutation(mutationToken);
                    }
                  }
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "geometry",
        icon: Box,
        title: (draft) => draft.name,
        renameFieldKey: baseline.exists ? "name" : undefined,
        kindLabel: roleKindLabel(baseline.role),
        entityId: objectId || undefined,
        statePill: (draft) =>
          draft.exists ? draft.meshState : { tone: "warn", label: "Not found" },
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "shape", label: "Primitive", value: draft.geometryKind },
        { id: "span", label: "Dimensions", value: draft.spanText },
        { id: "volume", label: "Volume", value: draft.volumeText },
        {
          id: "material",
          label: "Material",
          value: draft.role === "antenna" ? null : draft.materialLabel,
          tone: draft.materialLabel === "Unassigned" ? "warn" : "ok",
        },
      ],
      notices: (draft): readonly InspectorNotice<ObjectOverviewDraft>[] => {
        const list: InspectorNotice<ObjectOverviewDraft>[] = [];
        if (!draft.exists) {
          list.push({
            id: "missing-object",
            tone: "warn",
            title: "Object not present in scene",
            text: "Select an authored object from the Objects branch or create a new primitive.",
            quickFix: {
              label: "Go to Objects",
              onApply: (ctx) =>
                ctx.selectNode(buildRootSelection("objects.root", "model:objects", "Objects")),
            },
          });
          return list;
        }
        if (objectEditDraftDirty) {
          list.push({
            id: "pending-object-edit-session",
            tone: "warn",
            title: "Uncommitted placement or geometry changes",
            text: "Staged 3D placement or geometry edits are pending on this object. Use Apply or Revert to commit or discard them.",
            quickFix: {
              label: "Inspect Geometry",
              onApply: (ctx) =>
                ctx.selectNode(
                  buildObjectSelection(
                    objectId,
                    draft.role === "antenna" ? "object.antenna.geometry" : "object.geometry",
                    "Geometry",
                  ),
                ),
            },
          });
        }
        if (draft.role === "magnetic_body" && draft.materialLabel === "Unassigned") {
          list.push({
            id: "unassigned-material",
            tone: "warn",
            title: "No magnetic material assigned",
            text: "Assign a library or custom material on the Material child node before running LLG stages.",
            quickFix: {
              label: "Open Material",
              onApply: (ctx) =>
                ctx.selectNode(buildObjectSelection(objectId, "object.material", "Material")),
            },
          });
        }
        return list;
      },
      sections: [
        {
          id: "object-identity",
          title: "Identity & physical role",
          icon: Box,
          defaultOpen: true,
          showWhen: (d) => d.exists,
          summary: (d) => `${roleKindLabel(d.role)} \u00b7 ${d.visible ? "Visible" : "Hidden"}`,
          rows: [
            {
              key: "name",
              type: "text",
              label: "Object name",
              validate: (val) => (val.trim().length === 0 ? "Object name cannot be empty." : null),
            },
            {
              key: "regionName",
              type: "text",
              label: "Region",
              placeholder: "Optional logical region tag (unassigned when empty)",
              showWhen: (d) => !d.antennaWithoutMagnetization,
            },
            {
              key: "role",
              type: "select",
              label: "Physical role",
              options: [
                { value: "magnetic_body", label: "Magnetic body (LLG spins)" },
                { value: "conductor", label: "Non-magnetic conductor (charge / spin Hall)" },
                { value: "spacer_dielectric", label: "Dielectric / spacer" },
                ...(baseline.role === "antenna"
                  ? [{ value: "antenna", label: "RF / inductive antenna" }]
                  : []),
              ],
            },
            {
              key: "visible",
              type: "switch",
              label: "Visible in 3D viewport",
            },
            {
              key: "notes",
              type: "textarea",
              label: "Notes",
              rows: 2,
              placeholder: "Optional fabrication, layer stack, or experimental reference notes",
            },
          ],
        },
        {
          id: "object-sub-resources",
          title: "Components",
          icon: Layers,
          defaultOpen: true,
          showWhen: (d) => d.exists,
          summary: () => `${childCards.length} inspectors`,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <InspectorShortcutCards items={childCards} onSelect={ctx.selectNode} />
              ),
            },
          ],
        },
        {
          id: "object-energies",
          title: "Micromagnetic energies",
          icon: Activity,
          defaultOpen: false,
          showWhen: (d) => d.exists && !d.antennaWithoutMagnetization,
          summary: (d) => `${d.metrics.statusLabel} \u00b7 Total ${d.metrics.total}`,
          rows: [
            {
              type: "readonly",
              label: "Sample",
              mono: true,
              format: (d) => d.metrics.sample,
            },
            {
              type: "readonly",
              label: "Source",
              format: (d) => `${d.metrics.source} (${d.metrics.statusLabel})`,
            },
            {
              type: "readonly",
              label: "Average m",
              mono: true,
              format: (d) => d.metrics.magnetization,
            },
            {
              type: "readonly",
              label: "Exchange",
              mono: true,
              format: (d) => d.metrics.exchange,
            },
            {
              type: "readonly",
              label: "Demag",
              mono: true,
              format: (d) => d.metrics.demag,
            },
            {
              type: "readonly",
              label: "Zeeman",
              mono: true,
              format: (d) => d.metrics.zeeman,
            },
            {
              type: "readonly",
              label: "Anisotropy",
              mono: true,
              format: (d) => d.metrics.anisotropy,
            },
            {
              type: "readonly",
              label: "DMI",
              mono: true,
              format: (d) => d.metrics.dmi,
            },
            {
              type: "readonly",
              label: "Total",
              mono: true,
              format: (d) => d.metrics.total,
            },
          ],
        },
        {
          id: "object-extensions",
          title: "Constraints & diagnostic extensions",
          icon: Shield,
          defaultOpen: true,
          live: true,
          showWhen: (d) => d.exists && d.role !== "antenna",
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="fm-extension-list" data-slot="object-extension-switches">
                  <div className="fm-extension-row">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-[var(--fm-text)]">
                          Absorbing boundary (SAL)
                        </span>
                        {ctx.draft.hasSal ? <Badge data-tone="ok">Active</Badge> : null}
                      </div>
                      <p className="fm-extension-row__hint">
                        Spatial &alpha;(r) damping ramp suppressing edge spin-wave reflections
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Switch
                        aria-label="Toggle Absorbing boundary (SAL)"
                        checked={ctx.draft.hasSal}
                        disabled={Boolean(sceneMutationLockReason)}
                        onCheckedChange={(checked) => void handleToggleSal(checked)}
                      />
                      {ctx.draft.hasSal ? (
                        <Button
                          aria-label="Configure Absorbing boundary"
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() =>
                            ctx.selectNode(
                              buildObjectSelection(
                                objectId,
                                "object.absorbing-boundary",
                                "Absorbing Boundary",
                              ),
                            )
                          }
                        >
                          <ArrowRight aria-hidden="true" size={12} />
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  <div className="fm-extension-row">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-[var(--fm-text)]">
                          Frozen spins constraint
                        </span>
                        {ctx.draft.hasFrozenSpins ? <Badge data-tone="ok">Pinned</Badge> : null}
                      </div>
                      <p className="fm-extension-row__hint">
                        Dirichlet spin pinning on object boundary or sub-volume
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Switch
                        aria-label="Toggle Frozen spins constraint"
                        checked={ctx.draft.hasFrozenSpins}
                        disabled={Boolean(sceneMutationLockReason)}
                        onCheckedChange={(checked) => void handleToggleFrozenSpins(checked)}
                      />
                      {ctx.draft.frozenConstraintId ? (
                        <Button
                          aria-label="Configure Frozen spins"
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            const cid = ctx.draft.frozenConstraintId!;
                            const nodeId = `model:object:${objectId}:frozen-spins:${encodeURIComponent(cid)}`;
                            ctx.selectNode({
                              kind: "object.frozen-spins",
                              label: "Frozen Spins",
                              nodeId,
                              objectId,
                              ref: {
                                constraintId: cid,
                                kind: "object.frozen-spins",
                                nodeId,
                                objectId,
                                type: "frozen-spins",
                              },
                            });
                          }}
                        >
                          <ArrowRight aria-hidden="true" size={12} />
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  <div className="fm-extension-row">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-[var(--fm-text)]">
                          Topological charge Q
                        </span>
                        {ctx.draft.hasTopologicalCharge ? (
                          <Badge data-tone="info">Enabled</Badge>
                        ) : null}
                      </div>
                      <p className="fm-extension-row__hint">
                        Berg-Lüscher skyrmion winding number diagnostic on 2D support
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Switch
                        aria-label="Toggle Topological charge Q"
                        checked={ctx.draft.hasTopologicalCharge}
                        onCheckedChange={handleToggleTopologicalCharge}
                      />
                      {ctx.draft.hasTopologicalCharge ? (
                        <Button
                          aria-label="Open Topological charge Q"
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() =>
                            ctx.selectNode(
                              buildObjectSelection(
                                objectId,
                                "object.extension.topological-charge",
                                "Topological Charge",
                                { extensionId: "topological-charge" },
                              ),
                            )
                          }
                        >
                          <ArrowRight aria-hidden="true" size={12} />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        allowCleanApply: () => objectEditDraftDirty,
        applyLabel: (_, dirty) =>
          !dirty && objectEditDraftDirty ? "Apply Placement" : "Apply",
        cleanMessage: () =>
          "Geometry, material, texture, and visualization are edited on their dedicated child nodes",
        lockReason: (d) => {
          if (!d.exists) return "Select an existing scene object.";
          if (sceneMutationLockReason) return sceneMutationLockReason;
          return null;
        },
        onRevert: () => {
          if (!editSession) return;
          const snapshot = editSession.getSnapshot();
          const canonicalDraft = resolveCommittedGeometryObjectDraft(scene.data, objectId);
          if (
            snapshot.identity &&
            snapshot.identity.targetKey === targetKey &&
            snapshot.draft &&
            canonicalDraft
          ) {
            editSession.reset(
              snapshot.identity,
              canonicalDraftInSelectedUnits(canonicalDraft, snapshot.draft),
            );
          }
        },
        onApply: async (draft, prev) => {
          if (!objectId || sceneMutationLockReason) return false;
          let latestScene: SceneResource | null = scene.data ?? null;
          let latestRevision: number | null = scene.data?.revision ?? null;

          const identityChanged =
            draft.name.trim() !== prev.name.trim() ||
            draft.notes !== prev.notes ||
            draft.regionName.trim() !== prev.regionName.trim();

          if (identityChanged) {
            const mutationToken = editSession
              ? editSession.beginSceneMutation(currentSessionScopeKey, objectId)
              : Symbol("identity-patch");
            if (mutationToken === null) return false;
            try {
              const context = buildAuthoringContext();
              const response = await patchObjectIdentityWithHistory(context, {
                baseRevision: latestRevision,
                name: draft.name.trim(),
                notes: draft.notes,
                objectId,
                ...(draft.regionName.trim() !== prev.regionName.trim()
                  ? { regionName: optionalObjectReference(draft.regionName) }
                  : {}),
              });
              if (context.isCurrentSessionScope?.() === false) return false;
              const nextRev = acknowledgedAuthoringSceneRevision(response);
              latestRevision = nextRev;
              latestScene = response;

              const regionChanged = draft.regionName.trim() !== prev.regionName.trim();
              if (editSession && canonicalGeometryDraft) {
                const snap = editSession.getSnapshot();
                const ackedGeomDraft = resolveCommittedGeometryObjectDraft(response, objectId);
                if (
                  snap.identity &&
                  snap.identity.targetKey === targetKey &&
                  snap.draft &&
                  ackedGeomDraft
                ) {
                  // `ObjectOverviewSpec` does not mutate metadata on `editSession.draft`;
                  // pass the submitted metadata as both `current` and `submitted` so
                  // `reconcileObjectIdentityAck` adopts the ACKed identity cleanly while
                  // still preserving any unsent geometry or placement edits from `snap.draft`.
                  const submittedIdentityDraft = {
                    ...snap.draft,
                    name: draft.name.trim(),
                    notes: draft.notes,
                    region: optionalObjectReference(draft.regionName) ?? "unassigned",
                  };
                  const reconciled = reconcileObjectIdentityAck(
                    submittedIdentityDraft,
                    submittedIdentityDraft,
                    canonicalGeometryDraft,
                    { ...ackedGeomDraft, baseRevision: nextRev },
                  );
                  editSession.updateDraft(snap.identity, () => reconciled.draft);
                  editSession.setDirty(snap.identity, reconciled.dirty);
                }
              }

              invalidateObjectOverviewResources(
                kernel.resources,
                nextRev,
                response,
                currentSessionScopeKey,
                kernel.api.resourceCacheScope,
                { metadataOnly: !regionChanged },
              );
              const nextTrimmedName = draft.name.trim();
              if (
                nextTrimmedName !== prev.name.trim() &&
                typeof kernel.selection?.get === "function" &&
                typeof kernel.selection?.set === "function"
              ) {
                const currentSel = kernel.selection.get();
                if (
                  currentSel.objectId === objectId &&
                  currentSel.kind === "object.root" &&
                  currentSel.label !== nextTrimmedName
                ) {
                  kernel.selection.set(
                    {
                      kind: currentSel.kind,
                      label: nextTrimmedName,
                      nodeId: currentSel.nodeId,
                      objectId: currentSel.objectId,
                      ref: currentSel.ref,
                    },
                    "inspector",
                  );
                }
              }
            } finally {
              if (editSession && typeof mutationToken === "number") {
                editSession.endSceneMutation(mutationToken);
              }
            }
          }

          if (draft.visible !== prev.visible) {
            const context = buildAuthoringContext();
            const updated = await runAuthoringMutationWithHistory(
              context,
              `Update visibility ${draft.name.trim()}`,
              async ({ baseRevision: capturedRev }) => {
                const commitRev = latestRevision ?? capturedRev;
                return kernel.api.model.patchObject(
                  objectId,
                  {
                    base_revision: commitRev,
                    visible: draft.visible,
                  },
                  authoringWriteOptions(commitRev, currentSessionScopeKey),
                );
              },
            );
            const revNum =
              typeof updated.revision === "number" ? updated.revision : latestRevision;
            latestRevision = revNum;
            latestScene = updated;
            invalidateObjectOverviewResources(
              kernel.resources,
              fallbackRevision(revNum),
              updated,
              currentSessionScopeKey,
              kernel.api.resourceCacheScope,
            );
          }

          if (draft.role !== prev.role) {
            const context = buildAuthoringContext();
            const reqOptions = currentSessionScopeKey
              ? { sessionScopeKey: currentSessionScopeKey }
              : undefined;
            const expectedPrevRole = roleToApiValue(prev.role);
            const nextRole = roleToApiValue(draft.role);
            const tx = await runAuthoringMutationWithHistory(
              context,
              `Change role ${draft.name.trim()}`,
              async ({ before, baseRevision: capturedRev }) => {
                // Fetch the freshest authoritative scene before constructing
                // the objects[] patch so concurrent edits to sibling objects
                // are never clobbered by stale local cache.
                let authoritativeScene: SceneResource | null | undefined =
                  latestScene ?? before ?? scene.data;
                if (typeof kernel.api.model.scene === "function") {
                  authoritativeScene = reqOptions
                    ? await kernel.api.model.scene(reqOptions)
                    : await kernel.api.model.scene();
                }
                const sourceObjects = authoritativeScene?.objects ?? [];
                const targetObject = sourceObjects.find(
                  (obj) => obj.id === objectId,
                );
                if (!targetObject) {
                  throw new Error(
                    `Object "${objectId}" no longer exists in the latest scene.`,
                  );
                }
                const currentServerRole =
                  typeof targetObject.role === "string" &&
                  targetObject.role.trim().length > 0
                    ? targetObject.role.trim().toLowerCase()
                    : "magnet";
                if (
                  currentServerRole !== expectedPrevRole &&
                  currentServerRole !== nextRole
                ) {
                  throw new Error(
                    `Revision conflict: object "${objectId}" role changed concurrently to "${currentServerRole}". Refresh and retry.`,
                  );
                }
                const commitRev =
                  typeof authoritativeScene?.revision === "number"
                    ? authoritativeScene.revision
                    : (latestRevision ?? capturedRev);
                if (typeof commitRev !== "number") {
                  throw new Error(
                    "Cannot update object role without a known scene base_revision.",
                  );
                }
                const nextObjects = sourceObjects.map((obj) =>
                  obj.id === objectId ? { ...obj, role: nextRole } : obj,
                );
                const payload = {
                  base_revision: commitRev,
                  kind: "merge_patch" as const,
                  merge_patch: { objects: nextObjects } as unknown as JsonObject,
                };
                return reqOptions
                  ? kernel.api.model.commitTransaction(payload, reqOptions)
                  : kernel.api.model.commitTransaction(payload);
              },
            );
            latestRevision = tx.scene_revision;
            latestScene = tx.committed_scene;
            invalidateObjectOverviewResources(
              kernel.resources,
              fallbackRevision(tx.scene_revision),
              tx.committed_scene,
              currentSessionScopeKey,
              kernel.api.resourceCacheScope,
            );
          }

          if (objectEditDraftDirty) {
            const geomOk = await applyPendingObjectEditSession(latestScene);
            if (!geomOk) return false;
          }

          return true;
        },
      },
    }),
    [
      applyPendingObjectEditSession,
      baseline.dependentCouplingCount,
      baseline.exists,
      baseline.name,
      baseline.regionCount,
      baseline.role,
      buildAuthoringContext,
      canonicalGeometryDraft,
      childCards,
      currentSessionScopeKey,
      editSession,
      handleToggleFrozenSpins,
      handleToggleSal,
      handleToggleTopologicalCharge,
      kernel.api,
      kernel.resources,
      kernel.selection,
      objectEditDraftDirty,
      objectId,
      scene.data,
      sceneMutationLockReason,
      targetKey,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
