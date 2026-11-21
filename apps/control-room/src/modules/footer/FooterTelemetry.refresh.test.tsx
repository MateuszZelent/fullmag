import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { RunPerformanceResource, ScalarWindowResource, SceneResource, SolverStatusResource } from "@/kernel/api/apiTypes";
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
  performance: null as RunPerformanceResource | null,
  solverStatus: null as SolverStatusResource | null,
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
    useRunPerformanceResource: () => ({
      ...emptyResource(),
      data: hooks.performance,
      status: hooks.performance ? "ready" : "idle",
    }),
    useScalarWindowResource: (options: { columns: readonly string[]; limit: number }) => {
      hooks.scalarColumns.push([...options.columns]);
      if (options.limit > 1 && hooks.history) {
        return { ...emptyResource(), data: hooks.history, status: "ready" };
      }
      return emptyResource();
    },
    useSolverStatusResource: () => ({
      ...emptyResource(),
      data: hooks.solverStatus,
      status: hooks.solverStatus ? "ready" : "idle",
    }),
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
  it("uses the current run stage summary when the runtime does not publish stage execution", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const bus = new EventBus<KernelEventMap>();
    const baseStatus = telemetryStatus();
    const status = {
      ...baseStatus,
      run: {
        ...baseStatus.run!,
        stage_count: 6,
        stage_index: 1,
        stage_label: "Relax",
      },
    };
    hooks.scene = { data: null, status: "idle" };

    try {
      await act(async () =>
        root.render(
          <FooterTelemetry
            bus={bus}
            status={status}
            stageExecution={{ data: null, status: "ready" }}
            view="overview"
          />,
        ),
      );

      expect(container.querySelector(".fm-footer-telemetry__stage-badge")?.textContent)
        .toBe("Stage 2/6");
      expect(container.querySelector(".fm-footer-telemetry__stage-label")?.textContent)
        .toBe("Relax · progress not published");
      expect(container.querySelector(".fm-footer-telemetry__stage-bar")?.getAttribute("aria-valuenow"))
        .toBeNull();
      expect(container.querySelector(".fm-footer-telemetry__notice")?.textContent)
        .toBe("Stage progress not published by this runtime");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("uses only matching performance progress when stage execution is unpublished", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const bus = new EventBus<KernelEventMap>();
    const baseStatus = telemetryStatus();
    const status = {
      ...baseStatus,
      run: {
        ...baseStatus.run!,
        stage_count: 6,
        stage_index: 1,
        stage_label: "Relax",
      },
    };
    hooks.scene = { data: null, status: "idle" };
    hooks.performance = {
      state: "running",
      run_id: "run-1",
      task_id: "task-1",
      step_id: "stage-id-1",
      attempt_id: "attempt-1",
      ownership_epoch: 1,
      stage_index: 1,
      step_index: 9423,
      first_step_index: 0,
      elapsed_monotonic_ns: 120_000_000_000,
      solver_clock: { step_index: 9423, time_s: 7.488e-9, dt_s: 1e-12 },
      progress_fraction: 0.3744,
      sample_sequence: 9424,
      unique_step_callback_records: 9424,
      gpu_scope: "whole_device",
      points: [],
      rows_dropped: 0,
      revision: "performance-current",
    } as RunPerformanceResource;

    try {
      await act(async () =>
        root.render(
          <FooterTelemetry
            bus={bus}
            status={status}
            stageExecution={{ data: null, status: "ready" }}
            view="overview"
          />,
        ),
      );

      expect(container.querySelector(".fm-footer-telemetry__stage-badge")?.textContent)
        .toBe("Stage 2/6");
      expect(container.querySelector(".fm-footer-telemetry__stage-label")?.textContent)
        .toBe("Relax · 37%");
      expect(container.querySelector(".fm-footer-telemetry__stage-bar")?.getAttribute("aria-valuenow"))
        .toBe("37.44");
      expect(container.querySelector(".fm-footer-telemetry__notice"))
        .toBeNull();

      hooks.performance = { ...hooks.performance, stage_index: 0 } as RunPerformanceResource;
      await act(async () =>
        root.render(
          <FooterTelemetry
            bus={bus}
            status={status}
            stageExecution={{ data: null, status: "ready" }}
            view="overview"
          />,
        ),
      );
      expect(container.querySelector(".fm-footer-telemetry__stage-label")?.textContent)
        .toBe("Relax · progress not published");
      expect(container.querySelector(".fm-footer-telemetry__notice")?.textContent)
        .toBe("Stage progress not published by this runtime");
    } finally {
      await act(async () => root.unmount());
      hooks.performance = null;
      dom.restore();
    }
  });

  it("keeps the accepted terminal stage fraction when the run completes", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const bus = new EventBus<KernelEventMap>();
    const baseStatus = telemetryStatus();
    const status: FooterTelemetryStatus = {
      ...baseStatus,
      run: {
        ...baseStatus.run!,
        stage_count: 1,
        stage_index: 0,
        stage_label: "Immediate pulse",
      },
      solver: { ...baseStatus.solver, state: "completed" },
    };
    hooks.scene = { data: null, status: "idle" };
    hooks.performance = {
      state: "completed",
      run_id: "run-1",
      task_id: "task-1",
      step_id: "pulse-stage-id",
      attempt_id: "attempt-1",
      ownership_epoch: 1,
      stage_index: 0,
      step_index: 28_070,
      first_step_index: 0,
      elapsed_monotonic_ns: 120_000_000_000,
      solver_clock: { step_index: 28_070, time_s: 8e-9, dt_s: 1e-13 },
      progress_fraction: 1,
      sample_sequence: 28_071,
      unique_step_callback_records: 28_071,
      gpu_scope: "whole_device",
      points: [],
      rows_dropped: 0,
      revision: "performance-completed",
    } as RunPerformanceResource;

    try {
      await act(async () =>
        root.render(
          <FooterTelemetry
            bus={bus}
            status={status}
            stageExecution={{ data: null, status: "ready" }}
            view="overview"
          />,
        ),
      );
      expect(container.querySelector(".fm-footer-telemetry__stage-badge")?.textContent)
        .toBe("Stage 1/1");
      expect(container.querySelector(".fm-footer-telemetry__stage-label")?.textContent)
        .toBe("Immediate pulse · 100%");
      expect(container.querySelector(".fm-footer-telemetry__stage-bar")?.getAttribute("aria-valuenow"))
        .toBe("100");
      expect(cardLabels(container)).toContain("Stage rate");
    } finally {
      await act(async () => root.unmount());
      hooks.performance = null;
      dom.restore();
    }
  });

  it("keeps the exact run integrator visible through a brief solver-status gap", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const bus = new EventBus<KernelEventMap>();
    const status = telemetryStatus();
    hooks.scene = { data: null, status: "idle" };
    hooks.solverStatus = {
      algorithm: "fdm",
      integrator: "rk45",
      run_id: "run-1",
    } as SolverStatusResource;
    const render = () => act(async () =>
      root.render(
        <FooterTelemetry
          bus={bus}
          status={status}
          stageExecution={{ data: null, status: "ready" }}
          view="overview"
        />,
      ),
    );
    const solverValue = () => container
      .querySelectorAll(".fm-footer-telemetry__metric")
      .find((metric) => metric.querySelector(".fm-footer-telemetry__metric-label")?.textContent === "Solver")
      ?.querySelector(".fm-footer-telemetry__metric-number")?.textContent;

    try {
      await render();
      expect(solverValue()).toBe("RK45");
      hooks.solverStatus = null;
      await render();
      expect(solverValue()).toBe("RK45");
    } finally {
      await act(async () => root.unmount());
      hooks.solverStatus = null;
      dom.restore();
    }
  });

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
          "dt",
          "pseudo_time_s",
          "mx",
          "my",
          "mz",
          "e_total",
        ]),
      );
      expect(requestedColumns).not.toContain("active_runtime_s");
      expect(requestedColumns).toHaveLength(8);
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
