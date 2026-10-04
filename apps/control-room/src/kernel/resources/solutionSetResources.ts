"use client";

import { useCallback, useMemo } from "react";

import {
  assertMaterializedDatasetPathId,
  assertSolutionSetLogicalId,
  assertSolutionSetMemberId,
  assertSolutionSetProjectId,
  assertSolutionSetRevision,
  assertSolutionSetRunId,
} from "../api/ControlRoomApi";
import { isCanonicalU64Decimal } from "../api/fieldQueryIdentity";
import type {
  MaterializedDatasetResource,
  SolutionSetDiscoveryPageResource,
  SolutionSetDiscoveryPageQuery,
  SolutionSetArtifactPageQuery,
  SolutionSetArtifactPageResource,
  SolutionSetArtifactResource,
  SolutionSetMemberPageQuery,
  SolutionSetMemberPageResource,
  SolutionSetResource,
  SolutionSetRevision,
  SolutionScalarResource,
} from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";
import type { ResourceResult } from "./resourceTypes";

export interface SolutionSetResourceOptions {
  enabled?: boolean;
}

export interface SolutionSetMemberPageResourceOptions
  extends SolutionSetResourceOptions {
  query?: SolutionSetMemberPageQuery;
}

export interface SolutionSetArtifactPageResourceOptions
  extends SolutionSetResourceOptions {
  query?: SolutionSetArtifactPageQuery;
}

export interface SolutionScalarArtifactBinding {
  manifestDigest: string;
  objectRef: string;
  byteLength: string;
}

export type SolutionSetRequestIdentity = {
  projectId: string;
  runId: string;
  solutionSetId: string;
  revision: string;
};

type SolutionSetIdentity = {
  project_id: string;
  run_id: string;
  solution_set_id: string;
  revision: string;
  schema_version: string;
  manifest_digest: string;
};

export const SOLUTION_SET_SCHEMA_VERSION =
  "fullmag.analysis.solution_revision.v1" as const;
export const SOLUTION_SCALAR_SCHEMA_VERSION =
  "fullmag.analysis.solution_scalar.v1" as const;
export const SOLUTION_SCALAR_ARTIFACT_SCHEMA =
  "fullmag.study.scalar_json@v1" as const;

