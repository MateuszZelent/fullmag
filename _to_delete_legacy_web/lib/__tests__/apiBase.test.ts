import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveApiBase } from "../apiBase";

describe("resolveApiBase", () => {
  const originalRuntimeHttpBase = process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE;
  const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

  afterEach(() => {
    if (originalRuntimeHttpBase === undefined) {
      delete process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE;
    } else {
      process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE = originalRuntimeHttpBase;
    }
    if (originalApiUrl === undefined) {
      delete process.env.NEXT_PUBLIC_API_URL;
    } else {
      process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
    }
    vi.unstubAllGlobals();
  });

  it("prefers SSR env configuration when window is unavailable", () => {
    process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE = "https://api.fullmag.test///";
    expect(resolveApiBase()).toBe("https://api.fullmag.test");
  });

  it("prefers runtime browser config over location origin", () => {
    delete process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE;
    delete process.env.NEXT_PUBLIC_API_URL;
    vi.stubGlobal("window", {
      __FULLMAG_CONFIG__: {
        runtimeHttpBase: "https://runtime.fullmag.test///",
      },
      location: { origin: "https://workspace.fullmag.test" },
    });

    expect(resolveApiBase()).toBe("https://runtime.fullmag.test");
  });

  it("falls back to window.location.origin when runtime config is absent", () => {
    delete process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE;
    delete process.env.NEXT_PUBLIC_API_URL;
    vi.stubGlobal("window", {
      location: { origin: "https://workspace.fullmag.test" },
    });

    expect(resolveApiBase()).toBe("https://workspace.fullmag.test");
  });
});
