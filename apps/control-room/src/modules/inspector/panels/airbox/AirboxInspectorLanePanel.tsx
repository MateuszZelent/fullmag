"use client";

import type { ComponentType } from "react";

import { useDomainMetaResource } from "@/kernel/resources/geometryLifecycleResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { isExplicitFdmAirboxRuntime, useAirboxInspectorRuntimeStatus } from "./airboxInspectorRuntimeStatus";
import { FdmUniverseExtentPanel } from "./FdmUniverseExtentPanel";
import { AirboxOverviewPanel } from "./AirboxOverviewPanel";
import { AirboxMeshBuildPanel } from "./AirboxMeshBuildPanel";
import { AirboxMeshOverviewPanel } from "./AirboxMeshOverviewPanel";
import { AirboxMeshParametersPanel } from "./AirboxMeshParametersPanel";
import { AirboxMeshQualityGatesPanel } from "./AirboxMeshQualityGatesPanel";
import { AirboxMeshStatisticsPanel } from "./AirboxMeshStatisticsPanel";
import { AirboxMeshTopologyPanel } from "./AirboxMeshTopologyPanel";

type AirboxFemPanel = ComponentType<InspectorPanelProps>;

function AirboxInspectorLanePanel({
  femPanel: FemPanel,
  selection,
}: InspectorPanelProps & { femPanel: AirboxFemPanel }) {
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const explicitFdm = isExplicitFdmAirboxRuntime(runtimeStatus);
  const domain = useDomainMetaResource({ enabled: explicitFdm });

  if (explicitFdm) {
    return <FdmUniverseExtentPanel resource={domain} />;
  }
  return <FemPanel selection={selection} />;
}

export function AirboxOverviewLanePanel(props: InspectorPanelProps) {
  return <AirboxInspectorLanePanel {...props} femPanel={AirboxOverviewPanel} />;
}

export function AirboxMeshOverviewLanePanel(props: InspectorPanelProps) {
  return <AirboxInspectorLanePanel {...props} femPanel={AirboxMeshOverviewPanel} />;
}

export function AirboxMeshParametersLanePanel(props: InspectorPanelProps) {
  return <AirboxInspectorLanePanel {...props} femPanel={AirboxMeshParametersPanel} />;
}

export function AirboxMeshQualityGatesLanePanel(props: InspectorPanelProps) {
  return <AirboxInspectorLanePanel {...props} femPanel={AirboxMeshQualityGatesPanel} />;
}

export function AirboxMeshStatisticsLanePanel(props: InspectorPanelProps) {
  return <AirboxInspectorLanePanel {...props} femPanel={AirboxMeshStatisticsPanel} />;
}

export function AirboxMeshTopologyLanePanel(props: InspectorPanelProps) {
  return <AirboxInspectorLanePanel {...props} femPanel={AirboxMeshTopologyPanel} />;
}

export function AirboxMeshBuildLanePanel(props: InspectorPanelProps) {
  return <AirboxInspectorLanePanel {...props} femPanel={AirboxMeshBuildPanel} />;
}
