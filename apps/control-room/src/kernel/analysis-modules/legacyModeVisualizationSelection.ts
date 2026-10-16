import type {
  AnalysisResultDatasetCatalogResource,
  AnalysisResultItemPageResource,
  AnalysisResultPageQuery,
} from "@/kernel/api/apiTypes";
import {
  fetchCompleteAnalysisResultDatasetCatalog,
  type AnalysisResultDatasetCatalogFilters,
} from "@/kernel/resources/analysisResultCatalogPagination";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  analysisResultSelectionRef,
  type AnalysisResultSelectionRef,
} from "@/shared/domain/analysis/results";

const ITEM_PAGE_SIZE = 50;

interface LegacyModeProduct {
  itemKind: "driven_frequency_point" | "eigen_mode";
  productKind: "driven_response" | "modal_eigen";
}

const LEGACY_MODE_PRODUCTS: Readonly<Record<string, LegacyModeProduct>> = {
  "results.dispersion.driven.field_at_k": {
    itemKind: "driven_frequency_point",
    productKind: "driven_response",
  },
  "results.dispersion.modal.mode_at_k": {
    itemKind: "eigen_mode",
    productKind: "modal_eigen",
  },
  "results.eigen.mode": {
    itemKind: "eigen_mode",
    productKind: "modal_eigen",
  },
  "results.resonance.driven.field": {
    itemKind: "driven_frequency_point",
    productKind: "driven_response",
  },
  "results.resonance.modal.mode": {
    itemKind: "eigen_mode",
    productKind: "modal_eigen",
  },
};

export interface LegacyModeVisualizationIdentity {
  branchId?: string;
  datasetId?: string;
  datasetRevision?: string;
  fieldId: string;
  itemKind: LegacyModeProduct["itemKind"];
  productKind: LegacyModeProduct["productKind"];
  runId: string;
  sampleId: string;
  stageId: string;
}

export type LegacyModeVisualizationIdentityResult =
  | { identity: LegacyModeVisualizationIdentity; ok: true }
  | { ok: false; reason: string };

export type LegacyModeVisualizationSelectionResult =
  | {
      ok: true;
      selection: Pick<Selection, "kind" | "label" | "ref">;
    }
  | { ok: false; reason: string };

export interface LegacyModeVisualizationPageLoaders {
  loadDatasetPage: (
    query: AnalysisResultDatasetCatalogFilters & {
      cursor?: string;
      limit: 500;
    },
    signal: AbortSignal,
  ) => Promise<AnalysisResultDatasetCatalogResource | null>;
  loadItemPage: (
    datasetId: string,
    query: AnalysisResultPageQuery,
    signal: AbortSignal,
  ) => Promise<AnalysisResultItemPageResource | null>;
}

function nonEmptyIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalIdentity(
  value: unknown,
  label: string,
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (nonEmptyIdentity(value)) return { ok: true, value };
  return { ok: false, reason: `The selected ${label} identity is invalid.` };
}

export function legacyModeVisualizationIdentity(
  selection: Pick<Selection, "kind" | "label" | "ref"> | null,
): LegacyModeVisualizationIdentityResult {
  const ref = selection?.ref;
  if (!selection || ref?.type !== "frequency-domain") {
    return { ok: false, reason: "Select a legacy frequency-domain mode or response field." };
  }
  const product = typeof selection.kind === "string"
    ? LEGACY_MODE_PRODUCTS[selection.kind]
    : undefined;
  if (!product || ref.kind !== selection.kind) {
    return {
      ok: false,
      reason: "This Results selection is not a concrete modal or driven-response field.",
    };
  }
  const runId = ref.analysisRunId;
  const stageId = ref.analysisStageId;
  const sampleId = ref.sampleId;
  const fieldId = ref.fieldId;
  if (
    !nonEmptyIdentity(runId) ||
    !nonEmptyIdentity(stageId) ||
    !nonEmptyIdentity(sampleId) ||
    !nonEmptyIdentity(fieldId)
  ) {
    return {
      ok: false,
      reason: "The selected field needs exact run, stage, sample, and field identities.",
    };
  }
  const datasetId = optionalIdentity(ref.datasetId, "dataset");
  if (!datasetId.ok) return datasetId;
  const datasetRevision = optionalIdentity(ref.datasetRevision, "dataset revision");
  if (!datasetRevision.ok) return datasetRevision;
  const branchId = optionalIdentity(ref.branchId, "branch");
  if (!branchId.ok) return branchId;
  return {
    ok: true,
    identity: {
      ...(branchId.value !== undefined ? { branchId: branchId.value } : {}),
      ...(datasetId.value !== undefined ? { datasetId: datasetId.value } : {}),
      ...(datasetRevision.value !== undefined
        ? { datasetRevision: datasetRevision.value }
        : {}),
      fieldId,
      itemKind: product.itemKind,
      productKind: product.productKind,
      runId,
      sampleId,
      stageId,
    },
  };
}

