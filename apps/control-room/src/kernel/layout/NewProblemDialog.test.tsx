import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
  SESSIONS_PATH,
  SESSION_CURRENT_PATH,
  PLATFORM_OUTPUT_STORAGE_PATH,
} from "../api/apiPaths";
import { PendingFormRegistry } from "../authoring/PendingFormRegistry";
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

import { cancelDomainSetupNavigation, pendingDomainSetupNavigation } from "./domainSetupNavigation";
import { NewProblemDialog } from "./NewProblemDialog";

const sessionReadbackState = vi.hoisted(() => ({
  identity: null as {
    requestScopeEpoch: string;
    sessionEpoch: string;
    sessionId: string;
  } | null,
  sessions: null as {
    schema_version: string;
    sessions: Array<{
      current: boolean;
      name: string;
      session_id: string;
      status: string;
    }>;
  } | null,
}));

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

vi.mock("../resources/useOutputStorageDefaults", () => ({
  useOutputStorageDefaults: () => ({
    data: { output_parent: "C:/simulations", temp_parent: "C:/simulations/.fullmag-tmp",
      data_format: "zarr", cleanup: "on_success", existing_output: "timestamp",
      supported_formats: ["zarr"], hdf5_unavailable_reason: "HDF5 unavailable in this runtime" },
    status: "ready", error: null, refetch: vi.fn(), revision: null,
  }),
}));

vi.mock("../resources/useSessionStatus", () => ({
  SESSION_STATUS_RESOURCE_KEY: "session:status",
  useSessionResourceIdentity: () => sessionReadbackState.identity,
}));

vi.mock("../resources/useSessionCollection", () => ({
  useSessionCollection: () => ({
    resource: {
      data: sessionReadbackState.sessions,
      error: null,
      refetch: vi.fn(),
      revision: null,
      status: sessionReadbackState.sessions ? "ready" : "loading",
    },
    state: sessionReadbackState.sessions ? "ready" : "loading",
  }),
}));

