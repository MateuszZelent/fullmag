import { useState } from "react";

import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import { patchObjectGeometryTransaction } from "@/kernel/authoring/geometryLifecycleCommands";
import { useKernel } from "@/kernel/KernelContext";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import type { SceneResource } from "@/kernel/api/apiTypes";
import { Button } from "@/shared/ui/Button";

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
  MICROSTRIP_LOOP_FIELDS,
  type MicrostripCircuitDraft,
  CPW_STATION_FIELDS,
  insertWidthStation,
  widthStationDraft,
  widthStationsEqual,
  type WidthStationDraft,
} from "./MicrostripGeometryEditorModel";

import { antennaGeometryAcknowledgementError } from "./AntennaGeometryAcknowledgement";

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
  status: string;
  refetch: () => void;
}

export function MicrostripGeometryEditor({ objectId, scene, status, refetch }: Props) {
  const { api, resources } = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const draftKey = `${sessionScopeKey ?? "unconfirmed"}|${objectId}`;
  const geometry = antennaLayoutGeometry(scene, objectId);
  const serverDimensions = geometry ? antennaLayoutDimensionDraft(geometry) : {};
  const serverCircuit = geometry ? microstripCircuitDraft(geometry, scene, objectId) : { enabled: false, parameters: {}, potentialJumpV: "" };
  const sourceGeometry = geometry ? microstripCircuitSourceKey(geometry, scene, objectId) : "";
  const [localState, setLocalState] = useState<LocalDraft | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [feedbackState, setFeedbackState] = useState<{
    key: string;
    kind: "error" | "success";
    message: string;
  } | null>(null);
  if (localState && localState.key !== draftKey) setLocalState(null);
  const local = localState?.key === draftKey ? localState : null;
  const pending = pendingKey === draftKey;
  const serverStations = geometry ? widthStationDraft(geometry, local?.stations) : [];
  const edited = Boolean(local && (!antennaLayoutDimensionsEqual(local.dimensions, local.baselineDimensions) || !widthStationsEqual(local.stations, local.baselineStations) || !microstripCircuitEqual(local.circuit, local.baselineCircuit)));
  const stations = local && (edited || local.sourceGeometry === sourceGeometry) ? local.stations : serverStations;
  const circuit = local && (edited || local.sourceGeometry === sourceGeometry) ? local.circuit : serverCircuit;
  const dimensions = local && (edited || local.sourceGeometry === sourceGeometry) ? local.dimensions : serverDimensions;
  const dirty = !antennaLayoutDimensionsEqual(dimensions, serverDimensions) || !widthStationsEqual(stations, serverStations) || !microstripCircuitEqual(circuit, serverCircuit);
  const conflict = Boolean(dirty && local?.sourceGeometry !== sourceGeometry);
  const revision = scene?.revision;
  const validRevision = typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
  const canSave = Boolean(geometry && sessionScopeKey && status === "ready" && validRevision && dirty && !conflict && !pending);
  const feedback = feedbackState?.key === draftKey ? feedbackState : null;

  if (!geometry) return null;

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

  async function save() {
    if (!geometry || !canSave || !sessionScopeKey || typeof revision !== "number") return;
    let patchedGeometry;
    let circuitPatch;
    try {
      patchedGeometry = buildAntennaLayoutGeometry(geometry, stations, dimensions);
      if (circuit.enabled && scene) circuitPatch = buildMicrostripCircuitPatch(scene, objectId, patchedGeometry, circuit);
    } catch (error) {
      setFeedbackState({ key: draftKey, kind: "error", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    setPendingKey(draftKey);
    setFeedbackState(null);
    try {
      const response = circuitPatch ? await api.model.commitTransaction({
        kind: "merge_patch", base_revision: revision, merge_patch: circuitPatch,
      }, { sessionScopeKey }) : await patchObjectGeometryTransaction(api, objectId, {
        base_revision: revision,
        geometry: patchedGeometry,
      }, { sessionScopeKey });
      const committedRevision = acknowledgedAuthoringSceneRevision(response);
      const committedGeometry = antennaLayoutGeometry(response.committed_scene, objectId);
      if (!committedGeometry || committedGeometry.geometry_kind !== geometry.geometry_kind) {
        refetch();
        throw new Error("Geometry ACK omitted the matching antenna layout. Refetch before saving again.");
      }
      const acknowledgementError = antennaGeometryAcknowledgementError(response.committed_scene, objectId, patchedGeometry, circuitPatch);
      if (acknowledgementError) {
        refetch();
        throw new Error(acknowledgementError);
      }
      publishCommittedSceneResource(resources, response.committed_scene, committedRevision, undefined, false, sessionScopeKey, api.resourceCacheScope);
      invalidateAuthoringMutationDependents(resources, "geometry", committedRevision);
      setLocalState((current) => current?.key === draftKey ? {
        ...current,
        sourceGeometry: microstripCircuitSourceKey(committedGeometry, response.committed_scene, objectId),
        baselineCircuit: microstripCircuitDraft(committedGeometry, response.committed_scene, objectId),
        baselineDimensions: antennaLayoutDimensionDraft(committedGeometry),
        baselineStations: widthStationDraft(committedGeometry),
      } : current);
      setFeedbackState({ key: draftKey, kind: "success", message: "Conductor authoring committed. Rebuild the conductor mesh and prepare the source before solving." });
    } catch (error) {
      if ((error as { status?: number })?.status === 409) refetch();
      setFeedbackState({ key: draftKey, kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPendingKey((current) => current === draftKey ? null : current);
    }
  }

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
    {geometry.geometry_kind === "MicrostripAntennaLayout" ? <>
      <FormField inline={false} type="checkbox" label="Full 3D conducting circuit" checked={circuit.enabled}
        disabled={serverCircuit.enabled}
        hint="Preserve signal and broad return; connect both ends with conducting bridges. A committed closed circuit requires an explicit terminal-source migration to reopen."
        onChange={(event) => update(stations, { ...circuit, enabled: event.currentTarget.checked })} />
      {circuit.enabled ? <>
        <FeedbackBanner kind="warning" message="Both connections close the conducting loop. Voltage is applied across the inlet connection; port branches observe the resulting current. Computed fields require a new solve and scientific qualification." />
        <fieldset className="fm-antenna-circuit-part">
          <legend>Voltage source</legend>
          <FormField inline={false} label="Inlet source-cut potential jump" unit="V" value={circuit.potentialJumpV}
            hint="V⁺ − V⁻ in the object-local z frame. A new cut uses the positive-axis normal at the clearance center; an existing cut keeps its plane and normal."
            onChange={(event) => update(stations, { ...circuit, potentialJumpV: event.currentTarget.value })} />
        </fieldset>
        {(["inlet", "outlet"] as const).map(end => <fieldset className="fm-antenna-circuit-part" key={end}>
          <legend>{end === "inlet" ? "Inlet connection" : "Outlet connection"}</legend>
          <p className="fm-inspector-hint">{end === "inlet" ? "Connects signal to the broad return and contains the voltage-source cut."
            : "Closes the opposite end between signal and the broad return."}</p>
          {MICROSTRIP_LOOP_FIELDS.filter(field => field.key.startsWith(`${end}_`)).map(field => <FormField inline={false} key={field.key} label={field.label} unit={field.unit}
            value={circuit.parameters[field.key] ?? ""}
            onChange={(event) => update(stations, { ...circuit, parameters: { ...circuit.parameters, [field.key]: event.currentTarget.value } })} />)}
        </fieldset>)}
      </> : null}
    </> : null}
    {conflict ? <FeedbackBanner kind="error" message="Conductor geometry changed on the server. Review the current conductor dimensions and stations, then explicitly rebase your draft before saving." /> : null}
    {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    <div className="fm-microstrip-station-actions">
      <Button type="button" onClick={() => update(insertWidthStation(stations, `draft:${crypto.randomUUID()}`))}>Add station</Button>
      {dirty ? <Button type="button" onClick={() => setLocalState(null)}>Revert draft</Button> : null}
      {conflict ? <Button type="button" onClick={() => setLocalState({ key: draftKey, sourceGeometry, baselineDimensions: serverDimensions, dimensions, baselineStations: serverStations, stations, baselineCircuit: serverCircuit, circuit })}>Rebase draft</Button> : null}
      {conflict || feedback?.message.includes("revision") ? <Button type="button" onClick={refetch}>Refetch Scene</Button> : null}
      <Button type="button" disabled={!canSave} onClick={() => void save()}>Save conductor authoring</Button>
    </div>
  </InspectorGroup>;
}
