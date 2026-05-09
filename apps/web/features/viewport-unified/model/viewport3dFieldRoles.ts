import type { QuantityDescriptor } from "@/lib/session/types";

const AIRBOX_VECTOR_QUANTITY_PRIORITY = ["H_eff", "H_ext", "H_demag"];

export interface Viewport3DFieldRolesInput {
  selectedQuantity: string | null;
  quantities: readonly QuantityDescriptor[];
  showQuantity: boolean;
  showMagneticTexture: boolean;
  vectorDomainFilter: "auto" | "magnetic_only" | "full_domain" | "airbox_only";
}

export interface Viewport3DFieldRoles {
  glyphQuantityId: string | null;
  shaderQuantityId: string | null;
}

function isVectorField(quantity: QuantityDescriptor | undefined): quantity is QuantityDescriptor {
  return Boolean(quantity && quantity.n_comp >= 3 && (quantity.data_available || quantity.available));
}

function findQuantity(
  quantities: readonly QuantityDescriptor[],
  id: string | null,
): QuantityDescriptor | undefined {
  return id ? quantities.find((quantity) => quantity.id === id) : undefined;
}

function resolveAirboxVectorQuantity(
  selectedQuantity: string | null,
  quantities: readonly QuantityDescriptor[],
): string | null {
  const selected = findQuantity(quantities, selectedQuantity);
  if (isVectorField(selected) && selected.domain === "full_domain") {
    return selected.id;
  }
  for (const id of AIRBOX_VECTOR_QUANTITY_PRIORITY) {
    const candidate = findQuantity(quantities, id);
    if (isVectorField(candidate) && candidate.domain === "full_domain") {
      return candidate.id;
    }
  }
  const fallback = quantities.find(
    (quantity) => isVectorField(quantity) && quantity.domain === "full_domain",
  );
  return fallback?.id ?? null;
}

export function resolveViewport3DFieldRoles({
  selectedQuantity,
  quantities,
  showQuantity,
  showMagneticTexture,
  vectorDomainFilter,
}: Viewport3DFieldRolesInput): Viewport3DFieldRoles {
  return {
    glyphQuantityId:
      vectorDomainFilter === "airbox_only"
        ? resolveAirboxVectorQuantity(selectedQuantity, quantities)
        : selectedQuantity,
    shaderQuantityId:
      showMagneticTexture && !showQuantity
        ? "m"
        : selectedQuantity,
  };
}
