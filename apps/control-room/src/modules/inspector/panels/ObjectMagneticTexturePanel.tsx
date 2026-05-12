"use client";

import { useMemo, useState } from "react";

import {
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
} from "@/kernel/api/apiPaths";
import { useKernel } from "@/kernel/KernelContext";
import {
  SCENE_RESOURCE_KEY,
  VISUALIZATION_STATE_RESOURCE_KEY,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  buildMagnetizationAssignmentPatch,
  objectMagneticTextureDraftFromModel,
  objectMagneticTextureDraftKey,
  resolveObjectMagneticTexturePanelModel,
  type ObjectMagneticTextureDraft,
} from "./ObjectMagneticTexturePanelModel";

interface DraftState {
  draft: ObjectMagneticTextureDraft;
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

export function ObjectMagneticTexturePanel({
  selection,
}: InspectorPanelProps) {
  const { api, resources } = useKernel();
  const scene = useSceneResource();
  const model = useMemo(
    () => resolveObjectMagneticTexturePanelModel(selection, scene.data),
    [scene.data, selection],
  );
  const baseDraft = useMemo(
    () => objectMagneticTextureDraftFromModel(model),
    [model],
  );
  const draftKey = objectMagneticTextureDraftKey(model);
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    key: draftKey,
  });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;

  function updateDraft(patch: Partial<ObjectMagneticTextureDraft>): void {
    setDraftState((current) => ({
      draft: {
        ...(current.key === draftKey ? current.draft : baseDraft),
        ...patch,
      },
      key: draftKey,
    }));
  }

  async function applyTexture(): Promise<void> {
    if (model.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return;
    }

    setPending(true);
    try {
      const response = await api.model.patchObject(
        model.objectId,
        buildMagnetizationAssignmentPatch(draft, model.baseRevision),
      );
      const revision =
        typeof response.revision === "number" ? response.revision : Date.now();
      resources.invalidate(SCENE_RESOURCE_KEY, revision);
      resources.invalidate(MODEL_GEOMETRY_VALIDATION_PATH, revision);
      resources.invalidate(MODEL_GEOMETRY_DIAGNOSTICS_PATH, revision);
      resources.invalidate(VISUALIZATION_STATE_RESOURCE_KEY, revision);
      setFeedback({
        kind: "success",
        message: "Magnetic texture assignment updated.",
      });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fm-inspector-panel">
      <InspectorSection title="Magnetic Texture">
        <FieldRow label="Object ID" value={model.objectId} />
        <FieldRow label="Texture ref" value={model.assetId} />
        <FieldRow label="Asset label" value={model.assetLabel} />
        <FieldRow label="Asset kind" value={model.assetKind} />
        <FieldRow label="Preset" value={model.presetKind} />
        <FieldRow label="Scene fetch" value={scene.status} />
      </InspectorSection>

      <InspectorSection title="Assignment">
        <label className="fm-inspector-edit-field">
          <span>Magnetization ref</span>
          <input
            aria-label="Magnetization ref"
            value={draft.magnetizationRef}
            onChange={(event) =>
              updateDraft({ magnetizationRef: event.target.value })
            }
          />
        </label>
      </InspectorSection>

      <InspectorSection title="Texture Mapping">
        <label className="fm-inspector-edit-field">
          <span>Mapping</span>
          <textarea readOnly rows={5} value={model.mapping} />
        </label>
        <label className="fm-inspector-edit-field">
          <span>Texture transform</span>
          <textarea readOnly rows={5} value={model.textureTransform} />
        </label>
      </InspectorSection>

      <InspectorSection title="Transactions">
        <div className="fm-inspector-actions">
          <Button
            disabled={pending || model.mode !== "committed"}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => void applyTexture()}
          >
            Apply Texture
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
