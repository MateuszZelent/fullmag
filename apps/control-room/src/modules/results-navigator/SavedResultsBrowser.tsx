"use client";

import { useState } from "react";

import type { ModuleProps } from "@/kernel/types";
import { useProjectDocumentSnapshot } from "@/kernel/persistence/ProjectDocumentStatus";
import {
  useProjectRunResource,
  useProjectRunsResource,
} from "@/kernel/resources/projectRunResources";
import {
  useSolutionSetArtifactsResource,
  useSolutionSetDiscoveryResource,
  useSolutionSetMembersResource,
  useSolutionSetResource,
  isSolutionScalarArtifact,
  useSolutionScalarResource,
} from "@/kernel/resources/solutionSetResources";
import type {
  SolutionSetArtifactResource,
  SolutionSetDiscoveryPageResource,
  SolutionSetMemberResource,
  SolutionSetResource,
  SolutionScalarResource,
} from "@/kernel/api/apiTypes";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

import { SavedMaterializedArtifactRow } from "./SavedMaterializedArtifactRow";
export { materializedDatasetMatchesArtifact } from "./savedMaterializedDatasetBinding";

const MATERIALIZED_FIELDS_PER_PAGE = 4;
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
  const runsError = runs.error ?? runs.refreshError;

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
          <Button size="sm" variant="ghost" aria-label="Refresh saved runs" onClick={runs.refetch}>
            Refresh runs
          </Button>
        </div>
        {runs.status === "loading" && !runs.data ? (
          <p className="m-0 text-fm-xs text-fm-muted" role="status">Loading runs…</p>
        ) : null}
        {runsError ? (
          <p className="m-0 text-fm-xs text-fm-danger" role="alert">
            Could not load runs: {runsError.message}{runs.data ? " Previously loaded runs are still shown." : ""}
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
  const run = useProjectRunResource(projectId, runId);
  const runError = run.error ?? run.refreshError;
  const [solutionCursor, setSolutionCursor] = useState<string | null>(null);
  const [selectedSolution, setSelectedSolution] = useState<SelectedSolution | null>(null);
  const discovery = useSolutionSetDiscoveryResource(projectId, runId, {
    query: {
      ...(solutionCursor ? { cursor: solutionCursor } : {}),
      limit: 25,
    },
  });
  const discoveryError = discovery.error ?? discovery.refreshError;
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
      <section aria-label="Selected saved run execution" className="fm-saved-run-execution grid min-w-0 gap-2">
        <p className="m-0 text-fm-xs text-fm-muted">
          This saved run is independent of the live session shown in the footer.
          A completed task does not by itself confirm that a field is available.
        </p>
        <Button size="sm" variant="secondary" className="justify-self-start"
          aria-label="Refresh selected run and saved results" onClick={() => {
            void run.refetch();
            void discovery.refetch();
          }}>
          Refresh run and results
        </Button>
        {run.status === "loading" && !run.data ? <p role="status">Loading task execution…</p> : null}
        {runError ? <p role="alert">Could not refresh task execution: {runError.message}</p> : null}
        {run.data?.tasks.map(task => <div key={task.task_id} className="fm-saved-run-task grid min-w-0 gap-1 text-fm-xs">
          <span>Task execution: {task.lifecycle}</span>
          <span className="truncate text-fm-muted" title={task.task_id}>{task.task_id}</span>
          {task.readiness.state === "blocked" ? <span>Blocked: {task.readiness.reason}</span> : null}
        </div>)}
        {run.data?.tasks.length === 0 ? <p role="status">No tasks have been materialized.</p> : null}
      </section>
      {discovery.status === "loading" && !discovery.data ? (
        <p className="m-0 text-fm-xs text-fm-muted" role="status">Loading SolutionSets…</p>
      ) : null}
      {discoveryError ? (
        <p className="m-0 text-fm-xs text-fm-danger" role="alert">
          Could not load SolutionSets: {discoveryError.message}{discovery.data ? " Previously loaded results are still shown." : ""}
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
  const [fieldPage, setFieldPage] = useState(0);
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
  const fieldPageCount = Math.ceil(materializedArtifacts.length / MATERIALIZED_FIELDS_PER_PAGE);
  const currentFieldPage = Math.min(fieldPage, Math.max(0, fieldPageCount - 1));
  const visibleMaterializedArtifacts = materializedArtifacts.slice(
    currentFieldPage * MATERIALIZED_FIELDS_PER_PAGE,
    (currentFieldPage + 1) * MATERIALIZED_FIELDS_PER_PAGE,
  );
  const [selectedScalarArtifactId, setSelectedScalarArtifactId] = useState<string | null>(null);
  const selectedScalarArtifact = scalarArtifacts.find(
    (artifact) => artifact.artifact_id === selectedScalarArtifactId,
  ) ?? null;
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
  const scalarError = scalar.error ?? scalar.refreshError;

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
          Choose a saved field by quantity and unit, then inspect its source.
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
          {visibleMaterializedArtifacts.map((artifact) => (
            <li className="grid min-w-0 gap-2" key={artifact.artifact_id}>
              <SavedMaterializedArtifactRow
                artifact={artifact}
                kernel={kernel}
                moduleId={moduleId}
                projectId={projectId}
                runId={runId}
                solutionSetId={solution.solution_set_id}
                revision={solution.revision}
                memberId={memberId}
                pageManifestMatches={artifactPageMatchesSolution}
                selected={selectedArtifactId === artifact.artifact_id}
                onSelect={() => setSelectedArtifactId(artifact.artifact_id)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {artifactPageMatchesSolution && fieldPageCount > 1 ? (
        <nav className="flex items-center gap-2" aria-label="Materialized field pages">
          <Button size="sm" variant="ghost" disabled={currentFieldPage === 0}
            onClick={() => setFieldPage(currentFieldPage - 1)}>Previous fields</Button>
          <span className="text-fm-xs text-fm-muted">Fields page {currentFieldPage + 1} / {fieldPageCount}</span>
          <Button size="sm" variant="ghost" disabled={currentFieldPage + 1 >= fieldPageCount}
            onClick={() => setFieldPage(currentFieldPage + 1)}>Next fields</Button>
        </nav>
      ) : null}
      {artifactPageMatchesSolution && artifacts.data?.next_after_artifact_id ? (
        <Button
          className="justify-self-start"
          size="sm"
          variant="secondary"
          onClick={() => {
            setSelectedArtifactId(null);
            setSelectedScalarArtifactId(null);
            setFieldPage(0);
            setArtifactCursor(artifacts.data?.next_after_artifact_id ?? null);
          }}
        >
          Next artifacts
        </Button>
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
