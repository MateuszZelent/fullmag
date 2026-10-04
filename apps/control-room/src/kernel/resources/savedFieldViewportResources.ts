"use client";

import { useCallback, useMemo } from "react";

import type {
  MaterializedDatasetResource,
  SavedFieldGeometryResource,
} from "../api/apiTypes";
import {
  MAX_DATASET_SLICE_BYTES,
  materializedDatasetSliceByteLimit,
  type MaterializedDatasetSliceRange,
  type DecodedMaterializedDatasetSlice,
} from "../api/codecs/materializedDatasetSliceCodec";
import type { DecodedTopology } from "../api/codecs/types";
import {
  savedSupportNodeIsActive,
  type DecodedSavedSupport,
} from "../api/codecs/savedSupportCodec";
import {
  canonicalSavedGeometryJson,
} from "../api/savedGeometryIdentity";
import {
  savedGeometryBinaryResourceKey,
  savedGeometryResourceKey,
} from "./savedGeometryResources";
import { useKernel } from "../KernelContext";
import { useResource } from "./useResource";
import type { ResourceResult } from "./resourceTypes";

export const SAVED_VIEWPORT_FIELD_MAX_BYTES = MAX_DATASET_SLICE_BYTES;
export const SAVED_VIEWPORT_FIELD_MAX_CHUNKS = 4096;
const MAX_U64 = BigInt("18446744073709551615");
const ZERO = BigInt(0);

export type SavedFieldViewportDtype = "f32" | "f64";

/**
 * A saved field remains a transport value until the viewport adapter makes an
 * explicit render-only view.  In particular, this type carries no session or
 * live-domain identity and keeps the producer dtype visible for diagnostics.
 */
export interface SavedFieldViewportValues {
  componentCount: number;
  dtype: SavedFieldViewportDtype;
  geometryObjectRef: string;
  layoutDigest: string;
  nodeCount: number;
  quantityId: string;
  representationEvidence: "not_verified";
  savedScopeKey: string;
  supportFingerprint: string;
  topologyFingerprint: string;
  unit: string;
  values: Float32Array | Float64Array;
}

export type SavedFieldViewportEligibility =
  | { reason: string; status: "unavailable" }
  | {
      range: MaterializedDatasetSliceRange;
      status: "ready";
      totalBytes: number;
    };

export interface SavedFieldViewportResources {
  eligibility: SavedFieldViewportEligibility;
  field: ResourceResult<SavedFieldViewportValues | null>;
  geometry: ResourceResult<SavedFieldGeometryResource>;
  support: ResourceResult<DecodedSavedSupport | null>;
  topology: ResourceResult<DecodedTopology | null>;
}

