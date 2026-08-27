use std::{
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

use fullmag_ir::{
    BackendPlanIR, DriveActivationIR, DynamicsIR, EnergyTermIR, FdmDemagHintsIR, FieldDriveKindIR,
    FieldSpatialProfileIR, FieldTargetIR, FieldTimeOriginIR, InitialMagnetizationIR, OutputIR,
    ProblemIR, RegionalFieldDriveIR, RequestedFemDemagIR, StudyIR, TimeDependenceIR,
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::alloc_counter;

const SCHEMA_VERSION: &str = "fullmag.fdm.cpu.production_qualification.v1";
const DT_S: f64 = 1e-13;
const ACCURACY_FIELD_B_T: f64 = 1e-2;
const ACCURACY_FINAL_TIME_S: f64 = 1e-9;
const ACCURACY_TOLERANCE: f64 = 1e-3;
const ACCURACY_TIMESTEPS_S: [f64; 3] = [5e-11, 2.5e-11, 1.25e-11];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum RunMode {
    Control,
    Requested,
    Full,
}

impl RunMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Control => "control",
            Self::Requested => "requested",
            Self::Full => "full",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Profile {
    Smoke,
    Full,
}

#[derive(Debug)]
struct Config {
    output_root: PathBuf,
    profile: Profile,
    commit: String,
    build_identity: String,
}

#[derive(Debug, Clone, Copy)]
struct Fixture {
    name: &'static str,
    cell_m: [f64; 3],
    steps: u64,
}

#[derive(Debug, Serialize)]
struct ProductionRunEvidence {
    fixture: String,
    mode: RunMode,
    grid: [u32; 3],
    cell_count: u64,
    simulated_time_s: f64,
    planner_wall_time_ns: u64,
    end_to_end_wall_time_ns: u64,
    allocation_count: u64,
    allocation_bytes: u64,
    peak_live_heap_growth_bytes: u64,
    backend_plan_sha256: String,
    final_magnetization_sha256: String,
    requested_execution: Value,
    execution_provenance: Value,
    artifact_pipeline: Value,
}

#[derive(Debug, Serialize)]
struct ProductionQualificationSuite {
    schema_version: &'static str,
    commit: String,
    build_identity: String,
    source_identity: SourceIdentityEvidence,
    hardware_identity: HardwareIdentity,
    hardware_fingerprint_sha256: String,
    profile: String,
    qualification_status: &'static str,
    qualification_blockers: Vec<&'static str>,
    process_peak_resident_bytes: u64,
    time_to_accuracy: TimeToAccuracyEvidence,
    results: Vec<ProductionRunEvidence>,
}

#[derive(Debug, Serialize)]
struct SourceIdentityEvidence {
    built_at_utc: &'static str,
    git_commit: &'static str,
    worktree_state: &'static str,
    source_snapshot_sha256: &'static str,
    rustc_version: &'static str,
    target_triple: &'static str,
}

#[derive(Debug, Serialize)]
struct HardwareIdentity {
    operating_system: &'static str,
    architecture: &'static str,
    cpu_vendor: String,
    cpu_brand: String,
    detected_cpu_features: Vec<&'static str>,
    available_logical_cpu_count: usize,
    rayon_thread_count: usize,
    rayon_num_threads_environment: Option<String>,
    thread_policy: &'static str,
    precision_policy: &'static str,
    accelerator_driver: &'static str,
    accelerator_toolkit: &'static str,
}

#[derive(Debug, Serialize)]
struct TimeToAccuracyEvidence {
    oracle_id: &'static str,
    tolerance_max_abs: f64,
    field_b_t: f64,
    final_time_s: f64,
    exact_magnetization: [f64; 3],
    first_passing_timestep_s: f64,
    first_passing_wall_time_ns: u64,
    observed_order_coarse_to_fine: f64,
    runs: Vec<TimeToAccuracyRunEvidence>,
}

#[derive(Debug, Serialize)]
struct TimeToAccuracyRunEvidence {
    timestep_s: f64,
    expected_steps: u64,
    planner_wall_time_ns: u64,
    end_to_end_wall_time_ns: u64,
    max_abs_error: f64,
    passes: bool,
    final_magnetization: [f64; 3],
    requested_execution: Value,
    execution_provenance: Value,
}

pub(super) fn run_from_args(args: &[String]) -> Result<(), String> {
    let config = parse_args(args)?;
    validate_output_root(&config.output_root)?;
    let source_identity = source_identity(&config.commit)?;
    let hardware_identity = hardware_identity()?;
    let hardware_fingerprint_sha256 = sha256_json(&hardware_identity)?;
    fs::create_dir_all(&config.output_root)
        .map_err(|error| format!("creating output root: {error}"))?;

    let fixtures = match config.profile {
        Profile::Smoke => vec![Fixture {
            name: "small",
            cell_m: [10e-9, 10e-9, 6e-9],
            steps: 6,
        }],
        Profile::Full => vec![
            Fixture {
                name: "small",
                cell_m: [10e-9, 10e-9, 6e-9],
                steps: 30,
            },
            Fixture {
                name: "medium",
                cell_m: [5e-9, 5e-9, 3e-9],
                steps: 30,
            },
            Fixture {
                name: "large",
                cell_m: [2e-9, 2e-9, 2e-9],
                steps: 30,
            },
        ],
    };

    let mut results = Vec::new();
    for fixture in fixtures {
        let mut fixture_results = Vec::new();
        for mode in [RunMode::Control, RunMode::Requested, RunMode::Full] {
            fixture_results.push(run_fixture(&config.output_root, fixture, mode)?);
        }
        validate_fixture_parity(&fixture_results)?;
        results.extend(fixture_results);
    }

    let time_to_accuracy = run_time_to_accuracy(&config.output_root)?;
    let mut qualification_blockers = vec!["external_hardware_baseline_gate_pending"];
    if config.profile == Profile::Smoke {
        qualification_blockers.push("full_fixture_profile_not_run");
    }
    let suite = ProductionQualificationSuite {
        schema_version: SCHEMA_VERSION,
        commit: config.commit,
        build_identity: config.build_identity,
        source_identity,
        hardware_identity,
        hardware_fingerprint_sha256,
        profile: match config.profile {
            Profile::Smoke => "smoke".to_string(),
            Profile::Full => "full".to_string(),
        },
        qualification_status: "evidence_only",
        qualification_blockers,
        process_peak_resident_bytes: process_peak_resident_bytes()?,
        time_to_accuracy,
        results,
    };
    let encoded =
        serde_json::to_vec_pretty(&suite).map_err(|error| format!("serializing suite: {error}"))?;
    fs::write(
        config.output_root.join("qualification-summary.json"),
        &encoded,
    )
    .map_err(|error| format!("writing qualification summary: {error}"))?;
    println!(
        "{}",
        String::from_utf8(encoded).expect("JSON serialization emits UTF-8")
    );
    Ok(())
}

fn parse_args(args: &[String]) -> Result<Config, String> {
    let mut output_root = None;
    let mut profile = Profile::Smoke;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--output-root" => {
                index += 1;
                output_root = args.get(index).map(PathBuf::from);
            }
            "--profile" => {
                index += 1;
                profile = match args.get(index).map(String::as_str) {
                    Some("smoke") => Profile::Smoke,
                    Some("full") => Profile::Full,
                    Some(value) => return Err(format!("unknown profile '{value}'")),
                    None => return Err("--profile requires smoke or full".to_string()),
                };
            }
            argument => return Err(format!("unknown argument '{argument}'")),
        }
        index += 1;
    }
    let output_root = output_root.ok_or_else(|| "--output-root is required".to_string())?;
    let commit = required_environment("FULLMAG_BENCH_COMMIT")?;
    let build_identity = required_environment("FULLMAG_BENCH_BUILD_ID")?;
    Ok(Config {
        output_root,
        profile,
        commit,
        build_identity,
    })
}

