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
  replaceUniversePolicy: vi.fn().mockResolvedValue({}),
  replaceSharedDomainPolicy: vi.fn().mockResolvedValue({}),
  invalidate: vi.fn(),
  executeCommand: vi.fn().mockResolvedValue(undefined),
  selectSet: vi.fn(),
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
        commitTransaction: vi.fn().mockResolvedValue({}),
      },
    },
    bus: { emit: vi.fn(), on: () => () => undefined },
    commands: { execute: mocks.executeCommand },
    diagnosticRecorder: { record: vi.fn() },
    layout: { setPanelVisible: vi.fn() },
    resources: {
      get: () => null,
      getRevision: () => 1,
      invalidate: mocks.invalidate,
      subscribe: () => () => undefined,
    },
    selection: { set: mocks.selectSet },
  };
  return {
    KernelContext: createContext<unknown>(kernelValue),
    useKernel: () => kernelValue,
  };
});

vi.mock("@/kernel/resources/useSessionStatus", () => ({
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

vi.mock("@/kernel/resources/geometryLifecycleResources", () => {
  const ready = <T,>(data: T) => ({
    data,
    error: null,
    refetch: vi.fn(),
    revision: 1,
    status: "ready" as const,
  });
  return {
    MESH_SEMANTICS_RESOURCE_KEY: "/meshing/semantics",
    MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY: "/meshing/policies/shared-domain",
    MESH_SUMMARY_RESOURCE_KEY: "/meshing/summary",
    MESH_UNIVERSE_POLICY_RESOURCE_KEY: "/meshing/policies/universe",
    SCENE_RESOURCE_KEY: "/model/scene",
    resolveObjectMeshPolicyResourceKey: (id: string) => `/meshing/policies/objects/${id}`,
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
    useMeshBuildCurrent: () => ready({ active_build: null }),
    useMeshBuildHistoryResource: () => ready({ entries: [] }),
    useMeshBuildLatestSuccessful: () => ready({ last_success: null }),
    useMeshCapabilitiesResource: () => ready({ generators: ["gmsh"] }),
    useMeshSemanticsResource: () =>
      ready({
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
        generation_id: "gen-fem-2",
        mesh_id: "mesh-fem-2",
        source_scene_revision: 3,
        topology_counts: { elements: 18400, nodes: 4200 },
      }),
    useMeshSharedDomainPolicyResource: () =>
      ready({
        config: { maximum_element_size: 5e-9, minimum_element_size: 2e-9 },
        effective_config: { maximum_element_size: 5e-9, minimum_element_size: 2e-9 },
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
    useMeshSharedDomainRealizedSizeFieldsResource: () => ready({ fields: [] }),
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
});

import {
  MeshQualityInspectorSpecPanel,
  MeshRootInspectorSpecPanel,
  ObjectMeshInspectorSpecPanel,
} from "./MeshDomainSpecs";

describe("Task 18 MeshDomainSpecs, l_ex guard, FemMeshReadinessGuide and FDM tree", () => {
  let harness: MountedWave5TestDom;

  beforeEach(() => {
    harness = mountWave5TestDom();
    mocks.replaceObjectPolicy.mockClear();
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
  });

  it("renders ScientificEChart and failed family gate rows with data-status='failed' in mesh.quality", async () => {
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
  });
});
