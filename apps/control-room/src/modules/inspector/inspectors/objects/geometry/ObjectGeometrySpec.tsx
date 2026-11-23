"use client";

import { Combine, Grid3X3, Move3d, Shapes, Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import { deleteObjectDialogStore } from "@/kernel/authoring/deleteObjectDialogStore";
import { geometryObjectEditSessionTargetKey } from "@/kernel/authoring/object-edit/objectEditDraftModel";
import { ObjectEditSessionController } from "@/kernel/authoring/object-edit/ObjectEditSessionController";
import type { GeometryObjectDraft } from "@/kernel/authoring/object-edit/objectEditTypes";
import {
  canonicalDraftInSelectedUnits,
  updateQuantityFieldSI,
} from "@/kernel/authoring/object-edit/quantityDraftFields";
import { useObjectEditSelector } from "@/kernel/authoring/object-edit/useObjectEditSelector";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  useGeometryValidationResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionScopedResourceKey } from "@/kernel/resources/useSessionScopedResourceKey";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { parseCompositeGeometry } from "@/modules/explorer/builders/geometryTreeExplorerNodes";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import {
  rebaseGeometryObjectDraft,
  resolveGeometryObjectDraft,
  summarizeGeometryValidationMessages,
} from "../../../panels/geometryObjectPanelModel";
import {
  buildObjectSelection,
  buildRootSelection,
} from "../../../panels/model-roots/SpecInspectorHost";
import { rebaseDirtyDraftOntoUnchangedObject } from "../../../panels/objectEditAckReconciliation";
import {
  InspectorTemplate,
  useInspectorSpecController,
  type InspectorFact,
  type InspectorNotice,
  type InspectorSpec,
} from "../../../template";

import { Array3DLatticeTableSection } from "./Array3DLatticeTableSection";
import { BooleanNodeSection } from "./BooleanNodeSection";
import {
  analyzeDeleteObjectImpact,
  DeleteObjectImpactDialog,
} from "./DeleteObjectImpactDialog";
import { applyGeometryDraftMutation } from "./geometryMutations";
import {
  buildBaselineFromScene,
  computeDraftSummaryMetrics,
} from "./geometrySerialization";
import { buildGeometryShapeSections } from "./GeometryShapeSections";
import {
  applyUniformScaleChange,
  extractTranslationSIFromSessionDraft,
  normalizeScaleForUniformLock,
  vec3ApproxEqual,
  type ObjectGeometrySpecDraft,
  type RevisionConflictPhase,
} from "./geometryShared";
import {
  buildGeometryTransformAndCsgSections,
  GeometryCodePreviewDialog,
  GeometryConflictActionsBar,
  LiveDraftOverlayPublisher,
  type GeometryCodePreviewState,
} from "./GeometryTransformSections";

/* ── Shared Geometry Spec Implementation ── */

