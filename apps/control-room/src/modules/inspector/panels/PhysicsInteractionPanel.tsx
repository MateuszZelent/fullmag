"use client";

import { HelpCircle } from "lucide-react";
import { useCallback, useMemo, useReducer, useState } from "react";

import {
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
} from "@/kernel/api/apiPaths";
import type { ObjectInteractionKind } from "@/kernel/api/apiTypes";
import { acknowledgedAuthoringSceneRevision } from "@/kernel/authoring/authoringMutationInvalidation";
import { useKernel } from "@/kernel/KernelContext";
import {
  resolveObjectInteractionResourceKey,
  useObjectInteractionResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  resolveActiveLaneOperation,
  useActiveLaneCapabilities,
  type ActiveLaneCapabilitySnapshot,
} from "@/kernel/resources/useActiveLaneCapabilities";
import {
  SESSION_STATUS_RESOURCE_KEY,
  useSessionStatusSelector,
} from "@/kernel/resources/useSessionStatus";
import {
  interactionAvailabilityForDiscretization,
  interactionSpecsForDiscretization,
  normalizeInteractionDiscretization,
  validateInteractionDraftForDiscretization,
  type InteractionDiscretization,
  type InteractionFieldSpec,
  type InteractionSpec,
} from "@/shared/domain/physics/interactions";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { Vector3Field } from "../primitives/Vector3Field";
import { PhysicsInspectorOverview } from "./PhysicsInspectorOverview";
import { buildPhysicsInspectorOverviewModel } from "./PhysicsInspectorOverviewModel";
import {
  buildInteractionApplyPatch,
  defaultObjectInteractionResource,
  draftFromInteractionResource,
  draftFromStudyScene,
  draftKeyForInteraction,
  interactionMutationKey,
  isDeferredInteraction,
  isWritableObjectInteraction,
  isWritableStudyInteraction,
  physicsInteractionDraftDirty,
  type PhysicsInteractionDraft,
  type PhysicsInteractionId,
} from "./PhysicsInteractionPanelModel";
import {
  OerstedFieldInspectorPanel,
  SpinTorqueInspectorPanel,
} from "./SpinAuthoringInspector";
import { CurrentTransportInspectorPanel } from "./TransportAuthoringInspector";

interface DraftState {
  draft: PhysicsInteractionDraft;
  key: string;
}

interface InteractionSelectionState {
  active?: boolean;
  interactionId: PhysicsInteractionId;
  nodeId: string | null;
}

type Feedback =
  | {
      kind: "error" | "success";
      message: string;
    }
  | null;

interface PhysicsInteractionPanelState {
  helpOpen: boolean;
  interactionSelection: InteractionSelectionState;
  mutations: Record<string, { feedback: Feedback; pending: boolean }>;
}

type PhysicsInteractionPanelAction =
  | { type: "setHelpOpen"; open: boolean }
  | { type: "setInteractionSelection"; selection: InteractionSelectionState }
  | { type: "setMutation"; key: string; pending?: boolean; feedback?: Feedback };

function physicsInteractionPanelReducer(
  state: PhysicsInteractionPanelState,
  action: PhysicsInteractionPanelAction,
): PhysicsInteractionPanelState {
  switch (action.type) {
    case "setHelpOpen":
      return { ...state, helpOpen: action.open };
    case "setInteractionSelection":
      return {
        ...state,
        interactionSelection: action.selection,
      };
    case "setMutation": {
      const previous = state.mutations[action.key] ?? {
        feedback: null,
        pending: false,
      };
      return {
        ...state,
        mutations: {
          ...state.mutations,
          [action.key]: {
            feedback:
              action.feedback === undefined ? previous.feedback : action.feedback,
            pending: action.pending === undefined ? previous.pending : action.pending,
          },
        },
      };
    }
  }
}

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

type PhysicsInteractionSpec = InteractionSpec;

