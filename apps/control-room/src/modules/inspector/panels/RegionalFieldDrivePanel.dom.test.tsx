import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import {
  installSimulationPreparationTestDom,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  InspectorEditSessionProvider,
  useInspectorEditSession,
  type InspectorEditSession,
} from "../InspectorEditSession";

const mocks = vi.hoisted(() => ({
  createFieldDrive: vi.fn(),
  generation: 3,
  invalidate: vi.fn(),
  record: vi.fn(),
  replaceFieldDrive: vi.fn(),
  scene: vi.fn(),
  scopeKey: "session=A&epoch=4" as string | null,
  setSelection: vi.fn(),
}));

vi.mock("@/kernel/resources/fieldDriveResources", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/kernel/resources/fieldDriveResources")
  >();
  return {
    ...actual,
    useFieldDrivesResource: () => ({
      data: { drives: [], scene_revision: 11 },
      status: "ready",
    }),
  };
});

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useSceneResource: () => ({
    data: { objects: [], revision: 11, scene_revision: 11 },
    status: "ready",
  }),
}));

import { RegionalFieldDrivePanel } from "./RegionalFieldDrivePanel";

const draftSelection: Selection = {
  kind: "physics.field-drive",
  label: "New field drive",
  moduleSource: "test",
  nodeId: "model:physics:field-drive:draft",
  objectId: null,
  ref: {
    draft: true,
    kind: "physics.field-drive",
    nodeId: "model:physics:field-drive:draft",
    type: "physics-field-drive",
  },
};

function SessionCapture({ capture }: {
  capture: (session: InspectorEditSession | null) => void;
}) {
  capture(useInspectorEditSession());
  return null;
}

function kernel(): KernelApi {
  return {
    api: {
      model: {
        createFieldDrive: mocks.createFieldDrive,
        replaceFieldDrive: mocks.replaceFieldDrive,
        scene: mocks.scene,
      },
    },
    authoringHistory: {
      getGeneration: () => mocks.generation,
      record: mocks.record,
    },
    commands: { getSessionScopeKey: () => mocks.scopeKey },
    resources: { invalidate: mocks.invalidate },
    selection: { set: mocks.setSelection },
  } as unknown as KernelApi;
}

describe("RegionalFieldDrivePanel scoped Apply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generation = 3;
    mocks.scopeKey = "session=A&epoch=4";
    mocks.scene.mockResolvedValue({
      objects: [],
      revision: 11,
      scene_revision: 11,
    });
  });

  it("uses the captured session and scene revision for create and records one history entry", async () => {
    const committedScene = { objects: [], revision: 12, scene_revision: 12 };
    mocks.createFieldDrive.mockResolvedValue({
      committed_scene: committedScene,
      scene_revision: 12,
      transaction_kind: "create_field_drive",
    });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    let registered: InspectorEditSession | null = null;

    try {
      await act(async () => root.render(
        <KernelContext.Provider value={kernel()}>
          <InspectorEditSessionProvider>
            <RegionalFieldDrivePanel selection={draftSelection} />
            <SessionCapture capture={(session) => { registered = session; }} />
          </InspectorEditSessionProvider>
        </KernelContext.Provider>,
      ));

      let result = false;
      await act(async () => { result = await registered!.apply(); });

      expect(result).toBe(true);
      expect(mocks.scene).toHaveBeenCalledWith({ sessionScopeKey: "session=A&epoch=4" });
      expect(mocks.createFieldDrive).toHaveBeenCalledWith(
        {
          base_revision: 11,
          drive: expect.objectContaining({ id: "field-drive", kind: "regional" }),
        },
        { sessionScopeKey: "session=A&epoch=4" },
      );
      expect(mocks.record).toHaveBeenCalledOnce();
      expect(mocks.invalidate).toHaveBeenCalled();
      expect(mocks.setSelection).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not publish a late acknowledgement after the active session changes", async () => {
    const committedScene = { objects: [], revision: 12, scene_revision: 12 };
    let finishWrite: ((value: unknown) => void) | null = null;
    const write = new Promise((resolve) => { finishWrite = resolve; });
    mocks.createFieldDrive.mockReturnValue(write);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    let registered: InspectorEditSession | null = null;

    try {
      await act(async () => root.render(
        <KernelContext.Provider value={kernel()}>
          <InspectorEditSessionProvider>
            <RegionalFieldDrivePanel selection={draftSelection} />
            <SessionCapture capture={(session) => { registered = session; }} />
          </InspectorEditSessionProvider>
        </KernelContext.Provider>,
      ));

      let result = true;
      let applyPromise: Promise<boolean> = Promise.resolve(false);
      await act(async () => {
        applyPromise = Promise.resolve(registered!.apply());
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.createFieldDrive).toHaveBeenCalledOnce();

      mocks.scopeKey = "session=B&epoch=5";
      await act(async () => {
        finishWrite?.({
          committed_scene: committedScene,
          scene_revision: 12,
          transaction_kind: "create_field_drive",
        });
        result = await applyPromise;
      });

      expect(result).toBe(false);
      expect(mocks.record).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(mocks.setSelection).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
