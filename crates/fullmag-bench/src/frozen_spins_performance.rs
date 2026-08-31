//! FDM CPU performance probe for the Frozen Spins P15 gates.
//!
//! This command intentionally measures the public, reusable-buffer CPU step
//! path. It compares an identical problem with no Frozen Spins constraint to a
//! problem with a deterministic partial mask, measures activation separately,
//! and records the explicit dense mask/reference storage contract. The
//! benchmark is CPU-only: it must not emit fabricated CUDA/H2D/D2H numbers.
//!
//! Example (from the repository root):
//! cargo run --release -p fullmag-bench -- frozen-spins-performance
//!   --run-id frozen-spins-fdm-cpu-performance-20260831T120000Z \
//!   --output C:\\absolute\\path\\runs\\frozen-spins-fdm-cpu-performance-20260831T120000Z\\raw.json

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use crate::alloc_counter;
use fullmag_engine::{
    CellSize, EffectiveFieldTerms, EvaluationRequest, ExchangeLlgProblem, FftWorkspace, GridShape,
    LlgConfig, MaterialParameters, TimeIntegrator, Vector3,
};
use fullmag_ir::{
    ResolvedFrozenSpinsPlanIR, SelectionAuthoredFingerprintIR, SelectionCertificateIR,
    RESOLVED_FROZEN_SPINS_PLAN_SCHEMA_VERSION, SELECTION_CERTIFICATE_SCHEMA_VERSION,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

const BENCHMARK_SCHEMA: &str = "fullmag.frozen_spins.fdm_cpu.performance.benchmark.v1";
const POLICY_SCHEMA: &str = "fullmag.frozen_spins.performance_policy.v1";
const BENCHMARK_ID: &str = "FS-P15-FDM-CPU-PERFORMANCE-V1";
const PLAN_PROVENANCE: &str = "synthetic_deterministic_performance_plan";
const DEFAULT_SITE_COUNTS: &[usize] = &[4_096, 1_000_000];
const DEFAULT_REPETITIONS: usize = 5;
const DEFAULT_STEPS_PER_SAMPLE: usize = 8;
const WARMUP_STEPS: usize = 2;
const PARTIAL_MASK_STRIDE: usize = 4;
const DT_S: f64 = 1.0e-15;
const CELL_M: f64 = 5.0e-9;

#[derive(Debug, Serialize)]
struct PerformanceDocument {
    schema_version: &'static str,
    policy_schema_version: &'static str,
    benchmark_id: &'static str,
    status: &'static str,
    acceptance_status: &'static str,
    implementation_status: &'static str,
    plan_provenance: &'static str,
    plan_validation: &'static str,
    lane: Lane,
    benchmark: BenchmarkConfig,
    cases: Vec<PerformanceCase>,
    runtime: RuntimeMetadata,
}

#[derive(Debug, Serialize)]
struct Lane {
    backend: &'static str,
    execution: &'static str,
    precision: &'static str,
    integrator: &'static str,
    evaluation: &'static str,
    terms: &'static str,
    fallback_used: bool,
}

#[derive(Debug, Serialize)]
struct BenchmarkConfig {
    site_counts_requested: Vec<usize>,
    repetitions: usize,
    steps_per_sample: usize,
    warmup_steps: usize,
    partial_mask_stride: usize,
    partial_mask_fraction: f64,
    comparison_scope: &'static str,
    layout_comparison: LayoutComparison,
    activation_timing_scope: &'static str,
    step_timing_scope: &'static str,
    step_routes: StepRoutes,
    workspace_scope: &'static str,
    dt_s: f64,
    cell_size_m: [f64; 3],
}

#[derive(Debug, Serialize)]
struct LayoutComparison {
    no_mask_layout: &'static str,
    partial_mask_layout: &'static str,
    matched_layout_mask_isolation: &'static str,
    interpretation: &'static str,
}

#[derive(Debug, Serialize)]
struct StepRoutes {
    no_mask: &'static str,
    partial_mask: &'static str,
}

#[derive(Debug, Serialize)]
struct RuntimeMetadata {
    run_id: String,
    hostname: String,
    rayon_threads: usize,
    thread_policy: ThreadPolicyMetadata,
    clock: &'static str,
    source_identity: SourceIdentity,
    binary_identity: BinaryIdentity,
}

#[derive(Debug, Serialize)]
struct ThreadPolicyMetadata {
    schema_version: &'static str,
    lane: &'static str,
    environment_variable: &'static str,
    environment_value: Option<String>,
    requested_rayon_threads: Option<usize>,
    observed_rayon_threads: usize,
    role: &'static str,
}

#[derive(Debug, Serialize)]
struct SourceIdentity {
    status: &'static str,
    git_commit: Option<String>,
    dirty_tree: Option<bool>,
    reason: &'static str,
}

#[derive(Debug, Serialize)]
struct BinaryIdentity {
    package: &'static str,
    executable: &'static str,
    profile: &'static str,
    target_os: &'static str,
    path: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug, Serialize)]
