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
  buildAntennaLayoutGeometry,
  CPW_STATION_FIELDS,
  insertWidthStation,
  widthStationDraft,
  widthStationsEqual,
  type WidthStationDraft,
} from "./MicrostripGeometryEditorModel";

interface LocalDraft {
  key: string;
  sourceGeometry: string;
  baselineStations: WidthStationDraft[];
  stations: WidthStationDraft[];
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
  const sourceGeometry = geometry ? JSON.stringify(geometry) : "";
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
  const edited = Boolean(local && !widthStationsEqual(local.stations, local.baselineStations));
  const stations = local && (edited || local.sourceGeometry === sourceGeometry) ? local.stations : serverStations;
  const dirty = !widthStationsEqual(stations, serverStations);
  const conflict = Boolean(dirty && local?.sourceGeometry !== sourceGeometry);
  const revision = scene?.revision;
  const validRevision = typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
  const canSave = Boolean(geometry && sessionScopeKey && status === "ready" && validRevision && dirty && !conflict && !pending);
  const feedback = feedbackState?.key === draftKey ? feedbackState : null;

  if (!geometry) return null;

  function update(stationsValue: WidthStationDraft[]) {
    setLocalState({
      key: draftKey,
      sourceGeometry: local && edited ? local.sourceGeometry : sourceGeometry,
      baselineStations: local && edited ? local.baselineStations : serverStations,
      stations: stationsValue,
    });
    setFeedbackState(null);
  }

  function updateStation(rowId: string, patch: Partial<Omit<WidthStationDraft, "rowId">>) {
    update(stations.map((station) => station.rowId === rowId ? { ...station, ...patch } : station));
  }

  async function save() {
    if (!geometry || !canSave || !sessionScopeKey || typeof revision !== "number") return;
    let patchedGeometry;
    try {
      patchedGeometry = buildAntennaLayoutGeometry(geometry, stations);
    } catch (error) {
      setFeedbackState({ key: draftKey, kind: "error", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    setPendingKey(draftKey);
    setFeedbackState(null);
    try {
      const response = await patchObjectGeometryTransaction(api, objectId, {
        base_revision: revision,
        geometry: patchedGeometry,
      }, { sessionScopeKey });
      const committedRevision = acknowledgedAuthoringSceneRevision(response);
      const committedGeometry = antennaLayoutGeometry(response.committed_scene, objectId);
      if (!committedGeometry || committedGeometry.geometry_kind !== geometry.geometry_kind) {
        refetch();
        throw new Error("Geometry ACK omitted the matching antenna layout. Refetch before saving again.");
      }
      publishCommittedSceneResource(resources, response.committed_scene, committedRevision, undefined, false, sessionScopeKey, api.resourceCacheScope);
      invalidateAuthoringMutationDependents(resources, "geometry", committedRevision);
      setLocalState((current) => current?.key === draftKey ? {
        ...current,
        sourceGeometry: JSON.stringify(committedGeometry),
        baselineStations: widthStationDraft(committedGeometry),
      } : current);
      setFeedbackState({ key: draftKey, kind: "success", message: "Width stations committed. Rebuild the conductor mesh before solving." });
    } catch (error) {
      if ((error as { status?: number })?.status === 409) refetch();
      setFeedbackState({ key: draftKey, kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPendingKey((current) => current === draftKey ? null : current);
    }
  }

  return <InspectorGroup title={geometry.geometry_kind === "CPWAntennaLayout" ? "CPW width stations" : "Microstrip width stations"} collapsible defaultOpen>
    <FeedbackBanner kind="warning" message="Station widths and gaps are 3D conductor dimensions. Changes invalidate the existing conductor mesh and field basis." />
    {stations.map((station, index) => <div className="fm-microstrip-station" key={station.rowId}>
      <FormField
        label={`Station ${index + 1} position`}
        hint="Normalized position along conductor length, s ∈ [0, 1]."
        value={station.s}
        disabled={index === 0 || index === stations.length - 1}
        onChange={(event) => updateStation(station.rowId, { s: event.currentTarget.value })}
      />
      <FormField
        label={`Station ${index + 1} signal width`}
        unit="m"
        value={station.signalWidthM}
        onChange={(event) => updateStation(station.rowId, { signalWidthM: event.currentTarget.value })}
      />
      {geometry.geometry_kind === "CPWAntennaLayout" ? CPW_STATION_FIELDS.map((field) => <FormField
        key={field.key}
        label={`Station ${index + 1} ${field.label}`}
        unit="m"
        value={station[field.key] ?? ""}
        onChange={(event) => updateStation(station.rowId, { [field.key]: event.currentTarget.value })}
      />) : null}
      {index > 0 && index < stations.length - 1 ? <Button type="button" onClick={() => update(stations.filter((current) => current.rowId !== station.rowId))}>Remove station {index + 1}</Button> : null}
    </div>)}
    {conflict ? <FeedbackBanner kind="error" message="Conductor geometry changed on the server. Review the current stations and explicitly rebase your draft before saving." /> : null}
    {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    <div className="fm-microstrip-station-actions">
      <Button type="button" onClick={() => update(insertWidthStation(stations, `draft:${crypto.randomUUID()}`))}>Add station</Button>
      {dirty ? <Button type="button" onClick={() => setLocalState(null)}>Revert draft</Button> : null}
      {conflict ? <Button type="button" onClick={() => setLocalState({ key: draftKey, sourceGeometry, baselineStations: serverStations, stations })}>Rebase draft</Button> : null}
      {conflict || feedback?.message.includes("revision") ? <Button type="button" onClick={refetch}>Refetch Scene</Button> : null}
      <Button type="button" disabled={!canSave} onClick={() => void save()}>Save width stations</Button>
    </div>
  </InspectorGroup>;
}
