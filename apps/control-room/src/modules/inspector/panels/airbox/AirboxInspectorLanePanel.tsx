"use client";

import { useMemo, type ComponentType, type ReactNode } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  useDomainMetaResource,
  useFdmMultilayerLayoutResource,
  useFdmRegionMembershipResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { hasPublishedFemMeshEvidence } from "@/kernel/resources/studyRuntimeResources";
import {
  buildDomainPresentation,
  deriveAuthoredFdmUniverseOutsideMagneticSupport,
} from "@/shared/domain/mesh/domainPresentation";
import { resolveFdmMultilayerAirboxTarget } from "@/shared/domain/mesh/fdmMultilayerAirboxTarget";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { Button } from "@/shared/ui/Button";
import { AirboxInspectorIdentityFrame } from "./AirboxInspectorIdentityFrame";
import {
  hasPublishedFemTopologyInspectionLane,
  resolveAirboxInspectorAuthoringLane,
  resolveAirboxInspectorLane,
  useAirboxInspectorRuntimeStatus,
} from "./airboxInspectorRuntimeStatus";
import { navigateToAirboxRoute } from "./airboxNavigation";
import { FdmUniverseExtentPanel } from "./FdmUniverseExtentPanel";
import { FdmMultilayerAirboxTargetPanelView } from "./FdmMultilayerAirboxTargetPanel";
import {
  resolveFdmMultilayerAirboxTargetInspectorModel,
  type FdmMultilayerAirboxTargetInspectorModel,
} from "./fdmMultilayerAirboxTargetInspectorModel";
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

function targetGridModelWithBounds(
  layout: NonNullable<ReturnType<typeof useFdmMultilayerLayoutResource>["data"]>,
): FdmMultilayerAirboxTargetInspectorModel {
  const model = resolveFdmMultilayerAirboxTargetInspectorModel(layout);
  if (model.status !== "ready") return model;

  const target = resolveFdmMultilayerAirboxTarget(layout);
  if (!target) {
    return {
      notice: "Target-only Airbox carrier failed validation.",
      status: "unavailable",
    };
  }
  const boundsMax = target.origin.map(
    (origin, axis) => origin + target.cells[axis]! * target.cellSize[axis]!,
  );
  if (!boundsMax.every(Number.isFinite)) {
    return {
      notice: "Target-only Airbox bounds are outside the supported numeric range.",
      status: "unavailable",
    };
  }

  const formatTuple = (values: readonly number[]) => `[${values.join(", ")}]`;
  return {
    ...model,
    targetGridRows: [
      ...model.targetGridRows,
      { label: "Bounds min", unit: "m", value: formatTuple(target.origin) },
      { label: "Bounds max", unit: "m", value: formatTuple(boundsMax) },
    ],
  };
}

function unavailableTargetGridModel(
  status: "error" | "idle" | "loading" | "stale",
  message?: string,
): FdmMultilayerAirboxTargetInspectorModel {
  const notice = status === "error"
    ? message ?? "The FDM multilayer layout could not be loaded. Airbox target facts are withheld."
    : status === "stale"
      ? "The FDM multilayer layout is stale. Airbox target facts are withheld until a current layout is available."
      : status === "loading"
        ? "The FDM multilayer layout is loading. Airbox target facts are withheld until its scope is resolved."
        : "The FDM multilayer layout has not loaded. Airbox target facts are withheld.";
  return { notice, status: "unavailable" };
}