const SOLUTION_SET_MANIFEST_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SOLUTION_SCALAR_OBJECT_REF_PATTERN = /^[a-f0-9]{64}$/;
const SOLUTION_SCALAR_BYTE_LIMIT = 64 * 1024;
const SOLUTION_EXECUTION_STATUSES = new Set([
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
const SOLUTION_ASSESSMENT_STATUSES = new Set([
  "converged",
  "tolerance_not_met",
  "limit_reached",
  "invalid",
  "unassessed",
]);

const EMPTY_RESOURCE_KEY = "solution-set:none";

export function solutionSetDiscoveryResourceKey(
  projectId: string,
  runId: string,
  query: SolutionSetDiscoveryPageQuery = {},
): string {
  return `solution-set-discovery:${encodeURIComponent(projectId)}:${encodeURIComponent(runId)}:${encodeURIComponent(query.cursor ?? "")}:${query.limit ?? 25}`;
}

export function validateSolutionSetDiscoveryEnvelope(
  data: SolutionSetDiscoveryPageResource,
  projectId: string,
  runId: string,
  query: SolutionSetDiscoveryPageQuery = {},
): SolutionSetDiscoveryPageResource {
  if (data.schema_version !== "fullmag.analysis.solution_set_discovery.v1" ||
    data.project_id !== projectId || data.run_id !== runId ||
    data.items.length > (query.limit ?? 25) ||
    (data.next_cursor != null &&
      (data.next_cursor === query.cursor || data.next_cursor.length > 4096 ||
        !/^[A-Za-z0-9_-]+$/.test(data.next_cursor)))) {
    throw new Error("Solution discovery response does not match the requested page.");
  }
  const ids = new Set<string>();
  for (const item of data.items) {
    assertSolutionSetLogicalId(item.solution_set_id);
    assertSolutionSetRevision(item.revision);
    if (ids.has(item.solution_set_id) ||
      !SOLUTION_SET_MANIFEST_DIGEST_PATTERN.test(item.manifest_digest)) {
      throw new Error("Solution discovery page contains inconsistent pinned references.");
    }
    ids.add(item.solution_set_id);
  }
  return data;
}

export function useSolutionSetDiscoveryResource(
  projectId: string | null | undefined,
  runId: string | null | undefined,
  options: SolutionSetResourceOptions & { query?: SolutionSetDiscoveryPageQuery } = {},
): ResourceResult<SolutionSetDiscoveryPageResource | null> {
  const { api } = useKernel();
  const cursor = options.query?.cursor ?? undefined;
  const limit = options.query?.limit ?? 25;
  const identity = useMemo(() => {
    if (!projectId || !runId || !Number.isInteger(limit) || limit < 1 || limit > 50 ||
      (cursor !== undefined && (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)))) return null;
    try {
      return {
        projectId: assertSolutionSetProjectId(projectId),
        runId: assertSolutionSetRunId(runId),
        query: { cursor, limit },
      };
    } catch {
      return null;
    }
  }, [projectId, runId, cursor, limit]);
  const load = useCallback(({ signal }: { signal: AbortSignal }) => {
    if (!identity) return Promise.resolve(null);
    return api.persistence.projects.solutionSets(
      identity.projectId, identity.runId, identity.query, { signal },
    ).then((data) => validateSolutionSetDiscoveryEnvelope(
      data, identity.projectId, identity.runId, identity.query,
    ));
  }, [api, identity]);
  return useResource<SolutionSetDiscoveryPageResource | null>({
    abortStaleInflight: true,
    enabled: identity !== null && options.enabled !== false,
    load,
    resourceKey: identity
      ? solutionSetDiscoveryResourceKey(identity.projectId, identity.runId, identity.query)
      : "solution-set-discovery:none",
    resolveRevision: (data) => data ? JSON.stringify([data.items, data.next_cursor]) : null,
  });
}

export function solutionSetResourceKey(
  projectId: string,
  runId: string,
  solutionSetId: string,
  revision: SolutionSetRevision,
): string {
  return [
    "solution-set",
    projectId,
    runId,
    solutionSetId,
    revision,
  ]
    .map(encodeURIComponent)
    .join(":");
}

export function solutionSetMembersResourceKey(
  projectId: string,
  runId: string,
  solutionSetId: string,
  revision: SolutionSetRevision,
  query: SolutionSetMemberPageQuery = {},
): string {
  return `${solutionSetResourceKey(
    projectId,
    runId,
    solutionSetId,
    revision,
  )}:members:${pageQueryKey(query.after_member_id, query.limit)}`;
}

export function solutionSetArtifactsResourceKey(
  projectId: string,
  runId: string,
  solutionSetId: string,
  revision: SolutionSetRevision,
  memberId: string,
  query: SolutionSetArtifactPageQuery = {},
): string {
  return `${solutionSetResourceKey(
    projectId,
    runId,
    solutionSetId,
    revision,
  )}:member:${encodeURIComponent(memberId)}:artifacts:${pageQueryKey(
    query.after_artifact_id,
    query.limit,
  )}`;
}

export function materializedDatasetResourceKey(
  identity: SolutionSetRequestIdentity & { memberId: string; artifactId: string },
): string {
  return `${solutionSetResourceKey(
    identity.projectId,
    identity.runId,
    identity.solutionSetId,
    identity.revision,
  )}:member:${encodeURIComponent(identity.memberId)}:artifact:${encodeURIComponent(
    identity.artifactId,
  )}:materialized-dataset`;
}

export function solutionScalarResourceKey(
  identity: SolutionSetRequestIdentity & { memberId: string; artifactId: string },
  binding?: SolutionScalarArtifactBinding | null,
): string {
  const base = `${solutionSetResourceKey(
    identity.projectId,
    identity.runId,
    identity.solutionSetId,
    identity.revision,
  )}:member:${encodeURIComponent(identity.memberId)}:artifact:${encodeURIComponent(
    identity.artifactId,
  )}`;
  if (!binding) return `${base}:scalar`;
  return `${base}:binding:${encodeURIComponent(binding.manifestDigest)}:${encodeURIComponent(
    binding.objectRef,
  )}:${encodeURIComponent(binding.byteLength)}:scalar`;
}

export function isSolutionScalarArtifact(
  artifact: SolutionSetArtifactResource,
): boolean {
  return (
    artifact.kind === "table" &&
    artifact.schema_id === SOLUTION_SCALAR_ARTIFACT_SCHEMA
  );
}

export type SolutionScalarRequestIdentity = SolutionSetRequestIdentity & {
  memberId: string;
  artifactId: string;
  binding: SolutionScalarArtifactBinding;
};

export function validateSolutionScalarEnvelope(
  data: SolutionScalarResource,
  expected: SolutionScalarRequestIdentity,
): SolutionScalarResource {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Solution scalar response does not match the pinned artifact.");
  }
  const byteLength = canonicalScalarU64(data.byte_length);
  const ownershipEpoch = canonicalScalarU64(data.ownership_epoch);
  const step = canonicalScalarU64(data.step);
  const revision = canonicalScalarRevision(data.revision);
  const acceptedStep = data.accepted_state?.accepted_step;
  const acceptedState = data.accepted_state;
  const acceptedStateValid =
    acceptedState === null ||
    acceptedState === undefined ||
    (typeof acceptedState === "object" &&
      acceptedState.run_id === expected.runId &&
      canonicalScalarU64(acceptedState.accepted_step) !== null &&
      nonEmptyScalarText(acceptedState.clock_digest) &&
      nonEmptyScalarText(acceptedState.state_digest) &&
      nonEmptyScalarText(acceptedState.domain_digest) &&
      nonEmptyScalarText(acceptedState.plan_digest) &&
      (acceptedState.stage_id === null ||
        acceptedState.stage_id === undefined ||
        nonEmptyScalarText(acceptedState.stage_id)));
  const provenance = data.provenance as unknown;
  if (
    data.schema_version !== SOLUTION_SCALAR_SCHEMA_VERSION ||
    data.project_id !== expected.projectId ||
    data.run_id !== expected.runId ||
    data.solution_set_id !== expected.solutionSetId ||
    data.revision !== expected.revision ||
    revision === null ||
    data.member_id !== expected.memberId ||
    data.artifact_id !== expected.artifactId ||
    data.manifest_digest !== expected.binding.manifestDigest ||
    !SOLUTION_SET_MANIFEST_DIGEST_PATTERN.test(data.manifest_digest) ||
    !SOLUTION_SCALAR_OBJECT_REF_PATTERN.test(data.object_ref) ||
    data.object_ref !== expected.binding.objectRef ||
    byteLength === null ||
    data.byte_length !== expected.binding.byteLength ||
    byteLength > BigInt(SOLUTION_SCALAR_BYTE_LIMIT) ||
    ownershipEpoch === null ||
    step === null ||
    !Number.isFinite(data.value_si) ||
    !Number.isFinite(data.time_s) ||
    data.integrity !== "verified" ||
    (data.manifest_state !== "open" && data.manifest_state !== "closed") ||
    !SOLUTION_EXECUTION_STATUSES.has(data.execution_status) ||
    !SOLUTION_EXECUTION_STATUSES.has(data.member_execution_status) ||
    !hasSolutionAssessment(data.scientific_assessment) ||
    !hasSolutionAssessment(data.member_scientific_assessment) ||
    !hasSolutionProvenance(provenance) ||
    !acceptedStateValid ||
    (acceptedStep !== undefined && canonicalScalarU64(acceptedStep) === null) ||
    !nonEmptyScalarText(data.task_id) ||
    !nonEmptyScalarText(data.attempt_id) ||
    !nonEmptyScalarText(data.quantity_id) ||
    !nonEmptyScalarText(data.unit)
  ) {
    throw new Error("Solution scalar response does not match the pinned artifact.");
  }
  return data;
}

