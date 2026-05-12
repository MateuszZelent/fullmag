"use client";

import { useMemo, useState } from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import { useKernel } from "@/kernel/KernelContext";
import {
  resolveObjectInteractionResourceKey,
  useObjectInteractionResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  buildInteractionPatch,
  defaultObjectInteractionResource,
  draftFromInteractionResource,
  draftKeyForInteractionResource,
  interactionLabel,
  isOptionalInteraction,
  OBJECT_INTERACTION_KINDS,
  type ObjectInteractionKind,
  type PhysicsInteractionDraft,
} from "./PhysicsInteractionPanelModel";

interface DraftState {
  draft: PhysicsInteractionDraft;
  key: string;
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
  const { api, resources } = useKernel();
  const [interactionKind, setInteractionKind] =
    useState<ObjectInteractionKind>("exchange");
  const interaction = useObjectInteractionResource(objectId, interactionKind);
  const resource =
    interaction.data ??
    defaultObjectInteractionResource(objectId ?? "", interactionKind);
  const baseDraft = useMemo(
    () => draftFromInteractionResource(interactionKind, resource),
    [interactionKind, resource],
  );
  const draftKey = draftKeyForInteractionResource(
    objectId,
    interactionKind,
    resource,
  );
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    key: draftKey,
  });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;
  const required = !isOptionalInteraction(interactionKind);

  function updateDraft(
    patch: Partial<Omit<PhysicsInteractionDraft, "interactionKind">>,
  ): void {
    setDraftState((current) => ({
      draft: {
        ...(current.key === draftKey ? current.draft : baseDraft),
        ...patch,
        interactionKind,
      },
      key: draftKey,
    }));
  }

  async function applyInteraction(): Promise<void> {
    if (!objectId) {
      setFeedback({ kind: "error", message: "No selected scene object." });
      return;
    }

    const result = buildInteractionPatch(draft);
    if ("error" in result) {
      setFeedback({ kind: "error", message: result.error });
      return;
    }

    setPending(true);
    try {
      await api.model.patchObjectInteraction(
        objectId,
        interactionKind,
        result.patch,
      );
      const revision = Date.now();
      resources.invalidate(
        resolveObjectInteractionResourceKey(objectId, interactionKind),
        revision,
      );
      resources.invalidate(MODEL_SCENE_PATH, revision);
      setFeedback({
        kind: "success",
        message: `${interactionLabel(interactionKind)} updated.`,
      });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fm-inspector-panel">
      <InspectorSection title="Object Physics">
        <FieldRow label="Object ID" value={objectId ?? "no object selection"} />
        <FormField
          label="Interaction"
          type="select"
          value={interactionKind}
          onChange={(event) => {
            setFeedback(null);
            setInteractionKind(event.target.value as ObjectInteractionKind);
          }}
        >
          {OBJECT_INTERACTION_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {interactionLabel(kind)}
            </option>
          ))}
        </FormField>
      </InspectorSection>

      <InspectorSection title="Backend Resource" collapsible defaultCollapsed={true}>
        <FieldRow label="Fetch state" value={interaction.status} />
        <FieldRow label="Present" value={resource.present ? "yes" : "no"} />
        <FieldRow label="Enabled" value={resource.enabled ? "yes" : "no"} />
        <FieldRow label="Kind" value={resource.interaction_kind} />
      </InspectorSection>

      <InspectorSection title="Method State">
        <FormField
          label="Present"
          type="checkbox"
          disabled={required}
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

      <InspectorSection title="Parameters">
        <FormField
          label="JSON"
          type="textarea"
          rows={6}
          value={draft.paramsText}
          onChange={(event) => updateDraft({ paramsText: event.target.value })}
        />
      </InspectorSection>

      <InspectorSection title="Actions">
        <div className="fm-inspector-toolbar">
          <Button
            disabled={pending || !objectId}
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
    </div>
  );
}
