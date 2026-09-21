import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AntennaFieldSolutionResource,
  AntennaStageOutputCatalogResource,
  AntennaSourceSpectrumResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  installSimulationPreparationTestDom,
  TestElement,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

const mocks = vi.hoisted(() => ({
  fieldSolution: {
    data: null as AntennaFieldSolutionResource | null,
    error: null as Error | null,
    refetch: vi.fn(),
    revision: null as string | null,
    status: "idle" as "idle" | "loading" | "ready" | "stale" | "error",
  },
  sourceSpectrum: {
    data: null as AntennaSourceSpectrumResource | null,
    error: null as Error | null,
    refetch: vi.fn(),
    revision: null as string | null,
    status: "idle" as "idle" | "loading" | "ready" | "stale" | "error",
  },
  stageOutputCatalog: {
    data: null as AntennaStageOutputCatalogResource | null,
    error: null as Error | null,
    refetch: vi.fn(),
    revision: null as string | null,
    status: "idle" as "idle" | "loading" | "ready" | "stale" | "error",
  },
  scene: {
    data: null as SceneResource | null,
    error: null as Error | null,
    refetch: vi.fn(),
    revision: null as number | null,
    status: "ready" as "idle" | "loading" | "ready" | "stale" | "error",
  },
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useSceneResource: () => mocks.scene,
}));

vi.mock("@/kernel/resources/antennaResources", () => ({
  useAntennaFieldSolutionResource: () => mocks.fieldSolution,
  useAntennaStageOutputCatalogResource: () => mocks.stageOutputCatalog,
  useAntennaSourceSpectrumResource: () => mocks.sourceSpectrum,
}));

import { AntennaCompositionPanel } from "./AntennaCompositionPanels";

afterEach(() => {
  mocks.fieldSolution.data = null;
  mocks.fieldSolution.status = "idle";
  mocks.sourceSpectrum.data = null;
  mocks.sourceSpectrum.status = "idle";
  mocks.stageOutputCatalog.data = null;
  mocks.stageOutputCatalog.status = "idle";
  mocks.scene.data = null;
});

describe("AntennaCompositionPanel runtime results", () => {
  it("uses a ready field-solution resource for the solution Inspector", async () => {
    mocks.scene.data = sceneFixture();
    mocks.fieldSolution.status = "ready";
    mocks.fieldSolution.data = fieldSolutionFixture();
    mocks.stageOutputCatalog.status = "ready";
    mocks.stageOutputCatalog.data = stageOutputCatalogFixture();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <AntennaCompositionPanel kind="solution" selection={solutionSelection()} />,
        ),
      );
      expect(container.textContent).toContain("Published solutionsolution-1");
      expect(container.textContent).toContain("Runtime resultready");
      expect(container.textContent).toContain("Field signaturesha256:field");
      expect(container.textContent).toContain("Stage catalog resultready");
      expect(container.textContent).toContain("Stage quantitiesH_ant_basis");
      expect(container.textContent).toContain("Stage assetsasset-1");
      expect(container.textContent).toContain("Stage reusesolution-1: published");
      expect(container.textContent).toContain("Stage manifestsmanifest.json");
      expect(findGroupBadge(container, "ready")).toBeDefined();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function sceneFixture(): SceneResource {
  return {
    antenna_field_solve_stages: [
      {
        id: "solve-1",
        outputs: [{ id: "solution-1", quantity: "H_ant_basis" }],
      },
    ],
  } as unknown as SceneResource;
}

function fieldSolutionFixture(): AntennaFieldSolutionResource {
  return {
    asset_id: "asset-1",
    assumptions: [],
    bases: [],
    component: "vector_basis",
    conductor_positions: {
      layout: "xyz",
      path: "conductor.f64le",
      scalar_type: "f64",
      sha256: "sha256:conductor",
      unit: "m",
      value_count: 3,
    },
    content_digest: "sha256:solution",
    current_transport_id: "current-1",
    gauge_policy: "zero_mean",
    geometry_revision: "geometry-1",
    material_revision: "material-1",
    mesh_digest: "mesh-1",
    quantity: "H_ant_basis",
    requested_execution: {},
    resolved_execution: {},
    resource_id: "antenna/field-solution/solution-1",
    sample_positions: {
      layout: "xyz",
      path: "samples.f64le",
      scalar_type: "f64",
      sha256: "sha256:samples",
      unit: "m",
      value_count: 6,
    },
    sample_topology: null,
    schema_version: "antenna_field_solution.v1",
    session_epoch: "epoch-1",
    session_id: "session-1",
    signatures: {
      current_solution_signature: "sha256:current",
      field_solution_signature: "sha256:field",
      target_projection_signatures: {},
    },
    solution_id: "solution-1",
    solver_policy: {},
    source_object_id: "antenna-1",
    stage_id: "solve-1",
    status: "ready",
    target_projection_signature: null,
  };
}

function stageOutputCatalogFixture(): AntennaStageOutputCatalogResource {
  return {
    content_digest: "sha256:catalog",
    diagnostic: null,
    outputs: [
      {
        kind: "field_solution",
        manifest_ref: "manifest.json",
        output_id: "solution-1",
        quantity_ids: ["H_ant_basis"],
        reused_existing: false,
        solution_ref: {
          asset_id: "asset-1",
          content_digest: "sha256:solution",
          output_id: "solution-1",
          stage_id: "solve-1",
        },
      },
    ],
    port_mode_id: "port-1",
    resource_id: "antenna/stage-output-catalog/solve-1",
    schema_version: "antenna_stage_output_catalog.v1",
    session_epoch: "epoch-1",
    session_id: "session-1",
    solution_id: "solution-1",
    stage_id: "solve-1",
    stage_kind: "antenna_field_solve",
    stage_revision: 3,
    status: "ready",
  };
}

function solutionSelection(): Selection {
  return {
    kind: "object.antenna.solution",
    label: "Field solve solve-1",
    moduleSource: "explorer",
    nodeId: "object:antenna-1:antenna:solution:solve-1",
    objectId: "antenna-1",
    ref: {
      kind: "object.antenna.solution",
      nodeId: "object:antenna-1:antenna:solution:solve-1",
      objectId: "antenna-1",
      type: "scene-object",
      visualizationTargetId: "object:antenna-1",
      antennaResourceId: "solve-1",
      antennaResourceKind: "solution",
    },
  } as Selection;
}

function findGroupBadge(root: TestNode, text: string): TestElement | undefined {
  const groups: TestElement[] = [];
  const visit = (node: TestNode): void => {
    if (node instanceof TestElement && node.getAttribute("data-slot") === "inspector-group") {
      const badge = node.querySelector(".fm-badge");
      if (badge?.textContent === text) groups.push(node);
    }
    node.childNodes.forEach(visit);
  };
  visit(root);
  return groups[0];
}
