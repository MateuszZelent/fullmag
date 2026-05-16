import { describe, expect, it } from "vitest";

import { detectRuntimeTarget } from "./runtimeTarget";

describe("detectRuntimeTarget", () => {
  it("detects Tauri before generic web", () => {
    expect(detectRuntimeTarget({ __TAURI_INTERNALS__: {} })).toBe("tauri");
  });

  it("detects Electron without using unguarded process access", () => {
    expect(
      detectRuntimeTarget({
        process: { versions: { electron: "35.0.0" } },
      }),
    ).toBe("electron");
  });

  it("defaults to web for plain browser globals", () => {
    expect(detectRuntimeTarget({})).toBe("web");
  });
});
