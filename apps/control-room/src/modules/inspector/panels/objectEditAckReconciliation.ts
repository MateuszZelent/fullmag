import {
  canonicalDraftInSelectedUnits,
  getRawQuantityField,
  QUANTITY_DRAFT_FIELDS,
  setRawQuantityField,
} from "@/kernel/authoring/object-edit/quantityDraftFields";
import type { GeometryObjectDraft } from "@/kernel/authoring/object-edit/objectEditTypes";

import {
  geometryDraftGeometryEquals,
  geometryDraftTranslationEquals,
} from "./geometryObjectPanelModel";

const METADATA_FIELDS = ["name", "notes", "material", "region"] as const;

function normalizedReference(value: string): string | null {
  const trimmed = value.trim();
  return !trimmed || trimmed === "unassigned" ? null : trimmed;
}

export function objectEditMetadataEquals(left: GeometryObjectDraft, right: GeometryObjectDraft): boolean {
  return left.name === right.name && left.notes === right.notes &&
    normalizedReference(left.material) === normalizedReference(right.material) &&
    normalizedReference(left.region) === normalizedReference(right.region);
}

function rebaseGeometry(current: GeometryObjectDraft, baseline: GeometryObjectDraft, draft: GeometryObjectDraft): void {
  if (current.geometryKind !== baseline.geometryKind) draft.geometryKind = current.geometryKind;
  for (const field of QUANTITY_DRAFT_FIELDS) {
    const currentMetadata = current.quantityFields?.[field];
    if (
      getRawQuantityField(current, field) === getRawQuantityField(baseline, field) &&
      (currentMetadata?.unit ?? "m") === (baseline.quantityFields?.[field]?.unit ?? "m")
    ) continue;
    Object.assign(draft, setRawQuantityField(draft, field, getRawQuantityField(current, field)));
    const metadata = { ...draft.quantityFields };
    if (currentMetadata) metadata[field] = { ...currentMetadata };
    else delete metadata[field];
    if (Object.keys(metadata).length > 0) draft.quantityFields = metadata;
    else delete draft.quantityFields;
  }
}

function rebaseMetadata(current: GeometryObjectDraft, submitted: GeometryObjectDraft, draft: GeometryObjectDraft): void {
  for (const field of METADATA_FIELDS) {
    if (!Object.is(current[field], submitted[field])) Object.assign(draft, { [field]: current[field] });
  }
}

function reconciled(draft: GeometryObjectDraft, canonical: GeometryObjectDraft): { dirty: boolean; draft: GeometryObjectDraft } {
  return {
    dirty: !geometryDraftGeometryEquals(draft, canonical) ||
      !geometryDraftTranslationEquals(draft, canonical) || !objectEditMetadataEquals(draft, canonical),
    draft,
  };
}

/** Retain post-submit raw edits; immutable identity and revision always come from ACK. */
export function reconcileObjectEditAck(
  current: GeometryObjectDraft,
  submitted: GeometryObjectDraft,
  canonical: GeometryObjectDraft,
): { dirty: boolean; draft: GeometryObjectDraft } {
  const draft = canonicalDraftInSelectedUnits(canonical, current);
  rebaseGeometry(current, submitted, draft);
  rebaseMetadata(current, submitted, draft);
  // R1 exposes translation only; disabled rotation and scale remain canonical.
  return reconciled(draft, canonical);
}

const CANONICAL_SCALAR_FIELDS = [
  "archHeight", "geometryKind", "height", "length", "material", "mode", "name",
  "notes", "objectId", "radius", "region", "width", "z0",
] as const;
const CANONICAL_VECTOR_FIELDS = ["rotation", "scale", "size", "translation"] as const;

function sameCanonicalObject(left: GeometryObjectDraft, right: GeometryObjectDraft): boolean {
  return CANONICAL_SCALAR_FIELDS.every((field) => left[field] === right[field]) &&
    CANONICAL_VECTOR_FIELDS.every((field) =>
      left[field].every((value, index) => value === right[field][index]));
}

/**
 * Policy and other scene writes bump the scene revision without touching this
 * object. Moving a dirty draft onto the new revision then keeps its edits and
 * avoids a revision conflict that only Revert could clear. Any change to the
 * object itself leaves the draft on its old base, so the conflict stays visible.
 */
export function rebaseDirtyDraftOntoUnchangedObject(
  draft: GeometryObjectDraft,
  previousCanonical: GeometryObjectDraft,
  canonical: GeometryObjectDraft,
): GeometryObjectDraft | null {
  if (
    canonical.baseRevision === null ||
    draft.baseRevision !== previousCanonical.baseRevision ||
    draft.baseRevision === canonical.baseRevision ||
    !sameCanonicalObject(previousCanonical, canonical)
  ) {
    return null;
  }
  return { ...draft, baseRevision: canonical.baseRevision };
}

/** Identity writes leave all unsent geometry edits intact as well as newer metadata. */
export function reconcileObjectIdentityAck(
  current: GeometryObjectDraft,
  submitted: GeometryObjectDraft,
  baseline: GeometryObjectDraft,
  canonical: GeometryObjectDraft,
): { dirty: boolean; draft: GeometryObjectDraft } {
  const draft = canonicalDraftInSelectedUnits(canonical, current);
  rebaseGeometry(current, baseline, draft);
  rebaseMetadata(current, submitted, draft);
  return reconciled(draft, canonical);
}
