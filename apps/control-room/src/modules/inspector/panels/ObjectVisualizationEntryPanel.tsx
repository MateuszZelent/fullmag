"use client";

import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import type { InspectorPanelProps } from "../inspectorTypes";
import { ObjectVisualizationPanel as GenericObjectVisualizationPanel } from "./ObjectVisualizationPanel";
import { AntennaVisualizationView } from "./antenna/AntennaVisualizationPanel";
import { isAntennaVisualizationObject } from "./antenna/AntennaVisualizationObjectModel";

/** Resolve authored ownership before mounting either set of resource readers. */
export function ObjectVisualizationPanel({ selection }: InspectorPanelProps) {
  const scene = useSceneResource();
  const objectId = selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId;
  if (isAntennaVisualizationObject(scene.data, objectId)) return <AntennaVisualizationView selection={selection} scene={scene} />;
  return <GenericObjectVisualizationPanel selection={selection} sceneOverride={scene} />;
}