struct PerformanceCase {
    site_count: usize,
    mode: &'static str,
    execution_layout: &'static str,
    frozen_site_count: usize,
    free_site_count: usize,
    repetitions: usize,
    steps_per_sample: usize,
    warmup_steps: usize,
    step_wall_time_ns: Vec<u64>,
    activation_wall_time_ns: Vec<u64>,
    activation_allocation_count: Vec<u64>,
    activation_allocated_bytes: Vec<u64>,
    steady_state_allocation_count: Vec<u64>,
    steady_state_allocated_bytes: Vec<u64>,
    mask_bytes: u64,
    mask_bytes_semantics: &'static str,
    host_mask_storage_type: &'static str,
    host_mask_exact_allocated_bytes: Option<u64>,
    host_mask_exact_allocated_bytes_status: &'static str,
    reference_bytes: u64,
    reference_bytes_semantics: &'static str,
    storage_bytes: u64,
    storage_bytes_semantics: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    NoMask,
    PartialMask,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Self::NoMask => "no_mask",
            Self::PartialMask => "partial_mask",
        }
    }

    fn execution_layout(self) -> &'static str {
        match self {
            // The runtime's no-mask CPU problem is eligible for the persistent
            // SoA fast path. A non-empty frozen mask intentionally selects the
            // AoS-compatible path until a mask-aware SoA implementation exists.
            Self::NoMask => "soa",
            Self::PartialMask => "aos",
        }
    }
}

#[derive(Debug)]
struct Config {
    run_id: String,
    output: PathBuf,
    site_counts: Vec<usize>,
    repetitions: usize,
    steps_per_sample: usize,
}

/// Run the benchmark command and write the raw measurement artifact.
pub fn run_from_args(args: &[String]) -> Result<(), String> {
    let config = parse_args(args)?;
    let thread_policy = thread_policy_metadata()?;
    let cases = run_cases(&config)?;
    let hostname = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());
    let binary_identity = binary_identity()?;
    let document = PerformanceDocument {
        schema_version: BENCHMARK_SCHEMA,
        policy_schema_version: POLICY_SCHEMA,
        benchmark_id: BENCHMARK_ID,
        // Raw output records completed measurements only. Acceptance is
        // evaluated by the versioned Python builder, so a raw artifact can
        // never be mistaken for a threshold PASS (for example on the current
        // 48-thread small-grid layout cliff).
        status: "MEASUREMENT_COMPLETED",
        acceptance_status: "NOT_EVALUATED",
        implementation_status: "EXECUTED",
        plan_provenance: PLAN_PROVENANCE,
        plan_validation: "validate_intrinsic_before_runtime_capture",
        lane: Lane {
            backend: "fdm",
            execution: "cpu_reference",
            precision: "double",
            integrator: "heun",
            evaluation: "minimal",
            terms: "none",
            fallback_used: false,
        },
        benchmark: BenchmarkConfig {
            site_counts_requested: config.site_counts.clone(),
            repetitions: config.repetitions,
            steps_per_sample: config.steps_per_sample,
            warmup_steps: WARMUP_STEPS,
            partial_mask_stride: PARTIAL_MASK_STRIDE,
            partial_mask_fraction: 1.0 / PARTIAL_MASK_STRIDE as f64,
            comparison_scope: "end_to_end_runtime_overhead_including_layout_dispatch",
            layout_comparison: LayoutComparison {
                no_mask_layout: Mode::NoMask.execution_layout(),
                partial_mask_layout: Mode::PartialMask.execution_layout(),
                matched_layout_mask_isolation: "not_measured",
                interpretation: "The ratio is an end-to-end production-path comparison; it is not an isolated mask-only overhead measurement.",
            },
            activation_timing_scope: "FrozenSpinsState::capture_at_activation",
            step_timing_scope: "public_reusable_buffer_production_routes",
            step_routes: StepRoutes {
                no_mask: "ExchangeLlgProblem::step_soa_with_buffers_evaluation+ExchangeLlgStateSoA::publish_accepted_to",
                partial_mask: "ExchangeLlgProblem::step_with_buffers_evaluation",
            },
            workspace_scope: "inert_single_cell_no_demag",
            dt_s: DT_S,
            cell_size_m: [CELL_M; 3],
        },
        cases,
        runtime: RuntimeMetadata {
            run_id: config.run_id.clone(),
            hostname,
            rayon_threads: thread_policy.observed_rayon_threads,
            thread_policy,
            clock: "std::time::Instant::monotonic",
            source_identity: SourceIdentity {
                status: "NOT_BOUND",
                git_commit: None,
                dirty_tree: None,
                reason: "The benchmark harness does not infer clean source identity; bind this artifact in the production qualification run.",
            },
            binary_identity,
        },
    };
    write_json_atomic(&config.output, &document)?;
    println!(
        "FROZEN_SPINS_FDM_CPU_PERFORMANCE_OUTPUT={} status=MEASUREMENT_COMPLETED site_counts={:?}",
        config.output.display(),
        config.site_counts
    );
    Ok(())
}

