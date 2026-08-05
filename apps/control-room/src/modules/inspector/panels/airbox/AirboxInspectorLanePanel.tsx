"use client";

import { useMemo, type ComponentType } from "react";

import {
  useDomainMetaResource,
  useFdmRegionMembershipResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { buildDomainPresentation } from "@/shared/domain/mesh/domainPresentation";

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
  const membership = useFdmRegionMembershipResource({ enabled: explicitFdm });
  const roleEvidence = useMemo(() => {
    if (!domain.data) return null;
    try {
      const presentation = buildDomainPresentation({
        domainMeta: domain.data,
        fdmMembership: membership.data,
        fdmMembershipStatus: membership.error
          ? "error"
          : membership.status,
      });
      return { presentation, source: "domain-presentation" as const };
    } catch {
      return null;
    }
  }, [domain.data, membership.data, membership.error, membership.status]);

  if (explicitFdm) {
    return (
      <FdmUniverseExtentPanel
        resource={domain}
        roleEvidence={roleEvidence}
      />
    );
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
