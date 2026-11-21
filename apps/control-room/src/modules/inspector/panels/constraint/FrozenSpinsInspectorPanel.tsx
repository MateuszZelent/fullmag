"use client";

import { Eye, Lock, Shield, Sliders } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import type {
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
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Switch } from "@/shared/ui/Switch";

import { useRegisterInspectorEditSession } from "../../InspectorEditSession";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import {
  InspectorTemplate,
  type InspectorFact,
  type InspectorNotice,
  type InspectorSpec,
} from "../../template";
import {
  buildObjectSelection,
  buildRootSelection,
} from "../model-roots/SpecInspectorHost";
import { SelectionExpressionBuilder } from "../selection/SelectionExpressionBuilder";
import {
  frozenSpinsPreviewTopologyFingerprint,
  resolveFrozenSpinsSolverBinding,
  type FrozenSpinsSolverBindingModel,
} from "./FrozenSpinsInspectorPanel.model";

type PendingField = "activate" | "apply" | "delete" | "preview" | "quantity" | null;

interface Feedback {
  kind: "error" | "success" | "warning";
  message: string;
}

interface FrozenSpinsWorkflowState {
  activationReceipt: FrozenSpinsPreviewActivationResponse | null;
  feedback: Feedback | null;
  pendingField: PendingField;
  preview: FrozenSpinsPreviewResponse | null;
  previewSelectorJson: string | null;
  runtimeApplication: FrozenSpinsRuntimeApplication | null;
}

type FrozenSpinsWorkflowAction =
  | { type: "pending"; field: PendingField }
  | { type: "feedback"; feedback: Feedback | null }
  | { type: "preview-invalidated" }
  | { type: "preview-reset" }
  | {
      type: "definition-applied";
      feedback: Feedback;
      runtimeApplication: FrozenSpinsRuntimeApplication | null;
    }
  | {
      type: "preview-created";
      feedback: Feedback;
      preview: FrozenSpinsPreviewResponse;
      selectorJson: string;
    }
  | {
      type: "preview-activated";
      feedback: Feedback;
      receipt: FrozenSpinsPreviewActivationResponse;
      runtimeApplication: FrozenSpinsRuntimeApplication;
    };

function frozenSpinsWorkflowReducer(
  state: FrozenSpinsWorkflowState,
  action: FrozenSpinsWorkflowAction,
): FrozenSpinsWorkflowState {
  switch (action.type) {
    case "pending":
      return { ...state, pendingField: action.field };
    case "feedback":
      return { ...state, feedback: action.feedback };
    case "preview-invalidated":
      return { ...state, preview: null, previewSelectorJson: null };
    case "preview-reset":
      return {
        ...state,
        feedback: null,
        preview: null,
        previewSelectorJson: null,
      };
    case "definition-applied":
      return {
        ...state,
        activationReceipt: null,
        feedback: action.feedback,
        preview: null,
        runtimeApplication: action.runtimeApplication,
      };
    case "preview-created":
      return {
        ...state,
        activationReceipt: null,
        feedback: action.feedback,
        preview: action.preview,
        previewSelectorJson: action.selectorJson,
        runtimeApplication: null,
      };
    case "preview-activated":
      return {
        ...state,
        activationReceipt: action.receipt,
        feedback: action.feedback,
        preview: null,
        runtimeApplication: action.runtimeApplication,
      };
  }
  const unhandledAction: never = action;
  return unhandledAction;
}

function createFrozenSpinsWorkflowState(): FrozenSpinsWorkflowState {
  return {
    activationReceipt: null,
    feedback: null,
    pendingField: null,
    preview: null,
    previewSelectorJson: null,
    runtimeApplication: null,
  };
}

const EMPTY_TOUCHED = new Set<string>();
const EMPTY_INVALID = new Map<string, string>();
const EMPTY_UNITS: Readonly<Record<string, string>> = {};