fn parse_args(args: &[String]) -> Result<Config, String> {
    let mut run_id = None;
    let mut output = None;
    let mut site_counts = DEFAULT_SITE_COUNTS.to_vec();
    let mut repetitions = DEFAULT_REPETITIONS;
    let mut steps_per_sample = DEFAULT_STEPS_PER_SAMPLE;
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag {
            "--run-id" => run_id = Some(parse_run_id(value)?),
            "--output" => output = Some(PathBuf::from(value)),
            "--sites" => site_counts = parse_usize_list(value, "--sites")?,
            "--repetitions" => repetitions = parse_positive_usize(value, "--repetitions")?,
            "--steps" => steps_per_sample = parse_positive_usize(value, "--steps")?,
            _ => return Err(format!("unknown argument {flag}")),
        }
        index += 2;
    }
    let output = output.ok_or_else(|| "--output ABSOLUTE_PATH is required".to_string())?;
    let run_id = run_id.ok_or_else(|| "--run-id SAFE_ID is required".to_string())?;
    if !output.is_absolute() {
        return Err("--output must be an absolute path".to_string());
    }
    if site_counts.iter().any(|count| *count < 2) {
        return Err("every site count must be at least 2".to_string());
    }
    site_counts.sort_unstable();
    site_counts.dedup();
    if site_counts.is_empty() {
        return Err("--sites must contain at least one site count".to_string());
    }
    Ok(Config {
        run_id,
        output,
        site_counts,
        repetitions,
        steps_per_sample,
    })
}

fn parse_run_id(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 128 {
        return Err("--run-id must contain 1..128 characters".to_string());
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("--run-id may contain only ASCII letters, digits, '-', '_' or '.'".to_string());
    }
    Ok(value.to_string())
}

