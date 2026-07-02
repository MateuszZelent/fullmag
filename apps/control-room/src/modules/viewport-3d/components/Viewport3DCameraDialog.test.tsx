import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@radix-ui/react-dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@radix-ui/react-dialog")>();

  return {
    ...actual,
    Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

import { Viewport3DCameraDialog } from "./Viewport3DCameraDialog";

describe("Viewport3DCameraDialog", () => {
  it("renders live camera parameters and editable camera fields", () => {
    const html = renderToStaticMarkup(
      <Viewport3DCameraDialog
        cameraOrthographicScale={null}
        cameraProjection="perspective"
        cameraResource={{
          fov_degrees: 42,
          orthographic_scale: 2e-6,
          position: [1, 2, 3],
          projection: "perspective",
          target: [0, 0, 0],
          up: [0, 0, 1],
        }}
        cameraState={{
          position: [1, 2, 3],
          target: [0, 0, 0],
          up: [0, 0, 1],
        }}
        onCameraPatch={() => undefined}
        onOpenChange={() => undefined}
        open
      />,
    );

    expect(html).toContain("Camera Parameters");
    expect(html).toContain("Position");
    expect(html).toContain("Target");
    expect(html).toContain("Yaw");
    expect(html).toContain("Pitch");
    expect(html).toContain("Roll");
    expect(html).toContain("Close camera parameters");
    expect(html).toContain('aria-describedby="fm-viewport-camera-dialog-description"');
    expect(html).toContain("Inspect and edit the 3D viewport camera position");
  });
});