fn required_environment(name: &str) -> Result<String, String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} must be set to a non-empty value"))
}

fn source_identity(expected_commit: &str) -> Result<SourceIdentityEvidence, String> {
    if !is_lower_hex(expected_commit, 40) {
        return Err("FULLMAG_BENCH_COMMIT must be exactly 40 lowercase hex digits".to_string());
    }
    let identity = fullmag_build_info::identity();
    if identity.git_commit != expected_commit {
        return Err(format!(
            "embedded build commit {} does not match requested benchmark commit {expected_commit}",
            identity.git_commit
        ));
    }
    if !matches!(identity.worktree_state, "clean" | "dirty") {
        return Err(format!(
            "embedded worktree state must be clean or dirty, got {}",
            identity.worktree_state
        ));
    }
    if !is_lower_hex(identity.source_snapshot_sha256, 64) {
        return Err("embedded source snapshot must be exactly 64 lowercase hex digits".to_string());
    }
    Ok(SourceIdentityEvidence {
        built_at_utc: identity.built_at_utc,
        git_commit: identity.git_commit,
        worktree_state: identity.worktree_state,
        source_snapshot_sha256: identity.source_snapshot_sha256,
        rustc_version: env!("FULLMAG_BENCH_RUSTC_VERSION"),
        target_triple: env!("FULLMAG_BENCH_TARGET"),
    })
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hardware_identity() -> Result<HardwareIdentity, String> {
    let (cpu_vendor, cpu_brand) = x86_cpu_identity()?;
    let available_logical_cpu_count = std::thread::available_parallelism()
        .map_err(|error| format!("resolving available logical CPU count: {error}"))?
        .get();
    let rayon_thread_count = rayon::current_num_threads();
    if rayon_thread_count == 0 || rayon_thread_count > available_logical_cpu_count {
        return Err(format!(
            "Rayon thread count {rayon_thread_count} is outside available CPU count {available_logical_cpu_count}"
        ));
    }
    Ok(HardwareIdentity {
        operating_system: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        cpu_vendor,
        cpu_brand,
        detected_cpu_features: detected_x86_cpu_features(),
        available_logical_cpu_count,
        rayon_thread_count,
        rayon_num_threads_environment: std::env::var("RAYON_NUM_THREADS").ok(),
        thread_policy: "rayon_global_pool",
        precision_policy: "cpu_reference_double",
        accelerator_driver: "not_applicable_cpu_reference",
        accelerator_toolkit: "not_applicable_cpu_reference",
    })
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
fn x86_cpu_identity() -> Result<(String, String), String> {
    #[cfg(target_arch = "x86")]
    use std::arch::x86::__cpuid;
    #[cfg(target_arch = "x86_64")]
    use std::arch::x86_64::__cpuid;

    let leaf_zero = __cpuid(0);
    let mut vendor_bytes = Vec::with_capacity(12);
    vendor_bytes.extend_from_slice(&leaf_zero.ebx.to_le_bytes());
    vendor_bytes.extend_from_slice(&leaf_zero.edx.to_le_bytes());
    vendor_bytes.extend_from_slice(&leaf_zero.ecx.to_le_bytes());
    let vendor = String::from_utf8(vendor_bytes)
        .map_err(|error| format!("decoding CPUID vendor: {error}"))?;

    let maximum_extended_leaf = __cpuid(0x8000_0000).eax;
    if maximum_extended_leaf < 0x8000_0004 {
        return Err("CPUID processor brand leaves are unavailable".to_string());
    }
    let mut brand_bytes = Vec::with_capacity(48);
    for leaf in 0x8000_0002..=0x8000_0004 {
        let values = __cpuid(leaf);
        brand_bytes.extend_from_slice(&values.eax.to_le_bytes());
        brand_bytes.extend_from_slice(&values.ebx.to_le_bytes());
        brand_bytes.extend_from_slice(&values.ecx.to_le_bytes());
        brand_bytes.extend_from_slice(&values.edx.to_le_bytes());
    }
    let brand = String::from_utf8(brand_bytes)
        .map_err(|error| format!("decoding CPUID processor brand: {error}"))?
        .trim_matches(char::from(0))
        .trim()
        .to_string();
    if vendor.is_empty() || brand.is_empty() {
        return Err("CPUID returned an empty CPU vendor or brand".to_string());
    }
    Ok((vendor, brand))
}

#[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
fn x86_cpu_identity() -> Result<(String, String), String> {
    Err(format!(
        "hardware qualification identity is not implemented for architecture {}",
        std::env::consts::ARCH
    ))
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
fn detected_x86_cpu_features() -> Vec<&'static str> {
    let mut features = Vec::new();
    if std::arch::is_x86_feature_detected!("sse2") {
        features.push("sse2");
    }
    if std::arch::is_x86_feature_detected!("avx") {
        features.push("avx");
    }
    if std::arch::is_x86_feature_detected!("avx2") {
        features.push("avx2");
    }
    if std::arch::is_x86_feature_detected!("fma") {
        features.push("fma");
    }
    if std::arch::is_x86_feature_detected!("avx512f") {
        features.push("avx512f");
    }
    features
}

#[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
fn detected_x86_cpu_features() -> Vec<&'static str> {
    Vec::new()
}

fn validate_output_root(output_root: &Path) -> Result<(), String> {
    if !output_root.is_absolute() {
        return Err("--output-root must be absolute".to_string());
    }
    let repository = std::env::current_dir()
        .map_err(|error| format!("resolving repository directory: {error}"))?;
    if output_root.starts_with(&repository) {
        return Err(format!(
            "--output-root must be outside the repository ({})",
            repository.display()
        ));
    }
    if output_root.exists() {
        let mut entries =
            fs::read_dir(output_root).map_err(|error| format!("reading output root: {error}"))?;
        if entries.next().is_some() {
            return Err("--output-root must be empty to prevent stale evidence".to_string());
        }
    }
    Ok(())
}

fn run_fixture(
    output_root: &Path,
    fixture: Fixture,
    mode: RunMode,
) -> Result<ProductionRunEvidence, String> {
    let problem = qualification_problem(fixture, mode);
    let planner_started = Instant::now();
    let plan = fullmag_plan::plan(&problem)
        .map_err(|error| format!("planning {} {}: {error}", fixture.name, mode.as_str()))?;
    let planner_wall_time_ns = elapsed_ns(planner_started);
    let BackendPlanIR::Fdm(fdm_plan) = &plan.backend_plan else {
        return Err(format!(
            "{} {} resolved to a non-FDM backend",
            fixture.name,
            mode.as_str()
        ));
    };
    let backend_plan_sha256 = sha256_json(&plan.backend_plan)?;
    let run_dir = output_root.join(format!("{}-{}", fixture.name, mode.as_str()));

    alloc_counter::reset();
    let run_started = Instant::now();
    let result =
        fullmag_runner::run_planned_problem(&problem, &plan, fixture.steps as f64 * DT_S, &run_dir)
            .map_err(|error| format!("running {} {}: {error}", fixture.name, mode.as_str()))?;
    let end_to_end_wall_time_ns = elapsed_ns(run_started);
    let (allocation_count, allocation_bytes) = alloc_counter::snapshot();
    let peak_live_heap_growth_bytes = alloc_counter::peak_live_growth_bytes();
    if peak_live_heap_growth_bytes == 0 {
        return Err(format!(
            "{} {} did not report peak live heap growth",
            fixture.name,
            mode.as_str()
        ));
    }
    let metadata = read_json(&run_dir.join("metadata.json"))?;
    validate_execution(&metadata, fixture, mode)?;

    Ok(ProductionRunEvidence {
        fixture: fixture.name.to_string(),
        mode,
        grid: fdm_plan.grid.cells,
        cell_count: fdm_plan
            .grid
            .cells
            .iter()
            .map(|value| u64::from(*value))
            .product(),
        simulated_time_s: fixture.steps as f64 * DT_S,
        planner_wall_time_ns,
        end_to_end_wall_time_ns,
        allocation_count,
        allocation_bytes,
        peak_live_heap_growth_bytes,
        backend_plan_sha256,
        final_magnetization_sha256: magnetization_sha256(&result.final_magnetization),
        requested_execution: metadata["requested_execution"].clone(),
        execution_provenance: metadata["execution_provenance"].clone(),
        artifact_pipeline: metadata["artifact_pipeline"].clone(),
    })
}

fn qualification_problem(fixture: Fixture, mode: RunMode) -> ProblemIR {
    let mut problem = ProblemIR::bootstrap_example();
    problem.problem_meta.name = format!("fdm_cpu_qualification_{}_{}", fixture.name, mode.as_str());
    problem.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cpu", "source": "fdm_cpu_qualification_fixture"}),
    );
    problem.energy_terms = vec![
        EnergyTermIR::Exchange,
        EnergyTermIR::Demag {
            realization: RequestedFemDemagIR::default(),
        },
        EnergyTermIR::InterfacialDmi {
            d: 3e-3,
            interface_normal: Some([0.0, 0.0, 1.0]),
        },
    ];
    problem.field_drives = vec![RegionalFieldDriveIR {
        id: "qualification_dynamic_field".to_string(),
        name: "qualification_dynamic_field".to_string(),
        kind: FieldDriveKindIR::Regional,
        enabled: true,
        target: FieldTargetIR::Global {},
        amplitude_b_t: 1e-3,
        direction: [0.0, 1.0, 0.0],
        spatial_profile: FieldSpatialProfileIR::Uniform {},
        waveform: TimeDependenceIR::Sinusoidal {
            frequency_hz: 5e9,
            phase_rad: 0.0,
            offset: 0.0,
        },
        time_origin: FieldTimeOriginIR::Absolute,
        activation: DriveActivationIR::AllTimeEvolution {},
        migration: None,
    }];
    let hints = problem
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("bootstrap FDM hints");
    hints.cell = fixture.cell_m;
    hints.demag = Some(FdmDemagHintsIR {
        strategy: "single_grid".to_string(),
        mode: "three_d".to_string(),
        fft_backend: "rustfft".to_string(),
        common_cells: None,
        common_cells_xy: None,
        common_cell_size: None,
    });
    let StudyIR::TimeEvolution { sampling, .. } = &mut problem.study else {
        unreachable!("bootstrap fixture is time evolution");
    };
    let every_seconds = match mode {
        RunMode::Control => None,
        RunMode::Requested => Some(3.0 * DT_S),
        RunMode::Full => Some(DT_S),
    };
    sampling.outputs = every_seconds.map_or_else(Vec::new, |every_seconds| {
        vec![
            OutputIR::Field {
                name: "m".to_string(),
                every_seconds,
            },
            OutputIR::Field {
                name: "H_eff".to_string(),
                every_seconds,
            },
            OutputIR::Scalar {
                name: "E_total".to_string(),
                every_seconds,
            },
        ]
    });
    problem
}