fn parse_usize_list(value: &str, flag: &str) -> Result<Vec<usize>, String> {
    let values = value
        .split(',')
        .map(|item| {
            item.parse::<usize>()
                .map_err(|error| format!("{flag} contains invalid integer {item:?}: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if values.iter().any(|item| *item == 0) {
        return Err(format!("{flag} values must be positive"));
    }
    Ok(values)
}

fn parse_positive_usize(value: &str, flag: &str) -> Result<usize, String> {
    let parsed = value
        .parse::<usize>()
        .map_err(|error| format!("{flag} contains invalid integer {value:?}: {error}"))?;
    if parsed == 0 {
        return Err(format!("{flag} must be positive"));
    }
    Ok(parsed)
}

fn run_cases(config: &Config) -> Result<Vec<PerformanceCase>, String> {
    let mut cases = Vec::with_capacity(config.site_counts.len() * 2);
    for &site_count in &config.site_counts {
        for mode in [Mode::NoMask, Mode::PartialMask] {
            eprintln!(
                "frozen-spins-performance: sites={} mode={} repetitions={} steps={}",
                site_count,
                mode.as_str(),
                config.repetitions,
                config.steps_per_sample
            );
            cases.push(run_case(
                site_count,
                mode,
                config.repetitions,
                config.steps_per_sample,
            )?);
        }
    }
    Ok(cases)
}

fn run_case(
    site_count: usize,
    mode: Mode,
    repetitions: usize,
    steps_per_sample: usize,
) -> Result<PerformanceCase, String> {
    let mask = partial_mask(site_count);
    let plan = resolved_plan(&mask, site_count)?;
    let frozen_site_count = if mode == Mode::PartialMask {
        mask.iter().filter(|value| **value).count()
    } else {
        0
    };
    let (activation_wall_time_ns, activation_allocation_count, activation_allocated_bytes) =
        if mode == Mode::PartialMask {
            activation_samples(site_count, repetitions, &plan)?
        } else {
            (Vec::new(), Vec::new(), Vec::new())
        };

    let free_site_count = site_count
        .checked_sub(frozen_site_count)
        .ok_or_else(|| "frozen site count exceeds site count".to_string())?;
    // Activation is measured above on fresh problem/state pairs. The timed
    // instance is separate, and no-mask follows the same persistent SoA state
    // route as the production CPU runner. Partial-mask intentionally follows
    // the production AoS route because frozen spins currently reject SoA.
    let (step_wall_time_ns, steady_state_allocation_count, steady_state_allocated_bytes) =
        match mode {
            Mode::NoMask => run_no_mask_soa_steps(site_count, repetitions, steps_per_sample)?,
            Mode::PartialMask => {
                run_partial_mask_aos_steps(site_count, repetitions, steps_per_sample, &plan)?
            }
        };

    let mask_bytes = if mode == Mode::PartialMask {
        // This is the logical dense-u8 payload contract, not a claim about
        // the allocator footprint of Vec<bool> (which is not exposed here).
        bytes_for(site_count, 1)?
    } else {
        0
    };
    let reference_bytes = if mode == Mode::PartialMask {
        bytes_for(site_count, std::mem::size_of::<Vector3>())?
    } else {
        0
    };
    let storage_bytes = mask_bytes
        .checked_add(reference_bytes)
        .ok_or_else(|| "mask/reference storage byte count overflow".to_string())?;
    let (
        mask_bytes_semantics,
        host_mask_storage_type,
        host_mask_exact_allocated_bytes,
        host_mask_exact_allocated_bytes_status,
        reference_bytes_semantics,
        storage_bytes_semantics,
    ) = if mode == Mode::PartialMask {
        (
            "logical_dense_u8_payload",
            "Vec<bool>",
            None,
            "NOT_OBSERVABLE",
            "logical_vec_payload",
            "logical_dense_payload_sum",
        )
    } else {
        (
            "not_applicable",
            "none",
            Some(0),
            "NOT_APPLICABLE",
            "not_applicable",
            "not_applicable",
        )
    };

    Ok(PerformanceCase {
        site_count,
        mode: mode.as_str(),
        execution_layout: mode.execution_layout(),
        frozen_site_count,
        free_site_count,
        repetitions,
        steps_per_sample,
        warmup_steps: WARMUP_STEPS,
        step_wall_time_ns,
        activation_wall_time_ns,
        activation_allocation_count,
        activation_allocated_bytes,
        steady_state_allocation_count,
        steady_state_allocated_bytes,
        mask_bytes,
        mask_bytes_semantics,
        host_mask_storage_type,
        host_mask_exact_allocated_bytes,
        host_mask_exact_allocated_bytes_status,
        reference_bytes,
        reference_bytes_semantics,
        storage_bytes,
        storage_bytes_semantics,
    })
}

fn activation_samples(
    site_count: usize,
    repetitions: usize,
    plan: &ResolvedFrozenSpinsPlanIR,
) -> Result<(Vec<u64>, Vec<u64>, Vec<u64>), String> {
    let mut wall_time_ns = Vec::with_capacity(repetitions);
    let mut allocation_count = Vec::with_capacity(repetitions);
    let mut allocated_bytes = Vec::with_capacity(repetitions);
    for _ in 0..repetitions {
        let mut problem = performance_problem(site_count)?;
        let mut state = problem
            .uniform_state([1.0, 0.0, 0.0])
            .map_err(|error| format!("activation state construction failed: {error}"))?;
        alloc_counter::reset();
        let started = Instant::now();
        problem
            .capture_frozen_spins_at_activation(plan, &mut state)
            .map_err(|error| format!("Frozen Spins activation failed: {error}"))?;
        wall_time_ns.push(elapsed_ns(started));
        let (count, bytes) = alloc_counter::snapshot();
        allocation_count.push(count);
        allocated_bytes.push(bytes);
    }
    Ok((wall_time_ns, allocation_count, allocated_bytes))
}

fn run_no_mask_soa_steps(
    site_count: usize,
    repetitions: usize,
    steps_per_sample: usize,
) -> Result<(Vec<u64>, Vec<u64>, Vec<u64>), String> {
    let problem = performance_problem(site_count)?;
    let published_state = problem
        .uniform_state([1.0, 0.0, 0.0])
        .map_err(|error| format!("state construction failed: {error}"))?;
    let mut state = published_state.to_soa();
    let mut published_state = published_state;
    // The benchmark intentionally disables demag, so the workspace is not
    // touched by the measured path. A one-cell workspace keeps the probe
    // focused on integration/mask overhead instead of FFT plan allocation.
    let mut workspace = FftWorkspace::new(1, 1, 1, CELL_M, CELL_M, CELL_M);
    let mut buffers = problem.create_integrator_buffers();

    // Warmup selects the persistent SoA route and primes runtime allocations.
    // It is deliberately excluded from all reported timing samples.
    for _ in 0..WARMUP_STEPS {
        problem
            .step_soa_with_buffers_evaluation(
                &mut state,
                DT_S,
                &mut workspace,
                &mut buffers,
                EvaluationRequest::Minimal,
            )
            .map_err(|error| format!("SoA warmup step failed: {error}"))?;
        state.publish_accepted_to(&mut published_state);
    }
    measure_soa_steps(
        &problem,
        &mut state,
        &mut workspace,
        &mut buffers,
        &mut published_state,
        repetitions,
        steps_per_sample,
    )
}

fn run_partial_mask_aos_steps(
    site_count: usize,
    repetitions: usize,
    steps_per_sample: usize,
    plan: &ResolvedFrozenSpinsPlanIR,
) -> Result<(Vec<u64>, Vec<u64>, Vec<u64>), String> {
    let mut problem = performance_problem(site_count)?;
    let mut state = problem
        .uniform_state([1.0, 0.0, 0.0])
        .map_err(|error| format!("state construction failed: {error}"))?;
    problem
        .capture_frozen_spins_at_activation(plan, &mut state)
        .map_err(|error| format!("Frozen Spins activation failed: {error}"))?;
    let mut workspace = FftWorkspace::new(1, 1, 1, CELL_M, CELL_M, CELL_M);
    let mut buffers = problem.create_integrator_buffers();

    // The partial-mask production route is AoS until a mask-aware persistent
    // SoA implementation is available. Warmup is excluded from measurements.
    for _ in 0..WARMUP_STEPS {
        problem
            .step_with_buffers_evaluation(
                &mut state,
                DT_S,
                &mut workspace,
                &mut buffers,
                EvaluationRequest::Minimal,
            )
            .map_err(|error| format!("AoS warmup step failed: {error}"))?;
    }
    measure_aos_steps(
        &problem,
        &mut state,
        &mut workspace,
        &mut buffers,
        repetitions,
        steps_per_sample,
    )
}

fn measure_soa_steps(
    problem: &ExchangeLlgProblem,
    state: &mut fullmag_engine::ExchangeLlgStateSoA,
    workspace: &mut FftWorkspace,
    buffers: &mut fullmag_engine::IntegratorBuffers,
    published_state: &mut fullmag_engine::ExchangeLlgState,
    repetitions: usize,
    steps_per_sample: usize,
) -> Result<(Vec<u64>, Vec<u64>, Vec<u64>), String> {
    let mut step_wall_time_ns = Vec::with_capacity(repetitions);
    let mut steady_state_allocation_count = Vec::with_capacity(repetitions);
    let mut steady_state_allocated_bytes = Vec::with_capacity(repetitions);
    for _ in 0..repetitions {
        alloc_counter::reset();
        let started = Instant::now();
        for _ in 0..steps_per_sample {
            problem
                .step_soa_with_buffers_evaluation(
                    state,
                    DT_S,
                    workspace,
                    buffers,
                    EvaluationRequest::Minimal,
                )
                .map_err(|error| format!("measured SoA step failed: {error}"))?;
            state.publish_accepted_to(published_state);
        }
        step_wall_time_ns.push(elapsed_ns(started));
        let (allocation_count, allocated_bytes) = alloc_counter::snapshot();
        steady_state_allocation_count.push(allocation_count);
        steady_state_allocated_bytes.push(allocated_bytes);
    }
    Ok((
        step_wall_time_ns,
        steady_state_allocation_count,
        steady_state_allocated_bytes,
    ))
}

fn measure_aos_steps(
    problem: &ExchangeLlgProblem,
    state: &mut fullmag_engine::ExchangeLlgState,
    workspace: &mut FftWorkspace,
    buffers: &mut fullmag_engine::IntegratorBuffers,
    repetitions: usize,
    steps_per_sample: usize,
) -> Result<(Vec<u64>, Vec<u64>, Vec<u64>), String> {
    let mut step_wall_time_ns = Vec::with_capacity(repetitions);
    let mut steady_state_allocation_count = Vec::with_capacity(repetitions);
    let mut steady_state_allocated_bytes = Vec::with_capacity(repetitions);
    for _ in 0..repetitions {
        alloc_counter::reset();
        let started = Instant::now();
        for _ in 0..steps_per_sample {
            problem
                .step_with_buffers_evaluation(
                    state,
                    DT_S,
                    workspace,
                    buffers,
                    EvaluationRequest::Minimal,
                )
                .map_err(|error| format!("measured AoS step failed: {error}"))?;
        }
        step_wall_time_ns.push(elapsed_ns(started));
        let (allocation_count, allocated_bytes) = alloc_counter::snapshot();
        steady_state_allocation_count.push(allocation_count);
        steady_state_allocated_bytes.push(allocated_bytes);
    }
    Ok((
        step_wall_time_ns,
        steady_state_allocation_count,
        steady_state_allocated_bytes,
    ))
}

fn performance_problem(site_count: usize) -> Result<ExchangeLlgProblem, String> {
    let grid = GridShape::new(site_count, 1, 1).map_err(|error| format!("grid: {error}"))?;
    let cell_size =
        CellSize::new(CELL_M, CELL_M, CELL_M).map_err(|error| format!("cell size: {error}"))?;
    let dynamics = LlgConfig::new(
        fullmag_engine::DEFAULT_GYROMAGNETIC_RATIO,
        TimeIntegrator::Heun,
    )
    .map_err(|error| format!("LLG config: {error}"))?;
    Ok(ExchangeLlgProblem::with_terms(
        grid,
        cell_size,
        MaterialParameters::new(8.0e5, 1.3e-11, 0.01)
            .map_err(|error| format!("material: {error}"))?,
        dynamics,
        // A zero-field problem isolates the CPU step/mask overhead while the
        // public step path still traverses the full integration pipeline.
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            ..Default::default()
        },
    ))
}

fn partial_mask(site_count: usize) -> Vec<bool> {
    (0..site_count)
        .map(|index| index % PARTIAL_MASK_STRIDE == 0)
        .collect()
}

fn resolved_plan(mask: &[bool], site_count: usize) -> Result<ResolvedFrozenSpinsPlanIR, String> {
    let frozen_site_count = mask.iter().filter(|value| **value).count() as u64;
    let active_site_count = site_count as u64;
    let free_site_count = active_site_count - frozen_site_count;
    let mask_sha256 = resolved_mask_sha256(mask);
    let topology = format!("frozen-spins-performance-grid-{site_count}");
    let constraint_ids = vec!["frozen-spins-performance".to_string()];
    let certificate = SelectionCertificateIR {
        schema_version: SELECTION_CERTIFICATE_SCHEMA_VERSION.to_string(),
        evaluator_id: "selection.fdm_cell_center.v1".to_string(),
        constraint_ids: constraint_ids.clone(),
        authored_fingerprints: vec![SelectionAuthoredFingerprintIR {
            constraint_id: constraint_ids[0].clone(),
            selector_sha256: "a".repeat(64),
        }],
        raw_candidate_dof_count: frozen_site_count,
        inactive_candidate_dof_count: 0,
        active_dof_count: active_site_count,
        frozen_dof_count: frozen_site_count,
        free_dof_count: free_site_count,
        bounds_m: None,
        grid_or_mesh_fingerprint: topology.clone(),
        source_state_revision: Some(1),
        mask_sha256: mask_sha256.clone(),
        resolved_reference_sha256: "b".repeat(64),
        warnings: Vec::new(),
    };
    let plan = ResolvedFrozenSpinsPlanIR {
        schema_version: RESOLVED_FROZEN_SPINS_PLAN_SCHEMA_VERSION.to_string(),
        constraint_ids,
        frozen_mask: mask.to_vec(),
        active_dof_count: active_site_count,
        frozen_dof_count: frozen_site_count,
        free_dof_count: free_site_count,
        mask_sha256,
        grid_or_mesh_fingerprint: topology,
        source_state_revision: Some(1),
        all_active_dofs_frozen: free_site_count == 0,
        certificate,
    };
    plan.validate_intrinsic()?;
    Ok(plan)
}

fn resolved_mask_sha256(mask: &[bool]) -> String {
    let mut hash = Sha256::new();
    hash.update((mask.len() as u64).to_le_bytes());
    hash.update(
        mask.iter()
            .map(|value| u8::from(*value))
            .collect::<Vec<_>>(),
    );
    format!("{:x}", hash.finalize())
}

fn bytes_for(count: usize, item_size: usize) -> Result<u64, String> {
    count
        .checked_mul(item_size)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| "storage byte count overflow".to_string())
}

fn elapsed_ns(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX)
}

