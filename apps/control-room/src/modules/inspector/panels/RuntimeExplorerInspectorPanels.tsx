import { useRuntimeExplorerDetail } from "@/kernel/resources/runtimeExplorerDetailStore";

import type { InspectorPanelProps } from "../inspectorTypes";
import {
  RuntimeCommandJobView,
  RuntimeDiagnosticCategoryView,
  RuntimeExecutionJobView,
  RuntimeResourceInspectorView,
} from "./runtime/RuntimeJobsAndDiagnosticsSpecs";

export { useRuntimeExplorerDetail };

export function RuntimeResourceInspectorPanel(props: InspectorPanelProps) {
  return <RuntimeResourceInspectorView {...props} />;
}

export function RuntimeRunJobInspectorPanel(props: InspectorPanelProps) {
  return <RuntimeExecutionJobView {...props} specId="jobs.run" title="Run lifecycle" />;
}

export function RuntimeStageJobInspectorPanel(props: InspectorPanelProps) {
  return <RuntimeExecutionJobView {...props} specId="jobs.stage" title="Stage lifecycle" />;
}

export function RuntimeCommandJobInspectorPanel(props: InspectorPanelProps) {
  return <RuntimeCommandJobView {...props} />;
}

export function RuntimeProblemDiagnosticInspectorPanel(props: InspectorPanelProps) {
  return (
    <RuntimeDiagnosticCategoryView
      {...props}
      categoryTitle="Problem diagnostic"
      specId="diagnostics.problem"
    />
  );
}

export function RuntimeHealthDiagnosticInspectorPanel(props: InspectorPanelProps) {
  return (
    <RuntimeDiagnosticCategoryView
      {...props}
      categoryTitle="Health diagnostic"
      specId="diagnostics.health"
    />
  );
}

export function RuntimeCapabilityDiagnosticInspectorPanel(props: InspectorPanelProps) {
  return (
    <RuntimeDiagnosticCategoryView
      {...props}
      categoryTitle="Capability diagnostic"
      specId="diagnostics.capability"
    />
  );
}

export function RuntimeSolverDiagnosticInspectorPanel(props: InspectorPanelProps) {
  return (
    <RuntimeDiagnosticCategoryView
      {...props}
      categoryTitle="Solver diagnostic"
      specId="diagnostics.solver"
    />
  );
}

export function RuntimeMeshDiagnosticInspectorPanel(props: InspectorPanelProps) {
  return (
    <RuntimeDiagnosticCategoryView
      {...props}
      categoryTitle="Mesh diagnostic"
      specId="diagnostics.mesh"
    />
  );
}

export function RuntimeFrequencyDiagnosticInspectorPanel(props: InspectorPanelProps) {
  return (
    <RuntimeDiagnosticCategoryView
      {...props}
      categoryTitle="Frequency-domain diagnostic"
      specId="diagnostics.frequency-domain"
    />
  );
}

export function RuntimePerformanceDiagnosticInspectorPanel(props: InspectorPanelProps) {
  return (
    <RuntimeDiagnosticCategoryView
      {...props}
      categoryTitle="Performance diagnostic"
      specId="diagnostics.performance"
    />
  );
}

export function RuntimeResourceDiagnosticInspectorPanel(props: InspectorPanelProps) {
  return (
    <RuntimeDiagnosticCategoryView
      {...props}
      categoryTitle="Resource diagnostic"
      specId="diagnostics.resource"
    />
  );
}
