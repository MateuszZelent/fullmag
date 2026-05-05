import { describe, expect, it } from "vitest";

import type { ViewportDocumentState } from "@/features/workspace-graph";

import { viewportDocumentShallowEqual } from "../useViewportGraphCameraBridge";

function viewportDocument(
  overrides: Partial<ViewportDocumentState> = {},
): ViewportDocumentState {
  return {
    id: "viewport:study:core:3d",
    workspaceMode: "study",
    tabId: "core:3d",
    viewMode: "3D",
    quantityId: "m",
    component: "3D",
    plane: null,
    sliceIndex: null,
    selectedDatasetId: "dataset:latest",
    selectedResultNodeId: "result:latest",
    renderMode: "surface",
    camera: {
      position: [1, 2, 3],
      target: [0, 0, 0],
      up: [0, 1, 0],
      projection: "perspective",
      navigation: "cad",
      lastFocusedObjectId: null,
    },
    overlayToggles: {
      telemetryHudVisible: false,
      previewNoticesVisible: true,
    },
    ...overrides,
  };
}

describe("viewportDocumentShallowEqual", () => {
  it("keeps equivalent viewport documents stable across tiny camera round-trip noise", () => {
    const current = viewportDocument();
    const next = viewportDocument({
      camera: {
        ...current.camera!,
        position: [1, 2, 3 + 1e-10],
      },
    });

    expect(viewportDocumentShallowEqual(current, next)).toBe(true);
  });

  it("detects semantic viewport document changes", () => {
    expect(
      viewportDocumentShallowEqual(
        viewportDocument(),
        viewportDocument({ selectedResultNodeId: "result:other" }),
      ),
    ).toBe(false);
  });
});
