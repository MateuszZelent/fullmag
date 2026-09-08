import { readFileSync } from "node:fs";

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

  // parseFiniteDraftNumber / cameraPatchFromDraft / orientationDirtyRef are
  // module-private (this file's only export is the component), and the rest
  // of this test file renders with react-dom/server (no interactivity, no
  // @testing-library/react anywhere in this module) — so C-17 is covered the
  // same way the sibling CameraControls.test.ts covers non-exported logic:
  // structural assertions against the source.
  describe("C-17 · empty numeric fields must not silently apply zero", () => {
    const readSource = () =>
      readFileSync(new URL("./Viewport3DCameraDialog.tsx", import.meta.url), "utf8");

    it("rejects an emptied/whitespace field before it ever reaches Number()", () => {
      const source = readSource();
      const start = source.indexOf("function parseFiniteDraftNumber");
      const block = source.slice(start, source.indexOf("\n}", start));
      expect(block).toContain('value.trim() === ""');
      expect(block.indexOf('value.trim() === ""')).toBeLessThan(
        block.indexOf("Number(value)"),
      );
    });

    it("floors the orbit distance away from zero so the camera keeps a rotation frame", () => {
      const source = readSource();
      const start = source.indexOf("function cameraPatchFromDraft");
      const block = source.slice(start, source.indexOf("\n}", start));
      expect(block).toContain("Math.max(Math.abs(parsed.distance), 1e-12)");
    });

    it("clears a stale orientation edit whenever the external camera snapshot changes", () => {
      const source = readSource();
      expect(source).toContain("useEffect(() => {\n    orientationDirtyRef.current = false;\n  }, [snapshot]);");
    });

    it("still treats an emptied orthographic scale as 'auto', not an error", () => {
      const source = readSource();
      // parseCameraDraft's multi-line return-type annotation makes a
      // brace-balanced slice fragile here, so anchor directly on the
      // orthographicScale handling instead of bracketing the whole function.
      expect(source).toContain(
        'const orthographicScale =\n    draft.orthographicScale.trim() === ""\n      ? null\n      : parseFiniteDraftNumber(draft.orthographicScale);',
      );
    });
  });
});