fn thread_policy_metadata() -> Result<ThreadPolicyMetadata, String> {
    // Rayon reads RAYON_NUM_THREADS while its global pool is initialized. Read
    // the observed pool size after forcing that initialization, and retain the
    // requested value so the evidence builder can reject an unqualified or
    // accidentally inherited thread configuration.
    let observed_rayon_threads = rayon::current_num_threads();
    let environment_value = std::env::var("RAYON_NUM_THREADS").ok();
    let requested_rayon_threads = match environment_value.as_deref() {
        Some(value) => Some(value.parse::<usize>().map_err(|error| {
            format!("RAYON_NUM_THREADS must be a positive integer, got {value:?}: {error}")
        })?),
        None => None,
    };
    if requested_rayon_threads == Some(0) {
        return Err("RAYON_NUM_THREADS must be positive".to_string());
    }
    let (lane, role) = match (requested_rayon_threads, observed_rayon_threads) {
        (Some(48), 48) => ("production_default", "required_production_gate"),
        (Some(1), 1) => (
            "serial_deterministic_supplemental",
            "supplemental_microbenchmark_only",
        ),
        _ => ("unqualified", "not_qualified_by_versioned_thread_policy"),
    };
    Ok(ThreadPolicyMetadata {
        schema_version: "fullmag.frozen_spins.performance_thread_policy.v1",
        lane,
        environment_variable: "RAYON_NUM_THREADS",
        environment_value,
        requested_rayon_threads,
        observed_rayon_threads,
        role,
    })
}