fn run_time_to_accuracy(output_root: &Path) -> Result<TimeToAccuracyEvidence, String> {
    let field_h_apm = ACCURACY_FIELD_B_T / fullmag_engine::MU0;
    let exact_magnetization = fullmag_engine::constant_z_field_llg_from_positive_x(
        2.211e5,
        0.02,
        field_h_apm,
        ACCURACY_FINAL_TIME_S,
    );
    let mut runs = Vec::new();
    for (index, timestep_s) in ACCURACY_TIMESTEPS_S.into_iter().enumerate() {
        let expected_steps_f64 = ACCURACY_FINAL_TIME_S / timestep_s;
        let expected_steps = expected_steps_f64.round() as u64;
        if (expected_steps_f64 - expected_steps as f64).abs() > 32.0 * f64::EPSILON {
            return Err(format!(
                "accuracy timestep {timestep_s:.6e} does not divide final time exactly"
            ));
        }
        let problem = accuracy_problem(timestep_s);
        let planner_started = Instant::now();
        let plan = fullmag_plan::plan(&problem)
            .map_err(|error| format!("planning accuracy timestep {timestep_s:.6e}: {error}"))?;
        let planner_wall_time_ns = elapsed_ns(planner_started);
        let BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
            return Err("accuracy oracle resolved to a non-FDM backend".to_string());
        };
        if fdm.grid.cells != [1, 1, 1] {
            return Err(format!(
                "accuracy oracle must resolve one macrospin cell, got {:?}",
                fdm.grid.cells
            ));
        }
        let run_dir = output_root.join(format!("accuracy-{index}"));
        let run_started = Instant::now();
        let result =
            fullmag_runner::run_planned_problem(&problem, &plan, ACCURACY_FINAL_TIME_S, &run_dir)
                .map_err(|error| format!("running accuracy timestep {timestep_s:.6e}: {error}"))?;
        let end_to_end_wall_time_ns = elapsed_ns(run_started);
        let actual = result
            .final_magnetization
            .first()
            .copied()
            .ok_or_else(|| "accuracy oracle produced no final magnetization".to_string())?;
        if result.final_magnetization.len() != 1 {
            return Err("accuracy oracle produced more than one macrospin cell".to_string());
        }
        let max_abs_error = actual
            .iter()
            .zip(exact_magnetization)
            .map(|(actual, exact)| (actual - exact).abs())
            .fold(0.0_f64, f64::max);
        let metadata = read_json(&run_dir.join("metadata.json"))?;
        validate_exact_cpu_execution(
            &metadata["execution_provenance"],
            &format!("accuracy timestep {timestep_s:.6e}"),
        )?;
        let evaluation = &metadata["execution_provenance"]["fdm_cpu_evaluation_telemetry"];
        let minimal = required_u64(evaluation, "minimal_step_count")?;
        let full = required_u64(evaluation, "full_step_count")?;
        if minimal.saturating_add(full) != expected_steps {
            return Err(format!(
                "accuracy timestep {timestep_s:.6e} executed {} steps instead of {expected_steps}",
                minimal.saturating_add(full)
            ));
        }
        let transaction = &metadata["execution_provenance"]["fdm_cpu_step_transaction_telemetry"];
        if required_u64(transaction, "accepted_step_count")? != expected_steps
            || required_u64(transaction, "rejected_attempt_count")? != 0
        {
            return Err(format!(
                "accuracy timestep {timestep_s:.6e} did not execute {expected_steps} accepted steps without rejection"
            ));
        }
        runs.push(TimeToAccuracyRunEvidence {
            timestep_s,
            expected_steps,
            planner_wall_time_ns,
            end_to_end_wall_time_ns,
            max_abs_error,
            passes: max_abs_error <= ACCURACY_TOLERANCE,
            final_magnetization: actual,
            requested_execution: metadata["requested_execution"].clone(),
            execution_provenance: metadata["execution_provenance"].clone(),
        });
    }
    if !runs
        .windows(2)
        .all(|pair| pair[1].max_abs_error < pair[0].max_abs_error)
    {
        return Err("accuracy error did not decrease under timestep refinement".to_string());
    }
    let observed_order_coarse_to_fine = (runs[0].max_abs_error / runs[2].max_abs_error).ln()
        / (runs[0].timestep_s / runs[2].timestep_s).ln();
    if !observed_order_coarse_to_fine.is_finite() || observed_order_coarse_to_fine < 1.5 {
        return Err(format!(
            "Heun accuracy order {observed_order_coarse_to_fine:.6} is below 1.5"
        ));
    }
    let first_passing = runs
        .iter()
        .find(|run| run.passes)
        .ok_or_else(|| format!("no timestep met max-abs tolerance {ACCURACY_TOLERANCE:.6e}"))?;
    let first_passing_timestep_s = first_passing.timestep_s;
    let first_passing_wall_time_ns = first_passing.end_to_end_wall_time_ns;

    Ok(TimeToAccuracyEvidence {
        oracle_id: "constant_z_field_llg_from_positive_x.v1",
        tolerance_max_abs: ACCURACY_TOLERANCE,
        field_b_t: ACCURACY_FIELD_B_T,
        final_time_s: ACCURACY_FINAL_TIME_S,
        exact_magnetization,
        first_passing_timestep_s,
        first_passing_wall_time_ns,
        observed_order_coarse_to_fine,
        runs,
    })
}

