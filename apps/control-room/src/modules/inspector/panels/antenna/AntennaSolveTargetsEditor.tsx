import { useLayoutEffect, useRef, useState } from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { AuthoringTransactionResponse, SceneResource } from "@/kernel/api/apiTypes";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { committedAntennaTransactionScene } from "./AntennaTransactionAcknowledgement";
import { useKernel } from "@/kernel/KernelContext";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { Button } from "@/shared/ui/Button";

import { useRegisterInspectorEditSession } from "../../InspectorEditSession";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  acknowledgeAntennaSolveTargetsDraft, antennaSolveTargetKey, antennaSolveTargetLabel,
  antennaSolveTargetOptions, antennaSamplingDomainOptions, antennaVectorPotentialSelectable, buildAntennaSolveTargetsTransaction,
  type AntennaSolveTarget, type AntennaSolveTargetsDraft,
} from "./AntennaSolveTargetsEditorModel";

interface Props {
  objectId: string;
  stageId: string;
  scene: SceneResource | null; sceneScopeKey: string | null;
  status: string;
  refetch: () => void;
}

export function AntennaSolveTargetsEditor({ objectId, stageId, scene, sceneScopeKey, status, refetch }: Props) {
  const { api, resources, commands, authoringHistory, selection } = useKernel();
  const identity = useSessionResourceIdentity();
  const scope = sessionRequestScopeKey(identity);
  const key = JSON.stringify([scope, objectId, stageId]);
  const [ownerState, setOwnerState] = useState({ key, token: {} });
  const context = ownerState.key === key ? ownerState : { key, token: {} };
  if (ownerState.key !== key) setOwnerState(context);
  const [draftState, setDraft] = useState<AntennaSolveTargetsDraft | null>(null);
  if (draftState && draftState.key !== key) setDraft(null);
  const [pickState, setPick] = useState({ key, value: "" });
  const pick = pickState.key === key ? pickState.value : "";
  const [pendingState, setPending] = useState<{ token: object } | null>(null);
  const [feedback, setFeedback] = useState<{ key: string; kind: "error" | "success"; message: string } | null>(null);
  const owner = useRef<object | null>(null);
  const inflight = useRef<{ ownerToken: object; operation: object } | null>(null);
  useLayoutEffect(() => {
    owner.current = context.token;
    return () => { owner.current = null; };
  }, [context.token]);
  const stage = scene?.antenna_field_solve_stages?.find((item) => item.id === stageId && item.source_object_id === objectId);
  const draft = draftState?.key === key ? draftState : null;
  const dirty = draft?.dirty === true;
  const targets = dirty ? draft.targets : stage?.target_refs ?? draft?.targets ?? [];
  const samplingDomain = dirty ? draft.samplingDomain ?? stage?.field_sampling_domain : stage?.field_sampling_domain;
  const vectorPotentialSelectable = antennaVectorPotentialSelectable(scene, stage);
  const oerstedRealization = dirty ? draft.oerstedRealization ?? stage?.oersted_realization : stage?.oersted_realization;
  const samplingOptions = antennaSamplingDomainOptions(scene);
  const samplingKey = samplingDomain ? antennaSolveTargetKey(samplingDomain) : "";
  const pending = pendingState?.token === context.token;
  const revision = typeof scene?.revision === "number" && Number.isSafeInteger(scene.revision) && scene.revision >= 0 ? scene.revision : null;
  const conflict = Boolean(dirty && !pending && draft?.baseRevision !== revision);
  const options = antennaSolveTargetOptions(scene);
  const selected = options.find((option) => option.key === pick);
  let request: ReturnType<typeof buildAntennaSolveTargetsTransaction> | null = null;
  let reason: string | null = null;
  try {
    if (!scene || !scope || !scene.scene?.id || sceneScopeKey !== scope || status !== "ready" || revision === null) {
      throw new Error("Current session-scoped scene is required to edit field-solve targets.");
    }
    request = buildAntennaSolveTargetsTransaction(scene, objectId, stageId, dirty && draft ? draft.baseRevision : revision, targets, samplingDomain, oerstedRealization);
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const canApply = Boolean(dirty && request && !pending && !conflict);

  function update(next: AntennaSolveTarget[], domain = samplingDomain, realization = oerstedRealization) {
    if (revision === null || !stage || scene?.objects?.find((object) => object.id === objectId)?.locked) return;
    setDraft({ key, baseRevision: dirty && draft ? draft.baseRevision : revision, dirty: true, targets: next, samplingDomain: domain, oerstedRealization: realization });
    setFeedback(null);
  }

  async function apply(): Promise<boolean> {
    if (!canApply || !draft || !request || !scene || !scope || inflight.current?.ownerToken === context.token) return false;
    const transaction = request;
    const submittedSceneId = scene.scene?.id ?? "";
    const operation = {};
    const ownerToken = context.token;
    const historyGeneration = authoringHistory?.getGeneration?.();
    const isCurrent = () => owner.current === ownerToken && commands.getSessionScopeKey() === scope &&
      (historyGeneration === undefined || authoringHistory?.getGeneration?.() === historyGeneration);
    inflight.current = { ownerToken, operation };
    setPending({ token: ownerToken });
    setFeedback(null);
    function validateCommittedScene(response: AuthoringTransactionResponse): SceneResource {
      const committed = committedAntennaTransactionScene(response, transaction, submittedSceneId);
      return committed;
    }
    try {
      const response = await runAuthoringMutationWithHistory({
        api, authoringHistory, selection, resourceData: { [MODEL_SCENE_PATH]: scene },
        sessionScopeKey: scope, isCurrentSessionScope: isCurrent,
      }, `Edit antenna field-solve sampling and targets ${stageId}`, () => api.model.commitTransaction(transaction, { sessionScopeKey: scope }), validateCommittedScene);
      if (!isCurrent()) return false;
      const committed = validateCommittedScene(response);
      publishCommittedSceneResource(resources, committed, response.scene_revision, undefined, false, scope, api.resourceCacheScope);
      invalidateAuthoringMutationDependents(resources, "interaction", response.scene_revision);
      setDraft((current) => acknowledgeAntennaSolveTargetsDraft(current, draft, response.scene_revision));
      setFeedback({ key, kind: "success", message: "Field-solve settings committed. Existing field solutions must be recomputed; projections and drives were not changed." });
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      refetch();
      setFeedback({ key, kind: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      if (inflight.current?.operation === operation) inflight.current = null;
      setPending((current) => current?.token === ownerToken ? null : current);
    }
  }

  useRegisterInspectorEditSession("staged", pending, dirty, Boolean(request && !conflict), undefined,
    apply, () => setDraft(null), { historyMode: "mutation-owned", applyBlockReason: reason ?? undefined });
  const editable = Boolean(stage && scope && scene?.scene?.id && sceneScopeKey === scope && revision !== null && !scene?.objects?.find((object) => object.id === objectId)?.locked);
  return <InspectorGroup title="Field-solve sampling and targets" collapsible defaultOpen>
    <FieldRow label="Solve stage" value={stageId} mono />
    <FormField type="select" label="Field-sampling domain" value={samplingKey} disabled={!editable} onChange={(event) => {
      const option = samplingOptions.find((candidate) => candidate.key === event.target.value);
      if (option) update([...targets], option.target);
    }} hint="Global requires an authored FEM domain Tet4 mesh; Object requires that object's independent Tet4 mesh. Region point-cloud sampling is not implemented. Selecting a domain does not create its mesh.">
      {!samplingOptions.some((option) => option.key === samplingKey) ? <option value={samplingKey} disabled>{samplingDomain ? `${antennaSolveTargetLabel(samplingDomain)} · unavailable` : "Select an explicit sampling domain"}</option> : null}
      {samplingOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
    </FormField>
    <FieldRow label="Declared mesh policy" value={stage?.conductor_mesh_policy ?? "unavailable"} mono />
    <FieldRow label="Declared solver policy" value={stage?.solver_policy ?? "unavailable"} mono />
    <FieldRow label="Physical model" value={stage?.model ?? "unavailable"} mono />
    <FormField type="select" label="Oersted realization" value={oerstedRealization ?? ""} disabled={!editable}
      onChange={event => update([...targets], samplingDomain, event.currentTarget.value)}
      hint="Requested numerical realization. Planner and runtime capability checks still apply; changing it requires recomputing the field basis.">
      {oerstedRealization !== "direct_tetra_quadrature" && oerstedRealization !== "vector_potential_solver"
        ? <option value={oerstedRealization ?? ""} disabled>{oerstedRealization || "Select an explicit realization"} · unavailable</option> : null}
      <option value="direct_tetra_quadrature">Direct tetrahedral quadrature (3D)</option>
      <option value="vector_potential_solver" disabled={!vectorPotentialSelectable}>FEM vector potential (3D){vectorPotentialSelectable ? "" : " · unavailable for this source"}</option>
    </FormField>
    {!vectorPotentialSelectable ? <p className="fm-inspector-hint">Current-driven or unresolved source definitions require an explicit direct realization. Vector potential is not available for these sources; no fallback is applied.</p> : null}
    <p className="fm-inspector-hint">The sampling domain owns the published H carrier. Targets select field destinations. Policy identifiers are preserved and may impose source-specific admission requirements. Configure the actual charge solver in CurrentTransport and the conductor mesh in Geometry / Mesh; runtime validation decides availability. Editing these inputs does not activate LLG, projections or drives.</p>
    {targets.map((target, index) => <div className="fm-microstrip-station-actions" key={antennaSolveTargetKey(target)}>
      <FieldRow label={`Target ${index + 1}`} value={antennaSolveTargetLabel(target)} />
      <Button type="button" disabled={!editable} aria-label={`Remove field-solve target ${index + 1}`} onClick={() => update(targets.filter((_, itemIndex) => itemIndex !== index))}>Remove target</Button>
    </div>)}
    <FormField type="select" label="Add field-solve target" value={pick} disabled={!editable} onChange={(event) => setPick({ key, value: event.currentTarget.value })}>
      <option value="">Select explicit target</option>
      {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
    </FormField>
    <Button type="button" disabled={!editable || !selected || targets.some((target) => antennaSolveTargetKey(target) === pick)} onClick={() => { if (selected) update([...targets, selected.target]); }}>Add target</Button>
    {reason ? <FeedbackBanner kind={conflict ? "error" : "warning"} message={reason} /> : null}
    {feedback?.key === key ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    <div className="fm-microstrip-station-actions">
      <Button type="button" onClick={refetch}>Refresh field-solve settings</Button>
      {dirty ? <Button type="button" disabled={pending} onClick={() => setDraft(null)}>Revert field-solve settings</Button> : null}
      {conflict && revision !== null ? <Button type="button" disabled={pending || status !== "ready"} onClick={() => setDraft((current) => current?.key === key ? { ...current, baseRevision: revision } : current)}>Rebase field-solve settings</Button> : null}
      <Button type="button" disabled={!canApply} onClick={() => void apply()}>Apply field-solve settings</Button>
    </div>
  </InspectorGroup>;
}
