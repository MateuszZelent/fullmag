import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  asRecord,
  formatCount,
  formatLength,
  MeshResourceFields,
  recordField,
} from "../MeshResourceView";

import { resolveMeshTopologyCounts } from "./meshTopologyCounts";
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
    <InspectorGroup title={title} badge={buildStatus} collapsible defaultOpen>
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
    </InspectorGroup>
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
    <InspectorGroup title="Solver Mesh Identity" badge={badge} collapsible defaultOpen>
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
    </InspectorGroup>
  );
}

export function MeshCountsExtentsSection({
  edgeLength,
  meshStatistics,
  topologyCounts,
}: {
  edgeLength: {
    max: number | null;
    mean: number | null;
    min: number | null;
    std: number | null;
  } | null;
  meshStatistics: unknown;
  topologyCounts: unknown;
}) {
  const counts = resolveMeshTopologyCounts(topologyCounts);
  return (
    <InspectorGroup title="Counts And Extents" collapsible defaultOpen>
      <MeshResourceFields
        fields={[
          {
            label: "Nodes",
            value: formatCount(counts?.node_count),
          },
          {
            label: "Elements",
            value: formatCount(counts?.element_count),
          },
          {
            label: "Boundary faces",
            value: formatCount(counts?.boundary_face_count),
          },
          {
            label: "Count source",
            value: counts ? "shared-domain manifest" : "not published",
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
    </InspectorGroup>
  );
}