function invalidateInteractionDependents(
  resources: { invalidate(resourceKey: string, revision: number): void },
  revision: number,
): void {
  resources.invalidate(MODEL_SCENE_PATH, revision);
  resources.invalidate(MODEL_READINESS_PATH, revision);
  resources.invalidate(MODEL_STUDY_PATH, revision);
  resources.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
}

export async function commitObjectInteractionMutation({
  interactionKind,
  objectId,
  patch,
  resources,
}: {
  interactionKind: ObjectInteractionKind;
  objectId: string;
  patch: () => Promise<{ revision?: unknown; scene_revision?: unknown }>;
  resources: { invalidate(resourceKey: string, revision: number): void };
}): Promise<number> {
  const response = await patch();
  const revision = acknowledgedAuthoringSceneRevision(response);
  resources.invalidate(
    resolveObjectInteractionResourceKey(objectId, interactionKind),
    revision,
  );
  invalidateInteractionDependents(resources, revision);
  return revision;
}

export function PhysicsInteractionPanel({ selection }: InspectorPanelProps) {
  const objectId = selection.objectId;
  const selectedRegionId =
    selection.ref?.type === "scene-object" ? selection.ref.regionId ?? null : null;
  const { api, resources } = useKernel();
  const sessionDiscretization = useSessionStatusSelector(
    (status) => status.data?.domain.discretization ?? null,
  );
  const sessionId = useSessionStatusSelector(
    (status) => status.data?.session.session_id ?? "current",
  );
  const activeLane = useActiveLaneCapabilities();
  const interactionDiscretization = normalizeInteractionDiscretization(
    sessionDiscretization,
  );
  const interactionOptions = interactionSpecsForDiscretization(
    interactionDiscretization,
  );
  const selectedInteractionId =
    interactionIdFromSelection(selection.nodeId) ?? "exchange";
  const [state, dispatch] = useReducer(physicsInteractionPanelReducer, {
    helpOpen: false,
    interactionSelection: {
      interactionId: selectedInteractionId,
      nodeId: selection.nodeId,
    },
    mutations: {},
  });
  const interactionId =
    state.interactionSelection.nodeId === selection.nodeId
      ? state.interactionSelection.interactionId
      : selectedInteractionId;
  const mutationKey = interactionMutationKey({
    interactionId,
    objectId,
    regionId: selectedRegionId,
    sessionId,
  });
  const mutation = state.mutations[mutationKey] ?? {
    feedback: null,
    pending: false,
  };

  const spec = interactionOptions.find((entry) => entry.id === interactionId);
  const interactionAvailability = interactionAvailabilityForDiscretization(
    interactionId,
    interactionDiscretization,
  );
  const activeLaneOperation = resolveActiveLaneOperation(
    activeLane,
    `interaction.${interactionId}`,
  );
  const objectInteractionKind =
    interactionAvailability.status === "supported" &&
    isWritableObjectInteraction(interactionId)
    ? interactionId
    : "exchange";
  const objectInteraction = useObjectInteractionResource(
    objectId,
    objectInteractionKind,
    {
      enabled: Boolean(
        objectId &&
          interactionAvailability.status === "supported" &&
          activeLaneOperation.enabled &&
          isWritableObjectInteraction(interactionId),
      ),
    },
  );
  const scene = useSceneResource({
    enabled:
      interactionAvailability.status === "supported" &&
      activeLaneOperation.enabled &&
      (isWritableStudyInteraction(interactionId) ||
        isWritableObjectInteraction(interactionId)),
  });
  const resource =
    objectInteraction.data ??
    defaultObjectInteractionResource(objectId ?? "", objectInteractionKind);
  const baseDraft = useMemo(() => {
    let nextDraft: PhysicsInteractionDraft;
    if (isWritableObjectInteraction(interactionId)) {
      nextDraft = draftFromInteractionResource(interactionId, resource);
    } else if (isWritableStudyInteraction(interactionId)) {
      nextDraft = draftFromStudyScene(interactionId, scene.data ?? null);
    } else {
      nextDraft = draftFromStudyScene(interactionId, scene.data ?? null);
    }

    if (
      nextDraft.id === "oersted_field" &&
      selectedRegionId &&
      !textDraftValue(nextDraft.values.region_id)
    ) {
      return {
        ...nextDraft,
        values: { ...nextDraft.values, region_id: selectedRegionId },
      };
    }
    if (
      state.interactionSelection.nodeId === selection.nodeId &&
      state.interactionSelection.interactionId === interactionId &&
      typeof state.interactionSelection.active === "boolean"
    ) {
      return {
        ...nextDraft,
        enabled: state.interactionSelection.active,
        present: state.interactionSelection.active,
      };
    }
    return nextDraft;
  }, [
    // The draft intentionally derives from the current lane selection and
    // resource snapshot; preserve this explicit memoization boundary.
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    interactionId,
    resource,
    scene.data,
    selectedRegionId,
    selection.nodeId,
    state.interactionSelection,
  ]);
  const draftKey = draftKeyForInteraction(objectId, baseDraft);
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    key: draftKey,
  });
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;
  const laneIssue = validateInteractionDraftForDiscretization(
    draft,
    interactionDiscretization,
  );
  const canApply =
    Boolean(spec) &&
    activeLaneOperation.enabled &&
    !laneIssue &&
    !isDeferredInteraction(interactionId) &&
    (isWritableStudyInteraction(interactionId) ||
      (Boolean(objectId) && isWritableObjectInteraction(interactionId)));

  function updateDraft(patch: Partial<PhysicsInteractionDraft>): void {
    setDraftState((current) => ({
      draft: {
        ...(current.key === draftKey ? current.draft : baseDraft),
        ...patch,
      },
      key: draftKey,
    }));
  }

  function updateValue(fieldId: string, value: string | string[]): void {
    updateDraft({
      values: {
        ...draft.values,
        [fieldId]: value,
      },
    });
  }

  const applyInteraction = useCallback(async (): Promise<boolean> => {
    if (!activeLaneOperation.enabled) {
      dispatch({
        type: "setMutation",
        key: mutationKey,
        feedback: { kind: "error", message: activeLaneOperation.reason },
      });
      return false;
    }
    const currentLaneIssue = validateInteractionDraftForDiscretization(
      draft,
      interactionDiscretization,
    );
    if (currentLaneIssue) {
      dispatch({
        type: "setMutation",
        key: mutationKey,
        feedback: { kind: "error", message: currentLaneIssue.error },
      });
      return false;
    }
    if (isWritableObjectInteraction(interactionId) && !objectId) {
      dispatch({
        type: "setMutation",
        key: mutationKey,
        feedback: { kind: "error", message: "No selected scene object." },
      });
      return false;
    }

    const result = buildInteractionApplyPatch(draft);
    if ("error" in result) {
      dispatch({
        type: "setMutation",
        key: mutationKey,
        feedback: { kind: "error", message: result.error },
      });
      return false;
    }

    dispatch({ type: "setMutation", key: mutationKey, pending: true });
    try {
      if (result.storage === "object_interaction") {
        await commitObjectInteractionMutation({
          interactionKind: objectInteractionKind,
          objectId: objectId ?? "",
          patch: () =>
            api.model.patchObjectInteraction(
              objectId ?? "",
              objectInteractionKind,
              {
                ...result.patch,
                base_revision: resource.scene_revision,
              },
            ),
          resources,
        });
      } else {
        const response = await api.model.commitTransaction({
          kind: "merge_patch",
          merge_patch: result.patch,
        });
        invalidateInteractionDependents(
          resources,
          acknowledgedAuthoringSceneRevision(response),
        );
      }
      dispatch({
        type: "setMutation",
        key: mutationKey,
        feedback: {
          kind: "success",
          message: `${spec?.label ?? interactionId} updated.`,
        },
      });
      return true;
    } catch (error) {
      if (isRevisionConflict(error)) {
        scene.refetch();
        dispatch({
          type: "setMutation",
          key: mutationKey,
          feedback: {
            kind: "error",
            message:
              "Scene changed while applying this interaction. Draft preserved; scene refetched. Review and retry.",
          },
        });
        return false;
      }
      dispatch({
        type: "setMutation",
        key: mutationKey,
        feedback: { kind: "error", message: errorMessage(error) },
      });
      return false;
    } finally {
      dispatch({ type: "setMutation", key: mutationKey, pending: false });
    }
  }, [
    activeLaneOperation,
    api.model,
    dispatch,
    draft,
    interactionDiscretization,
    interactionId,
    objectId,
    objectInteractionKind,
    resources,
    scene,
    spec,
    mutationKey,
    resource.scene_revision,
  ]);

  if (interactionDiscretization === "unknown") {
    return (
      <PhysicsInteractionLaneStatus
        discretization={interactionDiscretization}
        issue={laneIssue?.error ?? interactionAvailability.reason}
      />
    );
  }

  if (
    !activeLaneOperation.enabled &&
    (interactionId === "current_transport" ||
      interactionId === "spin_torque" ||
      interactionId === "oersted_field")
  ) {
    return (
      <PhysicsInteractionLaneStatus
        capabilityState={activeLaneOperation.state}
        discretization={interactionDiscretization}
        issue={activeLaneOperation.reason}
      />
    );
  }

  if (interactionId === "current_transport") {
    return <CurrentTransportInspectorPanel selection={selection} />;
  }
  if (interactionId === "spin_torque") {
    return <SpinTorqueInspectorPanel selection={selection} />;
  }
  if (interactionId === "oersted_field") {
    return <OerstedFieldInspectorPanel selection={selection} />;
  }

  const physicsStatus = !activeLaneOperation.enabled
    ? interactionAvailability.status === "unsupported" ? "unsupported" as const : "blocked" as const
    : draft.enabled ? "active" as const : "inactive" as const;
  const draftDirty = physicsInteractionDraftDirty(draft, baseDraft);
  const editSessionValid = Boolean(
    spec &&
      activeLaneOperation.enabled &&
      !laneIssue &&
      !isDeferredInteraction(interactionId) &&
      (isWritableStudyInteraction(interactionId) ||
        (Boolean(objectId) && isWritableObjectInteraction(interactionId))),
  );
  const editSessionLockReason = !activeLaneOperation.enabled
    ? activeLaneOperation.reason
    : laneIssue?.error;
  const resetInteractionDraft = () => {
    setDraftState({ draft: baseDraft, key: draftKey });
    dispatch({ type: "setMutation", key: mutationKey, feedback: null });
  };
  return (
    <PhysicsInspectorOverview
      editSession={{
        apply: applyInteraction,
        applying: mutation.pending,
        dirty: draftDirty,
        lockReason: editSessionLockReason,
        mode: "staged",
        reset: resetInteractionDraft,
        valid: editSessionValid,
      }}
      model={buildPhysicsInspectorOverviewModel({
        dependency: {
          requiredSourceIds: [],
          reason: laneIssue?.error ?? activeLaneOperation.reason,
          status: physicsStatus,
        },
        execution: { requestedLane: interactionDiscretization },
        family: interactionId,
        scope: {
          kind: selectedRegionId ? "region" : objectId ? "object" : "global",
          objectId,
          regionId: selectedRegionId,
          stableRef: selectedRegionId
            ? `region:${objectId ?? "unresolved"}:${selectedRegionId}`
            : objectId
              ? `object:${objectId}`
              : "global:physics",
        },
        source: {
          id: interactionId,
          kind: interactionId,
          status: physicsStatus,
        },
        status: physicsStatus,
        statusReason: laneIssue?.error ?? activeLaneOperation.reason,
      })}
      primary={<div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <PhysicsInteractionSelectionSection
        interactionId={interactionId}
        activeLane={activeLane}
        options={interactionOptions}
        draft={draft}
        objectId={objectId}
        sceneData={scene.data}
        selectedRegionId={selectedRegionId}
        onHelpOpen={() => dispatch({ type: "setHelpOpen", open: true })}
        onInteractionChange={(nextInteractionId) =>
          dispatch({
            type: "setInteractionSelection",
            selection: {
              interactionId: nextInteractionId,
              nodeId: selection.nodeId,
            },
          })
        }
        onInteractionToggle={(nextInteractionId, active) =>
          dispatch({
            type: "setInteractionSelection",
            selection: {
              active,
              interactionId: nextInteractionId,
              nodeId: selection.nodeId,
            },
          })
        }
      />
      {laneIssue ? (
        <FeedbackBanner kind="error" message={laneIssue.error} />
      ) : null}
      {!activeLaneOperation.enabled ? (
        <FeedbackBanner
          kind={
            activeLaneOperation.state === "semantic_only" ||
            activeLaneOperation.state === "deferred"
              ? "warning"
              : "error"
          }
          message={activeLaneOperation.reason}
        />
      ) : null}
      {spec ? <PhysicsInteractionContractSection spec={spec} /> : null}
      {isWritableObjectInteraction(interactionId) ? (
        <PhysicsInteractionBackendSection
          enabled={resource.enabled}
          interactionKind={resource.interaction_kind}
          present={resource.present}
          status={objectInteraction.status}
        />
      ) : null}
      <PhysicsInteractionStateSection
        disabled={!activeLaneOperation.enabled}
        draft={draft}
        interactionId={interactionId}
        onPatch={updateDraft}
      />
      <PhysicsInteractionParametersSection
        draft={draft}
        disabled={!activeLaneOperation.enabled}
        interactionId={interactionId}
        spec={spec}
        onValueChange={updateValue}
      />
      <PhysicsInteractionActionsSection
        canApply={canApply}
        feedback={mutation.feedback}
        pending={mutation.pending}
        onApply={() => void applyInteraction()}
        onRevert={() => {
          setDraftState({ draft: baseDraft, key: draftKey });
          dispatch({ type: "setMutation", key: mutationKey, feedback: null });
        }}
      />
      {spec ? (
        <PhysicsInteractionHelpDialog
          open={state.helpOpen}
          spec={spec}
          onOpenChange={(open) => dispatch({ type: "setHelpOpen", open })}
        />
      ) : null}
    </div>}
    />
  );
}

