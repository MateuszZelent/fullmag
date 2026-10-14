"use client";

import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { AntennaConductorDetails } from "./AntennaCompositionPanels";
import { AntennaPlacementEditor } from "./AntennaPlacementEditor";
import { MicrostripGeometryEditor } from "./MicrostripGeometryEditor";

export function AntennaGeometryPanel({ selection }: InspectorPanelProps) {
  const scene = useSceneResource();
  const objectId = selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId;
  const object = scene.data?.objects?.find((candidate) => candidate.id === objectId);
  const geometry = object?.geometry as { geometry_kind?: string } | undefined;
  const isCpw = geometry?.geometry_kind === "CPWAntennaLayout";
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
    <AntennaConductorDetails objectId={objectId} scene={scene.data} />
    {objectId ? <>
      <MicrostripGeometryEditor key={`geometry:${objectId}`} objectId={objectId} scene={scene.data} status={scene.status} refetch={scene.refetch} />
      <AntennaPlacementEditor key={`placement:${objectId}`} objectId={objectId} scene={scene.data} status={scene.status} refetch={scene.refetch} />
    </> : null}
  </div>;
}
