import { act, useState, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonValue, SceneResource } from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  type TestElement,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { InspectorEditSessionProvider } from "@/modules/inspector/InspectorEditSession";
import { resetPersistedInspectorModeTabs } from "@/modules/inspector/template";
import { StageTextureAssignmentsEditor } from "@/modules/inspector/panels/stages/StageTextureAssignmentsEditor";
import { observationSourceWorkspaceStore } from "@/kernel/workspace/observationSourceWorkspace";
import { resetTextureDraftBridgeForTests } from "@/shared/domain/magnetization-texture/textureDraftBridge";

vi.mock("@radix-ui/react-tooltip", () => ({
  Provider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => (
    <span data-slot="mock-tooltip-content">{children}</span>
  ),
}));

vi.mock("@radix-ui/react-hover-card", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => (
    <div data-slot="mock-hover-card">{children}</div>
  ),
}));

vi.mock("@radix-ui/react-dropdown-menu", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Sub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SubTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Content: ({ children }: { children?: ReactNode }) => (
    <div data-slot="mock-dropdown-menu-content">{children}</div>
  ),
  CheckboxItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
  Item: ({
    children,
    disabled,
    onSelect,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onSelect?: (event: Event) => void;
  }) => (
    <button
      disabled={disabled}
      role="menuitem"
      type="button"
      onClick={() => onSelect?.(new TestEvent("select") as unknown as Event)}
    >
      {children}
    </button>
  ),
}));

vi.mock("@radix-ui/react-tabs", async () => {
  const React = await import("react");
  const TabsCtx = React.createContext<{
    value?: string;
    onValueChange?: (next: string) => void;
  }>({});
  return {
    Root: ({
      children,
      className,
      value,
      onValueChange,
    }: {
      children?: ReactNode;
      className?: string;
      value?: string;
      onValueChange?: (next: string) => void;
    }) => (
      <TabsCtx.Provider value={{ value, onValueChange }}>
        <div className={className}>{children}</div>
      </TabsCtx.Provider>
    ),
    List: ({
      children,
      className,
      ...props
    }: {
      children?: ReactNode;
      className?: string;
    }) => (
      <div className={className} role="tablist" {...props}>
        {children}
      </div>
    ),
    Trigger: ({
      children,
      className,
      disabled,
      value,
      onClick,
    }: {
      children?: ReactNode;
      className?: string;
      disabled?: boolean;
      value: string;
      onClick?: () => void;
    }) => {
      const ctx = React.useContext(TabsCtx);
      const active = ctx.value === value;
      return (
        <button
          aria-selected={active}
          className={className}
          data-state={active ? "active" : "inactive"}
          data-value={value}
          disabled={disabled}
          role="tab"
          type="button"
          onClick={() => {
            if (disabled) return;
            onClick?.();
            ctx.onValueChange?.(value);
          }}
        >
          {children}
        </button>
      );
    },
    Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  };
});

vi.mock("@radix-ui/react-select", async () => {
  const React = await import("react");
  const SelectCtx = React.createContext<{
    value?: string;
    onValueChange?: (next: string) => void;
    disabled?: boolean;
  }>({});
  return {
    Root: ({
      children,
      value,
      onValueChange,
      disabled,
    }: {
      children?: ReactNode;
      value?: string;
      onValueChange?: (next: string) => void;
      disabled?: boolean;
    }) => (
      <SelectCtx.Provider value={{ value, onValueChange, disabled }}>
        <div data-slot="mock-select-root">{children}</div>
      </SelectCtx.Provider>
    ),
    Group: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Value: () => {
      const ctx = React.useContext(SelectCtx);
      return <span>{ctx.value ?? ""}</span>;
    },
    Trigger: function MockSelectTrigger({
      children,
      className,
      disabled,
      id,
    }: {
      children?: ReactNode;
      className?: string;
      disabled?: boolean;
      id?: string;
    }) {
      const ctx = React.useContext(SelectCtx);
      return (
        <button
          className={className}
          disabled={disabled ?? ctx.disabled}
          id={id}
          type="button"
        >
          {children}
        </button>
      );
    },
    Icon: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Content: function MockSelectContent({ children }: { children?: ReactNode }) {
      return <div data-slot="mock-select-content">{children}</div>;
    },
    Viewport: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    ScrollUpButton: function MockSelectScrollUp({ children }: { children?: ReactNode }) {
      return <div>{children}</div>;
    },
    ScrollDownButton: function MockSelectScrollDown({ children }: { children?: ReactNode }) {
      return <div>{children}</div>;
    },
    Label: function MockSelectLabel({ children }: { children?: ReactNode }) {
      return <div>{children}</div>;
    },
    Separator: function MockSelectSeparator() {
      return <hr />;
    },
    Item: function MockSelectItem({
      children,
      value,
      disabled,
    }: {
      children?: ReactNode;
      value: string;
      disabled?: boolean;
    }) {
      const ctx = React.useContext(SelectCtx);
      return (
        <button
          aria-selected={ctx.value === value}
          data-select-option={value}
          disabled={disabled ?? ctx.disabled}
          role="option"
          type="button"
          onClick={() => ctx.onValueChange?.(value)}
        >
          {children}
        </button>
      );
    },
    ItemText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
  };
});

type TestInputCompat = TestElement & {
  _onPropertyChange?: (event: {
    propertyName: string;
    target: TestElement;
    srcElement: TestElement;
  }) => void;
  _valueTracker?: { setValue: (value: string) => void };
  attachEvent?: (
    name: string,
    listener: (event: {
      propertyName: string;
      target: TestElement;
      srcElement: TestElement;
    }) => void,
  ) => void;
  detachEvent?: (name: string) => void;
};

