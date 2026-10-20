import { isClosedLoopDisplay, type AntennaInspectionDisplay } from "@/kernel/resources/antennaClosedLoopInspectionModel";
import type { AntennaFieldQuantity } from "@/kernel/visualization/antennaFieldIntent";

export const ANTENNA_RAW_QUANTITIES = {
  device_potential: { label: "Electric potential V", unit: "V", components: 1 },
  current_density: { label: "Current density J", unit: "A/m^2", components: 3 },
  magnetic_field: { label: "Inspection Oersted field H", unit: "A/m", components: 3 },
} as const;

export const ANTENNA_CLOSED_LOOP_QUANTITIES = {
  ...ANTENNA_RAW_QUANTITIES,
  electric_potential_per_ampere: { label: "Inspection potential V/Ic", unit: "V/A", components: 1 },
  current_density_per_ampere: { label: "Inspection current J/Ic", unit: "1/m^2", components: 3 },
  magnetic_field_per_ampere: { label: "Inspection Oersted field H/Ic", unit: "1/m", components: 3 },
} as const;

export function antennaInspectionHasCurrent(display: AntennaInspectionDisplay | null): boolean {
  if (display && isClosedLoopDisplay(display)) return display.capabilities.current_density === true;
  return display?.schema_version === "antenna_inspection_display.v2"
    && display.capabilities.current_density === true
    && display.device_current != null;
}

export function antennaVisualizationQuantity(quantity: AntennaFieldQuantity, inspection: boolean, currentAvailable: boolean, closedLoop = false): AntennaFieldQuantity {
  if (inspection && closedLoop) return quantity;
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
