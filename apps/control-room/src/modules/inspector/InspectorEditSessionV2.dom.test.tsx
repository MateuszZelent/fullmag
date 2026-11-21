import { Atom, Layers, SlidersHorizontal } from "lucide-react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import {
  findElement,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Input } from "@/shared/ui/Input";

import {
  createInspectorEditSessionStore,
  formatInspectorSessionKey,
  InspectorEditSessionProvider,
  useInspectorEditSessionV2Controller,
  useRegisterInspectorEditSessionV2,
  type InspectorEditSessionV2,
} from "./InspectorEditSession";
import {
  resetPersistedInspectorModeTabs,
  useInspectorSpecController,
  type InspectorSpec,
} from "./template";

interface MaterialDraftFixture extends Record<string, unknown> {
  ms: number;
  alpha: number;
  aex: number;
}

function RebaseHarness({
  baseline,
  modeTabId = "core",
  onApply,
  selectionKey = "object:film",
  serverFieldErrors,
}: {
  baseline: MaterialDraftFixture;
  modeTabId?: string;
  onApply?: (draft: MaterialDraftFixture, baseline: MaterialDraftFixture) => Promise<boolean>;
  selectionKey?: string;
  serverFieldErrors?: Partial<Record<keyof MaterialDraftFixture & string, string | null>>;
}) {
  const controller = useInspectorEditSessionV2Controller<MaterialDraftFixture>({
    baseline,
    fieldLabels: {
      aex: "Exchange stiffness (Aex)",
      alpha: "Gilbert damping (alpha)",
      ms: "Saturation magnetization (Ms)",
    },
    mode: "staged",
    modeTabId,
    nodeTitle: "Permalloy film",
    onApply: onApply ?? (async () => true),
    selectionKey,
    serverFieldErrors,
    specId: "object.material",
  });

  return (
    <div
      className="fm-inspector__body"
      data-animation-key={controller.animationKey}
      data-session-status={controller.status}
    >
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
      <output data-slot="dirty-fields">
        {[...controller.dirtyFields].join(",")}
      </output>
      <output data-slot="invalid-ms">
        {controller.invalidFields.get("ms") ?? ""}
      </output>
      <button type="button" onClick={() => controller.revertField("ms")}>
        Revert Ms
      </button>
      <button type="button" onClick={() => void controller.apply()}>
        Apply
      </button>
    </div>
  );
}

function LiveViewportSibling({ selectionKey }: { selectionKey: string }) {
  const session: InspectorEditSessionV2 = {
    apply: async () => false,
    applyBlockReason: null,
    applying: false,
    dirty: false,
    dirtyFieldLabels: [],
    dirtyFields: new Set(),
    focusField: () => undefined,
    invalidFields: new Map(),
    lockReason: null,
    mode: "liveViewport",
    nodeTitle: "Midplane",
    revertAll: () => undefined,
    revertField: () => undefined,
    sessionKey: formatInspectorSessionKey(selectionKey, "model.planar.monitor", "2d-display"),
    valid: true,
  };
  useRegisterInspectorEditSessionV2(session);
  return <div data-live-section="true">Live display controls</div>;
}

