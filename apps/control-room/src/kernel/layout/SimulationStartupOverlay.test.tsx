import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { LiveStatusResource } from "../api/apiTypes";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { ModuleRegistry } from "../module/ModuleRegistry";
import type { ResourceResult } from "../resources/resourceTypes";
import { KernelContext } from "../KernelContext";
import type { KernelApi } from "../types";

import {
  SimulationStartupOverlayView,
  openSimulationPreparationDiagnostics,
  resolveSimulationStartupOverlayState,
  shouldRefreshSimulationStartupStatus,
} from "./SimulationStartupOverlay";
import {
  resolveSimulationPreparationViewModel,
  serializeSimulationPreparationDiagnostics,
} from "./simulationPreparationModel";
import { LayoutController } from "./LayoutController";

const source = readFileSync(
  new URL("./SimulationStartupOverlay.tsx", import.meta.url),
  "utf8",
);

const refetch = vi.fn();

function startupGateKernel(): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  return {
    bus,
    layout: new LayoutController(bus),
    modules: new ModuleRegistry(),
  } as KernelApi;
}

function preparationResource(
  patch: Partial<import("../api/apiTypes").SimulationPreparationResource> = {},
): import("../api/apiTypes").SimulationPreparationResource {
  const ids = [
    "runtime_startup",
    "script_materialization",
    "validation",
    "planning",
    "domain_preparation",
    "meshing",
    "mesh_postprocessing",
    "solver_initialization",
    "ready",
  ] as const;
  const labels = [
    "Runtime startup",
    "Script materialization",
    "Validation",
    "Planning",
    "Domain preparation",
    "Meshing",
    "Mesh post-processing",
    "Solver initialization",
    "Ready",
  ];
  return {
    active_stage_id: "meshing",
    completed_at_unix_ms: null,
    failure: null,
    log_tail: [
      {
        level: "info",
        message: "Optimizing element quality",
        stage_id: "meshing",
        timestamp_unix_ms: 18_500,
      },
    ],
    preparation_id: "prep-7",
    requested_execution: {
      backend: "fem",
      device: "auto",
      engine_id: null,
      mode: "strict",
      precision: "double",
      runtime_family: null,
      worker: null,
    },
    resolved_execution: {
      backend: "fem",
      device: "gpu",
      engine_id: "mfem",
      mode: "strict",
      precision: "double",
      runtime_family: "local",
      worker: null,
    },
    revision: 7,
    stages: ids.map((id, index) => ({
      completed_at_unix_ms: index < 5 ? 2_500 : null,
      detail: id === "meshing" ? "Optimizing element quality" : "",
      duration_ms: index < 5 ? 500 : id === "meshing" ? 16_200 : null,
      id,
      label: labels[index]!,
      progress_label:
        id === "meshing" ? "142580 / 226318 elements" : null,
      progress_percent: id === "meshing" ? 63 : null,
      started_at_unix_ms: id === "meshing" ? 2_500 : null,
      status: index < 5 ? "completed" : id === "meshing" ? "active" : "pending",
    })),
    started_at_unix_ms: 0,
    status: "running",
    ...patch,
  };
}

function preparationResult(
  data = preparationResource(),
  status: ResourceResult<import("../api/apiTypes").SimulationPreparationResource>["status"] = "ready",
) {
  return {
    data,
    error: null,
    refetch,
    revision: data.revision,
    status,
  } satisfies ResourceResult<import("../api/apiTypes").SimulationPreparationResource>;
}

function statusResource(
  patch: Partial<LiveStatusResource> = {},
): ResourceResult<LiveStatusResource> {
  return {
    data: {
      resources: {},
      session: { name: "arch_waveguide_relax_50nm" },
      lifecycle: {
        commandability: "allowed",
        connectivity: "connected",
        session_resource: "active",
        solver: "idle",
      },
      solver: { state: "awaiting_command" },
      ...patch,
    } as LiveStatusResource,
    error: null,
    refetch,
    revision: 1,
    status: "ready",
  };
}

