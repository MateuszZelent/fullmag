"use client";

import { useCallback } from "react";

import {
  DATA_ANTENNA_FIELD_SOLUTION_PATH,
  DATA_ANTENNA_FIELD_SOLUTION_PAYLOAD_PATH,
  DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PATH,
  DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PAYLOAD_PATH,
  DATA_ANTENNA_STAGE_OUTPUT_CATALOG_PATH,
  DATA_ANTENNA_SOURCE_SPECTRUM_PATH,
  DATA_ANTENNA_SOURCE_SPECTRUM_PAYLOAD_PATH,
} from "../api/apiPaths";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import type {
  AntennaFieldSolutionResource,
  AntennaFieldPayloadKind,
  AntennaExternalLeadInspectionResource,
  AntennaInspectionPayloadKind,
  AntennaStageOutputCatalogResource,
  AntennaSpectrumPayloadKind,
  AntennaSourceSpectrumResource,
  BinaryResourceResult,
} from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";
import { sessionResourceIdentitiesEqual } from "./sessionResourceIdentity";
import { useSessionScopedResourceKey } from "./useSessionScopedResourceKey";

export interface AntennaResourceOptions {
  enabled?: boolean;
}

interface AntennaPayloadResourceOptions extends AntennaResourceOptions {
  expectedEtag?: string;
  range?: string;
}

export function antennaSpectrumPayloadEtag(
  spectrum: AntennaSourceSpectrumResource,
  payloadKind: AntennaSpectrumPayloadKind,
): string {
  if (!spectrum.payloads) {
    throw new Error("antenna spectrum manifest has no binary payload references");
  }
  const token = `antenna-source-spectrum-payload:${spectrum.session_id}:${spectrum.session_epoch}:${spectrum.request_scope_epoch}:${spectrum.output_id}:${payloadKind}:${spectrum.content_digest}:${spectrum.payloads[payloadKind].sha256}`;
  return `"${token.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function antennaFieldPayloadEtag(
  solution: AntennaFieldSolutionResource,
  payloadKind: AntennaFieldPayloadKind,
  portModeId?: string,
): string {
  const basis = portModeId
    ? solution.bases.find((item) => item.port_mode_id === portModeId)
    : undefined;
  const reference = (() => {
    switch (payloadKind) {
      case "conductor_positions": return solution.conductor_positions;
      case "sample_positions": return solution.sample_positions;
      case "sample_topology": return solution.sample_topology;
      case "electric_potential_per_ampere": return basis?.electric_potential_per_ampere;
      case "current_density_per_ampere": return basis?.current_density_per_ampere;
      case "magnetic_field_per_ampere": return basis?.magnetic_field_per_ampere;
    }
  })();
  if (!reference) {
    throw new Error("antenna field manifest has no selected binary payload reference");
  }
  const token = `antenna-field-payload:${solution.session_id}:${solution.session_epoch}:${solution.request_scope_epoch}:${solution.solution_id}:${payloadKind}:${portModeId ?? ""}:${solution.content_digest}:${reference.sha256}`;
  return `"${token.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function requireMatchingAntennaPayloadRevision(
  result: BinaryResourceResult<ArrayBuffer> | null,
  expectedEtag: string,
): BinaryResourceResult<ArrayBuffer> | null {
  if (result?.status === "ready" && result.etag !== expectedEtag) {
    throw new Error("antenna payload revision does not match selected manifest");
  }
  return result;
}

function concretePath(template: string, name: string, value: string): string {
  return template.replace(`{${name}}`, encodeURIComponent(value));
}

function concreteSpectrumPayloadPath(
  outputId: string,
  payloadKind: AntennaSpectrumPayloadKind,
): string {
  return concretePath(
    concretePath(
      DATA_ANTENNA_SOURCE_SPECTRUM_PAYLOAD_PATH,
      "output_id",
      outputId,
    ),
    "payload_kind",
    payloadKind,
  );
}

function concreteFieldPayloadPath(
  solutionId: string,
  payloadKind: AntennaFieldPayloadKind,
  portModeId?: string,
): string {
  const path = concretePath(
    concretePath(DATA_ANTENNA_FIELD_SOLUTION_PAYLOAD_PATH, "solution_id", solutionId),
    "payload_kind",
    payloadKind,
  );
  return portModeId ? `${path}?port_mode_id=${encodeURIComponent(portModeId)}` : path;
}

function ignoreMissingAntennaResource<T>(error: unknown): T | null {
  if (
    error instanceof ControlRoomApiError &&
    error.status === 404 &&
    error.code !== "missing_payload"
  ) {
    return null;
  }
  throw error;
}

