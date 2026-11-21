import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MaskFieldDriveResource, MaskTermResource, ReadyAntennaResource, SceneResource } from "@/kernel/api/apiTypes";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
  type TestElement,
  type TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { MODEL_MASK_FIELD_DRIVES_RESOURCE_KEY } from "@/kernel/resources/maskAntennaResources";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import {
  createInspectorEditSessionStore,
  InspectorEditSessionProvider,
  type InspectorEditSession,
} from "../InspectorEditSession";
import { InspectorDirtySelectionGuard } from "../InspectorDirtySelectionGuard";

// `masks` is the mask antenna list the panel shows (a live resource the tests
// move to newer revisions, as a refetch does); `server` is what the HTTP API
// holds now. They differ when another writer changed the scene and the list
// has not been refetched yet.
const mocks = vi.hoisted(() => ({
  identity: { requestScopeEpoch: "api:1", sessionEpoch: "4", sessionId: "A" },
  listeners: new Set<() => void>(),
  masks: { data: { drives: [] as unknown[], scene_revision: 11 }, status: "ready" },
  ready: { data: { antennas: [] as ReadyAntennaResource[] }, status: "ready" },
  regional: { data: { drives: [], scene_revision: 11 }, status: "ready" },
  scene: { data: { objects: [], revision: 11 }, status: "ready" },
  server: { drives: [] as unknown[], scene_revision: 11 },
}));

vi.mock("@/kernel/resources/maskAntennaResources", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/kernel/resources/maskAntennaResources")
  >();
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  };
  return {
    ...actual,
    useMaskFieldDrivesResource: () => useSyncExternalStore(subscribe, () => mocks.masks),
    useReadyAntennasResource: () => mocks.ready,
  };
});

vi.mock("@/kernel/resources/fieldDriveResources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/resources/fieldDriveResources")>()),
  useFieldDrivesResource: () => mocks.regional,
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/resources/geometryLifecycleResources")>()),
  useSceneResource: () => mocks.scene,
}));

vi.mock("@/kernel/resources/useSessionStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/resources/useSessionStatus")>()),
  useSessionResourceIdentity: () => mocks.identity,
}));

