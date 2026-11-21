import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { ScalarWindowResource, SceneResource } from "@/kernel/api/apiTypes";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import {
  installSimulationPreparationTestDom,
  type TestElement,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { FooterTelemetry } from "./FooterTelemetry";
import { type FooterTelemetryStatus } from "./FooterTelemetry.model";

const hooks = vi.hoisted(() => ({
  scene: null as { data: unknown; status: string } | null,
  scalarColumns: [] as string[][],
  history: null as ScalarWindowResource | null,
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useSceneResource: () => hooks.scene,
}));

vi.mock("@/kernel/selection/useSelection", () => ({
  useSelectionSelector: () => null,
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => {
  const emptyResource = () => ({
    data: null,
    error: null,
    refetch: () => {},
    revision: null,
    status: "idle",
  });

  return {
    useCurrentRunResource: () => emptyResource(),
    useFrequencyDomainResponseProgressResource: () => emptyResource(),
    useFrequencyDomainResponseSweepResource: () => emptyResource(),
    useObjectMetricsResource: () => emptyResource(),
    useRunPerformanceResource: () => emptyResource(),
    useScalarWindowResource: (options: { columns: readonly string[]; limit: number }) => {
      hooks.scalarColumns.push([...options.columns]);
      if (options.limit > 1 && hooks.history) {
        return { ...emptyResource(), data: hooks.history, status: "ready" };
      }
      return emptyResource();
    },
    useSolverStatusResource: () => emptyResource(),
  };
});

vi.mock("./antennaFieldEta", () => ({
  formatAntennaFieldEta: (seconds: number) => `${seconds}s`,
  useAntennaFieldEta: () => ({ state: "idle" }),
}));

function telemetryStatus(): FooterTelemetryStatus {
  return {
    energies: null,
    metrics: { steps_per_second: null, total_steps: 12 },
    run: {
      calibration_id: null,
      requested_device: "cpu",
      resolved_device: "cpu",
      run_id: "run-1",
      selection_confidence: null,
      selection_reason: "explicit_cpu",
      solver_steps: 12,
      solver_time: 1e-9,
    },
    sessionId: "session-1",
    sessionEpoch: "session-1@1",
    requestScopeEpoch: "scope-1",
    scalarsRevision: 1,
    solver: {
      converged: null,
      dt: 1e-12,
      max_torque_T: null,
      state: "running",
    },
  };
}

function cardLabels(container: TestElement): string[] {
  return container
    .querySelectorAll(".fm-footer-telemetry__metric-label")
    .map((element) => element.textContent.trim());
}

describe("FooterTelemetry scene refresh stability", () => {
  it("keeps a ready nonmagnetic scene's cards stable through stale refresh and ready", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const scene = {
      objects: [{ id: "wire", name: "Copper wire" }],
      revision: 1,
    } satisfies SceneResource;
    const status = telemetryStatus();
    const bus = new EventBus<KernelEventMap>();
    hooks.scene = { data: scene, status: "ready" };
    hooks.scalarColumns = [];

    const root = createRoot(container as unknown as Element);
    const render = () =>
      act(async () =>
        root.render(
          <FooterTelemetry
            bus={bus}
            status={status}
            stageExecution={{ data: null, status: "ready" }}
            view="overview"
          />,
        ),
      );
    const assertNoMagneticCards = (labels: string[]) => {
      for (const label of [
        "Max Torque",
        "avg mx",
        "avg my",
        "avg mz",
        "|avg m|",
        "Energy",
        "Exchange",
        "Demag",
        "Zeeman",
        "Anisotropy",
        "DMI",
      ]) {
        expect(labels).not.toContain(label);
      }
    };

    try {
      await render();
      const telemetryRoot = container.querySelector(".fm-footer-telemetry");
      expect(telemetryRoot).not.toBeNull();
      const initialLabels = cardLabels(container);
      expect(initialLabels.length).toBeGreaterThan(0);
      assertNoMagneticCards(initialLabels);

      hooks.scene = { data: scene, status: "stale" };
      await render();
      expect(container.querySelector(".fm-footer-telemetry")).toBe(telemetryRoot);
      expect(cardLabels(container)).toEqual(initialLabels);
      assertNoMagneticCards(cardLabels(container));

      hooks.scene = { data: scene, status: "ready" };
      await render();
      expect(container.querySelector(".fm-footer-telemetry")).toBe(telemetryRoot);
      expect(cardLabels(container)).toEqual(initialLabels);
      assertNoMagneticCards(cardLabels(container));

      const requestedColumns = hooks.scalarColumns.at(-1) ?? [];
      expect(requestedColumns).toEqual(
        expect.arrayContaining([
          "step",
          "time",
          "mx",
          "my",
          "mz",
          "e_total",
        ]),
      );
      expect(requestedColumns).not.toContain("pseudo_time_s");
      expect(requestedColumns).not.toContain("active_runtime_s");
      expect(requestedColumns).toHaveLength(6);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

describe("FooterTelemetry accepted relaxation history", () => {
  it("renders and refreshes both charts when physical time is zero at every step", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const bus = new EventBus<KernelEventMap>();
    const status = {
      ...telemetryStatus(),
      solver: { ...telemetryStatus().solver, relaxation_algorithm: "projected_gradient_bb" as const },
    };
    const history = (rows: number[][]): ScalarWindowResource => ({
      columns: ["step", "e_total", "max_torque_T"],
      observation_frames: rows.map(([step]) => ({
        observation_frame_id: `frame-${step}`,
        session_epoch: "session-1@1",
        domain_generation_id: "mesh-1",
        topology_revision: "1",
        source_step: step,
        source_time_seconds: 0,
      })),
      revision: rows.length,
      returned_rows: rows.length,
      rows,
      series: { run_id: "run-1", step_id: "relax-1", task_id: "task-1", case_id: "case-1", attempt_id: "attempt-1", ownership_epoch: 1 },
      total_rows: rows.length,
    });
    const render = () => act(async () =>
      root.render(<FooterTelemetry bus={bus} status={status} stageExecution={{ data: null, status: "ready" }} view="overview" />),
    );
    const paths = () => container.querySelectorAll(".fm-footer-telemetry__spark-line").map((line) => line.getAttribute("d"));

    try {
      hooks.scene = { data: null, status: "idle" };
      hooks.history = history([[1, 2e-18, 9e-4], [2, 1e-18, 6e-4]]);
      await render();
      const initial = paths();
      expect(initial).toHaveLength(2);

      hooks.history = history([[1, 2e-18, 9e-4], [2, 1e-18, 6e-4], [3, 0.7e-18, 2e-4]]);
      await render();
      const updated = paths();
      expect(updated).toHaveLength(2);
      expect(updated[0]).not.toEqual(initial[0]);
      expect(updated[1]).not.toEqual(initial[1]);

      hooks.history = {
        ...hooks.history,
        observation_frames: hooks.history.observation_frames.map((frame) => ({ ...frame, session_epoch: "other-session@2" })),
      };
      await render();
      expect(paths()).toHaveLength(0);
    } finally {
      hooks.history = null;
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

describe("FooterTelemetry authored antenna stage", () => {
  it("shows the canonical queued definition before a run and preserves it during refresh", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const status = { ...telemetryStatus(), run: null };
    const scene = {
      revision: 1,
      antenna_field_solve_stages: [{ id: "inspect_gsg", source_object_id: "antenna", current_transport_id: "gsg_charge" }],
      study: {
        stages: [{ kind: "antenna_field_solve", stage_id: "dormant" }],
        study_pipeline: { version: "study_pipeline.v1", nodes: [{
          id: "queue-1", label: "GSG inspection", node_kind: "primitive",
          stage_kind: "antenna_field_solve", enabled: true,
          payload: { kind: "antenna_field_solve", stage_id: "inspect_gsg" },
        }] },
      },
    } as SceneResource;
    hooks.scene = { data: scene, status: "ready" };
    const root = createRoot(container as unknown as Element);
    const render = () => act(async () => root.render(
      <FooterTelemetry bus={new EventBus<KernelEventMap>()} status={status}
        stageExecution={{ data: null, status: "ready" }} view="antenna" />,
    ));
    try {
      await render();
      expect(container.textContent).toContain("Antenna stage configured — not started");
      expect(container.textContent).toContain("inspect_gsg");
      expect(container.textContent).toContain("antenna");
      expect(container.textContent).toContain("gsg_charge");
      expect(container.textContent).not.toContain("dormant");
      expect(container.querySelector('[role="progressbar"]')).toBeNull();
      const panel = container.querySelector('[aria-label="Antenna telemetry"]');
      hooks.scene = { data: scene, status: "stale" };
      await render();
      expect(container.querySelector('[aria-label="Antenna telemetry"]')).toBe(panel);
      expect(container.textContent).toContain("not started");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
