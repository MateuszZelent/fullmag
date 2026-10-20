import { useLayoutEffect, useRef, useState } from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { AuthoringTransactionRequest, SceneResource } from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { useKernel } from "@/kernel/KernelContext";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { Button } from "@/shared/ui/Button";

import { useRegisterInspectorEditSession } from "../../InspectorEditSession";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { composeAntennaProjection, composeAntennaProjectionDrive } from "./AntennaProjectionDriveComposerModel";
import { antennaSolveTargetOptions } from "./AntennaSolveTargetsEditorModel";
import { committedAntennaTransactionScene } from "./AntennaTransactionAcknowledgement";
import { antennaRunStageIds } from "./SolvedAntennaDriveEditorModel";

interface Props {
  stageId: string;
  scene: SceneResource | null;
  sceneScopeKey: string | null;
  status: string;
  refetch: () => void;
}
interface Draft {
  key: string; baseRevision: number; dirty: boolean;
  target: string; mode: string; run: string; peak: string; frequency: string;
}

export function AntennaProjectionDriveComposer({ stageId, scene, sceneScopeKey, status, refetch }: Props) {
  const { api, resources, commands, authoringHistory, selection } = useKernel();
  const scope = sessionRequestScopeKey(useSessionResourceIdentity());
  const key = JSON.stringify([scope, stageId]);
  const [ownerState, setOwner] = useState({ key, token: {} });
  const context = ownerState.key === key ? ownerState : { key, token: {} };
  if (ownerState.key !== key) setOwner(context);
  const token = context.token;
  const owner = useRef<object | null>(null), inflight = useRef<object | null>(null);
  useLayoutEffect(() => { owner.current = token; return () => { owner.current = null; }; }, [token]);
  const [local, setLocal] = useState<Draft | null>(null);
  if (local && local.key !== key) setLocal(null);
  const [pendingToken, setPending] = useState<object | null>(null);
  const [rejectedToken, setRejected] = useState<object | null>(null);
  const [feedback, setFeedback] = useState<{ token: object; kind: "success" | "error"; message: string } | null>(null);
  const current = scope && sceneScopeKey === scope && scene?.scene?.id ? scene : null;
  const revision = current?.revision;
  const validRevision = typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
  const initial: Draft = { key, baseRevision: validRevision ? revision : -1, dirty: false, target: "", mode: "projection", run: "", peak: "", frequency: "" };
  const draft = local?.key === key ? local : initial;
  const pending = pendingToken === token;
  const conflict = draft.dirty && !pending && (draft.baseRevision !== revision || rejectedToken === token);
  const targets = antennaSolveTargetOptions(current);
  const runs = antennaRunStageIds(current);
  let request: AuthoringTransactionRequest | null = null, reason: string | null = null;
  try {
    if (!current || !validRevision || status !== "ready") throw new Error("Waiting for the current session-scoped scene.");
    const target = targets.find((option) => option.key === draft.target)?.target;
    if (!target) throw new Error("Select a projection target explicitly.");
    const combined = draft.mode === "drive";
    if (combined && target.kind !== "object") throw new Error("The combined drive composer requires an object target.");
    const result = combined && target.kind === "object" ? composeAntennaProjectionDrive(current, stageId, target.object_id, draft.run, draft.peak, draft.frequency) : null;
    const projection = result?.projection ?? composeAntennaProjection(current, stageId, target);
    request = { base_revision: draft.baseRevision, kind: "merge_patch", merge_patch: {
      antenna_target_projections: [...(current.antenna_target_projections ?? []), projection],
      ...(result ? { solved_antenna_drives: [...(current.solved_antenna_drives ?? []), result.drive] } : {}),
    } };
  } catch (error) { reason = error instanceof Error ? error.message : String(error); }
  const canCreate = Boolean(request && draft.dirty && !conflict && !pending);
  function update(patch: Partial<Draft>) {
    if (!current || !validRevision) return;
    setLocal({ ...draft, ...(draft.dirty ? {} : { baseRevision: revision }), ...patch, dirty: true }); setFeedback(null);
  }
  async function create(): Promise<boolean> {
    if (!current || !scope || !request || !canCreate || inflight.current === token) return false;
    const submitted = draft, transaction = request;
    const generation = authoringHistory?.getGeneration?.();
    const isCurrent = () => owner.current === token && commands.getSessionScopeKey() === scope
      && (generation === undefined || authoringHistory?.getGeneration?.() === generation);
    if (!isCurrent()) return false;
    inflight.current = token; setPending(token); setFeedback(null);
    const validate = (response: Parameters<typeof committedAntennaTransactionScene>[0]) => committedAntennaTransactionScene(response, transaction, current.scene?.id ?? "");
    try {
      const response = await runAuthoringMutationWithHistory({ api, authoringHistory, selection,
        resourceData: { [MODEL_SCENE_PATH]: current }, sessionScopeKey: scope, isCurrentSessionScope: isCurrent,
      }, `Create antenna projection from ${stageId}`, () => api.model.commitTransaction(transaction, { sessionScopeKey: scope }), validate);
      if (!isCurrent()) return false;
      const committed = validate(response);
      publishCommittedSceneResource(resources, committed, response.scene_revision, undefined, false, scope, api.resourceCacheScope);
      invalidateAuthoringMutationDependents(resources, "interaction", response.scene_revision);
      setLocal((value) => value?.key === key ? { ...value, baseRevision: response.scene_revision, dirty: value !== submitted } : value);
      setRejected(null);
      setFeedback({ token, kind: "success", message: submitted.mode === "drive" ? "Projection and drive committed. Field qualification and execution are still required." : "Projection committed without a drive or Run stage. Field qualification and execution are still required." });
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      setRejected(token); refetch();
      setFeedback({ token, kind: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      if (inflight.current === token) inflight.current = null;
      setPending((value) => value === token ? null : value);
    }
  }
  function discard() { if (!pending) { setLocal(null); setRejected(null); setFeedback(null); } }
  useRegisterInspectorEditSession("staged", pending, draft.dirty, canCreate, undefined, create, discard,
    { historyMode: "mutation-owned", applyBlockReason: reason ?? (conflict ? "Scene changed. Review and explicitly rebase the draft." : undefined) });

  return <div data-testid="antenna-projection-composer"><InspectorGroup title="Create antenna projection">
    <p className="fm-inspector-hint">A projection binds a field-solve output to a target. It does not run the solver or qualify a field. A Run stage is required only when adding a time-dependent drive.</p>
    <FormField label="Projection composition" type="select" value={draft.mode} onChange={(event) => update({ mode: event.currentTarget.value })}>
      <option value="projection">Projection only</option><option value="drive">Projection and sinusoidal drive</option>
    </FormField>
    <FormField label="Projection target" type="select" value={draft.target} onChange={(event) => update({ target: event.currentTarget.value })}>
      <option value="">Select projection target</option>
      {targets.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
    </FormField>
    {draft.mode === "drive" ? <>
      <FormField label="Run stage" type="select" value={draft.run} onChange={(event) => update({ run: event.currentTarget.value })}>
        <option value="">Select Run stage</option>{runs.map((id) => <option key={id} value={id}>{id}</option>)}
      </FormField>
      <FormField label="Peak current" unit="A" value={draft.peak} onChange={(event) => update({ peak: event.currentTarget.value })} />
      <FormField label="Frequency" unit="Hz" value={draft.frequency} onChange={(event) => update({ frequency: event.currentTarget.value })} />
    </> : null}
    {reason ? <FeedbackBanner kind="warning" message={reason} /> : null}
    {conflict ? <FeedbackBanner kind="warning" message="Scene changed or the previous write was not confirmed. Review and explicitly rebase or discard your draft." /> : null}
    {feedback?.token === token ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    <div className="fm-microstrip-station-actions">
      <Button type="button" onClick={refetch}>Refresh projection source</Button>
      <Button type="button" disabled={!draft.dirty || pending} onClick={discard}>Discard projection draft</Button>
      {conflict ? <Button type="button" disabled={pending || !validRevision || status !== "ready"} onClick={() => { setLocal({ ...draft, baseRevision: revision!, dirty: true }); setRejected(null); }}>Rebase projection draft explicitly</Button> : null}
      <Button type="button" disabled={!canCreate} onClick={() => void create()}>{draft.mode === "drive" ? "Create projection and drive" : "Create projection"}</Button>
    </div>
  </InspectorGroup></div>;
}
