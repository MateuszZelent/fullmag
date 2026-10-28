"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import type { SceneResource, SceneSpinTransport, TransportValidationRequest, TransportValidationResponse } from "@/kernel/api/apiTypes";
import {
  authoringWriteOptions,
  captureAuthoringMutationFence,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  SPIN_INTERFACES_RESOURCE_KEY,
  SPIN_TRANSPORTS_RESOURCE_KEY,
  invalidateSpinAuthoringResources,
  useSpinInterfacesResource,
  useSpinTransportsResource,
  useSpinAuthoringGeometryResource,
  useSpinInterfaceMeshEvidenceResource,
} from "@/kernel/resources/spinAuthoringResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import {
  useSessionResourceIdentity,
  useSessionStatusSelector,
} from "@/kernel/resources/useSessionStatus";
import { Button } from "@/shared/ui/Button";
import { getTransportAuthoringCapability } from "@/shared/domain/physics/transportAuthoringCapabilities";

import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { PhysicsInspectorOverview } from "./PhysicsInspectorOverview";
import { buildPhysicsInspectorOverviewModel } from "./PhysicsInspectorOverviewModel";
import { INTERFACE_TRACE_DIRECTIONS, bindInterfaceTraces, canBindInterfaceTraces, interfaceTraceSelection, buildInterface, interfaceDraft, record, region, reconcileInterfaceDraft, type InterfaceDraft } from "./SpinInterfaceInspectorModel";
import { transportScopeOptions } from "./TransportCollectionFieldsModel";
import { verifySpinInterfaceMeshOrientation } from "./SpinInterfaceMeshEvidenceModel";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";

