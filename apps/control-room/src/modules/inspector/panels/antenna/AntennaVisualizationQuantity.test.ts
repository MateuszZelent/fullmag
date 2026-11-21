import { describe, expect, it } from "vitest";

import type { AntennaInspectionDisplay } from "@/kernel/resources/antennaClosedLoopInspectionModel";
import type { AntennaFieldQuantity } from "@/kernel/visualization/antennaFieldIntent";
import { antennaInspectionHasCurrent, antennaVisualizationQuantity } from "./AntennaVisualizationQuantity";

function inspectionDisplay(schemaVersion: string, hasCurrent: boolean, current?: object | null) {
  // Only the discriminator and current fields are read by this selector.
  return {
    schema_version: schemaVersion,
    capabilities: { current_density: hasCurrent },
    device_current: current,
  } as unknown as AntennaInspectionDisplay;
}

describe("antennaInspectionHasCurrent", () => {
  it("requires both a current capability and a legacy current payload", () => {
    const schema = "antenna_inspection_display.v2";
    expect(antennaInspectionHasCurrent(inspectionDisplay(schema, true, {}))).toBe(true);
    expect(antennaInspectionHasCurrent(null)).toBe(false);
    expect(antennaInspectionHasCurrent(inspectionDisplay("antenna_inspection_display.v1", true, {}))).toBe(false);
    expect(antennaInspectionHasCurrent(inspectionDisplay(schema, false, {}))).toBe(false);
    expect(antennaInspectionHasCurrent(inspectionDisplay(schema, true, null))).toBe(false);
    expect(antennaInspectionHasCurrent(inspectionDisplay(schema, true))).toBe(false);
  });

  it("reads the current capability from the closed-loop display", () => {
    const schema = "antenna_inspection_display.closed_loop.v2";
    expect(antennaInspectionHasCurrent(inspectionDisplay(schema, true))).toBe(true);
    expect(antennaInspectionHasCurrent(inspectionDisplay(schema, false))).toBe(false);
  });
});

describe("antennaVisualizationQuantity", () => {
  const quantities = [
    ["device_potential", "electric_potential_per_ampere"],
    ["current_density", "current_density_per_ampere"],
    ["magnetic_field", "magnetic_field_per_ampere"],
  ] as const satisfies readonly [AntennaFieldQuantity, AntennaFieldQuantity][];

  it.each(quantities)("keeps %s and %s reversible across inspection and basis modes", (raw, basis) => {
    expect(antennaVisualizationQuantity(raw, true, true)).toBe(raw);
    expect(antennaVisualizationQuantity(basis, true, true)).toBe(raw);
    expect(antennaVisualizationQuantity(raw, false, true)).toBe(basis);
    expect(antennaVisualizationQuantity(basis, false, true)).toBe(basis);
    expect(antennaVisualizationQuantity(antennaVisualizationQuantity(basis, true, true), false, true)).toBe(basis);
    expect(antennaVisualizationQuantity(antennaVisualizationQuantity(raw, false, true), true, true)).toBe(raw);
    expect(antennaVisualizationQuantity(basis, true, true, true)).toBe(basis);
  });

  it("falls back to the magnetic field for unavailable legacy current", () => {
    expect(antennaVisualizationQuantity("current_density", true, false)).toBe("magnetic_field");
    expect(antennaVisualizationQuantity("current_density_per_ampere", true, false)).toBe("magnetic_field");
    expect(antennaVisualizationQuantity("current_density", false, false)).toBe("current_density_per_ampere");
    expect(antennaVisualizationQuantity("device_potential", true, false)).toBe("device_potential");
    expect(antennaVisualizationQuantity("magnetic_field_per_ampere", true, false)).toBe("magnetic_field");
  });
});
