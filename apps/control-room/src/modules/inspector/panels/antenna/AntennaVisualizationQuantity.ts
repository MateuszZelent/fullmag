import type { AntennaInspectionDisplayResource } from "@/kernel/api/apiTypes";
import type { AntennaFieldQuantity } from "@/kernel/visualization/antennaFieldIntent";

export const ANTENNA_RAW_QUANTITIES = {
  device_potential: { label: "Electric potential V", unit: "V", components: 1 },
  current_density: { label: "Current density J", unit: "A/m^2", components: 3 },
  magnetic_field: { label: "Inspection Oersted field H", unit: "A/m", components: 3 },
} as const;

export function antennaInspectionHasCurrent(display: AntennaInspectionDisplayResource | null): boolean {
  return display?.schema_version === "antenna_inspection_display.v2"
    && display.capabilities.current_density === true
    && display.device_current != null;
}

export function antennaVisualizationQuantity(quantity: AntennaFieldQuantity, inspection: boolean, currentAvailable: boolean): AntennaFieldQuantity {
  if (inspection) {
    switch (quantity) {
      case "electric_potential_per_ampere":
      case "device_potential": return "device_potential";
      case "current_density_per_ampere":
      case "current_density": return currentAvailable ? "current_density" : "magnetic_field";
      default: return "magnetic_field";
    }
  }
  switch (quantity) {
    case "device_potential": return "electric_potential_per_ampere";
    case "current_density": return "current_density_per_ampere";
    case "magnetic_field": return "magnetic_field_per_ampere";
    default: return quantity;
  }
}
