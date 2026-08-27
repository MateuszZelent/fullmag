use std::{
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

use fullmag_ir::{
    BackendPlanIR, DriveActivationIR, EnergyTermIR, FdmDemagHintsIR, FieldDriveKindIR,
    FieldSpatialProfileIR, FieldTargetIR, FieldTimeOriginIR, OutputIR, ProblemIR,
    RegionalFieldDriveIR, RequestedFemDemagIR, StudyIR, TimeDependenceIR,
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::alloc_counter;

const SCHEMA_VERSION: &str = "fullmag.fdm.cpu.production_qualification.v1";
const DT_S: f64 = 1e-13;

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
    profile: String,
    qualification_status: &'static str,
    qualification_blockers: Vec<&'static str>,
    process_peak_resident_bytes: u64,
    results: Vec<ProductionRunEvidence>,
}

pub(super) fn run_from_args(args: &[String]) -> Result<(), String> {
    let config = parse_args(args)?;
    validate_output_root(&config.output_root)?;
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

    let suite = ProductionQualificationSuite {
        schema_version: SCHEMA_VERSION,
        commit: config.commit,
        build_identity: config.build_identity,
        profile: match config.profile {
            Profile::Smoke => "smoke".to_string(),
            Profile::Full => "full".to_string(),
        },
        qualification_status: "evidence_only",
        qualification_blockers: vec![
            "time_to_accuracy_oracle_missing",
            "hardware_baseline_threshold_not_approved",
        ],
        process_peak_resident_bytes: process_peak_resident_bytes()?,
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

fn validate_execution(metadata: &Value, fixture: Fixture, mode: RunMode) -> Result<(), String> {
    let provenance = &metadata["execution_provenance"];
    if provenance["execution_engine"] != "cpu_reference"
        || provenance["precision"] != "double"
        || !provenance["resolved_fallback"].is_null()
    {
        return Err(format!(
            "{} {} did not execute exact CPU-double intent without fallback",
            fixture.name,
            mode.as_str()
        ));
    }
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
}
