"use client";

import { useState } from "react";

import type { ModuleProps } from "@/kernel/types";
import { useProjectDocumentSnapshot } from "@/kernel/persistence/ProjectDocumentStatus";
import {
  useProjectRunsResource,
} from "@/kernel/resources/projectRunResources";
import {
  useMaterializedDatasetResource,
  useSolutionSetArtifactsResource,
  useSolutionSetDiscoveryResource,
  useSolutionSetMembersResource,
  useSolutionSetResource,
  isSolutionScalarArtifact,
  useSolutionScalarResource,
} from "@/kernel/resources/solutionSetResources";
import {
  pinnedMaterializedDatasetSelectionRef,
  type PinnedMaterializedDatasetSelectionRef,
} from "@/kernel/selection/selectionTypes";
import type {
  MaterializedDatasetResource,
  SolutionSetArtifactResource,
  SolutionSetDiscoveryPageResource,
  SolutionSetMemberResource,
  SolutionSetResource,
  SolutionScalarResource,
} from "@/kernel/api/apiTypes";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

const MATERIALIZED_DATASET_SCHEMA = "fullmag.materialized_dataset.v1";

type SavedResultsBrowserProps = Pick<ModuleProps, "kernel" | "moduleId">;

type SelectedSolution = Pick<
  SolutionSetResource,
  "solution_set_id" | "revision"
>;

export function SavedResultsBrowser({
  kernel,
  moduleId,
}: SavedResultsBrowserProps) {
  const project = useProjectDocumentSnapshot();

  if (project.state !== "ready") {
    return (
      <section
        aria-label="Saved results"
        className="fm-results-navigator__saved grid min-w-0 gap-3 p-3"
      >
        <header className="grid min-w-0 gap-1">
          <h2 className="m-0 text-fm-md font-semibold text-fm-primary">Saved results</h2>
          <p className="m-0 text-fm-xs text-fm-muted">
            Open a project before browsing durable SolutionSet revisions.
          </p>
        </header>
        <p className="m-0 text-fm-xs text-fm-muted" role="status">
          Project state: {project.state}.
        </p>
      </section>
    );
  }

  return (
    <SavedProjectResults
      key={project.resource.project_id}
      kernel={kernel}
      moduleId={moduleId}
      projectId={project.resource.project_id}
    />
  );
}

function SavedProjectResults({
  kernel,
  moduleId,
  projectId,
}: SavedResultsBrowserProps & { projectId: string }) {
  const [runCursor, setRunCursor] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const runs = useProjectRunsResource(projectId, runCursor);

  return (
    <section
      aria-label="Saved results"
      className="fm-results-navigator__saved grid min-w-0 gap-3 p-3"
    >
      <header className="grid min-w-0 gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="m-0 min-w-0 truncate text-fm-md font-semibold text-fm-primary">
            Saved results
          </h2>
          <Badge variant="secondary">project</Badge>
        </div>
        <p className="m-0 truncate text-fm-xs text-fm-muted" title={projectId}>
          {projectId}
        </p>
      </header>

      <section className="grid min-w-0 gap-2" aria-labelledby="saved-results-runs-heading">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <h3
            className="m-0 text-fm-xs font-semibold text-fm-primary"
            id="saved-results-runs-heading"
          >
            Runs
          </h3>
          <span className="text-fm-xs text-fm-muted">50 per page</span>
        </div>
        {runs.status === "loading" && !runs.data ? (
          <p className="m-0 text-fm-xs text-fm-muted" role="status">Loading runs…</p>
        ) : null}
        {runs.error ? (
          <p className="m-0 text-fm-xs text-fm-danger" role="alert">
            Could not load runs: {runs.error.message}
          </p>
        ) : null}
        {runs.data?.runs.length === 0 ? (
          <p className="m-0 text-fm-xs text-fm-muted">No saved runs in this project.</p>
        ) : null}
        <ul className="m-0 grid min-w-0 list-none gap-1 p-0" aria-label="Saved runs">
          {runs.data?.runs.map((run) => (
            <li className="grid min-w-0" key={run.run_id}>
            <Button
              aria-current={selectedRunId === run.run_id ? "true" : undefined}
              className="h-auto min-w-0 justify-start px-2 py-2 text-left"
              size="sm"
              title={run.run_id}
              variant={selectedRunId === run.run_id ? "primary" : "ghost"}
              onClick={() => setSelectedRunId(run.run_id)}
            >
              <span className="min-w-0 truncate">{run.run_id}</span>
              <span className="ml-auto shrink-0 text-fm-xs opacity-80">
                {run.catalog_state}
              </span>
            </Button>
            </li>
          ))}
        </ul>
        {runs.data?.next_cursor ? (
          <Button
            className="justify-self-start"
            size="sm"
            variant="secondary"
            onClick={() => {
              setSelectedRunId(null);
              setRunCursor(runs.data?.next_cursor ?? null);
            }}
          >
            Next runs
          </Button>
        ) : null}
      </section>

      {selectedRunId ? (
        <SavedRunResults
          key={`${projectId}:${selectedRunId}`}
          kernel={kernel}
          moduleId={moduleId}
          projectId={projectId}
          runId={selectedRunId}
        />
      ) : (
        <p className="m-0 text-fm-xs text-fm-muted" role="status">
          Select a run to browse its pinned SolutionSet revisions.
        </p>
      )}
    </section>
  );
}

