import { useLayoutEffect, useRef, useState } from "react";
import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { AuthoringTransactionResponse, SceneResource } from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { committedAntennaTransactionScene } from "./AntennaTransactionAcknowledgement";
import { useKernel } from "@/kernel/KernelContext";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { Button } from "@/shared/ui/Button";
import { useInspectorEditSession, useRegisterInspectorEditSession } from "../../InspectorEditSession";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { FormField } from "../../primitives/FormField";
import { AntennaSamplingPlaneFields } from "./AntennaSamplingPlaneFields";
import { AntennaSamplingResolution } from "./AntennaSamplingResolution";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { antennaSolveTargetOptions } from "./AntennaSolveTargetsEditorModel";
import {
  acknowledgeAntennaResourceDraft, antennaEditableResource,
  antennaResourceDependents, buildAntennaResourceTransaction, createAntennaResourceDraft,
  type AntennaEditableKind, type AntennaResourceDraft,
} from "./AntennaResourceEditorModel";

interface Props { removeOnly?: boolean; kind: AntennaEditableKind; resourceId: string; scene: SceneResource | null; sceneScopeKey: string | null; status: string; refetch: () => void }

function AntennaResourceEditSession({ pending, dirty, valid, reason, apply, reset }: {
  pending: boolean; dirty: boolean; valid: boolean; reason: string | null;
  apply: () => Promise<boolean>; reset: () => void;
}) {
  useRegisterInspectorEditSession("staged", pending, dirty, valid, undefined,
    apply, reset, { historyMode: "mutation-owned", applyBlockReason: reason ?? undefined });
  return null;
}