fn accuracy_problem(timestep_s: f64) -> ProblemIR {
    let mut problem = ProblemIR::bootstrap_example();
    problem.problem_meta.name = format!("fdm_cpu_time_to_accuracy_{timestep_s:.6e}");
    problem.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cpu", "source": "fdm_cpu_accuracy_oracle"}),
    );
    problem.energy_terms = vec![EnergyTermIR::Exchange];
    problem.magnets[0].initial_magnetization = Some(InitialMagnetizationIR::Uniform {
        value: [1.0, 0.0, 0.0],
    });
    problem.field_drives = vec![RegionalFieldDriveIR {
        id: "accuracy_constant_field".to_string(),
        name: "accuracy_constant_field".to_string(),
        kind: FieldDriveKindIR::Regional,
        enabled: true,
        target: FieldTargetIR::Global {},
        amplitude_b_t: ACCURACY_FIELD_B_T,
        direction: [0.0, 0.0, 1.0],
        spatial_profile: FieldSpatialProfileIR::Uniform {},
        waveform: TimeDependenceIR::Constant,
        time_origin: FieldTimeOriginIR::Absolute,
        activation: DriveActivationIR::AllTimeEvolution {},
        migration: None,
    }];
    let hints = problem
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("bootstrap FDM hints");
    hints.cell = [200e-9, 20e-9, 6e-9];
    hints.demag = None;
    let StudyIR::TimeEvolution { dynamics, sampling } = &mut problem.study else {
        unreachable!("bootstrap fixture is time evolution");
    };
    let DynamicsIR::Llg {
        integrator,
        fixed_timestep,
        adaptive_timestep,
        ..
    } = dynamics;
    *integrator = "heun".to_string();
    *fixed_timestep = Some(timestep_s);
    *adaptive_timestep = None;
    sampling.outputs = vec![OutputIR::Field {
        name: "m".to_string(),
        every_seconds: ACCURACY_FINAL_TIME_S,
    }];
    problem
}