vi.mock("@/shared/ui/Select", () => ({
  Select: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectTrigger: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  SelectValue: () => null,
  SelectContent: () => null,
  SelectItem: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

afterEach(() => {
  vi.restoreAllMocks();
  sessionReadbackState.identity = null;
  sessionReadbackState.sessions = null;
});

describe("NewProblemDialog", () => {
  it("explains FEM domain setup and per-run device selection", async () => {
    const create = vi.fn(async () => createResponse(3));
    const { body, dispose } = await mountDialog({ create });

    try {
      await act(async () => findRadio(body, "FEM").click());

      expect(body.textContent).toContain(
        "Preparation preview · CPU · Double precision",
      );
      expect(body.textContent).toContain(
        "Configure Universe domain policy now or later; automatic bounds are derived after geometry is added.",
      );
      expect(body.textContent).toContain("Configure now opens the existing Universe Inspector after this simulation is created.");
      expect(body.textContent).toContain(
        "CPU and double precision are preparation defaults. Choose the device per run in Study > Execution.",
      );
    } finally {
      await dispose();
    }
  });

  it("offers FDM domain/grid setup now or later", async () => {
    const create = vi.fn(async () => createResponse(3));
    const { body, dispose } = await mountDialog({ create });

    try {
      expect(body.textContent).toContain(
        "Configure Universe bounds and grid settings now or later; automatic bounds are derived after geometry is added.",
      );
      expect(findRadio(body, "Configure later").getAttribute("aria-checked")).toBe("true");
      expect(findRadio(body, "Configure now").getAttribute("aria-checked")).toBe("false");
    } finally {
      await dispose();
    }
  });

  it("records the Universe navigation at ACK only when Configure now is selected", async () => {
    // The session connectors apply the request; the dialog itself may be
    // remounted while the workspace shell changes, so it never selects.
    const create = vi.fn(async () => createResponse(3));
    const { body, layout, selection, dispose } = await mountDialog({ create });
    cancelDomainSetupNavigation();

    try {
      await act(async () => findRadio(body, "Configure now").click());
      await act(async () => submitDialog(body));
      await settle();

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ backend: "fdm" }));
      expect(pendingDomainSetupNavigation()).toBe("scratch-session");
      expect(layout.setPanelVisible).not.toHaveBeenCalled();
      expect(selection.set).not.toHaveBeenCalled();
    } finally {
      cancelDomainSetupNavigation();
      await dispose();
    }
  });

  it("does not record the Universe navigation when setup is left for later", async () => {
    const create = vi.fn(async () => createResponse(3));
    const { body, dispose } = await mountDialog({ create });
    cancelDomainSetupNavigation();

    try {
      await act(async () => submitDialog(body));
      await settle();

      expect(create).toHaveBeenCalled();
      expect(pendingDomainSetupNavigation()).toBeNull();
    } finally {
      await dispose();
    }
  });

  it("submits the default FDM CPU/double request and closes only after ACK", async () => {
    const request = deferred<CreateResponse>();
    const create = vi.fn(() => request.promise);
    const { body, invalidations, onOpenChange, dispose } = await mountDialog({ create });

    try {
      await act(async () => submitDialog(body));

      expect(create).toHaveBeenCalledWith({
        backend: "fdm",
        device: "cpu",
        name: expect.stringMatching(/^Simulation /),
        output_storage: expect.objectContaining({
          output_dir: expect.stringMatching(/^C:\/simulations\/simulation_.*\/results\.zarr$/),
          temp_dir: "C:/simulations/.fullmag-tmp", data_format: "zarr", cleanup: "on_success", existing_output: "timestamp",
        }),
        precision: "double",
        replace_current: false,
      });
      expect(onOpenChange).not.toHaveBeenCalledWith(false);

      await act(async () => {
        request.resolve(createResponse(7));
        await request.promise;
      });

      expect(invalidations.invalidate.mock.calls).toEqual([
        [SESSIONS_PATH, "session:scratch-session"],
        [SESSION_STATUS_RESOURCE_KEY, "session:scratch-session"],
        [MODEL_SCENE_PATH, "session:scratch-session"],
        [MODEL_READINESS_PATH, "session:scratch-session"],
        [PLATFORM_OUTPUT_STORAGE_PATH, "saved:scratch-session"],
      ]);
      expect(invalidations.invalidatePrefix).toHaveBeenCalledWith(
        SESSION_CURRENT_PATH,
        "session:scratch-session",
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
      await act(async () => submitDialog(body));
      await settle();

      expect(create).toHaveBeenCalledWith({
        backend: "fem",
        device: "cpu",
        name: expect.stringMatching(/^Simulation /),
        output_storage: expect.objectContaining({
          output_dir: expect.stringMatching(/^C:\/simulations\/simulation_.*\/results\.zarr$/),
          temp_dir: "C:/simulations/.fullmag-tmp", data_format: "zarr", cleanup: "on_success", existing_output: "timestamp",
        }),
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
      await act(async () => submitDialog(body));
      await settle();

      expect(body.textContent).toContain("FEM CPU is unavailable in this runtime");
      expect(findRadio(body, "FEM").getAttribute("aria-checked")).toBe("true");
      expect(findButton(body, "Create simulation").disabled).toBe(false);
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
    } finally {
      await dispose();
    }
  });

  it("requires explicit shared-checkbox confirmation before replacement", async () => {
    const create = vi.fn(async () => createResponse(9));
    const { body, dispose } = await mountDialog({ create, hasActiveSession: true });

    try {
      const createButton = findButton(body, "Create simulation");
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

      await act(async () => submitDialog(body));
      await settle();
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        replace_current: true,
      }));
    } finally {
      await dispose();
    }
  });

  it("invalidates a replacement by session identity when its state version resets", async () => {
    const create = vi.fn(async () => createResponse(0, "session-fem-replacement"));
    const { body, invalidations, dispose } = await mountDialog({
      create,
      hasActiveSession: true,
    });

    try {
      const checkbox = findElements(
        body,
        (element) => element.tagName === "INPUT",
      ).at(-1)!;
      Object.assign(checkbox!, { checked: true });
      await act(async () => {
        checkbox!.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });

      await act(async () => submitDialog(body));
      await settle();

      expect(invalidations.invalidate).toHaveBeenCalledWith(
        SESSIONS_PATH,
        "session:session-fem-replacement",
      );
      expect(invalidations.invalidate).toHaveBeenCalledWith(
        SESSION_STATUS_RESOURCE_KEY,
        "session:session-fem-replacement",
      );
      expect(invalidations.invalidatePrefix).toHaveBeenCalledWith(
        SESSION_CURRENT_PATH,
        "session:session-fem-replacement",
      );
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

function createResponse(
  revision: number,
  sessionId = "scratch-session",
): CreateResponse {
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
    session_id: sessionId,
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
  const layout = { setPanelVisible: vi.fn() };
  const selection = { set: vi.fn() };
  const kernel = {
    api: { sessions: { create }, platform: { saveOutputStorageDefaults: vi.fn(async () => ({})) } },
    bus,
    layout,
    // Creation goes through the pending-form guard, which needs the real registry.
    pendingForms: new PendingFormRegistry(),
    resources: invalidations,
    selection,
  } as unknown as KernelApi;
  const onOpenChange = vi.fn();
  const renderDialog = () => (
    <KernelContext.Provider value={kernel}>
      <NewProblemDialog
        hasActiveSession={hasActiveSession}
        open
        onOpenChange={onOpenChange}
      />
    </KernelContext.Provider>
  );
  await act(async () => {
    root.render(renderDialog());
  });
  await settle();
  return {
    body: dom.document.body,
    invalidations,
    layout,
    onOpenChange,
    selection,
    rerender: async () => {
      await act(async () => root.render(renderDialog()));
    },
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

function submitDialog(body: TestElement): void {
  const form = findElement(body, (element) => element.tagName === "FORM", "simulation form");
  form.dispatchEvent(new TestEvent("submit", { bubbles: true }));
}
