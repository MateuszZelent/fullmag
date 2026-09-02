"use client";

import { useCallback, useMemo } from "react";

import {
  ANALYSIS_RESULT_AXIS_VALUES_PATH,
  ANALYSIS_RESULT_BRANCH_PATH,
  ANALYSIS_RESULT_BRANCH_POINTS_PATH,
  ANALYSIS_RESULT_BRANCHES_PATH,
  ANALYSIS_RESULT_DATASET_PATH,
  ANALYSIS_RESULT_DATASETS_PATH,
  ANALYSIS_RESULT_ITEM_PATH,
  ANALYSIS_RESULT_ITEMS_PATH,
  ANALYSIS_RESULT_PROJECTION_PATH,
  ANALYSIS_RESULT_RELATION_PATH,
  ANALYSIS_RESULT_RELATIONS_PATH,
  ANALYSIS_RESULT_SAMPLES_PATH,
} from "../api/apiPaths";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import type {
  AnalysisResultAxisValuesResource,
  AnalysisResultBranchPageResource,
  AnalysisResultBranchPointPageResource,
  AnalysisResultBranchResource,
  AnalysisResultDatasetCatalogResource,
  AnalysisResultDatasetManifestResource,
  AnalysisResultItemPageResource,
  AnalysisResultPageQuery,
  AnalysisResultProjectionResource,
  AnalysisResultRelationPageResource,
  AnalysisResultRelationResource,
  AnalysisResultSamplePageResource,
  AnalysisResultSpectralItemSummary,
} from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";

interface AnalysisResultResourceOptions {
  enabled?: boolean;
  query?: AnalysisResultPageQuery;
}

function concretePath(
  template: string,
  params: Record<string, string>,
): string {
  return Object.entries(params).reduce(
    (path, [key, value]) =>
      path.replace(`{${key}}`, encodeURIComponent(value)),
    template,
  );
}

function queryString(query: AnalysisResultPageQuery): string {
  const params = new URLSearchParams();
  Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([key, value]) => {
      if (value !== undefined) params.set(key, String(value));
    });
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function queryFromKey(queryKey: string): AnalysisResultPageQuery {
  return JSON.parse(queryKey) as AnalysisResultPageQuery;
}

function resultResourceKey(
  template: string,
  params: Record<string, string>,
  query: AnalysisResultPageQuery = {},
): string {
  return `${concretePath(template, params)}${queryString(query)}`;
}

function ignoreMissingResultResource<T>(error: unknown): T | null {
  if (error instanceof ControlRoomApiError && error.status === 404) return null;
  throw error;
}

export function useAnalysisResultDatasetCatalogResource(
  runId: string | null | undefined,
  options: AnalysisResultResourceOptions = {},
) {
  const { api } = useKernel();
  const queryKey = JSON.stringify(options.query ?? {});
  const query = useMemo(() => queryFromKey(queryKey), [queryKey]);
  const resourceKey = runId
    ? resultResourceKey(ANALYSIS_RESULT_DATASETS_PATH, { run_id: runId }, query)
    : `${ANALYSIS_RESULT_DATASETS_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      runId
        ? api.analysis.results
            .datasets(runId, query, { signal })
            .catch(ignoreMissingResultResource<AnalysisResultDatasetCatalogResource>)
        : Promise.resolve(null),
    [api, query, runId],
  );

  return useResource<AnalysisResultDatasetCatalogResource | null>({
    enabled: Boolean(runId) && options.enabled !== false,
    load,
    resolveRevision: (data) => data?.revision ?? null,
    resourceKey,
  });
}

export function useAnalysisResultDatasetManifestResource(
  runId: string | null | undefined,
  datasetId: string | null | undefined,
  options: Omit<AnalysisResultResourceOptions, "query"> = {},
) {
  const { api } = useKernel();
  const resourceKey = runId && datasetId
    ? resultResourceKey(ANALYSIS_RESULT_DATASET_PATH, {
        dataset_id: datasetId,
        run_id: runId,
      })
    : `${ANALYSIS_RESULT_DATASET_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      runId && datasetId
        ? api.analysis.results
            .dataset(runId, datasetId, { signal })
            .catch(ignoreMissingResultResource<AnalysisResultDatasetManifestResource>)
        : Promise.resolve(null),
    [api, datasetId, runId],
  );

  return useResource<AnalysisResultDatasetManifestResource | null>({
    enabled: Boolean(runId && datasetId) && options.enabled !== false,
    load,
    resolveRevision: (data) => data?.dataset_revision ?? null,
    resourceKey,
  });
}