function attachReactInputShim(input: TestElement): TestInputCompat {
  const compat = input as TestInputCompat;
  if (!compat.attachEvent) {
    compat.attachEvent = (_name, listener) => {
      compat._onPropertyChange = listener;
    };
    compat.detachEvent = () => {
      compat._onPropertyChange = undefined;
    };
  }
  return compat;
}

function setInputValue(input: TestElement, nextValue: string): void {
  const compat = attachReactInputShim(input);
  const previous = input.value;
  input.value = nextValue;
  compat._valueTracker?.setValue(previous);
  if (compat._onPropertyChange) {
    compat._onPropertyChange({
      propertyName: "value",
      target: input,
      srcElement: input,
    });
    return;
  }
  input.dispatchEvent(new TestEvent("input", { bubbles: true }));
}

const mockSceneState: { data: SceneResource | null } = { data: null };
const mockRegionsState: { data: unknown } = { data: null };
const mockStatusState: { data: Record<string, unknown> | null } = { data: null };

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/kernel/resources/geometryLifecycleResources")>();
  return {
    ...actual,
    publishCommittedSceneResource: vi.fn(),
    useSceneResource: () => ({ data: mockSceneState.data, error: null, loading: false }),
    useModelRegionsResource: () => ({ data: mockRegionsState.data, error: null, loading: false }),
  };
});

vi.mock("@/kernel/resources/useSessionStatus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/kernel/resources/useSessionStatus")>();
  return {
    ...actual,
    useSessionStatusSelector: (selector: (s: { data: unknown; error: null; status: "ready" }) => unknown) =>
      selector({ data: mockStatusState.data, error: null, status: "ready" }),
    useSessionResourceIdentity: () => ({
      sessionEpoch: "1",
      requestScopeEpoch: "1",
      sessionId: "session-1",
    }),
  };
});

const mockActiveLaneState: { data: unknown } = { data: null };

vi.mock("@/kernel/resources/useActiveLaneCapabilities", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/kernel/resources/useActiveLaneCapabilities")>();
  return {
    ...actual,
    useActiveLaneCapabilities: () => mockActiveLaneState.data,
  };
});

import {
  MagneticTextureInspectorPanel,
  resolveMagneticTextureCapabilityGate,
} from "./MagneticTextureInspectorPanel";

function createTestScene(): SceneResource {
  return {
    revision: 12,
    magnetization_assets: [
      {
        id: "mag:nanodisk:bloch_skyrmion",
        kind: "preset_texture",
        name: "Bloch skyrmion",
        preset_kind: "bloch_skyrmion",
        preset_version: 2,
        preset_params: {
          plane: "xy",
          radius: 25e-9,
          wall_width: 5e-9,
          core_polarity: -1,
          chirality: 1,
        },
        mapping: {
          space: "object",
          projection: "object_local",
          clamp_mode: "none",
        },
        texture_transform: {
          translation: [0, 0, 0],
          rotation_quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
          pivot: [0, 0, 0],
          rotate_vectors: true,
        },
        ui_label: null,
      },
    ],
    objects: [
      {
        id: "nanodisk",
        name: "Nanodisk",
        role: "magnet",
        magnetization_ref: "mag:nanodisk:bloch_skyrmion",
        geometry: {
          geometry_kind: "Cylinder",
          geometry_params: { radius: 50e-9, height: 5e-9 },
        },
        regions: [
          {
            region_id: "ring",
            name: "Outer ring",
            enabled: true,
            priority: 10,
            shape: {
              kind: "cylinder",
              center: [0, 0, 0],
              radius: 40e-9,
              height: 5e-9,
            },
            texture_override: {
              initial_magnetization: {
                kind: "preset_texture",
                preset_kind: "vortex",
                preset_version: 2,
                preset_params: {
                  plane: "xy",
                  circulation: 1,
                  core_polarity: 1,
                  core_radius: 6e-9,
                },
                mapping: {
                  space: "region",
                  projection: "object_local",
                  clamp_mode: "none",
                },
                texture_transform: {
                  translation: [0, 0, 0],
                  rotation_quat: [0, 0, 0, 1],
                  scale: [1, 1, 1],
                  pivot: [0, 0, 0],
                  rotate_vectors: true,
                },
              },
            },
          },
        ],
      },
    ],
  } as unknown as SceneResource;
}

