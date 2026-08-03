import { describe, expect, it } from "vitest";

import { isLiveEnergyLoadEnabled } from "./useLiveEnergyData";

describe("useLiveEnergyData", () => {
  it("loads energy only for an active following Energy preset", () => {
    expect(isLiveEnergyLoadEnabled({ active: true, descriptorId: "energy", paused: false })).toBe(true);
    expect(isLiveEnergyLoadEnabled({ active: false, descriptorId: "energy", paused: false })).toBe(false);
    expect(isLiveEnergyLoadEnabled({ active: true, descriptorId: "energy", paused: true })).toBe(false);
  });
});
