import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findElement } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { InspectorEditSessionProvider } from "@/modules/inspector/InspectorEditSession";

import {
  mountWave5TestDom,
  type MountedWave5TestDom,
} from "../../panels/mesh-details/wave5TestDomSetup.test-support";
import {
  applyMeshRootFemPolicy,
  buildEffectiveFemDefaultsPatch,
  type MeshRootDraft,
} from "./meshRootModel";
import { MeshRootInspectorSpecPanel } from "./MeshRootSpec";

const mocks = vi.hoisted(() => ({
  commitTransaction: vi.fn(),
  discretization: "fem" as "fdm" | "fem",
  domainMeta: null as Record<string, unknown> | null,
  executeCommand: vi.fn(),
  fetchSessionStatus: vi.fn(),
  invalidate: vi.fn(),
  manifest: null as Record<string, unknown> | null,
  replaceSharedDomainPolicy: vi.fn(),
  replaceUniversePolicy: vi.fn(),
  scene: {
    materials: [],
    objects: [
      {
        geometry: {
          geometry_kind: "Box",
          geometry_params: { length: 100e-9, thickness: 20e-9, width: 100e-9 },
        },
        id: "box-1",
        material_ref: "py",
        name: "New box",
        role: "magnet",
      },
    ],
    revision: 5,
    scene_revision: 5,
    study: { stages: [{ kind: "relax" }] },
  } as Record<string, unknown>,
  sessionStatusData: {
    discretization: "fem",
    resources: { mesh_revision: 1, scene_revision: 5 },
    session_id: "sess-w5",
  } as Record<string, unknown>,
  sessionStatusRefetch: vi.fn(),
  sharedPolicy: {
    config: null,
    effective_config: {
      curvature_factor: 0.2,
      growth_rate: 1.3,
      hmax: "auto",
      hmin: 1e-9,
      narrow_region_resolution: 2,
      optimize: "Netgen",
    },
    revision: 1,
  } as Record<string, unknown>,
  universePolicy: {
    config: {},
    effective_config: {},
    revision: 1,
  } as Record<string, unknown>,
}));

vi.mock("@/kernel/KernelContext", async () => {
  const { createContext } = await import("react");
  const kernelValue = {
    api: {
      meshing: {
        replaceUniversePolicy: mocks.replaceUniversePolicy,
        sharedDomain: {
          replacePolicy: mocks.replaceSharedDomainPolicy,
        },
      },
      model: {
        commitTransaction: mocks.commitTransaction,
      },
      resourceCacheScope: "test-scope",
      sessions: {
        current: {
          status: mocks.fetchSessionStatus,
        },
      },
    },
    commands: {
      execute: mocks.executeCommand,
    },
    resources: {
      invalidate: mocks.invalidate,
    },
    selection: {
      set: vi.fn(),
    },
  };
  return {
    KernelContext: createContext(kernelValue),
    useKernel: () => kernelValue,
  };
});

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  SESSION_STATUS_RESOURCE_KEY: "session:status",
  useSessionResourceIdentity: () => ({
    sessionEpoch: 1,
    sessionId: "sess-w5",
  }),
  useSessionStatusSelector: (
    selector: (state: {
      data: Record<string, unknown>;
      refetch: () => void;
    }) => unknown,
  ) =>
    selector({
      data: {
        ...mocks.sessionStatusData,
        domain: { discretization: mocks.discretization },
      },
      refetch: mocks.sessionStatusRefetch,
    }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY: "mesh:shared-domain-policy",
  MESH_SEMANTICS_RESOURCE_KEY: "mesh:semantics",
  MESH_SUMMARY_RESOURCE_KEY: "mesh:summary",
  MESH_UNIVERSE_POLICY_RESOURCE_KEY: "mesh:universe-policy",
  SCENE_RESOURCE_KEY: "model:scene",
  publishCommittedSceneResource: vi.fn(),
  useDomainMetaResource: () => ({
    data: mocks.domainMeta,
    error: null,
    status: "ready",
  }),
  useFdmMultilayerLayoutResource: () => ({
    data: { available: false, layers: [] },
    error: null,
    status: "ready",
  }),
  useMeshBuildCurrent: () => ({
    data: null,
    error: null,
    status: "ready",
  }),
  useMeshSharedDomainManifestResource: () => ({
    data: mocks.manifest,
    error: null,
    status: "ready",
  }),
  useMeshSharedDomainPolicyResource: () => ({
    data: mocks.sharedPolicy,
    error: null,
    status: "ready",
  }),
  useMeshSummaryResource: () => ({
    data: { revision: 1 },
    error: null,
    status: "ready",
  }),
  useSceneResource: () => ({
    data: mocks.scene,
    error: null,
    status: "ready",
  }),
  useUniverseMeshPolicyResource: () => ({
    data: mocks.universePolicy,
    error: null,
    status: "ready",
  }),
}));

