import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { SceneResource } from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import {
  createObjectTransaction,
  patchObjectGeometryTransaction,
  primitiveDraftOverlayStore,
} from "@/kernel/authoring/geometryLifecycleCommands";
import { resolveCommittedGeometryObjectDraft } from "@/kernel/authoring/object-edit/objectEditDraftModel";
import type { ObjectEditSessionController } from "@/kernel/authoring/object-edit/ObjectEditSessionController";
import type {
  GeometryObjectDraft,
  ObjectEditSessionIdentity,
} from "@/kernel/authoring/object-edit/objectEditTypes";
import { updateQuantityFieldSI } from "@/kernel/authoring/object-edit/quantityDraftFields";
import { resolveDraftObjectName } from "@/kernel/authoring/uniqueObjectName";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import type { KernelApi } from "@/kernel/types";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import { isPrimitiveDraftRevisionConflict } from "../../../panels/geometryObjectPanelModel";
import { buildObjectSelection } from "../../../panels/model-roots/SpecInspectorHost";
import { reconcileObjectEditAck } from "../../../panels/objectEditAckReconciliation";

import {
  serializeGeometryPayload,
  serializeTransformPayload,
} from "./geometrySerialization";
import {
  resolveDefaultDraftBaseName,
  type ObjectGeometrySpecDraft,
} from "./geometryShared";

export interface ApplyGeometryDraftParams {
  baseline?: ObjectGeometrySpecDraft | null;
  draft: ObjectGeometrySpecDraft;
  kernel: KernelApi;
  selection: InspectorPanelProps["selection"];
  sceneData: SceneResource | null | undefined;
  sceneSessionScopeKey: string | null | undefined;
  getLatestSessionIdentity: () => Parameters<typeof sessionRequestScopeKey>[0];
  resolveActiveScopeKey: () => string | null;
  objectEditSession: ObjectEditSessionController<GeometryObjectDraft>;
  editIdentity: ObjectEditSessionIdentity | null;
  canonicalSessionDraft: GeometryObjectDraft | null;
  createDraftSlugId: (draft: ObjectGeometrySpecDraft) => string;
  onSyncEditVersion: (editVersion: number) => void;
  onAcknowledgeCommitted?: () => void;
  onSetOwnCreatePending: (pending: boolean) => void;
  onCommittedSuccess: (originPivotObjectId: string | null) => void;
  onRevisionConflict: (
    sceneRevision: number | null,
    preConflictBaseline: GeometryObjectDraft | null,
  ) => void;
}