// The lightweight test DOM does not implement Radix portals. Keep the guard
// and its buttons real while rendering the dialog inline.
vi.mock("@/shared/ui/Dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <section role="dialog">{children}</section>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import * as explorer from "@/modules/explorer/public";
import * as navigationScene from "./antenna/AntennaNavigationScene";
import { MaskAntennaPanel } from "./MaskAntennaPanel";

const SCOPE_KEY = "session=A&epoch=4&request_scope_epoch=api%3A1";
const DIALOG = "Unapplied Inspector changes";
const CONFLICT =
  "This antenna changed in the scene in fields you also edited. Keep your values or load the scene version.";
const ORIGINAL_BZ = "B01 * sin(k * x)";
const EDITED_BZ = "B01 * cos(k * x)";
const THEIR_BZ = "B01 * sin(2 * k * x)";

function antenna(id: string, b01: number, bz = ORIGINAL_BZ): MaskFieldDriveResource {
  return {
    activation: { kind: "all_time_evolution" },
    enabled: true,
    frame: "world",
    id,
    name: id,
    position_m: [0, 0, 0],
    schema_version: "mask_field_drive.v1",
    shape: { center: [0, 0, 0], kind: "box", size: [1e-6, 1e-6, 1e-8] },
    target: { kind: "global" },
    terms: [{
      mask: {
        function: {
          expression_version: "field_expr.v1",
          locals: [{ expression: "2 * pi / wavelength", name: "k" }],
          name: "antenna_mask",
          outputs: ["0.0", "0.0", bz],
          parameters: [{ name: "B01", value: b01 }, { name: "wavelength", value: 2.79e-7 }],
        },
        kind: "function",
      },
      name: "carrier",
      time: {
        expression_version: "field_expr.v1",
        name: "antenna_time",
        outputs: ["sin(2 * pi * frequency * t)"],
        parameters: [{ name: "frequency", value: 3.6e9 }],
      },
    }],
    time_origin: "absolute",
  } as MaskFieldDriveResource;
}

/** Another writer changed the scene; the panel's list has not been refetched. */
function serverHolds(drives: MaskFieldDriveResource[], revision: number): void {
  mocks.server = { drives, scene_revision: revision };
}

/** The scene holds `drives` and the panel's list shows them (a refetch arrived). */
function publish(drives: MaskFieldDriveResource[], revision: number): void {
  serverHolds(drives, revision);
  mocks.masks = { data: { drives, scene_revision: revision }, status: "ready" };
  mocks.listeners.forEach((listener) => listener());
}

function antennaSelection(id: string): Omit<Selection, "moduleSource"> {
  const nodeId = `model:physics:mask-antennas:${id}`;
  return {
    kind: "physics.field-drive",
    label: id,
    nodeId,
    objectId: null,
    ref: { fieldDriveId: id, fieldDriveKind: "mask", kind: "physics.field-drive", nodeId, type: "physics-field-drive" },
  };
}

const DRAFT_SELECTION: Omit<Selection, "moduleSource"> = {
  kind: "physics.field-drive",
  label: "New mask antenna",
  nodeId: "model:physics:mask-antenna:draft",
  objectId: null,
  ref: {
    draft: true,
    fieldDriveKind: "mask",
    kind: "physics.field-drive",
    nodeId: "model:physics:mask-antenna:draft",
    type: "physics-field-drive",
  },
};

const OTHER_SELECTION: Omit<Selection, "moduleSource"> = {
  kind: "physics.field-drives",
  label: "Field Drives",
  nodeId: "model:physics:field-drives",
  objectId: null,
  ref: null,
};

function ack(revision: number) {
  return {
    committed_scene: { objects: [], revision, scene_revision: revision },
    scene_revision: revision,
    transaction_kind: "mask_field_drive",
  };
}

/** The Inspector's selection guard around the panel, as in the Inspector module. */
function GuardedPanel({ controller }: { controller: SelectionController }) {
  const [selection, setSelection] = useState(controller.get());
  useEffect(() => controller.subscribe(setSelection), [controller]);
  return (
    <InspectorDirtySelectionGuard controller={controller} selection={selection}>
      {(current) => current.ref?.type === "physics-field-drive"
        ? <MaskAntennaPanel selection={current} />
        : <p>{current.label}</p>}
    </InspectorDirtySelectionGuard>
  );
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  publish([], 11);
  mocks.ready.data.antennas = [];
});

async function mount(selection: Omit<Selection, "moduleSource">) {
  const bus = new EventBus<KernelEventMap>();
  const controller = new SelectionController(bus);
  controller.set(selection, "explorer");
  const model = {
    createMaskFieldDrive: vi.fn(),
    deleteMaskFieldDrive: vi.fn(),
    maskFieldDrives: vi.fn(async () => structuredClone(mocks.server)),
    readyAntennaTerms: vi.fn(),
    replaceMaskFieldDrive: vi.fn(),
    scene: vi.fn(async () => ({
      objects: [],
      revision: mocks.server.scene_revision,
      scene_revision: mocks.server.scene_revision,
    })),
  };
  const invalidate = vi.fn();
  const kernel = {
    api: { model },
    authoringHistory: { getGeneration: () => 3, record: vi.fn(), subscribe: () => () => undefined },
    bus,
    commands: { getSessionScopeKey: () => SCOPE_KEY },
    resources: { invalidate },
    selection: controller,
  } as unknown as KernelApi;
  const store = createInspectorEditSessionStore();
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(
    <KernelContext.Provider value={kernel}>
      <InspectorEditSessionProvider store={store}>
        <GuardedPanel controller={controller} />
      </InspectorEditSessionProvider>
    </KernelContext.Provider>,
  ));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    dom.restore();
  });
  return {
    container,
    controller,
    document: dom.document,
    invalidate,
    model,
    session: (): InspectorEditSession => {
      const session = store.getCurrentSession();
      if (!session) throw new Error("MaskAntennaPanel registered no Inspector session");
      return session;
    },
  };
}

