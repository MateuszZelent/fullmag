import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import {
  createInspectorEditSessionStore,
  InspectorEditSessionProvider,
  useRegisterInspectorEditSession,
} from "../InspectorEditSession";
import {
  PlanarPresentationDraftOwner,
  PlanarPresentationFieldContext,
} from "./PlanarPresentationDraftOwner";
import { PlanarManualRangeFields } from "./PlanarManualRangeFields";

describe("PlanarManualRangeFields", () => {
  it("keeps an invalid pair raw and commits both limits when the pair becomes valid", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const sessions = createInspectorEditSessionStore();
    const onCommit = vi.fn();

    try {
      await act(async () => root.render(
        <ManualRangeFixture
          maximum={1}
          minimum={0}
          onCommit={onCommit}
          sessions={sessions}
        />,
      ));

      await act(async () => editInput(findInput(container, "Range minimum"), "5"));
      expect(findInput(container, "Range minimum").value).toBe("5");
      expect(findInput(container, "Range maximum").value).toBe("1");
      expect(sessions.getCurrentSession()?.dirty).toBe(true);
      expect(onCommit).not.toHaveBeenCalled();

      await act(async () => editInput(findInput(container, "Range maximum"), "10"));
      expect(onCommit).not.toHaveBeenCalled();
      await act(async () => blurInput(findInput(container, "Range maximum")));

      expect(onCommit).toHaveBeenCalledOnce();
      expect(onCommit).toHaveBeenCalledWith({ mode: "manual", min: 5, max: 10 });
      expect(sessions.getCurrentSession()?.dirty).toBe(false);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it.each(["", "-"])("blocks the pair commit while the other limit is %j", async (minimumDraft) => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const sessions = createInspectorEditSessionStore();
    const onCommit = vi.fn();

    try {
      await act(async () => root.render(
        <ManualRangeFixture
          maximum={1}
          minimum={0}
          onCommit={onCommit}
          sessions={sessions}
        />,
      ));

      await act(async () => editInput(findInput(container, "Range minimum"), minimumDraft));
      await act(async () => editInput(findInput(container, "Range maximum"), "10"));
      await act(async () => blurInput(findInput(container, "Range maximum")));

      expect(findInput(container, "Range minimum").value).toBe(minimumDraft);
      expect(findInput(container, "Range maximum").value).toBe("10");
      expect(sessions.getCurrentSession()?.dirty).toBe(true);
      expect(onCommit).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("retains field drafts through a remount and clears them on global reset", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const sessions = createInspectorEditSessionStore();
    const onCommit = vi.fn();
    const render = (showFields: boolean) => (
      <ManualRangeFixture
        maximum={10}
        minimum={0}
        onCommit={onCommit}
        sessions={sessions}
        showFields={showFields}
      />
    );

    try {
      await act(async () => root.render(render(true)));
      await act(async () => editInput(findInput(container, "Range minimum"), "5"));
      await act(async () => root.render(render(false)));
      await act(async () => root.render(render(true)));

      expect(findInput(container, "Range minimum").value).toBe("5");
      expect(findInput(container, "Range maximum").value).toBe("10");
      expect(onCommit).not.toHaveBeenCalled();

      await act(async () => {
        await sessions.getCurrentSession()!.reset();
      });

      expect(findInput(container, "Range minimum").value).toBe("0");
      expect(findInput(container, "Range maximum").value).toBe("10");
      expect(sessions.getCurrentSession()?.dirty).toBe(false);
      expect(onCommit).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function ManualRangeFixture({
  maximum,
  minimum,
  onCommit,
  sessions,
  showFields = true,
}: {
  maximum: number;
  minimum: number;
  onCommit: (range: { mode: "manual"; min: number; max: number }) => void;
  sessions: ReturnType<typeof createInspectorEditSessionStore>;
  showFields?: boolean;
}) {
  return (
    <InspectorEditSessionProvider store={sessions}>
      <PlanarPresentationDraftOwner identityKey="monitor-a">
        <CleanSessionChild />
        <PlanarPresentationFieldContext contextKey="default-source">
          {showFields ? (
            <PlanarManualRangeFields
              maximum={maximum}
              minimum={minimum}
              onCommit={onCommit}
            />
          ) : <p>3D view</p>}
        </PlanarPresentationFieldContext>
      </PlanarPresentationDraftOwner>
    </InspectorEditSessionProvider>
  );
}

function CleanSessionChild() {
  useRegisterInspectorEditSession(
    "staged",
    false,
    false,
    true,
    undefined,
    () => true,
    () => undefined,
    { historyMode: "mutation-owned" },
  );
  return null;
}

function editInput(input: TestElement, value: string): void {
  const tracker = (input as TestElement & {
    _valueTracker?: { setValue: (next: string) => void };
  })._valueTracker;
  const previous = input.value;
  input.value = value;
  tracker?.setValue(previous);
  input.dispatchEvent(new TestEvent("input", { bubbles: true }));
}

function blurInput(input: TestElement): void {
  input.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
}

function findInput(root: TestNode, label: string): TestElement {
  const input = findElements(
    root,
    (element) => element.tagName === "INPUT" && element.getAttribute("aria-label") === label,
  )[0];
  if (!input) throw new Error("Missing input: " + label);
  return input;
}

function findElements(root: TestNode, predicate: (element: TestElement) => boolean): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode) => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}