describe("SimulationStartupOverlay", () => {
  it("shows while the session status resource is loading", () => {
    const state = resolveSimulationStartupOverlayState({
      data: null,
      error: null,
      refetch,
      revision: null,
      status: "loading",
    });

    expect(state).toMatchObject({
      detail: "Connecting to the local simulation backend.",
      isVisible: true,
      title: "Preparing simulation",
    });
  });

  it("shows explicit startup phases from the backend status", () => {
    expect(
      resolveSimulationStartupOverlayState(
        statusResource({
          solver: { state: "bootstrapping" },
        }),
      ),
    ).toMatchObject({
      detail: "Starting the runtime workspace.",
      isVisible: true,
      title: "Preparing simulation",
    });

    expect(
      resolveSimulationStartupOverlayState(
        statusResource({
          solver: { state: "materializing_script" },
        }),
      ),
    ).toMatchObject({
      detail: "Compiling the model and preparing runtime data.",
      isVisible: true,
      title: "Compiling simulation",
    });
  });

  it("treats a transient missing workspace error as startup loading", () => {
    const state = resolveSimulationStartupOverlayState({
      data: null,
      error: new Error("no active local live workspace"),
      refetch,
      revision: null,
      status: "error",
    });

    expect(state).toMatchObject({
      detail: "Waiting for the runtime workspace to become available.",
      isVisible: true,
      title: "Preparing simulation",
    });
  });

  it("hydrates the smoke bypass from browser config after startup", () => {
    expect(source).toContain("useState(false)");
    expect(source).toContain("useEffect(() => {");
    expect(source).toContain("window.setTimeout(() => {");
    expect(source).toContain("setAllowMissingSessionSmoke(");
    expect(source).toContain("getSimulationStartupSmokeBypassSnapshot()");
    expect(source).toContain("window.clearTimeout(timeoutId)");
  });

  it("allows controlled offline smoke tests to bypass the startup gate", () => {
    const state = resolveSimulationStartupOverlayState(
      {
        data: null,
        error: new Error("fetch failed"),
        refetch,
        revision: null,
        status: "error",
      },
      { allowMissingSessionSmoke: true },
    );

    expect(state).toMatchObject({ isVisible: false, kind: "hidden" });
  });

  it("does not hide unrelated API errors behind the startup overlay", () => {
    expect(
      resolveSimulationStartupOverlayState({
        data: null,
        error: new Error("API contract version mismatch"),
        refetch,
        revision: null,
        status: "error",
      }),
    ).toMatchObject({ isVisible: false, kind: "hidden" });
  });

  it("renders an accessible nonmodal status with collapsed details", () => {
    const html = renderToStaticMarkup(
      <SimulationStartupOverlayView
        state={resolveSimulationStartupOverlayState(
          statusResource({ solver: { state: "materializing_script" } }),
        )}
      />,
    );

    expect(html).toContain('aria-label="Simulation preparation status"');
    expect(html).not.toContain('data-interaction-state="blocked"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("View preparation details");
    expect(html).toContain("Compiling simulation");
    expect(html).toContain("Compiling the model");
    expect(html).toContain('aria-label="Simulation preparation progress"');
  });

  it("renders pending status beside the workspace content", () => {
    const html = renderToStaticMarkup(
      <>
        <div data-slot-id="viewport-main">Viewport module</div>
        <SimulationStartupOverlayView
          state={resolveSimulationStartupOverlayState({
            data: null,
            error: new Error("no active local live workspace"),
            refetch,
            revision: null,
            status: "error",
          })}
        />
      </>,
    );

    const viewportTag = html.match(
      /<div[^>]*data-slot-id="viewport-main"[^>]*>/,
    )?.[0];
    const startupStatusTag = html.match(
      /<aside[^>]*class="fm-simulation-startup"[^>]*>/,
    )?.[0];

    expect(html).toContain("Preparing simulation");
    expect(html).toContain("viewport-main");
    expect(viewportTag).toBeDefined();
    expect(viewportTag).not.toMatch(/\s(?:inert|aria-hidden)(?:=|\s|>)/);
    expect(startupStatusTag).toBeDefined();
    expect(startupStatusTag).not.toContain("aria-modal");
  });

  it("selects startup overlay state instead of subscribing to full session status", () => {
    expect(source).toContain("selectSimulationStartupOverlayResourceState");
    expect(source).toContain("simulationStartupOverlayResourceStateEquals");
    expect(source).toMatch(
      /useSessionStatusSelector\(\s*selectSimulationStartupOverlayResourceState/,
    );
    expect(source).not.toContain("useSessionStatus,");
    expect(source).not.toContain("const sessionStatus = useSessionStatus();");
  });

  it("keeps refreshing status while startup overlay is visible", () => {
    expect(source).not.toContain("setInterval(");
    expect(source).toContain("statusRefreshIntervalMs()");
    expect(source).not.toContain("SIMULATION_STARTUP_STATUS_REFRESH_MS");

    expect(
      shouldRefreshSimulationStartupStatus(
        resolveSimulationStartupOverlayState(
          statusResource({ solver: { state: "materializing_script" } }),
        ),
      ),
    ).toBe(true);

    const ready = resolveSimulationPreparationViewModel(
      preparationResult(
        preparationResource({
          active_stage_id: null,
          completed_at_unix_ms: 20_000,
          status: "ready",
        }),
      ),
      statusResource(),
      20_000,
    );
    expect(shouldRefreshSimulationStartupStatus(ready)).toBe(false);

    const staleReady = resolveSimulationPreparationViewModel(
      preparationResult(
        preparationResource({
          active_stage_id: null,
          completed_at_unix_ms: 20_000,
          status: "ready",
        }),
        "stale",
      ),
      { ...statusResource(), status: "stale" },
      20_000,
      // Only a transport disruption (or failed refresh) makes a retained
      // snapshot stale; a refetch in flight alone does not.
      true,
    );
    // Ready is terminal, so a disruption afterwards neither reopens the
    // window nor keeps the startup gate or its polling alive.
    expect(staleReady).toMatchObject({ isVisible: false, kind: "stale" });
    expect(shouldRefreshSimulationStartupStatus(staleReady)).toBe(false);
  });

  it("renders option A with determinate progress, ordered stages, and a visible log", () => {
    const model = resolveSimulationPreparationViewModel(
      preparationResult(),
      statusResource({ solver: { state: "bootstrapping" } }),
      18_700,
    );
    const html = renderToStaticMarkup(
      <SimulationStartupOverlayView state={model} />,
    );

    expect(html).toContain("Simulation preparation");
    expect(html).toContain('aria-label="Simulation preparation progress"');
    expect(html).toContain('aria-valuenow="63"');
    expect(html).toContain("Requested");
    expect(html).toContain("Resolved");
    expect(html).toContain("Preparation log");
    expect(html).toContain('aria-live="off"');
    const stageList = html.slice(html.indexOf("<ol"), html.indexOf("</ol>"));
    const orderedLabels = model.stages.map((stage) =>
      stageList.indexOf(stage.label),
    );
    expect(orderedLabels).toEqual([...orderedLabels].sort((left, right) => left - right));
  });

  it("renders accepted preparation provenance without inventing it", () => {
    const planFingerprint = `sha256:${"a".repeat(64)}`;
    const model = resolveSimulationPreparationViewModel(
      preparationResult(
        preparationResource({
          receipt: {
            payload_sha256: "b".repeat(64),
            plan_fingerprint: planFingerprint,
            preparation_id: "prep-accepted",
            run_id: "run-accepted",
            schema_version: "preparation_receipt.v1",
          },
        }),
      ),
      statusResource({ solver: { state: "bootstrapping" } }),
      18_700,
    );
    const html = renderToStaticMarkup(
      <SimulationStartupOverlayView state={model} />,
    );

    expect(html).toContain('data-preparation-receipt="accepted"');
    expect(html).toContain("prep-accepted");
    expect(html).toContain("run-accepted");
    expect(html).toContain("preparation_receipt.v1");
    expect(html).toContain(planFingerprint);
    expect(html).toContain("b".repeat(64));
  });

  it("renders an active Gmsh attempt as indeterminate without a fabricated percent", () => {
    const resource = preparationResource();
    resource.stages = resource.stages.map((stage) =>
      stage.id === "meshing"
        ? {
            ...stage,
            progress_label: "Attempt 3 — Frontal — progress indeterminate",
            progress_percent: null,
          }
        : stage,
    );
    const model = resolveSimulationPreparationViewModel(
      preparationResult(resource),
      statusResource({ solver: { state: "bootstrapping" } }),
      18_700,
    );
    const html = renderToStaticMarkup(
      <SimulationStartupOverlayView state={model} />,
    );

    expect(html).toContain('data-kind="indeterminate"');
    expect(html).not.toContain('aria-valuenow="');
    expect(html).toContain("Attempt 3 — Frontal — progress indeterminate");
    expect(html).not.toContain("75%");
  });

  it("limits polite announcements to stage and terminal summaries", () => {
    const model = resolveSimulationPreparationViewModel(
      preparationResult(),
      statusResource({ solver: { state: "bootstrapping" } }),
      18_700,
    );
    const html = renderToStaticMarkup(
      <SimulationStartupOverlayView state={model} />,
    );

    expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
    expect(html.match(/aria-live="off"/g)).toHaveLength(1);
  });

  it("keeps failure diagnostics available without gating the workspace", () => {
    const failed = preparationResource({
      active_stage_id: null,
      failure: {
        diagnostics_correlation_id: "diag-42",
        detail: "failed_predicates=[unsupported_cubic_anisotropy]",
        error_code: "mesh_generation_failed",
        stage_id: "meshing",
        summary: "Mesh generation did not converge.",
      },
      status: "failed",
    });
    const state = resolveSimulationPreparationViewModel(
      preparationResult(failed),
      statusResource({ solver: { state: "failed" } }),
      20_000,
    );
    const kernel = startupGateKernel();
    expect(state.failure?.detail).toBe(
      "failed_predicates=[unsupported_cubic_anisotropy]",
    );
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <>
          <div data-slot-id="viewport-main">Viewport module</div>
          <SimulationStartupOverlayView state={state} />
        </>
      </KernelContext.Provider>,
    );

    expect(html).toContain("Mesh generation did not converge.");
    expect(html).toContain("diag-42");
    expect(html).toContain("Copy diagnostics");
    expect(html).toContain("Open full diagnostics");
    expect(html).toContain('data-kind="terminal"');
    expect(html).toContain('aria-valuetext="Simulation preparation failed"');
    expect(html).not.toContain("Connecting to the simulation backend");
    expect(html).not.toContain('aria-valuenow="');
    expect(html).toContain("Failed");
    expect(html).toContain("viewport-main");
    expect(html).not.toContain('aria-modal="true"');
    expect(html).not.toContain(" inert");
  });

  it("serializes only the bounded safe preparation projection", () => {
    const preparation = preparationResource();
    const unsafe = {
      ...preparation,
      environment: { token: "secret-token" },
      failure: {
        diagnostics_correlation_id: "diag-42",
        detail: "failed_predicates=[unsupported_cubic_anisotropy]",
        error_code: "mesh_generation_failed",
        stage_id: "meshing" as const,
        summary: "Mesh generation did not converge.",
      },
      host_path: "/home/user/private/model.py",
      log_tail: Array.from({ length: 205 }, (_, index) => ({
        level: "info" as const,
        message: `safe entry ${index}`,
        stage_id: "meshing" as const,
        timestamp_unix_ms: index,
      })),
      stages: preparation.stages.map((stage, index) =>
        index === 1
          ? {
              ...stage,
              clock_adjustment: {
                backward_delta_ms: 32_000,
                observed_at_unix_ms: 8_000,
                stage_started_at_unix_ms: 40_000,
              },
              completed_at_unix_ms: 8_000,
            }
          : stage,
      ),
    };
    const diagnostics = serializeSimulationPreparationDiagnostics(unsafe);
    const projection = JSON.parse(diagnostics) as {
      failure: { detail: string };
      log_tail: unknown[];
      stages: Array<{ clock_adjustment?: unknown }>;
    };

    expect(projection.failure.detail).toBe(
      "failed_predicates=[unsupported_cubic_anisotropy]",
    );
    expect(projection.log_tail).toHaveLength(200);
    expect(projection.stages[1]?.clock_adjustment).toEqual({
      backward_delta_ms: 32_000,
      observed_at_unix_ms: 8_000,
      stage_started_at_unix_ms: 40_000,
    });
    expect(diagnostics).not.toContain("secret-token");
    expect(diagnostics).not.toContain("/home/user/private/model.py");
  });

  it("opens the existing kernel diagnostics destination", () => {
    const emit = vi.fn();
    const openBottomPanel = vi.fn();

    openSimulationPreparationDiagnostics({
      bus: { emit },
      layout: { openBottomPanel },
    });

    expect(openBottomPanel).toHaveBeenCalledWith("diagnostics");
    expect(emit).toHaveBeenCalledWith("footer:tab-requested", {
      reason: "simulation-preparation",
      tab: "diagnostics",
    });
  });
});