function input(root: TestNode, label: string): TestElement {
  return findElement(
    root,
    (element) => element.tagName === "INPUT" && element.getAttribute("aria-label") === label,
    `input ${label}`,
  );
}

function exactButton(root: TestNode, text: string): TestElement {
  return findElement(
    root,
    (element) => element.tagName === "BUTTON" && element.textContent.trim() === text,
    `button ${text}`,
  );
}

async function type(element: TestElement, value: string): Promise<void> {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new TestEvent("input", { bubbles: true }));
  });
}

/** Let a write started by a click run through its awaits. */
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function apply(session: InspectorEditSession): Promise<boolean> {
  let applied = false;
  await act(async () => { applied = await session.apply(); });
  return applied;
}

function submittedDrive(mock: ReturnType<typeof vi.fn>, call = 0) {
  const [, request] = mock.mock.calls[call];
  return request as { base_revision: number; drive: MaskFieldDriveResource };
}

function maskFunction(drive: MaskFieldDriveResource) {
  const mask = drive.terms[0].mask;
  if (mask.kind !== "function") throw new Error("a function mask");
  return mask.function;
}

describe("MaskAntennaPanel draft across scene revisions", () => {
  it("keeps the draft, focus and scroll when a newer revision arrives, and leaves after Apply without the dialog", async () => {
    publish([antenna("antenna", 2e-4)], 11);
    const view = await mount(antennaSelection("antenna"));
    const panel = view.container.querySelector(".fm-inspector-panel");
    if (!panel) throw new Error("Inspector panel root missing");
    panel.scrollTop = 140;
    await type(input(view.container, "B01"), "3e-4");
    const bz = input(view.container, "Bz =");
    bz.focus();
    await type(bz, EDITED_BZ);
    expect(view.session().dirty).toBe(true);

    // Another write (here: a second antenna) moves the scene to revision 12.
    await act(async () => publish([antenna("antenna", 2e-4), antenna("other", 1e-3)], 12));

    // The same input node keeps its text and the focus; the panel root keeps its scroll.
    expect(view.container.querySelector(".fm-inspector-panel") === panel).toBe(true);
    expect(panel.scrollTop).toBe(140);
    expect(input(view.container, "Bz =") === bz).toBe(true);
    expect(view.document.activeElement === bz).toBe(true);
    expect(bz.value).toBe(EDITED_BZ);
    expect(input(view.container, "B01").value).toBe("0.0003");
    expect(view.container.textContent).not.toContain(CONFLICT);
    expect(view.session().dirty).toBe(true);
    expect(view.session().applyBlockReason).toBeUndefined();

    view.model.replaceMaskFieldDrive.mockResolvedValue(ack(13));
    // Leave in the same task as the ACK, before React renders the saved state:
    // only the acknowledgement of the edit session keeps the guard closed.
    await act(async () => {
      expect(await view.session().apply()).toBe(true);
      view.controller.set(OTHER_SELECTION, "explorer");
    });
    expect(view.model.replaceMaskFieldDrive).toHaveBeenCalledOnce();
    const request = submittedDrive(view.model.replaceMaskFieldDrive);
    expect(view.model.replaceMaskFieldDrive.mock.calls[0][0]).toBe("antenna");
    expect(request.base_revision).toBe(12);
    expect(maskFunction(request.drive).outputs[2]).toBe(EDITED_BZ);
    expect(maskFunction(request.drive).parameters?.[0]).toEqual({ name: "B01", value: 3e-4 });
    expect(view.container.textContent).not.toContain(DIALOG);
    expect(view.controller.get().nodeId).toBe(OTHER_SELECTION.nodeId);
  });

  it("shows the saved antenna until the list is refetched", async () => {
    publish([antenna("antenna", 2e-4)], 11);
    const view = await mount(antennaSelection("antenna"));
    await type(input(view.container, "Bz ="), EDITED_BZ);
    view.model.replaceMaskFieldDrive.mockResolvedValue(ack(12));
    expect(await apply(view.session())).toBe(true);

    expect(view.session().dirty).toBe(false);
    expect(input(view.container, "Bz =").value).toBe(EDITED_BZ);
    await act(async () => publish([antenna("antenna", 2e-4, EDITED_BZ)], 12));
    expect(input(view.container, "Bz =").value).toBe(EDITED_BZ);
    expect(view.session().dirty).toBe(false);
  });

  it("follows the scene while the antenna is not edited", async () => {
    publish([antenna("antenna", 2e-4)], 11);
    const view = await mount(antennaSelection("antenna"));
    await act(async () => publish([antenna("antenna", 5e-4)], 12));
    expect(input(view.container, "B01").value).toBe("0.0005");
    expect(view.container.textContent).not.toContain(CONFLICT);
    expect(view.session().dirty).toBe(false);
  });

  it("follows the scene again after edits are typed back to the original values", async () => {
    publish([antenna("antenna", 2e-4)], 11);
    const view = await mount(antennaSelection("antenna"));
    await type(input(view.container, "Bz ="), EDITED_BZ);
    await type(input(view.container, "Bz ="), ORIGINAL_BZ);
    await type(input(view.container, "B01"), "2e-4");
    expect(view.session().dirty).toBe(false);

    await act(async () => publish([antenna("antenna", 5e-4)], 12));
    expect(input(view.container, "B01").value).toBe("0.0005");
    expect(input(view.container, "Bz =").value).toBe(ORIGINAL_BZ);
    expect(view.container.textContent).not.toContain(CONFLICT);
    expect(view.session().dirty).toBe(false);
    await act(async () => view.controller.set(OTHER_SELECTION, "explorer"));
    expect(view.container.textContent).not.toContain(DIALOG);
  });

  it("merges a change of another field made in the scene into the draft", async () => {
    publish([antenna("antenna", 2e-4)], 11);
    const view = await mount(antennaSelection("antenna"));
    await type(input(view.container, "Bz ="), EDITED_BZ);
    await act(async () => publish([antenna("antenna", 5e-4)], 12));

    expect(view.container.textContent).not.toContain(CONFLICT);
    expect(input(view.container, "Bz =").value).toBe(EDITED_BZ);
    expect(input(view.container, "B01").value).toBe("0.0005");
    view.model.replaceMaskFieldDrive.mockResolvedValue(ack(13));
    expect(await apply(view.session())).toBe(true);
    const request = submittedDrive(view.model.replaceMaskFieldDrive);
    expect(request.base_revision).toBe(12);
    expect(maskFunction(request.drive).outputs[2]).toBe(EDITED_BZ);
    expect(maskFunction(request.drive).parameters?.[0].value).toBe(5e-4);
  });

  it("edits a field from the value the scene gave it, without a conflict", async () => {
    publish([antenna("antenna", 2e-4)], 11);
    const view = await mount(antennaSelection("antenna"));
    await type(input(view.container, "Bz ="), EDITED_BZ);
    await act(async () => publish([antenna("antenna", 5e-4)], 12));
    await type(input(view.container, "B01"), "7e-4");

    expect(view.container.textContent).not.toContain(CONFLICT);
    view.model.replaceMaskFieldDrive.mockResolvedValue(ack(13));
    expect(await apply(view.session())).toBe(true);
    const request = submittedDrive(view.model.replaceMaskFieldDrive);
    expect(maskFunction(request.drive).parameters?.[0].value).toBe(7e-4);
    expect(maskFunction(request.drive).outputs[2]).toBe(EDITED_BZ);
  });

  it("types the earlier value back after the scene changed it", async () => {
    publish([antenna("antenna", 2e-4)], 11);
    const view = await mount(antennaSelection("antenna"));
    await type(input(view.container, "Bz ="), EDITED_BZ);
    await act(async () => publish([antenna("antenna", 5e-4)], 12));
    const b01 = input(view.container, "B01");
    for (const text of ["2", "2e", "2e-", "2e-4"]) {
      await type(b01, text);
      expect(b01.value).toBe(text);
      expect(view.container.textContent).not.toContain(CONFLICT);
    }

    view.model.replaceMaskFieldDrive.mockResolvedValue(ack(13));
    expect(await apply(view.session())).toBe(true);
    expect(maskFunction(submittedDrive(view.model.replaceMaskFieldDrive).drive).parameters?.[0].value).toBe(2e-4);
  });

  it("does not bring back a value the user typed back before the scene changed it", async () => {
    publish([antenna("antenna", 2e-4)], 11);
    const view = await mount(antennaSelection("antenna"));
    await type(input(view.container, "B01"), "3e-4");
    await type(input(view.container, "Bz ="), EDITED_BZ);
    await type(input(view.container, "B01"), "2e-4");
    await act(async () => publish([antenna("antenna", 5e-4)], 12));
    expect(input(view.container, "B01").value).toBe("0.0005");

    await type(input(view.container, "Bz ="), `${EDITED_BZ} + 0.0`);
    expect(input(view.container, "B01").value).toBe("0.0005");
    expect(view.container.textContent).not.toContain(CONFLICT);
    view.model.replaceMaskFieldDrive.mockResolvedValue(ack(13));
    expect(await apply(view.session())).toBe(true);
    expect(maskFunction(submittedDrive(view.model.replaceMaskFieldDrive).drive).parameters?.[0].value).toBe(5e-4);
  });

  it("blocks Apply for a field changed on both sides until the user keeps their values", async () => {
    publish([antenna("antenna", 2e-4)], 11);
    const view = await mount(antennaSelection("antenna"));
    await type(input(view.container, "Bz ="), EDITED_BZ);
    await act(async () => publish([antenna("antenna", 5e-4, THEIR_BZ)], 12));

    expect(view.container.textContent).toContain(CONFLICT);
    expect(view.container.textContent).toContain("terms[0].mask.function.outputs[2]");
    expect(input(view.container, "Bz =").value).toBe(EDITED_BZ);
    expect(input(view.container, "B01").value).toBe("0.0005");
    expect(view.session().applyBlockReason).toBe(CONFLICT);
    expect(await apply(view.session())).toBe(false);
    expect(view.model.replaceMaskFieldDrive).not.toHaveBeenCalled();

    await act(async () => exactButton(view.container, "Keep my values").click());
    expect(view.container.textContent).not.toContain(CONFLICT);
    expect(view.session().applyBlockReason).toBeUndefined();
    view.model.replaceMaskFieldDrive.mockResolvedValue(ack(13));
    expect(await apply(view.session())).toBe(true);
    const request = submittedDrive(view.model.replaceMaskFieldDrive);
    expect(maskFunction(request.drive).outputs[2]).toBe(EDITED_BZ);
    // The other writer's change of a field this panel did not edit survives.
    expect(maskFunction(request.drive).parameters?.[0].value).toBe(5e-4);
  });

  it("loads the scene version of a field changed on both sides on request", async () => {
    publish([antenna("antenna", 2e-4)], 11);
    const view = await mount(antennaSelection("antenna"));
    await type(input(view.container, "Bz ="), EDITED_BZ);
    await act(async () => publish([antenna("antenna", 5e-4, THEIR_BZ)], 12));

    await act(async () => exactButton(view.container, "Load scene version").click());
    expect(input(view.container, "Bz =").value).toBe(THEIR_BZ);
    expect(input(view.container, "B01").value).toBe("0.0005");
    expect(view.container.textContent).not.toContain(CONFLICT);
    expect(view.session().dirty).toBe(false);
  });

  it("merges onto the antenna the server holds when the list is older", async () => {
    publish([antenna("antenna", 2e-4)], 11);
    const view = await mount(antennaSelection("antenna"));
    await type(input(view.container, "Bz ="), EDITED_BZ);
    serverHolds([antenna("antenna", 5e-4)], 12);

    view.model.replaceMaskFieldDrive.mockResolvedValue(ack(13));
    expect(await apply(view.session())).toBe(true);
    const request = submittedDrive(view.model.replaceMaskFieldDrive);
    expect(request.base_revision).toBe(12);
    expect(maskFunction(request.drive).outputs[2]).toBe(EDITED_BZ);
    expect(maskFunction(request.drive).parameters?.[0].value).toBe(5e-4);
  });

  it("refuses to save over a field the server changed when the list is older", async () => {
    publish([antenna("antenna", 2e-4)], 11);
    const view = await mount(antennaSelection("antenna"));
    await type(input(view.container, "Bz ="), EDITED_BZ);
    serverHolds([antenna("antenna", 2e-4, THEIR_BZ)], 12);

    expect(await apply(view.session())).toBe(false);
    expect(view.model.replaceMaskFieldDrive).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("Not saved: this antenna changed in the scene");
    expect(view.invalidate).toHaveBeenCalledWith(MODEL_MASK_FIELD_DRIVES_RESOURCE_KEY, 12);
    await act(async () => publish([antenna("antenna", 2e-4, THEIR_BZ)], 12));
    expect(view.container.textContent).toContain(CONFLICT);
    expect(input(view.container, "Bz =").value).toBe(EDITED_BZ);
  });

  it("adds generated terms to the draft without dropping edits made during the request", async () => {
    const readyFunction = "fullmag.antennas.gaussian_k_source";
    const initial = antenna("antenna", 2e-4);
    initial.terms[0].origin = {
      arguments: { amplitude: 2e-4 },
      call_index: 0,
      function: readyFunction,
      output_index: 0,
    };
    mocks.ready.data.antennas = [{ arguments: [], function: readyFunction, summary: "Gaussian" }];
    publish([initial], 11);
    const view = await mount(antennaSelection("antenna"));
    let finish!: (response: { terms: MaskTermResource[] }) => void;
    view.model.readyAntennaTerms.mockReturnValue(new Promise((resolve) => { finish = resolve; }));

    await act(async () => exactButton(view.container, "Build terms").click());
    expect(view.model.readyAntennaTerms).toHaveBeenCalledOnce();
    await type(input(view.container, "Name"), "Antenna renamed while building");
    const generated = antenna("antenna", 6e-4).terms[0];
    generated.origin = { ...initial.terms[0].origin, arguments: { amplitude: 6e-4 } };
    await act(async () => finish({ terms: [generated] }));

    expect(input(view.container, "Name").value).toBe("Antenna renamed while building");
    expect(input(view.container, "B01").value).toBe("0.0006");
    view.model.replaceMaskFieldDrive.mockResolvedValue(ack(12));
    expect(await apply(view.session())).toBe(true);
    const request = submittedDrive(view.model.replaceMaskFieldDrive);
    expect(request.drive.name).toBe("Antenna renamed while building");
    expect(maskFunction(request.drive).parameters?.[0].value).toBe(6e-4);
  });

  it("saves an edited antenna and moves on through Apply and continue", async () => {
    publish([antenna("antenna", 2e-4), antenna("other", 1e-3)], 11);
    const view = await mount(antennaSelection("antenna"));
    await type(input(view.container, "Bz ="), EDITED_BZ);

    await act(async () => view.controller.set(antennaSelection("other"), "explorer"));
    expect(view.container.textContent).toContain(DIALOG);
    expect(view.controller.get().nodeId).toBe("model:physics:mask-antennas:antenna");
    view.model.replaceMaskFieldDrive.mockResolvedValue(ack(12));
    await act(async () => exactButton(view.container, "Apply and continue").click());
    await settle();

    expect(view.model.replaceMaskFieldDrive).toHaveBeenCalledOnce();
    expect(maskFunction(submittedDrive(view.model.replaceMaskFieldDrive).drive).outputs[2]).toBe(EDITED_BZ);
    expect(view.container.textContent).not.toContain(DIALOG);
    expect(view.controller.get().nodeId).toBe("model:physics:mask-antennas:other");
  });

  it("keeps Apply and Discard disabled until post-ACK navigation has a current scene", async () => {
    const destination = { ...antennaSelection("other"), moduleSource: "inspector" };
    const scene = { objects: [], scene_revision: 12 } as unknown as SceneResource;
    const initialScene = vi.spyOn(navigationScene, "antennaNavigationScene").mockReturnValue(scene);
    const refreshedScene = vi.spyOn(navigationScene, "antennaNavigationSceneState")
      .mockReturnValue({ scene: null, error: null });
    const links = vi.spyOn(explorer, "antennaNavigationLinks").mockReturnValue([
      { key: "related", label: "Related antenna", reason: null, selection: destination },
    ]);
    let notifySceneChanged: (() => void) | undefined;
    const observe = vi.spyOn(navigationScene, "observeAntennaNavigationScene")
      .mockImplementation((_kernel, _scope, listener) => {
        notifySceneChanged = listener;
        return () => { notifySceneChanged = undefined; };
      });
    try {
      publish([antenna("antenna", 2e-4), antenna("other", 1e-3)], 11);
      const view = await mount(antennaSelection("antenna"));
      await type(input(view.container, "Bz ="), EDITED_BZ);
      await act(async () => view.controller.set(destination, "inspector"));
      view.model.replaceMaskFieldDrive.mockResolvedValue(ack(12));
      await act(async () => exactButton(view.container, "Apply and continue").click());
      await settle();

      expect(refreshedScene).toHaveBeenCalled();
      expect(view.model.replaceMaskFieldDrive).toHaveBeenCalledOnce();
      expect(exactButton(view.container, "Apply and continue").disabled).toBe(true);
      expect(exactButton(view.container, "Discard").disabled).toBe(true);
      expect(view.controller.get().nodeId).toBe(antennaSelection("antenna").nodeId);

      refreshedScene.mockReturnValue({ scene, error: null });
      await act(async () => notifySceneChanged?.());
      expect(view.controller.get().nodeId).toBe(destination.nodeId);
      expect(view.container.textContent).not.toContain(DIALOG);
      expect(view.model.replaceMaskFieldDrive).toHaveBeenCalledOnce();
    } finally {
      observe.mockRestore();
      links.mockRestore();
      refreshedScene.mockRestore();
      initialScene.mockRestore();
    }
  });

  it("selects a created antenna without the dialog", async () => {
    publish([], 11);
    const view = await mount(DRAFT_SELECTION);
    await type(input(view.container, "ID"), "ui-antenna");
    view.model.createMaskFieldDrive.mockResolvedValue(ack(12));

    expect(await apply(view.session())).toBe(true);
    expect(view.model.createMaskFieldDrive.mock.calls[0][0].drive.id).toBe("ui-antenna");
    expect(view.container.textContent).not.toContain(DIALOG);
    expect(view.controller.get().nodeId).toBe("model:physics:mask-antennas:ui-antenna");
  });

  it("leaves a discarded new-antenna draft", async () => {
    publish([], 11);
    const view = await mount(DRAFT_SELECTION);
    await type(input(view.container, "ID"), "ui-antenna");

    await act(async () => view.controller.set(OTHER_SELECTION, "explorer"));
    expect(view.container.textContent).toContain(DIALOG);
    await act(async () => exactButton(view.container, "Discard").click());
    await settle();
    expect(view.container.textContent).not.toContain(DIALOG);
    expect(view.controller.get().nodeId).toBe(OTHER_SELECTION.nodeId);
    expect(view.model.createMaskFieldDrive).not.toHaveBeenCalled();
  });

  it("leaves a deleted antenna with an unapplied edit without the dialog", async () => {
    publish([antenna("antenna", 2e-4)], 11);
    const view = await mount(antennaSelection("antenna"));
    await type(input(view.container, "Bz ="), EDITED_BZ);
    view.model.deleteMaskFieldDrive.mockResolvedValue(ack(12));

    await act(async () => exactButton(view.container, "Delete antenna").click());
    await settle();
    expect(view.model.deleteMaskFieldDrive).toHaveBeenCalledOnce();
    expect(view.container.textContent).not.toContain(DIALOG);
    expect(view.controller.get().nodeId).toBe(OTHER_SELECTION.nodeId);
  });
});
