"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type {
  FieldMetaResource,
  FrozenSpinsActivation,
  FrozenSpinsDefinition,
  FrozenSpinsMembershipPolicy,
  FrozenSpinsPreviewActivationResponse,
  FrozenSpinsPreviewResponse,
  FrozenSpinsReferencePolicy,
  FrozenSpinsRuntimeApplication,
  FrozenSpinsSolverRuntimeStatus,
} from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { useKernel } from "@/kernel/KernelContext";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import {
  FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY,
  frozenSpinsCollectionResourceKey,
  frozenSpinsDefinitionResourceKey,
  useFrozenSpinsDefinitionResource,
} from "@/kernel/resources/frozenSpinsResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import {
  useFieldMetaResource,
  useSolverStatusResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useSessionScopedResourceKey } from "@/kernel/resources/useSessionScopedResourceKey";
import { Button } from "@/shared/ui/Button";

import { useRegisterInspectorEditSession } from "../../InspectorEditSession";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { QuantityFieldDraftScope, useQuantityFieldDraftScope } from "../../primitives/QuantityField";
import { quantityFieldDraftBlockReason } from "../../primitives/quantityFieldDraftStore";
import { SelectionExpressionBuilder } from "../selection/SelectionExpressionBuilder";
import { selectionReferenceCatalog, selectionReferenceIssue } from "../selection/selectionReferenceCatalog";
import { syncAuthoringScriptBestEffort } from "../ObjectMagneticTexturePanelViewModel";
import { reconcileFrozenSpinsDraft } from "./frozenSpinsDraft";

type PendingField = "activate" | "apply" | "delete" | "preview" | "quantity" | null;

interface Feedback {
  kind: "error" | "success" | "warning";
  message: string;
}

export function FrozenSpinsInspectorPanel({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "frozen-spins" ? selection.ref : null;
  const constraintId = ref?.constraintId ?? "";
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    frozenSpinsDefinitionResourceKey(constraintId),
  );
  const sessionScopeKey = sessionRequestScopeKey(sessionIdentity);
  const [deletedOwner, setDeletedOwner] = useState<string | null>(null);
  const locallyDeleted = deletedOwner === resourceKey;
  if (deletedOwner !== null && deletedOwner !== resourceKey) setDeletedOwner(null);
  const resource = useFrozenSpinsDefinitionResource(constraintId, {
    enabled: ref !== null && !locallyDeleted,
  });
  const matchingData = resource.data?.definition.id === constraintId ? resource.data : null;
  const resourceError = resource.error ?? resource.refreshError
    ?? (resource.data && !matchingData ? new Error("The loaded Frozen Spins definition does not match the selected constraint.") : null);
  const definitionCurrent = resource.status === "ready" && matchingData !== null && !resourceError;
  const [lastGood, setLastGood] = useState<{
    constraintId: string;
    resourceKey: string;
    resource: NonNullable<typeof resource.data>;
  } | null>(null);
  if (
    definitionCurrent && matchingData &&
    (lastGood?.constraintId !== constraintId ||
      lastGood.resourceKey !== resourceKey ||
      lastGood.resource !== matchingData)
  ) {
    setLastGood({ constraintId, resourceKey, resource: matchingData });
  }
  const retainedResource =
    matchingData ??
    (lastGood?.constraintId === constraintId && lastGood.resourceKey === resourceKey
      ? lastGood.resource
      : null);

  if (!ref) {
    return (
      <FeedbackBanner
        kind="warning"
        message="Select a Frozen Spins constraint in Explorer."
      />
    );
  }
  if (resourceError && !retainedResource) {
    return (
      <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
        <FeedbackBanner kind="error" message={errorMessage(resourceError)} />
        <Button size="sm" type="button" onClick={resource.refetch}>Retry definition</Button>
      </div>
    );
  }
  if (!retainedResource) {
    return (
      <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
        <p className="fm-help-text">Loading Frozen Spins definition…</p>
      </div>
    );
  }

  const objectId = ref.objectId ?? selection.objectId;
  return (
    <div className="grid min-w-0 gap-fm-inspector-group">
    {resourceError && !locallyDeleted ? <FeedbackBanner kind="error" message={errorMessage(resourceError)} /> : null}
    {!definitionCurrent && !locallyDeleted ? (
      <div>
        <p className="fm-help-text" role="status">Current definition is unconfirmed. Your edits are preserved.</p>
        <Button size="sm" type="button" onClick={resource.refetch}>Retry definition</Button>
      </div>
    ) : null}
    <FrozenSpinsEditor
      key={resourceKey}
      definition={retainedResource.definition}
      objectId={objectId}
      regionId={ref.regionId ?? null}
      revision={retainedResource.revision}
      sessionScopeKey={sessionScopeKey}
      definitionUnavailableReason={definitionCurrent ? undefined : "Confirm the current Frozen Spins definition before applying, previewing or deleting."}
      onDeleteCommitted={() => setDeletedOwner(resourceKey)}
    />
    </div>
  );
}