function PhysicsInteractionLaneStatus({
  capabilityState,
  discretization,
  issue,
}: {
  capabilityState?: string;
  discretization: InteractionDiscretization;
  issue: string | undefined;
}) {
  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <InspectorGroup title="Physics interaction lane" defaultOpen>
        <FieldRow
          label="Discretization"
          value={discretization === "unknown" ? "unresolved" : discretization.toUpperCase()}
        />
        {capabilityState ? (
          <FieldRow label="Capability" value={capabilityState} />
        ) : null}
        <FeedbackBanner
          kind="error"
          message={issue ?? "Resolve the FDM/FEM lane before editing interactions."}
        />
      </InspectorGroup>
    </div>
  );
}

function PhysicsInteractionSelectionSection({
  activeLane,
  draft,
  interactionId,
  options,
  objectId,
  onHelpOpen,
  onInteractionChange,
  onInteractionToggle,
  sceneData,
  selectedRegionId,
}: {
  activeLane: ActiveLaneCapabilitySnapshot | null;
  draft: PhysicsInteractionDraft;
  interactionId: PhysicsInteractionId;
  options: readonly PhysicsInteractionSpec[];
  objectId: string | null | undefined;
  onHelpOpen: () => void;
  onInteractionChange: (interactionId: PhysicsInteractionId) => void;
  onInteractionToggle: (interactionId: PhysicsInteractionId, active: boolean) => void;
  sceneData: Parameters<typeof draftFromStudyScene>[1];
  selectedRegionId: string | null;
}) {
  return (
    <InspectorGroup
      title="Physics Interaction"
      collapsible
      defaultOpen
    >
      <FieldRow label="Object ID" value={objectId ?? "no object selection"} />
      {selectedRegionId ? (
        <FieldRow label="Region ID" value={selectedRegionId} />
      ) : null}
      <div className="fm-region-inherited-parameters fm-mb-2">
        {options.map((option) => (
          <PhysicsInteractionChecklistRow
            key={option.id}
            activeLane={activeLane}
            draft={draft}
            interactionId={interactionId}
            objectId={objectId}
            option={option}
            sceneData={sceneData}
            onToggle={onInteractionToggle}
          />
        ))}
      </div>
      <FormField
        label="Interaction"
        type="select"
        value={interactionId}
        onChange={(event) =>
          onInteractionChange(event.target.value as PhysicsInteractionId)
        }
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </FormField>
      <div className="fm-inspector-toolbar">
        <Button
          aria-label="Interaction help"
          size="icon"
          title="Interaction help"
          type="button"
          variant="ghost"
          onClick={onHelpOpen}
        >
          <HelpCircle aria-hidden="true" size={16} />
        </Button>
      </div>
    </InspectorGroup>
  );
}