export function useAnalysisResultAxisValuesResource(
  runId: string | null | undefined,
  datasetId: string | null | undefined,
  axisId: string | null | undefined,
  options: AnalysisResultResourceOptions = {},
) {
  const { api } = useKernel();
  const queryKey = JSON.stringify(options.query ?? {});
  const query = useMemo(() => queryFromKey(queryKey), [queryKey]);
  const resourceKey = runId && datasetId && axisId
    ? resultResourceKey(ANALYSIS_RESULT_AXIS_VALUES_PATH, {
        axis_id: axisId,
        dataset_id: datasetId,
        run_id: runId,
      }, query)
    : `${ANALYSIS_RESULT_AXIS_VALUES_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      runId && datasetId && axisId
        ? api.analysis.results
            .axisValues(runId, datasetId, axisId, query, { signal })
            .catch(ignoreMissingResultResource<AnalysisResultAxisValuesResource>)
        : Promise.resolve(null),
    [api, axisId, datasetId, query, runId],
  );

  return useResource<AnalysisResultAxisValuesResource | null>({
    enabled: Boolean(runId && datasetId && axisId) && options.enabled !== false,
    load,
    resolveRevision: (data) => data?.dataset_revision ?? null,
    resourceKey,
  });
}

export function useAnalysisResultSamplesResource(
  runId: string | null | undefined,
  datasetId: string | null | undefined,
  options: AnalysisResultResourceOptions = {},
) {
  return usePagedAnalysisResultResource<AnalysisResultSamplePageResource>(
    ANALYSIS_RESULT_SAMPLES_PATH,
    "samples",
    runId,
    datasetId,
    options,
  );
}

export function useAnalysisResultItemsResource(
  runId: string | null | undefined,
  datasetId: string | null | undefined,
  options: AnalysisResultResourceOptions = {},
) {
  return usePagedAnalysisResultResource<AnalysisResultItemPageResource>(
    ANALYSIS_RESULT_ITEMS_PATH,
    "items",
    runId,
    datasetId,
    options,
  );
}

export function useAnalysisResultBranchesResource(
  runId: string | null | undefined,
  datasetId: string | null | undefined,
  options: AnalysisResultResourceOptions = {},
) {
  return usePagedAnalysisResultResource<AnalysisResultBranchPageResource>(
    ANALYSIS_RESULT_BRANCHES_PATH,
    "branches",
    runId,
    datasetId,
    options,
  );
}

export function useAnalysisResultBranchPointsResource(
  runId: string | null | undefined,
  datasetId: string | null | undefined,
  branchId: string | null | undefined,
  options: AnalysisResultResourceOptions = {},
) {
  return usePagedAnalysisResultResource<AnalysisResultBranchPointPageResource>(
    ANALYSIS_RESULT_BRANCH_POINTS_PATH,
    "branchPoints",
    runId,
    datasetId,
    options,
    branchId,
  );
}

export function useAnalysisResultRelationsResource(
  runId: string | null | undefined,
  datasetId: string | null | undefined,
  options: AnalysisResultResourceOptions = {},
) {
  return usePagedAnalysisResultResource<AnalysisResultRelationPageResource>(
    ANALYSIS_RESULT_RELATIONS_PATH,
    "relations",
    runId,
    datasetId,
    options,
  );
}

export function useAnalysisResultItemResource(
  runId: string | null | undefined,
  datasetId: string | null | undefined,
  itemId: string | null | undefined,
  options: Omit<AnalysisResultResourceOptions, "query"> = {},
) {
  const { api } = useKernel();
  const resourceKey = runId && datasetId && itemId
    ? resultResourceKey(ANALYSIS_RESULT_ITEM_PATH, {
        dataset_id: datasetId,
        item_id: itemId,
        run_id: runId,
      })
    : `${ANALYSIS_RESULT_ITEMS_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      runId && datasetId && itemId
        ? api.analysis.results
            .item(runId, datasetId, itemId, { signal })
            .catch(ignoreMissingResultResource<AnalysisResultSpectralItemSummary>)
        : Promise.resolve(null),
    [api, datasetId, itemId, runId],
  );

  return useResource<AnalysisResultSpectralItemSummary | null>({
    enabled: Boolean(runId && datasetId && itemId) && options.enabled !== false,
    load,
    resolveRevision: (data) => data?.source_revision ?? null,
    resourceKey,
  });
}

