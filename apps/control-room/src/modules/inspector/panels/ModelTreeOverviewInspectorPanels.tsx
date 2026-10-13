import { useMemo, type ReactNode } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../inspectorTypes";
import { ScientificInspectorTemplate } from "../components/ScientificInspectorTemplate";
import { CrossSectionInspectorPanel } from "./CrossSectionInspectorPanel";
import { MeshPartVisualizationPanel } from "./MeshPartVisualizationPanel";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { AirboxMeshParametersPanel } from "./airbox/AirboxMeshParametersPanel";
import {
  resolveAirboxInspectorAuthoringLane,
  resolveAirboxInspectorLane,
  useAirboxInspectorRuntimeStatus,
} from "./airbox/airboxInspectorRuntimeStatus";
import { navigateToStudyRoot } from "./airbox/airboxNavigation";

function ContextInspector({
  breadcrumbs,
  children,
  methodLabel,
  physicalLabel,
  properties = [],
  diagnostics = [
    "This is a semantic navigator node. Select a child to inspect its owned resource or definition.",
  ],
  title,
}: {
  breadcrumbs: readonly string[];
  children?: ReactNode;
  diagnostics?: readonly string[];
  methodLabel: string;
  physicalLabel: string;
  properties?: readonly { label: string; mono?: boolean; value: string }[];
  title: string;
}) {
  return (
    <ScientificInspectorTemplate
      breadcrumbs={breadcrumbs}
      diagnostics={diagnostics}
      methodLabel={methodLabel}
      physicalLabel={physicalLabel}
      properties={[
        { label: "Payload owner", value: "Typed child resources" },
        ...properties,
      ]}
      provenance={[{ label: "Selection source", value: "explorer" }]}
      status={{ availability: "context-only", execution: "not_applicable", resource: "child-scoped" }}
      title={title}
    >
      {children}
    </ScientificInspectorTemplate>
  );
}

export function SessionRootInspectorPanel({}: InspectorPanelProps) {
  return (
    <ContextInspector
      breadcrumbs={["Model", "Session"]}
      methodLabel="Canonical ProblemIR navigator"
      physicalLabel="Session model"
      title="Session Model"
    />
  );
}

export function UniverseRootInspectorPanel({ selection }: InspectorPanelProps) {
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const authoringLane = resolveAirboxInspectorAuthoringLane(selection, runtimeStatus);
  const runtimeLane = resolveAirboxInspectorLane(selection, runtimeStatus);
  const knownMethod = authoringLane === "fdm" || authoringLane === "fem";
  const runtimeLaneForAuthoring = runtimeLane === "fdm" && authoringLane === "fdm"
    ? "fdm"
    : runtimeLane === "fem" && authoringLane === "fem"
      ? "fem"
      : null;
  const runtimeMatchesAuthoring = runtimeLaneForAuthoring !== null;
  const availabilityMessage = knownMethod
    ? runtimeMatchesAuthoring
      ? `The accepted ${authoringLane.toUpperCase()} method is available for policy authoring.`
      : `The accepted ${authoringLane.toUpperCase()} method is known. Runtime realization remains unresolved, so mesh facts and runtime actions are unavailable.`
    : runtimeStatus?.authoring.reason ?? "Choose an explicit FEM or FDM method before configuring the domain.";
  return (
    <ContextInspector
      breadcrumbs={["Model", "Universe"]}
      diagnostics={[availabilityMessage, "Airbox generation follows the selected demagnetization settings and planner."]}
      methodLabel="Physical domain navigator"
      physicalLabel="Simulation universe"
      title="Universe"
    >
      {knownMethod ? (
        <InspectorGroup title="Outer-domain policy" badge="authoring">
          <p>Use Auto or Manual to author the universe bounds. Values remain editable before runtime realization.</p>
          <UniverseMethodActions
            showDiagnostics={!runtimeMatchesAuthoring}
            showNewProblem={false}
            showStudySettings
            studyLabel={authoringLane === "fdm" ? "Open FDM grid settings" : "Open Study settings"}
          />
          {!runtimeMatchesAuthoring ? <p role="status">{availabilityMessage}</p> : null}
          <AirboxMeshParametersPanel
            lane={authoringLane}
            runtimeLane={runtimeLaneForAuthoring}
            selection={selection}
          />
        </InspectorGroup>
      ) : (
        <InspectorGroup title="Domain authoring unavailable" badge={runtimeStatus?.authoring.state ?? "loading"}>
          <p role="status">{availabilityMessage}</p>
          <UniverseMethodActions
            showDiagnostics
            showNewProblem={runtimeStatus?.authoring.state === "missing"}
            showStudySettings
            studyLabel="Open Study settings"
          />
        </InspectorGroup>
      )}
    </ContextInspector>
  );
}

function UniverseMethodActions({
  showDiagnostics,
  showNewProblem,
  showStudySettings,
  studyLabel,
}: {
  showDiagnostics: boolean;
  showNewProblem: boolean;
  showStudySettings: boolean;
  studyLabel: string;
}) {
  const kernel = useKernel();
  const commandContext = useMemo(
    () => createCommandContext("inspector", kernel, { sourceDetail: "universe-authoring-availability" }),
    [kernel],
  );
  return (
    <div className="fm-inspector-toolbar" aria-label="Universe navigation">
      {showStudySettings ? (
        <Button size="sm" type="button" variant="secondary" onClick={() => navigateToStudyRoot(kernel.selection)}>
          {studyLabel}
        </Button>
      ) : null}
      {showNewProblem ? (
        <Button size="sm" type="button" variant="primary" onClick={() => void kernel.commands.execute("workspace.new-problem", commandContext)}>
          Choose method in New Problem
        </Button>
      ) : null}
      {showDiagnostics ? (
        <Button size="sm" type="button" variant="ghost" onClick={() => kernel.layout.openBottomPanel("diagnostics")}>
          Open diagnostics
        </Button>
      ) : null}
    </div>
  );
}

