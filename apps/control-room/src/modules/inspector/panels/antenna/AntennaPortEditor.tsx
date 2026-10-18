import { useLayoutEffect, useRef, useState } from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { SceneResource } from "@/kernel/api/apiTypes";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { useKernel } from "@/kernel/KernelContext";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { antennaPortTerminalChoices } from "@/shared/domain/physics/antennaPortValidation";
import { Button } from "@/shared/ui/Button";

import { useRegisterInspectorEditSession } from "../../InspectorEditSession";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  acknowledgeAntennaPortDraft, antennaPortDraftMatches, buildAntennaPortTransaction,
  committedAntennaPortScene, createAntennaPortDraft, type AntennaPortBranchDraft, type AntennaPortDraft,
} from "./AntennaPortEditorModel";

interface Props {
  objectId: string;
  portId: string;
  scene: SceneResource | null; sceneScopeKey: string | null;
  status: string;
  refetch: () => void;
}

export function AntennaPortEditor({ objectId, portId, scene, sceneScopeKey, status, refetch }: Props) {
  const { api, resources, commands, authoringHistory, selection } = useKernel();
  const identity = useSessionResourceIdentity();
  const scope = sessionRequestScopeKey(identity);
  const key = JSON.stringify([scope, objectId, portId]);
  const [ownerState, setOwnerState] = useState({ key, token: {} });
  const context = ownerState.key === key ? ownerState : { key, token: {} };
  if (ownerState.key !== key) setOwnerState(context);
  const [draftState, setDraft] = useState<AntennaPortDraft | null>(null);
  const [pendingState, setPending] = useState<{ token: object } | null>(null);
  const [feedback, setFeedback] = useState<{ token: object; kind: "error" | "success"; message: string } | null>(null);
  const [rebaseRequired, setRebaseRequired] = useState<object | null>(null);
  const owner = useRef<object | null>(null);
  const inflight = useRef<{ ownerToken: object; operation: object } | null>(null);
  const nextRow = useRef(0);
  useLayoutEffect(() => {
    owner.current = context.token;
    return () => { owner.current = null; };
  }, [context.token]);

  const currentScene = scope && sceneScopeKey === scope && scene?.scene?.id ? scene : null;
  const revision = typeof currentScene?.revision === "number" && Number.isSafeInteger(currentScene.revision) && currentScene.revision >= 0 ? currentScene.revision : null;
  const sources = currentScene?.objects?.filter((object) => object.id === objectId) ?? [];
  const ports = currentScene?.antenna_port_modes?.filter((port) => port.id === portId) ?? [];
  const mode = ports.length === 1 && ports[0].source_object_id === objectId ? ports[0] : null;
  let draft = draftState?.key === key ? draftState : null;
  if (draftState && draftState.key !== key) setDraft(null);
  // Keep the last-good form through refreshes. Only an authoritative clean
  // snapshot advances it; an older cache frame must not undo a newer ACK.
  if (mode && revision !== null && status === "ready" && (!draft || (!draft.dirty && revision > draft.baseRevision))) {
    draft = draft && antennaPortDraftMatches(mode, draft)
      ? { ...draft, baseRevision: revision } : createAntennaPortDraft(mode, key, revision);
    setDraft(draft);
  }
  const dirty = draft?.dirty === true;
  const pending = pendingState?.token === context.token;
  const requiresRebase = rebaseRequired === context.token;
  const conflict = dirty && !pending && (requiresRebase || draft?.baseRevision !== revision);
  const editable = Boolean(draft && scope && currentScene && mode && sources.length === 1 && !sources[0].locked && revision !== null);
  let request: ReturnType<typeof buildAntennaPortTransaction> | null = null;
  let reason: string | null = null;
  try {
    if (!currentScene || !scope || status !== "ready" || revision === null || !draft) {
      throw new Error("Current session-scoped scene is required to edit port terminal pairs.");
    }
    request = buildAntennaPortTransaction(currentScene, objectId, portId, draft);
    if (requiresRebase) throw new Error("Previous port write was not confirmed. Refresh and explicitly rebase or revert before applying again.");
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const canApply = Boolean(dirty && request && !reason && !pending && !conflict);
  const branches = draft?.branches ?? [];
  const terminalChoices = mode && draft ? antennaPortTerminalChoices(currentScene, { ...mode, current_transport_id: draft.currentTransportId }) : [];

  function update(patch: Partial<Pick<AntennaPortDraft, "currentTransportId" | "branches">>) {
    if (!editable || !draft) return;
    setDraft({ ...draft, ...patch, dirty: true });
    setFeedback(null);
  }

  function updateBranch(rowKey: string, patch: Partial<AntennaPortBranchDraft>) {
    if (draft) update({ branches: draft.branches.map((branch) => branch.rowKey === rowKey ? { ...branch, ...patch } : branch) });
  }

  function revert() {
    if (pending || !mode || revision === null || status !== "ready") return;
    setDraft(createAntennaPortDraft(mode, key, revision));
    setFeedback(null);
    setRebaseRequired(null);
  }

  async function apply(): Promise<boolean> {
    if (!canApply || !draft || !request || !currentScene || !scope || !mode || !identity || inflight.current?.ownerToken === context.token) return false;
    const submitted = draft;
    const transaction = request;
    const operation = {};
    const ownerToken = context.token;
    const historyGeneration = authoringHistory?.getGeneration?.();
    const isCurrent = () => owner.current === ownerToken && commands.getSessionScopeKey() === scope &&
      (historyGeneration === undefined || authoringHistory?.getGeneration?.() === historyGeneration);
    if (!isCurrent()) return false;
    inflight.current = { ownerToken, operation };
    setPending({ token: ownerToken });
    setFeedback(null);
    try {
      const response = await runAuthoringMutationWithHistory({
        api, authoringHistory, selection, resourceData: { [MODEL_SCENE_PATH]: currentScene },
        sessionScopeKey: scope, isCurrentSessionScope: isCurrent,
      }, `Edit antenna port ${portId}`, () => api.model.commitTransaction(transaction, { sessionScopeKey: scope }),
      (result) => committedAntennaPortScene(result, submitted, objectId, portId, currentScene.scene?.id ?? "", mode));
      if (!isCurrent()) return false;
      const committed = committedAntennaPortScene(response, submitted, objectId, portId, currentScene.scene?.id ?? "", mode);
      publishCommittedSceneResource(resources, committed, response.scene_revision, undefined, false, scope, api.resourceCacheScope);
      invalidateAuthoringMutationDependents(resources, "interaction", response.scene_revision);
      setDraft((current) => acknowledgeAntennaPortDraft(current, submitted, response.scene_revision));
      setRebaseRequired(null);
      setFeedback({ token: ownerToken, kind: "success", message: "Port committed. This validates authoring references only; current closure, mesh and fields require separate qualification and recomputation." });
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      setRebaseRequired(ownerToken);
      refetch();
      setFeedback({ token: ownerToken, kind: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      if (inflight.current?.operation === operation) inflight.current = null;
      setPending((current) => current?.token === ownerToken ? null : current);
    }
  }

  useRegisterInspectorEditSession("staged", pending, dirty, Boolean(request && !reason && !conflict),
    editable ? undefined : "Current unlocked source and port are required.", apply, revert,
    { historyMode: "mutation-owned", applyBlockReason: reason ?? undefined });

  return <InspectorGroup title="Port terminal pairs" collapsible defaultOpen>
    <FieldRow label="Port identity" value={portId} mono />
    <FieldRow label="Source identity" value={objectId} mono />
    <p className="fm-inspector-hint">Edit existing authoring references only. No terminals, source drives or current closure are created. Port identity, schema and normalization are unchanged. Recompute dependent field solutions after a change.</p>
    <FormField label="Current transport" mono value={draft?.currentTransportId ?? ""} disabled={!editable}
      onChange={(event) => update({ currentTransportId: event.currentTarget.value })} />
    {terminalChoices.length === 0 ? <p className="fm-inspector-hint">No selectable terminal inventory is available for this transport. Existing references are preserved; prepare the terminal observations before choosing replacements.</p> : null}
    {branches.map((branch, index) => <div className="fm-inspector-panel" key={branch.rowKey}>
      <FormField label={`Branch ${index + 1} ID`} mono value={branch.id} disabled={!editable}
        onChange={(event) => updateBranch(branch.rowKey, { id: event.currentTarget.value })} />
      <FormField label={`Branch ${index + 1} inlet terminal`} type="select" value={branch.inletTerminalRef} disabled={!editable}
        onChange={(event) => updateBranch(branch.rowKey, { inletTerminalRef: event.currentTarget.value })}>
        <option value="" disabled>Select an existing terminal</option>
        {branch.inletTerminalRef && !terminalChoices.some(choice => choice.id === branch.inletTerminalRef)
          ? <option value={branch.inletTerminalRef} disabled>{branch.inletTerminalRef} · unavailable</option> : null}
        {terminalChoices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </FormField>
      <FormField label={`Branch ${index + 1} outlet terminal`} type="select" value={branch.outletTerminalRef} disabled={!editable}
        onChange={(event) => updateBranch(branch.rowKey, { outletTerminalRef: event.currentTarget.value })}>
        <option value="" disabled>Select an existing terminal</option>
        {branch.outletTerminalRef && !terminalChoices.some(choice => choice.id === branch.outletTerminalRef)
          ? <option value={branch.outletTerminalRef} disabled>{branch.outletTerminalRef} · unavailable</option> : null}
        {terminalChoices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </FormField>
      <FormField label={`Branch ${index + 1} signed weight`} inputMode="decimal" unit="1" value={branch.signedWeight} disabled={!editable}
        onChange={(event) => updateBranch(branch.rowKey, { signedWeight: event.currentTarget.value })} />
      <Button type="button" disabled={!editable} aria-label={`Remove port branch ${index + 1}`}
        onClick={() => update({ branches: branches.filter((item) => item.rowKey !== branch.rowKey) })}>Remove branch</Button>
    </div>)}
    <Button type="button" disabled={!editable} onClick={() => { if (draft) update({ branches: [...draft.branches, {
      rowKey: `added-${nextRow.current++}`, originalId: null, id: "", inletTerminalRef: "", outletTerminalRef: "", signedWeight: "",
    }] }); }}>Add branch</Button>
    {reason ? <FeedbackBanner kind={conflict ? "error" : "warning"} message={reason} /> : null}
    {feedback?.token === context.token ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    <div className="fm-microstrip-station-actions">
      <Button type="button" onClick={refetch}>Refresh port</Button>
      {dirty ? <Button type="button" disabled={pending || !mode || revision === null || status !== "ready"} onClick={revert}>Revert port</Button> : null}
      {conflict ? <Button type="button" disabled={!editable || pending || status !== "ready"} onClick={() => {
        if (!editable || revision === null) return;
        setDraft((current) => current?.key === key ? { ...current, baseRevision: revision } : current);
        setRebaseRequired(null);
        setFeedback(null);
      }}>Rebase port</Button> : null}
      <Button type="button" disabled={!canApply} onClick={() => void apply()}>Apply port</Button>
    </div>
  </InspectorGroup>;
}
