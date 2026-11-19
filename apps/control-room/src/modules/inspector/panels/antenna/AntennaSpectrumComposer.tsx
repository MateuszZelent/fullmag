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
import { AntennaSamplingPlaneFields } from "./AntennaSamplingPlaneFields";
import { AntennaSamplingResolution } from "./AntennaSamplingResolution";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { committedAntennaTransactionScene } from "./AntennaTransactionAcknowledgement";
import {
  acknowledgeAntennaSpectrumDraft, composeAntennaSpectrumRequest, emptyAntennaSpectrumDraft,
  type AntennaSpectrumDraft, type AntennaSpectrumLocalDraft,
} from "./AntennaSpectrumComposerModel";

interface Props {
  stageId: string; scene: SceneResource | null; sceneScopeKey: string | null;
  status: string; refetch: () => void;
}

export function AntennaSpectrumComposer({ stageId, scene, sceneScopeKey, status, refetch }: Props) {
  const { api, resources, commands, authoringHistory, selection } = useKernel();
  const scope = sessionRequestScopeKey(useSessionResourceIdentity());
  const key = JSON.stringify([scope, stageId]);
  const [ownerState, setOwner] = useState({ key, token: {} });
  const context = ownerState.key === key ? ownerState : { key, token: {} };
  if (ownerState.key !== key) setOwner(context);
  const token = context.token;
  const owner = useRef<object | null>(null), inflight = useRef<object | null>(null);
  useLayoutEffect(() => { owner.current = token; return () => { owner.current = null; }; }, [token]);
  const [local, setLocal] = useState<AntennaSpectrumLocalDraft | null>(null);
  if (local && local.key !== key) setLocal(null);
  const [pendingToken, setPending] = useState<object | null>(null);
  const [rejectedToken, setRejected] = useState<object | null>(null);
  const [feedback, setFeedback] = useState<{ token: object; kind: "success" | "error"; message: string } | null>(null);
  const current = scope && sceneScopeKey === scope && scene?.scene?.id ? scene : null;
  const revision = current?.revision;
  const validRevision = typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
  const initial: AntennaSpectrumLocalDraft = { key, baseRevision: validRevision ? revision : -1, dirty: false, values: emptyAntennaSpectrumDraft };
  const draft = local?.key === key ? local : initial;
  const values = draft.values;
  const pending = pendingToken === token;
  const conflict = draft.dirty && !pending && (draft.baseRevision !== revision || rejectedToken === token);
  let request: AuthoringTransactionRequest | null = null, reason: string | null = null;
  try {
    if (!current || !validRevision || status !== "ready") throw new Error("Waiting for the current session-scoped scene.");
    const spectrum = composeAntennaSpectrumRequest(current, stageId, values);
    request = { base_revision: draft.baseRevision, kind: "merge_patch", merge_patch: {
      antenna_spectrum_requests: [...(current.antenna_spectrum_requests ?? []), spectrum],
    } };
  } catch (error) { reason = error instanceof Error ? error.message : String(error); }
  const canCreate = Boolean(request && draft.dirty && !pending && !conflict);
  function update(patch: Partial<AntennaSpectrumDraft>) {
    if (!current || !validRevision) return;
    setLocal({ ...draft, ...(draft.dirty ? {} : { baseRevision: revision }), dirty: true, values: { ...values, ...patch } }); setFeedback(null);
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
      }, `Create antenna source FFT from ${stageId}`, () => api.model.commitTransaction(transaction, { sessionScopeKey: scope }), validate);
      if (!isCurrent()) return false;
      const committed = validate(response);
      publishCommittedSceneResource(resources, committed, response.scene_revision, undefined, false, scope, api.resourceCacheScope);
      invalidateAuthoringMutationDependents(resources, "interaction", response.scene_revision);
      setLocal((value) => acknowledgeAntennaSpectrumDraft(value, submitted, response.scene_revision));
      setRejected(null);
      setFeedback({ token, kind: "success", message: "Source FFT request saved. No spectrum was computed. FFT execution is not yet available in this workspace." });
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
    { historyMode: "mutation-owned", applyBlockReason: reason ?? (conflict ? "Scene changed. Review and explicitly rebase the FFT draft." : undefined) });

  return <div data-testid="antenna-spectrum-composer"><InspectorGroup title="Author structured spatial FFT">
    <FeedbackBanner kind="warning" message="This analyzes the per-ampere antenna field basis, not the spin-wave response. FEM element sampling requires a qualified tet4 field carrier." />
    <FormField label="FFT target object" type="select" value={values.targetObjectId} onChange={(event) => update({ targetObjectId: event.currentTarget.value })}>
      <option value="">Select target object</option>
      {(current?.objects ?? []).map((object) => <option key={object.id} value={object.id}>{object.name || object.id} ({object.id})</option>)}
    </FormField>
    <AntennaSamplingPlaneFields values={values} onChange={frame => update(frame)} />
    <FormField label="Extent u" unit="m" value={values.extentUM} onChange={(event) => update({ extentUM: event.currentTarget.value })} />
    <FormField label="Extent v" unit="m" value={values.extentVM} onChange={(event) => update({ extentVM: event.currentTarget.value })} />
    <FormField label="Samples u" value={values.samplesU} onChange={(event) => update({ samplesU: event.currentTarget.value })} />
    <FormField label="Samples v" value={values.samplesV} onChange={(event) => update({ samplesV: event.currentTarget.value })} />
    <AntennaSamplingResolution values={values} />
    <FormField label="Window" type="select" value={values.windowKind} onChange={(event) => update({ windowKind: event.currentTarget.value as AntennaSpectrumDraft["windowKind"] })}>
      <option value="rectangular">Rectangular</option><option value="hann">Hann</option><option value="hamming">Hamming</option><option value="blackman">Blackman</option>
    </FormField>
    <FormField label="Normalization" type="select" value={values.normalization} onChange={(event) => update({ normalization: event.currentTarget.value as AntennaSpectrumDraft["normalization"] })}>
      <option value="integral_si">Integral SI</option><option value="unitary_discrete">Unitary discrete</option>
    </FormField>
    <FormField label="Component" type="select" value={values.component} onChange={(event) => update({ component: event.currentTarget.value as AntennaSpectrumDraft["component"] })}>
      <option value="x">Hx</option><option value="y">Hy</option><option value="z">Hz</option><option value="u">Hu</option><option value="v">Hv</option><option value="normal">Hnormal</option><option value="vector_power">Vector magnitude squared</option>
    </FormField>
    <FormField label="Outside domain" type="select" value={values.outsidePolicy} onChange={(event) => update({ outsidePolicy: event.currentTarget.value as AntennaSpectrumDraft["outsidePolicy"] })}>
      <option value="error">Fail request</option><option value="zero">Zero outside samples</option>
    </FormField>
    {reason ? <FeedbackBanner kind="warning" message={reason} /> : null}
    {conflict ? <FeedbackBanner kind="warning" message="Scene changed or the previous write was not confirmed. Review and explicitly rebase or discard the FFT draft." /> : null}
    {feedback?.token === token ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    <div className="fm-microstrip-station-actions">
      <Button type="button" onClick={refetch}>Refresh FFT source</Button>
      <Button type="button" disabled={!draft.dirty || pending} onClick={discard}>Discard FFT draft</Button>
      {conflict ? <Button type="button" disabled={pending || !validRevision || status !== "ready"} onClick={() => { setLocal({ ...draft, baseRevision: revision!, dirty: true }); setRejected(null); }}>Rebase FFT draft explicitly</Button> : null}
      <Button type="button" disabled={!canCreate} onClick={() => void create()}>Create source FFT request</Button>
    </div>
  </InspectorGroup></div>;
}