fn validate_execution(metadata: &Value, fixture: Fixture, mode: RunMode) -> Result<(), String> {
    let provenance = &metadata["execution_provenance"];
    validate_exact_cpu_execution(provenance, &format!("{} {}", fixture.name, mode.as_str()))?;
    let fft = &provenance["fdm_fft_execution"];
    if fft["requested_backend"] != "rustfft"
        || fft["resolved_backend"] != "rustfft"
        || fft["executed_backend"] != "rustfft"
        || fft["workspace_layout"] != "half_spectrum_r2c"
    {
        return Err(format!(
            "{} {} did not execute the requested R2C RustFFT backend",
            fixture.name,
            mode.as_str()
        ));
    }
    let evaluation = &provenance["fdm_cpu_evaluation_telemetry"];
    let minimal = required_u64(evaluation, "minimal_step_count")?;
    let full = required_u64(evaluation, "full_step_count")?;
    if minimal.saturating_add(full) != fixture.steps {
        return Err(format!(
            "{} {} evaluation count mismatch: minimal={minimal} full={full} expected={}",
            fixture.name,
            mode.as_str(),
            fixture.steps
        ));
    }
    match mode {
        RunMode::Control if minimal != fixture.steps || full != 0 => {
            return Err("control fixture must execute only Minimal steps".to_string());
        }
        RunMode::Requested if minimal == 0 || full == 0 => {
            return Err("requested fixture must exercise both Minimal and Full steps".to_string());
        }
        RunMode::Full if minimal != 0 || full != fixture.steps => {
            return Err("full fixture must execute only Full steps".to_string());
        }
        _ => {}
    }
    Ok(())
}

