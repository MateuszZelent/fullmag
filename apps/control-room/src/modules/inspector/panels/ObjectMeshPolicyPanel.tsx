"use client";

import { useMemo, useState } from "react";

import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  SCENE_RESOURCE_KEY,
  resolveObjectMeshPolicyResourceKey,
  resolveObjectMeshQualityResourceKey,
  resolveObjectMeshReportResourceKey,
  useObjectMeshPolicyResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useKernel } from "@/kernel/KernelContext";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  buildObjectMeshPolicyReplaceRequest,
  defaultObjectMeshPolicyResource,
  draftFromObjectMeshPolicyResource,
  draftKeyForObjectMeshPolicyResource,
  type ObjectMeshPolicyDraft,
} from "./ObjectMeshPolicyPanelModel";

interface DraftState {
  draft: ObjectMeshPolicyDraft;
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

export function ObjectMeshPolicyPanel({ selection }: InspectorPanelProps) {
  const objectId = selection.objectId;
  const { api, resources } = useKernel();
  const policy = useObjectMeshPolicyResource(objectId);
  const resource = policy.data ?? defaultObjectMeshPolicyResource(objectId ?? "");
  const baseDraft = useMemo(
    () => draftFromObjectMeshPolicyResource(resource),
    [resource],
  );
  const draftKey = draftKeyForObjectMeshPolicyResource(objectId, resource);
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    key: draftKey,
  });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;

  function updateDraft(patch: Partial<ObjectMeshPolicyDraft>): void {
    setDraftState((current) => ({
      draft: {
        ...(current.key === draftKey ? current.draft : baseDraft),
        ...patch,
      },
      key: draftKey,
    }));
  }

  async function applyPolicy(): Promise<void> {
    if (!objectId) {
      setFeedback({ kind: "error", message: "No selected scene object." });
      return;
    }

    const result = buildObjectMeshPolicyReplaceRequest(draft);
    if ("error" in result) {
      setFeedback({ kind: "error", message: result.error });
      return;
    }

    setPending(true);
    try {
      const next = await api.meshing.replaceObjectPolicy(
        objectId,
        result.request,
      );
      const revision = next.revision;
      resources.invalidate(resolveObjectMeshPolicyResourceKey(objectId), revision);
      resources.invalidate(resolveObjectMeshReportResourceKey(objectId), revision);
      resources.invalidate(resolveObjectMeshQualityResourceKey(objectId), revision);
      resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, revision);
      resources.invalidate(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY, revision);
      resources.invalidate(SCENE_RESOURCE_KEY, revision);
      setFeedback({ kind: "success", message: "Object mesh policy updated." });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fm-inspector-panel">
      <InspectorSection title="Object Mesh Policy">
        <FieldRow label="Object ID" value={objectId ?? "no object selection"} />
        <FieldRow label="Fetch state" value={policy.status} />
        <FieldRow label="Revision" value={String(resource.revision)} />
        <FieldRow label="Policy" value={resource.config ? "object override" : "inherited"} />
      </InspectorSection>

      <InspectorSection title="Policy State">
        <label className="fm-inspector-edit-field">
          <span>Use object policy</span>
          <input
            checked={draft.present}
            type="checkbox"
            onChange={(event) => updateDraft({ present: event.target.checked })}
          />
        </label>
      </InspectorSection>

      <InspectorSection title="Config">
        <label className="fm-inspector-edit-field">
          <span>JSON</span>
          <textarea
            aria-label="Object mesh policy config"
            disabled={!draft.present}
            rows={7}
            value={draft.configText}
            onChange={(event) => updateDraft({ configText: event.target.value })}
          />
        </label>
      </InspectorSection>

      <InspectorSection title="Transactions">
        <div className="fm-inspector-actions">
          <Button
            disabled={pending || !objectId}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => void applyPolicy()}
          >
            Apply Mesh Policy
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
            Revert Draft
          </Button>
        </div>
      </InspectorSection>

      {feedback ? (
        <InspectorSection title="Diagnostics">
          <p
            className="fm-inspector-validation-message"
            data-kind={feedback.kind}
          >
            {feedback.message}
          </p>
        </InspectorSection>
      ) : null}
    </div>
  );
}
