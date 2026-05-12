"use client";

import { useMemo, useState } from "react";

import {
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
} from "@/kernel/api/apiPaths";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  SCENE_RESOURCE_KEY,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";
import { resolveGeometryObjectDraft } from "./geometryObjectPanelModel";
import {
  buildMaterialAssignmentPatch,
  materialAssignmentDraftFromRef,
  type MaterialAssignmentDraft,
} from "./ObjectMaterialPanelModel";

interface DraftState {
  draft: MaterialAssignmentDraft;
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

export function ObjectMaterialPanel({ selection }: InspectorPanelProps) {
  const { api, resources } = useKernel();
  const scene = useSceneResource();
  const object = resolveGeometryObjectDraft(selection, scene.data);
  const baseDraft = useMemo(
    () => materialAssignmentDraftFromRef(object.material),
    [object.material],
  );
  const draftKey = [
    object.mode,
    object.objectId,
    object.baseRevision ?? "unknown",
    object.material,
  ].join(":");
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    key: draftKey,
  });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;

  function updateDraft(materialRef: string): void {
    setDraftState({
      draft: { materialRef },
      key: draftKey,
    });
  }

  async function applyMaterial(): Promise<void> {
    if (object.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return;
    }

    setPending(true);
    try {
      const sceneResponse = await api.model.patchObject(
        object.objectId,
        buildMaterialAssignmentPatch(draft, object.baseRevision),
      );
      const revision =
        typeof sceneResponse.revision === "number"
          ? sceneResponse.revision
          : Date.now();
      resources.invalidate(SCENE_RESOURCE_KEY, revision);
      resources.invalidate(MODEL_GEOMETRY_VALIDATION_PATH, revision);
      resources.invalidate(MODEL_GEOMETRY_DIAGNOSTICS_PATH, revision);
      resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, revision);
      resources.invalidate(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY, revision);
      setFeedback({ kind: "success", message: "Object material updated." });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fm-inspector-panel">
      <InspectorSection title="Object Material">
        <FieldRow label="Object ID" value={object.objectId} />
        <FieldRow label="Current material" value={object.material} />
        <FieldRow label="Mode" value={object.mode} />
        <FieldRow
          label="Scene revision"
          value={object.baseRevision === null ? "unknown" : String(object.baseRevision)}
        />
        <FieldRow label="Fetch state" value={scene.status} />
      </InspectorSection>

      <InspectorSection title="Assignment">
        <label className="fm-inspector-edit-field">
          <span>Material ref</span>
          <input
            aria-label="Material ref"
            value={draft.materialRef}
            onChange={(event) => updateDraft(event.target.value)}
          />
        </label>
      </InspectorSection>

      <InspectorSection title="Transactions">
        <div className="fm-inspector-actions">
          <Button
            disabled={pending || object.mode !== "committed"}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => void applyMaterial()}
          >
            Apply Material
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
