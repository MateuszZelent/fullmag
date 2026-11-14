import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DomainMetaResource, LiveStatusResource } from "@/kernel/api/apiTypes";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { activeLaneCapabilityFixture } from "@/kernel/resources/activeLaneCapabilityFixture.testSupport";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  type TestElement,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { KernelApi } from "@/kernel/types";

import { UNKNOWN_MESH_COMMAND_LANE_REASON } from "@/kernel/authoring/geometryLifecycleCommandContributions";
import {
  meshBuildDialogUnavailableMessage,
  resolveMeshBuildDialogLane,
  shouldLoadMeshBuildDialogFemResources,
} from "./MeshBuildDialog";
import { MeshBuildDialog } from "./MeshBuildDialog";
import {
  meshBuildDialogRuntimeStatusEquals,
  selectMeshBuildDialogRuntimeStatus,
} from "./MeshBuildDialogRuntimeStatus";
import { openMeshBuildDiagnostics } from "./meshBuildDiagnosticsNavigation";

const meshDialogMocks = vi.hoisted(() => ({
  status: null as unknown,
  scene: null as unknown,
  domain: null as unknown,
  membership: null as unknown,
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const idleResource = () => ({
    data: null,
    error: null,
    refetch: () => undefined,
    revision: null,
    status: "idle",
  });
  const readyResource = () => ({ ...idleResource(), status: "ready" });
  const femSnapshotResources = new Set([
    "useMeshSharedDomainManifestResource",
    "useMeshSharedDomainPolicyResource",
    "useMeshSharedDomainQualityResource",
    "useMeshSummaryResource",
    "useMeshBuildLatestSuccessful",
    "useUniverseMeshPolicyResource",
  ]);
  return Object.fromEntries(Object.entries(actual).map(([name, value]) => [
    name,
    name === "useSceneResource" ? () => meshDialogMocks.scene ?? idleResource()
      : name === "useDomainMetaResource" ? () => meshDialogMocks.domain ?? idleResource()
        : name === "useFdmRegionMembershipResource" ? () => meshDialogMocks.membership ?? idleResource()
          : femSnapshotResources.has(name) ? readyResource
            : name.startsWith("use") ? idleResource
              : value,
  ]));
});

vi.mock("@/kernel/resources/useSessionStatus", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useSessionStatusSelector: (selector: (status: never) => unknown) =>
      selector({ data: meshDialogMocks.status } as never),
  };
});

vi.mock("@/shared/ui/Dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-dialog-root>{children}</div> : null,
  DialogContent: ({ children, ...props }: ComponentProps<"div">) =>
    <div {...props}>{children}</div>,
  DialogDescription: ({ children, ...props }: ComponentProps<"p">) =>
    <p {...props}>{children}</p>,
  DialogHeader: ({ children, ...props }: ComponentProps<"div">) =>
    <div {...props}>{children}</div>,
  DialogTitle: ({ children, ...props }: ComponentProps<"h2">) =>
    <h2 {...props}>{children}</h2>,
}));

type MountedDialog = {
  bus: EventBus<KernelEventMap>;
  container: TestElement;
  kernel: KernelApi;
  dom: ReturnType<typeof installSimulationPreparationTestDom>;
  resolved: KernelEventMap["mesh:build-confirm-resolved"][];
  root: ReturnType<typeof createRoot>;
};

let mounted: MountedDialog | null = null;

afterEach(async () => {
  if (!mounted) return;
  await act(async () => mounted?.root.unmount());
  mounted.dom.restore();
  mounted = null;
});

function fdmDomain(
  cells: number,
  bounds: DomainMetaResource["bounds"],
) {
  return {
    bounds,
    counts: { cells },
  } as DomainMetaResource;
}

function femActiveLaneCapabilityFixture() {
  const fdm = activeLaneCapabilityFixture();
  return {
    ...fdm,
    authored: { ...fdm.authored, backend: "fem", discretization: "fem" },
    requested: { ...fdm.requested, backend: "fem", discretization: "fem" },
    resolved: { ...fdm.resolved, backend: "fem", discretization: "fem" },
    operations: {
      grid_build: {
        ...fdm.operations.grid_build!,
        reason: "FDM grid build is not applicable to this FEM lane.",
        reason_code: "not_applicable",
        state: "unsupported",
      },
      shared_mesh_build: {
        reason: "Shared-domain mesh build is supported by the resolved FEM lane.",
        reason_code: "capability_supported",
        requires: ["discretization:fem"],
        state: "supported",
      },
    },
  };
}