fn validate_exact_cpu_execution(provenance: &Value, label: &str) -> Result<(), String> {
    if provenance["execution_engine"] != "cpu_reference"
        || provenance["precision"] != "double"
        || !provenance["resolved_fallback"].is_null()
        || provenance["execution_resolution"]["resolution_mode"] != "exact"
        || provenance["execution_resolution"]["fallback_occurred"] != false
    {
        return Err(format!(
            "{label} did not execute exact CPU-double intent without fallback"
        ));
    }
    Ok(())
}

fn validate_fixture_parity(results: &[ProductionRunEvidence]) -> Result<(), String> {
    let first = results
        .first()
        .ok_or_else(|| "fixture produced no results".to_string())?;
    for result in &results[1..] {
        if result.backend_plan_sha256 != first.backend_plan_sha256 {
            return Err(format!(
                "{} backend plan changed between output modes",
                first.fixture
            ));
        }
        if result.final_magnetization_sha256 != first.final_magnetization_sha256 {
            return Err(format!(
                "{} final state changed between output modes",
                first.fixture
            ));
        }
    }
    Ok(())
}

fn required_u64(value: &Value, key: &str) -> Result<u64, String> {
    value[key]
        .as_u64()
        .ok_or_else(|| format!("missing unsigned telemetry field '{key}'"))
}