function SavedRunResults({
  kernel,
  moduleId,
  projectId,
  runId,
}: SavedResultsBrowserProps & { projectId: string; runId: string }) {
  const [solutionCursor, setSolutionCursor] = useState<string | null>(null);
  const [selectedSolution, setSelectedSolution] = useState<SelectedSolution | null>(null);
  const discovery = useSolutionSetDiscoveryResource(projectId, runId, {
    query: {
      ...(solutionCursor ? { cursor: solutionCursor } : {}),
      limit: 25,
    },
  });
  const selectedDiscovery = selectedSolution
    ? discovery.data?.items.find(
        (item) =>
          item.solution_set_id === selectedSolution.solution_set_id &&
          item.revision === selectedSolution.revision,
      ) ?? null
    : null;
  const selectedSolutionResource = useSolutionSetResource(
    projectId,
    runId,
    selectedSolution?.solution_set_id,
    selectedSolution?.revision,
    { enabled: selectedSolution !== null },
  );
  const selectedManifestDigest =
    selectedDiscovery &&
    selectedSolutionResource.status === "ready" &&
    selectedSolutionResource.data?.manifest_digest === selectedDiscovery.manifest_digest
      ? selectedDiscovery.manifest_digest
      : null;

  return (
    <section
      aria-label={`Saved results for run ${runId}`}
      className="grid min-w-0 gap-3 border-t border-fm-subtle pt-3"
    >
      <header className="grid min-w-0 gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="m-0 min-w-0 truncate text-fm-sm font-semibold text-fm-primary">
            SolutionSets
          </h3>
          <Badge variant="secondary">run</Badge>
        </div>
        <p className="m-0 truncate text-fm-xs text-fm-muted" title={runId}>
          {runId}
        </p>
        {selectedSolution ? (
          <p className="m-0 text-fm-xs text-fm-accent" role="status">
            Selected solution: {selectedSolution.solution_set_id} · revision {selectedSolution.revision}
          </p>
        ) : null}
      </header>
      {discovery.status === "loading" && !discovery.data ? (
        <p className="m-0 text-fm-xs text-fm-muted" role="status">Loading SolutionSets…</p>
      ) : null}
      {discovery.error ? (
        <p className="m-0 text-fm-xs text-fm-danger" role="alert">
          Could not load SolutionSets: {discovery.error.message}
        </p>
      ) : null}
      <SolutionSetDiscoveryList
        data={discovery.data}
        selectedSolution={selectedSolution}
        onSelect={setSelectedSolution}
      />
      {discovery.data?.next_cursor ? (
        <Button
          className="justify-self-start"
          size="sm"
          variant="secondary"
          onClick={() => {
            setSelectedSolution(null);
            setSolutionCursor(discovery.data?.next_cursor ?? null);
          }}
        >
          Next SolutionSets
        </Button>
      ) : null}
      {selectedSolution ? (
        <SavedSolutionResults
          key={`${projectId}:${runId}:${selectedSolution.solution_set_id}:${selectedSolution.revision}`}
          kernel={kernel}
          moduleId={moduleId}
          projectId={projectId}
          runId={runId}
          solution={selectedSolution}
          manifestDigest={selectedManifestDigest}
          solutionResourceStatus={selectedSolutionResource.status}
        />
      ) : null}
    </section>
  );
}

