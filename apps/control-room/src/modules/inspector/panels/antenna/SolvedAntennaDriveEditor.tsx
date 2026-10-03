import { useState } from "react";

import { MODEL_READINESS_PATH, MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { Button } from "@/shared/ui/Button";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  buildSolvedDrive,
  antennaRunStageIds,
  changeSolvedDriveWaveformKind,
  solvedDriveDraft,
  type SolvedDriveDraft,
  type WaveformKind,
} from "./SolvedAntennaDriveEditorModel";

interface Props {
  driveId: string;
  scene: SceneResource | null;
  status: string;
  refetch: () => void;
}

interface LocalDraft {
  id: string;
  draft: SolvedDriveDraft;
  dirtyKeys: Array<keyof SolvedDriveDraft>;
  editedAgainst: Partial<SolvedDriveDraft>;
}

interface RevisionConflict {
  id: string;
  baseRevision: number;
  baseDraft: SolvedDriveDraft;
  phase: "conflict" | "refreshing" | "rebased";
}

export function SolvedAntennaDriveEditor({ driveId, scene, status, refetch }: Props) {
  const { api, resources } = useKernel();
  const drive = scene?.solved_antenna_drives?.find((item) => item.id === driveId);
  const initial = drive ? solvedDriveDraft(drive) : null;
  const [local, setLocal] = useState<LocalDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [conflictState, setConflictState] = useState<RevisionConflict | null>(null);
  const [feedbackState, setFeedbackState] = useState<{ id: string; message: string } | null>(null);
  const draft = local?.id === driveId && initial
    ? {
        ...initial,
        ...Object.fromEntries(local.dirtyKeys.map((key) => [key, local.draft[key]])),
      } as SolvedDriveDraft
    : initial;
  const revision = scene?.revision;
  const runStageIds = antennaRunStageIds(scene);
  const conflict = conflictState?.id === driveId ? conflictState : null;
  const validRevision = typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
  const conflictPhase = conflict?.phase === "refreshing"
    ? status === "error"
      ? "refresh-error"
      : status === "ready" && validRevision && revision !== conflict.baseRevision
        ? "refetched"
        : "refreshing"
    : conflict?.phase === "rebased" && revision !== conflict.baseRevision
      ? "conflict"
    : conflict?.phase;
  const feedback = conflict?.phase === "rebased" && conflictPhase === "conflict"
    ? "Scene changed again after rebase. Refetch and rebase the draft before saving."
    : feedbackState?.id === driveId ? feedbackState.message : null;
  const dirtyKeySet = new Set(local?.id === driveId ? local.dirtyKeys : []);
  const locallyConflictingKeys = local?.id === driveId && initial
    ? local.dirtyKeys.filter((key) =>
        local.editedAgainst[key] !== initial[key] && local.draft[key] !== initial[key])
    : [];
  const canSave = status === "ready" && validRevision && !pending &&
    locallyConflictingKeys.length === 0 && (!conflict || conflictPhase === "rebased");
  const comparisonKeys = conflict && initial
    ? (Object.keys(draft ?? initial) as Array<keyof SolvedDriveDraft>).filter((key) =>
        dirtyKeySet.has(key) || initial[key] !== conflict.baseDraft[key])
    : [];
  const selectedStageIds = new Set(draft?.stageIds.split(",").map((value) => value.trim()) ?? []);

  if (!drive || !draft) return null;

  function update(patch: Partial<SolvedDriveDraft>) {
    const patchKeys = Object.keys(patch) as Array<keyof SolvedDriveDraft>;
    const editedAgainst = local?.id === driveId ? { ...local.editedAgainst } : {};
    for (const key of patchKeys) {
      if (!dirtyKeySet.has(key) || local?.draft[key] === initial?.[key]) {
        Object.assign(editedAgainst, { [key]: initial?.[key] });
      }
    }
    setLocal({
      id: driveId,
      draft: { ...draft!, ...patch },
      dirtyKeys: [...new Set([...(local?.id === driveId ? local.dirtyKeys : []), ...patchKeys])],
      editedAgainst,
    });
    setFeedbackState(null);
  }

  function changeWaveform(kind: WaveformKind) {
    const next = changeSolvedDriveWaveformKind(draft!, kind);
    const changed = (Object.keys(next) as Array<keyof SolvedDriveDraft>)
      .filter((key) => next[key] !== draft![key]);
    update(Object.fromEntries(changed.map((key) => [key, next[key]])) as Partial<SolvedDriveDraft>);
  }

  function rebaseDraft() {
    if (!initial || !local || local.id !== driveId || conflictPhase !== "refetched" || !validRevision || typeof revision !== "number") return;
    const edited = Object.fromEntries(local.dirtyKeys.map((key) => [key, local.draft[key]])) as Partial<SolvedDriveDraft>;
    setLocal({
      ...local,
      draft: { ...initial, ...edited },
      editedAgainst: Object.fromEntries(local.dirtyKeys.map((key) => [key, initial[key]])),
    });
    setConflictState({ ...conflict!, baseRevision: revision, baseDraft: initial, phase: "rebased" });
    setFeedbackState({ id: driveId, message: "Draft rebased onto the latest scene. Review and retry Save." });
  }

  function rebaseLocalDraft() {
    if (!initial || !local || local.id !== driveId) return;
    setLocal({
      ...local,
      draft: { ...initial, ...Object.fromEntries(local.dirtyKeys.map((key) => [key, local.draft[key]])) },
      editedAgainst: Object.fromEntries(local.dirtyKeys.map((key) => [key, initial[key]])),
    });
  }

  async function save() {
    if (!drive || !draft || !canSave || typeof revision !== "number") return;
    setPending(true);
    setFeedbackState(null);
    try {
      const updated = buildSolvedDrive(drive, draft);
      const availableRunIds = new Set(runStageIds);
      if (updated.activation.kind === "stage_ids" &&
        updated.activation.stage_ids.some((id) => !availableRunIds.has(id))) {
        throw new Error("Selected activation stage is not a Run stage in the current study.");
      }
      const drives = scene!.solved_antenna_drives!.map((item) => item.id === driveId ? updated : item);
      const response = await api.model.commitTransaction({
        base_revision: revision,
        kind: "merge_patch",
        merge_patch: { solved_antenna_drives: drives as unknown as JsonObject[] },
      });
      resources.invalidate(MODEL_SCENE_PATH, response.scene_revision);
      resources.invalidate(MODEL_READINESS_PATH, response.scene_revision);
      setFeedbackState({ id: driveId, message: "Antenna drive committed." });
      setLocal(null);
      setConflictState(null);
    } catch (error) {
      const statusCode = (error as { status?: number })?.status;
      if (statusCode === 409) {
        setConflictState({ id: driveId, baseRevision: revision, baseDraft: initial!, phase: "conflict" });
        setFeedbackState({ id: driveId, message: "Scene changed on the server. Your draft is preserved. Refresh and review before saving again." });
      } else {
        setFeedbackState({ id: driveId, message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <InspectorGroup title="Drive authoring">
      <FormField label="Peak current" unit="A" value={draft.peakCurrentA} onChange={(event) => update({ peakCurrentA: event.currentTarget.value })} />
      <FormField label="Waveform" type="select" value={draft.waveformKind} onChange={(event) => changeWaveform(event.currentTarget.value as WaveformKind)}>
        <option value="constant">Constant</option>
        <option value="sinusoidal">Sinusoidal</option>
        <option value="sinc_pulse">Sinc pulse</option>
        <option value="pulse">Pulse</option>
        <option value="piecewise_linear">Piecewise linear</option>
      </FormField>
      {draft.waveformKind === "sinusoidal" ? <>
        <FormField label="Frequency" unit="Hz" value={draft.frequencyHz} onChange={(event) => update({ frequencyHz: event.currentTarget.value })} />
        <FormField label="Phase" unit="rad" value={draft.phaseRad} onChange={(event) => update({ phaseRad: event.currentTarget.value })} />
        <FormField label="Offset" value={draft.offset} onChange={(event) => update({ offset: event.currentTarget.value })} />
      </> : null}
      {draft.waveformKind === "sinc_pulse" ? <>
        <FormField label="Cutoff" unit="Hz" value={draft.cutoffHz} onChange={(event) => update({ cutoffHz: event.currentTarget.value })} />
        <FormField label="Center time" unit="s" value={draft.sincT0} onChange={(event) => update({ sincT0: event.currentTarget.value })} />
        <FormField label="Amplitude" value={draft.sincAmplitude} onChange={(event) => update({ sincAmplitude: event.currentTarget.value })} />
      </> : null}
      {draft.waveformKind === "pulse" ? <>
        <FormField label="Pulse on" unit="s" value={draft.pulseOn} onChange={(event) => update({ pulseOn: event.currentTarget.value })} />
        <FormField label="Pulse off" unit="s" value={draft.pulseOff} onChange={(event) => update({ pulseOff: event.currentTarget.value })} />
      </> : null}
      {draft.waveformKind === "piecewise_linear" ? <FormField label="Points [time, amplitude]" type="textarea" value={draft.piecewisePoints} onChange={(event) => update({ piecewisePoints: event.currentTarget.value })} /> : null}
      {draft.waveformKind === "pulse" || draft.waveformKind === "piecewise_linear" ? <FormField label="Declared bandwidth" unit="Hz" hint="Optional physical upper frequency; never inferred from pulse duration or knot spacing." value={draft.bandwidthHz} onChange={(event) => update({ bandwidthHz: event.currentTarget.value })} /> : null}
      <FormField label="Activation" type="select" value={draft.activationKind} onChange={(event) => update({ activationKind: event.currentTarget.value as SolvedDriveDraft["activationKind"] })}>
        <option value="all_time_evolution">All time-evolution stages</option>
        <option value="stage_ids">Selected stages</option>
      </FormField>
      {draft.activationKind === "stage_ids" ? <>
        {runStageIds.map((id) => <FormField key={id} label={`Run ${id}`} type="checkbox" checked={selectedStageIds.has(id)} onChange={(event) => {
          const selected = draft.stageIds.split(",").map((value) => value.trim()).filter(Boolean);
          update({ stageIds: (event.currentTarget.checked ? [...new Set([...selected, id])] : selected.filter((value) => value !== id)).join(", ") });
        }} />)}
        <FormField label="Stage IDs" hint="Only Run stages in the current study can be activated." value={draft.stageIds} onChange={(event) => update({ stageIds: event.currentTarget.value })} />
      </> : null}
      {feedback ? <FeedbackBanner kind={feedback === "Antenna drive committed." ? "success" : "error"} message={feedback} /> : null}
      {locallyConflictingKeys.length > 0 && !conflict ? <InspectorGroup title="Concurrent drive edit" badge="review required">
        {locallyConflictingKeys.map((key) => <div key={key}>
          <FieldRow label={`Server ${key}`} value={initial?.[key] ?? ""} />
          <FieldRow label={`Draft ${key}`} value={draft[key]} />
        </div>)}
        <Button type="button" onClick={rebaseLocalDraft}>Rebase Draft</Button>
      </InspectorGroup> : null}
      {conflict ? <InspectorGroup title="Revision conflict" badge={conflictPhase}>
        <FieldRow label="Conflict base revision" value={String(conflict.baseRevision)} />
        <FieldRow label="Server revision" value={validRevision ? String(revision) : "unavailable"} />
        {comparisonKeys.map((key) => <FieldRow key={`draft-${key}`} label={`Draft ${key}`} value={draft[key]} />)}
        {initial ? comparisonKeys.map((key) => <FieldRow key={`server-${key}`} label={`Server ${key}`} value={initial[key]} />) : null}
        <div className="fm-inspector-toolbar">
          <Button type="button" disabled={pending || conflictPhase === "refreshing"} onClick={() => { setConflictState({ ...conflict, phase: "refreshing" }); refetch(); }}>Refetch Scene</Button>
          <Button type="button" disabled={pending || conflictPhase !== "refetched"} onClick={rebaseDraft}>Rebase Draft</Button>
          <Button type="button" disabled={pending || conflictPhase !== "rebased"} onClick={() => void save()}>Retry Save</Button>
          <Button type="button" disabled={pending} onClick={() => { setLocal(null); setConflictState(null); setFeedbackState(null); refetch(); }}>Discard Draft</Button>
        </div>
      </InspectorGroup> : null}
      <Button type="button" disabled={!canSave || Boolean(conflict)} onClick={() => void save()}>Save drive</Button>
    </InspectorGroup>
  );
}