export function AntennaResourceEditor({ kind, resourceId, scene, sceneScopeKey, status, refetch, removeOnly = false }: Props) {
  const { api, resources, commands, authoringHistory, selection } = useKernel();
  const editSession = useInspectorEditSession();
  const identity = useSessionResourceIdentity();
  const scope = sessionRequestScopeKey(identity);
  const key = JSON.stringify([scope, kind, resourceId]);
  const [contextState, setContext] = useState({ key, token: {} });
  const context = contextState.key === key ? contextState : { key, token: {} };
  if (contextState.key !== key) setContext(context);
  const [local, setLocal] = useState<AntennaResourceDraft | null>(null);
  const [acknowledgedBase, setAcknowledgedBase] = useState<AntennaResourceDraft | null>(null);
  if (acknowledgedBase && acknowledgedBase.key !== key) setAcknowledgedBase(null);
  if (local && local.key !== key) setLocal(null);
  const [pendingState, setPending] = useState<{ token: object } | null>(null);
  const [feedback, setFeedback] = useState<{ key: string; kind: "success" | "error"; message: string } | null>(null);
  const owner = useRef<object | null>(null);
  const inflight = useRef<object | null>(null);
  useLayoutEffect(() => { owner.current = context.token; return () => { owner.current = null; }; }, [context.token]);
  const resource = antennaEditableResource(scene, kind, resourceId);
  const awaitingScene = acknowledgedBase?.key === key && (scene?.revision ?? -1) < acknowledgedBase.baseRevision;
  const initial = awaitingScene ? acknowledgedBase : scene && resource && typeof scene.revision === "number" ? createAntennaResourceDraft(scene, kind, resourceId, key) : null;
  const draft = local?.key === key ? local : initial;
  const dirty = local?.key === key;
  const pending = pendingState?.token === context.token || awaitingScene;
  const removalBlockedByDraft = removeOnly && Boolean(editSession?.dirty || editSession?.applying);
  const revision = typeof scene?.revision === "number" && Number.isSafeInteger(scene.revision) ? scene.revision : null;
  const conflict = Boolean(dirty && !awaitingScene && draft?.baseRevision !== revision);
  const scoped = Boolean(scope && scene?.scene?.id && sceneScopeKey === scope && revision !== null);
  const dependents = scene ? antennaResourceDependents(scene, kind, resourceId) : [];
  let transaction: ReturnType<typeof buildAntennaResourceTransaction> | null = null;
  let reason: string | null = null;
  try {
    if (awaitingScene) throw new Error("Waiting for the committed scene revision.");
    if (!scoped || !scene || !draft || status !== "ready") throw new Error("Current session-scoped scene is required.");
    transaction = buildAntennaResourceTransaction(scene, kind, resourceId, draft, removeOnly);
  } catch (error) { reason = error instanceof Error ? error.message : String(error); }
  function update(values: Record<string, string>) {
    if (draft && scoped) { setLocal({ ...draft, values: { ...draft.values, ...values } }); setFeedback(null); }
  }
  function updateBranch(index: number, patch: Partial<AntennaResourceDraft["branches"][number]>) {
    if (draft && scoped) { setLocal({ ...draft, branches: draft.branches.map((branch, i) => i === index ? { ...branch, ...patch } : branch) }); setFeedback(null); }
  }
  async function commit(remove = false): Promise<boolean> {
    if (remove && removalBlockedByDraft) return false;
    if (!scene || !draft || !scope || !scoped || status !== "ready" || pending || conflict || inflight.current) return false;
    const submitted = draft;
    let request;
    try { request = remove ? buildAntennaResourceTransaction(scene, kind, resourceId, submitted, true) : transaction; }
    catch (error) { setFeedback({ key, kind: "error", message: error instanceof Error ? error.message : String(error) }); return false; }
    if (!request || (!remove && !dirty)) return false;
    const submittedRequest = request;
    const submittedSceneId = scene.scene?.id ?? "";
    const ownerToken = context.token;
    const operation = {};
    const historyGeneration = authoringHistory?.getGeneration?.();
    const isCurrent = () => owner.current === ownerToken && commands.getSessionScopeKey() === scope &&
      (historyGeneration === undefined || authoringHistory?.getGeneration?.() === historyGeneration);
    inflight.current = operation;
    setPending({ token: ownerToken });
    setFeedback(null);
    function validateCommittedScene(response: AuthoringTransactionResponse): SceneResource {
      const committed = committedAntennaTransactionScene(response, submittedRequest, submittedSceneId);
      return committed;
    }
    try {
      const response = await runAuthoringMutationWithHistory({ api, authoringHistory, selection,
        resourceData: { [MODEL_SCENE_PATH]: scene }, sessionScopeKey: scope, isCurrentSessionScope: isCurrent },
      `${remove ? "Remove" : "Edit"} antenna ${kind} ${resourceId}`,
      () => api.model.commitTransaction(request, { sessionScopeKey: scope }), validateCommittedScene);
      if (!isCurrent()) return false;
      const committed = validateCommittedScene(response);
      setAcknowledgedBase(remove ? null : createAntennaResourceDraft(committed, kind, resourceId, key));
      publishCommittedSceneResource(resources, committed, response.scene_revision, undefined, false, scope, api.resourceCacheScope);
      invalidateAuthoringMutationDependents(resources, "interaction", response.scene_revision);
      setLocal((current) => acknowledgeAntennaResourceDraft(current, submitted, response.scene_revision));
      setFeedback({ key, kind: "success", message: remove ? "Resource removed without cascading deletion." : "Resource committed. Field publication and FFT qualification still require their runtime gates." });
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      refetch();
      setFeedback({ key, kind: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      if (inflight.current === operation) inflight.current = null;
      setPending((current) => current?.token === ownerToken ? null : current);
    }
  }

  // Keep the last draft visible through invalidation and ACK; only the transaction buttons are pending.
  if (!draft) return null;
  const values = draft.values;
  const field = (name: string, label: string, unit?: string) => <FormField key={name} label={label} unit={unit} value={values[name] ?? ""} onChange={(event) => update({ [name]: event.currentTarget.value })} />;
  const choice = (name: string, label: string, options: Array<[string, string]>) => <FormField key={name} type="select" label={label} value={values[name] ?? ""} onChange={(event) => update({ [name]: event.currentTarget.value })}>{options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</FormField>;
  return <InspectorGroup title={removeOnly ? `Remove antenna ${kind}` : `Edit antenna ${kind}`} collapsible defaultOpen>
    {!removeOnly ? <AntennaResourceEditSession pending={pending} dirty={dirty} valid={Boolean(transaction && !conflict)} reason={reason} apply={() => commit()} reset={() => setLocal(null)} /> : null}
    <FieldRow label="Immutable resource ID" value={resourceId} mono />
    {!removeOnly ? <>
    {kind === "port" ? <>
      <p className="fm-inspector-hint">Signed weights define a normalized port mode. They do not set terminal currents or activate a solve.</p>
      {draft.branches.map((branch, index) => <InspectorGroup key={index} title={`Branch ${index + 1}`}>
        {([ ["id", "Branch ID"], ["inlet", "Inlet terminal"], ["outlet", "Outlet terminal"], ["weight", "Signed weight"] ] as const).map(([name, label]) => <FormField key={name} label={label} value={branch[name]} onChange={(event) => updateBranch(index, { [name]: event.currentTarget.value })} />)}
        <Button type="button" onClick={() => setLocal({ ...draft, branches: draft.branches.filter((_, i) => i !== index) })}>Remove branch from draft</Button>
      </InspectorGroup>)}
      <Button type="button" onClick={() => setLocal({ ...draft, branches: [...draft.branches, { id: "", inlet: "", outlet: "", weight: "" }] })}>Add explicit branch</Button>
    </> : <>
      {choice("target", "Target", antennaSolveTargetOptions(scene).map((option): [string, string] => [option.key, option.label]))}
      {choice("rebind", "Source binding", [["", "Keep exact current reference and asset pins"], ...(scene?.antenna_field_solve_stages ?? []).map((stage): [string, string] => [stage.id, `Rebind explicitly to stage output: ${stage.id}`])])}
      <p className="fm-inspector-hint">Keeping the reference preserves its asset ID and digest. Explicit rebind replaces it with a pending stage-output reference and does not run the stage.</p>
    </>}
    {kind === "spectrum" ? <>
      <AntennaSamplingPlaneFields values={{ originM: values.originM ?? "", axisU: values.axisU ?? "", axisV: values.axisV ?? "" }} onChange={frame => update(frame)} />
      {field("extentUM", "Extent u", "m")}{field("extentVM", "Extent v", "m")}{field("samplesU", "Samples u")}{field("samplesV", "Samples v")}
      <AntennaSamplingResolution transform={resource && "transform" in resource ? resource.transform : ""} values={{ extentUM: values.extentUM ?? "", extentVM: values.extentVM ?? "", samplesU: values.samplesU ?? "", samplesV: values.samplesV ?? "" }} />
      {choice("windowKind", "Window", ["rectangular", "hann", "hamming", "blackman"].map((value): [string, string] => [value, value]))}
      {choice("normalization", "Normalization", [["integral_si", "Integral SI"], ["unitary_discrete", "Unitary discrete"]])}
      {choice("component", "Component", [...["x", "y", "z", "u", "v", "normal", "vector_power"].map((value): [string, string] => [value, value]), ...(resource && "component" in resource && resource.component === "transverse" ? [["transverse", "Transverse (equilibrium projection)"] as [string, string]] : [])])}
      {choice("outsidePolicy", "Outside domain", [["error", "Fail request"], ["zero", "Explicit zero outside"]])}
      <p className="fm-inspector-hint">Source spatial FFT only. Interpolation and immutable request/output IDs remain unchanged. Saving does not qualify or publish a spectrum.</p>
    </> : null}
    </> : <p className="fm-inspector-hint">Removal never cascades. Rebind or remove every dependent resource before removing this port.</p>}
    {reason ? <FeedbackBanner kind={conflict ? "error" : "warning"} message={reason} /> : null}
    {feedback?.key === key ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    {removalBlockedByDraft ? <FeedbackBanner kind="warning" message="Apply or discard the current port draft before removal." /> : null}
    {dependents.length ? <FeedbackBanner kind="warning" message={`Removal refused until dependents are rebound or removed: ${dependents.join(", ")}.`} /> : null}
    <div className="fm-microstrip-station-actions">
      <Button type="button" onClick={refetch}>Refresh resource</Button>
      {!removeOnly && dirty ? <Button type="button" disabled={pending} onClick={() => setLocal(null)}>Discard draft</Button> : null}
      {!removeOnly && conflict && revision !== null ? <Button type="button" disabled={pending || status !== "ready"} onClick={() => setLocal((current) => current?.key === key ? { ...current, baseRevision: revision } : current)}>Rebase draft explicitly</Button> : null}
      {!removeOnly ? <Button type="button" disabled={!dirty || !transaction || conflict || pending} onClick={() => void commit()}>Apply {kind}</Button> : null}
      <Button type="button" disabled={!scoped || status !== "ready" || pending || conflict || dirty || removalBlockedByDraft || dependents.length > 0} onClick={() => void commit(true)}>Remove {kind} (no cascade)</Button>
    </div>
  </InspectorGroup>;
}
