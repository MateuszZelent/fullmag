const FIELD_FRAME_ID_CACHE = new WeakMap<object, number>();
let NEXT_FIELD_FRAME_ID = 1;

export function formatQuantityOptionLabel(quantity: {
  label: string;
  unit: string | null | undefined;
}): string {
  return quantity.unit && quantity.unit !== "dimensionless"
    ? `${quantity.label} (${quantity.unit})`
    : quantity.label;
}

export function isQuantitySelectable(quantity: {
  interactive_preview: boolean;
  supports_preview_2d: boolean;
  supports_preview_3d: boolean;
}): boolean {
  return Boolean(
    quantity.interactive_preview &&
      (quantity.supports_preview_2d || quantity.supports_preview_3d),
  );
}

export function fieldFrameIdentity(value: object | null | undefined): string {
  if (!value) {
    return "none";
  }
  let id = FIELD_FRAME_ID_CACHE.get(value);
  if (!id) {
    id = NEXT_FIELD_FRAME_ID++;
    FIELD_FRAME_ID_CACHE.set(value, id);
  }
  return String(id);
}

export function vectorHead(values: Float64Array | null | undefined): [number, number, number] | null {
  if (!values || values.length < 3) {
    return null;
  }
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
}