function canonicalScalarU64(value: unknown): bigint | null {
  if (typeof value !== "string" || !isCanonicalU64Decimal(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function canonicalScalarRevision(value: unknown): bigint | null {
  const parsed = canonicalScalarU64(value);
  return parsed === null || parsed === BigInt(0) ? null : parsed;
}

function nonEmptyScalarText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasSolutionAssessment(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const status = (value as { status?: unknown }).status;
  return typeof status === "string" && SOLUTION_ASSESSMENT_STATUSES.has(status);
}

function hasSolutionProvenance(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return [
    "run_spec_digest",
    "model_digest",
    "physics_digest",
    "discretization_digest",
    "resolved_plan_digest",
    "acquisition_digest",
  ].every((key) => nonEmptyScalarText(record[key]));
}

export function useMaterializedDatasetResource(
  projectId: string | null | undefined,
  runId: string | null | undefined,
  solutionSetId: string | null | undefined,
  revision: SolutionSetRevision | null | undefined,
  memberId: string | null | undefined,
  artifactId: string | null | undefined,
  options: SolutionSetResourceOptions = {},
): ResourceResult<MaterializedDatasetResource | null> {
  const { api } = useKernel();
  const identity = useMemo(() => {
    const solution = resolveIdentity(projectId, runId, solutionSetId, revision);
    const member = resolveMaterializedDatasetPathId(memberId);
    const artifact = resolveMaterializedDatasetPathId(artifactId);
    return solution && member && artifact
      ? { ...solution, memberId: member, artifactId: artifact }
      : null;
  }, [projectId, runId, solutionSetId, revision, memberId, artifactId]);
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!identity) return Promise.resolve(null);
      return api.persistence.projects
        .materializedDataset(
          identity.projectId,
          identity.runId,
          identity.solutionSetId,
          identity.revision,
          identity.memberId,
          identity.artifactId,
          { signal },
        )
        .then((data) => validateMaterializedDatasetEnvelope(data, identity));
    },
    [api, identity],
  );
  return useResource<MaterializedDatasetResource | null>({
    abortStaleInflight: true,
    enabled: identity !== null && options.enabled !== false,
    load,
    resolveRevision: (data) => data?.manifest_object_ref ?? null,
    resourceKey: identity ? materializedDatasetResourceKey(identity) : EMPTY_RESOURCE_KEY,
  });
}