export function FrozenSpinsEditor({
  definition: initialDefinition,
  objectId,
  regionId,
  revision: initialRevision,
  sessionScopeKey,
  definitionUnavailableReason,
  onDeleteCommitted,
}: {
  definition: FrozenSpinsDefinition;
  objectId: string | null;
  regionId: string | null;
  revision: number;
  sessionScopeKey?: string | null;
  definitionUnavailableReason?: string;
  onDeleteCommitted?: () => void;
}) {
  const kernel = useKernel();
  const [draft, setDraft] = useState(() => normalizeDefinition(initialDefinition));
  const [deleted, setDeleted] = useState(false);
  const deletedRef = useRef(false);
  const scene = useSceneResource();
  const referenceCatalog = useMemo(() => selectionReferenceCatalog(scene.data,
    scene.status === "ready" && !scene.error && !scene.refreshError), [scene.data, scene.status, scene.error, scene.refreshError]);
  const referenceIssue = selectionReferenceIssue(draft.selector, referenceCatalog);
  const numericDrafts = useQuantityFieldDraftScope(
    JSON.stringify([sessionScopeKey, "frozen-spins", initialDefinition.id, objectId, regionId]),
  );
  const numericDraftBlockReason = quantityFieldDraftBlockReason(numericDrafts.summary)
    ?? (numericDrafts.summary.pendingCount > 0 ? "Commit or discard pending selector numeric edits." : undefined);
  const [baseline, setBaseline] = useState(() => normalizeDefinition(initialDefinition));
  const [conflict, setConflict] = useState(false);
  const conflictReason = conflict ? "The definition changed externally. Revert to its latest version before applying or previewing." : undefined;
  const baselineRef = useRef({
    definition: normalizeDefinition(initialDefinition),
    revision: initialRevision,
  });
  const acknowledgedRevisionRef = useRef(initialRevision);
  const draftRef = useRef(draft);
  const applyInFlight = useRef(false);
  const acknowledgeAppliedDraftRef = useRef<(() => boolean) | null>(null);
  const mountedRef = useRef(true);
  const [revision, setRevision] = useState(initialRevision);
  const [pendingField, setPendingField] = useState<PendingField>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [preview, setPreview] = useState<FrozenSpinsPreviewResponse | null>(null);
  const [activationReceipt, setActivationReceipt] =
    useState<FrozenSpinsPreviewActivationResponse | null>(null);
  const [runtimeApplication, setRuntimeApplication] =
    useState<FrozenSpinsRuntimeApplication | null>(null);
  const [previewSelectorJson, setPreviewSelectorJson] = useState<string | null>(null);
  const solverStatus = useSolverStatusResource();
  const fieldMeta = useFieldMetaResource({
    enabled: objectId !== null,
    owner_object_id: objectId,
    quantityId: "m",
  });
  const fieldIdentityError = fieldMeta.error ?? fieldMeta.refreshError;
  const fieldIdentityCurrent = fieldMeta.status === "ready" && !fieldIdentityError
    && fieldMeta.data?.field_revision !== undefined
    && fieldMeta.data?.field_revision !== null
    && Boolean(frozenSpinsPreviewTopologyFingerprint(fieldMeta.data));
  useLayoutEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    const incomingDefinition = normalizeDefinition(initialDefinition);
    if (initialRevision < acknowledgedRevisionRef.current) return;
    const previousBaseline = baselineRef.current;
    if (
      initialRevision === previousBaseline.revision &&
      JSON.stringify(incomingDefinition) === JSON.stringify(previousBaseline.definition)
    ) {
      return;
    }
    const reconciled = reconcileFrozenSpinsDraft(previousBaseline.definition, incomingDefinition, draftRef.current, numericDrafts.store.getSummary().pendingCount > 0);
    baselineRef.current = { definition: incomingDefinition, revision: initialRevision };
    acknowledgedRevisionRef.current = initialRevision;
    setBaseline(incomingDefinition);
    setRevision(initialRevision);
    if (reconciled.conflict) setConflict(true);
    if (reconciled.draft !== draftRef.current) {
      draftRef.current = reconciled.draft;
      setDraft(reconciled.draft);
      setPreview(null);
      setPreviewSelectorJson(null);
    }
  }, [initialDefinition, initialRevision, numericDrafts.store]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function blockNumericDrafts(): boolean {
    const summary = numericDrafts.store.getSummary();
    if (summary.pendingCount === 0) return false;
    setFeedback({ kind: "warning", message: quantityFieldDraftBlockReason(summary) ?? "Commit or discard pending selector numeric edits." });
    return true;
  }

  async function applyDraft(): Promise<boolean> {
    if (deletedRef.current || applyInFlight.current || blockNumericDrafts() || conflict || definitionUnavailableReason || referenceIssue || !canonicalDirty) return false;
    const acknowledgeDraft = acknowledgeAppliedDraftRef.current;
    const submittedDraft = draft;
    const operationSessionScopeKey = sessionScopeKey ?? null;
    if (!operationSessionScopeKey) {
      setFeedback({ kind: "error", message: "Session identity is not ready. Try again after it loads." });
      return false;
    }
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();
    const isCurrentSession = () =>
      kernel.commands.getSessionScopeKey() === operationSessionScopeKey &&
      (historyGeneration === undefined ||
        kernel.authoringHistory?.getGeneration?.() === historyGeneration);
    const requestOptions = scopedFrozenSpinsRequestOptions(sessionScopeKey);
    applyInFlight.current = true;
    setPendingField("apply");
    setFeedback(null);
    try {
      const response = await runAuthoringMutationWithHistory(
        {
          api: kernel.api,
          authoringHistory: kernel.authoringHistory,
          sessionScopeKey,
          isCurrentSessionScope: isCurrentSession,
        },
        "Update Frozen Spins definition",
        async ({ baseRevision }) =>
          requestOptions
            ? kernel.api.model.frozenSpins.patch(
                draft.id,
                {
                  definition: draft,
                  expected_revision: baseRevision ?? revision,
                },
                requestOptions,
              )
            : kernel.api.model.frozenSpins.patch(draft.id, {
                definition: draft,
                expected_revision: baseRevision ?? revision,
          }),
      );
      if (!isCurrentSession()) return false;
      invalidateDefinitionResources(kernel, draft.id, response.revision);
      kernel.resources.invalidate(FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY, "");
      const syncWarning = await syncAuthoringScriptBestEffort(kernel.api, operationSessionScopeKey);
      if (!mountedRef.current || !isCurrentSession()) return false;
      if (response.revision < acknowledgedRevisionRef.current) {
        setConflict(true);
        setFeedback({ kind: "warning", message: `The definition was committed, but a newer scene revision is already loaded.${syncWarning ? ` Authoring script sync skipped: ${syncWarning}` : ""}` });
        return false;
      }
      const acknowledged = normalizeDefinition(response.definition);
      const reconciled = reconcileFrozenSpinsDraft(submittedDraft, acknowledged, draftRef.current, numericDrafts.store.getSummary().pendingCount > 0);
      baselineRef.current = { definition: acknowledged, revision: response.revision };
      acknowledgedRevisionRef.current = response.revision;
      setBaseline(acknowledged);
      if (draftRef.current === submittedDraft && numericDrafts.store.getSummary().pendingCount === 0 && acknowledgeDraft?.()) {
        draftRef.current = reconciled.draft;
        setDraft(reconciled.draft);
      } else if (reconciled.draft !== draftRef.current) {
        draftRef.current = reconciled.draft;
        setDraft(reconciled.draft);
      }
      if (reconciled.conflict) setConflict(true);
      setRevision(response.revision);
      setPreview(null);
      setActivationReceipt(null);
      setRuntimeApplication(response.runtime_application ?? null);
      setFeedback({
        kind: syncWarning || response.runtime_application ? "warning" : "success",
        message: (response.runtime_application
          ? frozenSpinsRuntimeApplicationMessage(response.runtime_application)
          : "Frozen Spins definition updated.") + (syncWarning ? ` Authoring script sync skipped: ${syncWarning}` : ""),
      });
      return true;
    } catch (error) {
      if (!mountedRef.current) return false;
      if (!isCurrentSession()) return false;
      setFeedback({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      applyInFlight.current = false;
      if (mountedRef.current) setPendingField(null);
    }
  }

  async function createPreview(): Promise<void> {
    if (deletedRef.current || applyInFlight.current || blockNumericDrafts() || conflict || definitionUnavailableReason || referenceIssue || !fieldIdentityCurrent) return;
    const operationSessionScopeKey = sessionScopeKey ?? null;
    if (!operationSessionScopeKey) {
      setFeedback({ kind: "error", message: "Session identity is not ready. Try again after it loads." });
      return;
    }
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();
    const isCurrentSession = () =>
      kernel.commands.getSessionScopeKey() === operationSessionScopeKey &&
      (historyGeneration === undefined || kernel.authoringHistory?.getGeneration?.() === historyGeneration);
    const submittedSelectorJson = JSON.stringify(draft.selector);
    if (!objectId) {
      setFeedback({
        kind: "warning",
        message: "Select a target object to preview Frozen Spins.",
      });
      return;
    }
    const sourceStateRevision = fieldMeta.data?.field_revision;
    const topologyFingerprint = frozenSpinsPreviewTopologyFingerprint(fieldMeta.data);
    if (sourceStateRevision === undefined || !topologyFingerprint) {
      setFeedback({
        kind: "warning",
        message: "Current magnetization and topology identity are required for preview.",
      });
      return;
    }
    applyInFlight.current = true;
    setPendingField("preview");
    setFeedback(null);
    try {
      const request = {
        expected_revision: revision,
        expected_source_state_revision: sourceStateRevision,
        expected_topology_fingerprint: topologyFingerprint,
        selector: draft.selector,
        stage_id:
          draft.activation?.kind === "stage_ids"
            ? draft.activation.stage_ids[0] ?? null
            : null,
        target_object_id: objectId,
      };
      const requestOptions = scopedFrozenSpinsRequestOptions(sessionScopeKey);
      const response = requestOptions
        ? await kernel.api.model.frozenSpins.createPreview(request, requestOptions)
        : await kernel.api.model.frozenSpins.createPreview(request);
      if (!mountedRef.current || !isCurrentSession()) return;
      setPreviewSelectorJson(submittedSelectorJson);
      setPreview(response);
      setActivationReceipt(null);
      setRuntimeApplication(null);
      kernel.resources.invalidate(
        FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY,
        response.preview_id,
      );
      setFeedback({
        kind: response.current ? "success" : "warning",
        message: response.current
          ? "Speculative Frozen Spins preview is available for 3D visualization. Solver identity is not bound until runtime activation."
          : "Preview was created but is stale against the current model state.",
      });
    } catch (error) {
      if (!mountedRef.current || !isCurrentSession()) return;
      const message = errorMessage(error);
      if (message.includes("selection_stale_revision")) {
        await fieldMeta.refetch();
        if (!mountedRef.current || !isCurrentSession()) return;
        setFeedback({
          kind: "warning",
          message: `${message} Field identity refresh requested; retry Preview mask after current identity is confirmed.`,
        });
      } else {
        setFeedback({ kind: "error", message });
      }
    } finally {
      applyInFlight.current = false;
      if (mountedRef.current) setPendingField(null);
    }
  }

  async function activatePreview(): Promise<void> {
    const acknowledgeDraft = acknowledgeAppliedDraftRef.current;
    if (deletedRef.current || applyInFlight.current || blockNumericDrafts() || conflict || definitionUnavailableReason || referenceIssue) return;
    if (!preview || !activationCandidateReady) {
      setFeedback({
        kind: "warning",
        message: "Create a current Frozen Spins preview before activation.",
      });
      return;
    }
    const submittedDraft = draft;
    const operationSessionScopeKey = sessionScopeKey ?? null;
    if (!operationSessionScopeKey) {
      setFeedback({ kind: "error", message: "Session identity is not ready. Try again after it loads." });
      return;
    }
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();
    const isCurrentSession = () =>
      kernel.commands.getSessionScopeKey() === operationSessionScopeKey &&
      (historyGeneration === undefined ||
        kernel.authoringHistory?.getGeneration?.() === historyGeneration);
    const requestOptions = scopedFrozenSpinsRequestOptions(sessionScopeKey);
    applyInFlight.current = true;
    setPendingField("activate");
    setFeedback(null);
    try {
      const response = await runAuthoringMutationWithHistory(
        {
          api: kernel.api,
          authoringHistory: kernel.authoringHistory,
          sessionScopeKey,
          isCurrentSessionScope: isCurrentSession,
        },
        "Commit Frozen Spins preview",
        async ({ baseRevision }) =>
          requestOptions
            ? kernel.api.model.frozenSpins.activatePreview(
                preview.preview_id,
                {
                  activation_candidate_token: preview.activation_candidate_token,
                  definition: submittedDraft,
                  expected_revision: baseRevision ?? revision,
                },
                requestOptions,
              )
            : kernel.api.model.frozenSpins.activatePreview(
                preview.preview_id,
                {
                  activation_candidate_token: preview.activation_candidate_token,
                  definition: submittedDraft,
                  expected_revision: baseRevision ?? revision,
                },
              ),
      );
      if (!isCurrentSession()) return;
      invalidateDefinitionResources(kernel, draft.id, response.revision);
      kernel.resources.invalidate(FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY, "");
      const syncWarning = await syncAuthoringScriptBestEffort(kernel.api, operationSessionScopeKey);
      if (!mountedRef.current || !isCurrentSession()) return;
      if (response.revision < acknowledgedRevisionRef.current) {
        setConflict(true);
        setFeedback({ kind: "warning", message: `The preview was committed, but a newer scene revision is already loaded.${syncWarning ? ` Authoring script sync skipped: ${syncWarning}` : ""}` });
        return;
      }
      const acknowledged = normalizeDefinition(response.definition);
      const reconciled = reconcileFrozenSpinsDraft(submittedDraft, acknowledged, draftRef.current, numericDrafts.store.getSummary().pendingCount > 0);
      baselineRef.current = { definition: acknowledged, revision: response.revision };
      acknowledgedRevisionRef.current = response.revision;
      setBaseline(acknowledged);
      if (draftRef.current === submittedDraft && numericDrafts.store.getSummary().pendingCount === 0 && acknowledgeDraft?.()) {
        draftRef.current = reconciled.draft;
        setDraft(reconciled.draft);
      } else if (reconciled.draft !== draftRef.current) {
        draftRef.current = reconciled.draft;
        setDraft(reconciled.draft);
      }
      if (reconciled.conflict) setConflict(true);
      setRevision(response.revision);
      setPreview(null);
      setActivationReceipt(response);
      setRuntimeApplication(response.runtime_application);
      solverStatus.refetch();
      setFeedback({
        kind: "warning",
        message: `${frozenSpinsRuntimeApplicationMessage(response.runtime_application)} The preview candidate was consumed. Current runtime confirmation is shown below.${syncWarning ? ` Authoring script sync skipped: ${syncWarning}` : ""}`,
      });
    } catch (error) {
      if (!mountedRef.current) return;
      if (!isCurrentSession()) return;
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      applyInFlight.current = false;
      if (mountedRef.current) setPendingField(null);
    }
  }

  async function deleteDefinition(): Promise<void> {
    if (deletedRef.current || applyInFlight.current || blockNumericDrafts() || conflict || definitionUnavailableReason) return;
    if (canonicalDirty) {
      setFeedback({ kind: "warning", message: "Apply or revert the definition edits before deleting the constraint." });
      return;
    }
    const operationSessionScopeKey = sessionScopeKey ?? null;
    if (!operationSessionScopeKey) {
      setFeedback({ kind: "error", message: "Session identity is not ready. Try again after it loads." });
      return;
    }
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();
    const isCurrentSession = () =>
      kernel.commands.getSessionScopeKey() === operationSessionScopeKey &&
      (historyGeneration === undefined || kernel.authoringHistory?.getGeneration?.() === historyGeneration);
    applyInFlight.current = true;
    const requestOptions = scopedFrozenSpinsRequestOptions(sessionScopeKey);
    setPendingField("delete");
    setFeedback(null);
    try {
      const response = await runAuthoringMutationWithHistory(
        {
          api: kernel.api,
          authoringHistory: kernel.authoringHistory,
          sessionScopeKey,
          isCurrentSessionScope: isCurrentSession,
        },
        "Delete Frozen Spins definition",
        async ({ baseRevision }) =>
          requestOptions
            ? kernel.api.model.frozenSpins.delete(
                draft.id,
                { expected_revision: baseRevision ?? revision },
                requestOptions,
              )
            : kernel.api.model.frozenSpins.delete(draft.id, {
                expected_revision: baseRevision ?? revision,
              }),
      );
      if (!isCurrentSession()) return;
      if (mountedRef.current) {
        deletedRef.current = true;
        setDeleted(true);
        numericDrafts.store.clear();
        onDeleteCommitted?.();
      }
      kernel.resources.invalidate(
        frozenSpinsCollectionResourceKey(),
        response.revision,
      );
      kernel.resources.invalidate(
        frozenSpinsDefinitionResourceKey(draft.id),
        response.revision,
      );
      kernel.resources.invalidate(FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY, "");
      const syncWarning = await syncAuthoringScriptBestEffort(kernel.api, operationSessionScopeKey);
      if (!mountedRef.current || !isCurrentSession()) return;
      if (syncWarning) {
        setFeedback({ kind: "warning", message: `Frozen Spins deletion was acknowledged. Authoring script sync skipped: ${syncWarning}` });
        return;
      }
      kernel.selection.clear("inspector");
    } catch (error) {
      if (!mountedRef.current || !isCurrentSession()) return;
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      applyInFlight.current = false;
      if (mountedRef.current) setPendingField(null);
    }
  }

  async function retryDeletedScriptSync(): Promise<void> {
    if (!deletedRef.current || applyInFlight.current || !sessionScopeKey) return;
    const operationSessionScopeKey = sessionScopeKey;
    const generation = kernel.authoringHistory?.getGeneration?.();
    const isCurrentSession = () => kernel.commands.getSessionScopeKey() === operationSessionScopeKey
      && (generation === undefined || kernel.authoringHistory?.getGeneration?.() === generation);
    if (!isCurrentSession()) return;
    applyInFlight.current = true;
    setPendingField("delete");
    setFeedback(null);
    try {
      const warning = await syncAuthoringScriptBestEffort(kernel.api, operationSessionScopeKey);
      if (!mountedRef.current || !isCurrentSession()) return;
      if (warning) setFeedback({ kind: "warning", message: `Frozen Spins deletion was acknowledged. Authoring script sync skipped: ${warning}` });
      else kernel.selection.clear("inspector");
    } finally {
      applyInFlight.current = false;
      if (mountedRef.current) setPendingField(null);
    }
  }

  async function showSolverQuantity(): Promise<void> {
    if (deletedRef.current || applyInFlight.current || !canShowSolverQuantity) return;
    const operationSessionScopeKey = sessionScopeKey ?? null;
    const isCurrentSession = () => Boolean(operationSessionScopeKey) && kernel.commands.getSessionScopeKey() === operationSessionScopeKey;
    if (!isCurrentSession()) return;
    applyInFlight.current = true;
    setPendingField("quantity");
    setFeedback(null);
    try {
      kernel.visualizationSync.queuePatch({
        active_quantity_id: "frozen_spins",
        field_component: null,
        quantity: {
          active_quantity_id: "frozen_spins",
          field_component: null,
        },
      });
      await kernel.visualizationSync.flushNow();
      if (!mountedRef.current || !isCurrentSession()) return;
      kernel.layout.setActiveViewportMainModule("viewport-3d");
      kernel.layout.setFocusedSlot("viewport-main");
      setFeedback({
        kind: "success",
        message: "3D viewport now reads the solver-owned frozen_spins quantity.",
      });
    } catch (error) {
      if (!mountedRef.current || !isCurrentSession()) return;
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      applyInFlight.current = false;
      if (mountedRef.current) setPendingField(null);
    }
  }

  const canonicalDirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const dirty = canonicalDirty || numericDrafts.summary.pendingCount > 0 || conflict;
  const resetDraft = () => {
    if (deletedRef.current || applyInFlight.current) return;
    numericDrafts.store.clear();
    setConflict(false);
    draftRef.current = baseline;
    setDraft(baseline);
    setPreview(null);
    setPreviewSelectorJson(null);
    setFeedback(null);
  };
  const activation = draft.activation ?? { kind: "all_stages" };
  const reference = draft.reference ?? { kind: "capture_current_at_activation" };
  const membership = draft.membership?.kind ?? "automatic";
  const toolbarPending = pendingField !== null;
  const activationCandidateReady = Boolean(
    !referenceIssue &&
    !definitionUnavailableReason &&
    !conflict &&
    numericDrafts.summary.pendingCount === 0 &&
    preview?.current &&
    draft.enabled &&
    reference.kind === "capture_current_at_activation" &&
    previewSelectorJson === JSON.stringify(draft.selector) &&
    activationIncludesStage(activation, preview.requested.stage_id),
  );
  const solverReadError = solverStatus.error ?? solverStatus.refreshError;
  const solverStatusCurrent = solverStatus.status === "ready" && !solverReadError && solverStatus.data !== null;
  const solverRuntime = solverStatusCurrent ? solverStatus.data?.frozen_spins ?? null : null;
  const solverBinding: FrozenSpinsSolverBindingModel = !activationReceipt
    ? resolveFrozenSpinsSolverBinding(null, null, draft.id)
    : solverReadError
      ? { state: "error", message: `Cannot confirm solver binding: ${errorMessage(solverReadError)}` }
      : solverStatus.status === "loading" || solverStatus.status === "stale"
        ? { state: solverStatus.status, message: "Solver status is refreshing. Its previous certificate is unconfirmed." }
        : !solverStatusCurrent
          ? { state: "unavailable", message: "Solver status is unavailable. Runtime activation cannot be confirmed." }
          : resolveFrozenSpinsSolverBinding(activationReceipt, solverRuntime, draft.id);
  const canShowSolverQuantity = solverStatusCurrent && (solverBinding.state === "confirmed" || solverBinding.state === "mismatch");
  const acknowledgeAppliedDraft = useRegisterInspectorEditSession(
    deleted ? null : "staged",
    pendingField !== null,
    dirty,
    numericDrafts.summary.pendingCount === 0 && !conflict && !definitionUnavailableReason && !referenceIssue,
    undefined,
    applyDraft,
    resetDraft,
    {
      applyBlockReason: definitionUnavailableReason ?? conflictReason ?? referenceIssue ?? numericDraftBlockReason ?? (sessionScopeKey ? undefined : "Session identity is not ready."),
      historyMode: "mutation-owned",
    },
  );
  useLayoutEffect(() => {
    acknowledgeAppliedDraftRef.current = acknowledgeAppliedDraft;
  }, [acknowledgeAppliedDraft]);

  if (deleted) {
    return (
      <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group" data-frozen-spins-inspector-id={draft.id}>
        <FeedbackBanner kind={feedback?.kind ?? "warning"} message={feedback?.message ?? "Deletion acknowledged. Synchronizing the canonical Python script…"} />
        <div className="fm-inspector-toolbar">
          <Button disabled={toolbarPending} size="sm" type="button" onClick={() => void retryDeletedScriptSync()}>Retry script sync</Button>
          <Button disabled={toolbarPending} size="sm" type="button" onClick={() => {
            if (kernel.commands.getSessionScopeKey() === sessionScopeKey) kernel.selection.clear("inspector");
          }}>Close</Button>
        </div>
      </div>
    );
  }

  return (
    <QuantityFieldDraftScope store={numericDrafts.store}>
    <div
      className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group"
      data-frozen-spins-inspector-id={draft.id}
    >
      {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
      {numericDraftBlockReason ? <FeedbackBanner kind="warning" message={numericDraftBlockReason} /> : null}
      {conflictReason ? <FeedbackBanner kind="warning" message={conflictReason} /> : null}
      {definitionUnavailableReason ? <FeedbackBanner kind="warning" message={definitionUnavailableReason} /> : null}
      {referenceIssue ? <FeedbackBanner kind="warning" message={referenceIssue} /> : null}
      {referenceIssue && !referenceCatalog.ready ? (
        <div>
          {scene.error || scene.refreshError ? <FeedbackBanner kind="error" message={errorMessage(scene.error ?? scene.refreshError)} /> : null}
          <Button size="sm" type="button" onClick={scene.refetch}>Refresh selector catalog</Button>
        </div>
      ) : null}
      <fieldset className="m-0 grid min-w-0 gap-fm-inspector-group border-0 p-0" disabled={pendingField === "delete"}>
      <InspectorGroup title="Frozen Spins" collapsible defaultOpen>
        <FieldRow label="Constraint ID" value={draft.id} />
        <FieldRow label="Schema" value={draft.schema_version} />
        <TextInput
          label="Name"
          value={draft.name}
          onChange={(name) => setDraft((current) => ({ ...current, name }))}
        />
        <label className="fm-inspector-field">
          <input
            checked={draft.enabled ?? true}
            type="checkbox"
            onChange={(event) =>
              setDraft((current) => ({ ...current, enabled: event.target.checked }))
            }
          />
          <span>Enabled</span>
        </label>
      </InspectorGroup>

      <InspectorGroup title="Selection" collapsible defaultOpen>
        {objectId ? (
          <SelectionExpressionBuilder
            referenceCatalog={referenceCatalog}
            numericDraftStore={numericDrafts.store}
            expression={draft.selector}
            objectId={objectId}
            regionId={regionId}
            onChange={(selector) => setDraft((current) => ({ ...current, selector }))}
          />
        ) : (
          <p className="fm-inspector-feedback" data-kind="warning">
            Select a target object to edit the selection expression.
          </p>
        )}
        <SelectInput
          label="Membership"
          value={membership}
          options={[
            ["automatic", "Automatic (from selector)"],
            ["static", "Static"],
            ["snapshot_at_activation", "Snapshot at activation"],
          ]}
          onChange={(kind) =>
            setDraft((current) => ({
              ...current,
              membership: kind === "automatic" ? null : { kind } as FrozenSpinsMembershipPolicy,
            }))
          }
        />
        <p className="fm-help-text">
          Automatic uses the canonical selector analysis, including named selection references:
          static for geometry-only selections, snapshot at activation for state-dependent selections.
        </p>
        <SelectInput
          label="Empty selection"
          value={draft.empty_selection ?? "error"}
          options={[
            ["error", "Error"],
            ["allow_noop", "Allow no-op"],
          ]}
          onChange={(empty_selection) =>
            setDraft((current) => ({
              ...current,
              empty_selection: empty_selection as FrozenSpinsDefinition["empty_selection"],
            }))
          }
        />
        <SelectInput
          label="Inactive selection"
          value={draft.inactive_selection ?? "warn_and_intersect"}
          options={[
            ["warn_and_intersect", "Warn and intersect"],
            ["error", "Error"],
          ]}
          onChange={(inactive_selection) =>
            setDraft((current) => ({
              ...current,
              inactive_selection:
                inactive_selection as FrozenSpinsDefinition["inactive_selection"],
            }))
          }
        />
      </InspectorGroup>

      <InspectorGroup title="Activation and reference" collapsible defaultOpen>
        <SelectInput
          label="Activation"
          value={activation.kind}
          options={[
            ["all_stages", "All stages"],
            ["stage_ids", "Selected stage IDs"],
          ]}
          onChange={(kind) =>
            setDraft((current) => ({
              ...current,
              activation:
                kind === "stage_ids"
                  ? { kind, stage_ids: [] }
                  : ({ kind } as FrozenSpinsActivation),
            }))
          }
        />
        {activation.kind === "stage_ids" ? (
          <TextInput
            label="Stage IDs"
            value={activation.stage_ids.join(", ")}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                activation: {
                  kind: "stage_ids",
                  stage_ids: splitIds(value),
                },
              }))
            }
          />
        ) : null}
        <SelectInput
          label="Reference"
          value={reference.kind}
          options={[
            ["capture_current_at_activation", "Capture current at activation"],
            ["initial_state", "Initial state"],
            ["explicit_field_asset", "Explicit field asset"],
          ]}
          onChange={(kind) =>
            setDraft((current) => ({
              ...current,
              reference:
                kind === "explicit_field_asset"
                  ? { kind, asset_id: "" }
                  : ({ kind } as FrozenSpinsReferencePolicy),
            }))
          }
        />
        {reference.kind === "explicit_field_asset" ? (
          <TextInput
            label="Field asset ID"
            value={reference.asset_id}
            onChange={(asset_id) =>
              setDraft((current) => ({
                ...current,
                reference: { kind: "explicit_field_asset", asset_id },
              }))
            }
          />
        ) : null}
      </InspectorGroup>

      <InspectorGroup title="Preview" collapsible defaultOpen>
        {!fieldIdentityCurrent ? (
          <div>
            <p className="fm-help-text" role="status">Current magnetization and topology identity are unconfirmed. Refresh field identity before previewing.</p>
            {fieldIdentityError ? <FeedbackBanner kind="error" message={errorMessage(fieldIdentityError)} /> : null}
            <Button disabled={toolbarPending || fieldMeta.status === "loading"} size="sm" type="button" onClick={fieldMeta.refetch}>Refresh field identity</Button>
          </div>
        ) : null}
        <div className="fm-inspector-toolbar">
          <Button
            disabled={toolbarPending || Boolean(numericDraftBlockReason) || conflict || Boolean(definitionUnavailableReason) || Boolean(referenceIssue) || !fieldIdentityCurrent}
            size="sm"
            type="button"
            onClick={() => void createPreview()}
          >
            {pendingField === "preview" ? "Computing preview…" : "Preview mask"}
          </Button>
          <Button
            disabled={toolbarPending || !dirty || Boolean(numericDraftBlockReason) || conflict || Boolean(definitionUnavailableReason) || Boolean(referenceIssue)}
            size="sm"
            type="button"
            onClick={() => void applyDraft()}
          >
            {pendingField === "apply" ? "Applying…" : "Apply"}
          </Button>
          <Button disabled={toolbarPending || !dirty} size="sm" type="button" onClick={resetDraft}>
            Revert
          </Button>
          {preview ? (
            <Button
              disabled={!activationCandidateReady || toolbarPending}
              size="sm"
              title={
                activationCandidateReady
                  ? "Atomically commit this exact preview candidate"
                  : "Create a preview that matches the current selector, reference, and stage"
              }
              type="button"
              variant="primary"
              onClick={() => void activatePreview()}
            >
              {pendingField === "activate" ? "Committing…" : "Commit preview"}
            </Button>
          ) : null}
          <Button
            disabled={toolbarPending || dirty || Boolean(definitionUnavailableReason)}
            size="sm"
            type="button"
            variant="danger"
            onClick={() => void deleteDefinition()}
          >
            {pendingField === "delete" ? "Deleting…" : "Delete"}
          </Button>
        </div>
        {preview ? (
          <FrozenSpinsPreviewDetails
            activationCandidateReady={activationCandidateReady}
            preview={preview}
          />
        ) : null}
        {activationReceipt ? (
          <FrozenSpinsSolverBindingDetails
            binding={solverBinding}
            receipt={activationReceipt}
            runtime={solverRuntime}
          />
        ) : null}
        {activationReceipt && !solverStatusCurrent ? (
          <Button disabled={toolbarPending} size="sm" type="button" onClick={solverStatus.refetch}>Refresh solver status</Button>
        ) : null}
        {runtimeApplication ? (
          <FrozenSpinsRuntimeApplicationDetails application={runtimeApplication} />
        ) : null}
        {canShowSolverQuantity ? (
          <Button
            disabled={toolbarPending}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => void showSolverQuantity()}
          >
            {pendingField === "quantity"
              ? "Opening solver quantity…"
              : "Show solver frozen_spins in 3D"}
          </Button>
        ) : null}
      </InspectorGroup>
      </fieldset>
    </div>
    </QuantityFieldDraftScope>
  );
}