export function FrozenSpinsInspectorPanel({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "frozen-spins" ? selection.ref : null;
  const fallbackConstraintId =
    !ref && selection.nodeId?.includes(":frozen-spins:")
      ? decodeURIComponent(selection.nodeId.split(":frozen-spins:").at(-1) ?? "")
      : "";
  const constraintId = ref?.constraintId ?? fallbackConstraintId;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    frozenSpinsDefinitionResourceKey(constraintId),
  );
  const sessionScopeKey = sessionRequestScopeKey(sessionIdentity);
  const resource = useFrozenSpinsDefinitionResource(constraintId, {
    enabled: Boolean(constraintId),
  });
  const [lastGood, setLastGood] = useState<{
    constraintId: string;
    resourceKey: string;
    resource: NonNullable<typeof resource.data>;
  } | null>(null);
  if (
    resource.data &&
    (lastGood?.constraintId !== constraintId ||
      lastGood.resourceKey !== resourceKey ||
      lastGood.resource !== resource.data)
  ) {
    setLastGood({ constraintId, resourceKey, resource: resource.data });
  }
  const retainedResource =
    resource.data ??
    (lastGood?.constraintId === constraintId && lastGood.resourceKey === resourceKey
      ? lastGood.resource
      : null);

  if (!constraintId) {
    return (
      <FeedbackBanner
        kind="warning"
        message="Select a Frozen Spins constraint in Explorer."
      />
    );
  }
  if (resource.error && !retainedResource) {
    return <FeedbackBanner kind="error" message={errorMessage(resource.error)} />;
  }
  if (!retainedResource) {
    return (
      <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
        <p className="fm-help-text">Loading Frozen Spins definition…</p>
      </div>
    );
  }

  const objectId = ref?.objectId ?? selection.objectId;
  return (
    <FrozenSpinsEditor
      key={resourceKey}
      definition={retainedResource.definition}
      objectId={objectId}
      regionId={ref?.regionId ?? null}
      revision={retainedResource.revision}
      selection={selection}
      sessionScopeKey={sessionScopeKey}
    />
  );
}

