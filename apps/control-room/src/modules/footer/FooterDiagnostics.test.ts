import { describe, expect, it } from "vitest";

import type {
  CpuTelemetryResource,
  SolverProfileResource,
} from "@/kernel/api/apiTypes";

import {
  buildCpuTelemetryPanelModel,
  buildSolverProfilePanelModel,
  serializeSolverProfileRows,
} from "./FooterDiagnostics";

const PROFILE_SAMPLE_TIME_MS = new Date(2026, 0, 2, 3, 4, 5, 123).getTime();

const profile: SolverProfileResource = {
  aggregates: {
    average_demag_ns: 2_000_000,
    average_exchange_ns: 150_000,
    average_total_ns: 5_000_000,
    max_total_ns: 5_000_000,
    sample_count: 1,
  },
  artifact_refs: ["diagnostics/solver_profile.jsonl"],
  live_publisher: {
    coalesced_wake_count: 4,
    disconnected_wake_count: 0,
    last_clone_wall_time_ns: 8_000,
    last_merge_wall_time_ns: 12_000,
    last_payload_estimated_bytes: 45 * 1024,
    last_publish_lag_wall_time_ns: 2_000_000,
    last_publish_wall_time_ns: 3_000_000,
    last_replace_wall_time_ns: 20_000,
    max_clone_wall_time_ns: 8_000,
    max_merge_wall_time_ns: 12_000,
    max_payload_estimated_bytes: 45 * 1024,
    max_publish_lag_wall_time_ns: 2_000_000,
    max_publish_wall_time_ns: 3_000_000,
    max_replace_wall_time_ns: 20_000,
    publish_count: 7,
    replace_count: 11,
    total_clone_wall_time_ns: 16_000,
    total_merge_wall_time_ns: 24_000,
    total_publish_lag_wall_time_ns: 4_000_000,
    total_publish_wall_time_ns: 6_000_000,
    total_replace_wall_time_ns: 40_000,
  },
  config: {
    emit_engine_log: true,
    enabled: true,
    max_samples: 32,
    persist_artifact: true,
    sample_every: 1,
  },
  preview_3d_disabled: false,
  latest_samples: [
    {
      demag_solves: 1,
      demag_solver: "CG",
      demag_preconditioner: "JACOBI",
      demag_solver_setup_reused: true,
      demag_subphase_sum_ns: 1_900_000,
      demag_subphases: [
        {
          id: "demag_solver_apply",
          label: "demag_solver_apply",
          percent_of_total: 38,
          wall_time_ns: 1_900_000,
        },
      ],
      delta_wall_time_ns: null,
      dt: 1e-13,
      artifact_enqueue_bytes: 4 * 1024,
      artifact_queue_depth_current: 1,
      artifact_queue_depth_max: 3,
      artifact_field_snapshot_writer_wall_time_ns: 3_000_000,
      artifact_native_field_snapshot_writer_wall_time_ns: 0,
      artifact_scalar_row_writer_wall_time_ns: 1_000_000,
      artifact_writer_job_wall_time_ns: 4_000_000,
      artifact_writer_jobs_completed: 2,
      field_copy_bytes: 24 * 1024 * 1024,
      finalization_field_copy_bytes: 8 * 1024,
      finalization_field_copy_wall_time_ns: 70_000,
      finalization_wall_time_ns: 80_000,
      hot_loop_control_scalar_d2h_bytes: 16,
      hot_loop_control_scalar_host_sync_count: 2,
      hot_loop_host_sync_count: 2,
      missing_ns: 25_000,
      native_ffi_overhead_wall_time_ns: 25_000,
      phase_sum_ns: 4_975_000,
      phase_windows: [
        {
          id: "demag_total",
          label: "Demag total",
          max_wall_time_ns: 2_100_000,
          mean_wall_time_ns: 2_000_000,
          sum_wall_time_ns: 6_000_000,
        },
      ],
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
        {
          id: "relax_preconditioner",
          label: "relax_preconditioner",
          percent_of_total: 15,
          wall_time_ns: 750_000,
        },
        {
          id: "field_copy",
          label: "field_copy",
          percent_of_total: 5,
          wall_time_ns: 250_000,
        },
        {
          id: "artifact_enqueue",
          label: "artifact_enqueue",
          percent_of_total: 2,
          wall_time_ns: 100_000,
        },
        {
          id: "native_ffi_overhead",
          label: "native_ffi_overhead",
          percent_of_total: 1,
          wall_time_ns: 25_000,
        },
        {
          id: "finalization",
          label: "finalization",
          percent_of_total: 2,
          wall_time_ns: 80_000,
        },
        {
          id: "relax_gradient",
          label: "relax_gradient",
          percent_of_total: 1,
          wall_time_ns: 30_000,
        },
        {
          id: "relax_state_upload",
          label: "relax_state_upload",
          percent_of_total: 1,
          wall_time_ns: 15_000,
        },
        {
          id: "relax_metric",
          label: "relax_metric",
          percent_of_total: 1,
          wall_time_ns: 10_000,
        },
        {
          id: "relax_line_search",
          label: "relax_line_search",
          percent_of_total: 1,
          wall_time_ns: 5_000,
        },
      ],
      poisson_final_residual: 1e-8,
      poisson_iterations: 12,
      rejected_attempts: 0,
      rhs_evaluations: 2,
      sample_time_unix_ms: PROFILE_SAMPLE_TIME_MS,
      sample_kinds: ["normal_step"],
      span_first_step: 11,
      span_last_step: 13,
      span_monotonic_wall_time_ns: 100_000_000,
      span_step_count: 3,
      profiled_step_total_ns: 30_000_000,
      native_solver_wall_time_ns: 15_000_000,
      unprofiled_gap_total_ns: 70_000_000,
      unprofiled_gap_per_step_ns: 23_333_333,
      step: 12,
      threading: {
        cap_reason: "auto-small-mesh-cap",
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
    expect(model.threadSummary).toBe("OMP 8->1 | manual | auto-small-mesh-cap");
    expect(model.hasSingleThreadWarning).toBe(true);
    expect(model.previewModeSummary).toBe("3D preview enabled");
    expect(model.windowPhaseSummary).toBe(
      "Window phases: Demag total sum 6.0 ms / mean 2.0 ms / max 2.1 ms",
    );
    expect(model.livePublisherSummary).toBe(
      "Live publish 7 / replace 20.0 us / merge 12.0 us / clone 8.0 us / sync 3.0 ms / lag 2.0 ms / payload 45.0 KiB / coalesced 4",
    );
    expect(model.rows[0]).toMatchObject({
      artifact: "100.0 us / 4.0 KiB / q3 / w2 4.0 ms",
      demag: "2.0 ms",
      demagDetail: "CG/JACOBI / 1 solve / 12 it / res 1.0e-8 / apply 1.9 ms",
      demagSetup: "reused",
      exchange: "150.0 us",
      fieldCopy: "250.0 us / 24.0 MiB",
      finalization: "80.0 us / 8.0 KiB",
      gapPerStep: "23.3 ms",
      gapTotal: "70.0 ms",
      gpuSync: "2 sync / ctrl 2 / 16 B",
      missing: "25.0 us",
      nativeFfi: "25.0 us / upload 15.0 us / grad 30.0 us / metric 10.0 us / ls 5.0 us",
      relaxPreconditioner: "750.0 us",
      rhs: "3.0 ms",
      clock: "03:04:05.123",
      spanSteps: "11-13 (3)",
      spanWall: "100.0 ms",
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
          delta_wall_time_ns: 2_333_000_000,
          sample_time_unix_ms: PROFILE_SAMPLE_TIME_MS + 2_333,
          span_first_step: 14,
          span_last_step: 16,
          span_monotonic_wall_time_ns: 2_333_000_000,
          time: 2e-12,
          total_ns: 6_000_000,
        },
      ],
    };
    const model = buildSolverProfilePanelModel(duplicateStepProfile);

    expect(model.rows.map((row) => row.step)).toEqual(["12", "12"]);
    expect(model.rows.map((row) => row.spanSteps)).toEqual([
      "14-16 (3)",
      "11-13 (3)",
    ]);
    expect(model.rows.map((row) => row.spanWall)).toEqual(["2.33 s", "100.0 ms"]);
    expect(new Set(model.rows.map((row) => row.id)).size).toBe(2);
  });

  it("labels profiler samples captured with 3D preview disabled", () => {
    const model = buildSolverProfilePanelModel({
      ...profile,
      preview_3d_disabled: true,
    });

    expect(model.previewModeSummary).toBe("3D preview disabled for benchmark");
  });

  it("serializes visible solver profiler rows for clipboard copy", () => {
    const model = buildSolverProfilePanelModel(profile);

    expect(serializeSolverProfileRows(model.rows)).toBe(
      [
        "Last step\tClock\tSpan steps\tSpan wall\tGap total\tGap/step\tTotal (last step)\tExchange (last step)\tDemag (last step)\tDemag detail\tSetup\tRelax prec.\tRHS\tPreview\tCache\tField copy\tArtifact\tFinalization\tGPU sync\tNative\tOrchestr.\tMissing",
        "12\t03:04:05.123\t11-13 (3)\t100.0 ms\t70.0 ms\t23.3 ms\t5.0 ms\t150.0 us\t2.0 ms\tCG/JACOBI / 1 solve / 12 it / res 1.0e-8 / apply 1.9 ms\treused\t750.0 us\t3.0 ms\t0 ns\t0 ns\t250.0 us / 24.0 MiB\t100.0 us / 4.0 KiB / q3 / w2 4.0 ms\t80.0 us / 8.0 KiB\t2 sync / ctrl 2 / 16 B\t25.0 us / upload 15.0 us / grad 30.0 us / metric 10.0 us / ls 5.0 us\t0 ns\t25.0 us",
      ].join("\n"),
    );
  });

  it("keeps the profiler panel idle when the resource is missing", () => {
    const model = buildSolverProfilePanelModel(null);

    expect(model.rows).toEqual([]);
    expect(model.allRows).toEqual([]);
    expect(model.sampleCount).toBe(0);
    expect(model.threadSummary).toBe("Threading pending");
    expect(model.previewModeSummary).toBe("Preview mode pending");
    expect(model.windowPhaseSummary).toBe("Window phases pending");
    expect(model.hasSingleThreadWarning).toBe(false);
  });
});
