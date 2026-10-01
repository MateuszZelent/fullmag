"use client";

import type { MaterializedDatasetResource } from "@/kernel/api/apiTypes";
import { useProjectDocumentSnapshot } from "@/kernel/persistence/ProjectDocumentStatus";
import { useMaterializedDatasetResource } from "@/kernel/resources/solutionSetResources";
import type { PinnedMaterializedDatasetSelectionRef, Selection } from "@/kernel/selection/selectionTypes";
import { Badge } from "@/shared/ui/Badge";

import { InspectorGroup } from "../primitives/InspectorGroup";
import type { InspectorPanelProps } from "../inspectorTypes";
import { MaterializedDatasetValues } from "./MaterializedDatasetValues";

export function MaterializedDatasetInspectorPanel({ selection }: InspectorPanelProps) {
  const ref = materializedDatasetSelection(selection);
  const project = useProjectDocumentSnapshot();
  const activeProjectId = project.state === "ready" ? project.resource.project_id : null;
  const projectMatchesSelection =
    ref !== null && materializedDatasetSelectionMatchesProject(ref, activeProjectId);
  const resource = useMaterializedDatasetResource(
    ref?.projectId,
    ref?.runId,
    ref?.solutionSetId,
    ref?.containingRevision,
    ref?.memberId,
    ref?.artifactId,
    { enabled: projectMatchesSelection },
  );

  if (!ref) {
    return <p className="m-0 text-fm-xs text-fm-danger" role="alert">Pinned dataset selection is missing.</p>;
  }
  if (!projectMatchesSelection) {
    return (
      <p className="m-0 text-fm-xs text-fm-danger" role="alert">
        The pinned dataset belongs to project {ref.projectId}, but the active project is
        {activeProjectId ? ` ${activeProjectId}` : " unavailable"}. Open the owning project to inspect it.
      </p>
    );
  }
  if (resource.status === "loading" && !resource.data) {
    return <p className="m-0 text-fm-xs text-fm-muted" role="status">Verifying pinned materialized dataset…</p>;
  }
  if (resource.error) {
    return (
      <p className="m-0 text-fm-xs text-fm-danger" role="alert">
        Could not load the pinned materialized dataset: {resource.error.message}
      </p>
    );
  }
  if (!resource.data) {
    return <p className="m-0 text-fm-xs text-fm-muted" role="status">Materialized dataset is unavailable.</p>;
  }
  if (!materializedDatasetSelectionMatches(ref, resource.data)) {
    return (
      <p className="m-0 text-fm-xs text-fm-danger" role="alert">
        The returned manifest does not match the selected immutable identity.
      </p>
    );
  }

  const data = resource.data;
  return (
    <div className="grid min-w-0 gap-3" data-materialized-dataset-inspector="readonly">
      <InspectorGroup title="Pinned identity">
        <ReadonlyGrid
          rows={[
            ["Project", data.project_id],
            ["Run", data.run_id],
            ["SolutionSet", data.solution_set_id],
            ["Containing revision", data.containing_solution_revision],
            ["Owner revision", data.owner_solution_revision],
            ["Member", data.member_id],
            ["Manifest root", data.manifest_object_ref],
          ]}
        />
      </InspectorGroup>

      <InspectorGroup title="Dataset status">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="success">Integrity {data.integrity}</Badge>
          <Badge variant="secondary">Availability {data.dataset.status.availability}</Badge>
          <Badge variant="secondary">Execution {data.owner_execution_status}</Badge>
          <Badge variant="secondary">Assessment {data.owner_scientific_assessment.status}</Badge>
        </div>
        <ReadonlyGrid
          rows={[
            ["Dataset", `${data.dataset.dataset_id} · revision ${data.dataset.revision}`],
            ["Definition", `${data.definition.definition_id} · revision ${data.definition.revision}`],
            ["Scientific reason", data.owner_scientific_assessment.reason ?? "—"],
            ["Evidence artifacts", String(data.owner_scientific_assessment.evidence_artifact_count)],
          ]}
        />
      </InspectorGroup>

      <InspectorGroup title="Field semantics">
        <ReadonlyGrid
          rows={[
            ["Sample / item / field", `${data.sample_id} / ${data.item_id} / ${data.field_id}`],
            ["Quantity", data.field.descriptor.quantity_id],
            ["Unit", data.field.descriptor.unit],
            ["Frame", `${data.field.descriptor.frame.kind} · ${data.field.descriptor.frame.frame_id}`],
            ["Support", data.field.descriptor.active_support.support_fingerprint],
            ["Function space", formatFunctionSpace(data.field.descriptor.function_space)],
            ["Plane / representation", `${data.field.plane} / ${data.field.descriptor.value_representation}`],
            ["Normalization", data.field.descriptor.normalization],
            ["Complex encoding", data.field.descriptor.complex_encoding],
          ]}
        />
      </InspectorGroup>

      <InspectorGroup title="Coverage and provenance">
        <ReadonlyGrid
          rows={[
            ["Dtype / endian", `${data.field.coverage.dtype} / ${data.field.coverage.endian}`],
            ["Elements / components", `${data.field.coverage.total_elements} / ${data.field.coverage.component_count}`],
            ["Bytes / chunks", `${data.field.coverage.total_bytes} / ${data.field.coverage.chunk_count}`],
            ["Tensor artifact", data.field.tensor_artifact.artifact_id],
            ["Tensor object", data.field.tensor_artifact.object_ref],
            ["RunSpec digest", data.source.run_spec_digest],
            ["Source member / artifact", `${data.source.member_id} / ${data.source.artifact_id}`],
            ["Source tensor", data.source.tensor_object_ref],
          ]}
        />
      </InspectorGroup>

      <MaterializedDatasetValues key={JSON.stringify(ref)} dataset={data} />
    </div>
  );
}

export function materializedDatasetSelection(
  selection: Selection,
): PinnedMaterializedDatasetSelectionRef | null {
  return selection.ref?.type === "materialized-dataset" ? selection.ref : null;
}

export function materializedDatasetSelectionMatches(
  ref: PinnedMaterializedDatasetSelectionRef,
  data: MaterializedDatasetResource,
): boolean {
  return (
    data.project_id === ref.projectId &&
    data.run_id === ref.runId &&
    data.solution_set_id === ref.solutionSetId &&
    data.containing_solution_revision === ref.containingRevision &&
    data.member_id === ref.memberId &&
    data.artifact_id === ref.artifactId &&
    data.manifest_object_ref === ref.manifestObjectRef &&
    data.sample_id === ref.sampleId &&
    data.item_id === ref.itemId &&
    data.field_id === ref.fieldId &&
    data.dataset.dataset_id === ref.datasetId &&
    data.dataset.revision === ref.datasetRevision
  );
}

export function materializedDatasetSelectionMatchesProject(
  ref: PinnedMaterializedDatasetSelectionRef,
  activeProjectId: string | null,
): boolean {
  return activeProjectId === ref.projectId;
}

function formatFunctionSpace(
  functionSpace: MaterializedDatasetResource["field"]["descriptor"]["function_space"],
): string {
  if (!functionSpace) return "—";
  return `${functionSpace.family} ${functionSpace.order} · ${functionSpace.space_id} · ${functionSpace.ordering}`;
}

function ReadonlyGrid({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="grid min-w-0 gap-1 text-fm-xs">
      {rows.map(([label, value]) => (
        <div className="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-2" key={label}>
          <dt className="text-fm-muted">{label}</dt>
          <dd className="m-0 min-w-0 break-words text-fm-primary">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