export function ObjectsRootInspectorPanel({}: InspectorPanelProps) {
  return (
    <ContextInspector
      breadcrumbs={["Model", "Objects"]}
      methodLabel="Scene object navigator"
      physicalLabel="Magnetic objects"
      title="Objects"
    />
  );
}

export function DefinitionsRootInspectorPanel({}: InspectorPanelProps) {
  return (
    <ContextInspector
      breadcrumbs={["Model", "Definitions"]}
      methodLabel="Canonical DSL definition navigator"
      physicalLabel="Definitions"
      title="Definitions"
    />
  );
}

export function PlanarMonitorsInspectorPanel({}: InspectorPanelProps) {
  return (
    <ContextInspector
      breadcrumbs={["Definitions", "Planar monitors"]}
      methodLabel="Planar monitor resource navigator"
      physicalLabel="Spatial observables"
      title="Planar Monitors"
    />
  );
}

export function PhysicsCouplingsInspectorPanel({}: InspectorPanelProps) {
  return (
    <ContextInspector
      breadcrumbs={["Physics", "Couplings"]}
      methodLabel="Coupling realization navigator"
      physicalLabel="Inter-object physics"
      title="Couplings"
    />
  );
}

function PhysicsScopeInspector({
  selection,
  title,
  physicalLabel,
}: InspectorPanelProps & { physicalLabel: string; title: string }) {
  return (
    <ContextInspector
      breadcrumbs={["Physics", title]}
      methodLabel="Physics graph scope"
      physicalLabel={physicalLabel}
      properties={[
        { label: "Scope node", mono: true, value: selection.nodeId ?? "Unavailable" },
        { label: "Object", value: selection.objectId ?? "Not object-scoped" },
      ]}
      title={title}
    />
  );
}

export function GlobalPhysicsScopeInspectorPanel(props: InspectorPanelProps) {
  return <PhysicsScopeInspector {...props} physicalLabel="Global interactions" title="Global Physics" />;
}

export function ObjectPhysicsScopeInspectorPanel(props: InspectorPanelProps) {
  return <PhysicsScopeInspector {...props} physicalLabel="Object-scoped interactions" title="Object Physics Scope" />;
}

export function CrossObjectPhysicsScopeInspectorPanel(props: InspectorPanelProps) {
  return <PhysicsScopeInspector {...props} physicalLabel="Cross-object interfaces" title="Cross-object Interfaces" />;
}

export function UnresolvedPhysicsScopeInspectorPanel(props: InspectorPanelProps) {
  return <PhysicsScopeInspector {...props} physicalLabel="Unresolved physics graph" title="Unresolved Physics" />;
}

export function MeshUnassignedInspectorPanel({}: InspectorPanelProps) {
  return (
    <ContextInspector
      breadcrumbs={["Mesh", "Unassigned parts"]}
      methodLabel="Mesh-part ownership navigator"
      physicalLabel="Unassigned mesh topology"
      title="Unassigned Mesh Parts"
    />
  );
}

export function MeshUnassignedPartInspectorPanel(props: InspectorPanelProps) {
  return (
    <ScientificInspectorTemplate
      breadcrumbs={["Mesh", "Unassigned parts", "Part"]}
      diagnostics={["This part is not assigned to a canonical object or region. Visualization remains scoped to the selected mesh part."]}
      methodLabel="Mesh-part visualization"
      physicalLabel="Unassigned mesh topology"
      properties={[{ label: "Selection node", mono: true, value: props.selection.nodeId ?? "Unavailable" }]}
      provenance={[{ label: "Selection source", value: props.selection.moduleSource }]}
      status={{ availability: "available", execution: "not_applicable", resource: "mesh-part-scoped" }}
      title={props.selection.label ?? "Unassigned Mesh Part"}
    >
      <MeshPartVisualizationPanel selection={props.selection} />
    </ScientificInspectorTemplate>
  );
}

export function Visualizations2DOverviewInspectorPanel({}: InspectorPanelProps) {
  return (
    <ContextInspector
      breadcrumbs={["Model", "Visualizations 2D"]}
      methodLabel="Planar visualization navigator"
      physicalLabel="Cross-section visualization"
      title="Visualizations 2D"
    />
  );
}

function CrossSectionInspectorShell({
  selection,
  title,
}: InspectorPanelProps & { title: string }) {
  return (
    <ScientificInspectorTemplate
      breadcrumbs={["Visualizations 2D", title]}
      diagnostics={["Cross-section settings are scoped to the selected draft or saved plot."]}
      methodLabel="Planar mesh visualization"
      physicalLabel="Cross-section"
      properties={[{ label: "Selection node", mono: true, value: selection.nodeId ?? "Unavailable" }]}
      provenance={[{ label: "Selection source", value: selection.moduleSource }]}
      status={{ availability: "available", execution: "not_applicable", resource: "cross-section-scoped" }}
      title={selection.label ?? title}
    >
      <CrossSectionInspectorPanel selection={selection} />
    </ScientificInspectorTemplate>
  );
}

export function Visualizations2DDraftInspectorPanel(props: InspectorPanelProps) {
  return <CrossSectionInspectorShell {...props} title="Draft" />;
}

export function Visualizations2DParameterInspectorPanel(props: InspectorPanelProps) {
  return <CrossSectionInspectorShell {...props} title="Parameter" />;
}

export function Visualizations2DPlotInspectorPanel(props: InspectorPanelProps) {
  return <CrossSectionInspectorShell {...props} title="Plot" />;
}
