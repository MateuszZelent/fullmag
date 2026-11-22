import type { InspectorPanelProps } from "../inspectorTypes";
import {
  RuntimeDiagnosticCategoryView,
  RuntimeJobsOverviewView,
  RuntimeResourcesOverviewView,
} from "./runtime/RuntimeJobsAndDiagnosticsSpecs";

export function ResourcesOverviewInspectorPanel(props: InspectorPanelProps) {
  return <RuntimeResourcesOverviewView {...props} />;
}

export function JobsOverviewInspectorPanel(props: InspectorPanelProps) {
  return <RuntimeJobsOverviewView {...props} />;
}

export function DiagnosticsOverviewInspectorPanel(props: InspectorPanelProps) {
  return (
    <RuntimeDiagnosticCategoryView
      {...props}
      categoryTitle="Runtime Diagnostics"
      specId="diagnostics.root"
    />
  );
}
