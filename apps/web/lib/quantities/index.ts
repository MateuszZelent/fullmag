/**
 * @module lib/quantities
 *
 * Canonical frontend quantity system.
 *
 * Re-exports the full public API of the quantities module:
 *   - types    — TypeScript analogs of Rust `QuantityId`, `QuantityDescriptor`, etc.
 *   - catalog  — static quantity catalog mirroring the Rust `QUANTITY_SPECS` table
 *   - rendering — shape-driven renderer selection and color-scale mapping
 *   - compat   — legacy bridge helpers (transitional, to be removed)
 */

export type {
  QuantityId,
  QuantityShape,
  QuantityLocation,
  QuantityDomain,
  QuantityComponent,
  NormalizationHint,
  QuantityReduction,
  QuantityDescriptor,
  StepDiagnostics,
  LiveQuantityFrame,
  QuantitySink,
  QuantityRequest,
} from "./types";

export {
  quantityCatalog,
  quantityById,
  uiExposedQuantities,
  interactivePreviewQuantities,
  historyQuantities,
  quantitiesByShape,
  allQuantityIds,
  quantityColumnLabel,
} from "./catalog";

export type {
  RendererKind,
  ColorScaleKind,
  QuantityRenderMeta,
} from "./rendering";

export {
  rendererForShape,
  colorScaleForHint,
  renderMetaFor,
} from "./rendering";

export {
  metricKeyToQuantityId,
  buildLegacyColumnLabels,
  previewAliasToQuantityId,
} from "./compat";
