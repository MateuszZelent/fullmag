"use client";

import { useCallback } from "react";

import {
  DATA_ANTENNA_FIELD_SOLUTION_PATH,
  DATA_ANTENNA_STAGE_OUTPUT_CATALOG_PATH,
  DATA_ANTENNA_SOURCE_SPECTRUM_PATH,
  DATA_ANTENNA_SOURCE_SPECTRUM_PAYLOAD_PATH,
} from "../api/apiPaths";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import type {
  AntennaFieldSolutionResource,
  AntennaStageOutputCatalogResource,
  AntennaSpectrumPayloadKind,
  AntennaSourceSpectrumResource,
  BinaryResourceResult,
} from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";

export interface AntennaResourceOptions {
  enabled?: boolean;
}

interface AntennaPayloadResourceOptions extends AntennaResourceOptions {
  expectedEtag?: string;
}

export function antennaSpectrumPayloadEtag(
  spectrum: AntennaSourceSpectrumResource,
  payloadKind: AntennaSpectrumPayloadKind,
): string {
  if (!spectrum.payloads) {
    throw new Error("antenna spectrum manifest has no binary payload references");
  }
  const token = `antenna-source-spectrum-payload:${spectrum.session_id}:${spectrum.session_epoch}:${spectrum.output_id}:${payloadKind}:${spectrum.content_digest}:${spectrum.payloads[payloadKind].sha256}`;
  return `"${token.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function requireMatchingAntennaPayloadRevision(
  result: BinaryResourceResult<ArrayBuffer> | null,
  expectedEtag: string,
): BinaryResourceResult<ArrayBuffer> | null {
  if (result?.status === "ready" && result.etag !== expectedEtag) {
    throw new Error("antenna spectrum payload revision does not match selected manifest");
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
  const resourceKey = solutionId
    ? concretePath(DATA_ANTENNA_FIELD_SOLUTION_PATH, "solution_id", solutionId)
    : `${DATA_ANTENNA_FIELD_SOLUTION_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      solutionId
        ? api.data.antenna
            .fieldSolution(solutionId, { signal })
            .catch(ignoreMissingAntennaResource<AntennaFieldSolutionResource>)
        : Promise.resolve(null),
    [api, solutionId],
  );

  return useResource<AntennaFieldSolutionResource | null>({
    enabled: Boolean(solutionId) && options.enabled !== false,
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
  const resourceKey = stageId
    ? concretePath(
        DATA_ANTENNA_STAGE_OUTPUT_CATALOG_PATH,
        "stage_id",
        stageId,
      )
    : `${DATA_ANTENNA_STAGE_OUTPUT_CATALOG_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      stageId
        ? api.data.antenna
            .stageOutputCatalog(stageId, { signal })
            .catch(ignoreMissingAntennaResource<AntennaStageOutputCatalogResource>)
        : Promise.resolve(null),
    [api, stageId],
  );

  return useResource<AntennaStageOutputCatalogResource | null>({
    enabled: Boolean(stageId) && options.enabled !== false,
    load,
    resolveRevision: (data) =>
      data
        ? `${data.stage_revision}:${data.content_digest}`
        : null,
    resourceKey,
  });
}

export function useAntennaSourceSpectrumResource(
  outputId: string | null | undefined,
  options: AntennaResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = outputId
    ? concretePath(DATA_ANTENNA_SOURCE_SPECTRUM_PATH, "output_id", outputId)
    : `${DATA_ANTENNA_SOURCE_SPECTRUM_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      outputId
        ? api.data.antenna
            .sourceSpectrum(outputId, { signal })
            .catch(ignoreMissingAntennaResource<AntennaSourceSpectrumResource>)
        : Promise.resolve(null),
    [api, outputId],
  );

  return useResource<AntennaSourceSpectrumResource | null>({
    enabled: Boolean(outputId) && options.enabled !== false,
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
  const resourceKey = outputId && payloadKind
    ? `${concreteSpectrumPayloadPath(outputId, payloadKind)}${options.expectedEtag ? `#${options.expectedEtag}` : ""}`
    : `${DATA_ANTENNA_SOURCE_SPECTRUM_PAYLOAD_PATH}:none`;
  const load = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      if (!outputId || !payloadKind) return null;
      const result = await api.data.antenna
        .sourceSpectrumPayload(outputId, payloadKind, { signal })
        .catch(ignoreMissingAntennaResource<BinaryResourceResult<ArrayBuffer>>);
      return options.expectedEtag
        ? requireMatchingAntennaPayloadRevision(result, options.expectedEtag)
        : result;
    },
    [api, options.expectedEtag, outputId, payloadKind],
  );

  return useResource<BinaryResourceResult<ArrayBuffer> | null>({
    enabled:
      Boolean(outputId && payloadKind) && options.enabled !== false,
    load,
    resolveRevision: (data) =>
      data?.status === "ready" ? data.etag : null,
    resourceKey,
  });
}
