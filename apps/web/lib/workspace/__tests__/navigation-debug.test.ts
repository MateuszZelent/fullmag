import { beforeEach, describe, expect, it, vi } from "vitest";

import { recordFrontendDebugEvent } from "../navigation-debug";

describe("navigation debug events", () => {
  beforeEach(() => {
    (globalThis as {
      window?: {
        location: { href: string };
        __FULLMAG_DEBUG_EVENTS__?: unknown[];
      };
      performance?: {
        mark: ReturnType<typeof vi.fn>;
        clearMarks: ReturnType<typeof vi.fn>;
      };
    }).window = {
      location: { href: "http://localhost/workspace" },
    };
    (globalThis as {
      performance?: {
        mark: ReturnType<typeof vi.fn>;
        clearMarks: ReturnType<typeof vi.fn>;
      };
    }).performance = {
      mark: vi.fn(),
      clearMarks: vi.fn(),
    };
  });

  it("summarizes heavy detail values and clears its performance mark", () => {
    recordFrontendDebugEvent("workspace", "sample", {
      payload: new Float32Array(1024),
      rows: Array.from({ length: 100 }, (_, index) => index),
      text: "x".repeat(300),
    });

    const event = window.__FULLMAG_DEBUG_EVENTS__?.[0];

    expect(event?.detail).toMatchObject({
      payload: {
        type: "Float32Array",
        length: 1024,
        byteLength: 4096,
      },
      rows: {
        type: "Array",
        length: 100,
      },
    });
    expect(String(event?.detail?.text)).toHaveLength(240);
    expect(performance.mark).toHaveBeenCalledTimes(1);
    expect(performance.clearMarks).toHaveBeenCalledTimes(1);
  });
});
