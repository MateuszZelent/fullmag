"use client";

import { useState } from "react";

import type {
  MaterializedDatasetResource,
  SolutionSetArtifactResource,
  SolutionSetDiscoveryPageResource,
  SolutionSetRevision,
  SolutionScalarResource,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  isSolutionScalarArtifact,
  useMaterializedDatasetResource,
  useSolutionScalarResource,
  useSolutionSetArtifactsResource,
  useSolutionSetMembersResource,
  useSolutionSetResource,
} from "@/kernel/resources/solutionSetResources";
import { pinnedMaterializedDatasetSelectionRef } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";

const MATERIALIZED_DATASET_SCHEMA = "fullmag.materialized_dataset.v1";
const MEMBER_PAGE_LIMIT = 50;
const ARTIFACT_PAGE_LIMIT = 50;

type SolutionSetRef = SolutionSetDiscoveryPageResource["items"][number];

type BatchCaseResultsProps = {
  projectId: string;
  runId: string;
  solution: SolutionSetRef;
  onClose?: () => void;
};

export function BatchCaseResults({
  projectId,
  runId,
  solution,
  onClose,
}: BatchCaseResultsProps) {
  const kernel = useKernel();
  const [memberCursor, setMemberCursor] = useState<string | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [artifactCursor, setArtifactCursor] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);

  const solutionResource = useSolutionSetResource(
    projectId,
    runId,
    solution.solution_set_id,
    solution.revision as SolutionSetRevision,
  );
  const solutionManifestMatches =
    solutionResource.status === "ready" &&
    solutionResource.data?.manifest_digest === solution.manifest_digest;
  const manifestDigest = solutionManifestMatches ? solution.manifest_digest : null;

  const members = useSolutionSetMembersResource(
    projectId,
    runId,
    solution.solution_set_id,
    solution.revision as SolutionSetRevision,
    {
      enabled: manifestDigest !== null,
      query: {
        after_member_id: memberCursor,
        limit: MEMBER_PAGE_LIMIT,
      },
    },
  );
  const memberPage = members.data;
  const memberPageMatchesSolution = Boolean(
    manifestDigest &&
      memberPage &&
      memberPage.project_id === projectId &&
      memberPage.run_id === runId &&
      memberPage.solution_set_id === solution.solution_set_id &&
      memberPage.revision === solution.revision &&
      memberPage.manifest_digest === manifestDigest,
  );
  const selectedMember = memberPageMatchesSolution
    ? members.data?.items.find((member) => member.member_id === selectedMemberId) ?? null
    : null;

  const artifacts = useSolutionSetArtifactsResource(
    projectId,
    runId,
    solution.solution_set_id,
    solution.revision as SolutionSetRevision,
    selectedMember?.member_id,
    {
      enabled: manifestDigest !== null && selectedMember !== null,
      query: {
        after_artifact_id: artifactCursor,
        limit: ARTIFACT_PAGE_LIMIT,
      },
    },
  );
  const artifactPage = artifacts.data;
  const artifactPageMatchesSolution = Boolean(
    manifestDigest &&
      selectedMember &&
      artifactPage &&
      artifactPage.project_id === projectId &&
      artifactPage.run_id === runId &&
      artifactPage.solution_set_id === solution.solution_set_id &&
      artifactPage.revision === solution.revision &&
      artifactPage.member_id === selectedMember.member_id &&
      artifactPage.manifest_digest === manifestDigest,
  );
  const selectedArtifact = artifactPageMatchesSolution
    ? artifacts.data?.items.find((artifact) => artifact.artifact_id === selectedArtifactId) ?? null
    : null;
  const selectedDatasetArtifact = selectedArtifact && isMaterializedDatasetArtifact(selectedArtifact)
    ? selectedArtifact
    : null;
  const selectedScalarArtifact = selectedArtifact && isSolutionScalarArtifact(selectedArtifact)
    ? selectedArtifact
    : null;

  const metadata = useMaterializedDatasetResource(
    projectId,
    runId,
    solution.solution_set_id,
    solution.revision as SolutionSetRevision,
    selectedMember?.member_id,
    selectedDatasetArtifact?.artifact_id,
    { enabled: artifactPageMatchesSolution && selectedDatasetArtifact !== null },
  );
  const scalar = useSolutionScalarResource(
    projectId,
    runId,
    solution.solution_set_id,
    solution.revision as SolutionSetRevision,
    selectedMember?.member_id,
    selectedScalarArtifact?.artifact_id,
    selectedScalarArtifact && manifestDigest && artifactPageMatchesSolution
      ? {
          manifestDigest,
          objectRef: selectedScalarArtifact.object_ref,
          byteLength: selectedScalarArtifact.byte_length,
        }
      : null,
    { enabled: artifactPageMatchesSolution && selectedScalarArtifact !== null },
  );

  const metadataMatchesPath = materializedDatasetMatchesPath(
    metadata.data,
    projectId,
    runId,
    solution.solution_set_id,
    solution.revision,
    selectedMember?.member_id ?? null,
    selectedDatasetArtifact?.artifact_id ?? null,
  );
  const metadataMatchesArtifact = materializedDatasetMatchesArtifact(
    metadata.data,
    selectedDatasetArtifact,
  );
  const canInspectDataset = Boolean(
    solutionManifestMatches &&
      artifactPageMatchesSolution &&
      metadata.status === "ready" &&
      metadata.data?.integrity === "verified" &&
      metadataMatchesPath &&
      metadataMatchesArtifact,
  );
  const scalarMatchesArtifact = Boolean(
    scalar.data &&
      selectedScalarArtifact &&
      manifestDigest &&
      scalar.data.manifest_digest === manifestDigest &&
      scalar.data.object_ref === selectedScalarArtifact.object_ref &&
      scalar.data.byte_length === selectedScalarArtifact.byte_length,
  );

  const inspectDataset = () => {
    const data = metadata.data;
    if (!canInspectDataset || !data || !selectedDatasetArtifact || !selectedMember) return;

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
    kernel.selection.set(
      {
        kind: ref.kind,
        label: data.dataset.dataset_id,
        nodeId: ref.nodeId,
        objectId: null,
        ref,
      },
      "inspector",
    );
  };

  return (
    <section
      aria-label={`Results for ${solution.solution_set_id} revision ${solution.revision}`}
      className="grid min-w-0 gap-2 border-t border-fm-subtle pt-2"
    >
      <header className="flex min-w-0 items-center gap-2">
        <h4 className="m-0 min-w-0 flex-1 truncate text-fm-xs font-semibold text-fm-primary">
          {solution.solution_set_id} · revision {solution.revision}
        </h4>
        {onClose ? (
          <Button className="shrink-0" size="sm" variant="ghost" onClick={onClose}>
            Close results
          </Button>
        ) : null}
      </header>

      {solutionResource.status === "loading" && !solutionResource.data ? (
        <p className="m-0 text-fm-xs text-fm-muted" role="status">Verifying SolutionSet manifest…</p>
      ) : null}
      {solutionResource.error ? (
        <p className="m-0 text-fm-xs text-fm-danger" role="alert">
          Could not verify SolutionSet manifest: {solutionResource.error.message}
        </p>
      ) : null}
      {solutionResource.status === "ready" && !solutionManifestMatches ? (
        <p className="m-0 text-fm-xs text-fm-danger" role="alert">
          The SolutionSet manifest digest differs from the selected results entry.
        </p>
      ) : null}
      {solutionManifestMatches ? (
        <p className="m-0 break-all text-fm-xs text-fm-muted" role="status">
          Verified manifest {solution.manifest_digest}
        </p>
      ) : null}

      {members.data && manifestDigest && members.data.manifest_digest !== manifestDigest ? (
        <p className="m-0 text-fm-xs text-fm-danger" role="alert">
          Member page manifest digest differs from the selected SolutionSet revision.
        </p>
      ) : null}
      {members.status === "loading" && !members.data ? (
        <p className="m-0 text-fm-xs text-fm-muted" role="status">Loading case members…</p>
      ) : null}
      {members.error ? (
        <p className="m-0 text-fm-xs text-fm-danger" role="alert">
          Could not load case members: {members.error.message}
        </p>
      ) : null}
      {memberPageMatchesSolution && members.data ? (
        <>
          <ul aria-label="Result members" className="m-0 grid min-w-0 list-none gap-1 p-0">
            {members.data.items.map((member) => (
              <li className="grid min-w-0" key={member.member_id}>
                <Button
                  aria-current={selectedMemberId === member.member_id ? "true" : undefined}
                  className="h-auto min-w-0 justify-start px-2 py-1 text-left"
                  size="sm"
                  variant={selectedMemberId === member.member_id ? "primary" : "ghost"}
                  onClick={() => {
                    setSelectedMemberId(member.member_id);
                    setArtifactCursor(null);
                    setSelectedArtifactId(null);
                  }}
                >
                  <span className="min-w-0 truncate">
                    {member.member_id} · {member.task_id} · {member.stage_id}
                  </span>
                  <span className="ml-auto shrink-0 text-fm-xs opacity-80">
                    {member.execution_status}
                  </span>
                </Button>
                <p className="m-0 break-words pl-2 text-fm-xs text-fm-muted">
                  Attempt {member.attempt_id} · scientific {member.scientific_assessment.status}
                </p>
              </li>
            ))}
          </ul>
          {members.data.items.length === 0 ? (
            <p className="m-0 text-fm-xs text-fm-muted">This SolutionSet revision has no members.</p>
          ) : null}
          {members.data.next_after_member_id ? (
            <Button
              className="justify-self-start"
              size="sm"
              variant="secondary"
              onClick={() => {
                setMemberCursor(members.data?.next_after_member_id ?? null);
                setSelectedMemberId(null);
                setArtifactCursor(null);
                setSelectedArtifactId(null);
              }}
            >
              Next members
            </Button>
          ) : null}
        </>
      ) : null}

      {selectedMember ? (
        <section
          aria-label={`Artifacts for member ${selectedMember.member_id}`}
          className="grid min-w-0 gap-2 border-t border-fm-subtle pt-2"
        >
          <h5 className="m-0 text-fm-xs font-medium text-fm-primary">
            Artifacts for {selectedMember.member_id} · {selectedMember.artifact_count} total
          </h5>
          {artifacts.data && manifestDigest && artifacts.data.manifest_digest !== manifestDigest ? (
            <p className="m-0 text-fm-xs text-fm-danger" role="alert">
              Artifact page manifest digest differs from the selected SolutionSet revision.
            </p>
          ) : null}
          {artifactPageMatchesSolution && artifacts.data ? (
            <ul aria-label="Case result artifacts" className="m-0 grid min-w-0 list-none gap-1 p-0">
              {artifacts.data.items.map((artifact) => (
                <li className="grid min-w-0 gap-1" key={artifact.artifact_id}>
                  <Button
                    aria-current={selectedArtifactId === artifact.artifact_id ? "true" : undefined}
                    className="h-auto min-w-0 justify-start px-2 py-1 text-left"
                    size="sm"
                    variant={selectedArtifactId === artifact.artifact_id ? "primary" : "ghost"}
                    onClick={() => setSelectedArtifactId(artifact.artifact_id)}
                  >
                    <span className="min-w-0 truncate">{artifact.artifact_id}</span>
                    <span className="ml-auto shrink-0 text-fm-xs opacity-80">
                      {artifact.kind} · {artifact.integrity}
                    </span>
                  </Button>
                  <p className="m-0 break-words pl-2 text-fm-xs text-fm-muted">
                    {artifact.schema_id} · {artifact.byte_length} bytes
                    {artifact.scientific_evidence ? " · scientific evidence" : ""}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
          {artifacts.status === "loading" && !artifacts.data ? (
            <p className="m-0 text-fm-xs text-fm-muted" role="status">Loading case artifacts…</p>
          ) : null}
          {artifacts.error ? (
            <p className="m-0 text-fm-xs text-fm-danger" role="alert">
              Could not load case artifacts: {artifacts.error.message}
            </p>
          ) : null}
          {artifactPageMatchesSolution && artifacts.data?.items.length === 0 ? (
            <p className="m-0 text-fm-xs text-fm-muted">No artifacts are recorded for this member.</p>
          ) : null}
          {artifactPageMatchesSolution && artifacts.data?.next_after_artifact_id ? (
            <Button
              className="justify-self-start"
              size="sm"
              variant="secondary"
              onClick={() => {
                setArtifactCursor(artifacts.data?.next_after_artifact_id ?? null);
                setSelectedArtifactId(null);
              }}
            >
              Next artifacts
            </Button>
          ) : null}
        </section>
      ) : null}

      {selectedScalarArtifact ? (
        <section aria-label={`Scalar ${selectedScalarArtifact.artifact_id}`} className="grid min-w-0 gap-1">
          {scalar.status === "loading" && !scalar.data ? (
            <p className="m-0 text-fm-xs text-fm-muted" role="status">Verifying scalar artifact…</p>
          ) : null}
          {scalar.error ? (
            <p className="m-0 text-fm-xs text-fm-danger" role="alert">
              Could not verify scalar artifact: {scalar.error.message}
            </p>
          ) : null}
          {scalar.data && !scalarMatchesArtifact ? (
            <p className="m-0 text-fm-xs text-fm-danger" role="alert">
              Scalar payload does not match the selected artifact page entry.
            </p>
          ) : null}
          {scalarMatchesArtifact && scalar.data ? <SolutionScalarDetails data={scalar.data} /> : null}
        </section>
      ) : null}

      {selectedDatasetArtifact ? (
        <section aria-label={`Dataset ${selectedDatasetArtifact.artifact_id}`} className="grid min-w-0 gap-2">
          {metadata.status === "loading" && !metadata.data ? (
            <p className="m-0 text-fm-xs text-fm-muted" role="status">Verifying materialized dataset…</p>
          ) : null}
          {metadata.error ? (
            <p className="m-0 text-fm-xs text-fm-danger" role="alert">
              Could not verify materialized dataset: {metadata.error.message}
            </p>
          ) : null}
          {metadata.data && (!metadataMatchesPath || !metadataMatchesArtifact) ? (
            <p className="m-0 text-fm-xs text-fm-danger" role="alert">
              Verified dataset metadata does not match the selected artifact page entry.
            </p>
          ) : null}
          {canInspectDataset ? (
            <Button
              className="justify-self-start"
              size="sm"
              variant="secondary"
              onClick={inspectDataset}
            >
              Inspect pinned dataset
            </Button>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function isMaterializedDatasetArtifact(artifact: SolutionSetArtifactResource): boolean {
  return artifact.schema_id === MATERIALIZED_DATASET_SCHEMA && artifact.kind === "other";
}

function materializedDatasetMatchesPath(
  data: MaterializedDatasetResource | null,
  projectId: string,
  runId: string,
  solutionSetId: string,
  revision: string,
  memberId: string | null,
  artifactId: string | null,
): boolean {
  return Boolean(
    data &&
      memberId &&
      artifactId &&
      data.project_id === projectId &&
      data.run_id === runId &&
      data.solution_set_id === solutionSetId &&
      data.containing_solution_revision === revision &&
      data.member_id === memberId &&
      data.artifact_id === artifactId,
  );
}

function materializedDatasetMatchesArtifact(
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

function SolutionScalarDetails({ data }: { data: SolutionScalarResource }) {
  const assessment = data.scientific_assessment.reason
    ? `${data.scientific_assessment.status}: ${data.scientific_assessment.reason}`
    : data.scientific_assessment.status;
  return (
    <dl className="m-0 grid min-w-0 gap-1 text-fm-xs">
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <dt className="text-fm-muted">Quantity</dt>
        <dd className="m-0 min-w-0 truncate text-fm-primary" title={data.quantity_id}>{data.quantity_id}</dd>
      </div>
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <dt className="text-fm-muted">Attempt</dt>
        <dd className="m-0 min-w-0 truncate text-fm-primary" title={data.attempt_id}>{data.attempt_id}</dd>
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
        <dt className="text-fm-muted">Scientific</dt>
        <dd className="m-0 min-w-0 text-fm-primary">{assessment}</dd>
      </div>
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <dt className="text-fm-muted">Execution</dt>
        <dd className="m-0 min-w-0 text-fm-primary">
          solution {data.execution_status} · member {data.member_execution_status}
        </dd>
      </div>
    </dl>
  );
}