function PhysicsInteractionChecklistRow({
  activeLane,
  draft,
  interactionId,
  objectId,
  onToggle,
  option,
  sceneData,
}: {
  activeLane: ActiveLaneCapabilitySnapshot | null;
  draft: PhysicsInteractionDraft;
  interactionId: PhysicsInteractionId;
  objectId: string | null | undefined;
  onToggle: (interactionId: PhysicsInteractionId, active: boolean) => void;
  option: PhysicsInteractionSpec;
  sceneData: Parameters<typeof draftFromStudyScene>[1];
}) {
  const objectInteractionKind = isWritableObjectInteraction(option.id)
    ? option.id
    : "exchange";
  const objectInteraction = useObjectInteractionResource(
    objectId,
    objectInteractionKind,
    { enabled: Boolean(objectId && isWritableObjectInteraction(option.id)) },
  );
  const selected = option.id === interactionId;
  const operation = resolveActiveLaneOperation(
    activeLane,
    `interaction.${option.id}`,
  );
  const objectActive = Boolean(
    objectInteraction.data?.present && objectInteraction.data?.enabled,
  );
  const studyDraft = isWritableStudyInteraction(option.id)
    ? draftFromStudyScene(option.id, sceneData)
    : null;
  const checked = selected
    ? draft.present && draft.enabled
    : objectActive || Boolean(studyDraft?.present && studyDraft.enabled);
  const disabled = isDeferredInteraction(option.id) || !operation.enabled;

  return (
    <label
      className="fm-inspector-checkbox-row"
      title={operation.enabled ? undefined : operation.reason}
    >
      <input
        className="fm-inspector-checkbox"
        checked={checked}
        disabled={disabled}
        type="checkbox"
        onChange={(event) => onToggle(option.id, event.target.checked)}
      />
      <span>{option.label}</span>
      <span className="fm-inspector-checkbox-row__meta">
        {operation.enabled ? statusLabel(option.availability) : operation.state}
      </span>
    </label>
  );
}

