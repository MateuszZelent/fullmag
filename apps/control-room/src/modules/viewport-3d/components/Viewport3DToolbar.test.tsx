import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { resolveTargetBoundsMeters } from "@/shared/domain/magnetization-texture/boundsResolver";
import { createDefaultMagneticTextureDraft } from "@/shared/domain/magnetization-texture/presetDefaults";
import {
  getTextureDraftBridgeSnapshot,
  handleTextureGizmoShortcutKey,
  registerTextureInspectorBinding,
  resetTextureDraftBridgeForTests,
  toggleTextureGizmo,
  unregisterTextureInspectorBinding,
} from "@/shared/domain/magnetization-texture/textureDraftBridge";

vi.mock("@radix-ui/react-dropdown-menu", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Sub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SubTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Content: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div className={className} data-slot="mock-dropdown-menu-content">
      {children}
    </div>
  ),
  CheckboxItem: ({
    children,
    checked,
    onCheckedChange,
  }: {
    children?: ReactNode;
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <button
      aria-checked={checked}
      data-slot="button"
      role="menuitemcheckbox"
      type="button"
      onClick={() => onCheckedChange?.(!checked)}
    >
      {children}
    </button>
  ),
  RadioGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioItem: ({
    children,
    className,
    value,
    ...rest
  }: {
    children?: ReactNode;
    className?: string;
    value: string;
  }) => (
    <div
      aria-checked={false}
      className={className}
      data-value={value}
      role="menuitemradio"
      {...rest}
    >
      {children}
    </div>
  ),
  ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
  Item: ({
    children,
    onSelect,
    ...rest
  }: {
    children?: ReactNode;
    onSelect?: (event: Event) => void;
  }) => (
    <button
      data-slot="button"
      role="menuitem"
      type="button"
      onClick={() => onSelect?.(new TestEvent("select") as unknown as Event)}
      {...rest}
    >
      {children}
    </button>
  ),
}));

import { Viewport3DToolbar } from "./Viewport3DToolbar";

function createProps(onCommand: (id: string) => void) {
  return {
    inspectEnabled: false,
    layersContent: <div>Vector overlays</div>,
    onCommand,
    projection: "perspective" as const,
    qualityProfileId: "balanced" as const,
    settingsOpen: false,
  };
}

function click(element: ReturnType<typeof findElement>) {
  element.dispatchEvent(new TestEvent("click", { bubbles: true }));
}

