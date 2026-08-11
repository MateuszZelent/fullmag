import { describe, expect, it } from "vitest";

import {
  explorerNodePresentationState,
  legacyStatusFacets,
} from "./explorerNodeState";

describe("explorer node state facets", () => {
  it("preserves transport, execution, and semantic availability independently", () => {
    expect(
      explorerNodePresentationState({
        availability: "partial",
        executionState: "running",
        resourceState: "stale",
      }),
    ).toEqual({
      label: "Running · stale data · partial",
      status: "running",
      tone: "active",
    });
  });

  it("gives failure precedence over running execution", () => {
    expect(
      explorerNodePresentationState({
        availability: "available",
        executionState: "running",
        resourceState: "error",
      }),
    ).toEqual({ label: "Resource error · running", status: "failed", tone: "failed" });
  });

  it("keeps unsupported distinct from unavailable", () => {
    expect(
      explorerNodePresentationState({
        availability: "unsupported",
        executionState: "not_started",
        resourceState: "ready",
      }),
    ).toEqual({ label: "Unsupported", status: "unsupported", tone: "failed" });

    expect(
      explorerNodePresentationState({
        availability: "unavailable",
        executionState: "not_started",
        resourceState: "ready",
      }),
    ).toEqual({ label: "Unavailable", status: "unavailable", tone: "muted" });
  });

  it("maps legacy statuses without erasing their meaning", () => {
    expect(legacyStatusFacets("mesh-building")).toEqual({
      availability: "partial",
      executionState: "running",
      resourceState: "loading",
    });
    expect(legacyStatusFacets("stale")).toEqual({
      availability: "available",
      executionState: "not_started",
      resourceState: "stale",
    });
    expect(legacyStatusFacets("unsupported")).toEqual({
      availability: "unsupported",
      executionState: "not_started",
      resourceState: "ready",
    });
  });
});