vi.mock("../../panels/mesh-guide/FemMeshReadinessGuideCard", () => ({
  FemMeshReadinessGuideCard: () => createElement("div", { "data-testid": "fem-guide" }),
}));

describe("MeshRootSpec W5 regressions", () => {
  let harness: MountedWave5TestDom;

  beforeEach(() => {
    harness = mountWave5TestDom();
    vi.clearAllMocks();
    mocks.discretization = "fem";
    mocks.domainMeta = null;
    mocks.manifest = null;
    mocks.replaceSharedDomainPolicy.mockResolvedValue({
      config: { hmax: "5e-9" },
      revision: 2,
    });
    mocks.replaceUniversePolicy.mockResolvedValue({
      config: {},
      revision: 2,
    });
    mocks.commitTransaction.mockResolvedValue({
      committed_scene: {
        ...mocks.scene,
        revision: 7,
        scene_revision: 7,
      },
    });
    mocks.fetchSessionStatus.mockResolvedValue({
      discretization: "fdm",
      resources: { mesh_revision: 1, scene_revision: 7 },
      session_id: "sess-w5",
    });
    mocks.executeCommand.mockResolvedValue({ status: "completed" });
    mocks.sessionStatusData = {
      discretization: "fem",
      resources: { mesh_revision: 1, scene_revision: 5 },
      session_id: "sess-w5",
    };
    mocks.sharedPolicy = {
      config: null,
      effective_config: {
        curvature_factor: 0.2,
        growth_rate: 1.3,
        hmax: "auto",
        hmin: 1e-9,
        narrow_region_resolution: 2,
        optimize: "Netgen",
      },
      revision: 1,
    };
    mocks.universePolicy = {
      config: {},
      effective_config: {},
      revision: 1,
    };
  });

  afterEach(() => {
    harness.unmount();
  });

  it("omits PUT /meshing/policies/universe when airbox_hmax is unset, and sends it when airbox_hmax is positive", async () => {
    const baseDraft: MeshRootDraft = {
      anisotropyLimit: 10,
      cellSizeM: [4e-9, 4e-9, 4e-9],
      curvatureFactor: 0.2,
      elementsAcrossThickness: 2,
      enableNarrowRegionRefinement: true,
      fftSmoothSnap: true,
      gridCountX: 25,
      gridCountY: 25,
      gridCountZ: 5,
      growthRate: 1.3,
      hmaxM: 5e-9,
      hminM: 1e-9,
      lane: "fem",
      narrowRegionResolution: 2,
      optimizeMethod: "Netgen",
      optimizeQuality: true,
      sizingMode: "cell_size",
      zStackMode: "single_3d",
    };
    const kernel = {
      api: {
        meshing: {
          replaceUniversePolicy: mocks.replaceUniversePolicy,
          sharedDomain: { replacePolicy: mocks.replaceSharedDomainPolicy },
        },
        resourceCacheScope: "test-scope",
      },
      resources: { invalidate: mocks.invalidate },
    } as never;

    // Without airbox_hmax -> must NOT send universe policy (would HTTP 400)
    await applyMeshRootFemPolicy({
      draft: baseDraft,
      kernel,
      sessionScopeKey: "scope-1",
      sharedPolicyData: mocks.sharedPolicy as never,
      universePolicyData: { config: {}, effective_config: {}, revision: 1 } as never,
    });
    expect(mocks.replaceSharedDomainPolicy).toHaveBeenCalledTimes(1);
    expect(mocks.replaceUniversePolicy).not.toHaveBeenCalled();

    // With explicit positive airbox_hmax -> allowed to update universe policy
    await applyMeshRootFemPolicy({
      draft: baseDraft,
      kernel,
      sessionScopeKey: "scope-1",
      sharedPolicyData: mocks.sharedPolicy as never,
      universePolicyData: {
        config: { airbox_hmax: 20e-9 },
        effective_config: { airbox_hmax: 20e-9 },
        revision: 1,
      } as never,
    });
    expect(mocks.replaceUniversePolicy).toHaveBeenCalledTimes(1);
  });

  it("always populates explicit numeric hmaxM in buildEffectiveFemDefaultsPatch and enables Apply on Load Effective Defaults", async () => {
    const patch = buildEffectiveFemDefaultsPatch(
      mocks.sharedPolicy as never,
      mocks.universePolicy as never,
      8e-9,
    );
    expect(patch.hmaxM).toBe(8e-9);

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(MeshRootInspectorSpecPanel, {
            selection: {
              kind: "mesh.root",
              label: "Mesh",
              moduleSource: "explorer",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    const loadDefaultsBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Load Effective Defaults")),
    );
    expect(loadDefaultsBtn).not.toBeNull();
    await act(async () => {
      loadDefaultsBtn!.click();
    });

    const applyBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Apply")) &&
        !el.disabled,
    );
    expect(applyBtn).not.toBeNull();
    await act(async () => {
      applyBtn!.click();
    });

    expect(mocks.replaceSharedDomainPolicy).toHaveBeenCalledTimes(1);
    expect(mocks.replaceSharedDomainPolicy.mock.calls[0]?.[0]?.config?.hmax).toBe("5e-9");
    expect(mocks.replaceUniversePolicy).not.toHaveBeenCalled();
  });

  it("passes freshly committed scene_revision into session:status resourceData when running FDM Save & Build Grid", async () => {
    mocks.discretization = "fdm";
    mocks.domainMeta = null;

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(MeshRootInspectorSpecPanel, {
            selection: {
              kind: "mesh.root",
              label: "Mesh",
              moduleSource: "explorer",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    const saveAndBuildBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Save & Build Grid")),
    );
    expect(saveAndBuildBtn).not.toBeNull();
    await act(async () => {
      saveAndBuildBtn!.click();
    });

    expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      "grid.build-fdm",
      expect.objectContaining({
        resourceData: expect.objectContaining({
          "session:status": expect.objectContaining({
            resources: expect.objectContaining({
              scene_revision: 7,
            }),
          }),
        }),
      }),
    );
    expect(mocks.sessionStatusRefetch).toHaveBeenCalled();
  });

  it("requires explicit AlertDialog confirmation before rebuilding an already-materialized FEM mesh", async () => {
    mocks.discretization = "fem";
    mocks.manifest = {
      mesh_id: "mesh-1",
      source_scene_revision: 5,
      topology_counts: { element_count: 1200, node_count: 450 },
    };

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(MeshRootInspectorSpecPanel, {
            selection: {
              kind: "mesh.root",
              label: "Mesh",
              moduleSource: "explorer",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    const rebuildBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Rebuild Shared-Domain Mesh")),
    );
    expect(rebuildBtn).not.toBeNull();
    await act(async () => {
      rebuildBtn!.click();
    });

    // Must NOT have executed yet — confirmation dialog must be open
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    const dialog = findElement(
      document.body as never,
      (el) => el.getAttribute("role") === "alertdialog",
      "alertdialog",
    );
    expect(dialog).not.toBeNull();

    // Confirm rebuild inside AlertDialog
    const confirmBtn = findElement(
      dialog,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Rebuild Shared-Domain Mesh")),
      "confirm-rebuild-button",
    );
    expect(confirmBtn).not.toBeNull();
    await act(async () => {
      confirmBtn.click();
    });

    expect(mocks.executeCommand).toHaveBeenCalledWith(
      "mesh.build-shared-domain",
      expect.objectContaining({ sourceDetail: "mesh.root.footer" }),
    );
  });
});