export function useAnalysisResultBranchResource(
  runId: string | null | undefined,
  datasetId: string | null | undefined,
  branchId: string | null | undefined,
  options: Omit<AnalysisResultResourceOptions, "query"> = {},
) {
  const { api } = useKernel();
  const resourceKey = runId && datasetId && branchId
    ? resultResourceKey(ANALYSIS_RESULT_BRANCH_PATH, {
        branch_id: branchId,
        dataset_id: datasetId,
        run_id: runId,
      })
    : `${ANALYSIS_RESULT_BRANCH_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      runId && datasetId && branchId
        ? api.analysis.results
            .branch(runId, datasetId, branchId, { signal })
            .catch(ignoreMissingResultResource<AnalysisResultBranchResource>)
        : Promise.resolve(null),
    [api, branchId, datasetId, runId],
  );

  return useResource<AnalysisResultBranchResource | null>({
    enabled: Boolean(runId && datasetId && branchId) && options.enabled !== false,
    load,
    resolveRevision: (data) => data?.dataset_revision ?? null,
    resourceKey,
  });
}

export function useAnalysisResultRelationResource(
  runId: string | null | undefined,
  datasetId: string | null | undefined,
  relationId: string | null | undefined,
  options: Omit<AnalysisResultResourceOptions, "query"> = {},
) {
  const { api } = useKernel();
  const resourceKey = runId && datasetId && relationId
    ? resultResourceKey(ANALYSIS_RESULT_RELATION_PATH, {
        dataset_id: datasetId,
        relation_id: relationId,
        run_id: runId,
      })
    : `${ANALYSIS_RESULT_RELATION_PATH}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      runId && datasetId && relationId
        ? api.analysis.results
            .relation(runId, datasetId, relationId, { signal })
            .catch(ignoreMissingResultResource<AnalysisResultRelationResource>)
        : Promise.resolve(null),
    [api, datasetId, relationId, runId],
  );

  return useResource<AnalysisResultRelationResource | null>({
    enabled: Boolean(runId && datasetId && relationId) && options.enabled !== false,
    load,
    resolveRevision: (data) => data?.relation.source_revision ?? null,
    resourceKey,
  });
}

function usePagedAnalysisResultResource<
  TData extends
    | AnalysisResultBranchPageResource
    | AnalysisResultBranchPointPageResource
    | AnalysisResultItemPageResource
    | AnalysisResultRelationPageResource
    | AnalysisResultSamplePageResource,
>(
  template: string,
  kind: "branchPoints" | "branches" | "items" | "relations" | "samples",
  runId: string | null | undefined,
  datasetId: string | null | undefined,
  options: AnalysisResultResourceOptions,
  branchId?: string | null,
) {
  const { api } = useKernel();
  const queryKey = JSON.stringify(options.query ?? {});
  const query = useMemo(() => queryFromKey(queryKey), [queryKey]);
  const resourceKey = runId && datasetId && (kind !== "branchPoints" || branchId)
    ? resultResourceKey(template, {
        ...(branchId ? { branch_id: branchId } : {}),
        dataset_id: datasetId,
        run_id: runId,
      }, query)
    : `${template}:none`;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!runId || !datasetId || (kind === "branchPoints" && !branchId)) {
        return Promise.resolve(null);
      }
      const request = kind === "items"
        ? api.analysis.results.items(runId, datasetId, query, { signal })
        : kind === "samples"
          ? api.analysis.results.samples(runId, datasetId, query, { signal })
          : kind === "branches"
            ? api.analysis.results.branches(runId, datasetId, query, { signal })
            : kind === "relations"
              ? api.analysis.results.relations(runId, datasetId, query, { signal })
              : api.analysis.results.branchPoints(
                  runId,
                  datasetId,
                  branchId as string,
                  query,
                  { signal },
                );
      return request.catch(
        ignoreMissingResultResource<
          | AnalysisResultBranchPageResource
          | AnalysisResultBranchPointPageResource
          | AnalysisResultItemPageResource
          | AnalysisResultRelationPageResource
          | AnalysisResultSamplePageResource
        >,
      ) as Promise<TData | null>;
    },
    [api, branchId, datasetId, kind, query, runId],
  );

  return useResource<TData | null>({
    enabled: Boolean(runId && datasetId && (kind !== "branchPoints" || branchId)) && options.enabled !== false,
    load,
    resolveRevision: (data) => data?.dataset_revision ?? null,
    resourceKey,
  });
}

export function useAnalysisResultProjectionResource(
  runId: string | null | undefined,
  datasetId: string | null | undefined,
  projectionId: string | null | undefined,
  options: Omit<AnalysisResultResourceOptions, "query"> = {},
) {
  const { api } = useKernel();
  const resourceKey = useMemo(
    () => runId && datasetId && projectionId
      ? resultResourceKey(ANALYSIS_RESULT_PROJECTION_PATH, {
          dataset_id: datasetId,
          projection_id: projectionId,
          run_id: runId,
        })
      : `${ANALYSIS_RESULT_PROJECTION_PATH}:none`,
    [datasetId, projectionId, runId],
  );
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      runId && datasetId && projectionId
        ? api.analysis.results
            .projection(runId, datasetId, projectionId, { signal })
            .catch(ignoreMissingResultResource<AnalysisResultProjectionResource>)
        : Promise.resolve(null),
    [api, datasetId, projectionId, runId],
  );

  return useResource<AnalysisResultProjectionResource | null>({
    enabled: Boolean(runId && datasetId && projectionId) && options.enabled !== false,
    load,
    resolveRevision: (data) => data?.projection_revision ?? null,
    resourceKey,
  });
}
