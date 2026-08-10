import { afterEach, describe, expect, it, vi } from "vitest";

import { copyTextToClipboard } from "./copyTextToClipboard";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyTextToClipboard", () => {
  it("uses the Clipboard API when it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await copyTextToClipboard("runtime log");

    expect(writeText).toHaveBeenCalledWith("runtime log");
  });

  it("falls back to a temporary textarea when Clipboard API is unavailable", async () => {
    const textarea = {
      remove: vi.fn(),
      select: vi.fn(),
      setAttribute: vi.fn(),
      style: {},
      value: "",
    };
    const appendChild = vi.fn();
    const execCommand = vi.fn(() => true);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", {
      body: { appendChild },
      createElement: vi.fn(() => textarea),
      execCommand,
    });

    await copyTextToClipboard("runtime log");

    expect(textarea.value).toBe("runtime log");
    expect(appendChild).toHaveBeenCalledWith(textarea);
    expect(textarea.select).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(textarea.remove).toHaveBeenCalledOnce();
  });
});
