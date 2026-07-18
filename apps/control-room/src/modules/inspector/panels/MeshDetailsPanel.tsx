"use client";

import type { InspectorPanelProps } from "../inspectorTypes";
import { JsonResourceSection } from "./MeshResourceView";
import { MeshBuildHistorySection } from "./mesh-details/MeshBuildHistorySection";
import { MeshBuildPipelineSection } from "./mesh-details/MeshBuildPipelineSection";
import {
  MeshCountsExtentsSection,
  MeshOverviewSection,
  SolverMeshIdentitySection,
} from "./mesh-details/MeshOverviewSection";
import { MeshPolicyComparisonSection } from "./mesh-details/MeshPolicyComparisonSection";
import {
  MeshQualityGatesSection,
  MeshQualityStatisticsSection,
} from "./mesh-details/MeshQualityGatesSection";
import {
  MeshRealizedSizeFieldsSection,
  OperationStatusesSection,
  ThinFilmDiagnosticsSection,
} from "./mesh-details/MeshRealizedSizeFieldsSection";
import { MeshEditorCapabilitiesSection } from "./mesh-details/MeshEditorCapabilitiesSection";
import { MeshViewportDeliverySection } from "./mesh-details/MeshViewportDeliverySection";
import { useMeshDetailsModel } from "./mesh-details/useMeshDetailsModel";

function meshDetailsInspectorSections(selectionKind: string | null): string[] {
  switch (selectionKind) {
    case "mesh.root":
      return [
        "overview",
        "identity",
        "pipeline",
        "policy-comparison",
        "viewport-delivery",
        "editor-capabilities",
        "json-capabilities",
        "json-semantics",
        "json-mesh-build-report",
      ];
    case "mesh.shared-domain":
      return [
        "overview",
        "identity",
        "counts",
        "viewport-delivery",
        "editor-capabilities",
        "json-universe-report",
        "json-shared-report",
        "json-mesh-build-report",
      ];
    case "mesh.builds":
      return [
        "overview",
        "pipeline",
        "build-history",
        "operation-statuses",
        "thin-film",
        "editor-capabilities",
        "json-last-build",
      ];
    case "mesh.quality":
      return [
        "overview",
        "quality-gates",
        "quality-statistics",
        "json-universe-quality",
        "json-shared-quality",
      ];
    case "mesh.size-fields":
      return [
        "overview",
        "size-fields",
      ];
    case "mesh.regions":
      return [
        "overview",
        "identity",
        "counts",
        "policy-comparison",
      ];
    default:
      return [
        "overview",
        "identity",
        "counts",
        "pipeline",
        "build-history",
        "policy-comparison",
        "quality-gates",
        "quality-statistics",
        "size-fields",
        "viewport-delivery",
        "operation-statuses",
        "thin-film",
        "editor-capabilities",
        "json-capabilities",
        "json-semantics",
        "json-mesh-build-report",
        "json-universe-report",
        "json-universe-quality",
        "json-shared-report",
        "json-shared-quality",
        "json-last-build",
      ];
  }
}