async function mountFdmGridDialog({
  activeLane = activeLaneCapabilityFixture(),
  domain = fdmDomain(0, { min: [0, 0, 0], max: [0, 0, 0] }),
  sceneRevision = 17,
  sceneStatus = "ready",
}: {
  activeLane?: NonNullable<LiveStatusResource["capabilities"]["active_lane"]> | null;
  domain?: DomainMetaResource | null;
  sceneRevision?: number | null;
  sceneStatus?: string;
} = {}): Promise<MountedDialog> {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div") as unknown as TestElement;
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const bus = new EventBus<KernelEventMap>();
  const resolved: KernelEventMap["mesh:build-confirm-resolved"][] = [];
  bus.on("mesh:build-confirm-resolved", (event) => resolved.push(event));

  const objects = [{
    geometry: { geometry_params: { size: [8e-9, 4e-9, 2e-9] } },
    id: "film",
    name: "Film",
  }];
  meshDialogMocks.status = {
    capabilities: { active_lane: activeLane, explicit_topology: false },
    domain: { discretization: "fdm" },
    resources: { mesh_build_revision: 2, mesh_revision: 9, scene_revision: 17 },
  } satisfies Partial<LiveStatusResource>;
  meshDialogMocks.scene = {
    data: sceneRevision === null ? null : { objects, revision: sceneRevision },
    error: null,
    refetch: () => undefined,
    revision: sceneRevision,
    status: sceneStatus,
  };
  meshDialogMocks.domain = { data: domain, error: null, refetch: () => undefined, revision: null, status: "ready" };
  meshDialogMocks.membership = { data: null, error: null, refetch: () => undefined, revision: null, status: "idle" };

  const kernel = { bus } as unknown as KernelApi;
  await act(async () => {
    root.render(<MeshBuildDialog kernel={kernel} />);
  });
  mounted = { bus, container, dom, kernel, resolved, root };
  return mounted;
}

async function requestFdmGridBuild(
  target: MountedDialog,
  commandId: "grid.build-fdm" | "mesh.build-shared-domain" = "grid.build-fdm",
): Promise<void> {
  await act(async () => target.bus.emit("mesh:build-confirm-requested", {
    commandId,
    requestId: "confirm-fdm-grid",
    source: "ribbon",
  }));
}

function fdmBuildButton(container: TestElement): TestElement {
  return findElement(
    container,
    (element) => element.tagName === "BUTTON" &&
      element.textContent.includes("Build Grid & Materialize Masks"),
    "FDM grid build button",
  );
}

