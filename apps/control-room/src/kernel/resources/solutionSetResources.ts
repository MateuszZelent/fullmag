"use client";

import { useCallback, useMemo } from "react";

import {
  assertSolutionSetLogicalId,
  assertSolutionSetMemberId,
  assertSolutionSetProjectId,
  assertSolutionSetRevision,
  assertSolutionSetRunId,
} from "../api/ControlRoomApi";
import type {
  SolutionSetArtifactPageQuery,
  SolutionSetArtifactPageResource,
  SolutionSetMemberPageQuery,
  SolutionSetMemberPageResource,
  SolutionSetResource,
  SolutionSetRevision,
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

const SOLUTION_SET_MANIFEST_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

const EMPTY_RESOURCE_KEY = "solution-set:none";

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