fn binary_identity() -> Result<BinaryIdentity, String> {
    let path = std::env::current_exe()
        .map_err(|error| format!("locating current executable for identity: {error}"))?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("reading executable metadata {}: {error}", path.display()))?;
    let size_bytes = metadata.len();
    if size_bytes == 0 {
        return Err(format!("current executable is empty: {}", path.display()));
    }
    let bytes = fs::read(&path).map_err(|error| {
        format!(
            "reading executable {} for identity: {error}",
            path.display()
        )
    })?;
    let mut hash = Sha256::new();
    hash.update(&bytes);
    Ok(BinaryIdentity {
        package: "fullmag-bench",
        executable: "fullmag-bench",
        profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        target_os: std::env::consts::OS,
        path: path.display().to_string(),
        size_bytes,
        sha256: format!("{:x}", hash.finalize()),
    })
}

fn write_json_atomic<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if path.exists() && path.is_dir() {
        return Err(format!("output path is a directory: {}", path.display()));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("creating output directory {}: {error}", parent.display()))?;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("output path has no UTF-8 file name: {}", path.display()))?;
    let temporary = path.with_file_name(format!(".{file_name}.tmp-{}-{nonce}", std::process::id()));
    let encoded = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("serializing benchmark: {error}"))?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("creating {}: {error}", temporary.display()))?;
    file.write_all(&encoded)
        .map_err(|error| format!("writing {}: {error}", temporary.display()))?;
    file.sync_all()
        .map_err(|error| format!("syncing {}: {error}", temporary.display()))?;
    drop(file);
    let result = atomic_replace(&temporary, path);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn atomic_replace(temporary: &Path, path: &Path) -> Result<(), String> {
    fs::rename(temporary, path)
        .map_err(|error| format!("publishing {}: {error}", path.display()))?;
    // Persist the directory entry where the platform exposes directory fsync.
    if let Some(parent) = path.parent() {
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("syncing output directory {}: {error}", parent.display()))?;
    }
    Ok(())
}

