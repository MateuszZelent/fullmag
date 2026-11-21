import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { WorkspaceSideRail } from "@/kernel/layout/WorkspaceSideRail";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { ModuleRegistry } from "@/kernel/module/ModuleRegistry";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import {
  setViewport3DInspectorContext,
  useViewport3DInspectorContext,
} from "@/modules/viewport-3d/public";
import { Input } from "@/shared/ui/Input";

// Render Radix AlertDialog inline inside the lightweight node test DOM while preserving
// role="alertdialog" and real button click handlers.
vi.mock("@/shared/ui/AlertDialog", () => ({
  AlertDialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <>{children}</> : null,
  AlertDialogContent: ({
    children,
    ...props
  }: {
    children: ReactNode;
    [key: string]: unknown;
  }) => (
    <section data-slot="alert-dialog-content" role="alertdialog" {...props}>
      {children}
    </section>
  ),
  AlertDialogDescription: ({ children }: { children: ReactNode }) => (
    <div data-slot="alert-dialog-description">{children}</div>
  ),
  AlertDialogFooter: ({ children }: { children: ReactNode }) => (
    <footer data-slot="alert-dialog-footer">{children}</footer>
  ),
  AlertDialogHeader: ({ children }: { children: ReactNode }) => (
    <header data-slot="alert-dialog-header">{children}</header>
  ),
  AlertDialogTitle: ({ children }: { children: ReactNode }) => (
    <h2 data-slot="alert-dialog-title">{children}</h2>
  ),
}));

vi.mock("@/kernel/resources/useSessionStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/resources/useSessionStatus")>()),
  useSessionResourceIdentity: () => ({
    requestScopeEpoch: "api:1",
    sessionEpoch: "1",
    sessionId: "session-a",
  }),
}));

vi.mock("@/modules/viewport-3d/public", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/viewport-3d/public")>();
  return {
    ...actual,
    Viewport3DExportPanelOutlet: () => <div data-testid="export-outlet">3D Export Panel</div>,
    Viewport3DInspectorOutlet: () => <div data-testid="view-outlet">3D View Settings</div>,
  };
});

import * as inspectorRegistry from "./inspectorRegistry";
import { useInspectorEditSessionV2Controller } from "./InspectorEditSession";
import InspectorModule from "./InspectorModule";

const FILM_SELECTION: Selection = {
  kind: "object.material",
  label: "Permalloy film",
  moduleSource: "explorer",
  nodeId: "model:object:film:material",
  objectId: "film",
  ref: {
    kind: "object.material",
    nodeId: "model:object:film:material",
    objectId: "film",
    type: "scene-object",
    visualizationTargetId: "object:film",
  },
};

const OTHER_OBJECT_SELECTION: Selection = {
  kind: "object.root",
  label: "Waveguide",
  moduleSource: "viewport-3d",
  nodeId: "model:object:waveguide",
  objectId: "waveguide",
  ref: {
    kind: "object.root",
    nodeId: "model:object:waveguide",
    objectId: "waveguide",
    type: "scene-object",
    visualizationTargetId: "object:waveguide",
  },
};

function makeKernel(initialSelection: Selection): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const commands = new CommandRegistry();
  const scopeKey = "session=session-a&epoch=1&request_scope_epoch=api%3A1";
  commands.attachSessionScopeSource({
    getScopeKey: () => scopeKey,
    subscribe: () => () => undefined,
  });
  const modules = new ModuleRegistry();
  modules.register({
    component: async () => ({ default: () => null }),
    id: "viewport-3d",
    slots: ["viewport-main"],
    title: "3D Viewport",
    version: "0.1.0",
  });
  const selection = new SelectionController(bus);
  selection.set(initialSelection, "explorer");
  return {
    authoringHistory: {
      getGeneration: () => 1,
      record: vi.fn(),
      subscribe: () => () => undefined,
    },
    bus,
    commands,
    layout: new LayoutController(bus),
    modules,
    pendingForms: {
      register: vi.fn(),
      unregister: vi.fn(),
      update: vi.fn(() => true),
    },
    resources: new ResourceInvalidationController(bus),
    selection,
  } as unknown as KernelApi;
}

