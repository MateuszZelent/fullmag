import { useMemo, useState } from "react";

import { MODEL_READINESS_PATH, MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { JsonObject, RegionalFieldDriveResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import {
  buildAntennaCanonicalFieldDrive,
  buildAntennaLegacyMigrationPatch,
  resolveAntennaObjectDraft,
  resolveAntennaObjectPanelModel,
  type AntennaObjectDraft,
} from "./AntennaObjectPanelModel";

type Feedback = {
  kind: "error" | "success";
  message: string;
};

interface DraftState {
  draft: AntennaObjectDraft;
  key: string;
}

interface FeedbackState {
  feedback: Feedback | null;
  key: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidateSceneResource(
  resources: ReturnType<typeof useKernel>["resources"],
  revision: number,
): void {
  resources.invalidate(MODEL_SCENE_PATH, revision);
  resources.invalidate(MODEL_READINESS_PATH, revision);
}

export function AntennaObjectPanel({ selection }: InspectorPanelProps) {
  const { api, resources } = useKernel();
  const scene = useSceneResource();
  const model = resolveAntennaObjectPanelModel(selection, scene.data);
  const baseDraft = useMemo(
    () => resolveAntennaObjectDraft(selection, scene.data),
    [scene.data, selection],
  );
  const draftKey = `${model.objectId}:${scene.data?.revision ?? "none"}`;
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    key: draftKey,
  });
  const [feedbackState, setFeedbackState] = useState<FeedbackState>({
    feedback: null,
    key: draftKey,
  });
  const [pending, setPending] = useState(false);
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;
  const feedback =
    feedbackState.key === draftKey ? feedbackState.feedback : null;

  function updateDraft(patch: Partial<AntennaObjectDraft>): void {
    setDraftState((current) => ({
      draft: { ...(current.key === draftKey ? current.draft : baseDraft), ...patch },
      key: draftKey,
    }));
  }

  function setFeedback(feedbackValue: Feedback | null): void {
    setFeedbackState({ feedback: feedbackValue, key: draftKey });
  }

  async function commitDraft(): Promise<void> {
    setPending(true);
    try {
      const response = model.mode === "canonical" ? await saveCanonicalDrive() : await migrateLegacyDrive();
      invalidateSceneResource(resources, response.scene_revision);
      setFeedback({ kind: "success", message: model.mode === "legacy" ? "Legacy source migrated to a regional field drive." : "Antenna field drive committed." });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  async function saveCanonicalDrive() {
    const patch = buildAntennaCanonicalFieldDrive(selection, scene.data, draft);
    if (patch.error || !patch.drive) throw new Error(patch.error ?? "Invalid antenna drive draft.");
    const drive = patch.drive as unknown as RegionalFieldDriveResource;
    return api.model.replaceFieldDrive(drive.id, { base_revision: scene.data?.revision ?? null, drive });
  }

  async function migrateLegacyDrive() {
    const patch = buildAntennaLegacyMigrationPatch(selection, scene.data, draft);
    if (patch.error || !patch.drives || !patch.modules) throw new Error(patch.error ?? "Invalid legacy antenna migration.");
    return api.model.commitTransaction({ kind: "merge_patch", merge_patch: { field_drives: { drives: patch.drives as JsonObject[] }, current_modules: { modules: patch.modules as JsonObject[] } } });
  }

  return (
    <div className="fm-inspector-panel">
      <InspectorGroup
        title="Antenna"
        badge={model.mode === "canonical" ? "Regional drive" : model.mode === "legacy" ? "Migration required" : "unassigned"}
      >
        {model.mode === "legacy" ? <FeedbackBanner kind="warning" message="Deprecated prescribed_zeeman_mask source. Saving migrates it atomically to RegionalFieldDrive." /> : null}
        <FieldRow label="Object" value={model.objectId} />
        <FieldRow label="Source" value={model.source} />
        <FieldRow label="Amplitude" value={model.amplitude} />
        <FieldRow label="Direction" value={model.direction} />
        <FieldRow label="Spatial profile" value={model.spatialProfile} />
        <FieldRow label="Waveform" value={model.waveform} />
        <FormField
          label="Amplitude"
          unit="T"
          value={draft.amplitudeB}
          onChange={(event) => updateDraft({ amplitudeB: event.target.value })}
        />
        <FormField
          label="Direction"
          value={draft.direction}
          onChange={(event) => updateDraft({ direction: event.target.value })}
        />
        <FormField
          label="Waveform"
          type="select"
          value={draft.waveformKind}
          onChange={(event) =>
            updateDraft({
              waveformKind: event.target.value as AntennaObjectDraft["waveformKind"],
            })
          }
        >
          <option value="constant">Constant</option>
          <option value="sinc_pulse">Sinc pulse</option>
          <option value="sinusoidal">Sinusoidal</option>
        </FormField>
        {draft.waveformKind === "sinc_pulse" ? (
          <>
            <FormField
              label="Cutoff"
              unit="Hz"
              value={draft.sincCutoffHz}
              onChange={(event) =>
                updateDraft({ sincCutoffHz: event.target.value })
              }
            />
            <FormField
              label="t0"
              unit="s"
              value={draft.sincT0}
              onChange={(event) => updateDraft({ sincT0: event.target.value })}
            />
          </>
        ) : null}
        {draft.waveformKind === "sinusoidal" ? (
          <FormField
            label="Frequency"
            unit="Hz"
            value={draft.sinusoidalFrequencyHz}
            onChange={(event) =>
              updateDraft({ sinusoidalFrequencyHz: event.target.value })
            }
          />
        ) : null}
        {feedback ? (
          <FeedbackBanner kind={feedback.kind} message={feedback.message} />
        ) : null}
        <div className="fm-inspector-toolbar">
          <Button
            disabled={pending || model.mode === "missing"}
            size="sm"
            type="button"
            variant="primary"
            onClick={commitDraft}
          >
            {pending ? "Saving" : model.mode === "legacy" ? "Migrate and save" : "Save field drive"}
          </Button>
        </div>
      </InspectorGroup>
    </div>
  );
}
