import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { InspectorSection } from "../../primitives/InspectorSection";
import {
  asRecord,
  formatCount,
  formatLength,
  MeshResourceFields,
  recordField,
} from "../MeshResourceView";

export function MeshOverviewSection({
  activeBuildRevision,
  buildStatus,
  meshFreshness,
  meshIsStale,
  meshRevision,
  meshSourceSceneRevision,
  objectPolicyCount,
  sceneRevision,
  semanticLayers,
  summaryStatus,
  targetCount,
  title,
}: {
  activeBuildRevision: unknown;
  buildStatus: string;
  meshFreshness: string;
  meshIsStale: boolean;
  meshRevision: unknown;
  meshSourceSceneRevision: number | null;
  objectPolicyCount: number;
  sceneRevision: number | null;
  semanticLayers: string;
  summaryStatus: string;
  targetCount: number;
  title: string;
}) {
  return (
    <InspectorSection value="overview" title={title} badge={buildStatus} collapsible defaultCollapsed={false}>
      {meshIsStale ? (
        <FeedbackBanner
          kind="warning"
          message="Solver mesh was built from an older scene revision. Rebuild the shared-domain mesh to synchronize inspector data with backend solver state."
        />
      ) : null}
      <MeshResourceFields
        fields={[
          { label: "Summary state", value: summaryStatus },
          {
            label: "Scene revision",
            value: String(sceneRevision ?? "unknown"),
          },
          {
            label: "Source scene revision",
            value: String(meshSourceSceneRevision ?? "unknown"),
          },
          {
            label: "Mesh freshness",
            value: meshFreshness,
          },
          { label: "Mesh revision", value: String(meshRevision ?? "unknown") },
          {
            label: "Build revision",
            value: String(activeBuildRevision ?? "unknown"),
          },
          {
            label: "Semantic layers",
            value: semanticLayers,
          },
          {
            label: "Object policies",
            value: objectPolicyCount.toLocaleString("en-US"),
          },
          {
            label: "Resolved object targets",
            value: targetCount.toLocaleString("en-US"),
          },
        ]}
      />
    </InspectorSection>
  );
}

export function SolverMeshIdentitySection({
  badge,
  manifest,
}: {
  badge: string;
  manifest: {
    domain_mesh_mode?: string | null;
    generation_id?: string | null;
    geometry_realization_revision?: number | null;
    mesh_id?: string | null;
    mesh_name?: string | null;
    mesh_parts?: readonly unknown[] | null;
    object_segments?: readonly unknown[] | null;
    regions?: readonly unknown[] | null;
    source_scene_revision?: number | null;
  } | null | undefined;
}) {
  return (
    <InspectorSection value="identity" title="Solver Mesh Identity" badge={badge} collapsible defaultCollapsed={false}>
      <MeshResourceFields
        fields={[
          { label: "Mesh name", value: manifest?.mesh_name ?? "not built" },
          { label: "Mesh id", value: manifest?.mesh_id ?? "none" },
          {
            label: "Generation",
            value: manifest?.generation_id ?? "no generation",
          },
          {
            label: "Domain mode",
            value: manifest?.domain_mesh_mode ?? "not applicable",
          },
          {
            label: "Source scene",
            value: String(manifest?.source_scene_revision ?? "unknown"),
          },
          {
            label: "Geometry realization",
            value: String(manifest?.geometry_realization_revision ?? "unknown"),
          },
          {
            label: "Mesh parts",
            value: String(manifest?.mesh_parts?.length ?? 0),
          },
          {
            label: "Object segments",
            value: String(manifest?.object_segments?.length ?? 0),
          },
          { label: "Regions", value: String(manifest?.regions?.length ?? 0) },
        ]}
      />
    </InspectorSection>
  );
}

export function MeshCountsExtentsSection({
  edgeLength,
  meshStatistics,
  meshSummary,
}: {
  edgeLength: {
    max: number | null;
    mean: number | null;
    min: number | null;
    std: number | null;
  } | null;
  meshStatistics: unknown;
  meshSummary: unknown;
}) {
  return (
    <InspectorSection value="counts" title="Counts And Extents" collapsible defaultCollapsed={false}>
      <MeshResourceFields
        fields={[
          {
            label: "Nodes",
            value: formatCount(
              recordField(asRecord(meshSummary), "node_count") ??
                recordField(asRecord(meshStatistics), "node_count"),
            ),
          },
          {
            label: "Elements",
            value: formatCount(
              recordField(asRecord(meshSummary), "element_count") ??
                recordField(asRecord(meshStatistics), "element_count"),
            ),
          },
          {
            label: "Boundary faces",
            value: formatCount(
              recordField(asRecord(meshSummary), "boundary_face_count") ??
                recordField(asRecord(meshStatistics), "boundary_face_count"),
            ),
          },
          {
            label: "Min edge",
            value: formatLength(
              edgeLength?.min ?? recordField(asRecord(meshStatistics), "min_edge_length"),
            ),
          },
          {
            label: "Max edge",
            value: formatLength(
              edgeLength?.max ?? recordField(asRecord(meshStatistics), "max_edge_length"),
            ),
          },
          {
            label: "Mean edge",
            value: formatLength(
              edgeLength?.mean ?? recordField(asRecord(meshStatistics), "mean_edge_length"),
            ),
          },
        ]}
      />
    </InspectorSection>
  );
}