export function frozenSpinsPreviewTopologyFingerprint(
  fieldMeta: FieldMetaResource | null | undefined,
): string | null {
  const publicationFingerprint = fieldMeta?.publication_bundle?.topology_hash?.trim();
  if (publicationFingerprint) return publicationFingerprint;

  const currentCarriers = (fieldMeta?.resolved_capability?.carriers ?? []).filter(
    (carrier) =>
      carrier.payload_state === "current" && carrier.carrier_fingerprint.trim().length > 0,
  );
  const fullCarrier = currentCarriers.find(
    (carrier) => carrier.scope_kind === "full" && carrier.scope_id == null,
  );
  if (fullCarrier) return fullCarrier.carrier_fingerprint;

  const fingerprints = [...new Set(
    currentCarriers.map((carrier) => carrier.carrier_fingerprint),
  )];
  return fingerprints.length === 1 ? fingerprints[0] : null;
}

export function FrozenSpinsPreviewDetails({
  activationCandidateReady,
  preview,
}: {
  activationCandidateReady?: boolean;
  preview: FrozenSpinsPreviewResponse;
}) {
  const activationCandidateState = !preview.current
    ? "stale"
    : activationCandidateReady === false
      ? "requires new preview"
      : "ready (one-time)";
  return (
    <div className="fm-inspector-panel" data-preview-current={preview.current}>
      <FieldRow label="Preview ID" value={preview.preview_id} />
      <FieldRow label="Authority" value={preview.authority} />
      <FieldRow label="Solver binding" value={preview.solver_binding} />
      <FieldRow label="Frozen DOFs" value={String(preview.frozen_dof_count)} />
      <FieldRow label="Free DOFs" value={String(preview.free_dof_count)} />
      <FieldRow label="Frozen fraction" value={`${(preview.fraction * 100).toFixed(2)}%`} />
      <FieldRow label="Bounds (m)" value={formatBounds(preview.bounds_m)} />
      <FieldRow label="Mask hash" value={preview.mask_sha256} />
      <FieldRow label="Freshness" value={preview.current ? "current" : "stale"} />
      <FieldRow
        label="Activation candidate"
        value={activationCandidateState}
      />
      <FieldRow label="Qualification" value={preview.resolved.qualification} />
      {preview.warnings.map((warning) => (
        <FeedbackBanner
          key={`${warning.code}:${warning.message}`}
          kind="warning"
          detail={`Code: ${warning.code}`}
          message={warning.message}
        />
      ))}
    </div>
  );
}