describe("Viewport3DToolbar", () => {
  beforeEach(() => {
    resetTextureDraftBridgeForTests();
  });

  afterEach(() => {
    resetTextureDraftBridgeForTests();
  });

  it("renders named action groups and keeps explained fit unavailable but reachable", () => {
    const html = renderToStaticMarkup(
      <Viewport3DToolbar
        {...createProps(() => undefined)}
        fitDisabledReason="The current scene has no visible bounds."
        inspectEnabled
        settingsOpen
      />,
    );

    expect(html).toContain('aria-label="3D view tools"');
    expect(html).toMatch(/role="toolbar"/);
    for (const group of [
      "Navigation",
      "Interaction mode",
      "Inspection",
      "Appearance",
      "Output",
    ]) {
      expect(html).toContain(`aria-label="${group}"`);
    }
    for (const testId of [
      "viewport-mode-camera",
      "viewport-mode-translate",
      "viewport-mode-rotate",
      "viewport-mode-scale",
    ]) {
      expect(html).toContain(`data-testid="${testId}"`);
    }
    expect(html).toContain('aria-label="Appearance: Scientific, quality Detailed"');
    expect(html).toContain("Detailed");
    expect(html).toContain('aria-label="Fit view"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("The current scene has no visible bounds.");
    expect(html).toContain('aria-label="Projection"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label="Inspect values"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="View settings"');
    expect(html).not.toMatch(/<button[^>]*aria-label="Fit view"[^>]*disabled=/);
    expect(html).not.toContain("title=");
  });

  it("routes direct actions and does not run fit while it is aria-disabled", async () => {
    const onCommand = vi.fn<(id: string) => void>();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root: Root = createRoot(container as unknown as Element);

    try {
      await act(async () =>
        root.render(
          <Viewport3DToolbar
            {...createProps(onCommand)}
            fitDisabledReason="Wait for scene bounds."
          />,
        ),
      );

      const fit = findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Fit view",
        "fit view",
      );
      expect(fit.getAttribute("aria-disabled")).toBe("true");
      await act(async () => click(fit));

      await act(async () =>
        click(
          findElement(
            container,
            (element) =>
              element.tagName === "BUTTON" && element.getAttribute("aria-label") === "Projection",
            "projection",
          ),
        ),
      );
      await act(async () =>
        click(
          findElement(
            container,
            (element) => element.getAttribute("aria-label") === "Inspect values",
            "inspect values",
          ),
        ),
      );
      await act(async () =>
        click(
          findElements(
            container,
            (element) => element.getAttribute("data-command-id") === "viewport-3d.capture-frame",
          )[0]!,
        ),
      );
      await act(async () =>
        click(
          findElements(
            container,
            (element) => element.getAttribute("data-command-id") === "viewport-3d.export-model",
          )[0]!,
        ),
      );
      await act(async () =>
        click(
          findElement(
            container,
            (element) => element.getAttribute("aria-label") === "View settings",
            "view settings",
          ),
        ),
      );

      expect(onCommand.mock.calls).toEqual([
        ["view-projection"],
        ["viewport-3d.inspect-toggle"],
        ["viewport-3d.capture-frame"],
        ["viewport-3d.export-model"],
        ["viewport-3d.toggle-settings"],
      ]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("synchronizes Camera / Translate / Rotate / Scale mode buttons bidirectionally with textureDraftBridge", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root: Root = createRoot(container as unknown as Element);

    const getModeBtn = (testId: string) =>
      findElement(
        container,
        (element) => element.getAttribute("data-testid") === testId,
        testId,
      );

    try {
      await act(async () => root.render(<Viewport3DToolbar {...createProps(() => undefined)} />));

      // Zero bare HTML title attributes and all buttons use shared Button primitive
      expect(findElements(container, (el) => el.getAttribute("title") !== null)).toHaveLength(0);
      for (const btn of findElements(container, (el) => el.tagName === "BUTTON")) {
        expect(btn.getAttribute("data-slot")).toBe("button");
      }

      // Initially Camera mode is active
      expect(getModeBtn("viewport-mode-camera").getAttribute("aria-pressed")).toBe("true");
      expect(getModeBtn("viewport-mode-camera").getAttribute("data-active")).toBe("true");
      expect(getModeBtn("viewport-mode-translate").getAttribute("aria-pressed")).toBe("false");

      // Clicking Translate (W) works even before any texture target is selected
      await act(async () => click(getModeBtn("viewport-mode-translate")));
      expect(getTextureDraftBridgeSnapshot().gizmoEnabled).toBe(true);
      expect(getTextureDraftBridgeSnapshot().gizmoMode).toBe("translate");
      expect(getModeBtn("viewport-mode-translate").getAttribute("aria-pressed")).toBe("true");
      expect(getModeBtn("viewport-mode-translate").getAttribute("data-active")).toBe("true");
      expect(getModeBtn("viewport-mode-camera").getAttribute("aria-pressed")).toBe("false");

      // Clicking Rotate (E) and Scale (R)
      await act(async () => click(getModeBtn("viewport-mode-rotate")));
      expect(getTextureDraftBridgeSnapshot().gizmoMode).toBe("rotate");
      expect(getModeBtn("viewport-mode-rotate").getAttribute("data-active")).toBe("true");

      await act(async () => click(getModeBtn("viewport-mode-scale")));
      expect(getTextureDraftBridgeSnapshot().gizmoMode).toBe("scale");
      expect(getModeBtn("viewport-mode-scale").getAttribute("data-active")).toBe("true");

      // Pressing Q shortcut switches toolbar back to Camera
      await act(async () => {
        handleTextureGizmoShortcutKey("q");
      });
      expect(getModeBtn("viewport-mode-camera").getAttribute("data-active")).toBe("true");
      expect(getModeBtn("viewport-mode-scale").getAttribute("data-active")).toBe("false");

      // Toggling gizmo off/on from Inspector syncs with toolbar
      await act(async () => {
        toggleTextureGizmo(false);
        toggleTextureGizmo(true);
      });
      expect(getModeBtn("viewport-mode-translate").getAttribute("data-active")).toBe("true");

      // Unregistering inspector binding resets toolbar back to Camera
      const owner = Symbol("inspector");
      const target = { kind: "object" as const, objectId: "disk" };
      const bounds = resolveTargetBoundsMeters(null, target);
      await act(async () => {
        registerTextureInspectorBinding(owner, {
          target,
          draft: createDefaultMagneticTextureDraft("vortex", bounds, "object"),
          bounds,
          patchDraft: vi.fn(),
          fitCharacteristicSize: vi.fn(),
          resetTransform: vi.fn(),
        });
        handleTextureGizmoShortcutKey("r");
      });
      expect(getModeBtn("viewport-mode-scale").getAttribute("data-active")).toBe("true");

      await act(async () => {
        unregisterTextureInspectorBinding(owner);
      });
      expect(getModeBtn("viewport-mode-camera").getAttribute("data-active")).toBe("true");
      expect(getModeBtn("viewport-mode-scale").getAttribute("data-active")).toBe("false");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