export function useSolutionScalarResource(
  projectId: string | null | undefined,
  runId: string | null | undefined,
  solutionSetId: string | null | undefined,
  revision: SolutionSetRevision | null | undefined,
  memberId: string | null | undefined,
  artifactId: string | null | undefined,
  binding: SolutionScalarArtifactBinding | null,
  options: SolutionSetResourceOptions = {},
): ResourceResult<SolutionScalarResource | null> {
  const { api } = useKernel();
  const identity = useMemo(() => {
    const solution = resolveIdentity(projectId, runId, solutionSetId, revision);
    const member = resolveMaterializedDatasetPathId(memberId);
    const artifact = resolveMaterializedDatasetPathId(artifactId);
    return solution && member && artifact
      ? { ...solution, memberId: member, artifactId: artifact }
      : null;
  }, [projectId, runId, solutionSetId, revision, memberId, artifactId]);
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!identity || !binding) return Promise.resolve(null);
      return api.persistence.projects
        .solutionScalar(
          identity.projectId,
          identity.runId,
          identity.solutionSetId,
          identity.revision,
          identity.memberId,
          identity.artifactId,
          { signal },
        )
        .then((data) =>
          validateSolutionScalarEnvelope(data, { ...identity, binding }),
        );
    },
    [api, binding, identity],
  );

  return useResource<SolutionScalarResource | null>({
    abortStaleInflight: true,
    enabled: identity !== null && binding !== null && options.enabled !== false,
    load,
    resolveRevision: (data) => data
      ? `${data.manifest_digest}:${data.object_ref}:${data.byte_length}:${data.ownership_epoch}`
      : null,
    resourceKey: identity
      ? solutionScalarResourceKey(identity, binding)
      : EMPTY_RESOURCE_KEY,
  });
}