function PhysicsInteractionContractSection({
  spec,
}: {
  spec: PhysicsInteractionSpec;
}) {
  return (
    <InspectorGroup title="Contract" collapsible defaultOpen>
      <FieldRow label="Scope" value={scopeLabel(spec.scope)} />
      <FieldRow label="Storage" value={storageLabel(spec.storage)} />
      <FieldRow label="Status" value={statusLabel(spec.availability)} />
      {spec.writableReason ? (
        <FieldRow label="Write path" value={spec.writableReason} />
      ) : null}
    </InspectorGroup>
  );
}

function PhysicsInteractionBackendSection({
  enabled,
  interactionKind,
  present,
  status,
}: {
  enabled: boolean;
  interactionKind: string;
  present: boolean;
  status: string;
}) {
  return (
    <InspectorGroup
      title="Backend Resource"
      collapsible
      defaultOpen={false}
    >
      <FieldRow label="Fetch state" value={status} />
      <FieldRow label="Present" value={present ? "yes" : "no"} />
      <FieldRow label="Enabled" value={enabled ? "yes" : "no"} />
      <FieldRow label="Kind" value={interactionKind} />
    </InspectorGroup>
  );
}

function PhysicsInteractionStateSection({
  disabled,
  draft,
  interactionId,
  onPatch,
}: {
  disabled: boolean;
  draft: PhysicsInteractionDraft;
  interactionId: PhysicsInteractionId;
  onPatch: (patch: Partial<PhysicsInteractionDraft>) => void;
}) {
  return (
    <InspectorGroup title="State" collapsible defaultOpen>
      <FormField
        label="Present"
        type="checkbox"
        disabled={
          disabled || interactionId === "exchange" || interactionId === "demag"
        }
        checked={draft.present}
        onChange={(event) => onPatch({ present: event.target.checked })}
      />
      <FormField
        label="Enabled"
        type="checkbox"
        disabled={disabled || !draft.present}
        checked={draft.enabled}
        onChange={(event) => onPatch({ enabled: event.target.checked })}
      />
    </InspectorGroup>
  );
}

