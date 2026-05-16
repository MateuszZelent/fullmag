import { describe, expect, it } from "vitest";

import { cn } from "./className";

describe("cn", () => {
  it("merges conditional classes and resolves Tailwind conflicts", () => {
    expect(cn("fm-button", false && "fm-hidden", "px-2", "px-4")).toBe(
      "fm-button px-4",
    );
  });
});
