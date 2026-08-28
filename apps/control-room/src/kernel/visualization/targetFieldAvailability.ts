import type {
  FieldAvailabilityResource,
  FieldCatalogResource,
} from "@/kernel/api/apiTypes";
import {
  resolveCanonicalQuantityId,
} from "@/kernel/api/quantityIds";
import type { VisualizationTargetRef } from "./ObjectVisualizationController";
import {
  canonicalVisualizationTargetId,
  isAirboxVisualizationTargetId,
} from "./visualizationTargetIdentity";

/**
 * Availability of a field for one concrete visualization target.
 *
 * A field catalog proves only backend capability and global materialization.
 * `ready` and `adopted` additionally require a target-scoped carrier supplied
 * by the viewport adapter. Keeping this distinction here prevents a global
 * catalog entry from being presented as a live target payload.
 */
export type TargetFieldAvailabilityState =
  | "supported"
  | "materializing"
  | "ready"
  | "stale"
  | "adopted"
  | "unavailable";

export type TargetFieldCarrierPayloadState = "missing" | "pending" | "ready";

/**
 * Renderer-neutral carrier proof. The viewport owns construction of this
 * descriptor from its field buffer and adoption registry; the Inspector only
 * consumes the identity and does not scan field values.
 */
export interface TargetFieldCarrierDescriptor {
  adopted: boolean;
  carrierId: string | null;
  fieldRevision: string | number | null;
  generationId: string | null;
  payloadPointCount?: number | null;
  payloadState: TargetFieldCarrierPayloadState;
  quantityId: string | null;
  scopeId: string | null;
  scopeKind: string | null;
  targetIds?: readonly string[];
}

export interface TargetFieldAvailability {
  adopted: boolean;
  carrierId: string | null;
  generationId: string | null;
  materialized: boolean;
  quantityId: string;
  reasonCode: string | null;
  revision: string | number | null;
  scopeId: string | null;
  scopeKind: string | null;
  state: TargetFieldAvailabilityState;
  supported: boolean;
  targetId: string;
}

export interface ResolveTargetFieldAvailabilityOptions {
  carrier?: TargetFieldCarrierDescriptor | null;
  expectedGenerationId?: string | null;
  expectedRevision?: string | number | null;
  expectedScopeId?: string | null;
  expectedScopeKind?: string | null;
  fieldCatalog: FieldCatalogResource | null | undefined;
  target: VisualizationTargetRef;
}

export interface ResolveTargetFieldAvailabilityMapOptions
  extends Omit<ResolveTargetFieldAvailabilityOptions, "expectedRevision"> {
  quantityIds?: readonly string[];
}

/**
 * Resolve the target-aware state for one quantity.
 *
 * `supported` is intentionally weaker than `ready`: it means the canonical
 * catalog accepts the quantity for the target domain, while no matching
 * target payload has been proven yet. A stale or mismatched carrier can never
 * make the result live.
 */
