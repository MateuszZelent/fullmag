import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { AntennaObjectPanel } from "./AntennaObjectPanel";

const mocks = vi.hoisted(() => ({
  commitTransaction: vi.fn(),
  invalidate: vi.fn(),
  replaceFieldDrive: vi.fn(),
  refetch: vi.fn(),
  sceneResource: {
    data: {
      field_drives: {
        drives: [
          {
            activation: { kind: "all_time_evolution" },
            amplitude_B_T: 0.001,
            direction: [0, 1, 0],
            enabled: true,
            id: "antenna-drive",
            kind: "regional",
            name: "Antenna drive",
            spatial_profile: { kind: "geometry_mask", object_id: "antenna" },
            target: { kind: "global" },
            time_origin: "stage_local",
            waveform: {
              frequency_hz: 1e9,
              kind: "sinusoidal",
              offset: 0.2,
              phase_rad: 0.7,
            },
          },
        ],
      },
      revision: 12,
    } as unknown,
    error: null as Error | null,
    revision: 12,
    status: "ready" as "idle" | "loading" | "ready" | "stale" | "error",
  },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      model: {
        commitTransaction: mocks.commitTransaction,
        replaceFieldDrive: mocks.replaceFieldDrive,
      },
    },
    resources: { invalidate: mocks.invalidate },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useSceneResource: () => ({ ...mocks.sceneResource, refetch: mocks.refetch }),
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => ({
    sessionId: "antenna-session",
    sessionEpoch: "1",
    requestScopeEpoch: "antenna-request",
  }),
}));

const sessionRequestOptions = {
  sessionScopeKey: "session=antenna-session&epoch=1&request_scope_epoch=antenna-request",
};

const selection: Selection = {
  kind: "object.antenna",
  label: "Antenna",
  moduleSource: "test",
  nodeId: "model:object:antenna:antenna",
  objectId: "antenna",
  ref: {
    kind: "object.antenna",
    nodeId: "model:object:antenna:antenna",
    objectId: "antenna",
    type: "scene-object",
    visualizationTargetId: "object:antenna",
  },
};

