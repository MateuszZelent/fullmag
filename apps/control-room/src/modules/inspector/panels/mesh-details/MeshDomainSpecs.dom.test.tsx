import {
  mountWave5TestDom,
  type MountedWave5TestDom,
} from "./wave5TestDomSetup.test-support";

import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findElement,
  findElements,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { buildFdmMeshPolicyNode } from "@/modules/explorer/builders/meshExplorerNodes";
import { InspectorEditSessionProvider } from "@/modules/inspector/InspectorEditSession";
import { evaluateFemMeshReadinessGuide } from "../mesh-guide/femMeshReadinessGuide";

const mocks = vi.hoisted(() => ({
  replaceObjectPolicy: vi.fn().mockResolvedValue({
    config: null,
    effective_config: { maximum_element_size: 5e-9, minimum_element_size: 2e-9 },
    object_id: "wg-1",
    revision: 4,
  }),
  patchStudy: vi.fn().mockResolvedValue({}),
  replaceUniversePolicy: vi.fn().mockResolvedValue({
    config: { mode: "auto" },
    effective_config: { mode: "auto" },
    revision: 2,
  }),
  replaceSharedDomainPolicy: vi.fn().mockResolvedValue({
    config: { hmax: 5e-9, hmin: 2e-9 },
    revision: 3,
  }),
  commitTransaction: vi.fn().mockResolvedValue({
    committed_scene: {
      objects: [],
      revision: 4,
      scene_revision: 4,
    },
  }),
  invalidate: vi.fn(),
  executeCommand: vi.fn().mockResolvedValue({ status: "completed" }),
  selectSet: vi.fn(),
  patchTarget: vi.fn(),
  clearTarget: vi.fn(),
  discretization: "fdm" as "fdm" | "fem",
}));

vi.mock("@/shared/charts/ScientificEChart", () => ({
  ScientificEChart: ({ ariaLabel }: { ariaLabel: string }) =>
    createElement("div", {
      "aria-label": ariaLabel,
      "data-slot": "scientific-echart",
    }),
  minMaxFinite: (values: ArrayLike<number>) => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i]!;
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return min <= max ? { min, max } : null;
  },
}));

vi.mock("@/kernel/KernelContext", async () => {
  const { createContext } = await import("react");
  const kernelValue = {
    api: {
      meshing: {
        replaceObjectPolicy: mocks.replaceObjectPolicy,
        replaceUniversePolicy: mocks.replaceUniversePolicy,
        sharedDomain: {
          replacePolicy: mocks.replaceSharedDomainPolicy,
        },
      },
      model: {
        patchStudy: mocks.patchStudy,
        commitTransaction: mocks.commitTransaction,
      },
    },
    bus: { emit: vi.fn(), on: () => () => undefined },
    commands: { execute: mocks.executeCommand },
    diagnosticRecorder: { record: vi.fn() },
    layout: { setActiveTab: vi.fn(), setPanelVisible: vi.fn() },
    resources: {
      get: () => null,
      getRevision: () => 1,
      invalidate: mocks.invalidate,
      subscribe: () => () => undefined,
    },
    selection: {
      clear: vi.fn(),
      get: () => ({
        kind: "mesh.root",
        label: "Mesh",
        moduleSource: "explorer" as const,
        nodeId: "model:mesh",
        objectId: null,
        ref: null,
      }),
      set: mocks.selectSet,
      subscribe: () => () => undefined,
    },
    visualization: {
      clearTarget: mocks.clearTarget,
      getSettings: () => ({
        boundsVisible: false,
        renderMode: "surface",
        surfaceOpacityPercent: 80,
        visible: true,
        wireframeVisible: true,
      }),
      patchTarget: mocks.patchTarget,
    },
  };
  return {
    KernelContext: createContext<unknown>(kernelValue),
    useKernel: () => kernelValue,
  };
});

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  SESSION_STATUS_RESOURCE_KEY: "/session/status",
  useSessionResourceIdentity: () => ({
    requestScopeEpoch: "1",
    sessionEpoch: "1",
    sessionId: "session-mesh-test",
  }),
  useSessionStatusSelector: (selector: (value: never) => unknown) =>
    selector({
      data: {
        domain: { discretization: mocks.discretization },
        resources: {
          mesh_build_revision: 2,
          mesh_revision: 2,
          scene_revision: 3,
        },
      },
    } as never),
}));