export function resolveTargetFieldAvailability(
  quantityId: string,
  {
    carrier = null,
    expectedGenerationId,
    expectedRevision,
    expectedScopeId,
    expectedScopeKind,
    fieldCatalog,
    target,
  }: ResolveTargetFieldAvailabilityOptions,
): TargetFieldAvailability {
  const canonicalQuantityId = resolveCanonicalQuantityId(quantityId);
  const scopeKind = expectedScopeKind ?? targetScopeKind(target);
  const scopeId = expectedScopeId ?? targetScopeId(target);
  const catalogGeneration = fieldCatalog?.domain_generation_id ?? null;
  const generationId = expectedGenerationId ?? catalogGeneration;
  const unavailable = (
    reasonCode: string,
    overrides: Partial<TargetFieldAvailability> = {},
  ): TargetFieldAvailability => ({
    adopted: false,
    carrierId: null,
    generationId,
    materialized: false,
    quantityId: canonicalQuantityId,
    reasonCode,
    revision: null,
    scopeId,
    scopeKind,
    state: "unavailable",
    supported: false,
    targetId: target.id,
    ...overrides,
  });

  if (!fieldCatalog) {
    return unavailable("field_catalog_not_ready");
  }

  const descriptor = fieldCatalog.quantities.find(
    (entry) =>
      resolveCanonicalQuantityId(entry.quantity_id) === canonicalQuantityId,
  );
  if (!descriptor) {
    return unavailable("quantity_not_advertised");
  }
  if (!descriptor.ui_exposed || !descriptor.spatial) {
    return unavailable("quantity_not_spatial");
  }
  if (isAirboxTarget(target) && descriptor.domain !== "full_domain") {
    return unavailable("quantity_domain_mismatch");
  }
  if (!isAirboxTarget(target) && descriptor.location === "airbox_only") {
    return unavailable("quantity_domain_mismatch");
  }
  if (descriptor.state === "unsupported") {
    return unavailable(
      descriptor.materialization_reason_code ?? "quantity_unsupported",
    );
  }

  const catalogRevision = descriptor.field_revision;
  const targetCarrier = carrierForTarget(carrier, target);
  const carrierMatches = targetCarrier
    ? targetCarrierIdentityMatches({
        carrier: targetCarrier,
        expectedGenerationId: generationId,
        expectedQuantityId: canonicalQuantityId,
        expectedRevision: expectedRevision ?? catalogRevision,
        expectedScopeId: scopeId,
        expectedScopeKind: scopeKind,
      })
    : false;
  const hasPayload = targetCarrier?.payloadState === "ready";
  const payloadHasPoints =
    targetCarrier?.payloadPointCount === undefined ||
    targetCarrier.payloadPointCount === null ||
    targetCarrier.payloadPointCount > 0;

  if (descriptor.state === "pending" || descriptor.state === "unmaterialized") {
    const hasMatchingLastGoodPayload = Boolean(
      targetCarrier && hasPayload && payloadHasPoints && carrierMatches,
    );
    return {
      adopted: false,
      carrierId: targetCarrier?.carrierId ?? null,
      generationId,
      materialized: hasMatchingLastGoodPayload,
      quantityId: canonicalQuantityId,
      reasonCode:
        descriptor.materialization_reason_code ??
        (descriptor.state === "pending"
          ? "field_materialization_pending"
          : "field_unmaterialized"),
      revision: targetCarrier?.fieldRevision ?? null,
      scopeId,
      scopeKind,
      state: hasMatchingLastGoodPayload ? "stale" : "materializing",
      supported: true,
      targetId: target.id,
    };
  }

  if (!descriptor.available) {
    return unavailable(
      descriptor.materialization_reason_code ?? "quantity_unavailable",
    );
  }

  if (descriptor.state === "error") {
    return targetCarrier && hasPayload && carrierMatches && payloadHasPoints
      ? {
          adopted: false,
          carrierId: targetCarrier.carrierId,
          generationId,
          materialized: true,
          quantityId: canonicalQuantityId,
          reasonCode:
            descriptor.materialization_reason_code ??
            "field_materialization_error",
          revision: targetCarrier.fieldRevision,
          scopeId,
          scopeKind,
          state: "stale",
          supported: true,
          targetId: target.id,
        }
      : unavailable(
          descriptor.materialization_reason_code ??
            descriptor.materialization_error ??
            "field_materialization_error",
        );
  }

  if (descriptor.state === "stale_complete" || descriptor.stale_by_steps > 0) {
    return {
      adopted: false,
      carrierId: targetCarrier?.carrierId ?? null,
      generationId,
      materialized: Boolean(targetCarrier && hasPayload && payloadHasPoints),
      quantityId: canonicalQuantityId,
      reasonCode:
        descriptor.materialization_reason_code ?? "field_stale_complete",
      revision: targetCarrier?.fieldRevision ?? null,
      scopeId,
      scopeKind,
      state: "stale",
      supported: true,
      targetId: target.id,
    };
  }

  if (!targetCarrier || !hasPayload || !payloadHasPoints) {
    return {
      adopted: false,
      carrierId: targetCarrier?.carrierId ?? null,
      generationId,
      materialized: false,
      quantityId: canonicalQuantityId,
      reasonCode: targetCarrier?.payloadState === "pending"
        ? "target_field_materialization_pending"
        : "target_carrier_missing",
      revision: targetCarrier?.fieldRevision ?? null,
      scopeId,
      scopeKind,
      state: targetCarrier?.payloadState === "pending"
        ? "materializing"
        : "supported",
      supported: true,
      targetId: target.id,
    };
  }

  if (!carrierMatches) {
    return {
      adopted: false,
      carrierId: targetCarrier.carrierId,
      generationId,
      materialized: true,
      quantityId: canonicalQuantityId,
      reasonCode: "target_carrier_identity_mismatch",
      revision: targetCarrier.fieldRevision,
      scopeId,
      scopeKind,
      state: "stale",
      supported: true,
      targetId: target.id,
    };
  }

  return {
    adopted: targetCarrier.adopted,
    carrierId: targetCarrier.carrierId,
    generationId,
    materialized: true,
    quantityId: canonicalQuantityId,
    reasonCode: null,
    revision: targetCarrier.fieldRevision,
    scopeId,
    scopeKind,
    state: targetCarrier.adopted ? "adopted" : "ready",
    supported: true,
    targetId: target.id,
  };
}

/**
 * Convert target-scoped backend availability into the renderer-neutral proof
 * consumed by Inspector quantity controls. The backend cannot prove renderer
 * adoption, so this always starts at a non-adopted state.
 */
export function resolveTargetFieldAvailabilityFromBackend(
  resource: FieldAvailabilityResource,
  target: VisualizationTargetRef,
): TargetFieldAvailability {
  return {
    adopted: false,
    carrierId: resource.carrier_id ?? null,
    generationId: resource.generation,
    materialized: resource.materialized,
    quantityId: resolveCanonicalQuantityId(resource.quantity_id),
    reasonCode: resource.reason_code ?? null,
    revision: resource.revision ?? null,
    scopeId: resource.scope_id ?? null,
    scopeKind: resource.scope_kind,
    state: resource.state,
    supported: resource.supported,
    targetId: target.id,
  };
}

