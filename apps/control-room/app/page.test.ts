import { describe, expect, it, vi } from "vitest";

vi.mock("./workspace/page", () => ({
  default: function WorkspacePage() {
    return null;
  },
}));

describe("HomePage route", () => {
  it("renders the workspace, which selects the tab from the address", async () => {
    const { default: HomePage } = await import("./page");
    const { default: WorkspacePage } = await import("./workspace/page");

    expect(HomePage().type).toBe(WorkspacePage);
  });
});
