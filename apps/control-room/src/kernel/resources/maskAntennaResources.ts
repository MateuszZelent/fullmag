"use client";

import { useCallback } from "react";

import {
  MODEL_MASK_FIELD_DRIVES_PATH,
  MODEL_READY_ANTENNAS_PATH,
  MODEL_SCENE_PATH,
} from "../api/apiPaths";
import type {
  MaskFieldDriveListResource,
  ReadyAntennaListResource,
} from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";
import { useResource } from "./useResource";

export const MODEL_MASK_FIELD_DRIVES_RESOURCE_KEY = MODEL_MASK_FIELD_DRIVES_PATH;
export const MODEL_READY_ANTENNAS_RESOURCE_KEY = MODEL_READY_ANTENNAS_PATH;

/** Resources a mask-antenna mutation changes: the list and the scene (Explorer tree). */
export function maskAntennaMutationResourceKeys() {
  return [MODEL_MASK_FIELD_DRIVES_RESOURCE_KEY, MODEL_SCENE_PATH] as const;
}

export interface MaskAntennaResourceOptions {
  enabled?: boolean;
}

export function useMaskFieldDrivesResource(
  options: MaskAntennaResourceOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MODEL_MASK_FIELD_DRIVES_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.model.maskFieldDrives({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<MaskFieldDriveListResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resolveRevision: (data) => data?.scene_revision ?? null,
    resourceKey,
  });
}

/** The ready antennas of `fullmag.antennas`; the registry does not change within a session. */
export function useReadyAntennasResource(
  options: MaskAntennaResourceOptions = {},
) {
  const { api } = useKernel();
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MODEL_READY_ANTENNAS_RESOURCE_KEY,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      api.model.readyAntennas({ sessionScopeKey, signal }),
    [api],
  );

  return useResource<ReadyAntennaListResource>({
    enabled: options.enabled !== false && sessionIdentity !== null,
    load,
    resourceKey,
  });
}