export interface FrozenSpinsSolverBindingModel {
  state: "confirmed" | "mismatch" | "not_committed" | "pending" | "loading" | "stale" | "error" | "unavailable";
  message: string;
}

export function resolveFrozenSpinsSolverBinding(
  receipt: FrozenSpinsPreviewActivationResponse | null,
  runtime: FrozenSpinsSolverRuntimeStatus | null,
  constraintId: string,
): FrozenSpinsSolverBindingModel {
  if (!receipt) {
    return {
      state: "not_committed",
      message: "No authoring preview has been committed.",
    };
  }
  if (!runtime || !runtime.active_constraint_ids.includes(constraintId)) {
    return {
      state: "pending",
      message:
        "Waiting for a solver stage that activates this constraint and publishes its certificate.",
    };
  }
  const matches =
    runtime.constraint_activation_epochs[constraintId] !== undefined &&
    runtime.topology_fingerprint === receipt.topology_fingerprint &&
    (runtime.source_state_revision === null ||
      runtime.source_state_revision === receipt.source_state_revision) &&
    sameSha256Identity(runtime.mask_sha256, receipt.mask_sha256) &&
    sameSha256Identity(runtime.reference_sha256, receipt.reference_sha256) &&
    runtime.active_site_count === receipt.active_site_count &&
    runtime.frozen_site_count === receipt.frozen_site_count &&
    runtime.free_site_count === receipt.free_site_count;
  return matches
    ? {
        state: "confirmed",
        message: "Solver certificate matches the committed preview identity.",
      }
    : {
        state: "mismatch",
        message:
          "Solver recomputed a different activation identity. The speculative preview is invalid and the solver-owned quantity must be used.",
      };
}

