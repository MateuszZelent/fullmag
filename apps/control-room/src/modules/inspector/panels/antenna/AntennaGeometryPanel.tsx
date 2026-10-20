"use client";

import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { AntennaPlacementEditor } from "./AntennaPlacementEditor";
import { MicrostripGeometryEditor } from "./MicrostripGeometryEditor";

function dimensions(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function length(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Unavailable";
  const magnitude = Math.abs(value);
  const [scale, unit]: [number, string] = magnitude > 0 && magnitude < 1e-6 ? [1e-9, "nm"]
    : magnitude > 0 && magnitude < 1e-3 ? [1e-6, "µm"]
      : magnitude > 0 && magnitude < 1 ? [1e-3, "mm"] : [1, "m"];
  return `${new Intl.NumberFormat("en", { maximumSignificantDigits: 4 }).format(value / scale)} ${unit}`;
}

function signalWidthRange(stations: unknown[]): string {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const station of stations) {
    const width = dimensions(station)?.signal_width_m;
    if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return "Unavailable";
    minimum = Math.min(minimum, width);
    maximum = Math.max(maximum, width);
  }
  if (!Number.isFinite(minimum)) return "Unavailable";
  return minimum === maximum ? length(minimum) : `${length(minimum)} – ${length(maximum)}`;
}

export function AntennaGeometryPanel({ selection }: InspectorPanelProps) {
  const scene = useSceneResource();
  const objectId = selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId;
  const object = scene.data?.objects?.find((candidate) => candidate.id === objectId);
  const geometry = dimensions(object?.geometry);
  const params = dimensions(geometry?.geometry_params);
  const stations = Array.isArray(params?.stations) ? params.stations : [];
  const isCpw = geometry?.geometry_kind === "CPWAntennaLayout";
  const closedLoop = !isCpw && dimensions(params?.loop)?.enabled === true;
  return <div className="fm-inspector-panel" data-inspector-owner="object.antenna.geometry">
    {scene.error ? <FeedbackBanner kind="error" message={scene.error.message} />
      : !scene.data ? <p role="status">Loading antenna scene…</p>
        : !object ? <FeedbackBanner kind="warning" message="Selected antenna is absent from the current scene." /> : null}
    <InspectorGroup title="Antenna geometry" description="Authored conductor geometry and placement; not a computed field or solver mesh.">
      <p>{isCpw
        ? "CPW consists of a signal strip and two coplanar return strips separated by gaps. Width and gap stations define the actual conductor preview."
        : geometry?.geometry_kind === "MicrostripAntennaLayout"
          ? "Microstrip consists of a narrow signal strip above a wider return conductor. The wide plate is part of the authored geometry, not an antenna bounding box."
          : "Inspect the authored geometry descriptor; the object name does not determine its physical shape."}</p>
    </InspectorGroup>
    {object && params && (isCpw || geometry?.geometry_kind === "MicrostripAntennaLayout") ? <InspectorGroup title="Authored dimensions" badge={isCpw ? "CPW" : "Microstrip"}
      description="Local conductor dimensions before object placement. Material and transport are configured under Conductor.">
      <FieldRow label="Length" value={length(params.length_m)} />
      <FieldRow label="Thickness" value={length(params.thickness_m)} />
      <FieldRow label="Signal width range" value={signalWidthRange(stations)} />
      {!isCpw ? <>
        <FieldRow label="Return width" value={length(params.return_width_m)} />
        <FieldRow label="Return offset" value={length(params.return_offset_m)} />
      </> : null}
      <FieldRow label="Width stations" value={stations.length.toLocaleString()} />
      {!isCpw ? <FieldRow label="Circuit geometry" value={closedLoop ? "Closed 3D loop" : "No end connections"} /> : null}
      <FieldRow label="Parts" value={isCpw ? "Signal · left return · right return"
        : closedLoop ? "Signal · wide return · inlet connection · outlet connection" : "Signal · wide return"} />
    </InspectorGroup> : null}
    {objectId ? <>
      <MicrostripGeometryEditor key={`geometry:${objectId}`} objectId={objectId} scene={scene.data} status={scene.status} refetch={scene.refetch} />
      <AntennaPlacementEditor key={`placement:${objectId}`} objectId={objectId} scene={scene.data} sceneScopeKey={scene.sessionScopeKey} status={scene.status} refetch={scene.refetch} />
    </> : null}
  </div>;
}
