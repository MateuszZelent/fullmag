"use client";
import type { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { VisualizationTargetInspectorPanel, type VisualizationInspectorOwner } from "../ObjectVisualizationPanel";
import { ArtifactInspectionSource, useArtifactInspectionSource } from "../ArtifactInspectionSource";

const OWNER: VisualizationInspectorOwner = {
  id: "object.antenna.visualization",
  title: "Antenna visualization",
  targetLabel: "Historical conductor / sampling carrier",
  capabilityDescription: "Raw H, current density J and electric potential V on their immutable result carriers.",
  actionSummary: "Inspect a source and execution; adjust common display passes without recomputing fields.",
};

type Props = InspectorPanelProps & { scene: ReturnType<typeof useSceneResource> };

export function AntennaArtifactVisualization({ selection, scene }: Props) {
  const objectId = selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId;
  const source = useArtifactInspectionSource(scene, objectId ?? null);
  return <VisualizationTargetInspectorPanel owner={OWNER} selection={selection} sceneOverride={scene} artifactInspection artifactInspectionOwner={source.retainedOwner}>
    <ArtifactInspectionSource source={source} />
  </VisualizationTargetInspectorPanel>;
}
