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
  MODEL_REGIONS_RESOURCE_KEY,
  resolveObjectMeshQualityResourceKey,
  resolveObjectMeshReportResourceKey,
  SCENE_RESOURCE_KEY,
  useModelRegionsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { Accordion } from "@/shared/ui/Accordion";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  buildObjectRegionPatch,
  objectRegionDraftFromModel,
  objectRegionDraftKey,
  resolveObjectRegionPanelModel,
  type ObjectRegionDraft,
} from "./ObjectRegionsPanelModel";

interface DraftState {
  draft: ObjectRegionDraft;
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

export function ObjectRegionsPanel({ selection }: InspectorPanelProps) {
  const { api, resources } = useKernel();
  const scene = useSceneResource();
  const regions = useModelRegionsResource();
  const model = useMemo(
    () =>
      resolveObjectRegionPanelModel(
        selection,
        scene.data,
        regions.data ?? null,
      ),
    [regions.data, scene.data, selection],
  );
  const baseDraft = useMemo(() => objectRegionDraftFromModel(model), [model]);
  const draftKey = objectRegionDraftKey(model);
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    key: draftKey,
  });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;

  function updateDraft(patch: Partial<ObjectRegionDraft>): void {
    setDraftState((current) => ({
      draft: {
        ...(current.key === draftKey ? current.draft : baseDraft),
        ...patch,
      },
      key: draftKey,
    }));
  }

  async function applyRegion(): Promise<void> {
    if (model.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return;
    }

    setPending(true);
    try {
      const response = await api.model.patchRegion(
        model.regionId,
        buildObjectRegionPatch(draft),
      );
      const revision =
        typeof response.revision === "number" ? response.revision : Date.now();
      resources.invalidate(SCENE_RESOURCE_KEY, revision);
      resources.invalidate(MODEL_REGIONS_RESOURCE_KEY, revision);
      resources.invalidate(MODEL_GEOMETRY_VALIDATION_PATH, revision);
      resources.invalidate(MODEL_GEOMETRY_DIAGNOSTICS_PATH, revision);
      resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, revision);
      resources.invalidate(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY, revision);
      resources.invalidate(resolveObjectMeshReportResourceKey(model.objectId), revision);
      resources.invalidate(resolveObjectMeshQualityResourceKey(model.objectId), revision);
      setFeedback({ kind: "success", message: "Object region updated." });
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
      defaultValue={["regions", "state", "actions"]}
    >
      <InspectorSection value="regions" title="Object Regions" collapsible defaultCollapsed={false}>
        <FieldRow label="Object ID" value={model.objectId} />
        <FieldRow label="Region ID" value={model.regionId} />
        <FieldRow label="Source" value={model.source} />
        <FieldRow label="Material ref" value={model.materialRef} />
        <FieldRow label="Magnetization ref" value={model.magnetizationRef} />
        <FieldRow label="Scene fetch" value={scene.status} />
        <FieldRow label="Regions fetch" value={regions.status} />
      </InspectorSection>

      <InspectorSection value="state" title="Region State">
        <FormField
          label="Region name"
          mono={false}
          type="text"
          value={draft.name}
          onChange={(event) => updateDraft({ name: event.target.value })}
        />
        <FormField
          label="Enabled"
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => updateDraft({ enabled: event.target.checked })}
        />
      </InspectorSection>

      <InspectorSection value="actions" title="Actions">
        <div className="fm-inspector-toolbar">
          <Button
            disabled={pending || model.mode !== "committed"}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => void applyRegion()}
          >
            Apply Region
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
    </Accordion>
  );
}
