import { useMemo, useState } from "react";

import { MODEL_READINESS_PATH, MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { JsonObject, RegionalFieldDriveResource } from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { useKernel } from "@/kernel/KernelContext";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
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
  antennaWaveformDefaults,
  antennaObjectDraftKey,
  isAntennaObjectRevisionConflict,
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
  dirtyKeys: Array<keyof AntennaObjectDraft>;
  key: string;
}

interface FeedbackState {
  feedback: Feedback | null;
  key: string;
}

type RevisionConflictPhase =
  | "conflict"
  | "refresh-error"
  | "refreshing"
  | "rebased"
  | "refetched";

interface RevisionConflictState {
  baseRevision: number;
  key: string;
  phase: RevisionConflictPhase;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sceneRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function invalidateSceneResource(
  resources: ReturnType<typeof useKernel>["resources"],
  revision: number,
): void {
  resources.invalidate(MODEL_SCENE_PATH, revision);
  resources.invalidate(MODEL_READINESS_PATH, revision);
}

export function AntennaObjectPanel({ selection }: InspectorPanelProps) {
  const { api, authoringHistory, resources } = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const scene = useSceneResource();
  const model = resolveAntennaObjectPanelModel(selection, scene.data);
  const baseDraft = useMemo(
    () => resolveAntennaObjectDraft(selection, scene.data),
    [scene.data, selection],
  );
  const draftKey = antennaObjectDraftKey(selection, scene.data);
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    dirtyKeys: [],
    key: draftKey,
  });
  const [feedbackState, setFeedbackState] = useState<FeedbackState>({
    feedback: null,
    key: draftKey,
  });
  const [pending, setPending] = useState(false);
  const [revisionConflictState, setRevisionConflictState] =
    useState<RevisionConflictState | null>(null);
  const baseRevision = sceneRevision(scene.data?.revision);
  const canCommit =
    scene.status === "ready" && baseRevision !== null && model.mode !== "missing";
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;
  const feedback =
    feedbackState.key === draftKey ? feedbackState.feedback : null;
  const revisionConflict =
    revisionConflictState?.key === draftKey ? revisionConflictState : null;
  const conflictBaseRevision = revisionConflict?.baseRevision ?? null;
  const conflictPhase = revisionConflict?.phase ?? null;
  const conflictViewPhase =
    revisionConflict && conflictPhase === "refreshing"
      ? scene.status === "error"
        ? "refresh-error"
        : scene.status === "ready" &&
            baseRevision !== null &&
            conflictBaseRevision !== null &&
            baseRevision !== conflictBaseRevision
          ? "refetched"
          : "refreshing"
      : conflictPhase;

  function updateDraft(patch: Partial<AntennaObjectDraft>): void {
    setDraftState((current) => {
      const dirtyKeys = current.key === draftKey ? current.dirtyKeys : [];
      return {
        draft: { ...(current.key === draftKey ? current.draft : baseDraft), ...patch },
        dirtyKeys: [...new Set([...dirtyKeys, ...(Object.keys(patch) as Array<keyof AntennaObjectDraft>)])],
        key: draftKey,
      };
    });
  }

  function setFeedback(feedbackValue: Feedback | null): void {
    setFeedbackState({ feedback: feedbackValue, key: draftKey });
  }

  async function commitDraft(): Promise<void> {
    if (!canCommit || baseRevision === null) {
      setFeedback({
        kind: "error",
        message: "Scene revision is unavailable; refresh before saving.",
      });
      return;
    }
    if (revisionConflict && revisionConflict.phase !== "rebased") {
      setFeedback({
        kind: "error",
        message: "Refetch and rebase the server change before saving again.",
      });
      return;
    }
    setPending(true);
    try {
      const response = await runAuthoringMutationWithHistory(
        { api, authoringHistory, sessionScopeKey },
        model.mode === "canonical"
          ? `Update antenna drive ${model.objectId}`
          : `Migrate antenna drive ${model.objectId}`,
        async () =>
          model.mode === "canonical"
            ? saveCanonicalDrive(baseRevision)
            : migrateLegacyDrive(baseRevision),
      );
      invalidateSceneResource(resources, response.scene_revision);
      setRevisionConflictState(null);
      setFeedback({ kind: "success", message: model.mode === "legacy" ? "Legacy source migrated to a regional field drive." : "Antenna field drive committed." });
    } catch (error) {
      if (isAntennaObjectRevisionConflict(error) && baseRevision !== null) {
        setRevisionConflictState({
          baseRevision,
          key: draftKey,
          phase: "conflict",
        });
        setFeedback({
          kind: "error",
          message: "The antenna field drive changed on the server. Refetch and compare before retrying.",
        });
      } else {
        setFeedback({ kind: "error", message: errorMessage(error) });
      }
    } finally {
      setPending(false);
    }
  }

  function refetchAfterRevisionConflict(): void {
    if (!revisionConflict) return;
    setRevisionConflictState({
      ...revisionConflict,
      phase: "refreshing",
    });
    setFeedback({ kind: "error", message: "Refetching the canonical scene…" });
    scene.refetch();
  }

  function rebaseAfterRevisionConflict(): void {
    if (!revisionConflict || conflictViewPhase !== "refetched") return;
    setDraftState((current) => {
      if (current.key !== draftKey) return { draft: baseDraft, dirtyKeys: [], key: draftKey };
      const edited = Object.fromEntries(
        current.dirtyKeys.map((key) => [key, current.draft[key]]),
      ) as Partial<AntennaObjectDraft>;
      return {
        draft: { ...baseDraft, ...edited },
        dirtyKeys: current.dirtyKeys,
        key: draftKey,
      };
    });
    setRevisionConflictState({
      ...revisionConflict,
      phase: "rebased",
    });
    setFeedback({
      kind: "error",
      message: "Draft rebased onto the latest server revision. Review and retry Save.",
    });
  }

  async function saveCanonicalDrive(baseRevisionValue: number) {
    const patch = buildAntennaCanonicalFieldDrive(selection, scene.data, draft);
    if (patch.error || !patch.drive) throw new Error(patch.error ?? "Invalid antenna drive draft.");
    const drive = patch.drive as unknown as RegionalFieldDriveResource;
    return api.model.replaceFieldDrive(
      drive.id,
      {
        base_revision: baseRevisionValue,
        drive,
      },
      sessionScopeKey ? { sessionScopeKey } : undefined,
    );
  }

  async function migrateLegacyDrive(baseRevisionValue: number) {
    const patch = buildAntennaLegacyMigrationPatch(selection, scene.data, draft);
    if (patch.error || !patch.drives || !patch.modules) throw new Error(patch.error ?? "Invalid legacy antenna migration.");
    return api.model.commitTransaction({
      base_revision: baseRevisionValue,
      kind: "merge_patch",
      merge_patch: {
        field_drives: { drives: patch.drives as JsonObject[] },
        current_modules: { modules: patch.modules as JsonObject[] },
      },
    }, sessionScopeKey ? { sessionScopeKey } : undefined);
  }

  return (
    <div className="fm-inspector-panel">
      <InspectorGroup
        title="Regional field drive"
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
          onChange={(event) => {
            const waveformKind = event.target.value as AntennaObjectDraft["waveformKind"];
            if (waveformKind !== draft.waveformKind) {
              updateDraft({ waveformKind, ...antennaWaveformDefaults[waveformKind] });
            }
          }}
        >
          <option value="constant">Constant</option>
          <option value="sinc_pulse">Sinc pulse</option>
          <option value="sinusoidal">Sinusoidal</option>
        </FormField>
        {draft.waveformKind === "sinc_pulse" ? (
          <>
            <FormField
              label="Waveform amplitude"
              type="number"
              value={draft.sincAmplitude}
              onChange={(event) =>
                updateDraft({ sincAmplitude: event.target.value })
              }
            />
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
          <>
            <FormField
              label="Frequency"
              unit="Hz"
              value={draft.sinusoidalFrequencyHz}
              onChange={(event) =>
                updateDraft({ sinusoidalFrequencyHz: event.target.value })
              }
            />
            <FormField
              label="Phase"
              unit="rad"
              type="number"
              value={draft.sinusoidalPhaseRad}
              onChange={(event) =>
                updateDraft({ sinusoidalPhaseRad: event.target.value })
              }
            />
            <FormField
              label="Offset"
              type="number"
              value={draft.sinusoidalOffset}
              onChange={(event) =>
                updateDraft({ sinusoidalOffset: event.target.value })
              }
            />
          </>
        ) : null}
        {feedback ? (
          <FeedbackBanner kind={feedback.kind} message={feedback.message} />
        ) : null}
        {revisionConflict ? (
          <InspectorGroup
            title="Revision conflict"
            badge={conflictViewPhase ?? undefined}
          >
            <FieldRow
              label="Conflict base revision"
              value={String(revisionConflict.baseRevision)}
            />
            <FieldRow
              label="Server revision"
              value={baseRevision === null ? "unavailable" : String(baseRevision)}
            />
            <FieldRow label="Draft amplitude" value={draft.amplitudeB} unit="T" />
            <FieldRow label="Server amplitude" value={baseDraft.amplitudeB} unit="T" />
            <FieldRow label="Draft direction" value={draft.direction} />
            <FieldRow label="Server direction" value={baseDraft.direction} />
            <FieldRow label="Draft waveform" value={draft.waveformKind} />
            <FieldRow label="Server waveform" value={baseDraft.waveformKind} />
            {draft.waveformKind === "sinusoidal" ? (
              <>
                <FieldRow label="Draft frequency" value={draft.sinusoidalFrequencyHz} unit="Hz" />
                <FieldRow label="Draft phase" value={draft.sinusoidalPhaseRad} unit="rad" />
                <FieldRow label="Draft offset" value={draft.sinusoidalOffset} />
              </>
            ) : null}
            {baseDraft.waveformKind === "sinusoidal" ? (
              <>
                <FieldRow label="Server frequency" value={baseDraft.sinusoidalFrequencyHz} unit="Hz" />
                <FieldRow label="Server phase" value={baseDraft.sinusoidalPhaseRad} unit="rad" />
                <FieldRow label="Server offset" value={baseDraft.sinusoidalOffset} />
              </>
            ) : null}
            {draft.waveformKind === "sinc_pulse" ? (
              <>
                <FieldRow label="Draft waveform amplitude" value={draft.sincAmplitude} />
                <FieldRow label="Draft cutoff" value={draft.sincCutoffHz} unit="Hz" />
                <FieldRow label="Draft t0" value={draft.sincT0} unit="s" />
              </>
            ) : null}
            {baseDraft.waveformKind === "sinc_pulse" ? (
              <>
                <FieldRow label="Server waveform amplitude" value={baseDraft.sincAmplitude} />
                <FieldRow label="Server cutoff" value={baseDraft.sincCutoffHz} unit="Hz" />
                <FieldRow label="Server t0" value={baseDraft.sincT0} unit="s" />
              </>
            ) : null}
            <div className="fm-inspector-toolbar">
              <Button
                disabled={pending || conflictViewPhase === "refreshing"}
                size="sm"
                type="button"
                variant="ghost"
                onClick={refetchAfterRevisionConflict}
              >
                Refetch Scene
              </Button>
              <Button
                disabled={pending || conflictViewPhase !== "refetched"}
                size="sm"
                type="button"
                variant="ghost"
                onClick={rebaseAfterRevisionConflict}
              >
                Rebase Draft
              </Button>
              <Button
                disabled={pending || conflictViewPhase !== "rebased"}
                size="sm"
                type="button"
                variant="primary"
                onClick={() => void commitDraft()}
              >
                Retry Save
              </Button>
            </div>
          </InspectorGroup>
        ) : null}
        <div className="fm-inspector-toolbar">
          <Button
            disabled={!canCommit || pending || revisionConflict !== null}
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