function sameSha256Identity(left: string, right: string): boolean {
  return normalizeSha256Identity(left) === normalizeSha256Identity(right);
}

function normalizeSha256Identity(value: string): string {
  return value.trim().toLowerCase().replace(/^sha256:/, "");
}

function FrozenSpinsSolverBindingDetails({
  binding,
  receipt,
  runtime,
}: {
  binding: FrozenSpinsSolverBindingModel;
  receipt: FrozenSpinsPreviewActivationResponse;
  runtime: FrozenSpinsSolverRuntimeStatus | null;
}) {
  return (
    <div className="fm-inspector-panel" data-solver-binding={binding.state}>
      <FieldRow label="Activation scope" value={receipt.activation_scope} />
      <FieldRow label="Runtime binding" value={binding.state} />
      <FieldRow
        label="Activation epoch"
        value={
          runtime?.constraint_activation_epochs[receipt.definition.id]?.toString() ??
          (binding.state === "pending" ? "pending" : "unconfirmed")
        }
      />
      <FieldRow
        label="Resolved set revision"
        value={runtime?.resolved_constraint_set_revision?.toString() ?? (binding.state === "pending" ? "pending" : "unconfirmed")}
      />
      <FeedbackBanner
        kind={binding.state === "confirmed" ? "success" : binding.state === "error" ? "error" : "warning"}
        message={binding.message}
      />
    </div>
  );
}

