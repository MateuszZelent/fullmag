"use client";

import { useQuantityCatalogResource } from "@/kernel/resources/studyRuntimeResources";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { useObjectVisualizationSelector, useSavedFieldPresentation } from "@/kernel/visualization/useObjectVisualization";
import { AIRBOX_VISUALIZATION_TARGET, resolveTargetVisualization } from "@/kernel/visualization/ObjectVisualizationController";
import { artifactUniverseCatalogHasExplicitLiveQuantity, artifactUniverseInspectionRoute } from "@/kernel/visualization/artifactFieldSelection";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { SavedFieldVisualizationInspector } from "../SavedFieldVisualizationPanel";
import { ArtifactInspectionSource, useArtifactInspectionSource } from "../ArtifactInspectionSource";
import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  VisualizationTargetInspectorPanel,
  type VisualizationInspectorOwner,
} from "../ObjectVisualizationPanel";

const AIRBOX_VISUALIZATION_OWNER: VisualizationInspectorOwner = {
  actionSummary: "Universe sampling mesh, computed field, and display settings",
  capabilityDescription:
    "Uses the canonical Airbox target while preserving Airbox-specific bounds and field support.",
  id: "airbox.visualization",
  targetLabel: "Universe (Airbox)",
  title: "Universe visualization",
};

export function AirboxVisualizationPanel(props: InspectorPanelProps) {
  const { presentation } = useSavedFieldPresentation();
  return presentation ? <SavedFieldVisualizationInspector /> : <CurrentAirboxVisualizationPanel {...props} />;
}

function CurrentAirboxVisualizationPanel({ selection }: InspectorPanelProps) {
  const scene = useSceneResource();
  const source = useArtifactInspectionSource(scene);
  const visualizationState = useVisualizationStateResource();
  const state = visualizationState.optimisticData ?? visualizationState.data;
  const activeQuantityId = useObjectVisualizationSelector(snapshot =>
    resolveTargetVisualization({ snapshot, target: AIRBOX_VISUALIZATION_TARGET, visualizationState: state }).settings.activeQuantityId);
  const hasInspectionContext = (scene.data?.antenna_field_solve_stages?.length ?? 0) > 0 || source.selected !== null;
  const liveCatalog = useQuantityCatalogResource({ enabled: hasInspectionContext || activeQuantityId === "H_ant" });
  const liveCatalogReady = liveCatalog.status === "ready" && !liveCatalog.error && !liveCatalog.refreshError;
  const explicitLive = liveCatalogReady && artifactUniverseCatalogHasExplicitLiveQuantity(liveCatalog.data, activeQuantityId);
  const artifactInspection = artifactUniverseInspectionRoute(activeQuantityId, hasInspectionContext, explicitLive, {
    ownerSelected: source.selected !== null,
    liveCatalogReady,
  });
  return (
    <VisualizationTargetInspectorPanel
      owner={AIRBOX_VISUALIZATION_OWNER}
      selection={selection}
      sceneOverride={scene}
      artifactInspection={artifactInspection}
      artifactInspectionOwner={source.retainedOwner}
      visualizationStateOverride={visualizationState}
      quantityCatalogOverride={(hasInspectionContext || activeQuantityId === "H_ant") && !artifactInspection ? liveCatalog : undefined}
    >
      {hasInspectionContext ? <ArtifactInspectionSource source={source} universe /> : null}
    </VisualizationTargetInspectorPanel>
  );
}