function invalidItemPage(reason: string): never {
  throw new Error("Invalid legacy mode Results item pagination: " + reason);
}

async function fetchCompleteModeItems({
  datasetId,
  datasetRevision,
  expectedBranchId,
  expectedItemKind,
  expectedRunId,
  expectedSampleId,
  loadPage,
  signal,
}: {
  datasetId: string;
  datasetRevision: string;
  expectedBranchId?: string;
  expectedItemKind: LegacyModeProduct["itemKind"];
  expectedRunId: string;
  expectedSampleId: string;
  loadPage: LegacyModeVisualizationPageLoaders["loadItemPage"];
  signal: AbortSignal;
}): Promise<AnalysisResultItemPageResource["items"]> {
  const seenCursors = new Set<string>();
  const seenItemIds = new Set<string>();
  const items: AnalysisResultItemPageResource["items"][number][] = [];
  let totalCount: number | null = null;
  let cursor: string | undefined;

  for (;;) {
    signal.throwIfAborted();
    const query: AnalysisResultPageQuery = {
      has_field: true,
      item_kind: expectedItemKind,
      limit: ITEM_PAGE_SIZE,
      sample_id: expectedSampleId,
      ...(expectedBranchId !== undefined ? { branch_id: expectedBranchId } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    };
    const page = await loadPage(datasetId, query, signal);
    signal.throwIfAborted();
    if (!page) return invalidItemPage("the item catalog disappeared before pagination completed");
    if (
      page.run_id !== expectedRunId ||
      page.dataset_id !== datasetId ||
      page.dataset_revision !== datasetRevision
    ) {
      return invalidItemPage("run, dataset, or dataset revision changed during pagination");
    }
    if (
      !Number.isSafeInteger(page.total_count) ||
      page.total_count < 0 ||
      !Array.isArray(page.items) ||
      page.items.length > ITEM_PAGE_SIZE
    ) {
      return invalidItemPage("page count or item membership is invalid");
    }
    if (totalCount === null) totalCount = page.total_count;
    else if (page.total_count !== totalCount) {
      return invalidItemPage("total_count changed between pages");
    }

    const pageRecord = page as unknown as Record<string, unknown>;
    const echoedCursor = pageRecord.cursor;
    if (
      echoedCursor !== undefined &&
      echoedCursor !== (cursor ?? null)
    ) {
      return invalidItemPage("the response cursor did not match the requested page");
    }
    const unsupportedReason = pageRecord.unsupported_reason;
    if (unsupportedReason !== undefined && unsupportedReason !== null) {
      return invalidItemPage("the item catalog is unsupported");
    }

    for (const item of page.items) {
      if (
        !item ||
        !nonEmptyIdentity(item.item_id) ||
        item.item_kind !== expectedItemKind ||
        item.sample_id !== expectedSampleId ||
        (expectedBranchId !== undefined && item.branch_id !== expectedBranchId) ||
        !item.field_ref ||
        !nonEmptyIdentity(item.field_ref.field_id)
      ) {
        return invalidItemPage("an item did not match the requested sample, branch, kind, or field filter");
      }
      if (seenItemIds.has(item.item_id)) {
        return invalidItemPage("item membership repeated across pages");
      }
      seenItemIds.add(item.item_id);
      items.push(item);
    }
    if (totalCount === null || items.length > totalCount) {
      return invalidItemPage("page membership exceeds total_count");
    }

    const nextCursor = page.next_cursor ?? null;
    if (
      nextCursor !== null &&
      (typeof nextCursor !== "string" || nextCursor.length === 0)
    ) {
      return invalidItemPage("next_cursor must be a non-empty string or null");
    }
    if (nextCursor !== null && page.items.length === 0) {
      return invalidItemPage("a non-terminal page must contain at least one item");
    }
    if (nextCursor === null) {
      if (totalCount !== items.length) {
        return invalidItemPage("the terminal page did not complete total_count");
      }
      return items;
    }
    if (seenCursors.has(nextCursor)) {
      return invalidItemPage("cursor repeated before reaching the terminal page");
    }
    if (totalCount !== null && items.length >= totalCount) {
      return invalidItemPage("a non-terminal page followed the declared total_count");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export async function resolveLegacyModeVisualizationSelection(
  selection: Pick<Selection, "kind" | "label" | "ref"> | null,
  signal: AbortSignal,
  loaders: LegacyModeVisualizationPageLoaders,
): Promise<LegacyModeVisualizationSelectionResult> {
  const selected = legacyModeVisualizationIdentity(selection);
  if (!selected.ok) return selected;
  const identity = selected.identity;

  const catalog = await fetchCompleteAnalysisResultDatasetCatalog({
    expectedRunId: identity.runId,
    query: {
      product_kind: identity.productKind,
      stage_id: identity.stageId,
    },
    signal,
    loadPage: loaders.loadDatasetPage,
  });
  if (
    !catalog ||
    catalog.status !== "ready" ||
    (catalog.unsupported_reason !== undefined && catalog.unsupported_reason !== null)
  ) {
    return {
      ok: false,
      reason: "No complete supported Results catalog is available for the selected run and stage.",
    };
  }
  if (catalog.items.some((dataset) =>
    dataset.run_id !== identity.runId ||
    dataset.stage_id !== identity.stageId ||
    dataset.product_kind !== identity.productKind
  )) {
    return {
      ok: false,
      reason: "The Results catalog did not honor the selected run, stage, and product filters.",
    };
  }

  const matchingDatasets = catalog.items.filter((dataset) =>
    (identity.datasetId === undefined || dataset.dataset_id === identity.datasetId) &&
    (identity.datasetRevision === undefined ||
      dataset.dataset_revision === identity.datasetRevision)
  );
  if (matchingDatasets.length === 0) {
    return {
      ok: false,
      reason: "The selected dataset identity is not present in the exact Results catalog.",
    };
  }
  if (matchingDatasets.length !== 1) {
    return {
      ok: false,
      reason: "The selected run, stage, and product match multiple Results datasets.",
    };
  }
  const dataset = matchingDatasets[0];
  if (!dataset) {
    return {
      ok: false,
      reason: "The selected dataset identity is not present in the exact Results catalog.",
    };
  }

  const items = await fetchCompleteModeItems({
    datasetId: dataset.dataset_id,
    datasetRevision: dataset.dataset_revision,
    expectedBranchId: identity.branchId,
    expectedItemKind: identity.itemKind,
    expectedRunId: identity.runId,
    expectedSampleId: identity.sampleId,
    loadPage: loaders.loadItemPage,
    signal,
  });
  const matchingItems = items.filter(
    (item) => item.field_ref?.field_id === identity.fieldId,
  );
  if (matchingItems.length === 0) {
    return {
      ok: false,
      reason: "The selected sample and field are not present in the exact Results dataset.",
    };
  }
  if (matchingItems.length !== 1) {
    return {
      ok: false,
      reason: "The selected field matches multiple Results items for this sample and branch.",
    };
  }
  const item = matchingItems[0];
  const fieldRef = item?.field_ref;
  if (
    !item ||
    !fieldRef ||
    fieldRef.status !== "ready" ||
    !nonEmptyIdentity(fieldRef.field_revision) ||
    !nonEmptyIdentity(fieldRef.resource_key)
  ) {
    return {
      ok: false,
      reason: "The selected Results item does not have one ready field owner.",
    };
  }

  const ref: AnalysisResultSelectionRef = analysisResultSelectionRef({
    branchId: item.branch_id ?? undefined,
    datasetId: dataset.dataset_id,
    datasetRevision: dataset.dataset_revision,
    fieldId: fieldRef.field_id,
    fieldRef,
    fieldRevision: fieldRef.field_revision,
    focus: "item",
    itemId: item.item_id,
    itemKind: item.item_kind,
    runId: dataset.run_id,
    sampleId: item.sample_id,
    stageId: dataset.stage_id,
  });
  return {
    ok: true,
    selection: {
      kind: "analysis.result",
      label: selection?.label ?? item.item_id,
      ref,
    },
  };
}