function FrozenSpinsRuntimeApplicationDetails({
  application,
}: {
  application: FrozenSpinsRuntimeApplication;
}) {
  return (
    <div
      className="fm-inspector-panel"
      data-runtime-application={application.state}
    >
      <FieldRow label="Application at commit" value={application.state} />
      <FieldRow
        label="Pending scene revision at commit"
        value={application.pending_revision.toString()}
      />
      <FieldRow label="Apply boundary" value={application.apply_boundary} />
      {application.application_command_id ? (
        <FieldRow
          label="Application command ID"
          value={application.application_command_id}
        />
      ) : null}
      <FieldRow
        label="Solver at commit"
        value={
          application.current_runtime_unchanged ? "unchanged" : "updated"
        }
      />
    </div>
  );
}

function frozenSpinsRuntimeApplicationMessage(
  application: FrozenSpinsRuntimeApplication,
): string {
  const boundary =
    application.apply_boundary === "accepted_step"
      ? "the next accepted solver step"
      : "the next runtime plan";
  const command = application.application_command_id
    ? ` Application command: ${application.application_command_id}.`
    : "";
  return `Frozen Spins definition committed as revision ${application.pending_revision}. The commit receipt schedules application at ${boundary}. Solver was ${application.current_runtime_unchanged ? "unchanged" : "updated"} at commit.${command}`;
}