export function validateMaterializedDatasetEnvelope(
  data: MaterializedDatasetResource,
  expected: SolutionSetRequestIdentity & { memberId: string; artifactId: string },
): MaterializedDatasetResource {
  if (
    data.schema_version !== "fullmag.analysis.materialized_dataset.v1" ||
    data.project_id !== expected.projectId ||
    data.run_id !== expected.runId ||
    data.solution_set_id !== expected.solutionSetId ||
    data.containing_solution_revision !== expected.revision ||
    data.member_id !== expected.memberId ||
    data.artifact_id !== expected.artifactId ||
    data.integrity !== "verified" ||
    !/^[a-f0-9]{64}$/.test(data.manifest_object_ref) ||
    data.artifact_id !== `materialized-dataset-${data.manifest_object_ref}`
  ) {
    throw new Error("Dataset response identity does not match the pinned request.");
  }
  const ownerRevision = assertSolutionSetRevision(data.owner_solution_revision);
  const containingRevision = assertSolutionSetRevision(data.containing_solution_revision);
  const manifestLength = assertSolutionSetRevision(data.manifest_byte_length);
  if (
    BigInt(ownerRevision) > BigInt(containingRevision) ||
    BigInt(manifestLength) > BigInt(4 * 1024 * 1024)
  ) {
    throw new Error("Dataset response owner or manifest budget is invalid.");
  }
  const source = data.source;
  const tensor = data.field.tensor_artifact;
  const sameSource = (candidate: MaterializedDatasetResource["source"]) =>
    candidate.run_id === source.run_id &&
    candidate.solution_set_id === source.solution_set_id &&
    candidate.solution_revision === source.solution_revision &&
    candidate.member_id === source.member_id &&
    candidate.artifact_id === source.artifact_id &&
    candidate.tensor_object_ref === source.tensor_object_ref &&
    candidate.run_spec_digest === source.run_spec_digest;
  if (
    source.run_id !== expected.runId ||
    source.solution_set_id !== expected.solutionSetId ||
    source.member_id !== expected.memberId ||
    source.solution_revision !== ownerRevision ||
    !SOLUTION_SET_MANIFEST_DIGEST_PATTERN.test(source.run_spec_digest) ||
    !/^[a-f0-9]{64}$/.test(source.tensor_object_ref) ||
    source.tensor_object_ref !== tensor.object_ref ||
    source.artifact_id !== tensor.artifact_id ||
    data.field.tensor_schema_id !== "fullmag.tensor.v1" ||
    tensor.schema_id !== data.field.tensor_schema_id ||
    tensor.byte_length !== data.field.tensor_byte_length ||
    data.field.sample_id !== data.sample_id ||
    data.field.item_id !== data.item_id ||
    data.field.field_id !== data.field_id ||
    !sameSource(data.dataset.source) ||
    !sameSource(data.definition.source) ||
    data.dataset.schema_version !== "1.0.0" ||
    data.definition.schema_version !== "1.0.0" ||
    data.dataset.definition_id !== data.definition.definition_id ||
    data.dataset.definition_revision !== data.definition.revision ||
    data.dataset.revision !== data.definition.revision ||
    data.dataset.status.availability !== "ready" ||
    data.field.plane !== "values" ||
    data.field.descriptor.complex_encoding !== "real" ||
    data.dataset.dataset_id.trim().length === 0 ||
    data.definition.definition_id.trim().length === 0 ||
    tensor.artifact_id.trim().length === 0
  ) {
    throw new Error("Dataset response field source differs from its pinned owner.");
  }
  assertSolutionSetRevision(data.dataset.revision);
  assertSolutionSetRevision(data.definition.revision);
  assertSolutionSetRevision(tensor.byte_length);
  return data;
}

