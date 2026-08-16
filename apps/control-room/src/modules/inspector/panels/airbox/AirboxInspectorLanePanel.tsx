"use client";

import { useMemo, type ComponentType, type ReactNode } from "react";

import {
  useDomainMetaResource,
  useFdmRegionMembershipResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  buildDomainPresentation,
  deriveAuthoredFdmUniverseOutsideMagneticSupport,
} from "@/shared/domain/mesh/domainPresentation";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { AirboxInspectorIdentityFrame } from "./AirboxInspectorIdentityFrame";
import {
  resolveAirboxInspectorLane,
  useAirboxInspectorRuntimeStatus,
} from "./airboxInspectorRuntimeStatus";
import { FdmUniverseExtentPanel } from "./FdmUniverseExtentPanel";
import {
  FdmAirboxMeshFactsPanel,
  type FdmAirboxMeshFactsView,
} from "./FdmAirboxMeshFactsPanel";
import { AirboxOverviewPanel } from "./AirboxOverviewPanel";
import { AirboxMeshBuildPanel } from "./AirboxMeshBuildPanel";
import { AirboxMeshOverviewPanel } from "./AirboxMeshOverviewPanel";
import {
  AirboxMeshParametersPanel,
  type AirboxMeshParametersLane,
} from "./AirboxMeshParametersPanel";
import { AirboxMeshQualityGatesPanel } from "./AirboxMeshQualityGatesPanel";
import { AirboxMeshStatisticsPanel } from "./AirboxMeshStatisticsPanel";
import { AirboxMeshTopologyPanel } from "./AirboxMeshTopologyPanel";

type AirboxFemPanel = ComponentType<InspectorPanelProps>;
type AirboxFdmPanel = ComponentType<
  InspectorPanelProps & { lane: AirboxMeshParametersLane }
>;

function AirboxInspectorLanePanel({
  fdmFactsView,
  fdmPanel: FdmPanel,
  femPanel: FemPanel,
  selection,
}: InspectorPanelProps & {
  fdmPanel?: AirboxFdmPanel;
  fdmFactsView?: FdmAirboxMeshFactsView;
  femPanel: AirboxFemPanel;
}) {
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const lane = resolveAirboxInspectorLane(selection, runtimeStatus);
  const explicitFdm = lane === "fdm";
  const domain = useDomainMetaResource({ enabled: explicitFdm });
  const membership = useFdmRegionMembershipResource({ enabled: explicitFdm });
  const scene = useSceneResource({ enabled: explicitFdm });
  const roleEvidence = useMemo(() => {
    if (!domain.data) return null;
    try {
      const presentation = buildDomainPresentation({
        domainMeta: domain.data,
        fdmMembership: membership.data,
        fdmMembershipStatus: membership.error
          ? "error"
          : membership.status,
        universeOutsideMagneticSupport:
          deriveAuthoredFdmUniverseOutsideMagneticSupport({
            domainBounds: domain.data.bounds,
            objects: scene.data?.objects,
          }),
      });
      return { presentation, source: "domain-presentation" as const };
    } catch {
      return null;
    }
  }, [
    domain.data,
    membership.data,
    membership.error,
    membership.status,
    scene.data,
  ]);

  let content: ReactNode;
  if (lane === "conflict") {
    content = (
      <div className="fm-inspector-panel" role="status">
        <p>Airbox selection is unavailable</p>
        <p>The selected Airbox target does not match the current runtime lane.</p>
      </div>
    );
  } else if (explicitFdm) {
    if (FdmPanel) {
      content = <FdmPanel lane="fdm" selection={selection} />;
    } else if (fdmFactsView) {
      content = (
        <FdmAirboxMeshFactsPanel
          membership={membership.data}
          resource={domain}
          roleEvidence={roleEvidence}
          view={fdmFactsView}
        />
      );
    } else {
      content = (
        <FdmUniverseExtentPanel
          membership={membership.data}
          resource={domain}
          roleEvidence={roleEvidence}
        />
      );
    }
  } else {
    content = <FemPanel selection={selection} />;
  }

  return (
    <AirboxInspectorIdentityFrame lane={lane} selection={selection}>
      {content}
    </AirboxInspectorIdentityFrame>
  );
}

export function AirboxOverviewLanePanel(props: InspectorPanelProps) {
  return <AirboxInspectorLanePanel {...props} femPanel={AirboxOverviewPanel} />;
}

export function AirboxMeshOverviewLanePanel(props: InspectorPanelProps) {
  return <AirboxInspectorLanePanel {...props} femPanel={AirboxMeshOverviewPanel} />;
}

export function AirboxMeshParametersLanePanel(props: InspectorPanelProps) {
  return (
    <AirboxInspectorLanePanel
      {...props}
      fdmPanel={AirboxMeshParametersPanel}
      femPanel={AirboxMeshParametersPanel}
    />
  );
}

export function AirboxMeshQualityGatesLanePanel(props: InspectorPanelProps) {
  return (
    <AirboxInspectorLanePanel
      {...props}
      fdmFactsView="quality"
      femPanel={AirboxMeshQualityGatesPanel}
    />
  );
}

export function AirboxMeshStatisticsLanePanel(props: InspectorPanelProps) {
  return (
    <AirboxInspectorLanePanel
      {...props}
      fdmFactsView="statistics"
      femPanel={AirboxMeshStatisticsPanel}
    />
  );
}

export function AirboxMeshTopologyLanePanel(props: InspectorPanelProps) {
  return (
    <AirboxInspectorLanePanel
      {...props}
      fdmFactsView="topology"
      femPanel={AirboxMeshTopologyPanel}
    />
  );
}

export function AirboxMeshBuildLanePanel(props: InspectorPanelProps) {
  return (
    <AirboxInspectorLanePanel
      {...props}
      fdmFactsView="build"
      femPanel={AirboxMeshBuildPanel}
    />
  );
}