describe("MagneticTextureInspectorPanel & StageTextureAssignmentsEditor on 8-slot InspectorTemplate", () => {
  beforeEach(() => {
    resetPersistedInspectorModeTabs();
    resetTextureDraftBridgeForTests();
    mockSceneState.data = createTestScene();
    mockRegionsState.data = { regions: [], scene_revision: 12 };
    mockActiveLaneState.data = null;
    mockStatusState.data = {
      capabilities: {
        field_state_import_formats: ["field_state_json", "ovf", "npz"],
      },
    };
  });

  afterEach(() => {
    observationSourceWorkspaceStore.reset();
    vi.clearAllMocks();
  });

  function createKernelMock(overrides?: {
    applyMagnetization?: ReturnType<typeof vi.fn>;
    inspectImport?: ReturnType<typeof vi.fn>;
    preparedMagnetization?: ReturnType<typeof vi.fn>;
    executeCommand?: ReturnType<typeof vi.fn>;
  }) {
    const applyMagnetization =
      overrides?.applyMagnetization ??
      vi.fn(async (target: unknown) => ({
        committed_scene: { ...createTestScene(), revision: 13 },
        magnetization_apply: {
          operation_id: "op-1",
          scene_revision: 13,
          scopes: [
            {
              object_id: "nanodisk",
              region_id: (target as { region_id?: string }).region_id ?? null,
            },
          ],
          status: "initial_state_ready",
          prepared_initial_state: {
            scene_revision: 13,
            initial_state_revision: 2,
            publication_id: "pub-13",
            observation_frame_id: "frame-13",
            domain_generation_id: "mesh-13",
            values_sha256: "b".repeat(64),
          },
        },
        scene_revision: 13,
      }));
    const inspectImport =
      overrides?.inspectImport ??
      vi.fn(async () => ({
        compatible: true,
        datasets: ["fields/m"],
        frame_count: 4,
        max_norm: 1.0,
        min_norm: 0.999,
        source_grid_shape: [64, 64, 1],
        vector_count: 4096,
        zero_vector_count: 0,
      }));
    const preparedMagnetization =
      overrides?.preparedMagnetization ?? vi.fn(async () => ({}));
    const executeCommand =
      overrides?.executeCommand ?? vi.fn(async () => ({ status: "completed" }));
    const clearSavedFieldPresentation = vi.fn();
    const setArtifactFieldSelection = vi.fn();
    const closePlayback = vi.fn();
    const setActiveViewportMainModule = vi.fn();
    return {
      applyMagnetization,
      clearSavedFieldPresentation,
      closePlayback,
      executeCommand,
      inspectImport,
      preparedMagnetization,
      setActiveViewportMainModule,
      setArtifactFieldSelection,
      kernel: {
        analysisFieldOverlay: {
          clear: vi.fn(),
        },
        api: {
          resourceCacheScope: "test-scope",
          data: {
            fields: {
              preparedMagnetization,
            },
          },
          model: {
            applyMagnetization,
            scene: vi.fn(async () => mockSceneState.data),
            syncAuthoringScript: vi.fn(async () => ({})),
          },
          persistence: {
            fieldStates: {
              inspectImport,
              import: vi.fn(async () => ({ field_revision: 2 })),
              export: vi.fn(async () => ({ artifact_ref: "out.ovf" })),
            },
          },
        },
        authoringHistory: {
          getGeneration: () => 1,
          record: vi.fn(),
        },
        bus: { emit: vi.fn(), subscribe: () => () => undefined },
        commands: {
          execute: executeCommand,
          getSessionScopeKey: () =>
            "session=session-1&epoch=1&request_scope_epoch=1",
        },
        layout: {
          setActiveViewportMainModule,
        },
        resources: {
          invalidate: vi.fn(),
        },
        savedResultsPlayback: {
          getSnapshot: () => null,
          close: closePlayback,
        },
        selection: {
          get: () => null,
          clear: vi.fn(),
          set: vi.fn(),
        },
        visualization: {
          clearSavedFieldPresentation,
          setArtifactFieldSelection,
        },
      },
    };
  }

  it("renders all 20 SVG preset tiles, live TexturePreviewCanvas, and zero forbidden literals or raw controls", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const { kernel } = createKernelMock();
    const selection: Selection = {
      kind: "object.magnetic-texture",
      label: "Magnetic texture",
      moduleSource: "explorer",
      nodeId: "model:object:nanodisk:magnetic-texture",
      objectId: "nanodisk",
      ref: {
        kind: "object.magnetic-texture",
        nodeId: "model:object:nanodisk:magnetic-texture",
        objectId: "nanodisk",
        type: "scene-object",
        visualizationTargetId: "object:nanodisk",
      },
    };

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel as never}>
            <InspectorEditSessionProvider>
              <MagneticTextureInspectorPanel selection={selection} />
            </InspectorEditSessionProvider>
          </KernelContext.Provider>,
        );
      });

      const inspectorRoot = findElement(
        container,
        (el) => el.getAttribute("data-slot") === "inspector-root",
        "inspector-root",
      );
      expect(inspectorRoot.getAttribute("data-domain")).toBe("material");

      const presetTiles = findElements(
        container,
        (el) => el.getAttribute("data-preset-tile") !== null,
      );
      expect(presetTiles).toHaveLength(20);
      for (const tile of presetTiles) {
        const svgs = findElements(tile, (el) => el.tagName.toLowerCase() === "svg");
        expect(svgs.length).toBeGreaterThan(0);
      }

      const previewCanvas = findElement(
        container,
        (el) => el.getAttribute("data-testid") === "texture-preview-canvas",
        "texture-preview-canvas",
      );
      expect(previewCanvas).toBeTruthy();

      expect(findElements(container, (el) => el.tagName === "SELECT")).toHaveLength(0);
      expect(findElements(container, (el) => el.getAttribute("title") !== null)).toHaveLength(0);
      expect(container.textContent.toLowerCase()).not.toContain("unknown");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("replaces a same-value invalid radius when switching texture presets after focusing the field error", async () => {
    const vortexScene = createTestScene() as unknown as {
      magnetization_assets: Array<{
        preset_kind: string;
        preset_params: Record<string, unknown>;
      }>;
    };
    vortexScene.magnetization_assets[0]!.preset_kind = "vortex";
    vortexScene.magnetization_assets[0]!.preset_params = {
      plane: "xy",
      circulation: 1,
      core_polarity: 1,
      core_radius: 6e-9,
    };
    mockSceneState.data = vortexScene as unknown as SceneResource;

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const { applyMagnetization, kernel } = createKernelMock();
    const selection: Selection = {
      kind: "object.magnetic-texture",
      label: "Magnetic texture",
      moduleSource: "explorer",
      nodeId: "model:object:nanodisk:magnetic-texture",
      objectId: "nanodisk",
      ref: {
        kind: "object.magnetic-texture",
        nodeId: "model:object:nanodisk:magnetic-texture",
        objectId: "nanodisk",
        type: "scene-object",
        visualizationTargetId: "object:nanodisk",
      },
    };

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel as never}>
            <InspectorEditSessionProvider>
              <MagneticTextureInspectorPanel selection={selection} />
            </InspectorEditSessionProvider>
          </KernelContext.Provider>,
        );
      });

      const blochTile = findElement(
        container,
        (el) => el.getAttribute("data-preset-tile") === "bloch_skyrmion",
        "Bloch skyrmion tile",
      );
      await act(async () => blochTile.click());

      const radiusRow = findElement(
        container,
        (el) => el.getAttribute("data-row") === "radiusM",
        "characteristic radius row",
      );
      const radiusInput = findElement(
        radiusRow,
        (el) => el.tagName === "INPUT",
        "characteristic radius input",
      );
      expect(radiusInput.value).toBe("25");

      await act(async () => {
        attachReactInputShim(radiusInput);
        radiusInput.focus();
        radiusInput.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
      });
      await act(async () => setInputValue(radiusInput, "bad"));
      await act(async () => {
        radiusInput.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
      });
      expect(radiusInput.getAttribute("aria-invalid")).toBe("true");

      const fixFieldButton = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Fix 1 field to apply"),
        "Fix 1 field to apply button",
      );
      await act(async () => fixFieldButton.click());

      const neelTile = findElement(
        container,
        (el) => el.getAttribute("data-preset-tile") === "neel_skyrmion",
        "Néel skyrmion tile",
      );
      await act(async () => neelTile.click());

      const resetRadiusInput = findElement(
        findElement(
          container,
          (el) => el.getAttribute("data-row") === "radiusM",
          "reset characteristic radius row",
        ),
        (el) => el.tagName === "INPUT",
        "reset characteristic radius input",
      );
      expect(resetRadiusInput.value).toBe("25");
      expect(container.textContent).not.toContain("Fix 1 field to apply");

      const applyButton = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Apply Texture"),
        "Apply Texture button",
      );
      expect(applyButton.disabled).toBe(false);
      await act(async () => applyButton.click());

      expect(applyMagnetization).toHaveBeenCalledTimes(1);
      expect(applyMagnetization.mock.calls[0]?.[0]).toMatchObject({
        kind: "object",
        object_id: "nanodisk",
        asset: {
          preset_kind: "neel_skyrmion",
          preset_params: { radius: 25e-9 },
        },
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("switches region from Override to Inherit from Object and commits applyMagnetization with texture_override: null", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const { applyMagnetization, kernel } = createKernelMock();
    const selection: Selection = {
      kind: "object.region.texture",
      label: "Magnetic texture",
      moduleSource: "explorer",
      nodeId: "model:object:nanodisk:region:ring:texture",
      objectId: "nanodisk",
      ref: {
        kind: "object.region.texture",
        nodeId: "model:object:nanodisk:region:ring:texture",
        objectId: "nanodisk",
        regionId: "ring",
        type: "scene-object",
        visualizationTargetId: "region:nanodisk:ring",
      },
    };

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel as never}>
            <InspectorEditSessionProvider>
              <MagneticTextureInspectorPanel selection={selection} />
            </InspectorEditSessionProvider>
          </KernelContext.Provider>,
        );
      });

      const inheritBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Inherit from object"),
        "Inherit from object button",
      );
      await act(async () => {
        inheritBtn.click();
      });

      const applyBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.trim().startsWith("Apply"),
        "Apply button",
      );
      await act(async () => {
        applyBtn.click();
      });

      expect(applyMagnetization).toHaveBeenCalledTimes(1);
      expect(applyMagnetization.mock.calls[0]?.[0]).toEqual({
        kind: "region",
        object_id: "nanodisk",
        region_id: "ring",
        texture_override: null,
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("writes fullmag.magnetization-assignments.v1 to stageMagnetizationAssignments while leaving scriptMagnetizationAssignments untouched", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const scene = createTestScene();
    const scriptAssignments = {
      schema_version: "fullmag.magnetization-assignments.v1",
      assignments: [
        { object_id: "nanodisk", region_id: null, initializer: { kind: "uniform", value: [0, 0, 1] } },
      ],
    };

    let latestDraft: {
      stageMagnetizationAssignments: JsonValue | undefined;
      scriptMagnetizationAssignments: JsonValue;
    } = {
      stageMagnetizationAssignments: undefined,
      scriptMagnetizationAssignments: scriptAssignments,
    };

    function StageHarness() {
      const [open, setOpen] = useState(false);
      const [stageDraft, setStageDraft] = useState(latestDraft);
      latestDraft = stageDraft;
      return (
        <StageTextureAssignmentsEditor
          disabledReason={null}
          open={open}
          scene={scene}
          value={stageDraft.stageMagnetizationAssignments}
          onChange={(next) =>
            setStageDraft((prev) => ({
              ...prev,
              stageMagnetizationAssignments: next,
            }))
          }
          onOpenChange={setOpen}
        />
      );
    }

    try {
      await act(async () => {
        root.render(<StageHarness />);
      });

      const addChangeBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Add texture change"),
        "Add texture change",
      );
      await act(async () => {
        addChangeBtn.click();
      });

      const skyrmionTile = findElement(
        container,
        (el) => el.getAttribute("data-preset-tile") === "bloch_skyrmion",
        "bloch_skyrmion tile",
      );
      await act(async () => {
        skyrmionTile.click();
      });

      const fitBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Fit characteristic size"),
        "Fit characteristic size",
      );
      await act(async () => {
        fitBtn.click();
      });

      const commitToStageBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Add to stage"),
        "Add to stage",
      );
      await act(async () => {
        commitToStageBtn.click();
      });

      expect(latestDraft.scriptMagnetizationAssignments).toEqual(scriptAssignments);
      expect(latestDraft.stageMagnetizationAssignments).toMatchObject({
        schema_version: "fullmag.magnetization-assignments.v1",
        assignments: [
          {
            object_id: "nanodisk",
            region_id: null,
            initializer: {
              kind: "preset_texture",
              preset_kind: "bloch_skyrmion",
              preset_version: 2,
              preset_params: {
                radius: 25e-9,
                wall_width: 5e-9,
              },
              texture_transform: {
                scale: [1, 1, 1],
              },
            },
          },
        ],
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("displays only formats advertised in capabilities.field_state_import_formats and triggers inspectImport", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const { inspectImport, kernel } = createKernelMock();
    const selection: Selection = {
      kind: "object.magnetic-texture",
      label: "Magnetic texture",
      moduleSource: "explorer",
      nodeId: "model:object:nanodisk:magnetic-texture",
      objectId: "nanodisk",
      ref: {
        kind: "object.magnetic-texture",
        nodeId: "model:object:nanodisk:magnetic-texture",
        objectId: "nanodisk",
        type: "scene-object",
        visualizationTargetId: "object:nanodisk",
      },
    };

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel as never}>
            <InspectorEditSessionProvider>
              <MagneticTextureInspectorPanel selection={selection} />
            </InspectorEditSessionProvider>
          </KernelContext.Provider>,
        );
      });

      const fieldFileTab = findElement(
        container,
        (el) => el.getAttribute("role") === "tab" && el.textContent.includes("Field file"),
        "Field file tab",
      );
      await act(async () => {
        fieldFileTab.dispatchEvent(new TestEvent("mousedown", { bubbles: true }));
        fieldFileTab.click();
      });

      const formatList = findElement(
        container,
        (el) => el.getAttribute("data-testid") === "supported-field-formats",
        "supported-field-formats",
      );
      expect(formatList.textContent).toContain("OVF");
      expect(formatList.textContent).toContain("NPZ");
      expect(formatList.textContent).not.toContain("HDF5");
      expect(formatList.textContent).not.toContain("Zarr");

      const pathField = findElement(
        container,
        (el) => el.getAttribute("data-row") === "fieldSourcePath",
        "fieldSourcePath row",
      );
      const pathInput = findElement(pathField, (el) => el.tagName === "INPUT", "path input");
      await act(async () => {
        attachReactInputShim(pathInput);
        pathInput.focus();
        pathInput.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
      });
      await act(async () => {
        setInputValue(pathInput, "checkpoints/relaxed_disk.ovf");
      });

      const inspectBtn = findElement(
        container,
        (el) => el.getAttribute("data-testid") === "inspect-field-file-btn",
        "inspect-field-file-btn",
      );
      await act(async () => {
        inspectBtn.click();
      });

      expect(inspectImport).toHaveBeenCalledTimes(1);
      expect(inspectImport.mock.calls[0]?.[0]).toMatchObject({
        artifact_ref: "checkpoints/relaxed_disk.ovf",
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("evaluates MT-15 capability gates dynamically against live draft (uniform, vortex, preset_v2 with fallback, and sampled_field)", async () => {
    const laneWithPresetV2Blocked = {
      operations: {
        "initial_magnetization.uniform": { state: "supported", reason: null },
        "initial_magnetization.vortex": { state: "supported", reason: null },
        "initial_magnetization.preset_v2": {
          state: "unsupported",
          reason: "Analytical v2 skyrmion presets require the FEM/FDM v2 initializer.",
        },
        "initial_magnetization.sampled_field": {
          state: "unsupported",
          reason: "Sampled field import is unavailable on this solver lane.",
        },
      },
    };
    mockActiveLaneState.data = laneWithPresetV2Blocked;

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const { kernel } = createKernelMock();
    const selection: Selection = {
      kind: "object.magnetic-texture",
      label: "Magnetic texture",
      moduleSource: "explorer",
      nodeId: "model:object:nanodisk:magnetic-texture",
      objectId: "nanodisk",
      ref: {
        kind: "object.magnetic-texture",
        nodeId: "model:object:nanodisk:magnetic-texture",
        objectId: "nanodisk",
        type: "scene-object",
        visualizationTargetId: "object:nanodisk",
      },
    };

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel as never}>
            <InspectorEditSessionProvider>
              <MagneticTextureInspectorPanel selection={selection} />
            </InspectorEditSessionProvider>
          </KernelContext.Provider>,
        );
      });

      // Baseline is bloch_skyrmion -> blocked by initial_magnetization.preset_v2
      expect(container.textContent).toContain(
        "Analytical v2 skyrmion presets require the FEM/FDM v2 initializer.",
      );

      // Switching live draft to Uniform clears the MT-15 error notice immediately
      const uniformTile = findElement(
        container,
        (el) => el.getAttribute("data-preset-tile") === "uniform",
        "uniform tile",
      );
      await act(async () => uniformTile.click());
      expect(container.textContent).not.toContain(
        "Analytical v2 skyrmion presets require the FEM/FDM v2 initializer.",
      );

      // Switching live draft to Vortex uses initial_magnetization.vortex (supported)
      const vortexTile = findElement(
        container,
        (el) => el.getAttribute("data-preset-tile") === "vortex",
        "vortex tile",
      );
      await act(async () => vortexTile.click());
      expect(container.textContent).not.toContain("Unsupported in active solver lane");

      // Switching to Field file mode triggers initial_magnetization.sampled_field gate
      const fieldFileTab = findElement(
        container,
        (el) => el.getAttribute("role") === "tab" && el.textContent.includes("Field file"),
        "Field file tab",
      );
      await act(async () => fieldFileTab.click());
      expect(container.textContent).toContain(
        "Sampled field import is unavailable on this solver lane.",
      );

      // Fallback check: when preset_v2 is absent from mock operations, non-uniform presets fall back to vortex
      const legacyMockLane = {
        operations: {
          "initial_magnetization.uniform": { state: "supported", reason: null },
          "initial_magnetization.vortex": {
            state: "unsupported",
            reason: "Legacy vortex gate active",
          },
        },
      };
      expect(
        resolveMagneticTextureCapabilityGate(legacyMockLane as never, {
          inheritanceMode: "override",
          sourceMode: "preset",
          presetKind: "hopfion",
        } as never),
      ).toEqual({
        enabled: false,
        reason: "Legacy vortex gate active",
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("supports clean Reapply Texture, post-apply Show initial magnetization preview, and Clear (asset: null)", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const {
      applyMagnetization,
      clearSavedFieldPresentation,
      closePlayback,
      kernel,
      preparedMagnetization,
      setActiveViewportMainModule,
      setArtifactFieldSelection,
    } = createKernelMock();
    const selection: Selection = {
      kind: "object.magnetic-texture",
      label: "Magnetic texture",
      moduleSource: "explorer",
      nodeId: "model:object:nanodisk:magnetic-texture",
      objectId: "nanodisk",
      ref: {
        kind: "object.magnetic-texture",
        nodeId: "model:object:nanodisk:magnetic-texture",
        objectId: "nanodisk",
        type: "scene-object",
        visualizationTargetId: "object:nanodisk",
      },
    };

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel as never}>
            <InspectorEditSessionProvider>
              <MagneticTextureInspectorPanel selection={selection} />
            </InspectorEditSessionProvider>
          </KernelContext.Provider>,
        );
      });

      // Item 4: Clean Reapply Texture is visible & enabled when dirtyFields is empty
      const reapplyBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Reapply Texture"),
        "Reapply Texture button",
      );
      expect(reapplyBtn.disabled).toBe(false);

      await act(async () => {
        reapplyBtn.click();
      });

      expect(applyMagnetization).toHaveBeenCalledTimes(1);
      expect(applyMagnetization.mock.calls[0]?.[0]).toMatchObject({
        kind: "object",
        object_id: "nanodisk",
        asset: {
          id: "mag:nanodisk:bloch_skyrmion",
          preset_kind: "bloch_skyrmion",
        },
      });

      // Item 1: Post-apply "Show initial magnetization" button probes preparedMagnetization and opens 3D preview
      const showInitialBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.trim() === "Show initial magnetization",
        "Show initial magnetization button",
      );
      await act(async () => {
        showInitialBtn.click();
      });

      expect(preparedMagnetization).toHaveBeenCalledTimes(1);
      expect(clearSavedFieldPresentation).toHaveBeenCalledTimes(1);
      expect(setArtifactFieldSelection).toHaveBeenCalledWith(null);
      expect(closePlayback).toHaveBeenCalledTimes(1);
      expect(setActiveViewportMainModule).toHaveBeenCalledWith("viewport-3d");
      expect(observationSourceWorkspaceStore.getSnapshot().prepared).toMatchObject({
        objectId: "nanodisk",
        regionId: null,
        source: {
          publication_id: "pub-13",
          scene_revision: 13,
        },
      });

      // Item 2: Clear button commits { kind: "object", object_id, asset: null }
      const clearBtn = findElement(
        container,
        (el) => el.getAttribute("data-testid") === "clear-magnetization-btn",
        "Clear magnetization button",
      );
      await act(async () => {
        clearBtn.click();
      });

      expect(applyMagnetization).toHaveBeenCalledTimes(2);
      expect(applyMagnetization.mock.calls[1]?.[0]).toEqual({
        kind: "object",
        object_id: "nanodisk",
        asset: null,
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("opens Field file tab on redirected object.magnetic-texture.load and executes study.load-field-state on Load File", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const executeCommand = vi.fn(async () => ({
      status: "completed" as const,
      message: "Field state loaded from disk.ovf.",
    }));
    const { kernel } = createKernelMock({ executeCommand });
    const loadSelection: Selection = {
      kind: "object.magnetic-texture.load",
      label: "Load texture",
      moduleSource: "explorer",
      nodeId: "model:object:nanodisk:magnetic-texture:load",
      objectId: "nanodisk",
      ref: {
        kind: "object.magnetic-texture.load",
        nodeId: "model:object:nanodisk:magnetic-texture:load",
        objectId: "nanodisk",
        type: "scene-object",
        visualizationTargetId: "object:nanodisk",
      },
    };

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel as never}>
            <InspectorEditSessionProvider>
              <MagneticTextureInspectorPanel selection={loadSelection} />
            </InspectorEditSessionProvider>
          </KernelContext.Provider>,
        );
      });

      const fieldFileTab = findElement(
        container,
        (el) => el.getAttribute("role") === "tab" && el.textContent.includes("Field file"),
        "Field file tab",
      );
      expect(fieldFileTab.getAttribute("aria-selected")).toBe("true");

      const loadBtn = findElement(
        container,
        (el) => el.getAttribute("data-testid") === "load-field-state-btn",
        "Load File button",
      );
      await act(async () => {
        loadBtn.click();
      });

      expect(executeCommand).toHaveBeenCalledWith(
        "study.load-field-state",
        expect.objectContaining({
          sourceDetail: "object-magnetic-texture-load",
        }),
      );
      expect(container.textContent).toContain("Field state loaded from disk.ovf.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("edits full 3D [dx, dy, dz] relative center offsets in bounds_pct and bounds_norm while preserving Y and Z, and preserves custom asset.id", async () => {
    const customScene = createTestScene() as unknown as {
      magnetization_assets: Array<Record<string, unknown>>;
      objects: Array<Record<string, unknown>>;
    };
    customScene.magnetization_assets[0]!.id = "custom_skyrmion_asset";
    customScene.magnetization_assets[0]!.preset_version = 1;
    customScene.magnetization_assets[0]!.mapping = {
      space: "object",
      projection: "planar_face",
      clamp_mode: "background",
      background_vector: [0, 1, 0],
    };
    customScene.magnetization_assets[0]!.texture_transform = {
      translation: [0, 20e-9, 1e-9],
      rotation_quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
      pivot: [0, 0, 0],
      rotate_vectors: true,
    };
    customScene.objects[0]!.magnetization_ref = "custom_skyrmion_asset";
    mockSceneState.data = customScene as unknown as SceneResource;

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const { applyMagnetization, kernel } = createKernelMock();
    const selection: Selection = {
      kind: "object.magnetic-texture",
      label: "Magnetic texture",
      moduleSource: "explorer",
      nodeId: "model:object:nanodisk:magnetic-texture",
      objectId: "nanodisk",
      ref: {
        kind: "object.magnetic-texture",
        nodeId: "model:object:nanodisk:magnetic-texture",
        objectId: "nanodisk",
        type: "scene-object",
        visualizationTargetId: "object:nanodisk",
      },
    };

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel as never}>
            <InspectorEditSessionProvider>
              <MagneticTextureInspectorPanel selection={selection} />
            </InspectorEditSessionProvider>
          </KernelContext.Provider>,
        );
      });

      // Switch Offset coordinate mode to bounds_pct (%)
      const pctOption = findElement(
        container,
        (el) => el.getAttribute("data-select-option") === "bounds_pct",
        "bounds_pct option",
      );
      await act(async () => {
        pctOption.click();
      });

      const relVector = findElement(
        container,
        (el) => el.getAttribute("data-testid") === "relative-center-offset-vector3",
        "relative-center-offset-vector3",
      );
      const axisInputs = findElements(relVector, (el) => el.tagName === "INPUT");
      expect(axisInputs).toHaveLength(3);

      // Edit X to +25% (cylinder diameter = 100 nm -> +25 nm) while preserving Y = 20 nm, Z = 1 nm!
      await act(async () => {
        attachReactInputShim(axisInputs[0]!);
        axisInputs[0]!.focus();
        axisInputs[0]!.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
      });
      await act(async () => {
        setInputValue(axisInputs[0]!, "25");
      });

      // Switch to bounds_norm [-1..1] and edit Z to -0.5 (height = 5 nm, half-extent = 2.5 nm -> -1.25 nm)
      const normOption = findElement(
        container,
        (el) => el.getAttribute("data-select-option") === "bounds_norm",
        "bounds_norm option",
      );
      await act(async () => {
        normOption.click();
      });

      const normInputs = findElements(
        findElement(
          container,
          (el) => el.getAttribute("data-testid") === "relative-center-offset-vector3",
          "norm vector",
        ),
        (el) => el.tagName === "INPUT",
      );
      await act(async () => {
        attachReactInputShim(normInputs[2]!);
        normInputs[2]!.focus();
        normInputs[2]!.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
      });
      await act(async () => {
        setInputValue(normInputs[2]!, "-0.5");
      });

      // Apply Texture: custom asset.id "custom_skyrmion_asset" AND Y = 20 nm are preserved!
      const applyBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Apply Texture"),
        "Apply Texture button",
      );
      await act(async () => {
        applyBtn.click();
      });

      expect(applyMagnetization).toHaveBeenCalledTimes(1);
      const savedPayload = applyMagnetization.mock.calls[0]?.[0] as {
        kind: string;
        object_id: string;
        asset: {
          id: string;
          preset_version: number;
          mapping: {
            clamp_mode: string;
            background_vector?: [number, number, number];
          };
          texture_transform: { translation: [number, number, number] };
        };
      };
      expect(savedPayload.asset.id).toBe("custom_skyrmion_asset");
      expect(savedPayload.asset.preset_version).toBe(2);
      expect(savedPayload.asset.mapping.clamp_mode).toBe("background");
      expect(savedPayload.asset.mapping.background_vector).toEqual([0, 1, 0]);
      expect(savedPayload.asset.texture_transform.translation[0]).toBeCloseTo(25e-9, 15);
      expect(savedPayload.asset.texture_transform.translation[1]).toBeCloseTo(20e-9, 15);
      expect(savedPayload.asset.texture_transform.translation[2]).toBeCloseTo(-1.25e-9, 15);

      // Editing Magnetization ref explicitly writes the new custom asset ID
      const magRefRow = findElement(
        container,
        (el) => el.getAttribute("data-row") === "magnetizationRef",
        "magnetizationRef row",
      );
      const magRefInput = findElement(magRefRow, (el) => el.tagName === "INPUT", "magRef input");
      await act(async () => {
        attachReactInputShim(magRefInput);
        magRefInput.focus();
        magRefInput.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
      });
      await act(async () => {
        setInputValue(magRefInput, "user:custom:m0");
      });
      const applyBtn2 = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Apply Texture"),
        "Apply Texture button 2",
      );
      await act(async () => {
        applyBtn2.click();
      });
      expect(applyMagnetization).toHaveBeenCalledTimes(2);
      expect(
        (applyMagnetization.mock.calls[1]?.[0] as { asset: { id: string } }).asset.id,
      ).toBe("user:custom:m0");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("blocks Apply with a clear lockReason when a region target has no authored region record", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const { applyMagnetization, kernel } = createKernelMock();
    const unauthoredRegionSelection: Selection = {
      kind: "object.region.texture",
      label: "Magnetic texture",
      moduleSource: "explorer",
      nodeId: "model:object:nanodisk:region:missing_region:texture",
      objectId: "nanodisk",
      ref: {
        kind: "object.region.texture",
        nodeId: "model:object:nanodisk:region:missing_region:texture",
        objectId: "nanodisk",
        regionId: "missing_region",
        type: "scene-object",
        visualizationTargetId: "region:nanodisk:missing_region",
      },
    };

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel as never}>
            <InspectorEditSessionProvider>
              <MagneticTextureInspectorPanel selection={unauthoredRegionSelection} />
            </InspectorEditSessionProvider>
          </KernelContext.Provider>,
        );
      });

      expect(container.textContent).toContain(
        "Select an authored magnetic region to apply its texture.",
      );

      const commitBar = findElement(
        container,
        (el) => el.getAttribute("data-slot") === "inspector-commit-bar",
        "inspector-commit-bar",
      );
      const applyBtn = findElement(
        commitBar,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Texture"),
        "locked Apply button",
      );
      expect(applyBtn.disabled).toBe(true);

      await act(async () => {
        applyBtn.click();
      });
      expect(applyMagnetization).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("authors Finite thickness (axis_extent_mode + axis_thickness_m) on both object and region targets and auto-activates prepared_initial_state on Apply", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const { applyMagnetization, kernel, setArtifactFieldSelection } = createKernelMock();
    const objectSelection: Selection = {
      kind: "object.magnetic-texture",
      label: "Magnetic texture",
      moduleSource: "explorer",
      nodeId: "model:object:nanodisk:magnetic-texture",
      objectId: "nanodisk",
      ref: {
        kind: "object.magnetic-texture",
        nodeId: "model:object:nanodisk:magnetic-texture",
        objectId: "nanodisk",
        type: "scene-object",
        visualizationTargetId: "object:nanodisk",
      },
    };
    const regionSelection: Selection = {
      kind: "object.region.texture",
      label: "Magnetic texture",
      moduleSource: "explorer",
      nodeId: "model:object:nanodisk:region:ring:texture",
      objectId: "nanodisk",
      ref: {
        kind: "object.region.texture",
        nodeId: "model:object:nanodisk:region:ring:texture",
        objectId: "nanodisk",
        regionId: "ring",
        type: "scene-object",
        visualizationTargetId: "region:nanodisk:ring",
      },
    };

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider
            value={kernel as unknown as ComponentProps<typeof KernelContext.Provider>["value"]}
          >
            <InspectorEditSessionProvider>
              <MagneticTextureInspectorPanel selection={objectSelection} />
            </InspectorEditSessionProvider>
          </KernelContext.Provider>,
        );
      });

      // Default mode is "Uniform through axis" — Axis thickness row is hidden
      expect(
        findElements(container, (el) => el.getAttribute("data-row") === "axisThicknessM"),
      ).toHaveLength(0);

      // Switch Through-axis extent segmented control to "Finite thickness"
      const finiteBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.trim() === "Finite thickness",
        "Finite thickness option",
      );
      await act(async () => {
        finiteBtn.click();
      });

      const thicknessRow = findElement(
        container,
        (el) => el.getAttribute("data-row") === "axisThicknessM",
        "axisThicknessM row",
      );
      const thicknessInput = findElement(
        thicknessRow,
        (el) => el.tagName === "INPUT",
        "axisThicknessM input",
      );
      // Default thickness is 1 nm; edit to 1.5 nm and apply on object target
      expect(thicknessInput.value).toBe("1");
      await act(async () => {
        attachReactInputShim(thicknessInput);
        thicknessInput.focus();
        thicknessInput.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
      });
      await act(async () => {
        setInputValue(thicknessInput, "1.5");
        thicknessInput.dispatchEvent(new TestEvent("blur", { bubbles: false }));
      });

      const applyObjectBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Apply Texture"),
        "Apply Texture object button",
      );
      await act(async () => {
        applyObjectBtn.click();
      });

      expect(applyMagnetization).toHaveBeenCalledTimes(1);
      const savedObjCall = applyMagnetization.mock.calls[0]?.[0] as {
        kind: string;
        object_id: string;
        asset: { mapping: { axis_extent_mode: string; axis_thickness_m: number } };
      };
      expect(savedObjCall.kind).toBe("object");
      expect(savedObjCall.object_id).toBe("nanodisk");
      expect(savedObjCall.asset.mapping.axis_extent_mode).toBe("thickness");
      expect(savedObjCall.asset.mapping.axis_thickness_m).toBeCloseTo(1.5e-9, 15);

      // Bonus UX: Applying with status === "initial_state_ready" automatically activates prepared_initial_state!
      expect(setArtifactFieldSelection).toHaveBeenCalledWith(null);
      expect(observationSourceWorkspaceStore.getSnapshot().prepared).toMatchObject({
        objectId: "nanodisk",
        regionId: null,
        source: {
          publication_id: "pub-13",
          scene_revision: 13,
        },
      });

      // Now switch to Region target ("ring"), enable Finite thickness (default 1 nm), and Apply
      await act(async () => {
        root.render(
          <KernelContext.Provider
            value={kernel as unknown as ComponentProps<typeof KernelContext.Provider>["value"]}
          >
            <InspectorEditSessionProvider>
              <MagneticTextureInspectorPanel selection={regionSelection} />
            </InspectorEditSessionProvider>
          </KernelContext.Provider>,
        );
      });

      const regionFiniteBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.trim() === "Finite thickness",
        "Region Finite thickness option",
      );
      await act(async () => {
        regionFiniteBtn.click();
      });

      const applyRegionBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Apply Texture"),
        "Apply Texture region button",
      );
      await act(async () => {
        applyRegionBtn.click();
      });

      expect(applyMagnetization).toHaveBeenCalledTimes(2);
      expect(applyMagnetization.mock.calls[1]?.[0]).toMatchObject({
        kind: "region",
        object_id: "nanodisk",
        region_id: "ring",
        texture_override: {
          initial_magnetization: {
            kind: "preset_texture",
            mapping: {
              space: "region",
              axis_extent_mode: "thickness",
              axis_thickness_m: 1e-9,
            },
          },
        },
      });

      // Unmounting MagneticTextureInspectorPanel leaves prepared_initial_state active on the viewport!
      await act(async () => {
        root.render(<div />);
      });
      expect(observationSourceWorkspaceStore.getSnapshot().prepared).toMatchObject({
        objectId: "nanodisk",
        regionId: "ring",
        source: {
          publication_id: "pub-13",
          scene_revision: 13,
        },
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