describe("AntennaObjectPanel authoring stability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.commitTransaction.mockReset();
    mocks.invalidate.mockReset();
    mocks.replaceFieldDrive.mockReset();
    mocks.refetch.mockReset();
    mocks.sceneResource.data = {
      field_drives: {
        drives: [
          {
            activation: { kind: "all_time_evolution" },
            amplitude_B_T: 0.001,
            direction: [0, 1, 0],
            enabled: true,
            id: "antenna-drive",
            kind: "regional",
            name: "Antenna drive",
            spatial_profile: { kind: "geometry_mask", object_id: "antenna" },
            target: { kind: "global" },
            time_origin: "stage_local",
            waveform: {
              frequency_hz: 1e9,
              kind: "sinusoidal",
              offset: 0.2,
              phase_rad: 0.7,
            },
          },
        ],
      },
      revision: 12,
    };
    mocks.sceneResource.error = null;
    mocks.sceneResource.revision = 12;
    mocks.sceneResource.status = "ready";
  });

  it("uses the scene revision and preserves waveform parameters while save is pending", async () => {
    const replaceResolution: {
      resolve: ((response: { scene_revision: number }) => void) | null;
    } = { resolve: null };
    mocks.replaceFieldDrive.mockImplementation(
      () =>
        new Promise<{ scene_revision: number }>((resolve) => {
          replaceResolution.resolve = resolve;
        }),
    );

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<AntennaObjectPanel selection={selection} />));
      const frequency = findElement(container, "Frequency");
      frequency.focus();

      await act(async () => changeInput(container, "Amplitude", "0.002"));
      await act(async () => findButton(container, "Save field drive").click());

      expect(mocks.replaceFieldDrive).toHaveBeenCalledOnce();
      expect(mocks.replaceFieldDrive).toHaveBeenCalledWith(
        "antenna-drive",
        expect.objectContaining({
          base_revision: 12,
          drive: expect.objectContaining({
            amplitude_B_T: 0.002,
            waveform: {
              frequency_hz: 1e9,
              kind: "sinusoidal",
              offset: 0.2,
              phase_rad: 0.7,
            },
          }),
        }),
        sessionRequestOptions,
      );
      frequency.focus();
      expect(frequency.disabled).toBe(false);
      expect(dom.document.activeElement).toBe(frequency);

      if (!replaceResolution.resolve) {
        throw new Error("field drive save did not become pending");
      }
      replaceResolution.resolve({ scene_revision: 13 });
      await act(async () => undefined);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps an unsaved draft when an unrelated scene revision arrives", async () => {
    mocks.replaceFieldDrive.mockResolvedValue({ scene_revision: 14 });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<AntennaObjectPanel selection={selection} />));
      await act(async () => changeInput(container, "Amplitude", "0.002"));

      const currentScene = mocks.sceneResource.data as {
        field_drives: { drives: Array<{ waveform: Record<string, unknown> }> };
      };
      mocks.sceneResource.data = {
        ...currentScene,
        field_drives: {
          drives: currentScene.field_drives.drives.map((drive) => ({
            ...drive,
            waveform: { ...drive.waveform, phase_rad: 0.8, offset: 0.3 },
          })),
        },
        revision: 13,
      };
      mocks.sceneResource.revision = 13;
      await act(async () => root.render(<AntennaObjectPanel selection={selection} />));

      expect(findElement(container, "Amplitude").value).toBe("0.002");
      expect(findElement(container, "Phase").value).toBe("0.8");
      expect(findElement(container, "Offset").value).toBe("0.3");
      await act(async () => findButton(container, "Save field drive").click());
      expect(mocks.replaceFieldDrive).toHaveBeenCalledWith(
        "antenna-drive",
        expect.objectContaining({
          base_revision: 13,
          drive: expect.objectContaining({
            amplitude_B_T: 0.002,
            waveform: {
              frequency_hz: 1e9,
              kind: "sinusoidal",
              offset: 0.3,
              phase_rad: 0.8,
            },
          }),
        }),
        sessionRequestOptions,
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("requires an explicit rebase when the server changes an edited field", async () => {
    mocks.replaceFieldDrive.mockResolvedValue({ scene_revision: 14 });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<AntennaObjectPanel selection={selection} />));
      await act(async () => changeInput(container, "Amplitude", "0.002"));

      const currentScene = mocks.sceneResource.data as {
        field_drives: { drives: Array<Record<string, unknown>> };
      };
      mocks.sceneResource.data = {
        ...currentScene,
        field_drives: {
          drives: currentScene.field_drives.drives.map((drive) => ({
            ...drive,
            amplitude_B_T: 0.003,
          })),
        },
        revision: 13,
      };
      mocks.sceneResource.revision = 13;
      await act(async () => root.render(<AntennaObjectPanel selection={selection} />));

      expect(findElement(container, "Amplitude").value).toBe("0.002");
      expect(container.textContent).toContain("Concurrent field edit");
      expect(container.textContent).toContain("0.003");
      expect(findButton(container, "Save field drive").disabled).toBe(true);
      expect(mocks.replaceFieldDrive).not.toHaveBeenCalled();

      await act(async () => findButton(container, "Rebase Draft").click());
      expect(findButton(container, "Save field drive").disabled).toBe(false);
      await act(async () => findButton(container, "Save field drive").click());
      expect(mocks.replaceFieldDrive).toHaveBeenCalledWith(
        "antenna-drive",
        expect.objectContaining({
          base_revision: 13,
          drive: expect.objectContaining({ amplitude_B_T: 0.002 }),
        }),
        sessionRequestOptions,
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("uses the acknowledged value as the base for a later edit", async () => {
    mocks.replaceFieldDrive.mockResolvedValue({ scene_revision: 13 });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<AntennaObjectPanel selection={selection} />));
      await act(async () => changeInput(container, "Amplitude", "0.002"));
      await act(async () => findButton(container, "Save field drive").click());

      const currentScene = mocks.sceneResource.data as {
        field_drives: { drives: Array<Record<string, unknown>> };
      };
      mocks.sceneResource.data = {
        ...currentScene,
        field_drives: {
          drives: currentScene.field_drives.drives.map((drive) => ({
            ...drive,
            amplitude_B_T: 0.002,
          })),
        },
        revision: 13,
      };
      mocks.sceneResource.revision = 13;
      await act(async () => root.render(<AntennaObjectPanel selection={selection} />));
      await act(async () => changeInput(container, "Amplitude", "0.004"));

      expect(container.textContent).not.toContain("Concurrent field edit");
      expect(findButton(container, "Save field drive").disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("uses explicit defaults each time the waveform kind changes", async () => {
    mocks.replaceFieldDrive.mockResolvedValue({ scene_revision: 13 });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<AntennaObjectPanel selection={selection} />));
      await act(async () => changeInput(container, "Frequency", "2000000000"));
      await act(async () => changeSelect(container, "Waveform", "sinc_pulse"));
      expect(findElement(container, "Waveform amplitude").value).toBe("1");
      await act(async () => changeInput(container, "Waveform amplitude", "0.4"));
      await act(async () => changeSelect(container, "Waveform", "sinusoidal"));
      expect(findElement(container, "Frequency").value).toBe("10000000000");
      expect(findElement(container, "Phase").value).toBe("0");
      expect(findElement(container, "Offset").value).toBe("0");
      await act(async () => findButton(container, "Save field drive").click());
      expect(mocks.replaceFieldDrive).toHaveBeenCalledWith(
        "antenna-drive",
        expect.objectContaining({
          drive: expect.objectContaining({
            waveform: {
              kind: "sinusoidal",
              frequency_hz: 1e10,
              phase_rad: 0,
              offset: 0,
            },
          }),
        }),
        sessionRequestOptions,
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("fails closed when the scene revision is unavailable", async () => {
    mocks.sceneResource.data = {
      field_drives: {
        drives: [
          {
            amplitude_B_T: 0.001,
            direction: [0, 1, 0],
            id: "antenna-drive",
            kind: "regional",
            spatial_profile: { kind: "geometry_mask", object_id: "antenna" },
            waveform: { kind: "constant" },
          },
        ],
      },
    };
    mocks.sceneResource.revision = null as never;

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<AntennaObjectPanel selection={selection} />));

      expect(findButton(container, "Save field drive").disabled).toBe(true);
      expect(mocks.replaceFieldDrive).not.toHaveBeenCalled();
      expect(mocks.commitTransaction).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("sends the expected scene revision with a legacy full-array migration", async () => {
    mocks.sceneResource.data = {
      current_modules: {
        modules: [
          {
            B: 0.001,
            direction: [0, 1, 0],
            id: "legacy-drive",
            kind: "antenna_field_source",
            model: "prescribed_zeeman_mask",
            name: "Legacy antenna drive",
            object: "antenna",
            spatial_profile: { kind: "uniform" },
            waveform: { kind: "constant" },
          },
        ],
      },
      field_drives: { drives: [] },
      revision: 21,
    };
    mocks.sceneResource.revision = 21;
    mocks.commitTransaction.mockResolvedValue({ scene_revision: 22 });

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<AntennaObjectPanel selection={selection} />));
      await act(async () => findButton(container, "Migrate and save").click());

      expect(mocks.commitTransaction).toHaveBeenCalledOnce();
      expect(mocks.commitTransaction.mock.calls[0]?.[1]).toEqual(sessionRequestOptions);
      const request = mocks.commitTransaction.mock.calls[0]?.[0] as {
        base_revision: number;
        kind: string;
        merge_patch: {
          current_modules: { modules: unknown[] };
          field_drives: { drives: Array<Record<string, unknown>> };
        };
      };
      expect(request).toMatchObject({ base_revision: 21, kind: "merge_patch" });
      expect(request.merge_patch.current_modules).toEqual({ modules: [] });
      expect(request.merge_patch.field_drives.drives).toHaveLength(1);
      expect(request.merge_patch.field_drives.drives[0]).toMatchObject({
        id: "legacy-drive",
        kind: "regional",
        spatial_profile: {
          kind: "geometry_mask",
          object_id: "antenna",
        },
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("requires refetch and rebase before retrying a same-field revision conflict", async () => {
    mocks.replaceFieldDrive
      .mockRejectedValueOnce(
        new ControlRoomApiError("scene changed", 409, "request-antenna", "revision_conflict"),
      )
      .mockResolvedValueOnce({ scene_revision: 14 });

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<AntennaObjectPanel selection={selection} />));
      await act(async () => changeInput(container, "Amplitude", "0.002"));
      await act(async () => findButton(container, "Save field drive").click());

      expect(container.textContent).toContain("Revision conflict");
      expect(findButton(container, "Refetch Scene").disabled).toBe(false);
      expect(findButton(container, "Rebase Draft").disabled).toBe(true);
      expect(findButton(container, "Retry Save").disabled).toBe(true);

      await act(async () => findButton(container, "Refetch Scene").click());
      expect(mocks.refetch).toHaveBeenCalledOnce();
      mocks.sceneResource.status = "loading";
      await act(async () => root.render(<AntennaObjectPanel selection={selection} />));
      expect(findButton(container, "Rebase Draft").disabled).toBe(true);

      mocks.sceneResource.data = {
        field_drives: {
          drives: [
            {
              amplitude_B_T: 0.001,
              direction: [0, 1, 0],
              id: "antenna-drive",
              kind: "regional",
              spatial_profile: { kind: "geometry_mask", object_id: "antenna" },
              waveform: {
                frequency_hz: 1.5e9,
                kind: "sinusoidal",
                offset: 0.3,
                phase_rad: 0.8,
              },
            },
          ],
        },
        revision: 13,
      };
      mocks.sceneResource.revision = 13;
      mocks.sceneResource.status = "ready";
      await act(async () => root.render(<AntennaObjectPanel selection={selection} />));
      expect(container.textContent).toContain("Server amplitude");
      expect(container.textContent).toContain("0.002");
      expect(container.textContent).toContain("0.001");
      expect(container.textContent).toContain("Draft frequency");
      expect(container.textContent).toContain("Server frequency");
      expect(container.textContent).toContain("1500000000");
      expect(container.textContent).toContain("Server phase");
      expect(container.textContent).toContain("0.8");
      expect(findButton(container, "Rebase Draft").disabled).toBe(false);

      await act(async () => findButton(container, "Rebase Draft").click());
      expect(findButton(container, "Retry Save").disabled).toBe(false);
      await act(async () => findButton(container, "Retry Save").click());
      expect(mocks.replaceFieldDrive).toHaveBeenLastCalledWith(
        "antenna-drive",
        expect.objectContaining({
          base_revision: 13,
          drive: expect.objectContaining({
            amplitude_B_T: 0.002,
            waveform: {
              frequency_hz: 1.5e9,
              kind: "sinusoidal",
              offset: 0.3,
              phase_rad: 0.8,
            },
          }),
        }),
        sessionRequestOptions,
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function changeInput(root: TestNode, label: string, value: string): void {
  const input = findElement(root, label);
  const nativeValueSetter = Object.getOwnPropertyDescriptor(
    TestElement.prototype,
    "value",
  )?.set;
  if (!nativeValueSetter) throw new Error("Missing native test input value setter");
  nativeValueSetter.call(input, value);
  input.dispatchEvent(new TestEvent("input", { bubbles: true }));
}

function changeSelect(root: TestNode, label: string, value: string): void {
  const select = findElement(root, label);
  select.value = value;
  select.dispatchEvent(new TestEvent("change", { bubbles: true }));
}

function findButton(root: TestNode, text: string): TestElement {
  const button = findElements(root, (element) =>
    element.tagName === "BUTTON" && element.textContent.includes(text),
  )[0];
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

function findElement(root: TestNode, label: string): TestElement {
  const element = findElements(
    root,
    (candidate) =>
      (candidate.tagName === "INPUT" || candidate.tagName === "SELECT") &&
      candidate.getAttribute("aria-label") === label,
  )[0];
  if (!element) throw new Error(`Missing control ${label}`);
  return element;
}

function findElements(
  root: TestNode,
  predicate: (element: TestElement) => boolean,
): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode): void => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}