function counter(value: string, label: string): bigint {
  if (
    typeof value !== "string" ||
    value.length > 20 ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    throw new Error(`${label} must be a canonical decimal u64.`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_U64) throw new Error(`${label} exceeds u64.`);
  return parsed;
}

function safeCount(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the JavaScript safe integer range.`);
  }
  return Number(value);
}

function unavailable(reason: string): SavedFieldViewportEligibility {
  return { reason, status: "unavailable" };
}

/**
 * Pure admission gate for the saved viewport path.  Every identity and
 * layout comparison is repeated here because this gate is also the boundary
 * between the metadata resources and the binary field resource.
 */
export function resolveSavedFieldViewportEligibility(
  dataset: MaterializedDatasetResource | null,
  geometry: SavedFieldGeometryResource | null,
  topology: DecodedTopology | null,
  support: DecodedSavedSupport | null,
): SavedFieldViewportEligibility {
  if (!dataset) return unavailable("Pinned materialized dataset is unavailable.");
  if (!geometry) return unavailable("Pinned field geometry is unavailable.");
  if (!topology) return unavailable("Pinned field topology is unavailable.");
  if (!support) {
    return unavailable(
      "Pinned active-node support is unavailable within the bounded transport.",
    );
  }
  if (geometry.representation_evidence !== "not_verified") {
    return unavailable("Saved geometry representation evidence is unsupported.");
  }

  const descriptor = dataset.field.descriptor;
  const coverage = dataset.field.coverage;
  if (
    dataset.integrity !== "verified" ||
    dataset.field.plane !== "values" ||
    descriptor.sample_location !== "node" ||
    descriptor.complex_encoding !== "real" ||
    descriptor.harmonic_convention !== null ||
    descriptor.value_representation !== "physical_field" ||
    descriptor.function_space?.ordering !== "by_node"
  ) {
    return unavailable(
      "Saved field semantics are not a direct real nodal physical field.",
    );
  }

  let totalElements: bigint;
  let componentCount: bigint;
  let totalBytes: bigint;
  let chunkCount: bigint;
  try {
    totalElements = counter(coverage.total_elements, "Saved field element count");
    componentCount = counter(coverage.component_count, "Saved field component count");
    totalBytes = counter(coverage.total_bytes, "Saved field byte count");
    chunkCount = counter(coverage.chunk_count, "Saved field chunk count");
    counter(geometry.node_count, "Saved geometry node count");
    counter(geometry.cell_count, "Saved geometry cell count");
    counter(geometry.facet_count, "Saved geometry facet count");
    counter(geometry.active_node_count, "Saved geometry active-node count");
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }

  if (
    coverage.endian !== "little" ||
    (coverage.dtype !== "f32" && coverage.dtype !== "f64") ||
    componentCount !== BigInt(3) ||
    descriptor.quantity_id !== "m" ||
    descriptor.unit !== "1" ||
    totalElements === ZERO ||
    totalBytes === ZERO ||
    totalBytes > BigInt(SAVED_VIEWPORT_FIELD_MAX_BYTES) ||
    chunkCount === ZERO ||
    chunkCount > BigInt(SAVED_VIEWPORT_FIELD_MAX_CHUNKS) ||
    descriptor.function_space?.vector_dimension !== coverage.component_count
  ) {
    return unavailable(
      "Saved viewport currently accepts only a real nodal m vector with unit 1.",
    );
  }

  const geometryNodeCount = counter(geometry.node_count, "Saved geometry node count");
  const geometryCellCount = counter(geometry.cell_count, "Saved geometry cell count");
  const geometryFacetCount = counter(geometry.facet_count, "Saved geometry facet count");
  if (
    totalElements !== geometryNodeCount ||
    BigInt(topology.nodeCount) !== geometryNodeCount ||
    BigInt(topology.cellCount ?? topology.elementCount) !== geometryCellCount ||
    BigInt(topology.facetCount ?? topology.boundaryFaceCount) !== geometryFacetCount ||
    topology.formatVersion !== 2 ||
    topology.positions.length !== topology.nodeCount * 3 ||
    support.nodeCount !== topology.nodeCount ||
    descriptor.layout_digest !== geometry.layout_digest ||
    descriptor.topology_id !== geometry.topology_fingerprint ||
    descriptor.active_support.support_fingerprint !== geometry.support_fingerprint
  ) {
    return unavailable("Saved geometry, support, topology and field identities differ.");
  }

  let activeNodeCount = 0;
  for (let node = 0; node < support.nodeCount; node += 1) {
    if (savedSupportNodeIsActive(support, node)) activeNodeCount += 1;
  }
  if (activeNodeCount === 0) {
    return unavailable("Saved active-node support contains no renderable canonical nodes.");
  }

  for (const position of topology.positions) {
    if (!Number.isFinite(position)) {
      return unavailable("Saved topology contains a nonfinite node coordinate.");
    }
  }

  let elementCount: number;
  let components: number;
  let bytes: number;
  try {
    elementCount = safeCount(totalElements, "Saved field element count");
    components = safeCount(componentCount, "Saved field component count");
    bytes = safeCount(totalBytes, "Saved field byte count");
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
  const scalarBytes = coverage.dtype === "f32" ? 4 : 8;
  if (BigInt(elementCount) * BigInt(components) * BigInt(scalarBytes) !== totalBytes) {
    return unavailable("Saved field byte count does not match its node layout.");
  }
  if (bytes > SAVED_VIEWPORT_FIELD_MAX_BYTES) {
    return unavailable("Saved field payload exceeds the 64 MiB viewport cap.");
  }

  const range: MaterializedDatasetSliceRange = {
    elementCount: coverage.total_elements,
    elementOffset: "0",
    maxResponseBytes: coverage.total_bytes,
  };
  try {
    materializedDatasetSliceByteLimit(range);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
  return { range, status: "ready", totalBytes: bytes };
}

function savedFieldViewportResourceKey(
  dataset: MaterializedDatasetResource,
  geometry: SavedFieldGeometryResource,
  range: MaterializedDatasetSliceRange,
): string {
  return [
    "saved-field-viewport",
    canonicalSavedGeometryJson({
      dataset: savedGeometryResourceKey(dataset),
      geometry: geometry.geometry_manifest.object_ref,
      layout: geometry.layout_digest,
      support: geometry.support_fingerprint,
      topology: geometry.topology_fingerprint,
      range,
    }),
  ].join(":");
}

function decodeSavedFieldValues(
  decoded: DecodedMaterializedDatasetSlice,
  dataset: MaterializedDatasetResource,
  geometry: SavedFieldGeometryResource,
  range: MaterializedDatasetSliceRange,
): SavedFieldViewportValues {
  const coverage = dataset.field.coverage;
  const expectedCount =
    safeCount(counter(range.elementCount, "Saved field element count"), "Saved field element count") *
    safeCount(counter(coverage.component_count, "Saved field component count"), "Saved field component count");
  if (
    decoded.metadata.slice.element_offset !== range.elementOffset ||
    decoded.metadata.slice.element_count !== range.elementCount ||
    decoded.metadata.slice.total_elements !== coverage.total_elements ||
    decoded.metadata.slice.component_count !== coverage.component_count ||
    decoded.metadata.slice.precision !== coverage.dtype ||
    decoded.values.length !== expectedCount ||
    (coverage.dtype === "f32" && !(decoded.values instanceof Float32Array)) ||
    (coverage.dtype === "f64" && !(decoded.values instanceof Float64Array))
  ) {
    throw new Error("Saved field slice does not match the admitted node layout.");
  }
  for (const value of decoded.values) {
    if (!Number.isFinite(value)) throw new Error("Saved field slice contains a nonfinite value.");
  }
  return {
    componentCount: safeCount(counter(coverage.component_count, "Saved field component count"), "Saved field component count"),
    dtype: coverage.dtype,
    geometryObjectRef: geometry.geometry_manifest.object_ref,
    layoutDigest: geometry.layout_digest,
    nodeCount: safeCount(counter(coverage.total_elements, "Saved field element count"), "Saved field element count"),
    quantityId: dataset.field.descriptor.quantity_id,
    representationEvidence: "not_verified",
    savedScopeKey: savedFieldViewportResourceKey(dataset, geometry, range),
    supportFingerprint: geometry.support_fingerprint,
    topologyFingerprint: geometry.topology_fingerprint,
    unit: dataset.field.descriptor.unit,
    values: decoded.values,
  };
}

export function useSavedFieldViewportResources(
  dataset: MaterializedDatasetResource | null,
  enabled = true,
): SavedFieldViewportResources {
  const { api } = useKernel();
  const datasetEnabled = enabled && dataset !== null;
  const geometryLoad = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!dataset) throw new Error("Pinned materialized dataset is required.");
      return api.persistence.projects.savedFieldGeometry(dataset, { signal });
    },
    [api, dataset],
  );
  const geometry = useResource<SavedFieldGeometryResource>({
    abortStaleInflight: true,
    enabled: datasetEnabled,
    load: geometryLoad,
    retryPolicy: null,
    resourceKey: dataset ? savedGeometryResourceKey(dataset) : "saved-field-geometry:idle",
    resolveRevision: (data) => data.geometry_manifest.object_ref,
  });

  const topologyLoad = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!dataset || !geometry.data) throw new Error("Pinned field geometry is required.");
      return api.persistence.projects.savedFieldTopology(dataset, geometry.data, { signal });
    },
    [api, dataset, geometry.data],
  );
  const topology = useResource<DecodedTopology | null>({
    abortStaleInflight: true,
    enabled: datasetEnabled && geometry.data !== null,
    load: topologyLoad,
    retryPolicy: null,
    resourceKey: dataset && geometry.data
      ? savedGeometryBinaryResourceKey(dataset, geometry.data, "topology")
      : "saved-field-topology:idle",
    resolveRevision: (data) => data ? geometry.data?.topology_binary_sha256 ?? null : null,
  });

  const supportLoad = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      if (!dataset || !geometry.data) throw new Error("Pinned field geometry is required.");
      return api.persistence.projects.savedFieldSupport(dataset, geometry.data, { signal });
    },
    [api, dataset, geometry.data],
  );
  const support = useResource<DecodedSavedSupport | null>({
    abortStaleInflight: true,
    enabled: datasetEnabled && geometry.data !== null,
    load: supportLoad,
    retryPolicy: null,
    resourceKey: dataset && geometry.data
      ? savedGeometryBinaryResourceKey(dataset, geometry.data, "support")
      : "saved-field-support:idle",
    resolveRevision: (data) => data ? geometry.data?.support_binary_sha256 ?? null : null,
  });

  const eligibility = useMemo(
    () => resolveSavedFieldViewportEligibility(
      dataset,
      geometry.data,
      topology.data,
      support.data,
    ),
    [dataset, geometry.data, support.data, topology.data],
  );
  const fieldLoad = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      if (!dataset || !geometry.data || eligibility.status !== "ready") {
        throw new Error("Saved field viewport admission is not ready.");
      }
      const decoded = await api.persistence.projects.materializedDatasetSlice(
        dataset,
        eligibility.range,
        { signal },
      );
      return decodeSavedFieldValues(decoded, dataset, geometry.data, eligibility.range);
    },
    [api, dataset, eligibility, geometry.data],
  );
  const field = useResource<SavedFieldViewportValues | null>({
    abortStaleInflight: true,
    enabled: datasetEnabled && eligibility.status === "ready",
    load: fieldLoad,
    retryPolicy: null,
    resourceKey: dataset && geometry.data && eligibility.status === "ready"
      ? savedFieldViewportResourceKey(dataset, geometry.data, eligibility.range)
      : "saved-field-viewport:idle",
    resolveRevision: (data) => data ? `${data.geometryObjectRef}:${data.layoutDigest}:${data.topologyFingerprint}` : null,
  });

  return { eligibility, field, geometry, support, topology };
}
