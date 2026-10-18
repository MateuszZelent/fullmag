import type { ArtifactFieldOverlayModel } from "./model/artifactFieldOverlayModel";

/** Historical inspection owns the field identity while its live layers are suppressed. */
export function Viewport3DFieldLabel({ quantityId, label, historical, model, error, liveDataAvailable }: {
  quantityId: string;
  label: string;
  historical: boolean;
  model: ArtifactFieldOverlayModel | null;
  error: string | null;
  liveDataAvailable?: boolean;
}) {
  const field = historical ? model : null;
  const state = historical ? field ? "ready" : error ? "unavailable" : "loading" : !quantityId ? "geometry" : liveDataAvailable === undefined ? undefined : liveDataAvailable ? "data-ready" : "no-data";
  return <span data-quantity-id={field?.quantityId ?? quantityId} data-field-state={state} title={historical && error ? error : undefined}>
    {field ? `${field.quantityId} [${field.unit}]` : historical ? `${label} · ${error ? "unavailable" : "loading"}` : !quantityId ? "Geometry" : liveDataAvailable === false ? `${label} · no field data` : label}
  </span>;
}
