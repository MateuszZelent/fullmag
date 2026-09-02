import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { FrequencyDomainFieldResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import type { ResourceResult, ResourceStatus } from "./resourceTypes";
import {
  isAnalysisResultFieldOverlayIntent,
  validateAnalysisResultFieldResponseMetadata,
} from "../visualization/AnalysisResultFieldOverlayIntent";
import {
  type ModeFieldOverlayIntent,
  type ModeFieldOverlayTopologyIdentity,
  type ResolvedModeFieldOverlayMetadata,
  resolveModeFieldOverlayMetadata,
} from "../visualization/ModeFieldOverlayIntent";
import {
  ModeFieldOverlayIntentController,
  type ModeFieldOverlayIntentSnapshot,
} from "../visualization/ModeFieldOverlayIntentController";

import { useFrequencyDomainEigenModeFieldMetaResource } from "./studyRuntimeResources";

export interface ModeFieldOverlayResource {
  readonly binaryResourceKey: string | null;
  readonly error: Error | null;
  readonly metadata: ResolvedModeFieldOverlayMetadata | null;
  readonly metadataStatus: ResourceStatus;
  readonly status: ResourceStatus;
}

const MODE_FIELD_METADATA_INVALID = new Error(
  "Mode-field metadata is incomplete, stale, or not a global complex XYZ field.",
);

export function resolveModeFieldOverlayMetadataRevision(
  intent: ModeFieldOverlayIntent,
  metadata: FrequencyDomainFieldResource,
): string {
  return JSON.stringify({
    artifactRevision: intent.artifactRevision,
    artifactPath: metadata.artifact_path,
    contentDigest: metadata.content_digest ?? null,
    metadataRevision: metadata.revision ?? null,
    metadataStatus: metadata.status,
  });
}

/**
 * Keeps the metadata gate ahead of the shared binary field data plane. A
 * consumer may request `binaryResourceKey` only after this adapter returns a
 * ready, provenance- and topology-bound metadata result.
 */
export function resolveModeFieldOverlayResource(
  intent: ModeFieldOverlayIntent | null | undefined,
  resource: Pick<
    ResourceResult<FrequencyDomainFieldResource | null>,
    "data" | "error" | "revision" | "status"
  >,
): ModeFieldOverlayResource {
  if (!intent) {
    return {
      binaryResourceKey: null,
      error: null,
      metadata: null,
      metadataStatus: "idle",
      status: "idle",
    };
  }

  if (resource.status !== "ready" || resource.data === null) {
    return {
      binaryResourceKey: null,
      error: resource.error,
      metadata: null,
      metadataStatus: resource.status,
      status: resource.status,
    };
  }

  const metadata = resolveModeFieldOverlayMetadata(
    intent,
    resource.data,
    resource.revision,
  );
  if (!metadata) {
    return {
      binaryResourceKey: null,
      error: MODE_FIELD_METADATA_INVALID,
      metadata: null,
      metadataStatus: resource.status,
      status: "error",
    };
  }

  return {
    binaryResourceKey: `data/fields/${encodeURIComponent(metadata.fieldId)}`,
    error: null,
    metadata,
    metadataStatus: resource.status,
    status: "ready",
  };
}

/**
 * Temporary index bridge over the generated metadata facade. The caller owns
 * only the stable intent; the legacy sample/mode indices never leave this
 * resource-hook boundary and cannot become overlay/cache identity.
 */
export function useModeFieldOverlayResource(
  intent: ModeFieldOverlayIntent | null | undefined,
  { enabled = true }: { enabled?: boolean } = {},
): ModeFieldOverlayResource {
  const metadataResource = useFrequencyDomainEigenModeFieldMetaResource(
    intent?.sampleIndex,
    intent?.modeIndex,
    { enabled: enabled && Boolean(intent) },
  );
  return useMemo(
    () => resolveModeFieldOverlayResource(intent, metadataResource),
    [intent, metadataResource],
  );
}

export type ModeFieldOverlayMetadataResource = ResourceResult<
  FrequencyDomainFieldResource | null
>;

/**
 * Owns the mounted viewport's complete metadata -> binary demand. Both facade
 * requests share the controller's AbortSignal, so clear, supersede and
 * unmount cancel whichever stage is active before a snapshot can be exposed.
 */
export function useModeFieldOverlayIntentResource({
  enabled = true,
  intent,
  topology,
}: {
  enabled?: boolean;
  intent: ModeFieldOverlayIntent | null | undefined;
  topology: ModeFieldOverlayTopologyIdentity | null;
}): ModeFieldOverlayIntentSnapshot {
  const { api } = useKernel();
  const [controller] = useState(() => new ModeFieldOverlayIntentController());
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!enabled || !intent || !topology) {
      controller.clear();
      return;
    }

    void controller.activate(
      intent,
      {
        loadMetadata: async (activeIntent, signal) => {
          if (isAnalysisResultFieldOverlayIntent(activeIntent)) {
            const metadata = resolveModeFieldOverlayMetadata(
              activeIntent,
              activeIntent.fieldRef,
              activeIntent.fieldRevision,
            );
            if (!metadata) {
              throw new Error(
                "Analysis result field reference failed validation.",
              );
            }
            return {
              data: activeIntent.fieldRef,
              revision: activeIntent.fieldRevision,
            };
          }
          const data = await api.analysis.frequencyDomain.eigenModeFieldMeta(
            activeIntent.sampleIndex,
            activeIntent.modeIndex,
            { signal },
          );
          return {
            data,
            revision: resolveModeFieldOverlayMetadataRevision(activeIntent, data),
          };
        },
        loadBinary: async (metadata, signal) => {
          const response = await api.data.fields.vector(
            metadata.fieldId,
            metadata.binaryQuery,
            { signal },
          );
          if (response.status !== "ready") {
            throw new Error(
              `Mode field binary resource returned ${response.status}.`,
            );
          }
          if (
            isAnalysisResultFieldOverlayIntent(metadata.intent) &&
            !validateAnalysisResultFieldResponseMetadata(
              metadata.intent,
              response.responseMetadata,
            )
          ) {
            throw new Error(
              "Analysis result field binary revision failed validation.",
            );
          }
          return response.data;
        },
      },
      topology,
    );

    return () => controller.clear();
  }, [api, controller, enabled, intent, topology]);

  return snapshot;
}