vi.mock(
  "@/kernel/resources/geometryLifecycleResources",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/kernel/resources/geometryLifecycleResources")
      >();
    const ready = <T,>(data: T) => ({
      data,
      error: null,
      refetch: vi.fn(),
      revision: 1,
      status: "ready" as const,
    });
    return {
      ...actual,
      MESH_BUILD_CURRENT_RESOURCE_KEY: "/meshing/builds/current",
    MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY: "/meshing/builds/latest-successful",
    MESH_SEMANTICS_RESOURCE_KEY: "/meshing/semantics",
    MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY: "/meshing/policies/shared-domain",
    MESH_SUMMARY_RESOURCE_KEY: "/meshing/summary",
    MESH_UNIVERSE_POLICY_RESOURCE_KEY: "/meshing/policies/universe",
    SCENE_RESOURCE_KEY: "/model/scene",
    publishCommittedSceneResource: vi.fn(),
    resolveObjectMeshPolicyResourceKey: (id: string) => `/meshing/policies/objects/${id}`,
    resolveObjectMeshQualityResourceKey: (id: string) => `/meshing/quality/objects/${id}`,
    resolveObjectMeshReportResourceKey: (id: string) => `/meshing/reports/objects/${id}`,
    useDomainMetaResource: () =>
      ready({
        bounds: { max: [8e-7, 4e-7, 1e-9], min: [-8e-7, -4e-7, -1e-9] },
        generation_id: "gen-fdm-1",
        grid: {
          origin: [-8e-7, -4e-7, -1e-9],
          shape: [256, 128, 1],
          spacing: [6.25e-9, 6.25e-9, 2e-9],
        },
      }),
    useFdmMultilayerLayoutResource: () => ready({ available: false, layers: [] }),
    useGeometryValidationResource: () => ready({ errors: [], valid: true }),
    useMeshBuildCurrent: () =>
      ready({
        active_build: null,
        shared_domain_build_report: {
          operation_statuses: [
            { kind: "Fragment", reason: "Conformal union", status: "succeeded" },
          ],
          thin_film_diagnostics: [
            {
              actual_method: "swept_prism",
              geometry_name: "Waveguide",
              lateral_size: 8e-7,
              thickness: 2e-9,
              warnings: [],
            },
          ],
        },
      }),
    useMeshBuildHistoryResource: () =>
      ready({
        history: [
          {
            build_id: "build-1",
            canonical_policy_snapshot: {
              objects: { "wg-1": { maximum_element_size: 6e-9 } },
              universe: { airbox_hmax: 4e-8, mode: "auto" },
            },
            element_count: 14000,
            id: "entry-1",
            mesh_name: "mesh-v1",
            mesh_target: "object:wg-1",
            node_count: 3100,
            restorable: true,
          },
          {
            build_id: "build-2",
            canonical_policy_snapshot: {
              objects: { "wg-1": { maximum_element_size: 4e-9 } },
              universe: { airbox_hmax: 3e-8, mode: "auto" },
            },
            element_count: 18400,
            id: "entry-2",
            mesh_name: "mesh-v2",
            mesh_target: "study_domain",
            node_count: 4200,
            restorable: true,
          },
        ],
      }),
    useMeshBuildLatestSuccessful: () => ready({ last_success: null }),
    useMeshCapabilitiesResource: () =>
      ready({
        generators: ["gmsh"],
        mesh_capabilities: {
          "mesh.exact_layer_count": {
            status: "validated",
            supported_layer_counts: [1, 2, 3],
          },
          "mesh.swept.prism": { status: "validated" },
          "mesh.topology.mixed_p1": { status: "validated" },
          "mesh.transition.pyramid_tet": { status: "validated" },
        },
      }),
    useMeshSemanticsResource: () =>
      ready({
        mesh_build_diagnostics: {
          mesh_statistics: {
            global: {
              edge_length: { max: 8e-9, mean: 3.42e-9, min: 1.5e-9, std: 1.1e-9 },
              element_count: 100,
              gamma: {
                below_threshold_count: 2,
                below_threshold_fraction: 0.02,
                histogram: [
                  { count: 2, hi: 0.2, lo: 0 },
                  { count: 98, hi: 1.0, lo: 0.2 },
                ],
                max: 0.96,
                mean: 0.74,
                min: 0.05,
                p05: 0.31,
                threshold: 0.2,
              },
            },
            worst_elements: [
              {
                centroid: [0, 0, 0],
                element_index: 42,
                gamma: 0.05,
                scope_label: "wg-1",
                sicn: 0.15,
                volume: 1.2e-27,
              },
            ],
          },
        },
        object_configs: [
          {
            config: { maximum_element_size: 4e-9, minimum_element_size: 2e-9 },
            effective_config: { maximum_element_size: 4e-9, minimum_element_size: 2e-9 },
            object_id: "wg-1",
          },
        ],
        revision: 3,
      }),
    useMeshSharedDomainManifestResource: () =>
      ready({
        domain_mesh_mode: "shared_domain",
        generation_id: "gen-fem-2",
        geometry_realization_revision: 3,
        mesh_id: "mesh-fem-2",
        mesh_name: "shared-domain-v2",
        mesh_parts: [
          {
            element_count: 12000,
            id: "part-wg-1",
            label: "Waveguide Part",
            owner_object_id: "wg-1",
            role: "magnetic",
          },
          {
            element_count: 420,
            id: "orphan-cad-1",
            label: "Imported Bracket",
            owner_object_id: null,
            role: null,
          },
        ],
        object_segments: [{ id: "seg-1" }],
        regions: [{ element_count: 12000, id: "reg-1", owner_object_id: "wg-1" }],
        source_scene_revision: 3,
        topology_counts: { boundary_face_count: 960, element_count: 18400, node_count: 4200 },
      }),
    useMeshSharedDomainPolicyResource: () =>
      ready({
        config: { hmax: 5e-9, hmin: 2e-9 },
        effective_config: {
          curvature_factor: 0.25,
          growth_rate: 1.2,
          hmax: 3.5e-9,
          hmin: 1.5e-9,
          narrow_region_resolution: 3,
          optimize: "Netgen",
        },
        revision: 2,
      }),
    useMeshSharedDomainQualityGatesResource: () =>
      ready({
        gates: {
          checks: [{ id: "min_sicn", status: "failed", value: "-0.014" }],
        },
        mixed_certificate: {
          certificate_fingerprint: "sha256:cert1",
          certificate_schema_version: "mixed_layer_topology_certificate.v1",
          certificate_status: "rejected",
          family_gates: [
            {
              family: "pyramid5",
              metric: "sicn",
              minimum_jacobian_m3: -1.4e-29,
              p05: 0.182,
              passed: false,
              positive_jacobian: false,
              threshold: 0.25,
            },
          ],
          mesh_revision: 2,
          reason: "pyramid5 failed Jacobian positivity",
          status: "rejected",
          topology_fingerprint: "sha256:cert1",
          valid: false,
        },
        statistics: {
          element_count: 100,
          histograms: {
            sicn: {
              bins: [
                { count: 3, max: 0.2, min: -0.1 },
                { count: 97, max: 1.0, min: 0.2 },
              ],
              threshold: 0.25,
            },
          },
          mean_edge_length_m: 3.42e-9,
          min_quality: -0.014,
          p05_quality: 0.182,
        },
      }),
    useMeshSharedDomainRealizedSizeFieldsResource: () =>
      ready({
        realized_size_fields: {
          fields: [
            {
              kind: "Box",
              params: { hmax: 4e-9, hmin: 2e-9 },
              source: "object:wg-1",
              status: "applied",
            },
          ],
        },
      }),
    useMeshSharedDomainQualityResource: () => ready(null),
    useMeshSharedDomainReportResource: () => ready(null),
    useMeshSummaryResource: () => ready({ revision: 2 }),
    useObjectMeshPolicyResource: () =>
      ready({
        config: { maximum_element_size: 4e-9, minimum_element_size: 2e-9 },
        effective_config: { maximum_element_size: 4e-9, minimum_element_size: 2e-9 },
        object_id: "wg-1",
        revision: 3,
      }),
    useObjectMeshQualityResource: () => ready(null),
    useObjectMeshReportResource: () => ready(null),
    useObjectMeshSizeFieldResource: () => ready(null),
    useObjectTopologyResource: () => ready(null),
    useSceneResource: () =>
      ready({
        materials: [
          {
            id: "permalloy",
            name: "Permalloy",
            properties: {
              aex: 13e-12,
              ms: 860e3,
            },
          },
        ],
        objects: [
          {
            geometry: { geometry_kind: "Box", geometry_params: { lx: 1.6e-6, ly: 8e-7, lz: 2e-9 } },
            id: "wg-1",
            material_ref: "permalloy",
            name: "Waveguide",
          },
        ],
        revision: 3,
        scene_revision: 3,
      }),
      useUniverseMeshPolicyResource: () =>
        ready({
          config: null,
          effective_config: { mode: "auto", padding: [8e-8, 8e-8, 1.2e-7] },
          revision: 1,
        }),
    };
  },
);

