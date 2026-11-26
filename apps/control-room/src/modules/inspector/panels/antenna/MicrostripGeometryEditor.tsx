import { useLayoutEffect, useRef, useState } from "react";

import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { patchObjectGeometryTransaction } from "@/kernel/authoring/geometryLifecycleCommands";
import { useKernel } from "@/kernel/KernelContext";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import type { AuthoringTransactionResponse, SceneResource } from "@/kernel/api/apiTypes";
import { Button } from "@/shared/ui/Button";

import { useRegisterInspectorEditSession } from "../../InspectorEditSession";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  antennaLayoutGeometry,
  antennaLayoutDimensionDraft,
  antennaLayoutDimensionFields,
  antennaLayoutDimensionsEqual,
  buildAntennaLayoutGeometry,
  buildMicrostripCircuitPatch,
  microstripCircuitDraft,
  microstripCircuitEqual,
  microstripCircuitSourceKey,
  antennaCircuitFields,
  type MicrostripCircuitDraft,
  CPW_STATION_FIELDS,
  insertWidthStation,
  widthStationDraft,
  widthStationsEqual,
  type WidthStationDraft,
} from "./MicrostripGeometryEditorModel";

import { committedAntennaGeometryScene } from "./AntennaGeometryAcknowledgement";

interface LocalDraft {
  key: string;
  sourceGeometry: string;
  baselineDimensions: Record<string, string>;
  dimensions: Record<string, string>;
  baselineStations: WidthStationDraft[];
  stations: WidthStationDraft[];
  baselineCircuit: MicrostripCircuitDraft;
  circuit: MicrostripCircuitDraft;
}

interface Props {
  objectId: string;
  scene: SceneResource | null;
  sceneScopeKey: string | null;
  status: string;
  refetch: () => void;
}

