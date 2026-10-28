"use client";

import type { SolutionSetArtifactResource } from "@/kernel/api/apiTypes";
import { useMaterializedDatasetResource } from "@/kernel/resources/solutionSetResources";
import {
  pinnedMaterializedDatasetSelectionRef,
  selectionRefEquals,
} from "@/kernel/selection/selectionTypes";
import type { ModuleProps } from "@/kernel/types";
import { Button } from "@/shared/ui/Button";

import {
  materializedDatasetMatchesArtifact,
  materializedDatasetMatchesPath,
} from "./savedMaterializedDatasetBinding";

export function SavedMaterializedArtifactRow({
  artifact, kernel, moduleId, projectId, runId, solutionSetId, revision,
  memberId, pageManifestMatches, selected, onSelect,
}: Pick<ModuleProps, "kernel" | "moduleId"> & {
  artifact: SolutionSetArtifactResource;
  projectId: string;
  runId: string;
  solutionSetId: string;
  revision: string;
  memberId: string;
  pageManifestMatches: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const metadata = useMaterializedDatasetResource(
    projectId, runId, solutionSetId, revision, memberId, artifact.artifact_id,
    { enabled: pageManifestMatches },
  );
  const error = metadata.error ?? metadata.refreshError;
  const matchesPath = materializedDatasetMatchesPath(
    metadata.data, projectId, runId, solutionSetId, revision, memberId, artifact.artifact_id,
  );
  const matchesArtifact = materializedDatasetMatchesArtifact(metadata.data, artifact);
  const verified = pageManifestMatches && metadata.status === "ready" &&
    metadata.data !== null && !error && matchesPath && matchesArtifact;
  const bindingError = pageManifestMatches && metadata.status === "ready" &&
    metadata.data !== null && (!matchesPath || !matchesArtifact);
  const data = verified ? metadata.data : null;
  const label = data
    ? data.field.descriptor.quantity_id + " [" + data.field.descriptor.unit + "]"
    : "Saved field";
  const status = !pageManifestMatches ? "Artifact page is not verified"
    : error ? "Metadata unavailable: " + error.message
      : bindingError ? "Manifest does not match this artifact"
        : verified ? "Manifest verified"
          : "Loading field metadata…";

  const inspect = () => {
    if (!verified || !data || !materializedDatasetMatchesArtifact(data, artifact)) return;
    const ref = pinnedMaterializedDatasetSelectionRef({
      artifactId: data.artifact_id,
      containingRevision: data.containing_solution_revision,
      datasetId: data.dataset.dataset_id,
      datasetRevision: data.dataset.revision,
      fieldId: data.field_id,
      itemId: data.item_id,
      manifestObjectRef: data.manifest_object_ref,
      memberId: data.member_id,
      projectId: data.project_id,
      runId: data.run_id,
      sampleId: data.sample_id,
      solutionSetId: data.solution_set_id,
    });
    kernel.selection.set({
      kind: ref.kind, label, nodeId: ref.nodeId, objectId: null, ref,
    }, moduleId);
    if (selectionRefEquals(kernel.selection.get().ref, ref)) {
      kernel.visualization.setSavedFieldPresentation(
        ref, data.field.descriptor.quantity_id, data.field.coverage.component_count,
      );
    }
  };

  return (
    <>
      <Button
        aria-current={selected ? "true" : undefined}
        className="h-auto min-w-0 flex-col items-start gap-1 px-2 py-2 text-left"
        size="sm"
        title={artifact.artifact_id + " · " + artifact.object_ref}
        variant={selected ? "primary" : "ghost"}
        onClick={onSelect}
      >
        <span className="min-w-0 truncate font-semibold">{label}</span>
        {data ? (
          <span className="min-w-0 text-fm-xs opacity-80">
            {data.field.coverage.total_elements} {data.field.descriptor.sample_location}
            {" · "}{data.field.coverage.component_count} components
          </span>
        ) : null}
        <span className="min-w-0 truncate text-fm-xs opacity-80">{artifact.artifact_id}</span>
      </Button>
      <p className={"m-0 text-fm-xs " + (error || bindingError ? "text-fm-danger" : "text-fm-muted")}
        role={error || bindingError ? "alert" : "status"}>{status}</p>
      {selected && verified ? (
        <Button className="justify-self-start" size="sm" variant="secondary" onClick={inspect}>
          Inspect pinned dataset
        </Button>
      ) : null}
    </>
  );
}