import {
  MeshBuildsInspectorSpecPanel,
  MeshQualityInspectorSpecPanel,
  MeshRegionsInspectorSpecPanel,
  MeshRootInspectorSpecPanel,
  MeshSharedDomainInspectorSpecPanel,
  MeshSizeFieldsInspectorSpecPanel,
  MeshUnassignedInspectorSpecPanel,
  MeshUnassignedPartInspectorSpecPanel,
  ObjectMeshInspectorSpecPanel,
} from "../../inspectors/mesh";

describe("Task 18 MeshDomainSpecs, l_ex guard, FemMeshReadinessGuide and FDM tree", () => {
  let harness: MountedWave5TestDom;

  beforeEach(() => {
    harness = mountWave5TestDom();
    mocks.replaceObjectPolicy.mockClear();
    mocks.replaceSharedDomainPolicy.mockClear();
    mocks.replaceUniversePolicy.mockClear();
    mocks.commitTransaction.mockClear();
    mocks.executeCommand.mockClear();
    mocks.patchTarget.mockClear();
    mocks.clearTarget.mockClear();
    mocks.discretization = "fdm";
  });

  afterEach(() => {
    harness.unmount();
  });

  it("emits kind 'object.root' from FemMeshReadinessGuide instead of broken 'object'", () => {
    const guide = evaluateFemMeshReadinessGuide({
      geometryValidation: { valid: true },
      scene: {
        objects: [
          {
            geometry: { kind: "box" },
            id: "wg-1",
            material_ref: "unassigned",
            name: "Waveguide",
          },
        ],
        revision: 2,
      },
    });

    const materialsStep = guide.steps.find((step) => step.id === "materials");
    expect(materialsStep?.actionTarget.kind).toBe("select-node");
    if (materialsStep?.actionTarget.kind === "select-node") {
      expect(materialsStep.actionTarget.selection.kind).toBe("object.root");
    }
  });

  it("builds zero selectable:false nodes under Model > Mesh in FDM mode and exposes live mesh.grid and unlocked mesh.builds", () => {
    const tree = buildFdmMeshPolicyNode(null, {
      generation_id: "gen-1",
      grid: {
        origin: [0, 0, 0],
        shape: [256, 128, 1],
        spacing: [5e-9, 5e-9, 2e-9],
      },
    } as never);

    const walk = (node: typeof tree): (typeof tree)[] => [
      node,
      ...(node.children ?? []).flatMap(walk),
    ];
    const allNodes = walk(tree);
    expect(allNodes.filter((n) => n.selectable === false)).toHaveLength(0);
    expect(allNodes.some((n) => n.kind === "mesh.grid")).toBe(true);
    const buildsNode = allNodes.find((n) => n.kind === "mesh.builds");
    expect(buildsNode).toBeDefined();
    expect(buildsNode?.selectable).not.toBe(false);
    expect(allNodes.some((n) => n.kind === "mesh.quality")).toBe(false);
    expect(allNodes.some((n) => n.kind === "mesh.size-fields")).toBe(false);
  });

  it("renders exchange-length l_ex warning and quick-fix button in mesh.root when delta_x = 6.25 nm > l_ex = 5.29 nm (Permalloy)", async () => {
    mocks.discretization = "fdm";
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

    const notice = findElement(
      harness.container,
      (el) => el.getAttribute("data-slot") === "inspector-notice",
    );
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("5.29");
    expect(notice?.textContent).toContain("Permalloy");

    const quickFixBtn = findElement(
      harness.container,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Set Δ")),
    );
    expect(quickFixBtn).not.toBeNull();
  });

  it("restores Load Effective Defaults in FEM mesh.root and persists canonical ScriptBuilderMeshState keys", async () => {
    mocks.discretization = "fem";
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
    const sentPayload = mocks.replaceSharedDomainPolicy.mock.calls[0]?.[0];
    expect(sentPayload).not.toHaveProperty("base_revision");
    expect(sentPayload.config).toMatchObject({
      curvature_factor: "0.25",
      growth_rate: "1.2",
      hmax: "3.5e-9",
      hmin: "1.5e-9",
      narrow_region_resolution: "3",
      optimize: "Netgen",
    });
  });

  it("sends PUT .../meshing/policies/objects/{id} with config: null when returning object.mesh to Inherit (zero DELETE)", async () => {
    mocks.discretization = "fem";
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(ObjectMeshInspectorSpecPanel, {
            selection: {
              kind: "object.mesh",
              label: "Mesh",
              moduleSource: "explorer",
              nodeId: "model:object:wg-1:mesh",
              objectId: "wg-1",
              ref: null,
            },
          }),
        ),
      );
    });

    const inheritBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Inherit shared domain")),
    );
    expect(inheritBtn).not.toBeNull();
    await act(async () => {
      inheritBtn!.click();
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

    expect(mocks.replaceObjectPolicy).toHaveBeenCalledTimes(1);
    expect(mocks.replaceObjectPolicy.mock.calls[0]?.[0]).toBe("wg-1");
    expect(mocks.replaceObjectPolicy.mock.calls[0]?.[1]).toMatchObject({
      config: null,
    });
    expect(mocks.replaceObjectPolicy.mock.calls[0]?.[1]).not.toHaveProperty(
      "base_revision",
    );
  });

  it("renders Build Object Mesh, Build Shared-Domain Mesh, Refinement, Quality, and History tabs in object.mesh", async () => {
    mocks.discretization = "fem";
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(ObjectMeshInspectorSpecPanel, {
            selection: {
              kind: "object.mesh",
              label: "Mesh",
              moduleSource: "explorer",
              nodeId: "model:object:wg-1:mesh",
              objectId: "wg-1",
              ref: null,
            },
          }),
        ),
      );
    });

    const buildObjectBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Build Object Mesh")),
    );
    expect(buildObjectBtn).not.toBeNull();

    const buildSharedBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Build Shared-Domain Mesh")),
    );
    expect(buildSharedBtn).not.toBeNull();

    expect(harness.container.textContent).toContain("Refinement & Fields");
    expect(harness.container.textContent).toContain("Quality");
    expect(harness.container.textContent).toContain("History");
  });

  it("renders SolverMeshIdentity, Counts & Extents, and Capabilities on mesh.shared-domain without fabricated keys", async () => {
    mocks.discretization = "fem";
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(MeshSharedDomainInspectorSpecPanel, {
            selection: {
              kind: "mesh.shared-domain",
              label: "Shared Domain",
              moduleSource: "explorer",
              nodeId: "model:mesh:shared-domain",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    expect(harness.container.textContent).toContain("shared-domain-v2");
    expect(harness.container.textContent).toContain("18,400");
    expect(harness.container.textContent).toContain("960");
  });

  it("unwraps realized_size_fields.fields and renders Thin-film diagnostics on mesh.size-fields", async () => {
    mocks.discretization = "fem";
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(MeshSizeFieldsInspectorSpecPanel, {
            selection: {
              kind: "mesh.size-fields",
              label: "Size Fields",
              moduleSource: "explorer",
              nodeId: "model:mesh:size-fields",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    expect(harness.container.textContent).toContain("Box · object:wg-1");
    expect(harness.container.textContent).toContain("Waveguide");
    expect(harness.container.textContent).toContain("swept_prism");
  });

  it("renders ScientificEChart, failed family gate rows, Show heatmap, Refine worst region, and Worst elements in mesh.quality", async () => {
    mocks.discretization = "fem";
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(MeshQualityInspectorSpecPanel, {
            selection: {
              kind: "mesh.quality",
              label: "Quality Gates",
              moduleSource: "explorer",
              nodeId: "model:mesh:quality",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    const chart = findElement(
      harness.container,
      (el) => el.getAttribute("data-slot") === "scientific-echart",
    );
    expect(chart).not.toBeNull();

    const failedGates = findElements(
      harness.container,
      (el) => el.getAttribute("data-status") === "failed",
    );
    expect(failedGates.length).toBeGreaterThan(0);
    expect(failedGates.some((el) => el.textContent?.includes("pyramid5"))).toBe(true);
    expect(harness.container.textContent).toContain("Show heatmap");
    expect(harness.container.textContent).toContain("Refine worst region");
    expect(harness.container.textContent).toContain("Element 42");
  });

  it("renders real build comparison diff and Restore buttons on mesh.builds without fake FDM timings", async () => {
    mocks.discretization = "fem";
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(MeshBuildsInspectorSpecPanel, {
            selection: {
              kind: "mesh.builds",
              label: "Build History",
              moduleSource: "explorer",
              nodeId: "model:mesh:builds",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    expect(harness.container.textContent).toContain("Build #1 vs Build #2");
    expect(harness.container.textContent).toContain("+4,400");
    expect(harness.container.textContent).toContain("Restore object policy to draft");
    expect(harness.container.textContent).toContain("Restore Airbox policy to draft");
  });

  it("renders hierarchy on mesh.regions and commits canonical merge_patch on mesh.unassigned.part", async () => {
    mocks.discretization = "fem";
    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(MeshRegionsInspectorSpecPanel, {
            selection: {
              kind: "mesh.regions",
              label: "Regions",
              moduleSource: "explorer",
              nodeId: "model:mesh:regions",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });
    expect(harness.container.textContent).toContain("Waveguide");
    expect(harness.container.textContent).toContain("Waveguide Part");

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(MeshUnassignedInspectorSpecPanel, {
            selection: {
              kind: "mesh.unassigned",
              label: "Unassigned",
              moduleSource: "explorer",
              nodeId: "model:mesh:unassigned",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });
    expect(harness.container.textContent).toContain("Imported Bracket");

    await act(async () => {
      harness.root.render(
        createElement(
          InspectorEditSessionProvider,
          null,
          createElement(MeshUnassignedPartInspectorSpecPanel, {
            selection: {
              kind: "mesh.unassigned.part",
              label: "Imported Bracket",
              moduleSource: "explorer",
              nodeId: "model:mesh:unassigned:orphan-cad-1",
              objectId: null,
              ref: {
                carrierPartId: "orphan-cad-1",
                kind: "mesh-part",
                nodeId: "model:mesh:unassigned:orphan-cad-1",
                objectId: null,
                type: "mesh-part",
                visualizationTargetId: "mesh-part:orphan-cad-1",
              },
            },
          }),
        ),
      );
    });

    const ownershipTab = findElement(
      harness.container,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Ownership")),
    );
    expect(ownershipTab).not.toBeNull();
    await act(async () => {
      ownershipTab!.click();
    });

    const excludeBtn = findElement(
      harness.container,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Exclude part")),
    );
    expect(excludeBtn).not.toBeNull();
    await act(async () => {
      excludeBtn!.click();
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

    expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
    const tx = mocks.commitTransaction.mock.calls[0]?.[0];
    expect(tx.kind).toBe("merge_patch");
    expect(tx).not.toHaveProperty("patch");
    expect(tx.merge_patch.editor.mesh_part_assignments["orphan-cad-1"]).toEqual({
      action: "ignore_nonphysical",
    });
  });

  it("locks mesh.root discretization strictly to the session mode (read-only FDM vs FEM, no editable lane switcher, no patchStudy mutation)", async () => {
    mocks.discretization = "fdm";
    mocks.patchStudy.mockClear();
    mocks.commitTransaction.mockClear();

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

    // FDM session: read-only Session method, no editable FDM Grid / FEM Mesh toggle, ONLY FDM controls
    expect(harness.container.textContent).toContain("Session method");
    expect(harness.container.textContent).toContain("FDM (Structured Grid)");
    expect(harness.container.textContent).toContain(
      "Assigned by the session simulation mode",
    );
    expect(harness.container.textContent).toContain("Global FDM grid sizing");
    expect(harness.container.textContent).toContain("Z-stack mode");
    expect(harness.container.textContent).not.toContain(
      "Global FEM sizing & narrow-region resolution",
    );
    expect(harness.container.textContent).not.toContain("Load Effective Defaults");
    expect(
      findElements(
        harness.container,
        (el) =>
          el.tagName === "BUTTON" &&
          Boolean(
            el.textContent?.includes("FDM Grid") ||
              el.textContent?.includes("FEM Mesh"),
          ),
      ),
    ).toHaveLength(0);

    // Editing FDM Z-stack mode commits study.fdm without mutating requested_backend via patchStudy
    const multilayerBtn = findElement(
      harness.container,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Multilayer Z-slices")),
    );
    expect(multilayerBtn).not.toBeNull();
    await act(async () => {
      multilayerBtn!.click();
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

    expect(mocks.patchStudy).not.toHaveBeenCalled();
    expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);

    // FEM session: read-only Session method, no editable FDM Grid / FEM Mesh toggle, ONLY FEM controls
    mocks.discretization = "fem";
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
              nodeId: "model:mesh:fem",
              objectId: null,
              ref: null,
            },
          }),
        ),
      );
    });

    expect(harness.container.textContent).toContain("Session method");
    expect(harness.container.textContent).toContain("FEM (Unstructured Mesh)");
    expect(harness.container.textContent).toContain(
      "Global FEM sizing & narrow-region resolution",
    );
    expect(harness.container.textContent).toContain("Load Effective Defaults");
    expect(harness.container.textContent).not.toContain("Global FDM grid sizing");
    expect(harness.container.textContent).not.toContain("Z-stack mode");
    expect(
      findElements(
        harness.container,
        (el) =>
          el.tagName === "BUTTON" &&
          Boolean(
            el.textContent?.includes("FDM Grid") ||
              el.textContent?.includes("FEM Mesh"),
          ),
      ),
    ).toHaveLength(0);
  });
});
