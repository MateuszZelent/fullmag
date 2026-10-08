"use client";

import { useCallback, useMemo } from "react";

import {
  DATA_OBSERVATION_FRAME_MAGNETIZATION_PATH,
  DATA_OBSERVATION_FRAME_PATH,
  DATA_OBSERVATION_FRAMES_PATH,
} from "../api/apiPaths";
import type {
  BinaryResourceResult,
  FieldVectorResponseMetadata,
  ObservationFrameListQuery,
  ObservationFrameListResource,
  ObservationFrameResource,
  ResourceRevision,
} from "../api/apiTypes";
import type { DecodedFieldVector } from "../api/codecs/types";
import { useKernel } from "../KernelContext";
import { ControlRoomApiError } from "../api/ControlRoomApi";

import { useResource } from "./useResource";
import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";

export interface ObservationFrameListResourceOptions {
  cursor?: string | null;
  enabled?: boolean;
  limit?: number | null;
  runId?: string | null;
  stageId?: string | null;
}

export interface ObservationFrameResourceOptions {
  enabled?: boolean;
}

export type ObservationFrameMagnetizationResource = BinaryResourceResult<
  DecodedFieldVector,
  FieldVectorResponseMetadata
>;

function concreteFramePath(template: string, frameId: string): string {
  return template.replace("{frame_id}", encodeURIComponent(frameId));
}

function normalizedOptionalIdentity(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function observationFrameListQuery({
  cursor,
  limit,
  runId,
  stageId,
}: Omit<ObservationFrameListResourceOptions, "enabled">): ObservationFrameListQuery {
  return {
    cursor: normalizedOptionalIdentity(cursor),
    limit: limit ?? undefined,
    run_id: normalizedOptionalIdentity(runId),
    stage_id: normalizedOptionalIdentity(stageId),
  };
}

export function observationFrameListResourceKey(
  query: ObservationFrameListQuery = {},
): string {
  const params = new URLSearchParams();
  for (const key of ["run_id", "stage_id", "cursor", "limit"] as const) {
    const value = query[key];
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized
    ? `${DATA_OBSERVATION_FRAMES_PATH}?${serialized}`
    : DATA_OBSERVATION_FRAMES_PATH;
}

export function observationFrameResourceKey(frameId: string | null | undefined) {
  return frameId
    ? concreteFramePath(DATA_OBSERVATION_FRAME_PATH, frameId)
    : `${DATA_OBSERVATION_FRAME_PATH}:none`;
}

export function observationFrameMagnetizationResourceKey(
  frameId: string | null | undefined,
) {
  return frameId
    ? concreteFramePath(DATA_OBSERVATION_FRAME_MAGNETIZATION_PATH, frameId)
    : `${DATA_OBSERVATION_FRAME_MAGNETIZATION_PATH}:none`;
}

export function observationFrameRevision(
  frame: ObservationFrameResource | null | undefined,
): ResourceRevision | null {
  if (!frame) return null;
  const generation = frame.accepted_state_ref.generation;
  return `${frame.frame_id}:${generation.runtime_epoch}:${generation.accepted_revision}`;
}

export function observationFrameListRevision(
  resource: ObservationFrameListResource | null | undefined,
): ResourceRevision | null {
  if (!resource) return null;
  return [
    resource.run_id,
    ...resource.frames.map((frame) => observationFrameRevision(frame)),
    resource.next_cursor ?? "end",
  ].join("|");
}

export function observationFrameMagnetizationRevision(
  resource: ObservationFrameMagnetizationResource,
): ResourceRevision | null {
  if (resource.status !== "ready") return resource.etag;
  return (
    resource.data.fieldGenerationId ??
    resource.responseMetadata.fieldGenerationId ??
    resource.etag
  );
}

// Legacy API identifies this optional store absence with an exact message.
// Other not-found resources and all storage failures remain errors.
export function handleAbsentObservationFrameStore(error: unknown): null {
  if (
    error instanceof ControlRoomApiError &&
    error.status === 404 &&
    error.code === "not_found" &&
    error.message === "durable observation run storage was not found"
  ) return null;
  throw error;
}

export function useObservationFrameListResource({
  cursor = null,
  enabled = true,
  limit = 50,
  runId = null,
  stageId = null,
}: ObservationFrameListResourceOptions = {}) {
  const { api } = useKernel();
  const query = useMemo(
    () => observationFrameListQuery({ cursor, limit, runId, stageId }),
    [cursor, limit, runId, stageId],
  );
  const unscopedResourceKey = useMemo(
    () => observationFrameListResourceKey(query),
    [query],
  );
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    unscopedResourceKey,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.data.observationFrames.list(query, { sessionScopeKey, signal })
        .catch(handleAbsentObservationFrameStore),
    [api, query],
  );

  return useResource<ObservationFrameListResource | null>({
    abortStaleInflight: true,
    enabled: enabled && sessionIdentity !== null,
    load,
    resolveRevision: observationFrameListRevision,
    resourceKey,
  });
}

export function useObservationFrameResource(
  frameId: string | null | undefined,
  { enabled = true }: ObservationFrameResourceOptions = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = observationFrameResourceKey(frameId);
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    unscopedResourceKey,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => {
      if (!frameId) return Promise.reject(new Error("An observation frame must be selected."));
      return api.data.observationFrames.get(frameId, { sessionScopeKey, signal });
    },
    [api, frameId],
  );

  return useResource<ObservationFrameResource>({
    abortStaleInflight: true,
    enabled: enabled && Boolean(frameId) && sessionIdentity !== null,
    load,
    resolveRevision: observationFrameRevision,
    resourceKey,
  });
}

export function useObservationFrameMagnetizationResource(
  frameId: string | null | undefined,
  { enabled = true }: ObservationFrameResourceOptions = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = observationFrameMagnetizationResourceKey(frameId);
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    unscopedResourceKey,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) => {
      if (!frameId) return Promise.reject(new Error("An observation frame must be selected."));
      return api.data.observationFrames.magnetization(frameId, {
        sessionScopeKey,
        signal,
      });
    },
    [api, frameId],
  );

  return useResource<ObservationFrameMagnetizationResource>({
    abortStaleInflight: true,
    enabled: enabled && Boolean(frameId) && sessionIdentity !== null,
    load,
    resolveRevision: observationFrameMagnetizationRevision,
    resourceKey,
  });
}