function SolutionSetDiscoveryList({
  data,
  onSelect,
  selectedSolution,
}: {
  data: SolutionSetDiscoveryPageResource | null;
  onSelect: (solution: SelectedSolution) => void;
  selectedSolution: SelectedSolution | null;
}) {
  if (!data) return null;
  if (data.items.length === 0) {
    return (
      <p className="m-0 text-fm-xs text-fm-muted" role="status">
        No SolutionSets on this page.
      </p>
    );
  }
  return (
    <ul className="m-0 grid min-w-0 list-none gap-1 p-0" aria-label="SolutionSet revisions">
      {data.items.map((item) => {
        const isSelected = selectedSolution?.solution_set_id === item.solution_set_id &&
          selectedSolution.revision === item.revision;
        return (
          <li className="grid min-w-0" key={`${item.solution_set_id}:${item.revision}`}>
          <Button
            aria-current={isSelected ? "true" : undefined}
            className="h-auto min-w-0 justify-start px-2 py-2 text-left"
            size="sm"
            title={item.manifest_digest}
            variant={isSelected ? "primary" : "ghost"}
            onClick={() => onSelect(item)}
          >
            <span className="min-w-0 truncate">{item.solution_set_id}</span>
            <span className="ml-auto shrink-0 text-fm-xs opacity-80">
              rev {item.revision}
            </span>
          </Button>
          </li>
        );
      })}
    </ul>
  );
}

function SavedSolutionResults({
  kernel,
  moduleId,
  projectId,
  runId,
  solution,
  manifestDigest,
  solutionResourceStatus,
}: SavedResultsBrowserProps & {
  projectId: string;
  runId: string;
  solution: SelectedSolution;
  manifestDigest: string | null;
  solutionResourceStatus: string;
}) {
  const [memberCursor, setMemberCursor] = useState<string | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const members = useSolutionSetMembersResource(
    projectId,
    runId,
    solution.solution_set_id,
    solution.revision,
    {
      enabled: manifestDigest !== null,
      query: {
        ...(memberCursor ? { after_member_id: memberCursor } : {}),
        limit: 50,
      },
    },
  );

  return (
    <section
      aria-label={`Members of ${solution.solution_set_id} revision ${solution.revision}`}
      className="grid min-w-0 gap-3 border-t border-fm-subtle pt-3"
    >
      <header className="grid min-w-0 gap-1">
        <h4 className="m-0 min-w-0 truncate text-fm-xs font-semibold text-fm-primary">
          {solution.solution_set_id}
        </h4>
        <p className="m-0 text-fm-xs text-fm-muted">
          Exact revision {solution.revision} · manifest {manifestDigest ?? "pending verification"}
        </p>
      </header>
      {solutionResourceStatus === "loading" || manifestDigest === null ? (
        <p className="m-0 text-fm-xs text-fm-muted" role="status">
          Verifying the selected SolutionSet revision…
        </p>
      ) : null}
      {solutionResourceStatus === "error" ? (
        <p className="m-0 text-fm-xs text-fm-danger" role="alert">
          The selected SolutionSet revision could not be verified.
        </p>
      ) : null}
      {members.data && manifestDigest && members.data.manifest_digest !== manifestDigest ? (
        <p className="m-0 text-fm-xs text-fm-danger" role="alert">
          Member page manifest digest differs from the selected SolutionSet revision.
        </p>
      ) : null}
      {members.status === "loading" && !members.data ? (
        <p className="m-0 text-fm-xs text-fm-muted" role="status">Loading members…</p>
      ) : null}
      {members.error ? (
        <p className="m-0 text-fm-xs text-fm-danger" role="alert">
          Could not load members: {members.error.message}
        </p>
      ) : null}
      {manifestDigest && members.data?.manifest_digest === manifestDigest ? (
        <MemberList
          data={members.data.items}
          selectedMemberId={selectedMemberId}
          onSelect={setSelectedMemberId}
        />
      ) : null}
      {manifestDigest && members.data?.manifest_digest === manifestDigest && members.data.next_after_member_id ? (
        <Button
          className="justify-self-start"
          size="sm"
          variant="secondary"
          onClick={() => {
            setSelectedMemberId(null);
            setMemberCursor(members.data?.next_after_member_id ?? null);
          }}
        >
          Next members
        </Button>
      ) : null}
      {selectedMemberId ? (
        <SavedMemberArtifacts
          key={`${projectId}:${runId}:${solution.solution_set_id}:${solution.revision}:${selectedMemberId}`}
          kernel={kernel}
          moduleId={moduleId}
          projectId={projectId}
          runId={runId}
          solution={solution}
          manifestDigest={manifestDigest}
          memberId={selectedMemberId}
        />
      ) : (
        <p className="m-0 text-fm-xs text-fm-muted" role="status">
          Select a member to inspect its published artifacts.
        </p>
      )}
    </section>
  );
}

