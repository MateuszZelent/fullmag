import { useLayoutEffect, useRef, useState } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
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
import { committedAntennaTransactionScene } from "./AntennaTransactionAcknowledgement";
import { acknowledgeConductorMaterialDraft, buildConductorMaterialTransaction, createConductorMaterialDraft, type ConductorMaterialDraft } from "./AntennaConductorMaterialModel";

export function AntennaConductorMaterialEditor({ objectId, scene, sceneScopeKey, status, refetch }: {
  objectId: string; scene: SceneResource | null; sceneScopeKey: string | null; status: string; refetch: () => void;
}) {
  const { api, resources, commands, authoringHistory, selection } = useKernel();
  const scope = sessionRequestScopeKey(useSessionResourceIdentity());
  const key = JSON.stringify([scope, objectId]);
  const [ownerState, setOwner] = useState({ key, token: {} });
  const context = ownerState.key === key ? ownerState : { key, token: {} };
  if (ownerState.key !== key) setOwner(context);
  const owner = useRef<object | null>(null), inflight = useRef<object | null>(null);
  useLayoutEffect(() => { owner.current = context.token; return () => { owner.current = null; }; }, [context.token]);
  const [draftState, setDraft] = useState<ConductorMaterialDraft | null>(null);
  const [pendingOwner, setPending] = useState<object | null>(null);
  const [rejectedOwner, setRejected] = useState<object | null>(null);
  const [feedback, setFeedback] = useState<{ token: object; kind: "error" | "success"; message: string } | null>(null);
  if (draftState && draftState.key !== key) setDraft(null);
  let draft = draftState?.key === key ? draftState : null;
  const current = scope && sceneScopeKey === scope && scene?.scene?.id ? scene : null;
  let fresh: ConductorMaterialDraft | null = null, reason: string | null = null;
  try {
    if (!current) throw new Error("Waiting for the current session-scoped scene.");
    fresh = createConductorMaterialDraft(current, objectId, key);
  } catch (error) { reason = error instanceof Error ? error.message : String(error); }
  if (fresh && status === "ready" && (!draft || !draft.dirty && fresh.baseRevision > draft.baseRevision)) {
    draft = fresh; setDraft(fresh);
  }
  const pending = pendingOwner === context.token, dirty = draft?.dirty === true;
  const conflict = dirty && !pending && (rejectedOwner === context.token || current?.revision !== draft?.baseRevision);
  let request: ReturnType<typeof buildConductorMaterialTransaction> | null = null;
  try {
    if (!reason && current && draft) request = buildConductorMaterialTransaction(current, objectId, draft);
  } catch (error) { reason = error instanceof Error ? error.message : String(error); }
  const editable = Boolean(current && fresh && draft);
  const canApply = Boolean(editable && status === "ready" && dirty && request && !reason && !conflict && !pending);

  function revert() {
    if (pending || !fresh || status !== "ready") return;
    setDraft(fresh); setRejected(null); setFeedback(null);
  }
  async function apply(): Promise<boolean> {
    if (!canApply || !draft || !current || !scope || !request || inflight.current === context.token) return false;
    const submitted = draft, transaction = request, sourceScene = current, token = context.token;
    const generation = authoringHistory?.getGeneration?.();
    const isCurrent = () => owner.current === token && commands.getSessionScopeKey() === scope
      && (generation === undefined || authoringHistory?.getGeneration?.() === generation);
    if (!isCurrent()) return false;
    inflight.current = token; setPending(token); setFeedback(null);
    const validate = (response: Parameters<typeof committedAntennaTransactionScene>[0]) => committedAntennaTransactionScene(response, transaction, sourceScene.scene?.id ?? "");
    try {
      const response = await runAuthoringMutationWithHistory({ api, authoringHistory, selection,
        resourceData: { [MODEL_SCENE_PATH]: sourceScene }, sessionScopeKey: scope, isCurrentSessionScope: isCurrent,
      }, `Edit antenna conductivity ${objectId}`, () => api.model.commitTransaction(transaction, { sessionScopeKey: scope }), validate);
      if (!isCurrent()) return false;
      const committed = validate(response);
      publishCommittedSceneResource(resources, committed, response.scene_revision, undefined, false, scope, api.resourceCacheScope);
      invalidateAuthoringMutationDependents(resources, "material", response.scene_revision);
      setDraft(value => acknowledgeConductorMaterialDraft(value, submitted, response.scene_revision));
      setRejected(null);
      setFeedback({ token, kind: "success", message: "Conductivity committed to geometry and charge materials. Recompute dependent antenna fields before reuse." });
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      setRejected(token); refetch();
      setFeedback({ token, kind: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      if (inflight.current === token) inflight.current = null;
      setPending(value => value === token ? null : value);
    }
  }
  useRegisterInspectorEditSession("staged", pending, dirty, canApply, editable ? undefined : reason ?? undefined,
    apply, revert, { historyMode: "mutation-owned", applyBlockReason: conflict ? "Scene changed. Revert to current values before applying." : reason ?? undefined });

  return <div data-testid="antenna-conductor-material-editor">
    <InspectorGroup title="Conductor conductivity" badge="geometry + charge materials" description="Explicit SI values saved together. Signal and return share the layout conductivity; each bridge has its own value.">
      <FieldRow label="Source object" value={objectId} mono />
      {draft?.rows.map(row => <div key={row.key}>
        <FormField label={row.label} unit="S/m" inputMode="decimal" value={row.value} disabled={!editable} onChange={event => {
          const value = event.currentTarget.value;
          setDraft(current => current?.key === key ? { ...current, dirty: true, rows: current.rows.map(item => item.key === row.key ? { ...item, value } : item) } : current);
          setFeedback(null);
        }} />
        <FieldRow label="Conductor parts" value={row.partIds.join(" · ")} mono />
      </div>)}
      <p className="fm-inspector-hint">This edits existing charge conductivity assignments and layout values. Object material references and all other charge parameters are preserved. A conductivity edit does not qualify a mesh or a field result.</p>
      {reason ? <FeedbackBanner kind="warning" message={reason} /> : null}
      {conflict ? <FeedbackBanner kind="warning" message="Scene changed or the previous write was not confirmed. Your draft is retained; revert explicitly before retrying." /> : null}
      {feedback?.token === context.token ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
      <div className="fm-microstrip-station-actions">
        <Button type="button" onClick={refetch}>Refresh conductivity</Button>
        <Button type="button" disabled={pending || !fresh || status !== "ready" || !dirty && rejectedOwner !== context.token} onClick={revert}>Revert conductivity</Button>
        <Button type="button" disabled={!canApply} onClick={() => void apply()}>Apply conductivity</Button>
      </div>
    </InspectorGroup>
  </div>;
}