describe("MeshBuildDialog", () => {
  it("re-renders when the resolved lane changes even if mesh revisions are stable", () => {
    const statusForLane = (lane: string) =>
      selectMeshBuildDialogRuntimeStatus({
        data: {
          capabilities: {
            active_lane: {
              resolved: { discretization: lane },
              operations: {
                grid_build: { reason: "shared gate", state: "available" },
              },
            },
            explicit_topology: true,
          },
          domain: { discretization: "fdm" },
          resources: { mesh_build_revision: 4, mesh_revision: 5 },
        } as never,
      });

    expect(
      meshBuildDialogRuntimeStatusEquals(statusForLane("fdm"), statusForLane("fem")),
    ).toBe(false);
  });

  it("requires an explicit FEM lane before loading FEM mesh resources", () => {
    // The caller projects session authoring intent before passing a lane here.
    expect(resolveMeshBuildDialogLane("fem")).toBe("fem");
    expect(resolveMeshBuildDialogLane("fdm")).toBe("fdm");
    expect(resolveMeshBuildDialogLane({ resolved: { discretization: "fem" } })).toBe("unknown");
    expect(resolveMeshBuildDialogLane("auto")).toBe("unknown");
    expect(resolveMeshBuildDialogLane(null)).toBe("unknown");

    expect(shouldLoadMeshBuildDialogFemResources(false, "fem")).toBe(false);
    expect(shouldLoadMeshBuildDialogFemResources(true, "fem")).toBe(true);
    expect(shouldLoadMeshBuildDialogFemResources(true, "fdm")).toBe(false);
    expect(shouldLoadMeshBuildDialogFemResources(true, "unknown")).toBe(false);
  });

  it("keeps FDM grid/mask refresh separate from FEM mesh controls", () => {
    expect(meshBuildDialogUnavailableMessage("fdm")).toBe(
      "FDM grid and membership masks are rebuilt by an atomic execution-plan replan. Use Mesh → Build Grid.",
    );
    expect(meshBuildDialogUnavailableMessage("unknown")).toBe(
      UNKNOWN_MESH_COMMAND_LANE_REASON,
    );
    expect(meshBuildDialogUnavailableMessage("fem")).toBeNull();
  });

  it("enables and revision-pins confirmation for a supported FDM grid operation", async () => {
    const dialog = await mountFdmGridDialog();
    await requestFdmGridBuild(dialog);

    const button = fdmBuildButton(dialog.container);
    expect(button.disabled).toBe(false);
    await act(async () => button.click());

    expect(dialog.resolved).toEqual([{
      confirmed: true,
      precondition: { mesh_revision: 9, scene_revision: 17 },
      requestId: "confirm-fdm-grid",
    }]);
  });

  it("rejects an FDM request delivered under an otherwise ready FEM lane", async () => {
    const dialog = await mountFdmGridDialog({ activeLane: femActiveLaneCapabilityFixture() });
    await requestFdmGridBuild(dialog);

    const femBuildButtons = findElements(
      dialog.container,
      (element) => element.tagName === "BUTTON" && element.textContent.includes("Accept & Build"),
    );
    if (femBuildButtons[0]) {
      await act(async () => femBuildButtons[0]?.click());
    }
    expect(dialog.resolved).toEqual([]);
    expect(femBuildButtons).toHaveLength(0);
    expect(dialog.container.textContent).toContain("different simulation method");

    const cancel = findElement(
      dialog.container,
      (element) => element.tagName === "BUTTON" && element.textContent.includes("Cancel confirmation"),
      "lane-mismatch cancellation action",
    );
    await act(async () => cancel.click());
    expect(dialog.resolved).toEqual([{ confirmed: false, requestId: "confirm-fdm-grid" }]);
  });

  it("rejects an FDM request after the lane changes to FEM at unchanged revisions", async () => {
    const dialog = await mountFdmGridDialog();
    await requestFdmGridBuild(dialog);
    expect(fdmBuildButton(dialog.container).disabled).toBe(false);

    meshDialogMocks.status = {
      capabilities: { active_lane: femActiveLaneCapabilityFixture(), explicit_topology: false },
      domain: { discretization: "fem" },
      resources: { mesh_build_revision: 2, mesh_revision: 9, scene_revision: 17 },
    } satisfies Partial<LiveStatusResource>;
    await act(async () => dialog.root.render(<MeshBuildDialog kernel={dialog.kernel} />));

    const femBuildButtons = findElements(
      dialog.container,
      (element) => element.tagName === "BUTTON" && element.textContent.includes("Accept & Build"),
    );
    if (femBuildButtons[0]) {
      await act(async () => femBuildButtons[0]?.click());
    }
    expect(dialog.resolved).toEqual([]);
    expect(femBuildButtons).toHaveLength(0);
    expect(dialog.container.textContent).toContain("different simulation method");
  });

  it("accepts a fresh FEM shared-domain request under the FEM lane", async () => {
    const dialog = await mountFdmGridDialog({ activeLane: femActiveLaneCapabilityFixture() });
    await requestFdmGridBuild(dialog, "mesh.build-shared-domain");

    const button = findElement(
      dialog.container,
      (element) => element.tagName === "BUTTON" && element.textContent.includes("Accept & Build"),
      "FEM shared-domain build button",
    );
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(dialog.resolved).toEqual([{
      confirmed: true,
      precondition: { mesh_revision: 9, scene_revision: 17 },
      requestId: "confirm-fdm-grid",
    }]);
  });

  it.each([
    { sceneRevision: null, sceneStatus: "loading", label: "missing" },
    { sceneRevision: 16, sceneStatus: "ready", label: "revision-mismatched" },
  ])("does not confirm with $label scene data", async ({ sceneRevision, sceneStatus }) => {
    const dialog = await mountFdmGridDialog({ sceneRevision, sceneStatus });
    await requestFdmGridBuild(dialog);

    const button = fdmBuildButton(dialog.container);
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(dialog.resolved).toEqual([]);
  });

  it("reblocks confirmation if the scene resource changes after preflight", async () => {
    const dialog = await mountFdmGridDialog();
    await requestFdmGridBuild(dialog);
    expect(fdmBuildButton(dialog.container).disabled).toBe(false);

    const scene = meshDialogMocks.scene as {
      data: { objects: unknown[]; revision: number };
      error: null;
      refetch: () => undefined;
      revision: number;
      status: string;
    };
    meshDialogMocks.scene = {
      ...scene,
      data: { ...scene.data, revision: 16 },
    };
    await act(async () => dialog.root.render(<MeshBuildDialog kernel={dialog.kernel} />));

    const button = fdmBuildButton(dialog.container);
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(dialog.resolved).toEqual([]);
  });

  it("allows matching last-good scene data during a background refetch", async () => {
    const dialog = await mountFdmGridDialog({ sceneRevision: 17, sceneStatus: "loading" });
    await requestFdmGridBuild(dialog);

    const button = fdmBuildButton(dialog.container);
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(dialog.resolved).toEqual([{
      confirmed: true,
      precondition: { mesh_revision: 9, scene_revision: 17 },
      requestId: "confirm-fdm-grid",
    }]);
  });

  it("uses authored object extents when the zero-cell domain has placeholder zero bounds", async () => {
    const dialog = await mountFdmGridDialog();
    await requestFdmGridBuild(dialog);

    expect(dialog.container.textContent).toContain(
      "[-4.00 nm, -2.00 nm, -1.00 nm] to [4.00 nm, 2.00 nm, 1.00 nm]",
    );
  });

  it("falls back to authored object extents when domain metadata is absent", async () => {
    const dialog = await mountFdmGridDialog({ domain: null });
    await requestFdmGridBuild(dialog);

    expect(dialog.container.textContent).toContain(
      "[-4.00 nm, -2.00 nm, -1.00 nm] to [4.00 nm, 2.00 nm, 1.00 nm]",
    );
  });

  it("preserves a materialized domain bound whose origin is zero", async () => {
    const dialog = await mountFdmGridDialog({
      domain: fdmDomain(32, {
        min: [0, 0, 0],
        max: [8e-9, 4e-9, 2e-9],
      }),
    });
    await requestFdmGridBuild(dialog);

    expect(dialog.container.textContent).toContain(
      "[0.000 m, 0.000 m, 0.000 m] to [8.00 nm, 4.00 nm, 2.00 nm]",
    );
  });

  it.each(["unsupported", "stale"] as const)(
    "keeps the FDM button and confirmation closed for a %s grid capability",
    async (state) => {
      const base = activeLaneCapabilityFixture();
      const reason = `FDM grid capability is ${state}.`;
      const activeLane = {
        ...base,
        operations: {
          ...base.operations,
          grid_build: {
            ...base.operations.grid_build!,
            reason,
            reason_code: `capability_${state}`,
            state,
          },
        },
      };
      const dialog = await mountFdmGridDialog({ activeLane });
      await requestFdmGridBuild(dialog);

      const button = fdmBuildButton(dialog.container);
      expect(button.disabled).toBe(true);
      expect(dialog.container.textContent).toContain(reason);
      expect(dialog.container.textContent).not.toContain(
        "Loading current scene geometry baseline…",
      );
      await act(async () => button.click());
      expect(dialog.resolved).toEqual([]);
    },
  );

  it("does not expose FDM confirmation when the active lane is unknown", async () => {
    const dialog = await mountFdmGridDialog({ activeLane: null });
    await requestFdmGridBuild(dialog);

    expect(findElements(
      dialog.container,
      (element) => element.tagName === "BUTTON" &&
        element.textContent.includes("Build Grid & Materialize Masks"),
    )).toHaveLength(0);
    expect(dialog.container.textContent).toContain("different simulation method");
    expect(dialog.resolved).toEqual([]);
  });

  it("opens the shared Operations projection from mesh build context", () => {
    const calls: string[] = [];

    openMeshBuildDiagnostics({
      bus: {
        emit: (event, payload) => {
          calls.push(`${event}:${payload.tab}:${payload.reason}`);
        },
      },
      layout: {
        setFocusedSlot: (slotId) => {
          calls.push(`focus:${slotId}`);
        },
        setPanelVisible: (panel, visible) => {
          calls.push(`panel:${panel}:${visible}`);
        },
      },
    });

    expect(calls).toEqual([
      "panel:bottom:true",
      "focus:panel-bottom",
      "footer:tab-requested:operations:mesh-build",
    ]);
  });
});