/** Resolve a stable map without triggering any payload/value reads. */
export function resolveTargetFieldAvailabilityMap({
  quantityIds,
  ...options
}: ResolveTargetFieldAvailabilityMapOptions): ReadonlyMap<
  string,
  TargetFieldAvailability
> {
  const ids = quantityIds ?? options.fieldCatalog?.quantities.map(
    (entry) => entry.quantity_id,
  ) ?? [];
  return new Map(
    ids.map((quantityId) => [
      resolveCanonicalQuantityId(quantityId),
      resolveTargetFieldAvailability(quantityId, options),
    ]),
  );
}

export function targetFieldAvailabilityIsSelectable(
  availability: TargetFieldAvailability,
): boolean {
  return (
    availability.supported &&
    (availability.state !== "unavailable" ||
      availability.reasonCode === "field_materialization_error")
  );
}

export function targetFieldAvailabilityIsLive(
  availability: TargetFieldAvailability,
): boolean {
  return availability.state === "adopted";
}

function carrierForTarget(
  carrier: TargetFieldCarrierDescriptor | null,
  target: VisualizationTargetRef,
): TargetFieldCarrierDescriptor | null {
  if (!carrier) return null;
  if (
    carrier.targetIds &&
    !carrier.targetIds.some(
      (targetId) =>
        canonicalVisualizationTargetId(targetId) ===
        canonicalVisualizationTargetId(target.id),
    )
  ) return null;
  return carrier;
}

function targetFieldIdentityToken(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.replace(/^sha256:/i, "").toLowerCase();
}

function targetFieldIdentityMatches(
  expected: string | number | null | undefined,
  actual: string | number | null | undefined,
): boolean {
  const expectedToken = targetFieldIdentityToken(expected);
  return expectedToken === null || expectedToken === targetFieldIdentityToken(actual);
}

function targetCarrierIdentityMatches({
  carrier,
  expectedGenerationId,
  expectedQuantityId,
  expectedRevision,
  expectedScopeId,
  expectedScopeKind,
}: {
  carrier: TargetFieldCarrierDescriptor;
  expectedGenerationId: string | null;
  expectedQuantityId: string;
  expectedRevision: string | number | null;
  expectedScopeId: string | null;
  expectedScopeKind: string | null;
}): boolean {
  return Boolean(
    carrier.carrierId &&
      carrier.quantityId &&
      resolveCanonicalQuantityId(carrier.quantityId) === expectedQuantityId &&
      (expectedScopeKind === null || carrier.scopeKind === expectedScopeKind) &&
      (expectedScopeId === null ||
        targetFieldScopeIdentityMatches(expectedScopeId, carrier.scopeId)) &&
      targetFieldIdentityMatches(expectedGenerationId, carrier.generationId) &&
      targetFieldIdentityMatches(expectedRevision, carrier.fieldRevision),
  );
}

function targetScopeKind(target: VisualizationTargetRef): string | null {
  if (target.kind === "airbox") return "airbox";
  if (
    target.kind === "fdm-domain" &&
    target.id === "fdm-universe-outside-support"
  ) {
    // Single-grid FDM uses the full regular-grid carrier for the logical
    // outside-support target; its semantic target id is not a data-plane
    // scope id.
    return "full";
  }
  switch (target.kind) {
    case "object":
      return "object";
    case "region":
      return "region";
    case "part":
      return "part";
    case "fdm-native-layer":
      return "layer";
    default:
      return null;
  }
}

function targetScopeId(target: VisualizationTargetRef): string | null {
  if (
    target.kind === "airbox" ||
    isAirboxVisualizationTargetId(target.id) ||
    (target.kind === "fdm-domain" &&
      target.id === "fdm-universe-outside-support")
  ) {
    return null;
  }
  if (target.kind === "fdm-domain") return null;
  if (target.kind === "object" && target.id.startsWith("object:")) {
    return target.id.slice("object:".length);
  }
  if (target.kind === "part" && target.id.startsWith("part:")) {
    return target.id.slice("part:".length);
  }
  if (target.kind === "fdm-native-layer") {
    const encodedLayerId = target.id.startsWith("fdm-native-layer:")
      ? target.id.slice("fdm-native-layer:".length)
      : "";
    return encodedLayerId ? decodeSafe(encodedLayerId) : null;
  }
  if (target.kind === "region") {
    const match = /^region:([^:]+):(.+)$/.exec(target.id);
    return match ? decodeSafe(match[2] ?? "") : target.id;
  }
  return target.id;
}

function targetFieldScopeIdentityMatches(
  expected: string | null,
  actual: string | null | undefined,
): boolean {
  if (expected === null) return true;
  if (actual === null || actual === undefined) return false;
  return canonicalScopeIdentity(expected) === canonicalScopeIdentity(actual);
}

function canonicalScopeIdentity(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("object:")) return trimmed.slice("object:".length);
  if (trimmed.startsWith("part:")) return trimmed.slice("part:".length);
  return trimmed;
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isAirboxTarget(target: VisualizationTargetRef): boolean {
  return (
    target.kind === "airbox" ||
    (target.kind === "fdm-domain" &&
      target.id === "fdm-universe-outside-support")
  );
}
