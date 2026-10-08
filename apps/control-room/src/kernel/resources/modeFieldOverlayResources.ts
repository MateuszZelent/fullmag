import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type {
  FrequencyDomainFieldResource,
  FrequencyDomainJsonArtifactResource,
} from "../api/apiTypes";
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
import { sessionRequestScopeKey } from "./sessionResourceIdentity";
import { useSessionResourceIdentity } from "./useSessionStatus";

import {
  useFrequencyDomainEigenModeFieldMetaResource,
  useFrequencyDomainEigenModeResource,
} from "./studyRuntimeResources";

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
  modeArtifact?: FrequencyDomainJsonArtifactResource | null,
): string {
  return JSON.stringify({
    artifactRevision: intent.artifactRevision,
    artifactPath: metadata.artifact_path,
    contentDigest: metadata.content_digest ?? null,
    metadataRevision: metadata.revision ?? null,
    metadataStatus: metadata.status,
    modeArtifactPath: modeArtifact?.artifact_path ?? null,
    modeArtifactDigest: modeArtifact?.content_digest ?? null,
    modeArtifactRevision: modeArtifact?.revision ?? null,
    modeArtifactRunId: modeArtifact?.run_id ?? null,
    modeArtifactStageId: modeArtifact?.stage_id ?? null,
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
  modeArtifactResource?: Pick<
    ResourceResult<FrequencyDomainJsonArtifactResource | null>,
    "data" | "error" | "revision" | "status"
  > | null,
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

  if (
    intent.equilibriumId !== undefined &&
    (!modeArtifactResource ||
      modeArtifactResource.status !== "ready" ||
      modeArtifactResource.data === null ||
      modeArtifactResource.revision == null)
  ) {
    const status = modeArtifactResource?.status === "ready"
      ? "error"
      : modeArtifactResource?.status ?? "error";
    return {
      binaryResourceKey: null,
      error: modeArtifactResource?.error ?? MODE_FIELD_METADATA_INVALID,
      metadata: null,
      metadataStatus: status,
      status,
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

  const metadataRevision = resource.revision === null
    ? null
    : intent.equilibriumId !== undefined
      ? JSON.stringify([resource.revision, modeArtifactResource?.revision ?? null])
      : resource.revision;
  const metadata = resolveModeFieldOverlayMetadata(
    intent,
    resource.data,
    metadataRevision,
    modeArtifactResource?.data,
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
  const sessionIdentity = useSessionResourceIdentity();
  const modeArtifactResource = useFrequencyDomainEigenModeResource(
    intent?.sampleIndex,
    intent?.modeIndex,
    {
      enabled: enabled && intent?.equilibriumId !== undefined && sessionIdentity !== null,
    },
  );
  const metadataResource = useFrequencyDomainEigenModeFieldMetaResource(
    intent?.sampleIndex,
    intent?.modeIndex,
    { enabled: enabled && Boolean(intent) && sessionIdentity !== null },
  );
  return useMemo(
    () => resolveModeFieldOverlayResource(intent, metadataResource, modeArtifactResource),
    [intent, metadataResource, modeArtifactResource],
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
  const sessionIdentity = useSessionResourceIdentity();
  const sessionScope = sessionRequestScopeKey(sessionIdentity);
  const [controller] = useState(() => new ModeFieldOverlayIntentController());
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!enabled || !intent || !topology || !sessionScope) {
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
          const [data, modeArtifact] = await Promise.all([
            api.analysis.frequencyDomain.eigenModeFieldMeta(
              activeIntent.sampleIndex,
              activeIntent.modeIndex,
              { sessionScopeKey: sessionScope, signal },
            ),
            activeIntent.equilibriumId !== undefined
              ? api.analysis.frequencyDomain.eigenMode(
                  activeIntent.sampleIndex,
                  activeIntent.modeIndex,
                  { sessionScopeKey: sessionScope, signal },
                )
              : Promise.resolve(null),
          ]);
          return {
            data,
            modeArtifact,
            revision: resolveModeFieldOverlayMetadataRevision(
              activeIntent,
              data,
              modeArtifact,
            ),
          };
        },
        loadBinary: async (metadata, signal) => {
          const response = await api.data.fields.vector(
            metadata.fieldId,
            metadata.binaryQuery,
            { sessionScopeKey: sessionScope, signal },
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
  }, [api, controller, enabled, intent, sessionScope, topology]);

  return snapshot;
}
