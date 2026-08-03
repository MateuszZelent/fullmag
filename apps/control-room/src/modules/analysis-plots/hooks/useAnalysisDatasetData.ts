"use client";

import { useEffect, useMemo, useState } from "react";

import {
  useTableColumnsResource,
  useTableListResource,
  useTableResource,
  useTableRowsBinaryResource,
} from "@/kernel/resources/studyRuntimeResources";
import { analysisColumnDescriptorsForQuery, chartTableWindowFromBinary } from "@/shared/domain/analysis/chartDataPlan";

/**
 * Analysis never consumes the active live table. The selected reference is
 * resolved against published table identities before any rows are requested.
 */
export function resolveAnalysisDatasetTableId(
  datasetRef: string | null,
  publishedTableIds: readonly string[],
): string | null {
  if (!datasetRef) return null;
  return publishedTableIds.includes(datasetRef) ? datasetRef : null;
}

export function shouldLoadAnalysisDatasetRows({
  datasetRef,
  enabled,
  hasSchema,
}: {
  datasetRef: string | null;
  enabled: boolean;
  hasSchema: boolean;
}): boolean {
  return enabled && datasetRef !== null && hasSchema;
}

export function useAnalysisDatasetData({ datasetRef, enabled }: { datasetRef: string | null; enabled: boolean }) {
  const tableList = useTableListResource({ enabled });
  const tableId = resolveAnalysisDatasetTableId(datasetRef, tableList.data?.tables.map((table) => table.table_id) ?? []);
  const table = useTableResource(tableId ?? "default", { enabled: enabled && tableId !== null });
  const columns = useTableColumnsResource(tableId ?? "default", { enabled: enabled && tableId !== null });
  const columnIds = useMemo(() => columns.data?.map((column) => column.column_id) ?? [], [columns.data]);
  const [pinned, setPinned] = useState<{ datasetRef: string; revision: string | number | null; table: ReturnType<typeof chartTableWindowFromBinary> } | null>(null);
  const pinnedForDataset = pinned?.datasetRef === datasetRef ? pinned : null;
  useEffect(() => {
    if (pinned && pinned.datasetRef !== datasetRef) setPinned(null);
  }, [datasetRef, pinned]);
  const rows = useTableRowsBinaryResource(tableId ?? "default", {
    columns: columnIds,
    enabled: shouldLoadAnalysisDatasetRows({ datasetRef: tableId ? datasetRef : null, enabled: enabled && !pinnedForDataset, hasSchema: columnIds.length > 0 }),
    limit: 5_000,
    targetPoints: 1_600,
  });
  const decodedTable = useMemo(() => {
    if (!rows.data || rows.data.status !== "ready" || !columns.data || !tableId) return null;
    const selected = analysisColumnDescriptorsForQuery(columns.data, columnIds);
    return selected.length === rows.data.data.columnCount
      ? chartTableWindowFromBinary({ columns: selected, decoded: rows.data.data, tableId })
      : null;
  }, [columnIds, columns.data, rows.data, tableId]);
  useEffect(() => {
    if (!datasetRef || !decodedTable || pinnedForDataset) return;
    setPinned({ datasetRef, revision: decodedTable.revision, table: decodedTable });
  }, [datasetRef, decodedTable, pinnedForDataset]);
  const visibleTable = pinnedForDataset?.table ?? decodedTable;
  const unsupportedReason = enabled && datasetRef !== null && tableList.status === "ready" && !tableId
    ? "The selected dataset is not available in this session."
    : columns.status === "ready" && columns.data?.length === 0
      ? "The selected dataset does not publish scalar table samples."
      : null;
  return { columns, rows, table, tableId, tableList, unsupportedReason, visibleRevision: pinnedForDataset?.revision ?? visibleTable?.revision ?? null, visibleTable };
}