function PhysicsInteractionParametersSection({
  draft,
  disabled,
  interactionId,
  onValueChange,
  spec,
}: {
  draft: PhysicsInteractionDraft;
  disabled: boolean;
  interactionId: PhysicsInteractionId;
  onValueChange: (fieldId: string, value: string | string[]) => void;
  spec: PhysicsInteractionSpec | undefined;
}) {
  return (
    <InspectorGroup title="Parameters" collapsible defaultOpen>
      {spec && spec.fields.length > 0 ? (
        spec.fields.map((field) => (
          <InteractionField
            key={field.id}
            disabled={disabled || isDeferredInteraction(interactionId)}
            field={field}
            value={draft.values[field.id]}
            onChange={(value) => onValueChange(field.id, value)}
          />
        ))
      ) : (
        <FieldRow label="Parameters" value="No explicit parameters" />
      )}
    </InspectorGroup>
  );
}

function PhysicsInteractionActionsSection({
  canApply,
  feedback,
  onApply,
  onRevert,
  pending,
}: {
  canApply: boolean;
  feedback: Feedback;
  onApply: () => void;
  onRevert: () => void;
  pending: boolean;
}) {
  return (
    <InspectorGroup title="Actions">
      <div className="fm-inspector-toolbar">
        <Button
          disabled={pending || !canApply}
          size="sm"
          type="button"
          variant="primary"
          onClick={onApply}
        >
          Apply Interaction
        </Button>
        <Button
          disabled={pending}
          size="sm"
          type="button"
          variant="ghost"
          onClick={onRevert}
        >
          Revert
        </Button>
      </div>
      {feedback ? (
        <FeedbackBanner kind={feedback.kind} message={feedback.message} />
      ) : null}
    </InspectorGroup>
  );
}

