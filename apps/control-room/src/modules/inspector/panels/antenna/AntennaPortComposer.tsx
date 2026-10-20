import { useLayoutEffect, useRef, useState } from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { SceneResource } from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { useKernel } from "@/kernel/KernelContext";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { antennaPortTerminalChoices } from "@/shared/domain/physics/antennaPortValidation";
import { Button } from "@/shared/ui/Button";
import { useRegisterInspectorEditSession } from "../../InspectorEditSession";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { committedAntennaTransactionScene } from "./AntennaTransactionAcknowledgement";
import { antennaPortCreationTransports, buildAntennaPortCreationTransaction, emptyAntennaPortBranch, type AntennaNewPortDraft } from "./AntennaPortComposerModel";

interface Props { objectId: string; scene: SceneResource | null; sceneScopeKey: string | null; status: string; refetch: () => void }

export function AntennaPortComposer({ objectId, scene, sceneScopeKey, status, refetch }: Props) {
  const { api, resources, commands, authoringHistory, selection } = useKernel();
  const scope = sessionRequestScopeKey(useSessionResourceIdentity());
  const key = JSON.stringify([scope, objectId]);
  const [ownerState, setOwner] = useState({ key, token: {} });
  const context = ownerState.key === key ? ownerState : { key, token: {} };
  if (ownerState.key !== key) setOwner(context);
  const token = context.token, owner = useRef<object | null>(null), inflight = useRef<object | null>(null), nextRow = useRef(2);
  useLayoutEffect(() => { owner.current = token; return () => { owner.current = null; }; }, [token]);
  const [local, setLocal] = useState<AntennaNewPortDraft | null>(null);
  if (local && local.key !== key) setLocal(null);
  const [pendingToken, setPending] = useState<object | null>(null), [rejectedToken, setRejected] = useState<object | null>(null);
  const [feedback, setFeedback] = useState<{ token: object; kind: "success" | "error"; message: string } | null>(null);
  const current = scope && sceneScopeKey === scope && scene?.scene?.id ? scene : null;
  const revision = current?.revision;
  const validRevision = typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
  const initial: AntennaNewPortDraft = { key, baseRevision: validRevision ? revision : -1, dirty: false, id: "", transport: "",
    branches: [emptyAntennaPortBranch("new-0"), emptyAntennaPortBranch("new-1")] };
  const draft = local?.key === key ? local : initial;
  const pending = pendingToken === token;
  const conflict = draft.dirty && !pending && (draft.baseRevision !== revision || rejectedToken === token);
  const sources = current?.objects?.filter(object => object.id === objectId) ?? [];
  const editable = Boolean(validRevision && sources.length === 1 && !sources[0].locked);
  const transports = antennaPortCreationTransports(current, objectId);
  const terminals = antennaPortTerminalChoices(current, { schema_version: "antenna_port_mode.v2", id: draft.id,
    source_object_id: objectId, current_transport_id: draft.transport, normalization_current_a: 1, branches: [] });
  let request: ReturnType<typeof buildAntennaPortCreationTransaction> | null = null, reason: string | null = null;
  try {
    if (!current || !validRevision || status !== "ready") throw new Error("Waiting for the current session-scoped scene.");
    request = buildAntennaPortCreationTransaction(current, objectId, draft);
  } catch (error) { reason = error instanceof Error ? error.message : String(error); }
  const canCreate = Boolean(request && draft.dirty && !conflict && !pending);
  function update(patch: Partial<AntennaNewPortDraft>) {
    if (!editable || !validRevision) return;
    setLocal({ ...draft, ...(draft.dirty ? {} : { baseRevision: revision }), ...patch, dirty: true }); setFeedback(null);
  }
  function discard() { if (!pending) { setLocal(null); setRejected(null); setFeedback(null); } }
  async function create(): Promise<boolean> {
    if (!current || !scope || !request || !canCreate || inflight.current === token) return false;
    const submitted = draft, transaction = request, sourceScene = current, generation = authoringHistory?.getGeneration?.();
    const isCurrent = () => owner.current === token && commands.getSessionScopeKey() === scope &&
      (generation === undefined || authoringHistory?.getGeneration?.() === generation);
    if (!isCurrent()) return false;
    inflight.current = token; setPending(token); setFeedback(null);
    const validate = (response: Parameters<typeof committedAntennaTransactionScene>[0]) => committedAntennaTransactionScene(response, transaction, sourceScene.scene?.id ?? "");
    try {
      const response = await runAuthoringMutationWithHistory({ api, authoringHistory, selection,
        resourceData: { [MODEL_SCENE_PATH]: sourceScene }, sessionScopeKey: scope, isCurrentSessionScope: isCurrent,
      }, `Create antenna port ${submitted.id}`, () => api.model.commitTransaction(transaction, { sessionScopeKey: scope }), validate);
      if (!isCurrent()) return false;
      const committed = validate(response);
      publishCommittedSceneResource(resources, committed, response.scene_revision, undefined, false, scope, api.resourceCacheScope);
      invalidateAuthoringMutationDependents(resources, "interaction", response.scene_revision);
      setLocal(value => value?.key === key ? value === submitted ? null : { ...value, baseRevision: response.scene_revision } : value);
      setRejected(null);
      setFeedback({ token, kind: "success", message: `Port '${submitted.id}' committed. No source, drive, field solve or mesh was created; execution requires separate validation.` });
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      setRejected(token); refetch(); setFeedback({ token, kind: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally { if (inflight.current === token) inflight.current = null; setPending(value => value === token ? null : value); }
  }
  useRegisterInspectorEditSession("staged", pending, draft.dirty, canCreate, editable ? undefined : "Current unlocked source is required.", create, discard,
    { historyMode: "mutation-owned", applyBlockReason: reason ?? (conflict ? "Review and explicitly rebase the new port draft." : undefined) });
  return <div data-testid="antenna-port-composer"><InspectorGroup title="Add antenna port">
    <p className="fm-inspector-hint">Define terminal-current normalization (v2), with a 1 A reference and explicit signed branches. An external source requires its already authored matching drive. A closed-loop source owns its v3 port and cut; adding another port to that transport is unsupported. Reusing terminals does not create independent physical excitation.</p>
    <FormField label="New port ID" value={draft.id} disabled={!editable} onChange={event => update({ id: event.currentTarget.value })} />
    <FormField type="select" label="New port transport" value={draft.transport} disabled={!editable} onChange={event => update({ transport: event.currentTarget.value })}>
      <option value="">Select an existing current transport</option>
      {draft.transport && !transports.some(transport => transport.name === draft.transport) ? <option value={draft.transport} disabled>{draft.transport} · unavailable</option> : null}
      {transports.map(transport => <option key={transport.name} value={transport.name}>{transport.name}</option>)}
    </FormField>
    {draft.branches.map((branch, index) => <div className="fm-inspector-panel" key={branch.rowKey}>
      <FormField label={`New port branch ${index + 1} ID`} value={branch.id} disabled={!editable} onChange={event => update({ branches: draft.branches.map(row => row.rowKey === branch.rowKey ? { ...row, id: event.currentTarget.value } : row) })} />
      {(["inletTerminalRef", "outletTerminalRef"] as const).map((field, role) => <FormField key={field} type="select" label={`New port branch ${index + 1} ${role ? "outlet" : "inlet"} terminal`} value={branch[field]} disabled={!editable} onChange={event => update({ branches: draft.branches.map(row => row.rowKey === branch.rowKey ? { ...row, [field]: event.currentTarget.value } : row) })}>
        <option value="" disabled>Select an existing terminal</option>
        {branch[field] && !terminals.some(terminal => terminal.id === branch[field]) ? <option value={branch[field]} disabled>{branch[field]} · unavailable</option> : null}
        {terminals.map(terminal => <option key={terminal.id} value={terminal.id}>{terminal.label}</option>)}
      </FormField>)}
      <FormField label={`New port branch ${index + 1} signed weight`} unit="1" value={branch.signedWeight} disabled={!editable} onChange={event => update({ branches: draft.branches.map(row => row.rowKey === branch.rowKey ? { ...row, signedWeight: event.currentTarget.value } : row) })} />
      <Button type="button" disabled={!editable} onClick={() => update({ branches: draft.branches.filter(row => row.rowKey !== branch.rowKey) })}>Remove new port branch {index + 1}</Button>
    </div>)}
    <Button type="button" disabled={!editable} onClick={() => update({ branches: [...draft.branches, emptyAntennaPortBranch(`new-${nextRow.current++}`)] })}>Add new port branch</Button>
    {reason && draft.dirty ? <FeedbackBanner kind="warning" message={reason} /> : null}
    {conflict ? <FeedbackBanner kind="warning" message="Scene changed or the previous write was not confirmed. Review and explicitly rebase or discard this draft." /> : null}
    {feedback?.token === token ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    <div className="fm-microstrip-station-actions">
      <Button type="button" onClick={refetch}>Refresh port sources</Button>
      <Button type="button" disabled={!draft.dirty || pending} onClick={discard}>Discard new port draft</Button>
      {conflict ? <Button type="button" disabled={pending || !validRevision || status !== "ready"} onClick={() => { setLocal({ ...draft, baseRevision: revision!, dirty: true }); setRejected(null); }}>Rebase new port draft explicitly</Button> : null}
      <Button type="button" disabled={!canCreate} onClick={() => void create()}>Create port</Button>
    </div>
  </InspectorGroup></div>;
}