function AirboxInspectorLanePanel({
  fdmFactsView,
  fdmPanel: FdmPanel,
  femPanel: FemPanel,
  authoringPanel = false,
  overviewFallback = false,
  selection,
}: InspectorPanelProps & {
  authoringPanel?: boolean;
  fdmPanel?: AirboxFdmPanel;
  fdmFactsView?: FdmAirboxMeshFactsView;
  femPanel: AirboxFemPanel;
  overviewFallback?: boolean;
}) {
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const lane = resolveAirboxInspectorLane(selection, runtimeStatus);
  const authoringLane = resolveAirboxInspectorAuthoringLane(selection, runtimeStatus);
  const publishedFemMesh = lane === "fem"
    ? hasPublishedFemMeshEvidence(runtimeStatus)
    : hasPublishedFemTopologyInspectionLane(runtimeStatus);
  const inspectionLane = lane === "unresolved" && authoringLane === "conflict"
    ? "conflict" : lane;
  const explicitFdm = lane === "fdm";
  const showTargetLayout = !authoringPanel && !FdmPanel;
  const multilayerLayout = useFdmMultilayerLayoutResource({
    enabled: explicitFdm && showTargetLayout,
  });
  const nativeFdmFactsEnabled = explicitFdm && (
    !showTargetLayout ||
    (multilayerLayout.status === "ready" && multilayerLayout.data?.available === false)
  );
  const domain = useDomainMetaResource({ enabled: nativeFdmFactsEnabled });
  const membership = useFdmRegionMembershipResource({ enabled: nativeFdmFactsEnabled });
  const scene = useSceneResource({ enabled: nativeFdmFactsEnabled });
  const targetGridModel = useMemo(() => {
    if (!showTargetLayout) return null;
    if (multilayerLayout.status !== "ready") {
      return unavailableTargetGridModel(
        multilayerLayout.status,
        multilayerLayout.error?.message ?? multilayerLayout.refreshError?.message ?? undefined,
      );
    }
    if (multilayerLayout.data?.available === false) return null;
    if (!multilayerLayout.data) {
      return unavailableTargetGridModel("error", "The Airbox layout response is missing.");
    }
    return targetGridModelWithBounds(multilayerLayout.data);
  }, [
    showTargetLayout,
    multilayerLayout.data,
    multilayerLayout.error,
    multilayerLayout.refreshError,
    multilayerLayout.status,
  ]);
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
  if (authoringPanel && authoringLane === "conflict") {
    content = (
      <AirboxLaneAvailabilityPanel
        heading="Airbox authoring method conflicts with this selection"
        message="This selected Airbox target is only valid for the accepted FDM method. Review the model method and session diagnostics."
        showNewProblem={false}
      />
    );
  } else if (authoringPanel && authoringLane === "unresolved") {
    content = (
      <AirboxLaneAvailabilityPanel
        heading="Universe policy editor needs an accepted method"
        message={runtimeStatus?.authoring.reason ?? "The accepted FEM/FDM method is still loading."}
        showNewProblem
      />
    );
  } else if (authoringPanel && (authoringLane === "fdm" || authoringLane === "fem")) {
    content = (
      <AirboxMeshParametersPanel
        lane={authoringLane}
        runtimeLane={lane === authoringLane ? lane : null}
        selection={selection}
      />
    );
  } else if (inspectionLane === "conflict") {
    content = (
      <AirboxLaneAvailabilityPanel
        heading="Airbox selection does not match the runtime lane"
        message="The selected FDM-specific target cannot be shown for the resolved runtime lane. Review the accepted model method and runtime diagnostics."
        showNewProblem={false}
        showPolicyRoute
      />
    );
  } else if (lane === "unresolved") {
    const authoredMethod = runtimeStatus?.authoring.method ?? null;
    if (
      authoredMethod === "fem" &&
      hasPublishedFemTopologyInspectionLane(runtimeStatus)
    ) {
      content = <FemPanel selection={selection} />;
    } else if (overviewFallback && authoredMethod === "fem") {
      content = <FemPanel selection={selection} />;
    } else if (overviewFallback && authoredMethod === "fdm") {
      content = <AirboxMeshParametersPanel lane="fdm" runtimeLane={null} selection={selection} />;
    } else {
      content = (
        <AirboxLaneAvailabilityPanel
          heading="Airbox runtime facts are not available yet"
          message={authoredMethod
            ? `The accepted ${authoredMethod.toUpperCase()} method is known, so the domain policy remains editable. Mesh facts and build actions wait for runtime-lane resolution.`
            : runtimeStatus?.authoring.reason ?? "The accepted model method has not been published."}
          showNewProblem={!authoredMethod}
          showPolicyRoute={Boolean(authoredMethod)}
        />
      );
    }
  } else if (explicitFdm) {
    if (FdmPanel) {
      content = <FdmPanel lane="fdm" selection={selection} />;
    } else if (showTargetLayout && targetGridModel) {
      content = (
        <div
          data-fdm-airbox-grid-source="layout.airbox"
          data-fdm-airbox-mesh-view={fdmFactsView ?? "overview"}
          data-fdm-multilayer-airbox-resource-status={multilayerLayout.status}
        >
          <FdmMultilayerAirboxTargetPanelView model={targetGridModel} />
        </div>
      );
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
    <AirboxInspectorIdentityFrame
      artifactLane={
        !authoringPanel && inspectionLane !== "conflict" && hasPublishedFemTopologyInspectionLane(runtimeStatus)
          ? "fem"
          : null
      }
      executionState={runtimeStatus?.executionState}
      lane={inspectionLane}
      publishedFemMesh={publishedFemMesh && inspectionLane !== "conflict"}
      runtimeReason={runtimeStatus?.authoring.reason}
      selection={selection}
    >
      {content}
    </AirboxInspectorIdentityFrame>
  );
}

export function AirboxOverviewLanePanel(props: InspectorPanelProps) {
  return <AirboxInspectorLanePanel {...props} femPanel={AirboxOverviewPanel} overviewFallback />;
}

export function AirboxMeshOverviewLanePanel(props: InspectorPanelProps) {
  return <AirboxInspectorLanePanel {...props} femPanel={AirboxMeshOverviewPanel} />;
}

export function AirboxMeshParametersLanePanel(props: InspectorPanelProps) {
  return (
    <AirboxInspectorLanePanel
      {...props}
      authoringPanel
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

function AirboxLaneAvailabilityPanel({
  heading,
  message,
  showNewProblem,
  showPolicyRoute = false,
}: {
  heading: string;
  message: string;
  showNewProblem: boolean;
  showPolicyRoute?: boolean;
}) {
  const kernel = useKernel();
  const commandContext = useMemo(
    () => createCommandContext("inspector", kernel, { sourceDetail: "airbox-authoring-availability" }),
    [kernel],
  );
  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group" role="status">
      <p>{heading}</p>
      <p>{message}</p>
      <div className="fm-inspector-toolbar">
        {showPolicyRoute ? (
          <Button size="sm" type="button" variant="primary" onClick={() => navigateToAirboxRoute(kernel.selection, "meshParameters")}>
            Open domain policy
          </Button>
        ) : null}
        {showNewProblem ? (
          <Button size="sm" type="button" variant="secondary" onClick={() => void kernel.commands.execute("workspace.new-problem", commandContext)}>
            Choose method in New Problem
          </Button>
        ) : null}
        <Button size="sm" type="button" variant="ghost" onClick={() => kernel.layout.openBottomPanel("diagnostics")}>
          Open diagnostics
        </Button>
      </div>
    </div>
  );
}
