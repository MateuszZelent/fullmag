import { describe, expect, it } from "vitest";

import {
  formatFrequencyHz,
  formatFrequencyRangeBoundsHz,
} from "./frequencyUnits";

describe("frequencyUnits", () => {
  it("formats frequencies with automatic Hz, MHz, and GHz units", () => {
    expect(formatFrequencyHz(500)).toBe("500 Hz");
    expect(formatFrequencyHz(750e6)).toBe("750 MHz");
    expect(formatFrequencyHz(12.5e9)).toBe("12.5 GHz");
    expect(formatFrequencyHz(null)).toBe("not available");
  });

  it("formats frequency ranges using the same automatic unit policy", () => {
    expect(formatFrequencyRangeBoundsHz(250e6, 950e6)).toBe(
      "250 MHz-950 MHz",
    );
    expect(formatFrequencyRangeBoundsHz(12.5e9, 13.1e9)).toBe(
      "12.5 GHz-13.1 GHz",
    );
  });
});
