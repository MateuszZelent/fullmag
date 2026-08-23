import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MODEL_SCENE_PATH, SESSIONS_PATH, SESSION_CURRENT_PATH } from "../api/apiPaths";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { KernelContext } from "../KernelContext";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";
import type { KernelApi } from "../types";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  TestEvent,
  type TestElement,
} from "./simulationPreparationTestDom.test-support";

import { NewProblemDialog } from "./NewProblemDialog";

vi.mock("@/shared/ui/Dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogClose: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children, ...props }: ComponentProps<"section">) => (
    <section {...props}>{children}</section>
  ),
  DialogDescription: (props: ComponentProps<"p">) => <p {...props} />,
  DialogFooter: (props: ComponentProps<"footer">) => <footer {...props} />,
  DialogHeader: (props: ComponentProps<"header">) => <header {...props} />,
  DialogTitle: (props: ComponentProps<"h2">) => <h2 {...props} />,
}));

afterEach(() => vi.restoreAllMocks());

describe("NewProblemDialog", () => {
  it("submits the default FDM CPU/double request and closes only after ACK", async () => {
    const request = deferred<CreateResponse>();
    const create = vi.fn(() => request.promise);
    const { body, invalidations, onOpenChange, dispose } = await mountDialog({ create });

    try {
      await act(async () => findButton(body, "Create").click());

      expect(create).toHaveBeenCalledWith({
        backend: "fdm",
        device: "cpu",
        name: "Untitled problem",
        precision: "double",
        replace_current: false,
      });
      expect(onOpenChange).not.toHaveBeenCalledWith(false);

      await act(async () => {
        request.resolve(createResponse(7));
        await request.promise;
      });

      expect(invalidations.invalidate.mock.calls).toEqual([
        [SESSIONS_PATH, 7],
        [SESSION_STATUS_RESOURCE_KEY, 7],
        [MODEL_SCENE_PATH, 7],
      ]);
      expect(invalidations.invalidatePrefix).toHaveBeenCalledWith(
        SESSION_CURRENT_PATH,
        7,
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      await dispose();
    }
  });

  it("submits FEM only with the fixed CPU/double execution", async () => {
    const create = vi.fn(async () => createResponse(3));
    const { body, dispose } = await mountDialog({ create });

    try {
      await act(async () => findRadio(body, "FEM").click());
      await act(async () => findButton(body, "Create").click());
      await settle();

      expect(create).toHaveBeenCalledWith({
        backend: "fem",
        device: "cpu",
        name: "Untitled problem",
        precision: "double",
        replace_current: false,
      });
    } finally {
      await dispose();
    }
  });

  it("keeps the selected form open after a capability error", async () => {
    const create = vi.fn(async () => {
      throw new Error("FEM CPU is unavailable in this runtime");
    });
    const { body, onOpenChange, dispose } = await mountDialog({ create });

    try {
      await act(async () => findRadio(body, "FEM").click());
      await act(async () => findButton(body, "Create").click());
      await settle();

      expect(body.textContent).toContain("FEM CPU is unavailable in this runtime");
      expect(findRadio(body, "FEM").getAttribute("aria-checked")).toBe("true");
      expect(findButton(body, "Create").disabled).toBe(false);
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
    } finally {
      await dispose();
    }
  });

  it("requires explicit shared-checkbox confirmation before replacement", async () => {
    const create = vi.fn(async () => createResponse(9));
    const { body, dispose } = await mountDialog({ create, hasActiveSession: true });

    try {
      const createButton = findButton(body, "Create");
      const checkbox = findElements(
        body,
        (element) => element.tagName === "INPUT",
      ).at(-1)!;
      expect(checkbox).toBeTruthy();
      expect(createButton.disabled).toBe(true);

      Object.assign(checkbox!, { checked: true });
      await act(async () => {
        checkbox!.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      expect(createButton.disabled).toBe(false);

      await act(async () => createButton.click());
      await settle();
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        replace_current: true,
      }));
    } finally {
      await dispose();
    }
  });

  it("renders name and replacement confirmation through shared primitives", async () => {
    const { body, dispose } = await mountDialog({
      create: async () => createResponse(1),
      hasActiveSession: true,
    });

    try {
      expect(findBySlot(body, "input")).toBeTruthy();
      expect(findBySlot(body, "checkbox")).toBeTruthy();
    } finally {
      await dispose();
    }
  });
});

interface CreateResponse {
  revisions: { scene_revision: number; state_version: number };
  scene_document: {
    objects: never[];
    revision: number;
    scene: null;
    schema_version: "0.3";
    version: null;
  };
  session_id: string;
  status: {
    effective_execution: { backend: "fdm"; device: "cpu"; precision: "double" };
    fallback: null;
    requested_execution: { backend: "fdm"; device: "cpu"; precision: "double" };
  };
}

function createResponse(revision: number): CreateResponse {
  const execution = { backend: "fdm", device: "cpu", precision: "double" } as const;
  return {
    revisions: { scene_revision: revision, state_version: revision },
    scene_document: {
      objects: [],
      revision,
      scene: null,
      schema_version: "0.3",
      version: null,
    },
    session_id: "scratch-session",
    status: {
      effective_execution: execution,
      fallback: null,
      requested_execution: execution,
    },
  };
}

async function mountDialog({
  create,
  hasActiveSession = false,
}: {
  create: (input: unknown) => Promise<CreateResponse>;
  hasActiveSession?: boolean;
}) {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const bus = new EventBus<KernelEventMap>();
  const invalidations = {
    invalidate: vi.fn(),
    invalidatePrefix: vi.fn(),
  };
  const kernel = {
    api: { sessions: { create } },
    bus,
    resources: invalidations,
  } as unknown as KernelApi;
  const onOpenChange = vi.fn();
  await act(async () => {
    root.render(
      <KernelContext.Provider value={kernel}>
        <NewProblemDialog
          hasActiveSession={hasActiveSession}
          open
          onOpenChange={onOpenChange}
        />
      </KernelContext.Provider>,
    );
  });
  await settle();
  return {
    body: dom.document.body,
    invalidations,
    onOpenChange,
    dispose: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
}

function findButton(body: TestElement, name: string): TestElement {
  return findElement(
    body,
    (element) => element.tagName === "BUTTON" && element.textContent.trim() === name,
    `${name} button`,
  );
}

function findRadio(body: TestElement, name: string): TestElement {
  return findElement(
    body,
    (element) => element.getAttribute("role") === "radio" && element.textContent.trim() === name,
    `${name} radio`,
  );
}

function findBySlot(body: TestElement, slot: string): TestElement | null {
  return findElements(body, (element) => element.getAttribute("data-slot") === slot)[0] ?? null;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
