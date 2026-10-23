import { act, useLayoutEffect, useRef, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
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
import { PlanarNumberField } from "./PlanarNumberField";
import {
  PlanarPresentationDraftOwner,
  PlanarPresentationFieldContext,
} from "./PlanarPresentationDraftOwner";

describe("PlanarPresentationDraftOwner", () => {
  it("keeps blank and sign-only raw input when the 2D field unmounts and remounts", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const sessions = createInspectorEditSessionStore();
    const onCommit = vi.fn();
    const render = (showField: boolean) => (
      <OwnerFixture
        contextKey="default-source"
        identityKey="object-a"
        onCommit={onCommit}
        sessions={sessions}
        showField={showField}
        value={1}
      />
    );

    try {
      await act(async () => root.render(render(true)));
      const initial = findInput(container, "Raster opacity");

      await act(async () => editInput(initial, ""));
      expect(findInput(container, "Raster opacity").value).toBe("");

      await act(async () => root.render(render(false)));
      await act(async () => root.render(render(true)));
      expect(findInput(container, "Raster opacity").value).toBe("");

      await act(async () => editInput(findInput(container, "Raster opacity"), "-"));
      await act(async () => root.render(render(false)));
      await act(async () => root.render(render(true)));

      expect(findInput(container, "Raster opacity").value).toBe("-");
      expect(onCommit).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("isolates raw input by source context and global reset clears the parked draft", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const sessions = createInspectorEditSessionStore();
    const onCommit = vi.fn();
    const render = (contextKey: string, value: number) => (
      <OwnerFixture
        contextKey={contextKey}
        identityKey="object-a"
        onCommit={onCommit}
        sessions={sessions}
        value={value}
      />
    );

    try {
      await act(async () => root.render(render("default-source", 1)));
      await act(async () => editInput(findInput(container, "Raster opacity"), ""));

      await act(async () => root.render(render("monitor:source-b", 2)));
      expect(findInput(container, "Raster opacity").value).toBe("2");
      expect(onCommit).not.toHaveBeenCalled();

      await act(async () => root.render(render("default-source", 1)));
      expect(findInput(container, "Raster opacity").value).toBe("");

      await act(async () => root.render(render("monitor:source-b", 2)));
      await act(async () => {
        await sessions.getCurrentSession()!.reset();
      });
      await act(async () => root.render(render("default-source", 1)));

      expect(findInput(container, "Raster opacity").value).toBe("1");
      expect(sessions.getCurrentSession()?.dirty).toBe(false);
      expect(onCommit).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("clears raw input when the inspected identity changes without committing it", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const sessions = createInspectorEditSessionStore();
    const onCommit = vi.fn();
    const render = (identityKey: string, value: number) => (
      <OwnerFixture
        contextKey="default-source"
        identityKey={identityKey}
        onCommit={onCommit}
        sessions={sessions}
        value={value}
      />
    );

    try {
      await act(async () => root.render(render("object-a", 1)));
      await act(async () => editInput(findInput(container, "Raster opacity"), "-"));
      expect(findInput(container, "Raster opacity").value).toBe("-");

      await act(async () => root.render(render("object-b", 2)));

      expect(findInput(container, "Raster opacity").value).toBe("2");
      expect(sessions.getCurrentSession()?.dirty).toBe(false);
      expect(onCommit).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("delegates one mutation-owned apply and acknowledges the global facade synchronously", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const sessions = createInspectorEditSessionStore();
    const historyRecord = vi.fn();
    const sceneRead = vi.fn(async () => ({ objects: [], revision: 1, scene_revision: 1 }));
    const kernel = testKernel(sceneRead, historyRecord);
    const childApply = vi.fn(async () => {
      historyRecord();
      return true;
    });

    try {
      await act(async () => root.render(
        <KernelContext.Provider value={kernel}>
          <OwnerFixture
            child={<DirtySessionChild onApply={childApply} />}
            contextKey="default-source"
            identityKey="object-a"
            onCommit={vi.fn()}
            sessions={sessions}
            showField={false}
            value={1}
          />
        </KernelContext.Provider>,
      ));

      const facade = sessions.getCurrentSession();
      expect(facade?.dirty).toBe(true);
      expect(facade?.mode).toBe("staged");

      let applied = false;
      await act(async () => {
        applied = await facade!.apply();
        expect(applied).toBe(true);
        expect(facade!.dirty).toBe(false);
      });

      expect(childApply).toHaveBeenCalledOnce();
      expect(historyRecord).toHaveBeenCalledOnce();
      expect(sceneRead).not.toHaveBeenCalled();
      expect(sessions.getCurrentSession()?.dirty).toBe(false);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not let a late child acknowledgement clear a newer raw edit", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const sessions = createInspectorEditSessionStore();
    const historyRecord = vi.fn();
    const sceneRead = vi.fn();
    const completion = deferred<boolean>();
    const childApply = vi.fn(() => completion.promise.then((applied) => {
      if (applied) historyRecord();
      return applied;
    }));
    const onCommit = vi.fn();

    try {
      await act(async () => root.render(
        <KernelContext.Provider value={testKernel(sceneRead, historyRecord)}>
          <OwnerFixture
            child={<DirtySessionChild onApply={childApply} />}
            contextKey="default-source"
            identityKey="object-a"
            onCommit={onCommit}
            sessions={sessions}
            value={1}
          />
        </KernelContext.Provider>,
      ));

      const facade = sessions.getCurrentSession()!;
      let applyResult: boolean | undefined;
      let applying!: Promise<boolean>;
      await act(async () => {
        applying = facade.apply();
        await Promise.resolve();
      });
      expect(childApply).toHaveBeenCalledOnce();

      await act(async () => {
        editInput(findInput(container, "Raster opacity"), "2");
        completion.resolve(true);
        applyResult = await applying;
      });

      expect(applyResult).toBe(false);
      expect(findInput(container, "Raster opacity").value).toBe("2");
      expect(facade.dirty).toBe(true);
      expect(historyRecord).toHaveBeenCalledOnce();
      expect(sceneRead).not.toHaveBeenCalled();
      expect(onCommit).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not accept a late child acknowledgement after the owner retargets", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const sessions = createInspectorEditSessionStore();
    const completion = deferred<boolean>();
    const oldTargetApply = vi.fn(() => completion.promise);
    const newTargetApply = vi.fn(async () => true);
    const kernel = testKernel(vi.fn(), vi.fn());
    const render = (identityKey: string) => (
      <KernelContext.Provider value={kernel}>
        <OwnerFixture
          child={<DirtySessionChild key={identityKey} onApply={identityKey === "object-a" ? oldTargetApply : newTargetApply} />}
          contextKey="default-source"
          identityKey={identityKey}
          onCommit={vi.fn()}
          sessions={sessions}
          showField={false}
          value={1}
        />
      </KernelContext.Provider>
    );

    try {
      await act(async () => root.render(render("object-a")));
      const facade = sessions.getCurrentSession()!;
      let applyResult: boolean | undefined;
      let applying!: Promise<boolean>;
      await act(async () => {
        applying = facade.apply();
        await Promise.resolve();
      });
      expect(oldTargetApply).toHaveBeenCalledOnce();

      await act(async () => root.render(render("object-b")));
      expect(sessions.getCurrentSession()?.dirty).toBe(true);

      await act(async () => {
        completion.resolve(true);
        applyResult = await applying;
      });

      expect(applyResult).toBe(false);
      expect(sessions.getCurrentSession()?.dirty).toBe(true);
      expect(oldTargetApply).toHaveBeenCalledOnce();
      expect(newTargetApply).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function OwnerFixture({
  child = <CleanSessionChild />,
  contextKey,
  identityKey,
  onCommit,
  sessions,
  showField = true,
  value,
}: {
  child?: ReactNode;
  contextKey: string;
  identityKey: string;
  onCommit: (value: number) => void;
  sessions: ReturnType<typeof createInspectorEditSessionStore>;
  showField?: boolean;
  value: number;
}) {
  return (
    <InspectorEditSessionProvider store={sessions}>
      <PlanarPresentationDraftOwner identityKey={identityKey}>
        {child}
        {showField ? (
          <PlanarPresentationFieldContext contextKey={contextKey}>
            <PlanarNumberField
              label="Raster opacity"
              onCommit={onCommit}
              path="raster_opacity"
              value={value}
            />
          </PlanarPresentationFieldContext>
        ) : <p>3D view</p>}
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

function DirtySessionChild({ onApply }: { onApply: () => Promise<boolean> }) {
  const acknowledgeRef = useRef<(() => boolean) | null>(null);
  const apply = async () => {
    const applied = await onApply();
    if (applied) acknowledgeRef.current?.();
    return applied;
  };
  const acknowledge = useRegisterInspectorEditSession(
    "staged",
    false,
    true,
    true,
    undefined,
    apply,
    () => undefined,
    { historyMode: "mutation-owned" },
  );
  useLayoutEffect(() => { acknowledgeRef.current = acknowledge; }, [acknowledge]);
  return null;
}

function testKernel(sceneRead: ReturnType<typeof vi.fn>, historyRecord: ReturnType<typeof vi.fn>): KernelApi {
  return {
    api: { model: { scene: sceneRead } },
    authoringHistory: { getGeneration: () => 3, record: historyRecord },
    commands: { getSessionScopeKey: () => "session=A&epoch=1" },
  } as unknown as KernelApi;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
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

function findInput(root: TestNode, label: string): TestElement {
  const input = findElements(
    root,
    (element) => element.tagName === "INPUT" && element.getAttribute("aria-label") === label,
  )[0];
  if (!input) throw new Error(`Missing input ${label}`);
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