describe("InspectorEditSessionV2", () => {
  it("rebases_clean_fields_on_incoming_revision_while_preserving_dirty_fields_focus_and_scroll", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const store = createInspectorEditSessionStore();

    try {
      await act(async () => {
        root.render(
          <InspectorEditSessionProvider store={store}>
            <RebaseHarness
              baseline={{ aex: 13e-12, alpha: 0.008, ms: 800 }}
            />
          </InspectorEditSessionProvider>,
        );
      });

      const bodyBefore = findElement(
        container,
        (el) => el.className === "fm-inspector__body",
      );
      const msInputBefore = findElement(
        container,
        (el) => el.getAttribute("aria-label") === "Ms",
      );
      const alphaInputBefore = findElement(
        container,
        (el) => el.getAttribute("aria-label") === "Alpha",
      );
      expect(bodyBefore).toBeInstanceOf(TestElement);
      expect(msInputBefore).toBeInstanceOf(TestElement);
      expect(alphaInputBefore).toBeInstanceOf(TestElement);

      const initialAnimationKey = bodyBefore!.getAttribute("data-animation-key");

      // Focus Ms, edit it to 820 (dirtyFields = {"ms"}), and scroll body to 180px.
      msInputBefore!.focus();
      expect(dom.document.activeElement).toBe(msInputBefore);

      await act(async () => {
        msInputBefore!.value = "820";
        msInputBefore!.dispatchEvent(new TestEvent("input", { bubbles: true }));
      });
      (bodyBefore as unknown as { scrollTop: number }).scrollTop = 180;

      expect(store.hasAnyStagedDirtySession()).toBe(true);
      expect(store.getActiveStagedDirtySummaries()).toEqual([
        {
          dirtyFieldLabels: ["Saturation magnetization (Ms)"],
          nodeTitle: "Permalloy film",
          sessionKey: "object:film::object.material::core",
        },
      ]);

      // Incoming WebSocket / polling revision updates clean `alpha: 0.012`, while `ms` baseline stays 800.
      await act(async () => {
        root.render(
          <InspectorEditSessionProvider store={store}>
            <RebaseHarness
              baseline={{ aex: 13e-12, alpha: 0.012, ms: 800 }}
            />
          </InspectorEditSessionProvider>,
        );
      });

      const bodyAfter = findElement(
        container,
        (el) => el.className === "fm-inspector__body",
      );
      const msInputAfter = findElement(
        container,
        (el) => el.getAttribute("aria-label") === "Ms",
      );
      const alphaInputAfter = findElement(
        container,
        (el) => el.getAttribute("aria-label") === "Alpha",
      );

      expect(alphaInputAfter?.value).toBe("0.012");
      expect(msInputAfter?.value).toBe("820");
      expect(msInputAfter).toBe(msInputBefore);
      expect(dom.document.activeElement).toBe(msInputBefore);
      expect((bodyAfter as unknown as { scrollTop: number }).scrollTop).toBe(180);
      expect(bodyAfter?.getAttribute("data-animation-key")).toBe(initialAnimationKey);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("isolates staged dirty sessions per sessionKey when live sections or liveViewport modeTabs mount", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const store = createInspectorEditSessionStore();

    function DualModeHarness() {
      const [tab, setTab] = useState<"definition" | "2d-display">("definition");
      const controller = useInspectorEditSessionV2Controller<{ name: string }>({
        baseline: { name: "Midplane" },
        fieldLabels: { name: "Monitor name" },
        mode: tab === "definition" ? "staged" : "liveViewport",
        modeTabId: tab,
        nodeTitle: "Midplane",
        onApply: async () => true,
        selectionKey: "planar:midplane",
        specId: "model.planar.monitor",
      });

      return (
        <div>
          <Input
            aria-label="Monitor name"
            value={controller.draft.name}
            onChange={(event) => {
              controller.setField("name", event.currentTarget.value);
            }}
            onInput={(event) => {
              controller.setField("name", event.currentTarget.value);
            }}
          />
          <button type="button" onClick={() => setTab("2d-display")}>
            Switch to 2D Display
          </button>
          <LiveViewportSibling selectionKey="planar:midplane" />
        </div>
      );
    }

    try {
      await act(async () => {
        root.render(
          <InspectorEditSessionProvider store={store}>
            <DualModeHarness />
          </InspectorEditSessionProvider>,
        );
      });

      const nameInput = findElement(
        container,
        (el) => el.getAttribute("aria-label") === "Monitor name",
      )!;
      await act(async () => {
        nameInput.value = "Midplane Z=0";
        nameInput.dispatchEvent(new TestEvent("input", { bubbles: true }));
      });

      expect(store.hasAnyStagedDirtySession()).toBe(true);

      const switchBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Switch to 2D Display"),
      )!;
      await act(async () => {
        switchBtn.click();
      });

      // Even after switching modeTab to liveViewport and having a live sibling mounted,
      // the unapplied staged draft remains registered and protected!
      expect(store.hasAnyStagedDirtySession()).toBe(true);
      expect(store.getActiveStagedDirtySummaries()).toEqual([
        {
          dirtyFieldLabels: ["Monitor name"],
          nodeTitle: "Midplane",
          sessionKey: "planar:midplane::model.planar.monitor::definition",
        },
      ]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("preserves dirty draft and pins server error on 409 Conflict rejection", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const store = createInspectorEditSessionStore();
    const onApply = vi.fn(async () => false);

    try {
      await act(async () => {
        root.render(
          <InspectorEditSessionProvider store={store}>
            <RebaseHarness
              baseline={{ aex: 13e-12, alpha: 0.008, ms: 800 }}
              onApply={onApply}
            />
          </InspectorEditSessionProvider>,
        );
      });

      const msInput = findElement(
        container,
        (el) => el.getAttribute("aria-label") === "Ms",
      )!;
      await act(async () => {
        msInput.value = "850";
        msInput.dispatchEvent(new TestEvent("input", { bubbles: true }));
      });

      const applyBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.trim() === "Apply",
      )!;
      await act(async () => {
        applyBtn.click();
      });

      await act(async () => {
        root.render(
          <InspectorEditSessionProvider store={store}>
            <RebaseHarness
              baseline={{ aex: 13e-12, alpha: 0.008, ms: 800 }}
              onApply={onApply}
              serverFieldErrors={{ ms: "409 Conflict: scene revision advanced" }}
            />
          </InspectorEditSessionProvider>,
        );
      });

      const body = findElement(
        container,
        (el) => el.className === "fm-inspector__body",
      )!;
      const invalidOut = findElement(
        container,
        (el) => el.getAttribute("data-slot") === "invalid-ms",
      )!;
      expect(msInput.value).toBe("850");
      expect(body.getAttribute("data-session-status")).toBe("ApplyRejected");
      expect(invalidOut.textContent).toBe("409 Conflict: scene revision advanced");
      expect(store.hasAnyStagedDirtySession()).toBe(true);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("registers useInspectorSpecController staged drafts into InspectorEditSessionStore across liveViewport modeTabs", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const store = createInspectorEditSessionStore();
    const selection: Selection = {
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
    const spec: InspectorSpec<{ ms: number; showVectors: boolean }> = {
      commitBar: {
        mode: "staged",
        onApply: async () => true,
      },
      facts: () => [],
      header: { breadcrumbs: [{ id: "film", label: "Permalloy film" }] },
      id: "object.material.spec-session-test",
      identity: {
        domain: "material",
        icon: Atom,
        kindLabel: "Material",
        statePill: () => ({ label: "Committed", tone: "ok" }),
        title: () => "Permalloy film",
      },
      modeTabs: [
        { id: "core", label: "Core" },
        { commitModeOverride: "liveViewport", id: "display", label: "Display" },
      ],
      sections: [
        {
          icon: SlidersHorizontal,
          id: "core",
          modeTabId: "core",
          rows: [
            {
              key: "ms",
              label: "Saturation magnetization (Ms)",
              type: "number",
            },
          ],
          title: "Core",
        },
        {
          icon: Layers,
          id: "display",
          live: true,
          modeTabId: "display",
          rows: [
            {
              key: "showVectors",
              label: "Show vectors",
              type: "switch",
            },
          ],
          title: "Display",
        },
      ],
    };

    function SpecHarness() {
      const ctrl = useInspectorSpecController(spec, selection, {
        ms: 800,
        showVectors: true,
      });
      return (
        <div>
          <Input
            aria-label="Spec Ms"
            value={String(ctrl.draft.ms)}
            onChange={(event) => ctrl.setField("ms", Number(event.currentTarget.value))}
            onInput={(event) => ctrl.setField("ms", Number(event.currentTarget.value))}
          />
          <button
            type="button"
            onClick={() => ctrl.setActiveModeTabId("display")}
          >
            Display tab
          </button>
        </div>
      );
    }

    try {
      resetPersistedInspectorModeTabs();
      await act(async () => {
        root.render(
          <InspectorEditSessionProvider store={store}>
            <SpecHarness />
          </InspectorEditSessionProvider>,
        );
      });

      expect(store.hasAnyStagedDirtySession()).toBe(false);

      const input = findElement(
        container,
        (el) => el.getAttribute("aria-label") === "Spec Ms",
      )!;
      await act(async () => {
        input.value = "860";
        input.dispatchEvent(new TestEvent("input", { bubbles: true }));
      });
      expect(store.hasAnyStagedDirtySession()).toBe(true);
      expect(store.getActiveStagedDirtySummaries()).toEqual([
        {
          dirtyFieldLabels: ["Saturation magnetization (Ms)"],
          nodeTitle: "Permalloy film",
          sessionKey:
            "model:object:film:material::object.material.spec-session-test::core",
        },
      ]);

      // Switch to liveViewport modeTab: staged draft stays protected in the store.
      const displayBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.trim() === "Display tab",
      )!;
      await act(async () => {
        displayBtn.click();
      });
      expect(store.hasAnyStagedDirtySession()).toBe(true);
      expect(store.getStagedDirtyFieldCount()).toBe(1);
    } finally {
      await act(async () => root.unmount());
      resetPersistedInspectorModeTabs();
      dom.restore();
    }
  });
});