function PhysicsInteractionHelpDialog({
  onOpenChange,
  open,
  spec,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  spec: PhysicsInteractionSpec;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="fm-physics-interaction-help-description">
        <DialogHeader>
          <DialogTitle>{spec.label}</DialogTitle>
          <DialogDescription id="fm-physics-interaction-help-description">
            {spec.description}
          </DialogDescription>
        </DialogHeader>
        <div className="fm-inspector-panel">
          <FieldRow label="Scope" value={scopeLabel(spec.scope)} />
          <FieldRow label="Storage" value={storageLabel(spec.storage)} />
          {spec.fields.map((field) => (
            <FieldRow
              key={field.id}
              label={field.label}
              unit={field.unit ?? undefined}
              value={field.description}
            />
          ))}
        </div>
        <DialogFooter>
          <Button size="sm" type="button" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InteractionField({
  disabled,
  field,
  onChange,
  value,
}: {
  disabled: boolean;
  field: InteractionFieldSpec;
  onChange: (value: string | string[]) => void;
  value: string | string[] | undefined;
}) {
  if (field.kind === "select") {
    return (
      <FormField
        disabled={disabled}
        hint={field.description}
        label={field.label}
        type="select"
        value={textDraftValue(value) || String(field.defaultValue)}
        onChange={(event) => onChange(event.target.value)}
      >
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </FormField>
    );
  }

  if (field.kind === "vector3") {
    const values = vectorDraftValue(value, field.defaultValue, 3) as [string, string, string];
    return (
      <Vector3Field
        disabled={disabled}
        label={field.label}
        unit={field.unit ?? undefined}
        values={values}
        onChange={(index, val) => {
          const next = [...values];
          next[index] = val;
          onChange(next);
        }}
      />
    );
  }

  if (field.kind === "vector6") {
    const values = vectorDraftValue(value, field.defaultValue, 6);
    return (
      <>
        {values.map((entry, index) => {
          const componentId = vectorComponentId("vector6", index);
          return (
            <FormField
              key={`${field.id}:${componentId}`}
              disabled={disabled}
              hint={index === 5 ? field.description : undefined}
              label={`${field.label} ${index + 1}`}
              type="text"
              unit={field.unit ?? undefined}
              value={entry}
              onChange={(event) => {
                const next = [...values];
                next[index] = event.target.value;
                onChange(next);
              }}
            />
          );
        })}
      </>
    );
  }

  return (
    <FormField
      disabled={disabled}
      hint={field.description}
      label={field.label}
      type="text"
      unit={field.unit ?? undefined}
      value={textDraftValue(value)}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function textDraftValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function vectorDraftValue(
  value: string | string[] | undefined,
  fallback: string | string[],
  length: number,
): string[] {
  const source = Array.isArray(value)
    ? value
    : Array.isArray(fallback)
      ? fallback
      : Array.from({ length }, () => fallback);
  return Array.from({ length }, (_, index) => source[index] ?? "");
}

function vectorComponentId(
  kind: Extract<InteractionFieldSpec["kind"], "vector3" | "vector6">,
  index: number,
): string {
  const labels =
    kind === "vector3"
      ? ["x", "y", "z"]
      : ["xx", "xy", "xz", "yx", "yy", "yz"];
  return labels[index] ?? String(index + 1);
}

function scopeLabel(scope: string): string {
  if (scope === "global") return "Global";
  if (scope === "global_or_region") return "Global or region";
  return "Object or region";
}

function storageLabel(storage: string): string {
  if (storage === "object_interaction") return "Object interaction resource";
  if (storage === "study") return "Study transaction";
  return "Planner/backend deferred";
}

function statusLabel(availability: string): string {
  if (availability === "object") return "Writable per object";
  if (availability === "study") return "Writable globally";
  return "Backend supported, authoring deferred";
}

function interactionIdFromSelection(
  nodeId: string | null,
): PhysicsInteractionId | null {
  const raw = nodeId?.split(":").at(-1);
  if (
    raw === "exchange" ||
    raw === "demag" ||
    raw === "zeeman" ||
    raw === "current_transport" ||
    raw === "spin_torque" ||
    raw === "interfacial_dmi" ||
    raw === "bulk_dmi" ||
    raw === "uniaxial_anisotropy" ||
    raw === "cubic_anisotropy" ||
    raw === "oersted_field" ||
    raw === "magnetoelastic"
  ) {
    return raw;
  }
  return null;
}