export function FrozenSpinsEditor({
  definition: initialDefinition,
  objectId,
  regionId,
  revision: initialRevision,
  selection: providedSelection,
  sessionScopeKey,
}: {
  definition: FrozenSpinsDefinition;
  objectId: string | null;
  regionId: string | null;
  revision: number;
  selection?: Selection;
  sessionScopeKey?: string | null;
}) {
  const kernel = useKernel();
  const [draft, setDraft] = useState(() => normalizeDefinition(initialDefinition));
  const [baseline, setBaseline] = useState(() => normalizeDefinition(initialDefinition));
  const [activeModeTabId, setActiveModeTabId] = useState("authoring");

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
  const [workflow, dispatchWorkflow] = useReducer(
    frozenSpinsWorkflowReducer,
    undefined,
    createFrozenSpinsWorkflowState,
  );
  const {
    activationReceipt,
    feedback,
    pendingField,
    preview,
    previewSelectorJson,
    runtimeApplication,
  } = workflow;

  const solverStatus = useSolverStatusResource();
  const fieldMeta = useFieldMetaResource({
    enabled: objectId !== null,
    owner_object_id: objectId,
    quantityId: "m",
  });

  useEffect(() => {
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
    const wasClean =
      JSON.stringify(draftRef.current) === JSON.stringify(previousBaseline.definition);
    baselineRef.current = { definition: incomingDefinition, revision: initialRevision };
    acknowledgedRevisionRef.current = initialRevision;
    setBaseline(incomingDefinition);
    setRevision(initialRevision);
    if (wasClean) {
      draftRef.current = incomingDefinition;
      setDraft(incomingDefinition);
      dispatchWorkflow({ type: "preview-invalidated" });
    }
  }, [initialDefinition, initialRevision]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  async function applyDraft(): Promise<boolean> {
    if (applyInFlight.current || !dirty) return false;
    const acknowledgeDraft = acknowledgeAppliedDraftRef.current;
    const submittedDraft = draft;
    const operationSessionScopeKey = sessionScopeKey ?? null;
    if (!operationSessionScopeKey) {
      dispatchWorkflow({
        type: "feedback",
        feedback: {
          kind: "error",
          message: "Session identity is not ready. Try again after it loads.",
        },
      });
      return false;
    }
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();
    const isCurrentSession = () =>
      kernel.commands.getSessionScopeKey() === operationSessionScopeKey &&
      (historyGeneration === undefined ||
        kernel.authoringHistory?.getGeneration?.() === historyGeneration);
    const requestOptions = scopedFrozenSpinsRequestOptions(sessionScopeKey);
    applyInFlight.current = true;
    dispatchWorkflow({ type: "pending", field: "apply" });
    dispatchWorkflow({ type: "feedback", feedback: null });
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
      if (!mountedRef.current) return false;
      if (!isCurrentSession()) return false;
      const acknowledged = normalizeDefinition(response.definition);
      baselineRef.current = { definition: acknowledged, revision: response.revision };
      acknowledgedRevisionRef.current = response.revision;
      setBaseline(acknowledged);
      if (draftRef.current === submittedDraft) {
        if (!acknowledgeDraft?.()) return false;
        draftRef.current = acknowledged;
        setDraft(acknowledged);
      }
      setRevision(response.revision);
      invalidateDefinitionResources(kernel, draft.id, response.revision);
      kernel.resources.invalidate(FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY, "");
      dispatchWorkflow({
        type: "definition-applied",
        runtimeApplication: response.runtime_application ?? null,
        feedback: {
          kind: response.runtime_application ? "warning" : "success",
          message: response.runtime_application
            ? frozenSpinsRuntimeApplicationMessage(response.runtime_application)
            : "Frozen Spins definition updated.",
        },
      });
      return true;
    } catch (error) {
      if (!mountedRef.current) return false;
      if (!isCurrentSession()) return false;
      dispatchWorkflow({
        type: "feedback",
        feedback: { kind: "error", message: errorMessage(error) },
      });
      return false;
    } finally {
      applyInFlight.current = false;
      if (mountedRef.current) dispatchWorkflow({ type: "pending", field: null });
    }
  }

  async function createPreview(): Promise<void> {
    if (applyInFlight.current) return;
    if (!objectId) {
      dispatchWorkflow({
        type: "feedback",
        feedback: {
          kind: "warning",
          message: "Select a target object to preview Frozen Spins.",
        },
      });
      return;
    }
    const sourceStateRevision = fieldMeta.data?.field_revision;
    const topologyFingerprint = frozenSpinsPreviewTopologyFingerprint(fieldMeta.data);
    if (sourceStateRevision === undefined || !topologyFingerprint) {
      dispatchWorkflow({
        type: "feedback",
        feedback: {
          kind: "warning",
          message: "Current magnetization and topology identity are required for preview.",
        },
      });
      return;
    }
    dispatchWorkflow({ type: "pending", field: "preview" });
    dispatchWorkflow({ type: "feedback", feedback: null });
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
      if (!mountedRef.current) return;
      kernel.resources.invalidate(
        FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY,
        response.preview_id,
      );
      dispatchWorkflow({
        type: "preview-created",
        preview: response,
        selectorJson: JSON.stringify(draft.selector),
        feedback: {
          kind: response.current ? "success" : "warning",
          message: response.current
            ? "Speculative Frozen Spins preview is current and visible in the 3D viewport. Solver identity is not bound until runtime activation."
            : "Preview was created but is stale against the current model state.",
        },
      });
    } catch (error) {
      if (!mountedRef.current) return;
      const message = errorMessage(error);
      if (message.includes("selection_stale_revision")) {
        await fieldMeta.refetch();
        dispatchWorkflow({
          type: "feedback",
          feedback: {
            kind: "warning",
            message: `${message} Current field identity was refreshed; retry Preview mask.`,
          },
        });
      } else {
        dispatchWorkflow({ type: "feedback", feedback: { kind: "error", message } });
      }
    } finally {
      if (mountedRef.current) dispatchWorkflow({ type: "pending", field: null });
    }
  }

  async function activatePreview(): Promise<void> {
    const acknowledgeDraft = acknowledgeAppliedDraftRef.current;
    if (applyInFlight.current) return;
    if (!preview?.current) {
      dispatchWorkflow({
        type: "feedback",
        feedback: {
          kind: "warning",
          message: "Create a current Frozen Spins preview before activation.",
        },
      });
      return;
    }
    const submittedDraft = draft;
    const operationSessionScopeKey = sessionScopeKey ?? null;
    if (!operationSessionScopeKey) {
      dispatchWorkflow({
        type: "feedback",
        feedback: {
          kind: "error",
          message: "Session identity is not ready. Try again after it loads.",
        },
      });
      return;
    }
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();
    const isCurrentSession = () =>
      kernel.commands.getSessionScopeKey() === operationSessionScopeKey &&
      (historyGeneration === undefined ||
        kernel.authoringHistory?.getGeneration?.() === historyGeneration);
    const requestOptions = scopedFrozenSpinsRequestOptions(sessionScopeKey);
    applyInFlight.current = true;
    dispatchWorkflow({ type: "pending", field: "activate" });
    dispatchWorkflow({ type: "feedback", feedback: null });
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
            : kernel.api.model.frozenSpins.activatePreview(preview.preview_id, {
                activation_candidate_token: preview.activation_candidate_token,
                definition: submittedDraft,
                expected_revision: baseRevision ?? revision,
              }),
      );
      if (!mountedRef.current) return;
      if (!isCurrentSession()) return;
      const acknowledged = normalizeDefinition(response.definition);
      baselineRef.current = { definition: acknowledged, revision: response.revision };
      acknowledgedRevisionRef.current = response.revision;
      setBaseline(acknowledged);
      if (draftRef.current === submittedDraft) {
        if (!acknowledgeDraft?.()) return;
        draftRef.current = acknowledged;
        setDraft(acknowledged);
      }
      setRevision(response.revision);
      invalidateDefinitionResources(kernel, draft.id, response.revision);
      kernel.resources.invalidate(FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY, "");
      solverStatus.refetch();
      dispatchWorkflow({
        type: "preview-activated",
        receipt: response,
        runtimeApplication: response.runtime_application,
        feedback: {
          kind: "warning",
          message: `${frozenSpinsRuntimeApplicationMessage(response.runtime_application)} The preview candidate was consumed; solver activation is still pending runtime confirmation and a matching solver-owned certificate.`,
        },
      });
    } catch (error) {
      if (!mountedRef.current) return;
      if (!isCurrentSession()) return;
      dispatchWorkflow({
        type: "feedback",
        feedback: { kind: "error", message: errorMessage(error) },
      });
    } finally {
      applyInFlight.current = false;
      if (mountedRef.current) dispatchWorkflow({ type: "pending", field: null });
    }
  }

  async function deleteDefinition(): Promise<void> {
    if (applyInFlight.current) return;
    applyInFlight.current = true;
    const requestOptions = scopedFrozenSpinsRequestOptions(sessionScopeKey);
    dispatchWorkflow({ type: "pending", field: "delete" });
    dispatchWorkflow({ type: "feedback", feedback: null });
    try {
      const response = await runAuthoringMutationWithHistory(
        {
          api: kernel.api,
          authoringHistory: kernel.authoringHistory,
          sessionScopeKey,
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
      if (!mountedRef.current) return;
      kernel.resources.invalidate(
        frozenSpinsCollectionResourceKey(),
        response.revision,
      );
      kernel.resources.invalidate(
        frozenSpinsDefinitionResourceKey(draft.id),
        response.revision,
      );
      kernel.resources.invalidate(FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY, "");
      kernel.selection.clear("inspector");
    } catch (error) {
      if (!mountedRef.current) return;
      dispatchWorkflow({
        type: "feedback",
        feedback: { kind: "error", message: errorMessage(error) },
      });
      dispatchWorkflow({ type: "pending", field: null });
    } finally {
      applyInFlight.current = false;
    }
  }

  async function showSolverQuantity(): Promise<void> {
    dispatchWorkflow({ type: "pending", field: "quantity" });
    dispatchWorkflow({ type: "feedback", feedback: null });
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
      kernel.layout.setActiveViewportMainModule("viewport-3d");
      kernel.layout.setFocusedSlot("viewport-main");
      dispatchWorkflow({
        type: "feedback",
        feedback: {
          kind: "success",
          message: "3D viewport now reads the solver-owned frozen_spins quantity.",
        },
      });
    } catch (error) {
      dispatchWorkflow({
        type: "feedback",
        feedback: { kind: "error", message: errorMessage(error) },
      });
    } finally {
      dispatchWorkflow({ type: "pending", field: null });
    }
  }

  const resetDraft = () => {
    if (applyInFlight.current) return;
    draftRef.current = baseline;
    setDraft(baseline);
    dispatchWorkflow({ type: "preview-reset" });
  };

  const activation = draft.activation ?? { kind: "all_stages" };
  const reference = draft.reference ?? { kind: "capture_current_at_activation" };
  const membership = draft.membership ?? { kind: "static" };
  const toolbarPending = pendingField !== null;

  const activationCandidateReady = Boolean(
    preview?.current &&
      draft.enabled &&
      reference.kind === "capture_current_at_activation" &&
      previewSelectorJson === JSON.stringify(draft.selector) &&
      activationIncludesStage(activation, preview.requested.stage_id),
  );

  const solverBinding = resolveFrozenSpinsSolverBinding(
    activationReceipt,
    solverStatus.data?.frozen_spins ?? null,
    draft.id,
  );

  const acknowledgeAppliedDraft = useRegisterInspectorEditSession(
    "staged",
    pendingField === "apply" || pendingField === "activate",
    dirty,
    true,
    undefined,
    applyDraft,
    resetDraft,
    {
      applyBlockReason: sessionScopeKey ? undefined : "Session identity is not ready.",
      historyMode: "mutation-owned",
    },
  );
  useLayoutEffect(() => {
    acknowledgeAppliedDraftRef.current = acknowledgeAppliedDraft;
  }, [acknowledgeAppliedDraft]);

  const effectiveSelection = useMemo<Selection>(
    () =>
      providedSelection ?? {
        kind: "object.frozen-spins",
        label: draft.name || "Frozen Spins",
        moduleSource: "inspector",
        nodeId: objectId
          ? `model:object:${objectId}:frozen-spins:${draft.id}`
          : `model:definitions:frozen-spins:${draft.id}`,
        objectId,
        ref: {
          constraintId: draft.id,
          kind: "object.frozen-spins",
          nodeId: objectId
            ? `model:object:${objectId}:frozen-spins:${draft.id}`
            : `model:definitions:frozen-spins:${draft.id}`,
          ...(objectId ? { objectId } : {}),
          type: "frozen-spins",
        },
      },
    [draft.id, draft.name, objectId, providedSelection],
  );

  const dirtyFields = useMemo(() => {
    const next = new Set<string>();
    if (dirty) next.add("name");
    return next;
  }, [dirty]);

  const spec: InspectorSpec<FrozenSpinsDefinition> = {
    id: "object.frozen-spins",
    header: {
      breadcrumbs: objectId
        ? [
            {
              id: "object",
              label: objectId,
              selection: buildObjectSelection(objectId, "object.root", objectId),
            },
            { id: "frozen", label: "Frozen Spins" },
          ]
        : [
            {
              id: "definitions",
              label: "Definitions",
              selection: buildRootSelection("definitions.root", "model:definitions", "Definitions"),
            },
            { id: "frozen", label: "Frozen Spins" },
          ],
      searchable: false,
    },
    identity: {
      domain: "physics",
      icon: Lock,
      title: (d) => d.name || d.id,
      kindLabel: "Frozen Spins constraint",
      entityId: draft.id,
      statePill: (d) =>
        solverBinding.state === "confirmed"
          ? { tone: "ok", label: "Solver bound" }
          : d.enabled !== false
            ? { tone: "info", label: "Authored" }
            : { tone: "degraded", label: "Disabled" },
    },
    facts: (d): readonly InspectorFact[] => [
      { id: "id", label: "Constraint ID", value: d.id },
      { id: "schema", label: "Schema", value: d.schema_version },
      {
        id: "frozen",
        label: "Frozen DOFs",
        value: preview ? `${preview.frozen_dof_count} (${(preview.fraction * 100).toFixed(1)}%)` : null,
        tone: "info",
      },
    ],
    notices: (): readonly InspectorNotice<FrozenSpinsDefinition>[] =>
      feedback
        ? [
            {
              id: "frozen-spins-feedback",
              tone:
                feedback.kind === "error"
                  ? "err"
                  : feedback.kind === "warning"
                    ? "warn"
                    : "info",
              text: feedback.message,
            },
          ]
        : [],
    sections: [
      {
        id: "frozen-spins-identity",
        title: "Frozen Spins",
        icon: Shield,
        defaultOpen: true,
        rows: [
          {
            type: "custom",
            wide: true,
            render: () => (
              <div className="flex flex-col gap-2">
                <div className="fm-inspector-field">
                  <span className="text-xs text-[var(--fm-text)]">Name</span>
                  <Input
                    aria-label="Name"
                    type="text"
                    value={draft.name}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, name: event.target.value }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-[var(--fm-text)]">Enabled</span>
                  <Switch
                    aria-label="Enabled"
                    checked={draft.enabled ?? true}
                    onCheckedChange={(checked) =>
                      setDraft((current) => ({ ...current, enabled: checked }))
                    }
                  />
                </div>
              </div>
            ),
          },
        ],
      },
      {
        id: "frozen-spins-selection",
        title: "Selection",
        icon: Sliders,
        defaultOpen: true,
        rows: [
          {
            type: "custom",
            wide: true,
            render: () => (
              <div className="flex flex-col gap-2.5">
                {objectId ? (
                  <SelectionExpressionBuilder
                    expression={draft.selector}
                    objectId={objectId}
                    regionId={regionId}
                    onChange={(selector) =>
                      setDraft((current) => ({ ...current, selector }))
                    }
                  />
                ) : (
                  <p className="fm-inspector-feedback" data-kind="warning">
                    Select a target object to edit the selection expression.
                  </p>
                )}
                <RadixSelectRow
                  label="Membership"
                  options={[
                    ["static", "Static"],
                    ["snapshot_at_activation", "Snapshot at activation"],
                  ]}
                  value={membership.kind}
                  onChange={(kind) =>
                    setDraft((current) => ({
                      ...current,
                      membership: { kind } as FrozenSpinsMembershipPolicy,
                    }))
                  }
                />
                <RadixSelectRow
                  label="Empty selection"
                  options={[
                    ["error", "Error"],
                    ["allow_noop", "Allow no-op"],
                  ]}
                  value={draft.empty_selection ?? "error"}
                  onChange={(empty_selection) =>
                    setDraft((current) => ({
                      ...current,
                      empty_selection:
                        empty_selection as FrozenSpinsDefinition["empty_selection"],
                    }))
                  }
                />
                <RadixSelectRow
                  label="Inactive selection"
                  options={[
                    ["warn_and_intersect", "Warn and intersect"],
                    ["error", "Error"],
                  ]}
                  value={draft.inactive_selection ?? "warn_and_intersect"}
                  onChange={(inactive_selection) =>
                    setDraft((current) => ({
                      ...current,
                      inactive_selection:
                        inactive_selection as FrozenSpinsDefinition["inactive_selection"],
                    }))
                  }
                />
              </div>
            ),
          },
        ],
      },
      {
        id: "frozen-spins-activation",
        title: "Activation and reference",
        icon: Lock,
        defaultOpen: true,
        rows: [
          {
            type: "custom",
            wide: true,
            render: () => (
              <div className="flex flex-col gap-2.5">
                <RadixSelectRow
                  label="Activation"
                  options={[
                    ["all_stages", "All stages"],
                    ["stage_ids", "Selected stage IDs"],
                  ]}
                  value={activation.kind}
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
                  <div className="fm-inspector-field">
                    <span className="text-xs text-[var(--fm-text)]">Stage IDs</span>
                    <Input
                      aria-label="Stage IDs"
                      type="text"
                      value={activation.stage_ids.join(", ")}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          activation: {
                            kind: "stage_ids",
                            stage_ids: splitIds(event.target.value),
                          },
                        }))
                      }
                    />
                  </div>
                ) : null}
                <RadixSelectRow
                  label="Reference"
                  options={[
                    ["capture_current_at_activation", "Capture current at activation"],
                    ["initial_state", "Initial state"],
                    ["explicit_field_asset", "Explicit field asset"],
                  ]}
                  value={reference.kind}
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
                  <div className="fm-inspector-field">
                    <span className="text-xs text-[var(--fm-text)]">Field asset ID</span>
                    <Input
                      aria-label="Field asset ID"
                      type="text"
                      value={reference.asset_id}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          reference: {
                            kind: "explicit_field_asset",
                            asset_id: event.target.value,
                          },
                        }))
                      }
                    />
                  </div>
                ) : null}
              </div>
            ),
          },
        ],
      },
      {
        id: "frozen-spins-preview",
        title: "Preview and solver certificate",
        icon: Eye,
        defaultOpen: true,
        rows: [
          {
            type: "custom",
            wide: true,
            render: () => (
              <div className="flex flex-col gap-2.5">
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    disabled={toolbarPending}
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => void createPreview()}
                  >
                    {pendingField === "preview" ? "Computing preview…" : "Preview mask"}
                  </Button>
                  {preview ? (
                    <Button
                      disabled={!activationCandidateReady || toolbarPending}
                      disabledReason={
                        !activationCandidateReady
                          ? "Create a preview that matches the current selector, reference, and stage"
                          : undefined
                      }
                      size="sm"
                      type="button"
                      variant="primary"
                      onClick={() => void activatePreview()}
                    >
                      {pendingField === "activate" ? "Committing…" : "Commit preview"}
                    </Button>
                  ) : null}
                  <Button
                    disabled={toolbarPending}
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
                    runtime={solverStatus.data?.frozen_spins ?? null}
                  />
                ) : null}
                {runtimeApplication ? (
                  <FrozenSpinsRuntimeApplicationDetails application={runtimeApplication} />
                ) : null}
                {solverBinding.state === "confirmed" || solverBinding.state === "mismatch" ? (
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
              </div>
            ),
          },
        ],
      },
    ],
    commitBar: {
      mode: "staged",
      cleanMessage: () => "Frozen Spins definition matches committed revision",
      onApply: async () => applyDraft(),
      onRevert: () => resetDraft(),
    },
  };

  return (
    <div className="min-w-0" data-frozen-spins-inspector-id={draft.id}>
      <InspectorTemplate
        activeModeTabId={activeModeTabId}
        animationKey={draft.id}
        appliedFlash={false}
        applyError={null}
        applying={toolbarPending}
        baseline={baseline}
        dirtyFields={dirtyFields}
        displayUnits={EMPTY_UNITS}
        draft={draft}
        forceShowErrors={false}
        invalidFields={EMPTY_INVALID}
        selection={effectiveSelection}
        spec={spec}
        touchedFields={EMPTY_TOUCHED}
        onActiveModeTabChange={setActiveModeTabId}
        onApply={() => void applyDraft()}
        onDisplayUnitChange={() => undefined}
        onFieldChange={(key, value) =>
          setDraft((current) => ({ ...current, [key]: value }))
        }
        onFieldTouch={() => undefined}
        onFitView={() => undefined}
        onFocusField={() => undefined}
        onHideInspector={() => {
          kernel.layout.setPanelVisible?.("right", false);
        }}
        onNotify={() => undefined}
        onOpenCodePreview={() => undefined}
        onParseErrorChange={() => undefined}
        onPatchDraft={(partial) => setDraft((current) => ({ ...current, ...partial }))}
        onResetDisplay={() => undefined}
        onRevertAll={resetDraft}
        onRevertField={(key) =>
          setDraft((current) => ({
            ...current,
            [key]: baseline[key as keyof FrozenSpinsDefinition],
          }))
        }
        onSelectNode={(next) => {
          kernel.selection.set?.(next, "inspector");
        }}
      />
    </div>
  );
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
      <FieldRow
        label="Frozen fraction"
        value={`${(preview.fraction * 100).toFixed(2)}%`}
      />
      <FieldRow label="Bounds (m)" value={formatBounds(preview.bounds_m)} />
      <FieldRow label="Mask hash" value={preview.mask_sha256} />
      <FieldRow label="Freshness" value={preview.current ? "current" : "stale"} />
      <FieldRow label="Activation candidate" value={activationCandidateState} />
      <FieldRow label="Qualification" value={preview.resolved.qualification} />
      {preview.warnings.map((warning) => (
        <FeedbackBanner
          key={`${warning.code}:${warning.message}`}
          detail={`Code: ${warning.code}`}
          kind="warning"
          message={warning.message}
        />
      ))}
    </div>
  );
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
          "pending"
        }
      />
      <FieldRow
        label="Resolved set revision"
        value={runtime?.resolved_constraint_set_revision?.toString() ?? "pending"}
      />
      <FeedbackBanner
        kind={binding.state === "confirmed" ? "success" : "warning"}
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
      <FieldRow label="Runtime application" value={application.state} />
      <FieldRow
        label="Pending scene revision"
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
        label="Current solver"
        value={application.current_runtime_unchanged ? "unchanged" : "updated"}
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
  return `Frozen Spins definition committed as revision ${application.pending_revision}. The current solver is unchanged until ${boundary}.${command}`;
}

