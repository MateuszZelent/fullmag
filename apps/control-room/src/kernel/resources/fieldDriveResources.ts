"use client";

import { useCallback } from "react";

import { MODEL_FIELD_DRIVES_PATH } from "../api/apiPaths";
import type { FieldDriveListResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { PHYSICS_GRAPH_RESOURCE_KEY } from "./physicsGraphResources";
import { useResource } from "./useResource";

export const MODEL_FIELD_DRIVES_RESOURCE_KEY = MODEL_FIELD_DRIVES_PATH;

export function fieldDriveMutationResourceKeys() {
  return [
    MODEL_FIELD_DRIVES_RESOURCE_KEY,
    PHYSICS_GRAPH_RESOURCE_KEY,
  ] as const;
}

export interface FieldDriveResourceOptions {
  enabled?: boolean;
}

export function useFieldDrivesResource(
  options: FieldDriveResourceOptions = {},
) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.fieldDrives({ signal }),
    [api],
  );

  return useResource<FieldDriveListResource>({
    enabled: options.enabled,
    load,
    resolveRevision: (data) => data?.scene_revision ?? null,
    resourceKey: MODEL_FIELD_DRIVES_RESOURCE_KEY,
  });
}