function SharedGeometrySpecPanel({
  selection,
  forceBuilderMode,
}: InspectorPanelProps & { forceBuilderMode: boolean }) {
  const kernel = useKernel();
  const fallbackEditSession = useMemo(
    () => new ObjectEditSessionController<GeometryObjectDraft>(),
    [],
  );
  const objectEditSession = kernel.objectEditSession ?? fallbackEditSession;
  const editSnapshot = useObjectEditSelector(objectEditSession);

  const { sessionIdentity } = useSessionScopedResourceKey(MODEL_SCENE_PATH);
  const scene = useSceneResource();
  const validation = useGeometryValidationResource();

  const resolveActiveScopeKey = useCallback((): string | null => {
    const commandScope = kernel.commands?.getSessionScopeKey?.() ?? null;
    const identityScope = sessionRequestScopeKey(sessionIdentity) ?? scene.sessionScopeKey ?? null;
    return identityScope ?? commandScope;
  }, [kernel.commands, scene.sessionScopeKey, sessionIdentity]);

  const currentSessionScopeKey = resolveActiveScopeKey();
  const sessionIdentityRef = useRef(sessionIdentity);
  useLayoutEffect(() => {
    sessionIdentityRef.current = sessionIdentity;
  }, [sessionIdentity]);

  const [lastOriginPivotObjectId, setLastOriginPivotObjectId] = useState<string | null>(null);
  const [ownCreatePending, setOwnCreatePending] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingObject, setDeletingObject] = useState(false);

  /* ── 409 Revision Conflict State (Derived During Render — Zero Effect Cascades) ── */
  const [revisionConflictPhase, setRevisionConflictPhase] =
    useState<RevisionConflictPhase | null>(null);
  const [conflictBaseRevision, setConflictBaseRevision] = useState<number | null>(null);
  const [refreshSawLoading, setRefreshSawLoading] = useState(false);
  const [prevConflictTargetKey, setPrevConflictTargetKey] = useState<string | null>(null);
  const preConflictSessionBaselineRef = useRef<GeometryObjectDraft | null>(null);

  const baseline = useMemo(
    () =>
      buildBaselineFromScene(
        selection,
        scene.data,
        forceBuilderMode,
        lastOriginPivotObjectId,
      ),
    [forceBuilderMode, lastOriginPivotObjectId, scene.data, selection],
  );

  const canonicalSessionDraft = useMemo(
    () =>
      baseline.mode === "committed"
        ? resolveGeometryObjectDraft(selection, scene.data)
        : null,
    [baseline.mode, scene.data, selection],
  );

  const sessionTargetKey = useMemo(
    () =>
      canonicalSessionDraft
        ? geometryObjectEditSessionTargetKey(currentSessionScopeKey, canonicalSessionDraft)
        : null,
    [canonicalSessionDraft, currentSessionScopeKey],
  );

  if (sessionTargetKey !== prevConflictTargetKey) {
    setPrevConflictTargetKey(sessionTargetKey);
    if (revisionConflictPhase !== null) setRevisionConflictPhase(null);
    if (conflictBaseRevision !== null) setConflictBaseRevision(null);
    if (refreshSawLoading) setRefreshSawLoading(false);
  }

  if (revisionConflictPhase === "refreshing") {
    if (scene.status === "loading" || scene.status === "stale") {
      if (!refreshSawLoading) setRefreshSawLoading(true);
    } else if (scene.status === "error") {
      setRevisionConflictPhase("refresh-error");
    } else if (scene.status === "ready") {
      const nextRev = typeof scene.data?.revision === "number" ? scene.data.revision : null;
      if (refreshSawLoading || (nextRev !== null && nextRev !== conflictBaseRevision)) {
        setRevisionConflictPhase("refetched");
      }
    }
  }

  const sessionMatchesTarget =
    sessionTargetKey !== null && editSnapshot.identity?.targetKey === sessionTargetKey;
  const editIdentity = sessionMatchesTarget ? editSnapshot.identity : null;
  const ownObjectApplyPending = Boolean(
    sessionMatchesTarget && editSnapshot.applyOperationId !== null,
  );
  const sceneWritePending = objectEditSession.hasPendingWrite(currentSessionScopeKey);
  const placementGestureActive = objectEditSession.hasActiveGesture(currentSessionScopeKey);
  const sceneMutationLockReason = placementGestureActive
    ? "Finish or cancel the active placement gesture before applying or reverting scene changes."
    : sceneWritePending && !ownObjectApplyPending && !ownCreatePending
      ? "Another scene-changing action is pending in this session."
      : null;

  useEffect(() => {
    if (revisionConflictPhase === null) {
      preConflictSessionBaselineRef.current = null;
    }
  }, [revisionConflictPhase]);

  const validationMessages = useMemo(
    () =>
      baseline.mode === "committed"
        ? summarizeGeometryValidationMessages(validation.data, baseline.objectId)
        : [],
    [baseline.mode, baseline.objectId, validation.data],
  );

  const otherObjects = useMemo(
    () =>
      (scene.data?.objects ?? [])
        .filter((o) => o.id !== baseline.objectId && o.role !== "airbox" && o.role !== "air")
        .map((o) => ({
          value: o.id,
          label: `${o.name ?? o.id} (${o.id})`,
        })),
    [baseline.objectId, scene.data?.objects],
  );

  const materialOptions = useMemo(
    () =>
      (scene.data?.materials ?? []).map((mat) => ({
        id: mat.id,
        label: mat.name?.trim() ? `${mat.name} (${mat.id})` : mat.id,
      })),
    [scene.data?.materials],
  );

  const createDraftSlugId = useCallback((draft: ObjectGeometrySpecDraft) => {
    const slug = draft.draftName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return `${slug || draft.primitiveKind.toLowerCase()}-${Date.now().toString(36)}`;
  }, []);

  const lastSyncedEditVersionRef = useRef<number>(-1);
  const lastSyncedTargetKeyRef = useRef<string | null>(null);
  const requestApplyRef = useRef<() => Promise<boolean>>(async () => false);
  const acknowledgeCommittedRef = useRef<() => void>(() => undefined);

  const handleRefetchConflict = useCallback(() => {
    setRefreshSawLoading(false);
    setRevisionConflictPhase("refreshing");
    scene.refetch?.();
  }, [scene]);

  const handleRebaseConflict = useCallback(() => {
    if (editIdentity && canonicalSessionDraft && preConflictSessionBaselineRef.current) {
      const snap = objectEditSession.getSnapshot();
      const currentSessionDraft = snap.draft ?? canonicalSessionDraft;
      const rebasedSessionDraft = rebaseGeometryObjectDraft(
        currentSessionDraft,
        canonicalDraftInSelectedUnits(canonicalSessionDraft, currentSessionDraft),
        preConflictSessionBaselineRef.current,
      );
      objectEditSession.updateDraft(editIdentity, () => rebasedSessionDraft);
      lastSyncedEditVersionRef.current = objectEditSession.getSnapshot().editVersion;
    }
    setRevisionConflictPhase("rebased");
  }, [canonicalSessionDraft, editIdentity, objectEditSession]);

  const handleRetryConflictApply = useCallback(() => {
    void requestApplyRef.current();
  }, []);

  const spec = useMemo<InspectorSpec<ObjectGeometrySpecDraft>>(
    () => ({
      id: forceBuilderMode ? "builder.primitive" : "object.geometry",
      header: {
        breadcrumbs:
          baseline.mode === "draft-new"
            ? [
                {
                  id: "objects",
                  label: "Objects",
                  selection: buildRootSelection("objects.root", "model:objects", "Objects"),
                },
                { id: "draft", label: baseline.draftName },
              ]
            : [
                {
                  id: "objects",
                  label: "Objects",
                  selection: buildRootSelection("objects.root", "model:objects", "Objects"),
                },
                {
                  id: "object",
                  label: baseline.draftName,
                  selection: buildObjectSelection(
                    baseline.objectId,
                    "object.root",
                    baseline.draftName,
                  ),
                },
                { id: "geometry", label: "Geometry" },
              ],
        canFitView: baseline.mode === "committed",
        searchable: true,
      },
      identity: {
        domain: "geometry",
        icon: Shapes,
        title: (draft) =>
          draft.mode === "draft-new"
            ? draft.draftName
            : draft.compositeSummary
              ? draft.compositeSummary.displayLabel
              : `${draft.primitiveKind} Geometry`,
        renameFieldKey: baseline.mode === "draft-new" ? "draftName" : undefined,
        kindLabel:
          baseline.mode === "draft-new"
            ? "Primitive builder draft"
            : baseline.compositeSummary
              ? baseline.compositeSummary.op === "array"
                ? "Array 3D lattice geometry"
                : "Composite CSG geometry"
              : "Parametric solid geometry",
        entityId: baseline.mode === "committed" ? baseline.objectId : undefined,
        statePill: (draft) => draft.meshStatusPill,
      },
      facts: (draft): readonly InspectorFact[] => {
        const metrics = computeDraftSummaryMetrics(draft);
        if (draft.compositeSummary) {
          const summary = draft.compositeSummary;
          return [
            { id: "kind", label: "Geometry", value: summary.kind },
            summary.op === "array"
              ? {
                  id: "instances",
                  label: "Instances",
                  value: `${(summary.instanceCount ?? 1).toLocaleString()} (${summary.dimensionsLabel ?? "1×1×1"})`,
                }
              : {
                  id: "operands",
                  label: "Operands",
                  value: `${summary.enabledOperandCount} / ${summary.operandCount}`,
                },
            { id: "span", label: "Bounding span", value: metrics.spanText },
          ];
        }
        return [
          { id: "kind", label: "Primitive", value: draft.primitiveKind },
          { id: "span", label: "Bounding span", value: metrics.spanText },
          { id: "volume", label: "Volume", value: metrics.volumeText },
        ];
      },
      modeTabs: [
        { id: "shape", label: "Shape", icon: Shapes },
        { id: "transform", label: "Transform", icon: Move3d },
        { id: "csg", label: "Boolean CSG", icon: Combine },
      ],
      notices: (draft): readonly InspectorNotice<ObjectGeometrySpecDraft>[] => {
        const list: InspectorNotice<ObjectGeometrySpecDraft>[] = [];
        if (revisionConflictPhase !== null) {
          list.push({
            id: "scene-revision-conflict",
            tone: revisionConflictPhase === "rebased" ? "warn" : "err",
            title: "Scene revision conflict",
            text:
              revisionConflictPhase === "rebased"
                ? "Draft rebased onto the latest scene revision. Click Retry Apply to commit."
                : revisionConflictPhase === "refetched"
                  ? "Latest scene fetched. Click Rebase Draft to merge your edits onto the updated revision."
                  : revisionConflictPhase === "refresh-error"
                    ? "Scene refetch failed. Retry Refetch Scene before rebasing."
                    : "The scene changed while this geometry edit was staged. Refetch and rebase before retrying.",
            quickFix:
              revisionConflictPhase === "conflict" || revisionConflictPhase === "refresh-error"
                ? {
                    label: "Refetch Scene",
                    onApply: () => handleRefetchConflict(),
                  }
                : revisionConflictPhase === "refetched"
                  ? {
                      label: "Rebase Draft",
                      onApply: () => handleRebaseConflict(),
                    }
                  : revisionConflictPhase === "rebased"
                    ? {
                        label: "Retry Apply",
                        onApply: handleRetryConflictApply,
                      }
                    : undefined,
          });
        }
        if (draft.mode === "committed" && draft.hasRealizedOrDirtyMesh) {
          list.push({
            id: "mesh-stale-warning",
            tone: "warn",
            title: "Geometry edits invalidate realized mesh",
            text: "Applying new dimensions or transforms marks the object mesh stale until rebuilt.",
          });
        }
        for (const [idx, msg] of validationMessages.entries()) {
          list.push({
            id: `geom-validation-${idx}`,
            tone: "err",
            title: "Geometry validation diagnostic",
            text: msg,
          });
        }
        return list;
      },
      sections: [
        {
          id: "geometry-revision-conflict-actions",
          title: "Revision conflict recovery",
          icon: Shapes,
          defaultOpen: true,
          showWhen: () => revisionConflictPhase !== null,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <GeometryConflictActionsBar
                  revisionConflictPhase={revisionConflictPhase}
                  onRebaseConflict={handleRebaseConflict}
                  onRefetchConflict={handleRefetchConflict}
                  onRetryApply={handleRetryConflictApply}
                />
              ),
            },
          ],
        },
        ...buildGeometryShapeSections({ materialOptions }),
        ...buildGeometryTransformAndCsgSections({ otherObjects }),
        {
          id: "geometry-csg-operand-stack",
          modeTabId: "csg",
          title: "Boolean operand stack",
          icon: Combine,
          defaultOpen: true,
          showWhen: (d) => {
            if (d.mode !== "committed") return false;
            const obj = scene.data?.objects?.find((item) => item.id === d.objectId);
            return parseCompositeGeometry(obj?.geometry).operands.length > 0;
          },
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <BooleanNodeSection
                  kernel={kernel}
                  objectId={ctx.draft.objectId}
                  sceneData={scene.data}
                  sessionScopeKey={currentSessionScopeKey}
                />
              ),
            },
          ],
        },
        {
          id: "geometry-array-3d-lattice",
          modeTabId: "csg",
          title: "Array 3D lattice",
          icon: Grid3X3,
          defaultOpen: false,
          showWhen: (d) => d.mode === "committed",
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <Array3DLatticeTableSection
                  kernel={kernel}
                  objectId={ctx.draft.objectId}
                  sceneData={scene.data}
                  sessionScopeKey={currentSessionScopeKey}
                />
              ),
            },
          ],
        },
        {
          id: "geometry-object-danger-actions",
          modeTabId: "shape",
          title: "Object lifecycle",
          icon: Trash2,
          defaultOpen: false,
          showWhen: (d) => d.mode === "committed",
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-[var(--fm-text-muted)]">
                    Inspect dependent couplings, regions, and CSG links before deletion.
                  </span>
                  <Button
                    className="shrink-0 whitespace-nowrap"
                    disabled={Boolean(sceneMutationLockReason) || deletingObject}
                    size="sm"
                    type="button"
                    variant="danger"
                    onClick={() => {
                      if (deleteObjectDialogStore.hasHost()) {
                        void kernel.commands.execute(
                          "geometry.delete-object",
                          createCommandContext("inspector", kernel, {
                            input: { objectId: baseline.objectId },
                            resourceData: { [MODEL_SCENE_PATH]: scene.data },
                            sessionScopeKey: currentSessionScopeKey,
                          }),
                        );
                      } else {
                        setDeleteDialogOpen(true);
                      }
                    }}
                  >
                    <Trash2 size={13} />
                    <span>Delete Object…</span>
                  </Button>
                </div>
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        allowCleanApply: (d) => d.mode === "draft-new",
        cleanMessage: (d) =>
          d.mode === "draft-new"
            ? "Adjust dimensions and click Apply to create the scene object"
            : "Parametric geometry matches committed SceneDocument",
        lockReason: (d) => {
          if (d.mode === "missing") {
            return "Select an existing object or start a primitive draft.";
          }
          if (sceneMutationLockReason) {
            return sceneMutationLockReason;
          }
          if (revisionConflictPhase !== null && revisionConflictPhase !== "rebased") {
            return "Resolve the scene revision conflict before applying this draft.";
          }
          return null;
        },
        onRevert: () => {
          setRevisionConflictPhase(null);
          setConflictBaseRevision(null);
          setRefreshSawLoading(false);
          preConflictSessionBaselineRef.current = null;
          if (editIdentity && canonicalSessionDraft) {
            const currentDraft = objectEditSession.getSnapshot().draft ?? canonicalSessionDraft;
            objectEditSession.reset(
              editIdentity,
              canonicalDraftInSelectedUnits(canonicalSessionDraft, currentDraft),
            );
            lastSyncedEditVersionRef.current = objectEditSession.getSnapshot().editVersion;
          }
        },
        onApply: (draft) =>
          applyGeometryDraftMutation({
            baseline,
            draft,
            kernel,
            selection,
            sceneData: scene.data,
            sceneSessionScopeKey: scene.sessionScopeKey,
            getLatestSessionIdentity: () => sessionIdentityRef.current,
            resolveActiveScopeKey,
            objectEditSession,
            editIdentity,
            canonicalSessionDraft,
            createDraftSlugId,
            onSyncEditVersion: (editVersion) => {
              lastSyncedEditVersionRef.current = editVersion;
            },
            onAcknowledgeCommitted: () => {
              acknowledgeCommittedRef.current();
            },
            onSetOwnCreatePending: setOwnCreatePending,
            onCommittedSuccess: (originPivotObjectId) => {
              setLastOriginPivotObjectId(originPivotObjectId);
              setRevisionConflictPhase(null);
              setConflictBaseRevision(null);
              preConflictSessionBaselineRef.current = null;
            },
            onRevisionConflict: (sceneRevision, preConflictBaseline) => {
              if (preConflictBaseline !== null) {
                preConflictSessionBaselineRef.current = preConflictBaseline;
              }
              setConflictBaseRevision(sceneRevision);
              setRefreshSawLoading(false);
              setRevisionConflictPhase("conflict");
            },
          }),
      },
    }),
    [
      baseline,
      canonicalSessionDraft,
      createDraftSlugId,
      currentSessionScopeKey,
      deletingObject,
      editIdentity,
      forceBuilderMode,
      handleRebaseConflict,
      handleRefetchConflict,
      handleRetryConflictApply,
      kernel,
      materialOptions,
      objectEditSession,
      otherObjects,
      resolveActiveScopeKey,
      revisionConflictPhase,
      scene.data,
      scene.sessionScopeKey,
      sceneMutationLockReason,
      selection,
      validationMessages,
    ],
  );

  const controller = useInspectorSpecController(spec, selection, baseline);

  useLayoutEffect(() => {
    requestApplyRef.current = controller.requestApply;
    acknowledgeCommittedRef.current = controller.acknowledgeCommitted;
  }, [controller.acknowledgeCommitted, controller.requestApply]);

  /* ── Activate & Reconcile objectEditSession + Sync 3D Gizmo Translation Into Controller ── */
  const controllerDraftRef = useRef(controller.draft);
  useLayoutEffect(() => {
    controllerDraftRef.current = controller.draft;
  }, [controller.draft]);

  useLayoutEffect(() => {
    if (!canonicalSessionDraft || !sessionTargetKey) return;
    const identity = objectEditSession.activate(
      {
        objectId: canonicalSessionDraft.objectId,
        sessionScopeKey: currentSessionScopeKey,
        targetKey: sessionTargetKey,
      },
      canonicalSessionDraft,
    );
    const currentSnap = objectEditSession.getSnapshot();
    if (
      !Number.isFinite(canonicalSessionDraft.baseRevision) ||
      currentSnap.draft?.baseRevision !== canonicalSessionDraft.baseRevision
    ) {
      objectEditSession.refreshCanonical(
        identity,
        canonicalDraftInSelectedUnits(
          canonicalSessionDraft,
          currentSnap.draft ?? canonicalSessionDraft,
        ),
        rebaseDirtyDraftOntoUnchangedObject,
      );
    }

    const latestSnap = objectEditSession.getSnapshot();
    if (
      latestSnap.identity?.draftId === identity.draftId &&
      latestSnap.draft &&
      latestSnap.draft.mode === "committed"
    ) {
      const targetChanged = lastSyncedTargetKeyRef.current !== sessionTargetKey;
      const versionChanged = latestSnap.editVersion !== lastSyncedEditVersionRef.current;
      if (targetChanged || versionChanged) {
        lastSyncedTargetKeyRef.current = sessionTargetKey;
        lastSyncedEditVersionRef.current = latestSnap.editVersion;
        const sessionTranslation = extractTranslationSIFromSessionDraft(latestSnap.draft);
        if (
          sessionTranslation &&
          !vec3ApproxEqual(sessionTranslation, controllerDraftRef.current.translation)
        ) {
          controller.setField("translation", sessionTranslation);
        }
      }
    }
  }, [
    canonicalSessionDraft,
    controller,
    currentSessionScopeKey,
    editSnapshot.editVersion,
    objectEditSession,
    sessionTargetKey,
  ]);

  /* ── Sync Inspector Dirty Flag Into objectEditSession (Compute & Delete Guards) ── */
  useEffect(() => {
    if (!editIdentity || baseline.mode !== "committed") return;
    const snap = objectEditSession.getSnapshot();
    if (snap.editVersion !== lastSyncedEditVersionRef.current) return;
    objectEditSession.setDirty(editIdentity, controller.dirty);
  }, [baseline.mode, controller.dirty, editIdentity, objectEditSession]);

  /* ── Coupled Field Change Handler (uniformScale + live 3D Placement Preview) ── */
  const pushTranslationToSession = useCallback(
    (nextTranslation: readonly [number, number, number]) => {
      if (!editIdentity || baseline.mode !== "committed") return;
      objectEditSession.updateDraft(editIdentity, (current) =>
        ([0, 1, 2] as const).reduce(
          (next, axis) =>
            updateQuantityFieldSI(next, `translation.${axis}`, nextTranslation[axis]),
          current,
        ),
      );
      lastSyncedEditVersionRef.current = objectEditSession.getSnapshot().editVersion;
    },
    [baseline.mode, editIdentity, objectEditSession],
  );

  const handleFieldChange = useCallback(
    <K extends keyof ObjectGeometrySpecDraft & string>(
      key: K,
      value: ObjectGeometrySpecDraft[K],
    ) => {
      if (key === "scale") {
        const nextScale = applyUniformScaleChange(
          controller.draft.scale,
          value as readonly [number, number, number],
          controller.draft.uniformScale,
        );
        controller.setField("scale", nextScale);
        return;
      }
      if (key === "uniformScale") {
        const enabled = Boolean(value);
        if (enabled) {
          const normalized = normalizeScaleForUniformLock(controller.draft.scale);
          controller.patchDraft({
            uniformScale: true,
            ...(vec3ApproxEqual(normalized, controller.draft.scale)
              ? {}
              : { scale: normalized }),
          });
        } else {
          controller.setField("uniformScale", false);
        }
        return;
      }
      if (key === "translation") {
        const nextVec = value as readonly [number, number, number];
        controller.setField("translation", nextVec);
        pushTranslationToSession(nextVec);
        return;
      }
      controller.setField(key, value);
    },
    [controller, pushTranslationToSession],
  );

  const handlePatchDraft = useCallback(
    (partial: Partial<ObjectGeometrySpecDraft>) => {
      controller.patchDraft(partial);
      if (partial.translation) {
        pushTranslationToSession(partial.translation);
      }
    },
    [controller, pushTranslationToSession],
  );

  const handleRevertField = useCallback(
    (fieldKey: string) => {
      controller.revertField(fieldKey);
      if (fieldKey === "translation") {
        pushTranslationToSession(controller.baseline.translation);
      }
    },
    [controller, pushTranslationToSession],
  );

  const handleRevertAll = useCallback(() => {
    if (
      placementGestureActive ||
      (sceneWritePending && !ownObjectApplyPending && !ownCreatePending)
    ) {
      return;
    }
    controller.revertAll();
  }, [
    controller,
    ownCreatePending,
    ownObjectApplyPending,
    placementGestureActive,
    sceneWritePending,
  ]);

  /* ── Standard Chrome Callbacks & Code Preview Dialog ── */
  const [codePreview, setCodePreview] = useState<GeometryCodePreviewState | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [statusToast, setStatusToast] = useState<string | null>(null);

  const handleSelectNode = useCallback(
    (next: Omit<Selection, "moduleSource">) => {
      kernel.selection.set(next, "inspector");
    },
    [kernel.selection],
  );

  const handleFitView = useCallback(
    (commandId?: Parameters<typeof kernel.commands.execute>[0]) => {
      const resolvedId = commandId ?? "viewport-3d.fit-selection";
      void kernel.commands.execute(resolvedId, createCommandContext("inspector", kernel));
    },
    [kernel],
  );

  const handleHideInspector = useCallback(() => {
    kernel.layout.setPanelVisible("right", false);
  }, [kernel.layout]);

  const handleOpenCodePreview = useCallback(
    (title: string, language: "python" | "json", code: string) => {
      setCopiedCode(false);
      setCodePreview({ title, language, code });
    },
    [],
  );

  const handleNotify = useCallback((title: string, description?: string) => {
    setStatusToast(description ? `${title}: ${description}` : title);
  }, []);

  const handleCopyCodePreview = useCallback(() => {
    if (codePreview) {
      void navigator.clipboard?.writeText(codePreview.code).catch(() => undefined);
      setCopiedCode(true);
    }
  }, [codePreview]);

  const deleteImpact = useMemo(
    () => analyzeDeleteObjectImpact(scene.data, baseline.objectId),
    [baseline.objectId, scene.data],
  );

  const handleConfirmDeleteObject = useCallback(async () => {
    if (deletingObject || baseline.mode !== "committed") return;
    setDeletingObject(true);
    try {
      await kernel.commands.execute(
        "geometry.delete-object",
        createCommandContext("inspector", kernel, {
          input: { confirmed: true, objectId: baseline.objectId },
          resourceData: { [MODEL_SCENE_PATH]: scene.data },
          sessionScopeKey: currentSessionScopeKey,
        }),
      );
      setDeleteDialogOpen(false);
    } finally {
      setDeletingObject(false);
    }
  }, [baseline.mode, baseline.objectId, currentSessionScopeKey, deletingObject, kernel, scene.data]);

  return (
    <>
      {controller.draft.mode === "draft-new" ? (
        <LiveDraftOverlayPublisher
          baseline={controller.baseline}
          draft={controller.draft}
          invalidFields={controller.invalidFields}
        />
      ) : null}

      <InspectorTemplate
        activeModeTabId={controller.activeModeTabId}
        animationKey={controller.animationKey}
        appliedFlash={controller.appliedFlash}
        applyError={controller.applyError}
        applying={controller.applying}
        baseline={controller.baseline}
        dirtyFields={controller.dirtyFields}
        displayUnits={controller.displayUnits}
        draft={controller.draft}
        forceShowErrors={controller.forceShowErrors}
        invalidFields={controller.invalidFields}
        selection={selection}
        spec={spec}
        touchedFields={controller.touchedFields}
        onActiveModeTabChange={controller.setActiveModeTabId}
        onApply={controller.requestApply}
        onDisplayUnitChange={controller.setDisplayUnit}
        onFieldChange={handleFieldChange}
        onFieldTouch={controller.touchField}
        onFitView={handleFitView}
        onFocusField={(key) => controller.focusField(key as keyof ObjectGeometrySpecDraft & string)}
        onHideInspector={handleHideInspector}
        onNotify={handleNotify}
        onOpenCodePreview={handleOpenCodePreview}
        onParseErrorChange={controller.setParseError}
        onPatchDraft={handlePatchDraft}
        onResetDisplay={controller.resetDisplay}
        onRevertAll={handleRevertAll}
        onRevertField={handleRevertField}
        onSelectNode={handleSelectNode}
      />

      {statusToast ? (
        <span className="sr-only" role="status">
          {statusToast}
        </span>
      ) : null}

      <GeometryCodePreviewDialog
        codePreview={codePreview}
        copiedCode={copiedCode}
        onClose={() => setCodePreview(null)}
        onCopy={handleCopyCodePreview}
      />

      {baseline.mode === "committed" ? (
        <DeleteObjectImpactDialog
          deleting={deletingObject}
          impact={deleteImpact}
          open={deleteDialogOpen}
          onConfirmDelete={() => {
            void handleConfirmDeleteObject();
          }}
          onOpenChange={setDeleteDialogOpen}
        />
      ) : null}
    </>
  );
}

export function GeometryObjectInspectorPanel(props: InspectorPanelProps) {
  return <SharedGeometrySpecPanel {...props} forceBuilderMode={false} />;
}

export function BuilderPrimitiveInspectorPanel(props: InspectorPanelProps) {
  return <SharedGeometrySpecPanel {...props} forceBuilderMode={true} />;
}
