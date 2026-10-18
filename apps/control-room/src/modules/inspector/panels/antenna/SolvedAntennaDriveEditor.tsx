import { useLayoutEffect, useRef, useState } from "react";

import { MODEL_READINESS_PATH, MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { AuthoringTransactionResponse, JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { useKernel } from "@/kernel/KernelContext";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { Button } from "@/shared/ui/Button";

import { useRegisterInspectorEditSession } from "../../InspectorEditSession";
import { antennaDriveBindingKey, antennaDriveBindingOptions, validateAntennaDriveBinding } from "./AntennaDriveBindingsModel";
import { AntennaDrivePreview } from "./AntennaDrivePreview";
import { AntennaPiecewisePointsEditor } from "./AntennaPiecewisePointsEditor";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  buildSolvedDrive,
  resolveCommittedSolvedDriveScene,
  acknowledgeSolvedDriveDraft,
  antennaRunStageOptions,
  changeSolvedDriveWaveformKind,
  solvedDriveDraft,
  solvedDriveSaveBlockReason,
  resolvedSolvedDriveDraftBase,
  type SolvedDriveLocalDraft as LocalDraft,
  type SolvedDriveDraft,
  type WaveformKind,
} from "./SolvedAntennaDriveEditorModel";

interface Props {
  driveId: string;
  scene: SceneResource | null; sceneScopeKey: string | null;
  status: string;
  refetch: () => void;
}

interface RevisionConflict {
  id: string;
  baseRevision: number;
  baseDraft: SolvedDriveDraft;
  phase: "conflict" | "refreshing" | "rebased";
}

export function SolvedAntennaDriveEditor({ driveId, scene, sceneScopeKey, status, refetch }: Props) {
  const { api, resources, commands, authoringHistory, selection } = useKernel();
  const identity = useSessionResourceIdentity();
  const scope = sessionRequestScopeKey(identity);
  const key = JSON.stringify([scope, driveId]);
  const [ownerState, setOwnerState] = useState({ key, token: {} });
  const context = ownerState.key === key ? ownerState : { key, token: {} };
  const owner = useRef<object | null>(null);
  const inflight = useRef<object | null>(null);
  useLayoutEffect(() => {
    owner.current = context.token;
    return () => { owner.current = null; };
  }, [context.token]);
  const drive = scene?.solved_antenna_drives?.find((item) => item.id === driveId);
  const [local, setLocal] = useState<LocalDraft | null>(null);
  const currentLocal = local?.id === driveId ? local : null;
  const initial = resolvedSolvedDriveDraftBase(drive ? solvedDriveDraft(drive) : null, currentLocal, scene?.revision);
  const [requestPending, setPending] = useState(false);
  const awaitingScene = Boolean(currentLocal?.acknowledgedBase && (scene?.revision == null || scene.revision < currentLocal.acknowledgedBase.revision));
  const pending = requestPending || awaitingScene;
  const [conflictState, setConflictState] = useState<RevisionConflict | null>(null);
  const [feedbackState, setFeedbackState] = useState<{ id: string; message: string } | null>(null);
  if (ownerState.key !== key) {
    setOwnerState(context);
    setLocal(null);
    setConflictState(null);
    setFeedbackState(null);
    setPending(false);
  }
  const draft = local?.id === driveId && initial
    ? {
        ...initial,
        ...Object.fromEntries(local.dirtyKeys.map((key) => [key, local.draft[key]])),
      } as SolvedDriveDraft
    : initial;
  const revision = scene?.revision;
  const runOptions = antennaRunStageOptions(scene);
  const runStageIds = runOptions.map(option => option.id);
  const bindingOptions = antennaDriveBindingOptions(scene, drive);
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
  const dirty = Boolean(initial && draft && (Object.keys(initial) as Array<keyof SolvedDriveDraft>).some(key => initial[key] !== draft[key]));
  let validatedDrive: ReturnType<typeof buildSolvedDrive> | null = null, validationError: string | null = null;
  try {
    if (drive && draft) {
      validatedDrive = buildSolvedDrive(drive, draft);
      validateAntennaDriveBinding(scene, drive, validatedDrive);
      if (validatedDrive.activation.kind === "stage_ids" && validatedDrive.activation.stage_ids.some(id => !runStageIds.includes(id))) {
        throw new Error("Selected activation stage is not a Run stage in the current study.");
      }
    }
  } catch (error) { validationError = error instanceof Error ? error.message : String(error); }
  const saveBlockReason = solvedDriveSaveBlockReason(validationError, locallyConflictingKeys.length, conflictPhase);
  const canSave = dirty && Boolean(validatedDrive && !validationError) && Boolean(scope && identity && scene?.scene?.id && sceneScopeKey === scope) &&
    status === "ready" && validRevision && !pending &&
    !saveBlockReason;
  const comparisonKeys = conflict && initial
    ? (Object.keys(draft ?? initial) as Array<keyof SolvedDriveDraft>).filter((key) =>
        dirtyKeySet.has(key) || initial[key] !== conflict.baseDraft[key])
    : [];
  const selectedStageIds = new Set(draft?.stageIds.split(",").map((value) => value.trim()).filter(Boolean) ?? []);

  function discard() {
    if (pending) return;
    setLocal(null); setConflictState(null); setFeedbackState(null);
  }
  useRegisterInspectorEditSession("staged", pending, dirty, canSave, undefined, save, discard,
    { historyMode: "mutation-owned", applyBlockReason: saveBlockReason });

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
      acknowledgedBase: currentLocal?.acknowledgedBase,
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

  async function save(): Promise<boolean> {
    if (!drive || !draft || !canSave || typeof revision !== "number" || !scope || !identity || inflight.current) return false;
    const operation = {};
    const ownerToken = context.token;
    const historyGeneration = authoringHistory?.getGeneration?.();
    const isCurrent = () => owner.current === ownerToken && commands.getSessionScopeKey() === scope &&
      (historyGeneration === undefined || authoringHistory?.getGeneration?.() === historyGeneration);
    if (!isCurrent()) return false;
    inflight.current = operation;
    setPending(true);
    setFeedbackState(null);
    try {
      const updated = buildSolvedDrive(drive, draft);
      validateAntennaDriveBinding(scene, drive, updated);
      const availableRunIds = new Set(runStageIds);
      if (updated.activation.kind === "stage_ids" &&
        updated.activation.stage_ids.some((id) => !availableRunIds.has(id))) {
        throw new Error("Selected activation stage is not a Run stage in the current study.");
      }
      const drives = scene!.solved_antenna_drives!.map((item) => item.id === driveId ? updated : item);
      const transaction = {
        base_revision: revision,
        kind: "merge_patch" as const,
        merge_patch: { solved_antenna_drives: drives as unknown as JsonObject[] },
      };
      const resolveCommitted = (result: AuthoringTransactionResponse) =>
        resolveCommittedSolvedDriveScene(result, updated, scene?.scene?.id ?? "", revision);
      const response = await runAuthoringMutationWithHistory({
        api, authoringHistory, selection, resourceData: { [MODEL_SCENE_PATH]: scene },
        sessionScopeKey: scope, isCurrentSessionScope: isCurrent,
      }, `Edit antenna drive ${driveId}`, () => api.model.commitTransaction(transaction, { sessionScopeKey: scope }), resolveCommitted);
      if (!isCurrent()) return false;
      const committed = resolveCommitted(response);
      const acknowledged = solvedDriveDraft(committed.solved_antenna_drives!.find((item) => item.id === driveId)!);
      publishCommittedSceneResource(resources, committed, response.scene_revision, undefined, false, scope, api.resourceCacheScope);
      resources.invalidate(MODEL_READINESS_PATH, response.scene_revision);
      setFeedbackState({ id: driveId, message: "Antenna drive committed." });
      setLocal((current) => acknowledgeSolvedDriveDraft(current, driveId, draft, acknowledged, response.scene_revision));
      setConflictState(null);
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      const statusCode = (error as { status?: number })?.status;
      if (statusCode === 409) {
        setConflictState({ id: driveId, baseRevision: revision, baseDraft: initial!, phase: "conflict" });
        setFeedbackState({ id: driveId, message: "Scene changed on the server. Your draft is preserved. Refresh and review before saving again." });
      } else {
        setFeedbackState({ id: driveId, message: error instanceof Error ? error.message : String(error) });
      }
      return false;
    } finally {
      if (inflight.current === operation) inflight.current = null;
      if (owner.current === ownerToken && commands.getSessionScopeKey() === scope) setPending(false);
    }
  }

  return (
    <div data-testid="antenna-drive-editor"><InspectorGroup title="Drive authoring">
      <FormField label="Drive name" hint="Display name only. The immutable drive ID and its source bindings stay unchanged." value={draft.name} onChange={event => update({ name: event.currentTarget.value })} />
      <FormField label="Field projection and port" type="select" value={antennaDriveBindingKey(draft.projectionRef, draft.portModeId)}
        hint="Choose an existing projection and its matching port. Saving changes the binding; it does not compute or qualify a field."
        onChange={event => {
          const option = bindingOptions.find(item => item.key === event.currentTarget.value);
          if (option) update({ projectionRef: option.projectionRef, portModeId: option.portModeId });
        }}>
        {!bindingOptions.some(option => option.projectionRef === draft.projectionRef && option.portModeId === draft.portModeId)
          ? <option value={antennaDriveBindingKey(draft.projectionRef, draft.portModeId)} disabled>Unavailable binding · {draft.projectionRef} / {draft.portModeId}</option> : null}
        {bindingOptions.map(option => <option key={option.key} value={option.key} title={option.description}>{option.label}</option>)}
      </FormField>
      <FormField label="Peak current" unit="A" hint="Signed current scale. I(t) = scale × waveform(t); offset or sinc amplitude can change the actual peak. No RMS conversion is applied." value={draft.peakCurrentA} onChange={(event) => update({ peakCurrentA: event.currentTarget.value })} />
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
      {draft.waveformKind === "piecewise_linear" ? <AntennaPiecewisePointsEditor key={key} value={draft.piecewisePoints} onChange={piecewisePoints => update({ piecewisePoints })} /> : null}
      {draft.waveformKind === "pulse" || draft.waveformKind === "piecewise_linear" ? <FormField label="Declared bandwidth" unit="Hz" hint="Optional physical upper frequency; never inferred from pulse duration or knot spacing." value={draft.bandwidthHz} onChange={(event) => update({ bandwidthHz: event.currentTarget.value })} /> : null}
      <FormField label="Time origin" type="select" value={draft.timeOrigin} onChange={event => update({ timeOrigin: event.currentTarget.value as SolvedDriveDraft["timeOrigin"] })}>
        <option value="stage_local">Stage-local waveform time</option><option value="absolute">Absolute simulation time</option>
      </FormField>
      <FormField label="Activation" type="select" value={draft.activationKind} onChange={(event) => update({ activationKind: event.currentTarget.value as SolvedDriveDraft["activationKind"] })}>
        <option value="all_time_evolution">All time-evolution stages</option>
        <option value="stage_ids">Selected stages</option>
      </FormField>
      {draft.activationKind === "stage_ids" ? <>
        {runOptions.map(({ id, label }) => <FormField key={id} label={label} hint={`Executable stage ID: ${id}`} type="checkbox" checked={selectedStageIds.has(id)} onChange={(event) => {
          const selected = [...selectedStageIds];
          update({ stageIds: (event.currentTarget.checked ? [...new Set([...selected, id])] : selected.filter(value => value !== id)).join(", ") });
        }} />)}
        {[...selectedStageIds].filter(id => !runStageIds.includes(id)).map(id => <FormField key={id} label="Unavailable Run" hint={`Stored stage ID: ${id}. Remove explicitly or restore this Run in the study.`} type="checkbox" checked onChange={() => update({ stageIds: [...selectedStageIds].filter(value => value !== id).join(", ") })} />)}
        {!runOptions.length ? <p className="fm-inspector-hint">No enabled Run stages are available in this study.</p> : null}
      </> : null}
      {validationError ? <FeedbackBanner kind="warning" message={validationError} /> : null}
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
      <div className="fm-inspector-toolbar">
        <Button type="button" disabled={!dirty || pending} onClick={discard}>Reset drive</Button>
        <Button type="button" disabled={!canSave || Boolean(conflict)} onClick={() => void save()}>Save drive</Button>
      </div>
      <AntennaDrivePreview drive={validatedDrive} revision={validRevision ? revision! : 0} />
    </InspectorGroup></div>
  );
}
