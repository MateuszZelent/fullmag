import type { DecodedFieldVector } from "@/kernel/api/codecs";

export type FdmFieldIndexingDegradedReason =
  | "duplicate-node-index"
  | "missing-node-indices"
  | "node-index-out-of-range"
  | "point-count-mismatch";

export type FdmFieldIndexingResult =
  | {
      indexing: NonNullable<DecodedFieldVector["indexing"]>;
      resolve: (cellOrdinal: number) => number | null;
      status: "compatible";
    }
  | {
      reason: FdmFieldIndexingDegradedReason;
      status: "degraded";
    };

const DEFAULT_FDM_FIELD_INDEXING = "legacy_count_only" as const;

export function buildFdmFieldIndexResolver(
  fieldVector: Pick<
    DecodedFieldVector,
    "indexing" | "nodeIndices" | "pointCount"
  > &
    Partial<Pick<DecodedFieldVector, "grid" | "nComp">>,
  domainCellCount: number,
  _domainGridShape?: readonly [number, number, number] | null,
): FdmFieldIndexingResult {
  const safeDomainCellCount = Math.max(0, Math.floor(domainCellCount));
  const indexing = fieldVector.indexing ?? DEFAULT_FDM_FIELD_INDEXING;

  if (indexing === "full_domain" || indexing === "legacy_count_only") {
    if (fieldVector.pointCount !== safeDomainCellCount) {
      return { reason: "point-count-mismatch", status: "degraded" };
    }
    return {
      indexing,
      resolve: (cellOrdinal) =>
        Number.isInteger(cellOrdinal) &&
        cellOrdinal >= 0 &&
        cellOrdinal < safeDomainCellCount
          ? cellOrdinal
          : null,
      status: "compatible",
    };
  }

  const nodeIndices = fieldVector.nodeIndices;
  if (!nodeIndices || nodeIndices.length !== fieldVector.pointCount) {
    return { reason: "missing-node-indices", status: "degraded" };
  }

  // A thin-film object often occupies consecutive global ordinals. Verify
  // the entire run before using direct arithmetic, with no per-cell map.
  const first = nodeIndices[0];
  const last = nodeIndices[nodeIndices.length - 1];
  if (first !== undefined && Number.isInteger(first) && first >= 0 &&
      last !== undefined && last < safeDomainCellCount &&
      last - first + 1 === nodeIndices.length &&
      nodeIndices.findIndex((ordinal, index) => ordinal !== first + index) === -1) {
    return {
      indexing,
      resolve: (ordinal) => Number.isInteger(ordinal) && ordinal >= first && ordinal <= last
        ? ordinal - first
        : null,
      status: "compatible",
    };
  }

  const fieldIndexByCell = new Map<number, number>();
  for (let fieldIndex = 0; fieldIndex < nodeIndices.length; fieldIndex += 1) {
    const cellOrdinal = nodeIndices[fieldIndex];
    if (
      cellOrdinal === undefined ||
      !Number.isInteger(cellOrdinal) ||
      cellOrdinal < 0 ||
      cellOrdinal >= safeDomainCellCount
    ) {
      return { reason: "node-index-out-of-range", status: "degraded" };
    }
    if (fieldIndexByCell.has(cellOrdinal)) {
      return { reason: "duplicate-node-index", status: "degraded" };
    }
    fieldIndexByCell.set(cellOrdinal, fieldIndex);
  }

  return {
    indexing,
    resolve: (cellOrdinal) => fieldIndexByCell.get(cellOrdinal) ?? null,
    status: "compatible",
  };
}