export function useAntennaFieldSolutionResource(
  solutionId: string | null | undefined,
  options: AntennaResourceOptions = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = solutionId
    ? concretePath(DATA_ANTENNA_FIELD_SOLUTION_PATH, "solution_id", solutionId)
    : `${DATA_ANTENNA_FIELD_SOLUTION_PATH}:none`;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(unscopedResourceKey);
  const load = useCallback(
    ({ signal, sessionScopeKey }: { signal: AbortSignal; sessionScopeKey?: string }) =>
      solutionId
        ? api.data.antenna
            .fieldSolution(solutionId, { signal, sessionScopeKey })
            .catch(ignoreMissingAntennaResource<AntennaFieldSolutionResource>)
        : Promise.resolve(null),
    [api, solutionId],
  );

  return useResource<AntennaFieldSolutionResource | null>({
    enabled: Boolean(solutionId && sessionIdentity) && options.enabled !== false,
    load,
    resolveRevision: (data) => data?.content_digest ?? null,
    resourceKey,
  });
}

export function useAntennaStageOutputCatalogResource(
  stageId: string | null | undefined,
  options: AntennaResourceOptions = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = stageId
    ? concretePath(
        DATA_ANTENNA_STAGE_OUTPUT_CATALOG_PATH,
        "stage_id",
        stageId,
      )
    : `${DATA_ANTENNA_STAGE_OUTPUT_CATALOG_PATH}:none`;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(unscopedResourceKey);
  const load = useCallback(
    ({ signal, sessionScopeKey }: { signal: AbortSignal; sessionScopeKey?: string }) =>
      stageId
        ? api.data.antenna
            .stageOutputCatalog(stageId, { signal, sessionScopeKey })
            .catch(ignoreMissingAntennaResource<AntennaStageOutputCatalogResource>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<AntennaStageOutputCatalogResource | null>({
    enabled: Boolean(stageId && sessionIdentity) && options.enabled !== false,
    load,
    resolveRevision: (data) =>
      data
        ? `${data.stage_revision}:${data.content_digest}`
        : null,
    resourceKey,
  });
}

export function useAntennaFieldSolutionPayloadResource(
  solutionId: string | null | undefined,
  payloadKind: AntennaFieldPayloadKind | null | undefined,
  portModeId: string | null | undefined,
  options: AntennaPayloadResourceOptions = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = solutionId && payloadKind
    ? `${concreteFieldPayloadPath(solutionId, payloadKind, portModeId ?? undefined)}${options.expectedEtag ? `#${options.expectedEtag}` : ""}${options.range ? `@${options.range}` : ""}`
    : `${DATA_ANTENNA_FIELD_SOLUTION_PAYLOAD_PATH}:none`;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(unscopedResourceKey);
  const load = useCallback(
    async ({ signal, sessionScopeKey }: { signal: AbortSignal; sessionScopeKey?: string }) => {
      if (!solutionId || !payloadKind) return null;
      const result = await api.data.antenna
        .fieldSolutionPayload(solutionId, payloadKind, portModeId ?? undefined, { signal, sessionScopeKey, range: options.range })
        .catch(ignoreMissingAntennaResource<BinaryResourceResult<ArrayBuffer>>);
      return options.expectedEtag
        ? requireMatchingAntennaPayloadRevision(result, options.expectedEtag)
        : result;
    },
    [api, options.expectedEtag, options.range, payloadKind, portModeId, solutionId],
  );

  return useResource<BinaryResourceResult<ArrayBuffer> | null>({
    enabled: Boolean(solutionId && payloadKind && sessionIdentity) && options.enabled !== false,
    load,
    resolveRevision: (data) => data?.status === "ready" ? data.etag : null,
    resourceKey,
  });
}

export function useAntennaSourceSpectrumResource(
  outputId: string | null | undefined,
  options: AntennaResourceOptions = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = outputId
    ? concretePath(DATA_ANTENNA_SOURCE_SPECTRUM_PATH, "output_id", outputId)
    : `${DATA_ANTENNA_SOURCE_SPECTRUM_PATH}:none`;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(unscopedResourceKey);
  const load = useCallback(
    ({ signal, sessionScopeKey }: { signal: AbortSignal; sessionScopeKey?: string }) =>
      outputId
        ? api.data.antenna
            .sourceSpectrum(outputId, { signal, sessionScopeKey })
            .catch(ignoreMissingAntennaResource<AntennaSourceSpectrumResource>)
        : Promise.resolve(null),
    [api, outputId],
  );

  return useResource<AntennaSourceSpectrumResource | null>({
    enabled: Boolean(outputId && sessionIdentity) && options.enabled !== false,
    load,
    resolveRevision: (data) => data?.content_digest ?? null,
    resourceKey,
  });
}

export function useAntennaSourceSpectrumPayloadResource(
  outputId: string | null | undefined,
  payloadKind: AntennaSpectrumPayloadKind | null | undefined,
  options: AntennaPayloadResourceOptions = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = outputId && payloadKind
    ? `${concreteSpectrumPayloadPath(outputId, payloadKind)}${options.expectedEtag ? `#${options.expectedEtag}` : ""}${options.range ? `@${options.range}` : ""}`
    : `${DATA_ANTENNA_SOURCE_SPECTRUM_PAYLOAD_PATH}:none`;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(unscopedResourceKey);
  const load = useCallback(
    async ({ signal, sessionScopeKey }: { signal: AbortSignal; sessionScopeKey?: string }) => {
      if (!outputId || !payloadKind) return null;
      const result = await api.data.antenna
        .sourceSpectrumPayload(outputId, payloadKind, { signal, sessionScopeKey, range: options.range })
        .catch(ignoreMissingAntennaResource<BinaryResourceResult<ArrayBuffer>>);
      return options.expectedEtag
        ? requireMatchingAntennaPayloadRevision(result, options.expectedEtag)
        : result;
    },
    [api, options.expectedEtag, options.range, outputId, payloadKind],
  );

  return useResource<BinaryResourceResult<ArrayBuffer> | null>({
    enabled:
      Boolean(outputId && payloadKind && sessionIdentity) && options.enabled !== false,
    load,
    resolveRevision: (data) =>
      data?.status === "ready" ? data.etag : null,
    resourceKey,
  });
}

export function useAntennaExternalLeadInspectionResource(
  stageId: string | null | undefined,
  options: AntennaResourceOptions & { pauseLoad?: boolean } = {},
) {
  const { api } = useKernel();
  const unscopedResourceKey = stageId
    ? concretePath(DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PATH, "stage_id", stageId)
    : `${DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PATH}:none`;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(unscopedResourceKey);
  const load = useCallback(
    ({ signal, sessionScopeKey }: { signal: AbortSignal; sessionScopeKey?: string }) =>
      stageId
        ? api.data.antenna
            .externalLeadInspection(stageId, { signal, sessionScopeKey })
            .catch(ignoreMissingAntennaResource<AntennaExternalLeadInspectionResource>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<AntennaExternalLeadInspectionResource | null>({
    enabled: Boolean(stageId && sessionIdentity) && options.enabled !== false,
    pauseLoad: options.pauseLoad,
    load,
    resolveRevision: (data) => data ? `${data.stage_revision}:${data.record_content_digest}` : null,
    resourceKey,
  });
}

export function useAntennaExternalLeadInspectionPayloadResource(
  inspection: AntennaExternalLeadInspectionResource | null | undefined,
  payloadKind: AntennaInspectionPayloadKind | null | undefined,
  options: Pick<AntennaPayloadResourceOptions, "enabled" | "range"> = {},
) {
  const { api } = useKernel();
  const stageId = inspection?.runtime_stage_id;
  const contentDigest = inspection?.outputs.length === 1
    ? inspection.outputs[0].inspection_ref.content_digest : null;
  const unscopedResourceKey = inspection && stageId && payloadKind && contentDigest
    ? `${concretePath(concretePath(DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PAYLOAD_PATH, "stage_id", stageId), "payload_kind", payloadKind)}?content_digest=${encodeURIComponent(contentDigest)}#${inspection.stage_revision}:${inspection.record_content_digest}${options.range ? `@${options.range}` : ""}`
    : `${DATA_ANTENNA_EXTERNAL_LEAD_INSPECTION_PAYLOAD_PATH}:none`;
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(unscopedResourceKey);
  const ownerMatches = inspection && sessionResourceIdentitiesEqual(sessionIdentity, {
    sessionId: inspection.session_id,
    sessionEpoch: inspection.session_epoch,
    requestScopeEpoch: inspection.request_scope_epoch,
  });
  const hasPayload = Boolean(
    inspection?.status === "inspection_only" && inspection.manifest &&
    contentDigest && inspection.manifest.content_digest === contentDigest,
  );
  const load = useCallback(
    ({ signal, sessionScopeKey }: { signal: AbortSignal; sessionScopeKey?: string }) =>
      ownerMatches && hasPayload && stageId && payloadKind && contentDigest
        ? api.data.antenna.externalLeadInspectionPayload(
            stageId, payloadKind, contentDigest, { signal, sessionScopeKey, range: options.range },
          )
        : Promise.resolve(null),
    [api, contentDigest, hasPayload, options.range, ownerMatches, payloadKind, stageId],
  );

  return useResource<BinaryResourceResult<ArrayBuffer> | null>({
    enabled: Boolean(ownerMatches && hasPayload && stageId && payloadKind) && options.enabled !== false,
    load,
    resolveRevision: (data) => data?.status === "ready" ? data.etag : null,
    resourceKey,
  });
}
