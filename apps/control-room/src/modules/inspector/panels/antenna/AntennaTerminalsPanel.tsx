"use client";

import { useLayoutEffect, useRef, useState } from "react";

import type { AuthoringTransactionResponse, SceneResource } from "@/kernel/api/apiTypes";
import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { antennaTerminalSourceState } from "./AntennaTerminalSourceModel";
import { AntennaTerminalSourceDetails } from "./AntennaTerminalSourceDetails";
import { committedAntennaTransactionScene } from "./AntennaTransactionAcknowledgement";
import { useKernel } from "@/kernel/KernelContext";
import { useSceneResource, publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { antennaInspectionValidationMessages } from "@/shared/domain/physics/antennaStageValidation";
import { Button } from "@/shared/ui/Button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

import { useRegisterInspectorEditSession } from "../../InspectorEditSession";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  acknowledgeAntennaTerminalPreparationDraft, antennaTerminalGeometryBinding, antennaTerminalPreparationErrors,
  buildAntennaTerminalPreparationTransaction, createAntennaTerminalPreparationDraft,
  type AntennaTerminalPreparationDraft, type AntennaTerminalLeadRow,
} from "./AntennaTerminalPreparationModel";

export function AntennaTerminalsPanel({ selection: selected }: InspectorPanelProps) {
  const scene = useSceneResource();
  const { api, resources, commands, authoringHistory, selection } = useKernel();
  const identity = useSessionResourceIdentity();
  const scope = sessionRequestScopeKey(identity);
  const objectId = selected.ref?.type === "scene-object" ? selected.ref.objectId : selected.objectId ?? "";
  const sourceModel = antennaTerminalSourceState(scene.data, objectId);
  const preparationAllowed = sourceModel.mode === "preparation";
  const key = JSON.stringify([scope, objectId, sourceModel.mode]);
  const [contextState, setContext] = useState({ key, token: {} });
  const context = contextState.key === key ? contextState : { key, token: {} };
  if (contextState.key !== key) setContext(context);
  const [draftState, setDraft] = useState<AntennaTerminalPreparationDraft | null>(null);
  if (draftState && draftState.key !== key) setDraft(null);
  const draft = draftState?.key === key ? draftState : null;
  const [pendingState, setPending] = useState<object | null>(null);
  const pending = pendingState === context.token;
  const [feedback, setFeedback] = useState<{ key: string; kind: "error" | "success"; message: string } | null>(null);
  const owner = useRef<object | null>(null);
  const inflight = useRef<object | null>(null);
  useLayoutEffect(() => { owner.current = context.token; return () => { owner.current = null; }; }, [context.token]);
  const object = scene.data?.objects?.find((item) => item.id === objectId);
  const ports = (scene.data?.antenna_port_modes ?? []).filter((port) => port.source_object_id === objectId);
  const current = Boolean(scope && scene.data?.scene?.id && scene.sessionScopeKey === scope && object && commands.getSessionScopeKey() === scope);
  const editable = preparationAllowed && current && !object?.locked;
  const errors = draft && scene.data ? antennaTerminalPreparationErrors(scene.data, objectId, draft) : ["Choose a port and load its terminal surfaces."];
  const canApply = Boolean(editable && scene.status === "ready" && draft?.dirty && !pending && errors.length === 0);

  function load(portId: string) {
    if (!scene.data || !editable || pending) return;
    try {
      setDraft(createAntennaTerminalPreparationDraft(scene.data, objectId, portId, key));
      setFeedback(null);
    } catch (error) {
      setFeedback({ key, kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
  function updateRow(index: number, patch: Partial<AntennaTerminalLeadRow>) {
    if (!editable) return;
    setDraft((current) => current?.key === key ? { ...current, dirty: true, rows: current.rows.map((row, ordinal) => ordinal === index ? { ...row, ...patch } : row) } : current);
    setFeedback(null);
  }

  async function apply(): Promise<boolean> {
    if (!canApply || !draft || !scene.data || !scope || inflight.current === context.token) return false;
    const submitted = draft;
    const sourceScene = scene.data;
    const ownerToken = context.token;
    const historyGeneration = authoringHistory?.getGeneration?.();
    const isCurrent = () => owner.current === ownerToken && commands.getSessionScopeKey() === scope &&
      (historyGeneration === undefined || authoringHistory?.getGeneration?.() === historyGeneration);
    inflight.current = ownerToken;
    setPending(ownerToken);
    setFeedback(null);
    try {
      const request = await buildAntennaTerminalPreparationTransaction(sourceScene, objectId, submitted);
      if (!isCurrent()) return false;
      function validateCommittedScene(response: AuthoringTransactionResponse): SceneResource {
        const committed = committedAntennaTransactionScene(response, request, sourceScene.scene?.id ?? "");
        if (antennaTerminalGeometryBinding(committed, objectId) !== submitted.geometryBinding) {
          throw new Error("Terminal preparation ACK changed the source geometry. Refresh before retrying.");
        }
        return committed;
      }
      const response = await runAuthoringMutationWithHistory({
        api, authoringHistory, selection, resourceData: { [MODEL_SCENE_PATH]: sourceScene },
        sessionScopeKey: scope, isCurrentSessionScope: isCurrent,
      }, `Edit antenna terminal preparation ${objectId}`, () => api.model.commitTransaction(request, { sessionScopeKey: scope }), validateCommittedScene);
      if (!isCurrent()) return false;
      const committed = validateCommittedScene(response);
      publishCommittedSceneResource(resources, committed, response.scene_revision, undefined, false, scope, api.resourceCacheScope);
      invalidateAuthoringMutationDependents(resources, "interaction", response.scene_revision);
      setDraft((current) => acknowledgeAntennaTerminalPreparationDraft(current, submitted, response.scene_revision));
      setFeedback({ key, kind: "success", message: "Inspection preparation committed. Actual surfaces, topology, signed component balance and world normals still require mesh materialization. Basis, FFT and LLG remain blocked." });
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      scene.refetch();
      setFeedback({ key, kind: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      if (inflight.current === ownerToken) inflight.current = null;
      setPending((current) => current === ownerToken ? null : current);
    }
  }
  useRegisterInspectorEditSession("staged", pending, preparationAllowed && Boolean(draft?.dirty), editable && scene.status === "ready" && errors.length === 0, undefined,
    apply, () => setDraft(null), { historyMode: "mutation-owned", applyBlockReason: errors[0] });

  function openSourceDetail(portId?: string) {
    if (!current || commands.getSessionScopeKey() !== scope) return;
    const kind = portId ? "object.antenna.port" as const : "object.antenna.geometry" as const;
    const nodeId = portId ? `model:object:${objectId}:antenna:port:${encodeURIComponent(portId)}` : `model:object:${objectId}:geometry`;
    selection.set({ kind, objectId, nodeId, label: portId ? `Port ${portId}` : "Geometry",
      ref: { type: "scene-object", kind, objectId, nodeId, visualizationTargetId: `object:${objectId}`,
        ...(portId ? { antennaResourceKind: "port" as const, antennaResourceId: portId } : {}) } }, "inspector");
  }

  if (!preparationAllowed) return <div className="fm-inspector-panel" data-inspector-owner="object.antenna.terminals">
    <AntennaTerminalSourceDetails model={sourceModel} current={current} onGeometry={() => openSourceDetail()} onPort={openSourceDetail} />
    {scene.error ? <FeedbackBanner kind="error" message={scene.error.message} /> : null}
    <Button type="button" onClick={scene.refetch}>Refresh scene</Button>
  </div>;

  return <div className="fm-inspector-panel" data-inspector-owner="object.antenna.terminals">
    <InspectorGroup title="Antenna terminals and external actuators" description="Explicit straight-stub preparation for raw inspection; not a complete qualified circuit." defaultOpen>
      <FeedbackBanner kind="warning" message="Inspection only · external_electrode_truncation. Feed and the omitted external circuit are not qualified. This preparation cannot supply a field basis, source FFT or LLG drive." />
      <p className="fm-inspector-hint">Apply replaces this transport&apos;s legacy boundary conditions and view reference with explicit current-driven preparation. Geometry and port weights are preserved. Directions are world-space outward unit vectors; no orientation is inferred from a transformed preview.</p>
      <Select value={draft?.portId ?? ""} disabled={!editable || pending || Boolean(draft?.dirty)} onValueChange={load}>
        <SelectTrigger aria-label="Terminal preparation port"><SelectValue placeholder="Select port and load caps" /></SelectTrigger>
        <SelectContent>{ports.map((port) => <SelectItem key={port.id} value={port.id}>{port.id}</SelectItem>)}</SelectContent>
      </Select>
      {draft ? <>
        <FormField label="Drive ID" value={draft.driveId} disabled={!editable} onChange={(event) => { const value = event.currentTarget.value; setDraft((current) => current?.key === key ? { ...current, driveId: value, dirty: true } : current); }} />
        <FormField label="Preparation revision" value={draft.revision} disabled={!editable} onChange={(event) => { const value = event.currentTarget.value; setDraft((current) => current?.key === key ? { ...current, revision: value, dirty: true } : current); }} />
        {draft.rows.map((row, index) => <InspectorGroup key={row.observationId} title={`${row.conductorId} · ${row.selector}`} collapsible defaultOpen>
          <FieldRow label="Port observation (not actuator)" value={row.observationId} mono />
          <FieldRow label="Authored end-cap selector" value={`antenna_terminal:${row.conductorId}:${row.selector}`} mono />
          <FormField label="External actuator ID" value={row.actuatorId} disabled={!editable} onChange={(event) => updateRow(index, { actuatorId: event.currentTarget.value })} />
          <FormField label="Lead length" unit="m" value={row.lengthM} disabled={!editable} onChange={(event) => updateRow(index, { lengthM: event.currentTarget.value })} />
          <FormField label="Lead conductivity" unit="S/m" value={row.conductivitySpm} disabled={!editable} onChange={(event) => updateRow(index, { conductivitySpm: event.currentTarget.value })} />
          <FormField label="Extrusion layers" value={row.layers} disabled={!editable} onChange={(event) => updateRow(index, { layers: event.currentTarget.value })} />
          {(["x", "y", "z"] as const).map((axis, component) => <FormField key={axis} label={`World outward direction ${axis}`} value={row.direction[component]} disabled={!editable} onChange={(event) => { const direction = [...row.direction] as [string, string, string]; direction[component] = event.currentTarget.value; updateRow(index, { direction }); }} />)}
          <FormField label="Signed outward actuator current" unit="A" hint="Positive leaves the outer electrode; negative enters. Enter each current explicitly; port weights are not an actuation law." value={row.currentA} disabled={!editable} onChange={(event) => updateRow(index, { currentA: event.currentTarget.value })} />
        </InspectorGroup>)}
      </> : null}
      {(scene.data?.antenna_field_solve_stages ?? []).filter((stage) => stage.source_object_id === objectId).map((stage) => <FieldRow key={stage.id} label={`Inspection readiness · ${stage.id}`} value={antennaInspectionValidationMessages(stage, scene.data).join(" · ")} />)}
      {errors.length ? <FeedbackBanner kind="warning" message={errors[0]} /> : null}
      {scene.error ? <FeedbackBanner kind="error" message={scene.error.message} /> : null}
      {feedback?.key === key ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
      <div className="fm-microstrip-station-actions">
        <Button type="button" onClick={scene.refetch}>Refresh scene</Button>
        {draft ? <Button type="button" disabled={pending} onClick={() => setDraft(null)}>Reset terminal draft</Button> : null}
        <Button type="button" disabled={!canApply} onClick={() => void apply()}>Apply inspection preparation</Button>
      </div>
    </InspectorGroup>
  </div>;
}
