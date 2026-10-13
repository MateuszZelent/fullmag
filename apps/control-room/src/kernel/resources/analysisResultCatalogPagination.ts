import type {
  AnalysisResultDatasetCatalogResource,
  AnalysisResultPageQuery,
} from "../api/apiTypes";

export const ANALYSIS_RESULT_DATASET_CATALOG_PAGE_SIZE = 500;

export type AnalysisResultDatasetCatalogFilters = Omit<
  AnalysisResultPageQuery,
  "cursor" | "limit"
>;

type CatalogRequestQuery = AnalysisResultDatasetCatalogFilters & {
  cursor?: string;
  limit: typeof ANALYSIS_RESULT_DATASET_CATALOG_PAGE_SIZE;
};

type CatalogPageLoader = (
  query: CatalogRequestQuery,
  signal: AbortSignal,
) => Promise<AnalysisResultDatasetCatalogResource | null>;

export interface CompleteAnalysisResultDatasetCatalogOptions {
  expectedRunId: string;
  query: AnalysisResultDatasetCatalogFilters;
  signal: AbortSignal;
  loadPage: CatalogPageLoader;
}

interface CatalogPageMetadata {
  runId: string;
  revision: string;
  schemaVersion: string;
  status: string;
  totalCount: number;
  unsupportedReason: string | null;
}

function invalidPage(reason: string): never {
  throw new Error("Invalid analysis result dataset catalog pagination: " + reason);
}

function inspectPage(
  page: AnalysisResultDatasetCatalogResource,
  expectedRunId: string,
): CatalogPageMetadata {
  if (!page || typeof page !== "object") {
    return invalidPage("page must be an object");
  }
  if (page.run_id !== expectedRunId) {
    return invalidPage("page run_id changed or did not match the requested run");
  }
  if (typeof page.revision !== "string" || page.revision.length === 0) {
    return invalidPage("page revision must be a non-empty string");
  }
  if (typeof page.schema_version !== "string" || page.schema_version.length === 0) {
    return invalidPage("page schema_version must be a non-empty string");
  }
  if (typeof page.status !== "string" || page.status.length === 0) {
    return invalidPage("page status must be a non-empty string");
  }
  if (!Number.isSafeInteger(page.total_count) || page.total_count < 0) {
    return invalidPage("page total_count must be a non-negative safe integer");
  }
  if (!Array.isArray(page.items)) {
    return invalidPage("page items must be an array");
  }
  if (page.items.length > ANALYSIS_RESULT_DATASET_CATALOG_PAGE_SIZE) {
    return invalidPage("page exceeded the requested 500-item limit");
  }
  if (
    page.unsupported_reason !== undefined &&
    page.unsupported_reason !== null &&
    typeof page.unsupported_reason !== "string"
  ) {
    return invalidPage("unsupported_reason must be a string or null");
  }
  if (
    page.next_cursor !== undefined &&
    page.next_cursor !== null &&
    (typeof page.next_cursor !== "string" || page.next_cursor.length === 0)
  ) {
    return invalidPage("next_cursor must be a non-empty string or null");
  }

  return {
    runId: page.run_id,
    revision: page.revision,
    schemaVersion: page.schema_version,
    status: page.status,
    totalCount: page.total_count,
    unsupportedReason: page.unsupported_reason ?? null,
  };
}

function assertSameMetadata(
  expected: CatalogPageMetadata,
  actual: CatalogPageMetadata,
): void {
  if (
    expected.runId !== actual.runId ||
    expected.revision !== actual.revision ||
    expected.schemaVersion !== actual.schemaVersion ||
    expected.status !== actual.status ||
    expected.totalCount !== actual.totalCount ||
    expected.unsupportedReason !== actual.unsupportedReason
  ) {
    invalidPage("run, revision, status, count, or schema changed between pages");
  }
}

function appendUniqueItems(
  page: AnalysisResultDatasetCatalogResource,
  expectedRunId: string,
  datasetRevisions: Map<string, string>,
  items: AnalysisResultDatasetCatalogResource["items"],
): void {
  for (const item of page.items) {
    if (
      !item ||
      typeof item.run_id !== "string" ||
      item.run_id !== expectedRunId ||
      typeof item.dataset_id !== "string" ||
      item.dataset_id.length === 0 ||
      typeof item.dataset_revision !== "string" ||
      item.dataset_revision.length === 0
    ) {
      invalidPage("item must have the requested run and a dataset identity");
    }
    const identity = JSON.stringify([item.run_id, item.dataset_id]);
    const existingRevision = datasetRevisions.get(identity);
    if (existingRevision !== undefined) {
      if (existingRevision !== item.dataset_revision) {
        invalidPage("dataset_id repeated with conflicting dataset_revision");
      }
      invalidPage("duplicate dataset membership across catalog pages");
    }
    datasetRevisions.set(identity, item.dataset_revision);
    items.push(item);
  }
}

export async function fetchCompleteAnalysisResultDatasetCatalog({
  expectedRunId,
  query,
  signal,
  loadPage,
}: CompleteAnalysisResultDatasetCatalogOptions): Promise<AnalysisResultDatasetCatalogResource | null> {
  if (
    Object.prototype.hasOwnProperty.call(query, "cursor") ||
    Object.prototype.hasOwnProperty.call(query, "limit")
  ) {
    invalidPage("filters cannot supply cursor or limit");
  }
  const datasetRevisions = new Map<string, string>();
  const seenCursors = new Set<string>();
  const items: AnalysisResultDatasetCatalogResource["items"] = [];
  let metadata: CatalogPageMetadata | null = null;
  let firstPage: AnalysisResultDatasetCatalogResource | null = null;
  let cursor: string | undefined;

  for (;;) {
    signal.throwIfAborted();
    const requestQuery: CatalogRequestQuery = {
      ...query,
      limit: ANALYSIS_RESULT_DATASET_CATALOG_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    };
    const page = await loadPage(requestQuery, signal);
    signal.throwIfAborted();

    if (page === null) {
      if (cursor === undefined && firstPage === null) return null;
      invalidPage("catalog disappeared before all cursor pages were read");
    }

    const pageMetadata = inspectPage(page, expectedRunId);
    if (metadata === null) {
      metadata = pageMetadata;
      firstPage = page;
    } else {
      assertSameMetadata(metadata, pageMetadata);
    }
    appendUniqueItems(page, expectedRunId, datasetRevisions, items);
    if (metadata === null || items.length > metadata.totalCount) {
      invalidPage("page membership exceeds total_count");
    }

    const nextCursor = page.next_cursor ?? null;
    if (nextCursor !== null && page.items.length === 0) {
      invalidPage("non-terminal page must contain at least one item");
    }
    if (nextCursor === null) {
      if (items.length !== metadata.totalCount) {
        invalidPage("terminal page did not complete total_count");
      }
      if (firstPage === null) {
        invalidPage("catalog did not include its initial page");
      }
      return {
        ...firstPage,
        items,
        next_cursor: null,
      };
    }
    if (seenCursors.has(nextCursor)) {
      invalidPage("cursor repeated before reaching the terminal page");
    }
    if (items.length >= metadata.totalCount) {
      invalidPage("non-terminal page followed the declared total_count");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}