export function SpinInterfaceInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const { api, commands, resources } = kernel;
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const projected = useSpinInterfacesResource();
  const geometry = useSpinAuthoringGeometryResource();
  const transports = useSpinTransportsResource();
  const interfaceRef = selection.ref?.type === "spin-interface" ? selection.ref : null;
  const ref = interfaceRef &&
    (interfaceRef.spinInterfaceIndex !== undefined || Boolean(interfaceRef.spinInterfaceId))
    ? interfaceRef
    : null;
  const [localOwnerId, setLocalOwnerId] = useState("");
  const [localInterfaceId, setLocalInterfaceId] = useState("");
  const ownerId = interfaceRef?.spinInterfaceOwnerId ?? localOwnerId;
  const selected = useMemo(() => {
    const items = projected.data?.items ?? [];
    if (ref?.spinInterfaceIndex !== undefined) return items[ref.spinInterfaceIndex] ?? null;
    if (ref?.spinInterfaceId) {
      return items.find((item) =>
        item.interface_id === ref.spinInterfaceId &&
        (!ref.spinInterfaceOwnerId || item.owner_spin_transport_id === ref.spinInterfaceOwnerId)
      ) ?? null;
    }
    return items.find((item) => item.owner_spin_transport_id === ownerId && item.interface_id === localInterfaceId) ?? null;
  }, [
    localInterfaceId,
    ownerId,
    projected.data?.items,
    ref,
  ]);
  const initialDraft = interfaceDraft(selected?.interface);
  const addressedId = ref?.spinInterfaceId ?? (ref?.spinInterfaceIndex !== undefined ? `index:${ref.spinInterfaceIndex}` : localInterfaceId || selected?.interface_id || null);
  const draftKey = JSON.stringify([sessionScopeKey, ownerId, addressedId ?? "new"]);
  const [draftState, setDraftState] = useState<{ key: string; value: InterfaceDraft; baseline: InterfaceDraft; ackRevision: number | null }>({ key: draftKey, value: initialDraft, baseline: initialDraft, ackRevision: null });
  const serverDraft = !selected && draftState.key === draftKey ? draftState.baseline : initialDraft;
  const targetUnavailable = Boolean(addressedId && !selected && projected.status === "ready" && (draftState.key !== draftKey || draftState.ackRevision === null || (projected.data?.scene_revision ?? -1) >= draftState.ackRevision));
  const baseDraft = draftState.key === draftKey && draftState.ackRevision !== null && (projected.data?.scene_revision ?? -1) < draftState.ackRevision ? draftState.baseline : serverDraft;
  const resolved = draftState.key === draftKey ? reconcileInterfaceDraft(baseDraft, draftState.value, draftState.baseline) : { draft: baseDraft, conflicts: [] };
  const draft = resolved.draft;
  const activeDraftKey = useRef(draftKey);
  useLayoutEffect(() => { activeDraftKey.current = draftKey; }, [draftKey]);
  const sideA = draft.kind === "transparent" ? { objectId: draft.sideAObject, regionId: draft.sideARegion } : { objectId: draft.normalObject, regionId: draft.normalRegion };
  const sideB = draft.kind === "transparent" ? { objectId: draft.sideBObject, regionId: draft.sideBRegion } : { objectId: draft.ferromagnetObject, regionId: draft.ferromagnetRegion };
  const meshEvidence = useSpinInterfaceMeshEvidenceResource(sideA, sideB);
  const meshMessage = useMemo(() => {
  let meshMessage = "Mesh adjacency/orientation NOT VERIFIED. Select two explicit regions and build their shared tet4 mesh.";
  try {
    if (meshEvidence.data && meshEvidence.status === "ready") {
      if (meshEvidence.data.sideA.owner_object_id !== sideA.objectId || meshEvidence.data.sideA.region_id !== sideA.regionId || meshEvidence.data.sideB.owner_object_id !== sideB.objectId || meshEvidence.data.sideB.region_id !== sideB.regionId) throw new Error("Mesh evidence belongs to different interface sides.");
      const normal = (draft.kind === "transparent" ? draft.normalAToB : draft.normalToFerromagnet).split(/[\s,]+/).filter(Boolean).map(Number);
      const proof = verifySpinInterfaceMeshOrientation(meshEvidence.data, normal);
      meshMessage = `Mesh verified: ${proof.sharedFacetCount} adjacent tet4 facets, area=${proof.interfaceAreaM2.toExponential(4)} m²; authored normal agrees with side A → B.`;
    } else if (meshEvidence.error) meshMessage = `Mesh adjacency/orientation NOT VERIFIED: ${meshEvidence.error.message}`;
  } catch (error) { meshMessage = `Mesh adjacency/orientation NOT VERIFIED: ${error instanceof Error ? error.message : String(error)}`; }
  return meshMessage;
  }, [meshEvidence.data, meshEvidence.error, meshEvidence.status, draft.kind, draft.normalAToB, draft.normalToFerromagnet, sideA.objectId, sideA.regionId, sideB.objectId, sideB.regionId]);
  const [pendingOperation, setPendingOperation] = useState<{
    id: number;
    sessionScopeKey: string;
    draftKey: string;
  } | null>(null);
  const nextPendingOperationId = useRef(0);
  const pending = pendingOperation?.sessionScopeKey === sessionScopeKey && pendingOperation.draftKey === draftKey;
  const [feedbackState, setFeedbackState] = useState<{ key: string; kind: "error" | "success"; message: string } | null>(null);
  const feedback = feedbackState?.key === draftKey ? feedbackState : null;
  const setFeedback = (value: { kind: "error" | "success"; message: string } | null) => setFeedbackState(value ? { ...value, key: draftKey } : null);
  const validationKey = `${draftKey}:${transports.data?.scene_revision ?? "none"}:${JSON.stringify(draft)}`;
  const [validationState, setValidationState] = useState<{ key: string; response: TransportValidationResponse | null }>({ key: "", response: null });
  const validation = validationState.key === validationKey ? validationState.response : null;
  const readOnly = selected ? !selected.known : false;
  const capabilities = useSessionStatusSelector((status) => status.data?.capabilities.transport_authoring ?? null);
  const owner = (transports.data?.items ?? []).find((item) => record(item)?.id === ownerId) ?? null;
  const capability = getTransportAuthoringCapability("spin_transport", owner, geometry.data, capabilities);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseDraft);
  const valid = Boolean(
    !readOnly && !targetUnavailable && resolved.conflicts.length === 0 &&
      ownerId &&
      transports.status === "ready" &&
      capability?.authoring_allowed &&
      validation?.semantic.valid === true &&
      validation?.execution.authoring_allowed === true,
  );
  const lockReason = readOnly
    ? "Unknown interface payloads are read-only."
    : !sessionScopeKey
      ? "Session identity is not ready."
    : !ownerId
      ? "Select the owning spin transport before applying."
      : transports.status !== "ready"
        ? "Spin transport resources are not ready."
        : !capability?.authoring_allowed
          ? capability?.reason ?? "Authoring capability is unavailable."
          : undefined;

  const validationRequest = (): TransportValidationRequest => {
    if (!ownerId || transports.data?.scene_revision === undefined) throw new Error("Select the owning spin transport.");
    return {
      base_revision: transports.data.scene_revision,
      candidate: { interface_id: selected?.interface_id ?? null, kind: "spin_interface", operation: selected ? "replace" : "create", owner_spin_transport_id: ownerId, resource: buildInterface(draft) },
      validation_version: "transport-authoring-validation.v1",
    };
  };

  const captureMutationContext = () => captureAuthoringMutationFence(
    createCommandContext("inspector", kernel, { sessionScopeKey }),
  );
  const isCurrentSession = () => Boolean(
    sessionScopeKey && commands?.getSessionScopeKey?.() === sessionScopeKey,
  );

  useEffect(() => {
    if (!sessionScopeKey || readOnly || targetUnavailable || !ownerId || transports.data?.scene_revision === undefined) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      try {
        void api.model.validateTransport(validationRequest(), {
          sessionScopeKey,
          signal: controller.signal,
        }).then((response) => {
          if (!controller.signal.aborted && isCurrentSession() && activeDraftKey.current === draftKey) {
            setValidationState({ key: validationKey, response });
          }
        }).catch(() => {
          if (!controller.signal.aborted && isCurrentSession() && activeDraftKey.current === draftKey) {
            setValidationState({ key: validationKey, response: null });
          }
        });
      } catch {
        if (!controller.signal.aborted && isCurrentSession() && activeDraftKey.current === draftKey) {
          setValidationState({ key: validationKey, response: null });
        }
      }
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  // Serialized draft is the validation dependency by design.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, commands, ownerId, readOnly, selected?.interface_id, sessionScopeKey, targetUnavailable, transports.data?.scene_revision, validationKey]);

  function ownerWith(nextInterface: unknown | null): SceneSpinTransport {
    const owner = (transports.data?.items ?? []).find((item) => record(item)?.id === ownerId);
    const ownerRecord = record(owner);
    if (!owner || !ownerRecord || !Array.isArray(ownerRecord.interfaces)) throw new Error("The owning spin transport is unavailable or read-only.");
    const selectedIndex = selected ? ownerRecord.interfaces.findIndex((item) => record(item)?.id === selected.interface_id) : -1;
    const interfaces = selectedIndex >= 0
      ? nextInterface === null ? ownerRecord.interfaces.filter((_, index) => index !== selectedIndex) : ownerRecord.interfaces.map((item, index) => index === selectedIndex ? nextInterface : item)
      : nextInterface === null ? ownerRecord.interfaces : [...ownerRecord.interfaces, nextInterface];
    return { ...ownerRecord, interfaces } as SceneSpinTransport;
  }

  async function validateOwner(resource: SceneSpinTransport, baseRevision: number | undefined, requestScopeKey: string) {
    const revision = baseRevision ?? transports.data?.scene_revision;
    if (revision === undefined) throw new Error("Scene revision is unavailable.");
    const response = await api.model.validateTransport({ base_revision: revision, candidate: { kind: "spin_transport", operation: "replace", path_id: ownerId, resource }, validation_version: "transport-authoring-validation.v1" }, { sessionScopeKey: requestScopeKey });
    if (commands?.getSessionScopeKey?.() !== requestScopeKey) throw new Error("Session changed during validation.");
    if (!response.semantic.valid || !response.execution.authoring_allowed) throw new Error(response.semantic.issues[0]?.message ?? response.execution.reason ?? "Owner update is not authoring-ready.");
  }

  async function run(action: "save" | "delete"): Promise<boolean> {
    if (!sessionScopeKey || pending || resolved.conflicts.length > 0 || !valid) return false;
    const submittedDraft = draft;
    const submittedRevision = transports.data?.scene_revision;
    const mutationContext = captureMutationContext();
    const operationId = ++nextPendingOperationId.current;
    setPendingOperation({ id: operationId, sessionScopeKey, draftKey });
    setFeedback(null);
    try {
      if (!capability?.authoring_allowed) throw new Error(capability?.reason ?? "Authoring capability is unavailable.");
      const nextInterface = action === "delete" ? null : buildInterface(draft);
      if (nextInterface) {
        const checked = await api.model.validateTransport(validationRequest(), { sessionScopeKey });
        if (mutationContext.isCurrentSessionScope?.() !== true || activeDraftKey.current !== draftKey) return false;
        setValidationState({ key: validationKey, response: checked });
        if (!checked.semantic.valid || !checked.execution.authoring_allowed) throw new Error(checked.semantic.issues[0]?.message ?? checked.execution.reason ?? "Interface is not authoring-ready.");
      } else if (validation?.execution.authoring_allowed !== true) throw new Error("Latest clone-only validation does not permit mutation.");
      const resource = ownerWith(nextInterface);
      const commit = action === "delete"
        ? await runAuthoringMutationWithHistory(
            mutationContext,
            `Delete spin interface ${selected?.interface_id ?? "new"}`,
            async ({ baseRevision }) => {
              const revision = baseRevision ?? transports.data!.scene_revision;
              if (revision !== submittedRevision) throw new Error("Scene revision changed before interface commit. Refresh and rebase.");
              await validateOwner(resource, revision, mutationContext.sessionScopeKey!);
              if (mutationContext.isCurrentSessionScope?.() !== true) {
                throw new Error("Authoring mutation belongs to an obsolete session.");
              }
              const requestOptions = authoringWriteOptions(null, mutationContext.sessionScopeKey);
              if (!requestOptions?.sessionScopeKey) throw new Error("Session identity is not ready.");
              return api.model.replaceSpinTransport(ownerId, {
                base_revision: revision,
                resource,
              }, requestOptions);
            },
          )
        : await runAuthoringMutationWithHistory(
            mutationContext,
            `${selected ? "Replace" : "Create"} spin interface ${selected?.interface_id ?? "new"}`,
            async ({ baseRevision }) => {
              const revision = baseRevision ?? transports.data!.scene_revision;
              if (revision !== submittedRevision) throw new Error("Scene revision changed before interface commit. Refresh and rebase.");
              await validateOwner(resource, revision, mutationContext.sessionScopeKey!);
              if (mutationContext.isCurrentSessionScope?.() !== true) {
                throw new Error("Authoring mutation belongs to an obsolete session.");
              }
              const requestOptions = authoringWriteOptions(null, mutationContext.sessionScopeKey);
              if (!requestOptions?.sessionScopeKey) throw new Error("Session identity is not ready.");
              return api.model.replaceSpinTransport(ownerId, {
                base_revision: revision,
                resource,
              }, requestOptions);
            },
          );
      if (mutationContext.isCurrentSessionScope?.() !== true || activeDraftKey.current !== draftKey) return false;
      const acknowledgedOwner = record(commit.resource);
      const acknowledgedInterfaces = acknowledgedOwner?.interfaces;
      const acknowledgedInterface = Array.isArray(acknowledgedInterfaces) ? acknowledgedInterfaces.find((entry) => record(entry)?.id === submittedDraft.id) : null;
      if (!Number.isSafeInteger(commit.scene_revision) || commit.scene_revision <= (submittedRevision ?? -1) ||
          commit.committed_scene?.revision !== commit.scene_revision || acknowledgedOwner?.id !== ownerId ||
          !Array.isArray(acknowledgedInterfaces) || (action === "save"
            ? !acknowledgedInterface || JSON.stringify(buildInterface(interfaceDraft(acknowledgedInterface))) !== JSON.stringify(buildInterface(submittedDraft))
            : acknowledgedInterfaces.some((entry) => record(entry)?.id === selected?.interface_id))) {
        projected.refetch(); transports.refetch();
        throw new Error("Interface ACK omitted or changed the submitted owner/interface. Refresh before retrying.");
      }
      publishCommittedSceneResource(resources, commit.committed_scene, commit.scene_revision, undefined, false, sessionScopeKey, api.resourceCacheScope);
      const acknowledgedKey = action === "save" && !selected ? JSON.stringify([sessionScopeKey, ownerId, submittedDraft.id]) : draftKey;
      if (action === "save") setDraftState((current) => {
        if (current.key !== draftKey) return current;
        const committedOwner = record(commit.resource);
        const committedInterface = (committedOwner?.interfaces as unknown[] | undefined)?.find((entry) => record(entry)?.id === submittedDraft.id);
        if (!committedInterface) return current;
        const acknowledged = interfaceDraft(committedInterface);
        const next = reconcileInterfaceDraft(acknowledged, current.value, submittedDraft).draft;
        return { key: acknowledgedKey, value: next, baseline: acknowledged, ackRevision: commit.scene_revision };
      });
      if (action === "save" && !selected) setLocalInterfaceId(submittedDraft.id);
      invalidateSpinAuthoringResources(resources, commit, [
        SPIN_TRANSPORTS_RESOURCE_KEY,
        SPIN_INTERFACES_RESOURCE_KEY,
      ]);
      setFeedbackState({ key: acknowledgedKey, kind: "success", message: action === "delete" ? "Interface deleted through its owning spin transport." : "Interface committed through its owning spin transport." });
      return true;
    } catch (error) {
      if (mutationContext.isCurrentSessionScope?.() !== true || activeDraftKey.current !== draftKey) return false;
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      setPendingOperation((current) => current?.id === operationId ? null : current);
    }
  }

  function resetDraft(): void {
    setDraftState({ key: draftKey, value: baseDraft, baseline: baseDraft, ackRevision: null });
    setFeedback(null);
  }

  useRegisterInspectorEditSession(
    "staged",
    pending,
    dirty,
    valid,
    lockReason,
    () => run("save"),
    resetDraft,
    { historyMode: "mutation-owned" },
  );

  const patch = (value: Partial<InterfaceDraft>) => setDraftState({ key: draftKey, value: { ...draft, ...value }, baseline: draftState.key === draftKey ? draftState.baseline : baseDraft, ackRevision: draftState.key === draftKey ? draftState.ackRevision : null });
  const selectedRecord = record(selected?.interface);
  const selectedSideA = region(selectedRecord?.side_a);
  const selectedSideB = region(selectedRecord?.side_b);
  const overviewModel = buildPhysicsInspectorOverviewModel({
    family: "spin_interface",
    scope: {
      kind: selectedSideA.object && selectedSideB.object
        ? "cross_object"
        : "interface",
      sideA: selectedSideA.object,
      sideB: selectedSideB.object,
      stableRef: selected?.interface_id
        ? `interface:${selected.interface_id}`
        : "interface:new",
    },
    source: {
      id: selected?.interface_id ?? "new",
      kind: "spin_interface",
      status: readOnly ? "unsupported" : "active",
    },
    status: readOnly ? "unsupported" : "active",
  });
  return <PhysicsInspectorOverview model={overviewModel} primary={<div className="fm-inspector-panel"><InspectorGroup title="HM/FM interface">
    {!ref ? <><FormField label="Owning spin transport" type="select" value={ownerId} onChange={(event) => { setLocalOwnerId(event.target.value); setLocalInterfaceId(""); }}><option value="">Select owner</option>{(transports.data?.items ?? []).map((item, index) => { const id = record(item)?.id; return typeof id === "string" ? <option key={`${id}:${index}`} value={id}>{id}</option> : null; })}</FormField><FormField label="Interface" type="select" value={localInterfaceId} onChange={(event) => setLocalInterfaceId(event.target.value)}><option value="">New interface</option>{(projected.data?.items ?? []).filter((item) => item.owner_spin_transport_id === ownerId).map((item, index) => <option key={`${item.interface_id}:${index}`} value={item.interface_id ?? ""}>{item.interface_id ?? `Unknown ${index + 1}`}</option>)}</FormField></> : null}
    {readOnly && selected ? <><FeedbackBanner kind="warning" message="Unknown interface payload is preserved losslessly and read-only." /><FormField label="Opaque payload" type="textarea" rows={20} readOnly value={JSON.stringify(selected.interface, null, 2)} /></> : <InterfaceFields scene={geometry.data} identityReadOnly={Boolean(addressedId) || pending} draft={draft} patch={patch} />}
    {!readOnly ? <div className="fm-help-text"><div>Owner: {ownerId || "not selected"}</div><div>Qualification: {validation?.execution.qualification ?? capability?.status ?? "checking"}</div><div>{validation?.execution.reason ?? capability?.reason ?? "Capability unavailable."}</div></div> : null}
    {targetUnavailable ? <FeedbackBanner kind="error" message="Selected interface no longer exists. Its last draft is retained; refresh or select a different interface." /> : null}
    {resolved.conflicts.length ? <FeedbackBanner kind="error" message={`Conflicting fields: ${resolved.conflicts.join(", ")}. Refresh and review before rebase.`} /> : null}
    <FeedbackBanner kind={meshMessage.startsWith("Mesh verified:") ? "success" : "warning"} message={meshMessage} />
    <Button type="button" onClick={() => { projected.refetch(); transports.refetch(); meshEvidence.refetch(); }}>Refresh interface and mesh evidence</Button>
    {resolved.conflicts.length ? <Button type="button" disabled={pending} onClick={() => setDraftState({ key: draftKey, value: draft, baseline: baseDraft, ackRevision: null })}>Rebase interface draft explicitly</Button> : null}
    {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    {!readOnly ? <Button disabled={pending || !valid} onClick={() => void run("save")}>{pending ? "Committing…" : selected ? "Replace" : "Create"}</Button> : null}
    {selected && !readOnly ? <Button variant="danger" disabled={pending || !valid} onClick={() => void run("delete")}>Delete</Button> : null}
  </InspectorGroup></div>} />;
}

function InterfaceFields({ draft, scene, identityReadOnly, patch }: { scene: SceneResource | null; identityReadOnly: boolean; draft: InterfaceDraft; patch: (value: Partial<InterfaceDraft>) => void }) {
  const field = (key: keyof InterfaceDraft) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => patch({ [key]: event.target.value });
  const scope = (label: string, objectKey: keyof InterfaceDraft, regionKey: keyof InterfaceDraft) => <FormField label={label} type="select" value={JSON.stringify([draft[objectKey], draft[regionKey]])} onChange={(event) => { const [objectId, regionId] = JSON.parse(event.currentTarget.value); patch({ [objectKey]: objectId, [regionKey]: regionId }); }}>
    <option value={'["",""]'}>Select object or authored region</option>
    {transportScopeOptions(scene).map((option) => <option key={`${option.objectId}:${option.regionId}`} value={JSON.stringify([option.objectId, option.regionId])}>{option.label}</option>)}
  </FormField>;
  return <>
    <FormField label="Interface id" readOnly={identityReadOnly} value={draft.id} onChange={field("id")} />
    <FormField label="Interface model" type="select" value={draft.kind} onChange={field("kind")}><option value="transparent">Transparent</option><option value="mixing_conductance">Mixing conductance</option></FormField>
    {draft.kind === "transparent" ? <>
      {scope("Source scope", "sideAObject", "sideARegion")}
      {scope("Target scope", "sideBObject", "sideBRegion")}
      <FormField label="Source-to-target orientation" value={draft.normalAToB} onChange={field("normalAToB")} />
    </> : <>
      {scope("Normal-metal scope", "normalObject", "normalRegion")}
      {scope("Ferromagnet scope", "ferromagnetObject", "ferromagnetRegion")}
      <FormField
        label="Oriented trace pair (normal metal → ferromagnet)"
        type="select"
        value={interfaceTraceSelection(draft)}
        disabled={!canBindInterfaceTraces(draft)}
        hint="Choose explicitly to bind or replace both region traces. Axis IDs declare orientation; they do not certify a realized CAD face."
        onChange={(event) => patch(bindInterfaceTraces(draft, event.currentTarget.value))}
      >
        <option value="" disabled>No explicit trace binding</option>
        {interfaceTraceSelection(draft) === "stored" ? <option value="stored" disabled>Stored binding (review before rebind)</option> : null}
        {INTERFACE_TRACE_DIRECTIONS.map((direction) => <option key={direction.surfaceId} value={direction.surfaceId}>{direction.surfaceId + " normal-metal trace → " + direction.oppositeId + " ferromagnet trace"}</option>)}
      </FormField>
      <div className="fm-help-text" role="status">
        <div>Normal-metal scope: {draft.normalObject || "not selected"} / {draft.normalRegion || "whole object"}</div>
        <div>Ferromagnet scope: {draft.ferromagnetObject || "not selected"} / {draft.ferromagnetRegion || "whole object"}</div>
        <div>Each region is selected by its authored scope. Review scope changes before Apply; stored object references require an explicit rebind.</div>
        <div>Normal-metal trace: {draft.normalSurface ? draft.normalSurface.objectId + ":" + draft.normalSurface.surfaceId + "; outward [" + draft.normalSurface.orientation + "]" : "not bound"}</div>
        <div>Ferromagnet trace: {draft.ferromagnetSurface ? draft.ferromagnetSurface.objectId + ":" + draft.ferromagnetSurface.surfaceId + "; outward [" + draft.ferromagnetSurface.orientation + "]" : "not bound"}</div>
        {interfaceTraceSelection(draft) === "stored" ? <div>Stored references or orientations differ from the selected canonical pair. They remain unchanged until an explicit rebind or clear.</div> : null}
        <div>Declared orientation only. Geometry and mesh adjacency/orientation are NOT VERIFIED by this selection.</div>
      </div>
      <Button type="button" disabled={!draft.normalSurface && !draft.ferromagnetSurface} onClick={() => patch({ normalSurface: null, ferromagnetSurface: null })}>Clear both trace bindings</Button>
      <FormField label="Normal-to-ferromagnet orientation" readOnly={Boolean(draft.normalSurface || draft.ferromagnetSurface)} value={draft.normalToFerromagnet} hint={draft.normalSurface || draft.ferromagnetSurface ? "Rebind the pair to change its orientation, or clear both bindings to edit the legacy normal." : undefined} onChange={field("normalToFerromagnet")} />
      <FormField label="g_up" unit="S/m²" value={draft.gUp} onChange={field("gUp")} /><FormField label="g_down" unit="S/m²" value={draft.gDown} onChange={field("gDown")} />
      <FormField label="g_r" unit="S/m²" value={draft.gR} onChange={field("gR")} /><FormField label="g_i" unit="S/m²" value={draft.gI} onChange={field("gI")} />
      <FormField label="Legacy SML conductance" unit="S/m²" value={draft.gSml} onChange={field("gSml")} />
      <FormField label="SML formula version" value={draft.smlFormulaVersion} onChange={field("smlFormulaVersion")} />
      <FormField label="SML g_n" unit="S/m²" value={draft.gN} onChange={field("gN")} /><FormField label="SML g_f" unit="S/m²" value={draft.gF} onChange={field("gF")} /><FormField label="SML g_lattice" unit="S/m²" value={draft.gLattice} onChange={field("gLattice")} />
      <FormField label="Formula version" value={draft.formulaVersion} onChange={field("formulaVersion")} /><FormField label="Absorption model" value={draft.absorption} onChange={field("absorption")} />
    </>}
  </>;
}