export async function applyGeometryDraftMutation({
  baseline,
  draft,
  kernel,
  selection,
  sceneData,
  sceneSessionScopeKey,
  getLatestSessionIdentity,
  resolveActiveScopeKey,
  objectEditSession,
  editIdentity,
  canonicalSessionDraft,
  createDraftSlugId,
  onSyncEditVersion,
  onAcknowledgeCommitted,
  onSetOwnCreatePending,
  onCommittedSuccess,
  onRevisionConflict,
}: ApplyGeometryDraftParams): Promise<boolean> {
  const geometry = serializeGeometryPayload(draft);
  const committedObject =
    draft.mode === "committed"
      ? sceneData?.objects?.find((item) => item.id === draft.objectId) ?? null
      : null;
  const existingTransform =
    committedObject?.transform &&
    typeof committedObject.transform === "object" &&
    !Array.isArray(committedObject.transform)
      ? (committedObject.transform as Record<string, unknown>)
      : null;
  const transform = serializeTransformPayload(
    draft,
    existingTransform,
    baseline ?? null,
  );
  const capturedScopeKey = resolveActiveScopeKey();
  const capturedCommandScopeKey = kernel.commands?.getSessionScopeKey?.();
  const historyGeneration = kernel.authoringHistory?.getGeneration?.();

  const isCurrentSessionScope = () => {
    const activeIdentityScope =
      sessionRequestScopeKey(getLatestSessionIdentity()) ?? sceneSessionScopeKey ?? null;
    const activeCommandScope = kernel.commands?.getSessionScopeKey?.();
    const activeScope = activeIdentityScope ?? activeCommandScope ?? null;
    if (activeScope !== capturedScopeKey) return false;
    if (
      capturedCommandScopeKey !== undefined &&
      activeCommandScope !== undefined &&
      activeCommandScope !== capturedCommandScopeKey
    ) {
      return false;
    }
    return (
      historyGeneration === undefined ||
      kernel.authoringHistory?.getGeneration?.() === historyGeneration
    );
  };

  const historyContext = {
    api: kernel.api,
    authoringHistory: kernel.authoringHistory,
    layout: kernel.layout,
    resourceData: { [MODEL_SCENE_PATH]: sceneData },
    selection: kernel.selection,
    sessionScopeKey: capturedScopeKey,
    isCurrentSessionScope,
  };
  const requestOptions = capturedScopeKey ? { sessionScopeKey: capturedScopeKey } : undefined;
  const sceneRevision =
    typeof sceneData?.revision === "number" && Number.isFinite(sceneData.revision)
      ? sceneData.revision
      : null;

  if (draft.mode === "draft-new") {
    const newId = createDraftSlugId(draft);
    const baseName = resolveDefaultDraftBaseName(selection, draft.primitiveKind);
    const createName = resolveDraftObjectName(
      draft.draftName.trim() || newId,
      baseName,
      sceneData,
    );
    const optionalMaterialRef =
      draft.materialRef &&
      draft.materialRef.trim().length > 0 &&
      draft.materialRef.trim() !== "unassigned"
        ? draft.materialRef.trim()
        : undefined;
    const optionalRegionName =
      draft.regionName.trim().length > 0 && draft.regionName.trim() !== "unassigned"
        ? draft.regionName.trim()
        : undefined;

    const reservation = objectEditSession.beginSceneMutation(capturedScopeKey, newId);
    if (reservation === null) {
      throw new Error(
        objectEditSession.hasActiveGesture(capturedScopeKey)
          ? "Finish or cancel the active placement gesture before applying scene changes."
          : "Another scene-changing action is pending in this session.",
      );
    }
    onSetOwnCreatePending(true);
    try {
      let selectedCreatedObject = false;
      const created = await runAuthoringMutationWithHistory(
        historyContext,
        `Create ${createName}`,
        async ({ baseRevision }) => {
          const response = await createObjectTransaction(
            kernel.api,
            {
              base_revision: baseRevision ?? sceneRevision,
              geometry,
              ...(optionalMaterialRef ? { material_ref: optionalMaterialRef } : {}),
              name: createName,
              object_id: newId,
              ...(optionalRegionName ? { region_name: optionalRegionName } : {}),
              transform,
            },
            requestOptions,
          );
          if (isCurrentSessionScope()) {
            onAcknowledgeCommitted?.();
            kernel.selection.set(
              buildObjectSelection(newId, "object.root", createName),
              "geometry-authoring",
            );
            selectedCreatedObject = true;
          }
          return response;
        },
        undefined,
        {
          ...(sceneRevision !== null ? { expectedSceneRevision: sceneRevision } : {}),
          captureWorkspaceStateAfter: () => selectedCreatedObject,
        },
      );

      if (!isCurrentSessionScope()) return false;
      const rev = acknowledgedAuthoringSceneRevision(created);
      onCommittedSuccess(draft.pivotMode === "origin" ? newId : null);
      primitiveDraftOverlayStore.clear();
      publishCommittedSceneResource(
        kernel.resources,
        created.committed_scene,
        rev,
        undefined,
        false,
        capturedScopeKey,
        kernel.api.resourceCacheScope,
      );
      invalidateAuthoringMutationDependents(kernel.resources, "geometry", rev);
      return true;
    } catch (error) {
      if (isPrimitiveDraftRevisionConflict(error)) {
        onRevisionConflict(sceneRevision, null);
      }
      throw error;
    } finally {
      onSetOwnCreatePending(false);
      objectEditSession.endSceneMutation(reservation);
    }
  }

  /* ── Committed object.geometry Apply ── */
  if (!editIdentity) {
    throw new Error("Geometry edit session is not ready. Try again.");
  }
  objectEditSession.updateDraft(editIdentity, (current) =>
    ([0, 1, 2] as const).reduce(
      (next, axis) => updateQuantityFieldSI(next, `translation.${axis}`, draft.translation[axis]),
      current,
    ),
  );
  onSyncEditVersion(objectEditSession.getSnapshot().editVersion);

  const operation = objectEditSession.beginApply(editIdentity);
  if (!operation) {
    throw new Error(
      objectEditSession.hasActiveGesture(capturedScopeKey)
        ? "Finish or cancel the active placement gesture before applying scene changes."
        : "Another scene-changing action is pending in this session.",
    );
  }

  try {
    const response = await runAuthoringMutationWithHistory(
      historyContext,
      `Edit geometry and placement ${draft.draftName}`,
      ({ baseRevision }) =>
        patchObjectGeometryTransaction(
          kernel.api,
          draft.objectId,
          {
            base_revision: baseRevision ?? sceneRevision,
            geometry,
            transform,
          },
          requestOptions,
        ),
      undefined,
      sceneRevision !== null ? { expectedSceneRevision: sceneRevision } : undefined,
    );

    if (!isCurrentSessionScope()) {
      objectEditSession.reject(operation);
      return false;
    }

    const rev = acknowledgedAuthoringSceneRevision(response);
    const hasCommittedObjectsArray = Array.isArray(response.committed_scene?.objects);
    const resolvedCanonicalDraft = hasCommittedObjectsArray
      ? resolveCommittedGeometryObjectDraft(response.committed_scene, operation.identity.objectId)
      : {
          ...operation.submittedDraft,
          baseRevision: rev,
        };
    if (!resolvedCanonicalDraft) {
      objectEditSession.reject(operation);
      throw new Error("The acknowledged object is missing from the committed scene.");
    }
    const acknowledged = objectEditSession.acknowledge(
      operation,
      {
        ...resolvedCanonicalDraft,
        baseRevision: rev,
      },
      reconcileObjectEditAck,
      { reconcileUnchangedDraft: true },
    );
    if (!acknowledged) return false;
    onSyncEditVersion(objectEditSession.getSnapshot().editVersion);

    onCommittedSuccess(draft.pivotMode === "origin" ? draft.objectId : null);
    publishCommittedSceneResource(
      kernel.resources,
      response.committed_scene,
      rev,
      undefined,
      false,
      capturedScopeKey,
      kernel.api.resourceCacheScope,
    );
    invalidateAuthoringMutationDependents(kernel.resources, "geometry", rev);
    return true;
  } catch (error) {
    objectEditSession.reject(operation);
    if (isPrimitiveDraftRevisionConflict(error)) {
      onRevisionConflict(sceneRevision, canonicalSessionDraft);
    }
    throw error;
  }
}
