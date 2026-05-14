"use client";

import { HelpCircle } from "lucide-react";
import { useMemo, useState } from "react";

import { MODEL_SCENE_PATH, MODEL_STUDY_PATH } from "@/kernel/api/apiPaths";
import { useKernel } from "@/kernel/KernelContext";
import {
  resolveObjectInteractionResourceKey,
  useObjectInteractionResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import type { InteractionFieldSpec } from "@/shared/domain/physics/interactions";
import { Accordion } from "@/shared/ui/Accordion";
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
import { InspectorSection } from "../primitives/InspectorSection";
import {
  buildInteractionApplyPatch,
  defaultObjectInteractionResource,
  draftFromInteractionResource,
  draftFromStudyScene,
  draftKeyForInteraction,
  interactionSelectOptions,
  isDeferredInteraction,
  isWritableObjectInteraction,
  isWritableStudyInteraction,
  type PhysicsInteractionDraft,
  type PhysicsInteractionId,
} from "./PhysicsInteractionPanelModel";

interface DraftState {
  draft: PhysicsInteractionDraft;
  key: string;
}

interface InteractionSelectionState {
  interactionId: PhysicsInteractionId;
  nodeId: string | null;
}

type Feedback =
  | {
      kind: "error" | "success";
      message: string;
    }
  | null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function PhysicsInteractionPanel({ selection }: InspectorPanelProps) {
  const objectId = selection.objectId;
  const selectedRegionId =
    selection.ref?.type === "scene-object" ? selection.ref.regionId ?? null : null;
  const { api, resources } = useKernel();
  const selectedInteractionId =
    interactionIdFromSelection(selection.nodeId) ?? "exchange";
  const [interactionSelection, setInteractionSelection] =
    useState<InteractionSelectionState>({
      interactionId: selectedInteractionId,
      nodeId: selection.nodeId,
    });
  const interactionId =
    interactionSelection.nodeId === selection.nodeId
      ? interactionSelection.interactionId
      : selectedInteractionId;
  const [helpOpen, setHelpOpen] = useState(false);

  const spec = interactionSelectOptions().find((entry) => entry.id === interactionId);
  const objectInteractionKind = isWritableObjectInteraction(interactionId)
    ? interactionId
    : "exchange";
  const objectInteraction = useObjectInteractionResource(
    objectId,
    objectInteractionKind,
    { enabled: Boolean(objectId && isWritableObjectInteraction(interactionId)) },
  );
  const scene = useSceneResource({
    enabled: isWritableStudyInteraction(interactionId),
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
    return nextDraft;
  }, [interactionId, resource, scene.data, selectedRegionId]);
  const draftKey = draftKeyForInteraction(objectId, baseDraft);
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    key: draftKey,
  });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;
  const canApply =
    Boolean(spec) &&
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

  async function applyInteraction(): Promise<void> {
    if (isWritableObjectInteraction(interactionId) && !objectId) {
      setFeedback({ kind: "error", message: "No selected scene object." });
      return;
    }

    const result = buildInteractionApplyPatch(draft);
    if ("error" in result) {
      setFeedback({ kind: "error", message: result.error });
      return;
    }

    setPending(true);
    try {
      if (result.storage === "object_interaction") {
        await api.model.patchObjectInteraction(
          objectId ?? "",
          objectInteractionKind,
          result.patch,
        );
      } else {
        await api.model.commitTransaction({
          kind: "merge_patch",
          merge_patch: result.patch,
        });
      }
      const revision = Date.now();
      if (result.storage === "object_interaction" && objectId) {
        resources.invalidate(
          resolveObjectInteractionResourceKey(objectId, objectInteractionKind),
          revision,
        );
      }
      resources.invalidate(MODEL_SCENE_PATH, revision);
      resources.invalidate(MODEL_STUDY_PATH, revision);
      resources.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
      setFeedback({
        kind: "success",
        message: `${spec?.label ?? interactionId} updated.`,
      });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <Accordion
      className="fm-inspector-panel"
      type="multiple"
      defaultValue={["interaction", "contract", "backend", "state", "parameters", "actions"]}
    >
      <InspectorSection value="interaction" title="Physics Interaction" collapsible defaultCollapsed={false}>
        <FieldRow label="Object ID" value={objectId ?? "no object selection"} />
        {selectedRegionId && <FieldRow label="Region ID" value={selectedRegionId} />}
        <FormField
          label="Interaction"
          type="select"
          value={interactionId}
          onChange={(event) => {
            setFeedback(null);
            setInteractionSelection({
              interactionId: event.target.value as PhysicsInteractionId,
              nodeId: selection.nodeId,
            });
          }}
        >
          {interactionSelectOptions().map((option) => (
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
            onClick={() => setHelpOpen(true)}
          >
            <HelpCircle aria-hidden="true" size={16} />
          </Button>
        </div>
      </InspectorSection>

      {spec && (
        <InspectorSection value="contract" title="Contract">
          <FieldRow label="Scope" value={scopeLabel(spec.scope)} />
          <FieldRow label="Storage" value={storageLabel(spec.storage)} />
          <FieldRow label="Status" value={statusLabel(spec.availability)} />
          {spec.writableReason && <FieldRow label="Write path" value={spec.writableReason} />}
        </InspectorSection>
      )}

      {isWritableObjectInteraction(interactionId) && (
        <InspectorSection value="backend" title="Backend Resource" collapsible defaultCollapsed={true}>
          <FieldRow label="Fetch state" value={objectInteraction.status} />
          <FieldRow label="Present" value={resource.present ? "yes" : "no"} />
          <FieldRow label="Enabled" value={resource.enabled ? "yes" : "no"} />
          <FieldRow label="Kind" value={resource.interaction_kind} />
        </InspectorSection>
      )}

      <InspectorSection value="state" title="State">
        <FormField
          label="Present"
          type="checkbox"
          disabled={interactionId === "exchange" || interactionId === "demag"}
          checked={draft.present}
          onChange={(event) => updateDraft({ present: event.target.checked })}
        />
        <FormField
          label="Enabled"
          type="checkbox"
          disabled={!draft.present}
          checked={draft.enabled}
          onChange={(event) => updateDraft({ enabled: event.target.checked })}
        />
      </InspectorSection>

      <InspectorSection value="parameters" title="Parameters">
        {spec && spec.fields.length > 0 ? (
          spec.fields.map((field) => (
            <InteractionField
              key={field.id}
              disabled={isDeferredInteraction(interactionId)}
              field={field}
              value={draft.values[field.id]}
              onChange={(value) => updateValue(field.id, value)}
            />
          ))
        ) : (
          <FieldRow label="Parameters" value="No explicit parameters" />
        )}
      </InspectorSection>

      <InspectorSection value="actions" title="Actions">
        <div className="fm-inspector-toolbar">
          <Button
            disabled={pending || !canApply}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => void applyInteraction()}
          >
            Apply Interaction
          </Button>
          <Button
            disabled={pending}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              setDraftState({ draft: baseDraft, key: draftKey });
              setFeedback(null);
            }}
          >
            Revert
          </Button>
        </div>
        {feedback && <FeedbackBanner kind={feedback.kind} message={feedback.message} />}
      </InspectorSection>

      {spec && (
        <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
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
              <Button size="sm" type="button" onClick={() => setHelpOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Accordion>
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

  if (field.kind === "vector3" || field.kind === "vector6") {
    const length = field.kind === "vector3" ? 3 : 6;
    const values = vectorDraftValue(value, field.defaultValue, length);
    return (
      <>
        {values.map((entry, index) => (
          <FormField
            key={`${field.id}:${index}`}
            disabled={disabled}
            hint={index === length - 1 ? field.description : undefined}
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
        ))}
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