export function MeshDetailsPanel({ selection }: InspectorPanelProps) {
  const model = useMeshDetailsModel(selection);
  const sections = meshDetailsInspectorSections(selection.kind);
  const showSection = (section: string) => sections.includes(section);

  return (
    <div
      key={selection.kind ?? "default"}
      className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group"
    >
      {showSection("overview") ? (
        <MeshOverviewSection
          activeBuildRevision={model.activeBuildRevision}
          buildStatus={model.buildStatus}
          meshFreshness={model.meshFreshness}
          meshIsStale={model.meshIsStale}
          meshRevision={model.meshRevision}
          meshSourceSceneRevision={model.meshSourceSceneRevision}
          objectPolicyCount={model.objectPolicyCount}
          sceneRevision={model.sceneRevision}
          semanticLayers={model.semanticLayers}
          summaryStatus={model.summaryStatus}
          targetCount={model.targetCount}
          title={model.title}
        />
      ) : null}
      {showSection("identity") ? (
        <SolverMeshIdentitySection
          badge={model.manifestStatus}
          manifest={model.manifest}
        />
      ) : null}
      {showSection("counts") ? (
        <MeshCountsExtentsSection
          edgeLength={model.qualityStatistics?.edgeLength ?? null}
          meshStatistics={model.meshStatistics}
          meshSummary={model.meshSummary}
        />
      ) : null}
      {showSection("pipeline") ? (
        <MeshBuildPipelineSection
          activeBuildStatus={model.activeBuildStatus}
          buildMode={model.buildMode}
          buildStatus={model.buildStatus}
          fallbacks={model.fallbacks}
          lastBuildError={model.lastBuildError}
          latestSuccessAvailable={model.latestSuccessAvailable}
          sizeFieldKinds={model.sizeFieldKinds}
          onBuildSharedDomain={model.onBuildSharedDomain}
          onOpenBuildDetails={model.onOpenBuildDetails}
        />
      ) : null}
      {showSection("build-history") ? (
        <MeshBuildHistorySection entries={model.buildHistoryEntries} />
      ) : null}
      {showSection("policy-comparison") ? (
        <MeshPolicyComparisonSection rows={model.policyDiffRows} />
      ) : null}
      {showSection("quality-gates") ? (
        <MeshQualityGatesSection
          badge={model.sharedQualityStatus}
          gateRows={model.gateRows}
        />
      ) : null}
      {showSection("quality-statistics") ? (
        <MeshQualityStatisticsSection
          statistics={model.qualityStatistics}
          refinementState={model.qualityRefinementState}
          onHoverSizeDistributionBin={model.onHoverSizeDistributionBin}
          onRefineWorstElement={model.onRefineWorstElement}
          onSelectMetric={model.onSelectMetric}
          onSelectWorstElement={model.onSelectWorstElement}
        />
      ) : null}
      {showSection("size-fields") ? (
        <MeshRealizedSizeFieldsSection sizeFields={model.sizeFields} />
      ) : null}
      {showSection("viewport-delivery") ? (
        <MeshViewportDeliverySection
          manifestStatus={model.manifestStatus}
          meshGenerationId={model.manifest?.generation_id}
          meshRevision={model.meshRevision}
        />
      ) : null}
      {showSection("editor-capabilities") ? (
        <MeshEditorCapabilitiesSection model={model.editorCapabilities} />
      ) : null}
      {showSection("operation-statuses") ? (
        <OperationStatusesSection operationStatuses={model.operationStatuses} />
      ) : null}
      {showSection("thin-film") ? (
        <ThinFilmDiagnosticsSection
          thinFilmDiagnostics={model.thinFilmDiagnostics}
        />
      ) : null}

      {showSection("json-capabilities") ? (
        <JsonResourceSection
          sectionValue="json-capabilities"
          badge={model.capabilitiesStatus}
          title="Meshing Capabilities JSON"
          value={model.capabilitiesData}
        />
      ) : null}
      {showSection("json-semantics") ? (
        <JsonResourceSection
          sectionValue="json-semantics"
          title="Mesh Semantics JSON"
          value={model.semanticsData}
        />
      ) : null}
      {showSection("json-mesh-build-report") ? (
        <JsonResourceSection
          sectionValue="json-mesh-build-report"
          title="Mesh Build Report JSON"
          value={model.meshBuildReport}
        />
      ) : null}
      {showSection("json-universe-report") ? (
        <JsonResourceSection
          sectionValue="json-universe-report"
          title="Universe Report JSON"
          value={model.universeReportData}
        />
      ) : null}
      {showSection("json-universe-quality") ? (
        <JsonResourceSection
          sectionValue="json-universe-quality"
          title="Universe Quality JSON"
          value={model.universeQualityData}
        />
      ) : null}
      {showSection("json-shared-report") ? (
        <JsonResourceSection
          sectionValue="json-shared-report"
          title="Shared-Domain Report JSON"
          value={model.sharedReportData}
        />
      ) : null}
      {showSection("json-shared-quality") ? (
        <JsonResourceSection
          sectionValue="json-shared-quality"
          title="Shared-Domain Quality JSON"
          value={model.sharedQualityData}
        />
      ) : null}
      {showSection("json-last-build") ? (
        <JsonResourceSection
          sectionValue="json-last-build"
          title="Latest Build JSON"
          value={model.latestBuildJson}
        />
      ) : null}
    </div>
  );
}