export function useSolutionSetResource(
  projectId: string | null | undefined,
  runId: string | null | undefined,
  solutionSetId: string | null | undefined,
  revision: SolutionSetRevision | null | undefined,
  options: SolutionSetResourceOptions = {},
): ResourceResult<SolutionSetResource | null> {
  const { api } = useKernel();
  const identity = useMemo(
    () => resolveIdentity(projectId, runId, solutionSetId, revision),
    [projectId, revision, runId, solutionSetId],
  );
  const resourceKey = identity
    ? solutionSetResourceKey(
        identity.projectId,
        identity.runId,
        identity.solutionSetId,
        identity.revision,
      )
    : EMPTY_RESOURCE_KEY;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!identity) return Promise.resolve(null);
      return api.persistence.projects
        .solutionSet(
          identity.projectId,
          identity.runId,
          identity.solutionSetId,
          identity.revision,
          { signal },
        )
        .then((data) => validateSolutionSetEnvelope(data, identity));
    },
    [api, identity],
  );

  return useResource<SolutionSetResource | null>({
    abortStaleInflight: true,
    enabled: identity !== null && options.enabled !== false,
    load,
    resolveRevision: (data) => data?.manifest_digest ?? null,
    resourceKey,
  });
}

export function useSolutionSetMembersResource(
  projectId: string | null | undefined,
  runId: string | null | undefined,
  solutionSetId: string | null | undefined,
  revision: SolutionSetRevision | null | undefined,
  options: SolutionSetMemberPageResourceOptions = {},
): ResourceResult<SolutionSetMemberPageResource | null> {
  const { api } = useKernel();
  const identity = useMemo(
    () => resolveIdentity(projectId, runId, solutionSetId, revision),
    [projectId, revision, runId, solutionSetId],
  );
  const queryKey = JSON.stringify(options.query ?? {});
  const query = useMemo(
    () => normalizeMemberPageQuery(JSON.parse(queryKey)),
    [queryKey],
  );
  const resourceKey = identity && query
    ? solutionSetMembersResourceKey(
        identity.projectId,
        identity.runId,
        identity.solutionSetId,
        identity.revision,
        query,
      )
    : EMPTY_RESOURCE_KEY;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!identity || !query) return Promise.resolve(null);
      return api.persistence.projects
        .solutionSetMembers(
          identity.projectId,
          identity.runId,
          identity.solutionSetId,
          identity.revision,
          query,
          { signal },
        )
        .then((data) => validateSolutionSetEnvelope(data, identity));
    },
    [api, identity, query],
  );

  return useResource<SolutionSetMemberPageResource | null>({
    abortStaleInflight: true,
    enabled:
      identity !== null && query !== null && options.enabled !== false,
    load,
    resolveRevision: (data) => data?.manifest_digest ?? null,
    resourceKey,
  });
}

export function useSolutionSetArtifactsResource(
  projectId: string | null | undefined,
  runId: string | null | undefined,
  solutionSetId: string | null | undefined,
  revision: SolutionSetRevision | null | undefined,
  memberId: string | null | undefined,
  options: SolutionSetArtifactPageResourceOptions = {},
): ResourceResult<SolutionSetArtifactPageResource | null> {
  const { api } = useKernel();
  const identity = useMemo(
    () => resolveIdentity(projectId, runId, solutionSetId, revision),
    [projectId, revision, runId, solutionSetId],
  );
  const normalizedMemberId = useMemo(
    () => resolvePathId(memberId),
    [memberId],
  );
  const queryKey = JSON.stringify(options.query ?? {});
  const query = useMemo(
    () => normalizeArtifactPageQuery(JSON.parse(queryKey)),
    [queryKey],
  );
  const resourceKey = identity && normalizedMemberId && query
    ? solutionSetArtifactsResourceKey(
        identity.projectId,
        identity.runId,
        identity.solutionSetId,
        identity.revision,
        normalizedMemberId,
        query,
      )
    : EMPTY_RESOURCE_KEY;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!identity || !normalizedMemberId || !query) {
        return Promise.resolve(null);
      }
      return api.persistence.projects
        .solutionSetArtifacts(
          identity.projectId,
          identity.runId,
          identity.solutionSetId,
          identity.revision,
          normalizedMemberId,
          query,
          { signal },
        )
        .then((data) =>
          validateSolutionSetEnvelope(data, {
            ...identity,
            memberId: normalizedMemberId,
          }),
        );
    },
    [api, identity, normalizedMemberId, query],
  );

  return useResource<SolutionSetArtifactPageResource | null>({
    abortStaleInflight: true,
    enabled:
      identity !== null &&
      normalizedMemberId !== null &&
      query !== null &&
      options.enabled !== false,
    load,
    resolveRevision: (data) => data?.manifest_digest ?? null,
    resourceKey,
  });
}

