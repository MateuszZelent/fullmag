import { beforeEach, describe, expect, it, vi } from "vitest";

const redirectMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

describe("HomePage route", () => {
  beforeEach(() => {
    redirectMock.mockClear();
  });

  it("redirects the root route to the canonical workspace", async () => {
    const { default: HomePage } = await import("./page");

    HomePage();

    expect(redirectMock).toHaveBeenCalledWith("/workspace");
  });
});
