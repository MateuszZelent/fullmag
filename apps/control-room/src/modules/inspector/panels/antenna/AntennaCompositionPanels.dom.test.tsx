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
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

const mocks = vi.hoisted(() => ({
  commitTransaction: vi.fn(),
  invalidate: vi.fn(),
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

vi.mock("@/kernel/KernelContext", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/kernel/KernelContext")>(),
  useKernel: () => ({
    api: { model: { commitTransaction: mocks.commitTransaction } },
    resources: { invalidate: mocks.invalidate },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  publishCommittedSceneResource: vi.fn(),
  useSceneResource: () => mocks.scene,
}));

vi.mock("@/kernel/resources/useSessionStatus", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/kernel/resources/useSessionStatus")>(),
  useSessionResourceIdentity: () => ({
    sessionId: "session-1",
    sessionEpoch: "epoch-1",
    requestScopeEpoch: "instance-1:7",
  }),
}));

// This composition fixture does not qualify placement bounds or their resource lifecycle.
vi.mock("@/kernel/resources/useGeometryRealizationResource", () => ({
  useGeometryRealizationResource: () => ({
    data: null,
    error: null,
    refetch: vi.fn(),
    revision: null,
    status: "idle",
  }),
}));

vi.mock("@/kernel/resources/antennaResources", () => ({
  antennaFieldPayloadEtag: () => '"field-payload"',
  useAntennaFieldSolutionResource: () => mocks.fieldSolution,
  useAntennaFieldSolutionPayloadResource: (
    _solutionId: string,
    kind: string | null,
  ) => ({
    data: kind ? {
      status: "ready",
      data: new Float64Array(kind === "sample_positions"
        ? [1e-9, 2e-9, 3e-9, 4e-9, 5e-9, 6e-9]
        : [1, -2, 3, 4, -5, 6]).buffer,
    } : null,
    error: null,
    status: kind ? "ready" : "idle",
  }),
  useAntennaStageOutputCatalogResource: () => mocks.stageOutputCatalog,
  useAntennaSourceSpectrumResource: () => mocks.sourceSpectrum,
}));

// The inspection panel has its own real-browser resource/identity proof.
vi.mock("./AntennaExternalLeadInspectionPanel", () => ({
  AntennaExternalLeadInspectionPanel: ({ authoredStageId }: { authoredStageId: string }) => (
    <div data-testid="antenna-inspection-composition-binding">{authoredStageId}</div>
  ),
}));

import { AntennaCompositionPanel } from "./AntennaCompositionPanels";

afterEach(() => {
  mocks.commitTransaction.mockReset();
  mocks.invalidate.mockReset();
  mocks.fieldSolution.data = null;
  mocks.fieldSolution.status = "idle";
  mocks.sourceSpectrum.data = null;
  mocks.sourceSpectrum.status = "idle";
  mocks.stageOutputCatalog.data = null;
  mocks.stageOutputCatalog.status = "idle";
  mocks.scene.data = null;
  mocks.scene.status = "ready";
  mocks.scene.refetch.mockReset();
});

describe("AntennaCompositionPanel runtime results", () => {
  it("authors the per-ampere source FFT from a symbolic solve output", async () => {
    mocks.scene.data = {
      revision: 15,
      objects: [{ id: "antenna-1" }, { id: "magnet-1" }],
      antenna_field_solve_stages: [{
        id: "solve-1", source_object_id: "antenna-1", current_transport_id: "current-1",
        port_mode_ids: ["port-1"], outputs: [{ id: "basis-1", quantity: "H_ant_basis" }],
        field_sampling_domain: { kind: "global" }, target_refs: [],
      }],
      antenna_port_modes: [{ id: "port-1", source_object_id: "antenna-1", current_transport_id: "current-1" }],
      antenna_spectrum_requests: [],
    } as unknown as SceneResource;
    mocks.commitTransaction.mockResolvedValue({ scene_revision: 16 });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const find = (tag: string, label: string): TestElement => {
      const found: TestElement[] = [];
      const visit = (node: TestNode) => {
        if (node instanceof TestElement && node.tagName === tag &&
          (node.getAttribute("aria-label") === label || node.textContent.includes(label))) found.push(node);
        node.childNodes.forEach(visit);
      };
      visit(container);
      if (!found[0]) throw new Error(`Missing ${label}`);
      return found[0];
    };
    try {
      await act(async () => root.render(<AntennaCompositionPanel kind="solution" selection={solutionSelection()} />));
      expect(container.textContent).toContain("not the spin-wave response");
      const target = find("SELECT", "FFT target object");
      target.value = "magnet-1";
      await act(async () => target.dispatchEvent(new TestEvent("change", { bubbles: true })));
      for (const [label, value] of [
        ["Plane origin", "0,0,0"], ["Axis u", "1,0,0"], ["Axis v", "0,1,0"],
        ["Extent u", "2e-7"], ["Extent v", "1e-7"], ["Samples u", "33"], ["Samples v", "17"],
      ]) {
        const input = find("INPUT", label);
        Object.getOwnPropertyDescriptor(TestElement.prototype, "value")?.set?.call(input, value);
        await act(async () => input.dispatchEvent(new TestEvent("input", { bubbles: true })));
      }
      await act(async () => find("BUTTON", "Create source FFT request").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(mocks.commitTransaction).toHaveBeenCalledWith({
        base_revision: 15, kind: "merge_patch",
        merge_patch: { antenna_spectrum_requests: [expect.objectContaining({
          solution_ref: { kind: "stage_output", stage_id: "solve-1", output_id: "basis-1" },
          target: { kind: "object", object_id: "magnet-1" },
          transform: "spatial_fft",
          sampling_plane: expect.objectContaining({ sample_count_u: 33, sample_count_v: 17, interpolation: "fem_element" }),
        })] },
      });
      await act(async () => find("BUTTON", "Create source FFT request").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
  it("creates a projection and drive atomically from the selected solve stage", async () => {
    mocks.scene.data = {
      revision: 11,
      objects: [{ id: "antenna-1", name: "Conductor" }, { id: "magnet-1", name: "Magnet" }],
      study: { stages: [{ kind: "run", stage_id: "run-1" }] },
      antenna_field_solve_stages: [{
        id: "solve-1", source_object_id: "antenna-1", current_transport_id: "current-1",
        port_mode_ids: ["port-1"], outputs: [{ id: "basis-1", quantity: "H_ant_basis" }],
        field_sampling_domain: { kind: "global" }, target_refs: [],
      }],
      antenna_port_modes: [{ id: "port-1", source_object_id: "antenna-1", current_transport_id: "current-1" }],
      antenna_target_projections: [], solved_antenna_drives: [],
    } as unknown as SceneResource;
    mocks.commitTransaction.mockResolvedValue({ scene_revision: 12 });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const find = (tag: string, label: string): TestElement => {
      const found: TestElement[] = [];
      const visit = (node: TestNode) => {
        if (node instanceof TestElement && node.tagName === tag &&
          (node.getAttribute("aria-label") === label || node.textContent.includes(label))) found.push(node);
        node.childNodes.forEach(visit);
      };
      visit(container);
      if (!found[0]) throw new Error(`Missing ${label}`);
      return found[0];
    };
    try {
      await act(async () => root.render(<AntennaCompositionPanel kind="solution" selection={solutionSelection()} />));
      await act(async () => find("BUTTON", "Create projection and drive").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(mocks.commitTransaction).not.toHaveBeenCalled();
      const target = find("SELECT", "Target object");
      target.value = "magnet-1";
      await act(async () => target.dispatchEvent(new TestEvent("change", { bubbles: true })));
      const run = find("SELECT", "Run stage");
      run.value = "run-1";
      await act(async () => run.dispatchEvent(new TestEvent("change", { bubbles: true })));
      for (const [label, value] of [["Peak current", "0.01"], ["Frequency", "1e9"]]) {
        const input = find("INPUT", label);
        Object.getOwnPropertyDescriptor(TestElement.prototype, "value")?.set?.call(input, value);
        await act(async () => input.dispatchEvent(new TestEvent("input", { bubbles: true })));
      }
      await act(async () => find("BUTTON", "Create projection and drive").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(mocks.commitTransaction).toHaveBeenCalledWith({
        base_revision: 11, kind: "merge_patch",
        merge_patch: {
          antenna_target_projections: [expect.objectContaining({
            solution: { kind: "stage_output", stage_id: "solve-1", output_id: "basis-1" },
            target: { kind: "object", object_id: "magnet-1" },
          })],
          solved_antenna_drives: [expect.objectContaining({
            port_mode_id: "port-1", peak_current_a: 0.01,
            activation: { kind: "stage_ids", stage_ids: ["run-1"] },
          })],
        },
      });
      await act(async () => find("BUTTON", "Create projection and drive").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
      mocks.scene.data = { ...mocks.scene.data!, revision: 12 } as SceneResource;
      mocks.commitTransaction.mockRejectedValueOnce({ status: 409 });
      await act(async () => root.render(<AntennaCompositionPanel kind="solution" selection={solutionSelection()} />));
      await act(async () => find("BUTTON", "Create projection and drive").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(container.textContent).toContain("Scene revision conflict");
      await act(async () => find("BUTTON", "Create projection and drive").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(mocks.commitTransaction).toHaveBeenCalledTimes(2);
      await act(async () => find("BUTTON", "Refetch Scene").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(mocks.scene.refetch).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
  it("rejects activation on a Relax stage before the scene transaction", async () => {
    mocks.scene.data = {
      revision: 3,
      study: { stages: [{ kind: "relax", stage_id: "relax-1" }, { kind: "run", stage_id: "run-1" }] },
      solved_antenna_drives: [{
        id: "drive-1", name: "RF", peak_current_a: 1, port_mode_id: "port-1",
        projection_ref: "projection-1", time_origin: "stage_local",
        waveform: { kind: "constant" },
        activation: { kind: "stage_ids", stage_ids: ["relax-1"] },
      }],
    } as unknown as SceneResource;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const buttons: TestElement[] = [];
    const visit = (node: TestNode) => {
      if (node instanceof TestElement && node.tagName === "BUTTON" && node.textContent.includes("Save drive")) buttons.push(node);
      node.childNodes.forEach(visit);
    };
    try {
      await act(async () => root.render(<AntennaCompositionPanel kind="drive" selection={driveSelection()} />));
      visit(container);
      expect(container.textContent).toContain("Run run-1");
      expect(container.textContent).not.toContain("Run relax-1");
      await act(async () => buttons[0]?.dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(container.textContent).toContain("not a Run stage");
      expect(mocks.commitTransaction).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
  it("commits the edited drive with the scene revision and preserves other drives", async () => {
    mocks.scene.data = {
      revision: 7,
      solved_antenna_drives: [
        { id: "drive-1", name: "RF", peak_current_a: 1, port_mode_id: "port-1", projection_ref: "projection-1", time_origin: "stage_local", waveform: { kind: "constant" }, activation: { kind: "all_time_evolution" } },
        { id: "drive-2", name: "Other", peak_current_a: 2, port_mode_id: "port-2", projection_ref: "projection-2", time_origin: "stage_local", waveform: { kind: "constant" }, activation: { kind: "all_time_evolution" } },
      ],
    } as unknown as SceneResource;
    mocks.commitTransaction.mockResolvedValue({ scene_revision: 8 });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<AntennaCompositionPanel kind="drive" selection={driveSelection()} />));
      const inputs: TestElement[] = [];
      const buttons: TestElement[] = [];
      const visit = (node: TestNode) => {
        if (node instanceof TestElement && node.tagName === "INPUT" && node.getAttribute("aria-label") === "Peak current") inputs.push(node);
        if (node instanceof TestElement && node.tagName === "BUTTON" && node.textContent.includes("Save drive")) buttons.push(node);
        node.childNodes.forEach(visit);
      };
      visit(container);
      const input = inputs[0];
      if (!input) throw new Error("Missing peak current input");
      Object.getOwnPropertyDescriptor(TestElement.prototype, "value")?.set?.call(input, "3");
      await act(async () => input.dispatchEvent(new TestEvent("input", { bubbles: true })));
      expect(buttons).toHaveLength(1);
      await act(async () => buttons[0]?.dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(mocks.commitTransaction).toHaveBeenCalledWith({
        base_revision: 7,
        kind: "merge_patch",
        merge_patch: { solved_antenna_drives: [
          expect.objectContaining({ id: "drive-1", peak_current_a: 3 }),
          expect.objectContaining({ id: "drive-2", peak_current_a: 2 }),
        ] },
      });
      expect(mocks.invalidate).toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("preserves only edited drive fields on refresh and blocks a same-field overwrite", async () => {
    mocks.scene.data = {
      revision: 7,
      solved_antenna_drives: [
        { id: "drive-1", name: "RF", peak_current_a: 1, port_mode_id: "port-1", projection_ref: "projection-1", time_origin: "stage_local", waveform: { kind: "constant" }, activation: { kind: "all_time_evolution" } },
        { id: "drive-2", name: "Other", peak_current_a: 2, port_mode_id: "port-2", projection_ref: "projection-2", time_origin: "stage_local", waveform: { kind: "constant" }, activation: { kind: "all_time_evolution" } },
      ],
    } as SceneResource;
    mocks.commitTransaction.mockResolvedValue({ scene_revision: 9 });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const find = (tag: string, label: string): TestElement => {
      const found: TestElement[] = [];
      const visit = (node: TestNode) => {
        if (node instanceof TestElement && node.tagName === tag &&
          (node.getAttribute("aria-label") === label || node.textContent.includes(label))) found.push(node);
        node.childNodes.forEach(visit);
      };
      visit(container);
      if (!found[0]) throw new Error(`Missing ${label}`);
      return found[0];
    };
    const editPeak = async (value: string) => {
      const input = find("INPUT", "Peak current");
      Object.getOwnPropertyDescriptor(TestElement.prototype, "value")?.set?.call(input, value);
      await act(async () => input.dispatchEvent(new TestEvent("input", { bubbles: true })));
      return input;
    };
    try {
      await act(async () => root.render(<AntennaCompositionPanel kind="drive" selection={driveSelection()} />));
      const input = await editPeak("3");
      input.focus();
      const panelRoot = container.firstChild;
      mocks.scene.data = {
        ...mocks.scene.data!, revision: 8,
        solved_antenna_drives: [
          { ...mocks.scene.data!.solved_antenna_drives![0], waveform: { kind: "sinusoidal", frequency_hz: 1e9, phase_rad: 0.7, offset: 0.2 } },
          { ...mocks.scene.data!.solved_antenna_drives![1], peak_current_a: 4 },
        ],
      } as SceneResource;
      await act(async () => root.render(<AntennaCompositionPanel kind="drive" selection={driveSelection()} />));
      expect(container.firstChild).toBe(panelRoot);
      expect(find("INPUT", "Peak current")).toBe(input);
      expect(dom.document.activeElement).toBe(input);
      expect(input.value).toBe("3");
      expect(find("INPUT", "Frequency").disabled).toBe(false);
      await act(async () => find("BUTTON", "Save drive").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(mocks.commitTransaction).toHaveBeenCalledWith({
        base_revision: 8, kind: "merge_patch",
        merge_patch: { solved_antenna_drives: [
          expect.objectContaining({ id: "drive-1", peak_current_a: 3, waveform: { kind: "sinusoidal", frequency_hz: 1e9, phase_rad: 0.7, offset: 0.2 } }),
          expect.objectContaining({ id: "drive-2", peak_current_a: 4 }),
        ] },
      });

      mocks.scene.data = {
        ...mocks.scene.data!, revision: 9,
        solved_antenna_drives: [{ ...mocks.scene.data!.solved_antenna_drives![0], peak_current_a: 3 }, mocks.scene.data!.solved_antenna_drives![1]],
      } as SceneResource;
      await act(async () => root.render(<AntennaCompositionPanel kind="drive" selection={driveSelection()} />));
      const secondInput = await editPeak("5");
      mocks.scene.data = {
        ...mocks.scene.data!, revision: 10,
        solved_antenna_drives: [{ ...mocks.scene.data!.solved_antenna_drives![0], peak_current_a: 4 }, mocks.scene.data!.solved_antenna_drives![1]],
      } as SceneResource;
      await act(async () => root.render(<AntennaCompositionPanel kind="drive" selection={driveSelection()} />));
      expect(find("INPUT", "Peak current")).toBe(secondInput);
      expect(secondInput.value).toBe("5");
      expect(container.textContent).toContain("Server peakCurrentA4");
      expect(container.textContent).toContain("Draft peakCurrentA5");
      expect(find("BUTTON", "Save drive").disabled).toBe(true);
      await act(async () => find("BUTTON", "Save drive").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
      await act(async () => find("BUTTON", "Rebase Draft").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(find("BUTTON", "Save drive").disabled).toBe(false);
      await act(async () => find("BUTTON", "Save drive").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(mocks.commitTransaction).toHaveBeenNthCalledWith(2, expect.objectContaining({
        base_revision: 10,
        merge_patch: { solved_antenna_drives: [
          expect.objectContaining({ id: "drive-1", peak_current_a: 5 }),
          expect.objectContaining({ id: "drive-2", peak_current_a: 4 }),
        ] },
      }));
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps the drive draft and blocks another save after a scene revision conflict", async () => {
    mocks.scene.data = {
      revision: 4,
      solved_antenna_drives: [{
        id: "drive-1", name: "RF", peak_current_a: 1, port_mode_id: "port-1",
        projection_ref: "projection-1", time_origin: "stage_local",
        waveform: { kind: "constant" }, activation: { kind: "all_time_evolution" },
      }],
    } as unknown as SceneResource;
    mocks.commitTransaction.mockRejectedValue({ status: 409 });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const controls: TestElement[] = [];
    const visit = (node: TestNode) => {
      if (node instanceof TestElement && (
        node.getAttribute("aria-label") === "Peak current" ||
        (node.tagName === "BUTTON" && node.textContent.includes("Save drive"))
      )) controls.push(node);
      node.childNodes.forEach(visit);
    };
    try {
      await act(async () => root.render(<AntennaCompositionPanel kind="drive" selection={driveSelection()} />));
      visit(container);
      const input = controls.find((item) => item.tagName === "INPUT");
      const save = controls.find((item) => item.tagName === "BUTTON");
      if (!input || !save) throw new Error("Missing drive controls");
      Object.getOwnPropertyDescriptor(TestElement.prototype, "value")?.set?.call(input, "3");
      await act(async () => input.dispatchEvent(new TestEvent("input", { bubbles: true })));
      await act(async () => save.dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(container.textContent).toContain("Your draft is preserved");
      expect(input.value).toBe("3");
      await act(async () => save.dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
      const findButton = (text: string) => {
        const buttons: TestElement[] = [];
        const visitButton = (node: TestNode) => {
          if (node instanceof TestElement && node.tagName === "BUTTON" && node.textContent.includes(text)) buttons.push(node);
          node.childNodes.forEach(visitButton);
        };
        visitButton(container);
        if (!buttons[0]) throw new Error(`Missing ${text}`);
        return buttons[0];
      };
      await act(async () => findButton("Refetch Scene").dispatchEvent(new TestEvent("click", { bubbles: true })));
      mocks.scene.status = "error";
      await act(async () => root.render(<AntennaCompositionPanel kind="drive" selection={driveSelection()} />));
      expect(container.textContent).toContain("refresh-error");
      await act(async () => findButton("Refetch Scene").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(mocks.scene.refetch).toHaveBeenCalledTimes(2);
      expect(input.value).toBe("3");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("rebases only edited drive fields after refetch and retries with the new revision", async () => {
    mocks.scene.data = {
      revision: 4,
      solved_antenna_drives: [{
        id: "drive-1", name: "RF", peak_current_a: 1, port_mode_id: "port-1",
        projection_ref: "projection-1", time_origin: "stage_local",
        waveform: { kind: "constant" }, activation: { kind: "all_time_evolution" },
      }],
    } as unknown as SceneResource;
    mocks.commitTransaction.mockRejectedValueOnce({ status: 409 }).mockResolvedValueOnce({ scene_revision: 8 });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const find = (tag: string, label: string): TestElement => {
      const found: TestElement[] = [];
      const visit = (node: TestNode) => {
        if (node instanceof TestElement && node.tagName === tag &&
          (node.getAttribute("aria-label") === label || node.textContent.includes(label))) found.push(node);
        node.childNodes.forEach(visit);
      };
      visit(container);
      if (!found[0]) throw new Error(`Missing ${label}`);
      return found[0];
    };
    try {
      await act(async () => root.render(<AntennaCompositionPanel kind="drive" selection={driveSelection()} />));
      const input = find("INPUT", "Peak current");
      Object.getOwnPropertyDescriptor(TestElement.prototype, "value")?.set?.call(input, "3");
      await act(async () => input.dispatchEvent(new TestEvent("input", { bubbles: true })));
      await act(async () => find("BUTTON", "Save drive").dispatchEvent(new TestEvent("click", { bubbles: true })));
      await act(async () => find("BUTTON", "Refetch Scene").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(mocks.scene.refetch).toHaveBeenCalled();
      mocks.scene.data = {
        ...mocks.scene.data!, revision: 5,
        solved_antenna_drives: [{
          ...mocks.scene.data!.solved_antenna_drives![0],
          peak_current_a: 2,
          waveform: { kind: "sinusoidal", frequency_hz: 1e9, phase_rad: 0.7, offset: 0.2 },
        }],
      } as SceneResource;
      await act(async () => root.render(<AntennaCompositionPanel kind="drive" selection={driveSelection()} />));
      expect(container.textContent).toContain("Server peakCurrentA2");
      expect(container.textContent).toContain("Draft peakCurrentA3");
      await act(async () => find("BUTTON", "Rebase Draft").dispatchEvent(new TestEvent("click", { bubbles: true })));
      mocks.scene.data = { ...mocks.scene.data!, revision: 6 } as SceneResource;
      await act(async () => root.render(<AntennaCompositionPanel kind="drive" selection={driveSelection()} />));
      expect(container.textContent).toContain("Scene changed again after rebase");
      await act(async () => find("BUTTON", "Retry Save").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
      await act(async () => find("BUTTON", "Refetch Scene").dispatchEvent(new TestEvent("click", { bubbles: true })));
      mocks.scene.data = {
        ...mocks.scene.data!, revision: 7,
        solved_antenna_drives: [{
          ...mocks.scene.data!.solved_antenna_drives![0],
          waveform: { kind: "sinusoidal", frequency_hz: 1e9, phase_rad: 0.8, offset: 0.3 },
        }],
      } as SceneResource;
      await act(async () => root.render(<AntennaCompositionPanel kind="drive" selection={driveSelection()} />));
      await act(async () => find("BUTTON", "Rebase Draft").dispatchEvent(new TestEvent("click", { bubbles: true })));
      await act(async () => find("BUTTON", "Retry Save").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(mocks.commitTransaction).toHaveBeenNthCalledWith(2, {
        base_revision: 7,
        kind: "merge_patch",
        merge_patch: { solved_antenna_drives: [expect.objectContaining({
          peak_current_a: 3,
          waveform: { kind: "sinusoidal", frequency_hz: 1e9, phase_rad: 0.8, offset: 0.3 },
        })] },
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
  it("shows missing transport and port references for an incomplete solve stage", async () => {
    mocks.scene.data = {
      antenna_field_solve_stages: [{
        id: "solve-1",
        source_object_id: "antenna-1",
        current_transport_id: "missing-current",
        port_mode_ids: ["missing-port"],
        outputs: [{ id: "solution-1", quantity: "H_ant_basis" }],
        field_sampling_domain: { kind: "global" },
        target_refs: [],
      }],
      current_transports: [],
      antenna_port_modes: [],
    } as unknown as SceneResource;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <AntennaCompositionPanel kind="solution" selection={solutionSelection()} />,
        ),
      );
      expect(container.textContent).toContain("Validation");
      expect(container.textContent).toContain("missing current transport");
      expect(container.textContent).toContain("missing port mode");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not present a published field as current after the current view is removed", async () => {
    mocks.scene.data = {
      ...sceneFixture(),
      antenna_field_solve_stages: [{
        id: "solve-1", source_object_id: "antenna-1", current_transport_id: "current-1",
        conservative_current_view_ref: "current-1:rt0", port_mode_ids: [],
        field_sampling_domain: { kind: "global" }, target_refs: [],
        outputs: [{ id: "solution-1", quantity: "H_ant_basis" }],
      }],
      current_transports: [{ name: "current-1", kind: "current_transport", model: "ohmic_poisson" }],
    } as unknown as SceneResource;
    mocks.fieldSolution.status = "ready";
    mocks.fieldSolution.data = fieldSolutionFixture();
    mocks.stageOutputCatalog.status = "ready";
    mocks.stageOutputCatalog.data = stageOutputCatalogFixture();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <AntennaCompositionPanel kind="solution" selection={solutionSelection()} />,
      ));
      expect(container.textContent).toContain("requires a mesh-exact ConservativeCurrentView");
      expect(container.textContent).toContain("Runtime resultauthoring invalid");
      expect(container.textContent).not.toContain("Published solutionsolution-1");
      expect(container.textContent).not.toContain("Direct antenna field");
      expect(findGroupBadge(container, "invalid · result pending")).toBeDefined();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("shows missing solve and target references for an incomplete projection", async () => {
    mocks.scene.data = {
      antenna_target_projections: [{
        id: "projection-1",
        output_id: "missing-output",
        solution: { output_id: "missing-output", stage_id: "missing-stage" },
        target: { kind: "object", object_id: "missing-object" },
      }],
      antenna_field_solve_stages: [],
      objects: [],
    } as unknown as SceneResource;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <AntennaCompositionPanel kind="projection" selection={projectionSelection()} />,
        ),
      );
      expect(container.textContent).toContain("Validation");
      expect(container.textContent).toContain("missing solve stage");
      expect(container.textContent).toContain("missing target object");
      expect(findGroupBadge(container, "invalid · result pending")).toBeDefined();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("accepts a symbolic stage output without requiring a published asset", async () => {
    mocks.scene.data = {
      antenna_target_projections: [{
        id: "projection-1",
        output_id: "field-1",
        solution: { kind: "stage_output", stage_id: "solve-1", output_id: "field-1" },
        target: { kind: "global" },
      }],
      antenna_field_solve_stages: [{
        id: "solve-1",
        outputs: [{ id: "field-1", quantity: "H_ant_basis" }],
      }],
    } as unknown as SceneResource;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <AntennaCompositionPanel kind="projection" selection={projectionSelection()} />,
        ),
      );
      expect(container.textContent).toContain("Stage output (awaiting publication)");
      expect(container.textContent).not.toContain("missing solution asset");
      expect(container.textContent).not.toContain("missing solution content digest");
      expect(findGroupBadge(container, "configured · result pending")).toBeDefined();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("shows missing references and invalid drive parameters without inventing a stage catalog", async () => {
    mocks.scene.data = {
      solved_antenna_drives: [{
        id: "drive-1",
        name: "RF drive",
        peak_current_a: 1,
        port_mode_id: "missing-port",
        projection_ref: "missing-projection",
        time_origin: "stage_local",
        waveform: { kind: "sinusoidal", frequency_hz: -1, phase_rad: 0, offset: 0 },
        activation: { kind: "stage_ids", stage_ids: [] },
      }],
      antenna_port_modes: [],
      antenna_target_projections: [],
      antenna_field_solve_stages: [],
    } as unknown as SceneResource;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <AntennaCompositionPanel kind="drive" selection={driveSelection()} />,
        ),
      );
      expect(container.textContent).toContain("Validation");
      expect(container.textContent).toContain("missing port mode");
      expect(container.textContent).toContain("missing projection");
      expect(container.textContent).toContain("sinusoidal frequency must be finite and > 0 Hz");
      expect(container.textContent).toContain("activation stage ids must be non-empty and unique");
      expect(container.textContent).not.toContain("missing activation stage");
      expect(findGroupBadge(container, "invalid · result pending")).toBeDefined();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("shows invalid references and sampling parameters for a spectrum request", async () => {
    mocks.scene.data = {
      antenna_spectrum_requests: [{
        id: "spectrum-1",
        component: "bad-component",
        output_id: "fft-1",
        solution_ref: {
          stage_id: "missing-stage",
          output_id: "missing-output",
          asset_id: "",
          content_digest: "",
        },
        target: { kind: "object", object_id: "missing-object" },
        transform: "spatial_fft",
        window: "hann",
        normalization: "integral_si",
        port_mode_id: "missing-port",
        sampling_plane: {
          axis_u: [1, 0, 0],
          axis_v: [1, 0, 0],
          origin_m: [0, 0, 0],
          extent_u_m: 0,
          extent_v_m: 1,
          sample_count_u: 2,
          sample_count_v: 2,
          interpolation: "unsupported",
          outside_policy: "error",
        },
        nonuniform_k_grid: null,
      }],
      antenna_port_modes: [],
      antenna_field_solve_stages: [],
      objects: [],
    } as unknown as SceneResource;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <AntennaCompositionPanel kind="spectrum" selection={spectrumSelection()} />,
        ),
      );
      expect(container.textContent).toContain("Validation");
      expect(container.textContent).toContain("missing solve stage");
      expect(container.textContent).toContain("missing target object");
      expect(container.textContent).toContain("missing port mode");
      expect(container.textContent).toContain("invalid sampling frame");
      expect(findGroupBadge(container, "invalid · result pending")).toBeDefined();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps a valid structured spectrum request explicitly pending", async () => {
    mocks.scene.data = {
      antenna_spectrum_requests: [{
        id: "spectrum-1",
        component: "x",
        output_id: "fft-1",
        solution_ref: {
          kind: "resolved_asset",
          stage_id: "solve-1",
          output_id: "h-ant-1",
          asset_id: "asset-1",
          content_digest: "digest-1",
        },
        target: { kind: "global" },
        transform: "spatial_fft",
        window: "hann",
        normalization: "integral_si",
        port_mode_id: "port-1",
        sampling_plane: {
          axis_u: [1, 0, 0],
          axis_v: [0, 1, 0],
          origin_m: [0, 0, 0],
          extent_u_m: 1,
          extent_v_m: 1,
          sample_count_u: 4,
          sample_count_v: 4,
          interpolation: "fem_element",
          outside_policy: "error",
        },
        nonuniform_k_grid: null,
      }],
      antenna_port_modes: [{ id: "port-1" }],
      antenna_field_solve_stages: [{
        id: "solve-1",
        port_mode_ids: ["port-1"],
        outputs: [{ id: "h-ant-1", quantity: "H_ant_basis" }],
      }],
    } as unknown as SceneResource;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <AntennaCompositionPanel kind="spectrum" selection={spectrumSelection()} />,
        ),
      );
      expect(container.textContent).toContain("Validationready");
      expect(container.textContent).not.toContain("Stage catalog result");
      expect(findGroupBadge(container, "configured · result pending")).toBeDefined();
      mocks.sourceSpectrum.status = "ready";
      mocks.sourceSpectrum.data = {
        output_id: "fft-1",
        request_id: "spectrum-1",
        solution_id: "h-ant-1",
        solution_content_digest: "other-digest",
        sampling: { solution_id: "h-ant-1" },
      } as AntennaSourceSpectrumResource;
      await act(async () => root.render(
        <AntennaCompositionPanel kind="spectrum" selection={spectrumSelection()} />,
      ));
      expect(container.textContent).toContain("Runtime resultidentity mismatch");
      expect(container.textContent).not.toContain("Published outputfft-1");
      expect(findGroupBadge(container, "stale result")).toBeDefined();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("marks unsupported transverse and modal spectra invalid before execution", async () => {
    mocks.scene.data = {
      antenna_spectrum_requests: [{
        id: "spectrum-1",
        component: "transverse",
        equilibrium_ref: "equilibrium-1",
        mode_basis_ref: "modes-1",
        output_id: "fft-1",
        solution_ref: { kind: "stage_output", stage_id: "solve-1", output_id: "basis" },
        target: { kind: "global" },
        transform: "spatial_fft",
        window: "rectangular",
        normalization: "integral_si",
        sampling_plane: {
          axis_u: [1, 0, 0], axis_v: [0, 1, 0], origin_m: [0, 0, 0],
          extent_u_m: 1, extent_v_m: 1, sample_count_u: 4, sample_count_v: 4,
          interpolation: "fem_element", outside_policy: "error",
        },
      }],
      antenna_field_solve_stages: [{
        id: "solve-1", port_mode_ids: ["port-1"],
        outputs: [{ id: "basis", quantity: "H_ant_basis" }],
      }],
      antenna_port_modes: [{ id: "port-1" }],
    } as unknown as SceneResource;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <AntennaCompositionPanel kind="spectrum" selection={spectrumSelection()} />,
      ));
      expect(container.textContent).toContain("transverse spectrum is unsupported");
      expect(container.textContent).toContain("mode_basis_ref is unsupported");
      expect(findGroupBadge(container, "invalid · result pending")).toBeDefined();
      const scene = mocks.scene.data as unknown as { antenna_spectrum_requests: Array<Record<string, unknown>> };
      mocks.scene.data = {
        ...scene,
        antenna_spectrum_requests: [{
          ...scene.antenna_spectrum_requests[0],
          equilibrium_ref: null,
          mode_basis_ref: null,
        }],
      } as unknown as SceneResource;
      await act(async () => root.render(
        <AntennaCompositionPanel kind="spectrum" selection={spectrumSelection()} />,
      ));
      expect(container.textContent).toContain("transverse spectrum requires equilibrium_ref");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("shows concrete port validation diagnostics", async () => {
    mocks.scene.data = {
      antenna_port_modes: [{
        id: "invalid-port",
        schema_version: "antenna_port_mode.v2",
        source_object_id: "antenna-1",
        current_transport_id: "transport-1",
        normalization_current_a: 1,
        branches: [{
          id: "signal",
          inlet_terminal_ref: "signal_in",
          outlet_terminal_ref: "signal_out",
          signed_weight: 1,
        }],
      }],
    } as unknown as SceneResource;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <AntennaCompositionPanel kind="port" selection={portSelection()} />,
        ),
      );
      expect(container.textContent).toContain("Validationrequires at least two branches");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("renders the canonical geometry_kind for a conductor Inspector", async () => {
    mocks.scene.data = {
      objects: [
        {
          id: "antenna-1",
          name: "Microstrip antenna",
          role: "antenna",
          material_ref: "copper",
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [50e-9, 1e-6, 10e-9] },
          },
        },
      ],
    } as unknown as SceneResource;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <AntennaCompositionPanel kind="conductor" selection={conductorSelection()} />,
        ),
      );
      expect(container.textContent).toContain("GeometryBox");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("shows the authored microstrip dimensions and width stations", async () => {
    mocks.scene.data = {
      objects: [{
        id: "antenna-1",
        name: "Microstrip antenna",
        role: "antenna",
        geometry: {
          geometry_kind: "MicrostripAntennaLayout",
          geometry_params: {
            length_m: 1e-6,
            thickness_m: 10e-9,
            conductivity_s_per_m: 5.8e7,
            return_width_m: 500e-9,
            return_offset_m: 30e-9,
            stations: [
              { s: 0, signal_width_m: 50e-9 },
              { s: 1, signal_width_m: 25e-9 },
            ],
          },
        },
      }],
    } as unknown as SceneResource;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <AntennaCompositionPanel kind="conductor" selection={conductorSelection()} />,
        ),
      );
      expect(container.textContent).toContain("GeometryMicrostripAntennaLayout");
      expect(container.textContent).toContain("Length1.0000e-6 m");
      expect(container.textContent).toContain("Station 1s=0.0000e+0, signal width=5.0000e-8 m");
      expect(container.textContent).toContain("Station 2s=1.0000e+0, signal width=2.5000e-8 m");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps the conductor Inspector stable while saving a width station", async () => {
    const geometry = {
      geometry_kind: "MicrostripAntennaLayout",
      geometry_params: {
        length_m: 1e-6, thickness_m: 10e-9, conductivity_s_per_m: 5.8e7,
        return_width_m: 500e-9, return_offset_m: 30e-9,
        stations: [{ s: 0, signal_width_m: 50e-9 }, { s: 1, signal_width_m: 25e-9 }],
        transform: { rotation_matrix: [[0, -1, 0], [1, 0, 0], [0, 0, 1]] },
      },
    };
    mocks.scene.data = { revision: 4, objects: [{ id: "antenna-1", geometry }] } as unknown as SceneResource;
    let acknowledge: ((value: unknown) => void) | undefined;
    mocks.commitTransaction.mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const find = (tag: string, label: string): TestElement => {
      const found: TestElement[] = [];
      const visit = (node: TestNode) => {
        if (node instanceof TestElement && node.tagName === tag &&
          (node.getAttribute("aria-label") === label || node.textContent.includes(label))) found.push(node);
        node.childNodes.forEach(visit);
      };
      visit(container);
      if (!found[0]) throw new Error(`Missing ${label}`);
      return found[0];
    };
    try {
      await act(async () => root.render(<AntennaCompositionPanel kind="conductor" selection={conductorSelection()} />));
      const panel = find("DIV", "Antenna conductor");
      const input = find("INPUT", "Station 1 signal width");
      const unrelatedInput = find("INPUT", "Station 2 signal width");
      Object.getOwnPropertyDescriptor(TestElement.prototype, "value")?.set?.call(input, "60e-9");
      await act(async () => input.dispatchEvent(new TestEvent("input", { bubbles: true })));
      await act(async () => find("BUTTON", "Save width stations").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(mocks.commitTransaction).toHaveBeenCalledWith(expect.objectContaining({
        kind: "patch_object_geometry", object_id: "antenna-1", base_revision: 4,
        geometry: expect.objectContaining({ geometry_params: expect.objectContaining({
          stations: [{ s: 0, signal_width_m: 60e-9 }, { s: 1, signal_width_m: 25e-9 }],
        }) }),
      }), { sessionScopeKey: "session=session-1&epoch=epoch-1&request_scope_epoch=instance-1%3A7" });
      expect(find("DIV", "Antenna conductor")).toBe(panel);
      expect(find("INPUT", "Station 1 signal width")).toBe(input);
      expect(unrelatedInput.disabled).toBe(false);
      await act(async () => acknowledge?.({ scene_revision: 5, committed_scene: { ...mocks.scene.data, revision: 5 } }));
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("requires explicit rebase if server geometry changes during a local station edit", async () => {
    const geometry = {
      geometry_kind: "MicrostripAntennaLayout",
      geometry_params: {
        length_m: 1e-6, thickness_m: 10e-9, conductivity_s_per_m: 5.8e7,
        return_width_m: 500e-9, return_offset_m: 30e-9,
        stations: [{ s: 0, signal_width_m: 50e-9 }, { s: 1, signal_width_m: 25e-9 }],
      },
    };
    mocks.scene.data = { revision: 4, objects: [{ id: "antenna-1", geometry }] } as unknown as SceneResource;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const find = (tag: string, label: string): TestElement => {
      const found: TestElement[] = [];
      const visit = (node: TestNode) => {
        if (node instanceof TestElement && node.tagName === tag &&
          (node.getAttribute("aria-label") === label || node.textContent.includes(label))) found.push(node);
        node.childNodes.forEach(visit);
      };
      visit(container);
      if (!found[0]) throw new Error(`Missing ${label}`);
      return found[0];
    };
    try {
      await act(async () => root.render(<AntennaCompositionPanel kind="conductor" selection={conductorSelection()} />));
      const input = find("INPUT", "Station 1 signal width");
      Object.getOwnPropertyDescriptor(TestElement.prototype, "value")?.set?.call(input, "60e-9");
      await act(async () => input.dispatchEvent(new TestEvent("input", { bubbles: true })));
      mocks.scene.data = { revision: 5, objects: [{ id: "antenna-1", geometry: {
        ...geometry, geometry_params: { ...geometry.geometry_params, return_width_m: 400e-9 },
      } }] } as unknown as SceneResource;
      await act(async () => root.render(<AntennaCompositionPanel kind="conductor" selection={conductorSelection()} />));
      expect(container.textContent).toContain("Conductor geometry changed on the server");
      expect(find("BUTTON", "Save width stations").disabled).toBe(true);
      expect(mocks.commitTransaction).not.toHaveBeenCalled();
      expect(input.value).toBe("60e-9");
      await act(async () => find("BUTTON", "Rebase draft").dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(find("BUTTON", "Save width stations").disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

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
      expect(container.textContent).toContain("Requested executionbackend=fem · device=auto · precision=double · mode=strict");
      expect(container.textContent).toContain("Resolved executionbackend=fem · device=cpu · precision=double · mode=strict");
      expect(container.textContent).toContain("Gauge policyzero_mean");
      expect(container.textContent).toContain("Port port-1 measured current2.0000e+0 A");
      expect(container.textContent).toContain("Port port-1 normalization1.0000e+0 A");
      expect(container.textContent).toContain("Port port-1 current certificatesha256:certificate");
      expect(container.textContent).toContain("Port port-1 magnetic basisA/m/A · 6 values");
      expect(container.textContent).toContain("Direct antenna field");
      expect(container.textContent).toContain("Sample 1 H/I");
      expect(container.textContent).toContain("1.000e+0");
      expect(findGroupBadge(container, "ready")).toBeDefined();
      mocks.fieldSolution.data = { ...fieldSolutionFixture(), content_digest: "sha256:other" };
      await act(async () => root.render(
        <AntennaCompositionPanel kind="solution" selection={solutionSelection()} />,
      ));
      expect(container.textContent).toContain("Runtime resultidentity mismatch");
      expect(container.textContent).not.toContain("Published solutionsolution-1");
      expect(container.textContent).not.toContain("Direct antenna field");
      expect(container.textContent).not.toContain("Port port-1 measured current");
      expect(findGroupBadge(container, "stale result")).toBeDefined();
      mocks.fieldSolution.data = fieldSolutionFixture();
      mocks.stageOutputCatalog.status = "loading";
      mocks.stageOutputCatalog.data = null;
      await act(async () => root.render(
        <AntennaCompositionPanel kind="solution" selection={solutionSelection()} />,
      ));
      expect(container.textContent).toContain("Runtime resultawaiting stage catalog");
      expect(container.textContent).not.toContain("Published solutionsolution-1");
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
    bases: [{
      port_mode_id: "port-1",
      measured_positive_terminal_current_a: 2,
      normalization_current_a: 1,
      normalization_scale: 0.5,
      current_balance_certificate_digest: "sha256:certificate",
      electric_potential_per_ampere: { layout: "scalar", path: "potential.f64le", scalar_type: "f64", sha256: "sha256:potential", unit: "V/A", value_count: 2 },
      current_density_per_ampere: { layout: "xyz", path: "current.f64le", scalar_type: "f64", sha256: "sha256:current-density", unit: "A/m^2/A", value_count: 6 },
      magnetic_field_per_ampere: { layout: "sample_xyz_interleaved", path: "field.f64le", scalar_type: "float64_le", sha256: "sha256:field-basis", unit: "A/m/A", value_count: 6 },
      quadrature_diagnostics: {},
    }],
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
    requested_execution: { discretization: "fem", device: "auto", precision: "double", execution_mode: "strict" },
    resolved_execution: { discretization: "fem", device: "cpu", precision: "double", execution_mode: "strict" },
    resource_id: "antenna/field-solution/solution-1",
    sample_positions: {
      layout: "sample_xyz_interleaved",
      path: "samples.f64le",
      scalar_type: "float64_le",
      sha256: "sha256:samples",
      unit: "m",
      value_count: 6,
    },
    sample_topology: null,
    schema_version: "antenna_field_solution.v1",
    session_epoch: "epoch-1",
    request_scope_epoch: "instance-1:7",
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
    request_scope_epoch: "instance-1:7",
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

function conductorSelection(): Selection {
  return {
    kind: "object.antenna.conductor",
    label: "Antenna conductor",
    moduleSource: "explorer",
    nodeId: "object:antenna-1:antenna:conductor",
    objectId: "antenna-1",
    ref: {
      kind: "object.antenna.conductor",
      nodeId: "object:antenna-1:antenna:conductor",
      objectId: "antenna-1",
      type: "scene-object",
      visualizationTargetId: "object:antenna-1",
      antennaResourceId: "antenna-1",
      antennaResourceKind: "conductor",
    },
  } as Selection;
}

function portSelection(): Selection {
  return {
    kind: "object.antenna.port",
    label: "Port invalid-port",
    moduleSource: "explorer",
    nodeId: "object:antenna-1:antenna:port:invalid-port",
    objectId: "antenna-1",
    ref: {
      kind: "object.antenna.port",
      nodeId: "object:antenna-1:antenna:port:invalid-port",
      objectId: "antenna-1",
      type: "scene-object",
      visualizationTargetId: "object:antenna-1",
      antennaResourceId: "invalid-port",
      antennaResourceKind: "port",
    },
  } as Selection;
}

function projectionSelection(): Selection {
  return {
    kind: "object.antenna.projection",
    label: "Projection projection-1",
    moduleSource: "explorer",
    nodeId: "object:antenna-1:antenna:projection:projection-1",
    objectId: "antenna-1",
    ref: {
      kind: "object.antenna.projection",
      nodeId: "object:antenna-1:antenna:projection:projection-1",
      objectId: "antenna-1",
      type: "scene-object",
      visualizationTargetId: "object:antenna-1",
      antennaResourceId: "projection-1",
      antennaResourceKind: "projection",
    },
  } as Selection;
}

function driveSelection(): Selection {
  return {
    kind: "object.antenna.drive",
    label: "Drive drive-1",
    moduleSource: "explorer",
    nodeId: "object:antenna-1:antenna:drive:drive-1",
    objectId: "antenna-1",
    ref: {
      kind: "object.antenna.drive",
      nodeId: "object:antenna-1:antenna:drive:drive-1",
      objectId: "antenna-1",
      type: "scene-object",
      visualizationTargetId: "object:antenna-1",
      antennaResourceId: "drive-1",
      antennaResourceKind: "drive",
    },
  } as Selection;
}

function spectrumSelection(): Selection {
  return {
    kind: "object.antenna.spectrum",
    label: "Spectrum spectrum-1",
    moduleSource: "explorer",
    nodeId: "object:antenna-1:antenna:spectrum:spectrum-1",
    objectId: "antenna-1",
    ref: {
      kind: "object.antenna.spectrum",
      nodeId: "object:antenna-1:antenna:spectrum:spectrum-1",
      objectId: "antenna-1",
      type: "scene-object",
      visualizationTargetId: "object:antenna-1",
      antennaResourceId: "spectrum-1",
      antennaResourceKind: "spectrum",
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