function normalizeDefinition(definition: FrozenSpinsDefinition): FrozenSpinsDefinition {
  return {
    ...definition,
    activation: definition.activation ?? { kind: "all_stages" },
    empty_selection: definition.empty_selection ?? "error",
    enabled: definition.enabled ?? true,
    inactive_selection: definition.inactive_selection ?? "warn_and_intersect",
    membership: definition.membership ?? { kind: "static" },
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
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function activationIncludesStage(
  activation: FrozenSpinsActivation,
  stageId: string | null | undefined,
): boolean {
  if (!stageId || activation.kind === "all_stages") return true;
  return activation.stage_ids.includes(stageId);
}

function formatBounds(bounds: number[][] | null | undefined): string {
  if (!bounds?.length) return "\u2014";
  return bounds
    .map((axis) => `[${axis.map((value) => value.toExponential(3)).join(", ")}]`)
    .join(" × ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function RadixSelectRow({
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
  const activeTitle = options.find(([opt]) => opt === value)?.[1] ?? value;
  return (
    <div className="fm-inspector-field">
      <span className="text-xs text-[var(--fm-text)]">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label} density="compact">
          <SelectValue placeholder={activeTitle}>{activeTitle}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map(([option, title]) => (
            <SelectItem key={option} value={option}>
              {title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