function normalizeDefinition(definition: FrozenSpinsDefinition): FrozenSpinsDefinition {
  return {
    ...definition,
    activation: definition.activation ?? { kind: "all_stages" },
    empty_selection: definition.empty_selection ?? "error",
    enabled: definition.enabled ?? true,
    inactive_selection: definition.inactive_selection ?? "warn_and_intersect",
    reference: definition.reference ?? { kind: "capture_current_at_activation" },
  };
}

function invalidateDefinitionResources(
  kernel: ReturnType<typeof useKernel>,
  constraintId: string,
  revision: number,
): void {
  kernel.resources.invalidate(frozenSpinsCollectionResourceKey(), revision);
  kernel.resources.invalidate(frozenSpinsDefinitionResourceKey(constraintId), revision);
}

function scopedFrozenSpinsRequestOptions(
  sessionScopeKey: string | null | undefined,
): { sessionScopeKey: string } | undefined {
  return sessionScopeKey ? { sessionScopeKey } : undefined;
}

function splitIds(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function activationIncludesStage(
  activation: FrozenSpinsActivation,
  stageId: string | null | undefined,
): boolean {
  if (!stageId || activation.kind === "all_stages") return true;
  return activation.stage_ids.includes(stageId);
}

function formatBounds(bounds: number[][] | null | undefined): string {
  if (!bounds?.length) return "not available";
  return bounds.map((axis) => `[${axis.map((value) => value.toExponential(3)).join(", ")}]`).join(" × ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function TextInput({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="fm-inspector-field">
      <span>{label}</span>
      <input
        aria-label={label}
        className="fm-inspector-input"
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function SelectInput({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: readonly (readonly [string, string])[];
  value: string;
}) {
  return (
    <label className="fm-inspector-field">
      <span>{label}</span>
      <select
        aria-label={label}
        className="fm-inspector-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([option, title]) => (
          <option key={option} value={option}>{title}</option>
        ))}
      </select>
    </label>
  );
}
