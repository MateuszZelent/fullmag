import { describe, expect, it } from "vitest";

import type {
  CpuTelemetryResource,
  SolverProfileResource,
} from "@/kernel/api/apiTypes";

import {
  buildCpuTelemetryPanelModel,
  buildSolverProfilePanelModel,
} from "./FooterDiagnostics";

const profile: SolverProfileResource = {
  aggregates: {
    average_demag_ns: 2_000_000,
    average_exchange_ns: 150_000,
    average_total_ns: 5_000_000,
    max_total_ns: 5_000_000,
    sample_count: 1,
  },
  artifact_refs: ["diagnostics/solver_profile.jsonl"],
  config: {
    emit_engine_log: true,
    enabled: true,
    max_samples: 32,
    persist_artifact: true,
    sample_every: 1,
  },
  latest_samples: [
    {
      demag_solves: 1,
      demag_subphase_sum_ns: 1_900_000,
      demag_subphases: [
        {
          id: "demag_solver_apply",
          label: "demag_solver_apply",
          percent_of_total: 38,
          wall_time_ns: 1_900_000,
        },
      ],
      dt: 1e-13,
      missing_ns: 50_000,
      phase_sum_ns: 4_950_000,
      phases: [
        {
          id: "exchange",
          label: "exchange",
          percent_of_total: 3,
          wall_time_ns: 150_000,
        },
        {
          id: "demag_total",
          label: "demag_total",
          percent_of_total: 40,
          wall_time_ns: 2_000_000,
        },
        {
          id: "rhs_total",
          label: "rhs_total",
          percent_of_total: 60,
          wall_time_ns: 3_000_000,
        },
      ],
      poisson_final_residual: 1e-8,
      poisson_iterations: 12,
      rejected_attempts: 0,
      rhs_evaluations: 2,
      step: 12,
      threading: {
        effective_omp_threads: 1,
        mfem_device: null,
        openmp_available: true,
        openmp_compiled: true,
        requested_omp_threads: 8,
        thread_mode: "manual",
      },
      time: 1e-12,
      total_ns: 5_000_000,
    },
  ],
  revision: 3,
  state: "enabled",
  threading: null,
};

describe("FooterDiagnostics", () => {
  it("builds CPU telemetry rows from host and process samples", () => {
    const cpu: CpuTelemetryResource = {
      logical_cpus: 40,
      memory_total_mb: 32000,
      memory_used_mb: 12000,
      model_name: "AMD Ryzen Threadripper",
      process_cpu_percent: 385.2,
      process_rss_mb: 512,
      process_threads: 44,
      sample_time_unix_ms: 1,
      status: "available",
      utilization_cpu_percent: 62.4,
    };

    const model = buildCpuTelemetryPanelModel(cpu);

    expect(model.status).toBe("available");
    expect(model.rows).toEqual([
      {
        id: "host",
        label: "AMD Ryzen Threadripper",
        memory: "12000 / 32000 MB",
        utilization: "62%",
      },
      {
        id: "process",
        label: "Fullmag API",
        memory: "512 MB RSS",
        utilization: "385%",
      },
      {
        id: "threads",
        label: "Threads",
        memory: "44 process",
        utilization: "40 logical",
      },
    ]);
  });

  it("builds solver profile rows and warns when OpenMP is effectively single-threaded", () => {
    const model = buildSolverProfilePanelModel(profile);

    expect(model.state).toBe("enabled");
    expect(model.sampleCount).toBe(1);
    expect(model.threadSummary).toBe("OMP 8->1 | manual");
    expect(model.hasSingleThreadWarning).toBe(true);
    expect(model.rows[0]).toMatchObject({
      demag: "2.0 ms",
      exchange: "150.0 us",
      missing: "50.0 us",
      rhs: "3.0 ms",
      step: "12",
      total: "5.0 ms",
    });
  });

  it("uses unique row identities when profiler samples share the same step", () => {
    const duplicateStepProfile: SolverProfileResource = {
      ...profile,
      aggregates: {
        ...profile.aggregates,
        sample_count: 2,
      },
      latest_samples: [
        profile.latest_samples[0],
        {
          ...profile.latest_samples[0],
          time: 2e-12,
          total_ns: 6_000_000,
        },
      ],
    };
    const model = buildSolverProfilePanelModel(duplicateStepProfile);

    expect(model.rows.map((row) => row.step)).toEqual(["12", "12"]);
    expect(new Set(model.rows.map((row) => row.id)).size).toBe(2);
  });

  it("keeps the profiler panel idle when the resource is missing", () => {
    const model = buildSolverProfilePanelModel(null);

    expect(model.rows).toEqual([]);
    expect(model.sampleCount).toBe(0);
    expect(model.threadSummary).toBe("Threading pending");
    expect(model.hasSingleThreadWarning).toBe(false);
  });
});
