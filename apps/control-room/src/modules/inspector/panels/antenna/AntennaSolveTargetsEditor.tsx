import { useLayoutEffect, useRef, useState } from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { SceneResource } from "@/kernel/api/apiTypes";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
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
  antennaSolveTargetOptions, buildAntennaSolveTargetsTransaction,
  type AntennaSolveTarget, type AntennaSolveTargetsDraft,
} from "./AntennaSolveTargetsEditorModel";

interface Props {
  objectId: string;
  stageId: string;
  scene: SceneResource | null;
  status: string;
  refetch: () => void;
}

export function AntennaSolveTargetsEditor({ objectId, stageId, scene, status, refetch }: Props) {
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
  const pending = pendingState?.token === context.token;
  const revision = typeof scene?.revision === "number" && Number.isSafeInteger(scene.revision) && scene.revision >= 0 ? scene.revision : null;
  const conflict = Boolean(dirty && !pending && draft?.baseRevision !== revision);
  const options = antennaSolveTargetOptions(scene);
  const selected = options.find((option) => option.key === pick);
  let request: ReturnType<typeof buildAntennaSolveTargetsTransaction> | null = null;
  let reason: string | null = null;
  try {
    if (!scene || !scope || scene.scene?.id !== identity?.sessionId || status !== "ready" || revision === null) {
      throw new Error("Current session-scoped scene is required to edit field-solve targets.");
    }
    request = buildAntennaSolveTargetsTransaction(scene, objectId, stageId, dirty && draft ? draft.baseRevision : revision, targets);
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const canApply = Boolean(dirty && request && !pending && !conflict);

  function update(next: AntennaSolveTarget[]) {
    if (revision === null || !stage || scene?.objects?.find((object) => object.id === objectId)?.locked) return;
    setDraft({ key, baseRevision: dirty && draft ? draft.baseRevision : revision, dirty: true, targets: next });
    setFeedback(null);
  }

  async function apply(): Promise<boolean> {
    if (!canApply || !draft || !request || !scene || !scope || inflight.current?.ownerToken === context.token) return false;
    const transaction = request;
    const operation = {};
    const ownerToken = context.token;
    const historyGeneration = authoringHistory?.getGeneration?.();
    const isCurrent = () => owner.current === ownerToken && commands.getSessionScopeKey() === scope &&
      (historyGeneration === undefined || authoringHistory?.getGeneration?.() === historyGeneration);
    inflight.current = { ownerToken, operation };
    setPending({ token: ownerToken });
    setFeedback(null);
    try {
      const response = await runAuthoringMutationWithHistory({
        api, authoringHistory, selection, resourceData: { [MODEL_SCENE_PATH]: scene },
        sessionScopeKey: scope, isCurrentSessionScope: isCurrent,
      }, `Edit antenna field-solve targets ${stageId}`, () => api.model.commitTransaction(transaction, { sessionScopeKey: scope }), (result) => result.committed_scene ?? null);
      if (!isCurrent()) return false;
      const committed = response.committed_scene;
      const acknowledged = committed?.antenna_field_solve_stages?.find((item) => item.id === stageId && item.source_object_id === objectId);
      if (!committed || committed.scene?.id !== identity?.sessionId || committed.revision !== response.scene_revision ||
          !acknowledged || JSON.stringify(acknowledged.target_refs.map(antennaSolveTargetKey)) !== JSON.stringify(draft.targets.map(antennaSolveTargetKey))) {
        refetch();
        throw new Error("Field-solve targets ACK omitted or changed the submitted scene. Refresh before applying again.");
      }
      // Validate the revision before publishing any cache or draft transition.
      acknowledgeAntennaSolveTargetsDraft(draft, draft, response.scene_revision);
      publishCommittedSceneResource(resources, committed, response.scene_revision, undefined, false, scope, api.resourceCacheScope);
      invalidateAuthoringMutationDependents(resources, "interaction", response.scene_revision);
      setDraft((current) => acknowledgeAntennaSolveTargetsDraft(current, draft, response.scene_revision));
      setFeedback({ key, kind: "success", message: "Field-solve targets committed. Existing field solutions must be recomputed; projections and drives were not changed." });
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
  const editable = Boolean(stage && scope && scene?.scene?.id === identity?.sessionId && revision !== null && !scene?.objects?.find((object) => object.id === objectId)?.locked);
  return <InspectorGroup title="Field-solve targets" collapsible defaultOpen>
    <FieldRow label="Solve stage" value={stageId} mono />
    <FieldRow label="Sampling domain" value={stage ? antennaSolveTargetLabel(stage.field_sampling_domain) : "unavailable"} />
    <p className="fm-inspector-hint">Targets select where the source field is calculated. They do not activate LLG, projections or drives. The sampling domain is unchanged.</p>
    {targets.map((target, index) => <div className="fm-microstrip-station-actions" key={`${antennaSolveTargetKey(target)}|${index}`}>
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
      <Button type="button" onClick={refetch}>Refresh targets</Button>
      {dirty ? <Button type="button" disabled={pending} onClick={() => setDraft(null)}>Revert targets</Button> : null}
      {conflict && revision !== null ? <Button type="button" disabled={pending || status !== "ready"} onClick={() => setDraft((current) => current?.key === key ? { ...current, baseRevision: revision } : current)}>Rebase targets</Button> : null}
      <Button type="button" disabled={!canApply} onClick={() => void apply()}>Apply field-solve targets</Button>
    </div>
  </InspectorGroup>;
}