#[cfg(windows)]
fn atomic_replace(temporary: &Path, path: &Path) -> Result<(), String> {
    use std::{ffi::OsStr, iter::once, os::windows::ffi::OsStrExt};

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let from = OsStr::new(temporary.as_os_str())
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let to = OsStr::new(path.as_os_str())
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(format!(
            "publishing {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_mask_has_deterministic_fraction_and_storage_contract() {
        let mask = partial_mask(16);
        assert_eq!(mask.iter().filter(|value| **value).count(), 4);
        assert_eq!(resolved_mask_sha256(&mask), resolved_mask_sha256(&mask));
        assert_eq!(bytes_for(1_000_000, 1), Ok(1_000_000));
        assert_eq!(
            bytes_for(1_000_000, std::mem::size_of::<Vector3>()),
            Ok(24_000_000)
        );
    }

    #[test]
    fn synthetic_plan_is_intrinsic_validated_and_bad_mask_hash_is_rejected() {
        let mask = partial_mask(16);
        let plan = resolved_plan(&mask, 16).expect("synthetic performance plan");
        assert_eq!(plan.validate_intrinsic(), Ok(()));
        let mut invalid = plan.clone();
        invalid.mask_sha256 = "0".repeat(64);
        assert!(invalid.validate_intrinsic().is_err());
    }

    #[test]
    fn small_probe_records_both_modes_and_real_activation_sample() {
        let no_mask = run_case(16, Mode::NoMask, 2, 2).expect("no-mask probe");
        let partial = run_case(16, Mode::PartialMask, 2, 2).expect("partial probe");
        assert_eq!(no_mask.mode, "no_mask");
        assert_eq!(partial.mode, "partial_mask");
        assert_eq!(no_mask.frozen_site_count, 0);
        assert_eq!(partial.frozen_site_count, 4);
        assert_eq!(partial.free_site_count, 12);
        assert_eq!(partial.activation_wall_time_ns.len(), 2);
        assert!(partial
            .activation_wall_time_ns
            .iter()
            .all(|value| *value > 0));
        assert_eq!(partial.activation_allocation_count.len(), 2);
        assert_eq!(partial.activation_allocated_bytes.len(), 2);
        assert_eq!(partial.mask_bytes, 16);
        assert_eq!(partial.mask_bytes_semantics, "logical_dense_u8_payload");
        assert_eq!(partial.host_mask_storage_type, "Vec<bool>");
        assert_eq!(partial.host_mask_exact_allocated_bytes, None);
        assert_eq!(
            partial.host_mask_exact_allocated_bytes_status,
            "NOT_OBSERVABLE"
        );
        assert_eq!(
            partial.reference_bytes,
            16 * std::mem::size_of::<Vector3>() as u64
        );
        assert_eq!(partial.reference_bytes_semantics, "logical_vec_payload");
        assert_eq!(
            partial.storage_bytes,
            partial.mask_bytes + partial.reference_bytes
        );
        assert!(no_mask.activation_wall_time_ns.is_empty());
        assert!(no_mask.step_wall_time_ns.iter().all(|value| *value > 0));
        assert!(partial.step_wall_time_ns.iter().all(|value| *value > 0));
    }

    #[test]
    fn parser_requires_absolute_output_and_accepts_explicit_million_sites() {
        let absolute_output = std::env::temp_dir().join("frozen-spins.json");
        let args = vec![
            "--run-id".to_string(),
            "test-parser-million-sites".to_string(),
            "--output".to_string(),
            absolute_output.display().to_string(),
            "--sites".to_string(),
            "64,1000000".to_string(),
            "--repetitions".to_string(),
            "3".to_string(),
            "--steps".to_string(),
            "2".to_string(),
        ];
        let parsed = parse_args(&args).expect("explicit benchmark config");
        assert_eq!(parsed.site_counts, vec![64, 1_000_000]);
        assert_eq!(parsed.run_id, "test-parser-million-sites");
        assert_eq!(parsed.repetitions, 3);
        assert_eq!(parsed.steps_per_sample, 2);
        assert!(parse_args(&[
            "--run-id".to_string(),
            "test".to_string(),
            "--output".to_string(),
            "relative.json".to_string()
        ])
        .is_err());
        assert!(parse_args(&[
            "--output".to_string(),
            absolute_output.display().to_string()
        ])
        .is_err());
    }

    #[test]
    fn atomic_writer_replaces_existing_output() {
        let output = std::env::temp_dir().join(format!(
            "fullmag-frozen-spins-performance-overwrite-{}.json",
            std::process::id()
        ));
        write_json_atomic(&output, &serde_json::json!({"value": 1})).expect("first write");
        write_json_atomic(&output, &serde_json::json!({"value": 2})).expect("overwrite write");
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(&output).expect("read overwritten output"))
                .expect("decode overwritten output");
        assert_eq!(value["value"], 2);
        let _ = fs::remove_file(output);
    }
}