fn read_json(path: &Path) -> Result<Value, String> {
    let encoded = fs::read(path).map_err(|error| format!("reading {}: {error}", path.display()))?;
    serde_json::from_slice(&encoded).map_err(|error| format!("parsing {}: {error}", path.display()))
}

fn sha256_json(value: &impl Serialize) -> Result<String, String> {
    let encoded =
        serde_json::to_vec(value).map_err(|error| format!("serializing hash input: {error}"))?;
    Ok(format!("sha256:{:x}", Sha256::digest(encoded)))
}

fn magnetization_sha256(values: &[[f64; 3]]) -> String {
    let mut hasher = Sha256::new();
    for vector in values {
        for component in vector {
            hasher.update(component.to_bits().to_le_bytes());
        }
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn elapsed_ns(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX)
}

#[cfg(windows)]
fn process_peak_resident_bytes() -> Result<u64, String> {
    use std::{ffi::c_void, mem::size_of};

    #[repr(C)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
    }
    #[link(name = "psapi")]
    unsafe extern "system" {
        fn GetProcessMemoryInfo(
            process: *mut c_void,
            counters: *mut ProcessMemoryCounters,
            size: u32,
        ) -> i32;
    }

    let mut counters = ProcessMemoryCounters {
        cb: u32::try_from(size_of::<ProcessMemoryCounters>())
            .map_err(|_| "process memory counter layout exceeds u32".to_string())?,
        page_fault_count: 0,
        peak_working_set_size: 0,
        working_set_size: 0,
        quota_peak_paged_pool_usage: 0,
        quota_paged_pool_usage: 0,
        quota_peak_non_paged_pool_usage: 0,
        quota_non_paged_pool_usage: 0,
        pagefile_usage: 0,
        peak_pagefile_usage: 0,
    };
    let succeeded =
        unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) };
    if succeeded == 0 {
        return Err(format!(
            "GetProcessMemoryInfo failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    u64::try_from(counters.peak_working_set_size)
        .map_err(|_| "peak working set exceeds u64".to_string())
}

#[cfg(target_os = "linux")]
fn process_peak_resident_bytes() -> Result<u64, String> {
    let status = fs::read_to_string("/proc/self/status")
        .map_err(|error| format!("reading /proc/self/status: {error}"))?;
    let line = status
        .lines()
        .find(|line| line.starts_with("VmHWM:"))
        .ok_or_else(|| "VmHWM is missing from /proc/self/status".to_string())?;
    let kib = line
        .split_ascii_whitespace()
        .nth(1)
        .ok_or_else(|| "VmHWM has no numeric value".to_string())?
        .parse::<u64>()
        .map_err(|error| format!("parsing VmHWM: {error}"))?;
    kib.checked_mul(1024)
        .ok_or_else(|| "VmHWM byte conversion overflow".to_string())
}

#[cfg(not(any(windows, target_os = "linux")))]
fn process_peak_resident_bytes() -> Result<u64, String> {
    Err("peak resident memory is unsupported on this platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qualification_modes_preserve_the_same_backend_plan() {
        let fixture = Fixture {
            name: "test",
            cell_m: [10e-9, 10e-9, 6e-9],
            steps: 6,
        };
        let mut hashes = Vec::new();
        for mode in [RunMode::Control, RunMode::Requested, RunMode::Full] {
            let problem = qualification_problem(fixture, mode);
            let plan = fullmag_plan::plan(&problem).expect("qualification fixture should plan");
            let BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
                panic!("qualification fixture must plan FDM");
            };
            assert!(fdm.enable_demag);
            assert!(fdm.interfacial_dmi.is_some());
            assert_eq!(
                fdm.fft.as_ref().map(|fft| fft.requested_backend.as_str()),
                Some("rustfft")
            );
            hashes.push(sha256_json(&plan.backend_plan).expect("hash backend plan"));
        }
        assert!(hashes.windows(2).all(|pair| pair[0] == pair[1]));
    }

    #[test]
    fn output_root_must_be_absolute_and_outside_repository() {
        assert!(validate_output_root(Path::new("relative")).is_err());
        let repository = std::env::current_dir().expect("repository path");
        assert!(validate_output_root(&repository.join("benchmark-output")).is_err());
    }

    #[test]
    fn process_peak_resident_memory_is_reported() {
        assert!(process_peak_resident_bytes().expect("process peak RSS") > 0);
    }

    #[test]
    fn hardware_identity_is_complete_and_stably_hashable() {
        let identity = hardware_identity().expect("supported qualification hardware");
        assert!(!identity.cpu_vendor.is_empty());
        assert!(!identity.cpu_brand.is_empty());
        assert!(identity.available_logical_cpu_count > 0);
        assert!(identity.rayon_thread_count > 0);
        let first = sha256_json(&identity).expect("hash hardware identity");
        let second = sha256_json(&identity).expect("hash hardware identity again");
        assert_eq!(first, second);
        assert!(first.starts_with("sha256:"));
        assert_eq!(first.len(), 71);
    }

    #[test]
    fn source_identity_rejects_noncanonical_commit_before_execution() {
        let error = source_identity("b01851826").expect_err("abbreviated commit must fail");
        assert!(error.contains("exactly 40 lowercase hex digits"));
    }

    #[test]
    fn time_to_accuracy_fixtures_plan_one_exact_cpu_macrospin() {
        for timestep_s in ACCURACY_TIMESTEPS_S {
            let problem = accuracy_problem(timestep_s);
            let plan = fullmag_plan::plan(&problem).expect("accuracy fixture should plan");
            let BackendPlanIR::Fdm(fdm) = plan.backend_plan else {
                panic!("accuracy fixture must plan FDM");
            };
            assert_eq!(fdm.grid.cells, [1, 1, 1]);
            assert!(!fdm.enable_demag);
            assert_eq!(fdm.regional_field_drive_bases.len(), 1);
            assert_eq!(fdm.fixed_timestep, Some(timestep_s));
        }
    }
}