describe("InspectorDirtySelectionGuard top-level protection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setViewport3DInspectorContext("selection");
  });

  it("intercepts_canvas_or_tree_selection_while_on_3d_view_tab_and_restores_selection_tab_with_guard_modal", async () => {
    const dom = installSimulationPreparationTestDom();
    const proto = TestElement.prototype as unknown as {
      scrollTo?: (opts?: { left?: number; top?: number }) => void;
    };
    const hadScrollTo = Object.prototype.hasOwnProperty.call(proto, "scrollTo");
    const prevScrollTo = proto.scrollTo;
    proto.scrollTo = function scrollToStub(opts) {
      if (typeof opts?.top === "number") {
        (this as unknown as TestElement).scrollTop = opts.top;
      }
      if (typeof opts?.left === "number") {
        (this as unknown as TestElement).scrollLeft = opts.left;
      }
    };

    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const applySpy = vi.fn(async () => true);

    function FakeMaterialPanel({ selection }: { selection: Selection }) {
      const controller = useInspectorEditSessionV2Controller<{
        alpha: number;
        ms: number;
      }>({
        baseline: { alpha: 0.008, ms: 800 },
        fieldLabels: {
          alpha: "Gilbert damping (alpha)",
          ms: "Saturation magnetization (Ms)",
        },
        mode: "staged",
        nodeTitle: selection.label ?? "Selection",
        onApply: applySpy,
        selectionKey: selection.nodeId ?? "unknown",
        specId: "object.material",
      });

      return (
        <div data-panel-selection={selection.objectId ?? ""}>
          <Input
            aria-label="Ms"
            value={String(controller.draft.ms)}
            onChange={(event) => {
              controller.setField("ms", Number(event.currentTarget.value));
            }}
            onInput={(event) => {
              controller.setField("ms", Number(event.currentTarget.value));
            }}
          />
          <Input
            aria-label="Alpha"
            value={String(controller.draft.alpha)}
            onChange={(event) => {
              controller.setField("alpha", Number(event.currentTarget.value));
            }}
            onInput={(event) => {
              controller.setField("alpha", Number(event.currentTarget.value));
            }}
          />
        </div>
      );
    }

    vi.spyOn(inspectorRegistry, "resolveInspectorPanel").mockImplementation(
      (sel) => ({
        component: FakeMaterialPanel,
        id: sel.kind === "object.material" ? "object-material-assignment" : "object-general",
        selectionKinds: [sel.kind ?? "object.root"],
        title: sel.kind === "object.material" ? "Material" : "Object",
      }),
    );

    const kernel = makeKernel(FILM_SELECTION);
    let currentContext = "selection";
    function ContextProbe() {
      currentContext = useViewport3DInspectorContext();
      return null;
    }

    try {
      setViewport3DInspectorContext("selection");
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <ContextProbe />
            <WorkspaceSideRail side="right" />
            <InspectorModule />
          </KernelContext.Provider>,
        );
      });

      const msInput = findElement(
        container,
        (el) => el.getAttribute("aria-label") === "Ms",
      )!;
      const alphaInput = findElement(
        container,
        (el) => el.getAttribute("aria-label") === "Alpha",
      )!;

      // Dirty two fields in staged session.
      await act(async () => {
        msInput.value = "840";
        msInput.dispatchEvent(new TestEvent("input", { bubbles: true }));
        alphaInput.value = "0.015";
        alphaInput.dispatchEvent(new TestEvent("input", { bubbles: true }));
      });

      // Switch right-side rail to 3D View tab: selection subtree stays mounted with hidden, draft survives!
      await act(async () => {
        setViewport3DInspectorContext("view");
      });
      expect(currentContext).toBe("view");
      expect(msInput.value).toBe("840");
      const selectionRailButton = findElement(
        container,
        (el) => el.getAttribute("data-rail-item") === "selection",
      );
      expect(selectionRailButton?.getAttribute("data-dirty-fields-count")).toBe("2");
      expect(
        findElement(
          selectionRailButton!,
          (el) => el.className === "fm-side-rail__dirty-dot",
        ),
      ).not.toBeNull();
      expect(
        findElement(
          container,
          (el) =>
            el.getAttribute("data-dirty-indicator") === "true" &&
            el.getAttribute("data-dirty-fields-count") === "2",
        ),
      ).not.toBeNull();

      // Click another object on the 3D Viewport canvas while viewing 3D View tab!
      await act(async () => {
        kernel.selection.set(OTHER_OBJECT_SELECTION, "viewport-3d");
      });

      // Guard intercepts navigation, restores right-rail tab back to "selection", and opens AlertDialog!
      expect(kernel.selection.get().objectId).toBe("film");
      expect(currentContext).toBe("selection");

      const alertModal = findElement(
        container,
        (el) => el.getAttribute("role") === "alertdialog",
      );
      expect(alertModal).not.toBeNull();
      expect(alertModal!.textContent).toContain("Permalloy film");
      expect(alertModal!.textContent).toContain("Saturation magnetization (Ms)");
      expect(alertModal!.textContent).toContain("Gilbert damping (alpha)");

      const buttons = findElements(
        alertModal!,
        (el) => el.tagName === "BUTTON",
      ).map((btn) => btn.textContent.trim());
      expect(buttons).toEqual([
        "Keep editing",
        "Discard 2 changes",
        "Apply and continue",
      ]);

      // 1) Keep editing keeps the selection on "film" and preserves the draft.
      const keepEditingBtn = findElement(
        alertModal!,
        (el) => el.tagName === "BUTTON" && el.textContent.trim() === "Keep editing",
      )!;
      await act(async () => {
        keepEditingBtn.click();
      });
      expect(
        findElements(container, (el) => el.getAttribute("role") === "alertdialog"),
      ).toHaveLength(0);
      expect(kernel.selection.get().objectId).toBe("film");
      expect(msInput.value).toBe("840");

      // 2) Switch to 3D View again, trigger tree selection, and choose "Apply and continue".
      await act(async () => {
        setViewport3DInspectorContext("view");
      });
      await act(async () => {
        kernel.selection.set(OTHER_OBJECT_SELECTION, "explorer");
      });
      expect(currentContext).toBe("selection");
      const applyContinueBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.trim() === "Apply and continue",
      );
      await act(async () => {
        applyContinueBtn.click();
      });
      expect(applySpy).toHaveBeenCalledOnce();
      expect(kernel.selection.get().objectId).toBe("waveguide");

      // 3) Return to film, dirty again, switch to 3D Export, trigger selection, and choose "Discard 1 change".
      await act(async () => {
        kernel.selection.set(FILM_SELECTION, "explorer");
      });
      const msInputAgain = findElement(
        container,
        (el) => el.getAttribute("aria-label") === "Ms",
      );
      await act(async () => {
        msInputAgain.value = "900";
        msInputAgain.dispatchEvent(new TestEvent("input", { bubbles: true }));
      });
      await act(async () => {
        setViewport3DInspectorContext("export");
      });
      expect(currentContext).toBe("export");
      await act(async () => {
        kernel.selection.set(OTHER_OBJECT_SELECTION, "viewport-3d");
      });
      expect(currentContext).toBe("selection");
      const discardBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.trim() === "Discard 1 change",
      );
      await act(async () => {
        discardBtn.click();
      });
      expect(kernel.selection.get().objectId).toBe("waveguide");
      expect(applySpy).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      if (hadScrollTo) proto.scrollTo = prevScrollTo;
      else delete proto.scrollTo;
      dom.restore();
    }
  });
});
