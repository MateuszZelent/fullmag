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
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<AntennaObjectPanel selection={selection} />));
      await act(async () => changeInput(container, "Amplitude", "0.002"));

      mocks.sceneResource.data = {
        ...(mocks.sceneResource.data as Record<string, unknown>),
        revision: 13,
      };
      mocks.sceneResource.revision = 13;
      await act(async () => root.render(<AntennaObjectPanel selection={selection} />));

      expect(findElement(container, "Amplitude").value).toBe("0.002");
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
                frequency_hz: 1e9,
                kind: "sinusoidal",
                offset: 0.2,
                phase_rad: 0.7,
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
      expect(findButton(container, "Rebase Draft").disabled).toBe(false);

      await act(async () => findButton(container, "Rebase Draft").click());
      expect(findButton(container, "Retry Save").disabled).toBe(false);
      await act(async () => findButton(container, "Retry Save").click());
      expect(mocks.replaceFieldDrive).toHaveBeenLastCalledWith(
        "antenna-drive",
        expect.objectContaining({
          base_revision: 13,
          drive: expect.objectContaining({ amplitude_B_T: 0.002 }),
        }),
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