export function MicrostripGeometryEditor({ objectId, scene, sceneScopeKey, status, refetch }: Props) {
  const { api, resources, commands, authoringHistory, selection } = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const draftKey = `${sessionScopeKey ?? "unconfirmed"}|${objectId}`;
  const [ownerState, setOwnerState] = useState({ key: draftKey, token: {} });
  const context = ownerState.key === draftKey ? ownerState : { key: draftKey, token: {} };
  if (ownerState.key !== draftKey) setOwnerState(context);
  const owner = useRef<object | null>(null);
  const inflight = useRef<{ ownerToken: object; operation: object } | null>(null);
  useLayoutEffect(() => {
    owner.current = context.token;
    return () => { owner.current = null; };
  }, [context.token]);
  const currentScene = sessionScopeKey && sceneScopeKey === sessionScopeKey ? scene : null;
  const geometry = antennaLayoutGeometry(currentScene, objectId);
  const serverDimensions = geometry ? antennaLayoutDimensionDraft(geometry) : {};
  const serverCircuit = geometry ? microstripCircuitDraft(geometry, currentScene, objectId) : { enabled: false, parameters: {}, potentialJumpV: "", sourceCutOffsetM: "", sourceCutNormal: "positive_axis" };
  const sourceGeometry = geometry ? microstripCircuitSourceKey(geometry, currentScene, objectId) : "";
  const [localState, setLocalState] = useState<LocalDraft | null>(null);
  const [pendingToken, setPendingToken] = useState<object | null>(null);
  const [feedbackState, setFeedbackState] = useState<{
    key: string;
    kind: "error" | "success";
    message: string;
  } | null>(null);
  if (localState && localState.key !== draftKey) setLocalState(null);
  const local = localState?.key === draftKey ? localState : null;
  const pending = pendingToken === context.token;
  const serverStations = geometry ? widthStationDraft(geometry, local?.stations) : [];
  const edited = Boolean(local && (!antennaLayoutDimensionsEqual(local.dimensions, local.baselineDimensions) || !widthStationsEqual(local.stations, local.baselineStations) || !microstripCircuitEqual(local.circuit, local.baselineCircuit)));
  const stations = local && (edited || local.sourceGeometry === sourceGeometry) ? local.stations : serverStations;
  const circuit = local && (edited || local.sourceGeometry === sourceGeometry) ? local.circuit : serverCircuit;
  const dimensions = local && (edited || local.sourceGeometry === sourceGeometry) ? local.dimensions : serverDimensions;
  const dirty = !antennaLayoutDimensionsEqual(dimensions, serverDimensions) || !widthStationsEqual(stations, serverStations) || !microstripCircuitEqual(circuit, serverCircuit);
  const conflict = Boolean(dirty && local?.sourceGeometry !== sourceGeometry);
  const revision = currentScene?.revision;
  const validRevision = typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
  let patchedGeometry: ReturnType<typeof buildAntennaLayoutGeometry> | null = null;
  let circuitPatch: ReturnType<typeof buildMicrostripCircuitPatch> | undefined;
  let validationError: string | undefined;
  if (geometry) {
    try {
      patchedGeometry = buildAntennaLayoutGeometry(geometry, stations, dimensions);
      if (circuit.enabled && currentScene) circuitPatch = buildMicrostripCircuitPatch(currentScene, objectId, patchedGeometry, circuit);
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error);
    }
  }
  const locked = currentScene?.objects?.find(object => object.id === objectId)?.locked === true;
  const canSave = Boolean(geometry && currentScene?.scene?.id && !locked && sessionScopeKey && status === "ready" && validRevision && dirty && !conflict && !pending && !validationError);
  const feedback = feedbackState?.key === draftKey ? feedbackState : null;

  function update(stationsValue: WidthStationDraft[], circuitValue = circuit, dimensionsValue = dimensions) {
    setLocalState({
      key: draftKey,
      sourceGeometry: local && edited ? local.sourceGeometry : sourceGeometry,
      baselineDimensions: local && edited ? local.baselineDimensions : serverDimensions,
      dimensions: dimensionsValue,
      baselineStations: local && edited ? local.baselineStations : serverStations,
      stations: stationsValue,
      baselineCircuit: local && edited ? local.baselineCircuit : serverCircuit,
      circuit: circuitValue,
    });
    setFeedbackState(null);
  }

  function updateStation(rowId: string, patch: Partial<Omit<WidthStationDraft, "rowId">>) {
    update(stations.map((station) => station.rowId === rowId ? { ...station, ...patch } : station));
  }

  function revert() {
    if (pending) return;
    setLocalState(null);
    setFeedbackState(null);
  }

  async function save(): Promise<boolean> {
    if (!geometry || !patchedGeometry || !currentScene || !canSave || !sessionScopeKey || typeof revision !== "number" || inflight.current?.ownerToken === context.token) return false;
    const operation = {};
    const ownerToken = context.token;
    const historyGeneration = authoringHistory?.getGeneration?.();
    const isCurrent = () => owner.current === ownerToken && commands.getSessionScopeKey() === sessionScopeKey &&
      (historyGeneration === undefined || authoringHistory?.getGeneration?.() === historyGeneration);
    if (!isCurrent()) return false;
    const submittedGeometry = patchedGeometry;
    const submittedCircuit = circuitPatch;
    const committedScene = (response: AuthoringTransactionResponse) =>
      committedAntennaGeometryScene(response, currentScene, objectId, submittedGeometry, submittedCircuit);
    inflight.current = { ownerToken, operation };
    setPendingToken(ownerToken);
    setFeedbackState(null);
    try {
      const response = await runAuthoringMutationWithHistory({
        api, authoringHistory, selection, resourceData: { [MODEL_SCENE_PATH]: currentScene },
        sessionScopeKey, isCurrentSessionScope: isCurrent,
      }, `Edit antenna conductor ${objectId}`, () => submittedCircuit ? api.model.commitTransaction({
        kind: "merge_patch", base_revision: revision, merge_patch: submittedCircuit,
      }, { sessionScopeKey }) : patchObjectGeometryTransaction(api, objectId, {
        base_revision: revision, geometry: submittedGeometry,
      }, { sessionScopeKey }), committedScene);
      if (!isCurrent()) return false;
      const committed = committedScene(response);
      const committedRevision = acknowledgedAuthoringSceneRevision(response);
      const committedGeometry = antennaLayoutGeometry(committed, objectId)!;
      publishCommittedSceneResource(resources, committed, committedRevision, undefined, false, sessionScopeKey, api.resourceCacheScope);
      invalidateAuthoringMutationDependents(resources, "geometry", committedRevision);
      setLocalState((current) => current?.key === draftKey ? {
        ...current,
        sourceGeometry: microstripCircuitSourceKey(committedGeometry, committed, objectId),
        baselineCircuit: microstripCircuitDraft(committedGeometry, committed, objectId),
        baselineDimensions: antennaLayoutDimensionDraft(committedGeometry),
        baselineStations: widthStationDraft(committedGeometry),
      } : current);
      setFeedbackState({ key: draftKey, kind: "success", message: "Conductor authoring committed. Rebuild the conductor mesh and prepare the source before solving." });
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      refetch();
      setFeedbackState({ key: draftKey, kind: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      if (inflight.current?.operation === operation) inflight.current = null;
      setPendingToken((current) => current === ownerToken ? null : current);
    }
  }

  useRegisterInspectorEditSession(geometry ? "staged" : null, pending, dirty, Boolean(canSave), locked ? "Unlock the antenna before editing its conductor." : undefined,
    save, revert, { historyMode: "mutation-owned", applyBlockReason: conflict
      ? "Rebase conductor authoring against the current scene." : validationError });

  if (!geometry) return null;
  const isCpw = geometry.geometry_kind === "CPWAntennaLayout";
  const cutAxis = isCpw ? "x" : "z";

  return <InspectorGroup title={geometry.geometry_kind === "CPWAntennaLayout" ? "CPW conductor geometry" : "Microstrip conductor geometry"} collapsible defaultOpen>
    <FeedbackBanner kind="warning" message="Station widths and gaps are 3D conductor dimensions. Changes invalidate the existing conductor mesh and field basis." />
    {antennaLayoutDimensionFields(geometry).map(({ parameter, label }) => <FormField inline={false} key={parameter}
      label={label} unit="m" value={dimensions[parameter] ?? ""}
      hint={parameter === "return_offset_m" ? "Signal/return offset; non-negative. A closed circuit also requires a source cut inside the clearance." : "Positive local conductor dimension before object placement."}
      onChange={(event) => update(stations, circuit, { ...dimensions, [parameter]: event.currentTarget.value })} />)}
    {stations.map((station, index) => <div className="fm-microstrip-station" key={station.rowId}>
      <FormField inline={false}
        label={`Station ${index + 1} position`}
        hint="Normalized position along conductor length, s ∈ [0, 1]."
        value={station.s}
        disabled={index === 0 || index === stations.length - 1}
        onChange={(event) => updateStation(station.rowId, { s: event.currentTarget.value })}
      />
      <FormField inline={false}
        label={`Station ${index + 1} signal width`}
        unit="m"
        value={station.signalWidthM}
        onChange={(event) => updateStation(station.rowId, { signalWidthM: event.currentTarget.value })}
      />
      {geometry.geometry_kind === "CPWAntennaLayout" ? CPW_STATION_FIELDS.map((field) => <FormField inline={false}
        key={field.key}
        label={`Station ${index + 1} ${field.label}`}
        unit="m"
        value={station[field.key] ?? ""}
        onChange={(event) => updateStation(station.rowId, { [field.key]: event.currentTarget.value })}
      />) : null}
      {index > 0 && index < stations.length - 1 ? <Button type="button" onClick={() => update(stations.filter((current) => current.rowId !== station.rowId))}>Remove station {index + 1}</Button> : null}
    </div>)}
    <>
      <FormField inline={false} type="checkbox" label="Full 3D conducting circuit" checked={circuit.enabled}
        disabled={serverCircuit.enabled}
        hint={isCpw ? "Connect signal and both grounds at each end. A committed closed circuit requires an explicit source migration to reopen." : "Preserve signal and broad return; connect both ends with conducting bridges. A committed closed circuit requires an explicit terminal-source migration to reopen."}
        onChange={(event) => update(stations, { ...circuit, enabled: event.currentTarget.checked })} />
      {circuit.enabled ? <>
        <FeedbackBanner kind="warning" message="Both connections close the conducting loop. Voltage is applied across the inlet connection; port branches observe the resulting current. Computed fields require a new solve and scientific qualification." />
        <fieldset className="fm-antenna-circuit-part">
          <legend>Voltage source</legend>
          <FormField inline={false} label="Inlet source-cut potential jump" unit="V" value={circuit.potentialJumpV}
            hint="V⁺ − V⁻ across the inlet source cut, oriented by the selected normal."
            onChange={(event) => update(stations, { ...circuit, potentialJumpV: event.currentTarget.value })} />
          <FormField inline={false} label={`Inlet source-cut local ${cutAxis} offset`} unit="m" value={circuit.sourceCutOffsetM}
            hint={isCpw ? "Object-local x; strictly between −inlet length + crossbar length and 0, inside the central feed neck." : "Object-local z; strictly inside the signal/return clearance. A new cut starts at the clearance midpoint."}
            onChange={(event) => update(stations, { ...circuit, sourceCutOffsetM: event.currentTarget.value })} />
          <FormField inline={false} type="select" label="Inlet source-cut normal" value={circuit.sourceCutNormal}
            hint="The normal defines the plus/minus sides of the potential jump."
            onChange={(event) => update(stations, { ...circuit, sourceCutNormal: event.currentTarget.value })}>
            <option value="positive_axis">Positive local {cutAxis}</option>
            <option value="negative_axis">Negative local {cutAxis}</option>
          </FormField>
        </fieldset>
        {(["inlet", "outlet"] as const).map(end => <fieldset className="fm-antenna-circuit-part" key={end}>
          <legend>{end === "inlet" ? "Inlet connection" : "Outlet connection"}</legend>
          <p className="fm-inspector-hint">{isCpw
            ? "Three feed necks join one transverse crossbar. The inlet source cut lies in the central neck; the solve determines both return currents."
            : end === "inlet" ? "Connects signal to the broad return and contains the voltage-source cut."
              : "Closes the opposite end between signal and the broad return."}</p>
          {antennaCircuitFields(geometry).map(field => field.key.startsWith(`${end}_`) ? <FormField inline={false} key={field.key} label={field.label} unit={field.unit}
            value={circuit.parameters[field.key] ?? ""}
            onChange={(event) => update(stations, { ...circuit, parameters: { ...circuit.parameters, [field.key]: event.currentTarget.value } })} /> : null)}
        </fieldset>)}
      </> : null}
    </>
    {conflict ? <FeedbackBanner kind="error" message="Conductor geometry changed on the server. Review the current conductor dimensions and stations, then explicitly rebase your draft before saving." /> : null}
    {dirty && validationError ? <FeedbackBanner kind="error" message={validationError} /> : null}
    {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    <div className="fm-microstrip-station-actions">
      <Button type="button" onClick={() => update(insertWidthStation(stations, `draft:${crypto.randomUUID()}`))}>Add station</Button>
      {dirty ? <Button type="button" disabled={pending} onClick={revert}>Revert draft</Button> : null}
      {conflict ? <Button type="button" disabled={pending} onClick={() => setLocalState({ key: draftKey, sourceGeometry, baselineDimensions: serverDimensions, dimensions, baselineStations: serverStations, stations, baselineCircuit: serverCircuit, circuit })}>Rebase draft</Button> : null}
      {conflict || feedback?.message.includes("revision") ? <Button type="button" onClick={refetch}>Refetch Scene</Button> : null}
      <Button type="button" disabled={!canSave} onClick={() => void save()}>Save conductor authoring</Button>
    </div>
  </InspectorGroup>;
}