function MemberList({
  data,
  onSelect,
  selectedMemberId,
}: {
  data: SolutionSetMemberResource[];
  onSelect: (memberId: string) => void;
  selectedMemberId: string | null;
}) {
  if (data.length === 0) {
    return <p className="m-0 text-fm-xs text-fm-muted">No members on this page.</p>;
  }
  return (
    <ul className="m-0 grid min-w-0 list-none gap-1 p-0" aria-label="SolutionSet members">
      {data.map((member) => (
        <li className="grid min-w-0" key={member.member_id}>
        <Button
          aria-current={selectedMemberId === member.member_id ? "true" : undefined}
          className="h-auto min-w-0 justify-start px-2 py-2 text-left"
          size="sm"
          title={member.task_id}
          variant={selectedMemberId === member.member_id ? "primary" : "ghost"}
          onClick={() => onSelect(member.member_id)}
        >
          <span className="min-w-0 truncate">{member.member_id}</span>
          <span className="ml-auto shrink-0 text-fm-xs opacity-80">{member.stage_id}</span>
        </Button>
        </li>
      ))}
    </ul>
  );
}

function SavedMemberArtifacts({
  kernel,
  moduleId,
  projectId,
  runId,
  solution,
  manifestDigest,
  memberId,
}: SavedResultsBrowserProps & {
  projectId: string;
  runId: string;
  solution: SelectedSolution;
  manifestDigest: string | null;
  memberId: string;
}) {
  const [artifactCursor, setArtifactCursor] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const artifacts = useSolutionSetArtifactsResource(
    projectId,
    runId,
    solution.solution_set_id,
    solution.revision,
    memberId,
    {
      enabled: manifestDigest !== null,
      query: {
        ...(artifactCursor ? { after_artifact_id: artifactCursor } : {}),
        limit: 50,
      },
    },
  );
  const materializedArtifacts = (artifacts.data?.items ?? []).filter(
    isMaterializedDatasetArtifact,
  );
  const scalarArtifacts = (artifacts.data?.items ?? []).filter(
    isSolutionScalarArtifact,
  );
  const artifactPageMatchesSolution =
    manifestDigest !== null && artifacts.data?.manifest_digest === manifestDigest;
  const selectedArtifact = materializedArtifacts.find(
    (artifact) => artifact.artifact_id === selectedArtifactId,
  ) ?? null;
  const [selectedScalarArtifactId, setSelectedScalarArtifactId] = useState<string | null>(null);
  const selectedScalarArtifact = scalarArtifacts.find(
    (artifact) => artifact.artifact_id === selectedScalarArtifactId,
  ) ?? null;
  const metadata = useMaterializedDatasetResource(
    projectId,
    runId,
    solution.solution_set_id,
    solution.revision,
    memberId,
    selectedArtifactId,
    { enabled: selectedArtifactId !== null && artifactPageMatchesSolution },
  );
  const scalar = useSolutionScalarResource(
    projectId,
    runId,
    solution.solution_set_id,
    solution.revision,
    memberId,
    selectedScalarArtifact?.artifact_id,
    selectedScalarArtifact && artifactPageMatchesSolution && manifestDigest
      ? {
          manifestDigest,
          objectRef: selectedScalarArtifact.object_ref,
          byteLength: selectedScalarArtifact.byte_length,
        }
      : null,
    { enabled: selectedScalarArtifact !== null && artifactPageMatchesSolution },
  );
  const metadataMatchesSelection = materializedDatasetMatchesPath(
    metadata.data,
    projectId,
    runId,
    solution.solution_set_id,
    solution.revision,
    memberId,
    selectedArtifactId,
  );
  const scalarError = scalar.error ?? scalar.refreshError;
  const metadataMatchesSelectedArtifact = materializedDatasetMatchesArtifact(
    metadata.data,
    selectedArtifact,
  );
  const metadataBindingError =
    metadata.status === "ready" &&
    metadata.data !== null &&
    (!selectedArtifact || !metadataMatchesSelectedArtifact);
  const canInspect =
    metadata.status === "ready" &&
    metadata.data !== null &&
    artifactPageMatchesSolution &&
    metadataMatchesSelection &&
    metadataMatchesSelectedArtifact;
  const inspectSelected = () => {
    const data = metadata.data;
    if (
      !canInspect ||
      !data ||
      !selectedArtifact ||
      !materializedDatasetMatchesArtifact(data, selectedArtifact)
    ) return;
    const ref: PinnedMaterializedDatasetSelectionRef =
      pinnedMaterializedDatasetSelectionRef({
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
    kernel.selection.set(
      {
        kind: ref.kind,
        label: data.dataset.dataset_id,
        nodeId: ref.nodeId,
        objectId: null,
        ref,
      },
      moduleId,
    );
  };

  return (
    <section
      aria-label={`Artifacts for member ${memberId}`}
      className="grid min-w-0 gap-2 border-t border-fm-subtle pt-3"
    >
      <header className="grid min-w-0 gap-1">
        <h5 className="m-0 min-w-0 truncate text-fm-xs font-semibold text-fm-primary">
          Materialized fields
        </h5>
        <p className="m-0 text-fm-xs text-fm-muted">
          Choose a saved field to verify its manifest and inspect its source.
        </p>
      </header>
      {artifacts.status === "loading" && !artifacts.data ? (
        <p className="m-0 text-fm-xs text-fm-muted" role="status">Loading artifacts…</p>
      ) : null}
      {artifacts.error ? (
        <p className="m-0 text-fm-xs text-fm-danger" role="alert">
          Could not load artifacts: {artifacts.error.message}
        </p>
      ) : null}
      {artifacts.data && !artifactPageMatchesSolution ? (
        <p className="m-0 text-fm-xs text-fm-danger" role="alert">
          Artifact page manifest digest differs from the selected SolutionSet revision.
        </p>
      ) : null}
      {artifactPageMatchesSolution && materializedArtifacts.length === 0 ? (
        <p className="m-0 text-fm-xs text-fm-muted">
          No materialized dataset artifact on this page.
        </p>
      ) : artifactPageMatchesSolution ? (
        <ul className="m-0 grid min-w-0 list-none gap-1 p-0" aria-label="Materialized dataset artifacts">
          {materializedArtifacts.map((artifact) => (
            <li className="grid min-w-0" key={artifact.artifact_id}>
            <ArtifactButton
              artifact={artifact}
              selected={selectedArtifactId === artifact.artifact_id}
              onSelect={() => setSelectedArtifactId(artifact.artifact_id)}
            />
            </li>
          ))}
        </ul>
      ) : null}
      {artifactPageMatchesSolution && artifacts.data?.next_after_artifact_id ? (
        <Button
          className="justify-self-start"
          size="sm"
          variant="secondary"
          onClick={() => {
            setSelectedArtifactId(null);
            setSelectedScalarArtifactId(null);
            setArtifactCursor(artifacts.data?.next_after_artifact_id ?? null);
          }}
        >
          Next artifacts
        </Button>
      ) : null}
      {selectedArtifactId ? (
        <div className="grid min-w-0 gap-2">
          {metadataBindingError ? (
            <p className="m-0 text-fm-xs text-fm-danger" role="alert">
              The verified manifest does not match the selected artifact page entry; Inspector is blocked.
            </p>
          ) : null}
          <p className="m-0 text-fm-xs text-fm-muted" role="status">
            {metadataBindingError
              ? "Manifest verification failed against the current artifact entry."
              : metadata.status === "loading"
              ? "Verifying the selected manifest…"
              : metadata.status === "ready"
                ? "Manifest verified. Open Inspector to view its details."
                : metadata.error
                  ? `Manifest unavailable: ${metadata.error.message}`
                  : "Select the verified manifest to open its Inspector details."}
          </p>
          {canInspect ? (
            <Button
              className="justify-self-start"
              size="sm"
              variant="secondary"
              onClick={inspectSelected}
            >
              Inspect pinned dataset
            </Button>
          ) : null}
        </div>
      ) : null}
      <section className="grid min-w-0 gap-2 border-t border-fm-subtle pt-2" aria-label={`Scalar artifacts for member ${memberId}`}>
        <header className="grid min-w-0 gap-1">
          <h6 className="m-0 min-w-0 truncate text-fm-xs font-semibold text-fm-primary">
            Scalar values
          </h6>
          <p className="m-0 text-fm-xs text-fm-muted">
            Read-only values from the selected historical SolutionSet artifact.
          </p>
        </header>
        {artifactPageMatchesSolution && scalarArtifacts.length === 0 ? (
          <p className="m-0 text-fm-xs text-fm-muted">
            No scalar artifact on this page.
          </p>
        ) : artifactPageMatchesSolution ? (
          <ul className="m-0 grid min-w-0 list-none gap-1 p-0" aria-label="Scalar artifacts">
            {scalarArtifacts.map((artifact) => (
              <li className="grid min-w-0" key={artifact.artifact_id}>
                <ArtifactButton
                  artifact={artifact}
                  selected={selectedScalarArtifactId === artifact.artifact_id}
                  onSelect={() => setSelectedScalarArtifactId(artifact.artifact_id)}
                />
              </li>
            ))}
          </ul>
        ) : null}
        {selectedScalarArtifactId ? (
          <div className="grid min-w-0 gap-2" aria-live="polite">
            {!selectedScalarArtifact ? (
              <p className="m-0 text-fm-xs text-fm-danger" role="alert">
                The selected scalar is no longer present on the current artifact page.
              </p>
            ) : null}
            {scalar.status === "loading" && !scalar.data ? (
              <p className="m-0 text-fm-xs text-fm-muted" role="status">
                Verifying the selected scalar artifact…
              </p>
            ) : null}
            {scalarError ? (
              <p className="m-0 text-fm-xs text-fm-danger" role="alert">
                Scalar unavailable: {scalarError.message}
              </p>
            ) : null}
            {scalar.status === "ready" && !scalarError && scalar.data ? <SolutionScalarDetails data={scalar.data} /> : null}
          </div>
        ) : null}
      </section>
    </section>
  );
}

function ArtifactButton({
  artifact,
  onSelect,
  selected,
}: {
  artifact: SolutionSetArtifactResource;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <Button
      aria-current={selected ? "true" : undefined}
      className="h-auto min-w-0 justify-start px-2 py-2 text-left"
      size="sm"
      title={artifact.object_ref}
      variant={selected ? "primary" : "ghost"}
      onClick={onSelect}
    >
      <span className="min-w-0 truncate">{artifact.artifact_id}</span>
      <span className="ml-auto shrink-0 text-fm-xs opacity-80">{artifact.kind}</span>
    </Button>
  );
}

export function isMaterializedDatasetArtifact(
  artifact: SolutionSetArtifactResource,
): boolean {
  return artifact.schema_id === MATERIALIZED_DATASET_SCHEMA && artifact.kind === "other";
}

function SolutionScalarDetails({ data }: { data: SolutionScalarResource }) {
  const assessment = data.scientific_assessment.reason
    ? `${data.scientific_assessment.status}: ${data.scientific_assessment.reason}`
    : data.scientific_assessment.status;
  const memberAssessment = data.member_scientific_assessment.reason
    ? `${data.member_scientific_assessment.status}: ${data.member_scientific_assessment.reason}`
    : data.member_scientific_assessment.status;
  return (
    <dl className="m-0 grid min-w-0 gap-1 text-fm-xs">
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <dt className="text-fm-muted">Quantity</dt>
        <dd className="m-0 min-w-0 truncate text-fm-primary" title={data.quantity_id}>
          {data.quantity_id}
        </dd>
      </div>
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <dt className="text-fm-muted">Value</dt>
        <dd className="m-0 min-w-0 text-fm-primary">{data.value_si} {data.unit}</dd>
      </div>
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <dt className="text-fm-muted">Step / time</dt>
        <dd className="m-0 min-w-0 text-fm-primary">{data.step} / {data.time_s} s</dd>
      </div>
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <dt className="text-fm-muted">Integrity</dt>
        <dd className="m-0 min-w-0 text-fm-primary">{data.integrity} · manifest {data.manifest_state}</dd>
      </div>
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <dt className="text-fm-muted">Execution</dt>
        <dd className="m-0 min-w-0 text-fm-primary">solution {data.execution_status} · member {data.member_execution_status}</dd>
      </div>
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <dt className="text-fm-muted">Scientific</dt>
        <dd className="m-0 min-w-0 text-fm-primary">{assessment}</dd>
      </div>
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <dt className="text-fm-muted">Member assessment</dt>
        <dd className="m-0 min-w-0 text-fm-primary">{memberAssessment}</dd>
      </div>
      {data.accepted_state ? (
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2">
          <dt className="text-fm-muted">Accepted state</dt>
          <dd
            className="m-0 min-w-0 truncate text-fm-primary"
            title={data.accepted_state.state_digest}
          >
            step {data.accepted_state.accepted_step} · stage {data.accepted_state.stage_id ?? "—"}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

export function materializedDatasetMatchesArtifact(
  data: MaterializedDatasetResource | null,
  artifact: SolutionSetArtifactResource | null,
): boolean {
  return Boolean(
    data &&
      artifact &&
      data.artifact_id === artifact.artifact_id &&
      data.manifest_object_ref === artifact.object_ref &&
      data.manifest_byte_length === artifact.byte_length,
  );
}

function materializedDatasetMatchesPath(
  data: MaterializedDatasetResource | null,
  projectId: string,
  runId: string,
  solutionSetId: string,
  revision: string,
  memberId: string,
  artifactId: string | null,
): boolean {
  return Boolean(
    data &&
      artifactId &&
      data.project_id === projectId &&
      data.run_id === runId &&
      data.solution_set_id === solutionSetId &&
      data.containing_solution_revision === revision &&
      data.member_id === memberId &&
      data.artifact_id === artifactId,
  );
}