function pageQueryKey(
  afterId: string | null | undefined,
  limit: number | null | undefined,
): string {
  const params = new URLSearchParams();
  params.set("limit", String(limit ?? 50));
  if (afterId != null) params.set("after", afterId);
  return params.toString();
}

function resolveIdentity(
  projectId: string | null | undefined,
  runId: string | null | undefined,
  solutionSetId: string | null | undefined,
  revision: SolutionSetRevision | null | undefined,
): {
  projectId: string;
  runId: string;
  solutionSetId: string;
  revision: SolutionSetRevision;
} | null {
  if (
    projectId === null ||
    projectId === undefined ||
    runId === null ||
    runId === undefined ||
    solutionSetId === null ||
    solutionSetId === undefined ||
    revision === null ||
    revision === undefined
  ) {
    return null;
  }
  try {
    return {
      projectId: assertSolutionSetProjectId(projectId),
      revision: assertSolutionSetRevision(revision),
      runId: assertSolutionSetRunId(runId),
      solutionSetId: assertSolutionSetLogicalId(solutionSetId),
    };
  } catch {
    return null;
  }
}

function resolvePathId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    return assertSolutionSetMemberId("member id", value);
  } catch {
    return null;
  }
}

function resolveMaterializedDatasetPathId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    return assertMaterializedDatasetPathId("dataset path id", value);
  } catch {
    return null;
  }
}

function normalizeMemberPageQuery(
  query: SolutionSetMemberPageQuery | undefined,
): SolutionSetMemberPageQuery | null {
  const candidate = query ?? {};
  try {
    const limit = candidate.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return null;
    }
    if (candidate.after_member_id != null) {
      assertSolutionSetMemberId("member cursor", candidate.after_member_id);
    }
    return {
      ...candidate,
      after_member_id: candidate.after_member_id ?? undefined,
      limit,
    };
  } catch {
    return null;
  }
}

function normalizeArtifactPageQuery(
  query: SolutionSetArtifactPageQuery | undefined,
): SolutionSetArtifactPageQuery | null {
  const candidate = query ?? {};
  try {
    const limit = candidate.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return null;
    }
    if (candidate.after_artifact_id != null) {
      assertSolutionSetMemberId("artifact cursor", candidate.after_artifact_id);
    }
    return {
      ...candidate,
      after_artifact_id: candidate.after_artifact_id ?? undefined,
      limit,
    };
  } catch {
    return null;
  }
}

export function validateSolutionSetEnvelope<T extends SolutionSetIdentity>(
  data: T,
  expected: SolutionSetRequestIdentity & { memberId?: string },
): T {
  if (
    data.schema_version !== SOLUTION_SET_SCHEMA_VERSION ||
    data.project_id !== expected.projectId ||
    data.run_id !== expected.runId ||
    data.solution_set_id !== expected.solutionSetId ||
    data.revision !== expected.revision ||
    !SOLUTION_SET_MANIFEST_DIGEST_PATTERN.test(data.manifest_digest) ||
    (expected.memberId !== undefined &&
      (data as T & { member_id?: string }).member_id !== expected.memberId)
  ) {
    throw new Error(
      "SolutionSet response identity does not match the pinned request.",
    );
  }
  return data;
}
