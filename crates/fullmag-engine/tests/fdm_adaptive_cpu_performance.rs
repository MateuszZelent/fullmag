use std::{
    alloc::{GlobalAlloc, Layout, System},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

use fullmag_engine::{
    constant_z_field_llg_from_positive_x, AdaptiveStepConfig, CellSize, EffectiveFieldTerms,
    EvaluationRequest, ExchangeLlgProblem, GridShape, LlgConfig, MaterialParameters,
    TimeIntegrator, FDM_CPU_ADAPTIVE_RK23_MAX_RHS_EVALS_TO_ORACLE,
    FDM_CPU_ADAPTIVE_RK45_MAX_RHS_EVALS_TO_ORACLE,
};

const GAMMA: f64 = 2.211e5;
const ALPHA: f64 = 0.1;
const FIELD_Z_APM: f64 = 1.0e4;
const FINAL_TIME: f64 = 1.0e-9;
const INITIAL_DT: f64 = 2.0e-10;
const MAX_ORACLE_ERROR: f64 = 2.0e-7;

struct ProcessAllocationCounter;

static COUNT_ALLOCATIONS: AtomicBool = AtomicBool::new(false);
static ALLOCATION_COUNT: AtomicUsize = AtomicUsize::new(0);

#[global_allocator]
static ALLOCATOR: ProcessAllocationCounter = ProcessAllocationCounter;

fn record_allocation() {
    if COUNT_ALLOCATIONS.load(Ordering::SeqCst) {
        ALLOCATION_COUNT.fetch_add(1, Ordering::SeqCst);
    }
}

unsafe impl GlobalAlloc for ProcessAllocationCounter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_allocation();
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_allocation();
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record_allocation();
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

fn measured_allocations<T>(operation: impl FnOnce() -> T) -> (T, usize) {
    ALLOCATION_COUNT.store(0, Ordering::SeqCst);
    COUNT_ALLOCATIONS.store(true, Ordering::SeqCst);
    let result = operation();
    COUNT_ALLOCATIONS.store(false, Ordering::SeqCst);
    (result, ALLOCATION_COUNT.load(Ordering::SeqCst))
}

#[derive(Clone, Copy, Debug)]
enum Representation {
    Aos,
    BufferSoa,
    PersistentSoa,
}

struct QualificationOutcome {
    actual: [f64; 3],
    allocations: usize,
    measured_accepted_steps: usize,
    total_rhs_evals: u32,
}

fn adaptive_problem(integrator: TimeIntegrator, cell_count: usize) -> ExchangeLlgProblem {
    ExchangeLlgProblem::with_terms(
        GridShape::new(cell_count, 1, 1).expect("grid"),
        CellSize::new(1.0, 1.0, 1.0).expect("cell"),
        MaterialParameters::new(1.0, 1.0e-30, ALPHA).expect("material"),
        LlgConfig::new(GAMMA, integrator)
            .expect("LLG")
            .with_adaptive(AdaptiveStepConfig {
                max_error: 1.0e-10,
                dt_min: 1.0e-15,
                dt_max: INITIAL_DT,
                headroom: 0.8,
                rtol: 1.0e-8,
                growth_limit: 2.0,
                shrink_limit: 0.2,
            }),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            external_field: Some([0.0, 0.0, FIELD_Z_APM]),
            ..Default::default()
        },
    )
}

fn resolved_frozen_spins(mask: Vec<bool>) -> fullmag_ir::ResolvedFrozenSpinsPlanIR {
    let active_dof_count = mask.len() as u64;
    let frozen_dof_count = mask.iter().filter(|frozen| **frozen).count() as u64;
    let free_dof_count = active_dof_count - frozen_dof_count;
    fullmag_ir::ResolvedFrozenSpinsPlanIR {
        schema_version: fullmag_ir::RESOLVED_FROZEN_SPINS_PLAN_SCHEMA_VERSION.to_string(),
        constraint_ids: vec!["performance-gate".to_string()],
        frozen_mask: mask,
        active_dof_count,
        frozen_dof_count,
        free_dof_count,
        mask_sha256: "performance-gate-mask".to_string(),
        grid_or_mesh_fingerprint: "performance-gate-grid".to_string(),
        source_state_revision: Some(1),
        all_active_dofs_frozen: free_dof_count == 0,
        certificate: fullmag_ir::SelectionCertificateIR {
            schema_version: fullmag_ir::SELECTION_CERTIFICATE_SCHEMA_VERSION.to_string(),
            evaluator_id: "selection.fdm_cell_center.v1".to_string(),
            constraint_ids: vec!["performance-gate".to_string()],
            authored_fingerprints: vec![fullmag_ir::SelectionAuthoredFingerprintIR {
                constraint_id: "performance-gate".to_string(),
                selector_sha256: "a".repeat(64),
            }],
            raw_candidate_dof_count: frozen_dof_count,
            inactive_candidate_dof_count: 0,
            active_dof_count,
            frozen_dof_count,
            free_dof_count,
            bounds_m: None,
            grid_or_mesh_fingerprint: "performance-gate-grid".to_string(),
            source_state_revision: Some(1),
            mask_sha256: "performance-gate-mask".to_string(),
            resolved_reference_sha256: "b".repeat(64),
            warnings: Vec::new(),
        },
    }
}

fn attempt_rhs_evals(buffers: &fullmag_engine::IntegratorBuffers) -> u32 {
    buffers
        .adaptive_attempts()
        .iter()
        .map(|attempt| attempt.rhs_evals)
        .sum()
}

fn run_aos_compatible(
    integrator: TimeIntegrator,
    representation: Representation,
) -> QualificationOutcome {
    let force_aos = matches!(representation, Representation::Aos);
    let mut problem = adaptive_problem(integrator, if force_aos { 2 } else { 1 });
    let mut state = problem
        .uniform_state([1.0, 0.0, 0.0])
        .expect("qualification state");
    let observed_cell = usize::from(force_aos);
    if force_aos {
        problem
            .capture_frozen_spins_at_activation(
                &resolved_frozen_spins(vec![true, false]),
                &mut state,
            )
            .expect("frozen-spin activation must force the public AoS branch");
        assert!(!problem.soa_fast_path_supported());
    } else {
        assert!(problem.soa_fast_path_supported());
    }

    let mut workspace = problem.create_workspace();
    let mut buffers = problem.create_integrator_buffers();
    let first_report = problem
        .step_with_buffers_evaluation(
            &mut state,
            INITIAL_DT,
            &mut workspace,
            &mut buffers,
            EvaluationRequest::Minimal,
        )
        .expect("adaptive qualification warmup step");
    let mut total_rhs_evals = attempt_rhs_evals(&buffers);
    let mut measured_accepted_steps = 0_usize;
    let mut dt = first_report
        .suggested_next_dt
        .unwrap_or(first_report.dt_used);

    let ((), allocations) = measured_allocations(|| {
        while state.time_seconds < FINAL_TIME {
            let remaining = FINAL_TIME - state.time_seconds;
            let report = problem
                .step_with_buffers_evaluation(
                    &mut state,
                    dt.min(remaining),
                    &mut workspace,
                    &mut buffers,
                    EvaluationRequest::Minimal,
                )
                .expect("adaptive qualification step");
            total_rhs_evals += attempt_rhs_evals(&buffers);
            measured_accepted_steps += 1;
            dt = report.suggested_next_dt.unwrap_or(report.dt_used);
        }
    });

    QualificationOutcome {
        actual: state.magnetization()[observed_cell],
        allocations,
        measured_accepted_steps,
        total_rhs_evals,
    }
}

fn run_persistent_soa(integrator: TimeIntegrator) -> QualificationOutcome {
    let problem = adaptive_problem(integrator, 1);
    let mut state = problem
        .uniform_state([1.0, 0.0, 0.0])
        .expect("qualification state")
        .to_soa();
    let mut workspace = problem.create_workspace();
    let mut buffers = problem.create_integrator_buffers();
    let first_report = problem
        .step_soa_with_buffers_evaluation(
            &mut state,
            INITIAL_DT,
            &mut workspace,
            &mut buffers,
            EvaluationRequest::Minimal,
        )
        .expect("persistent-SoA qualification warmup step");
    let mut total_rhs_evals = attempt_rhs_evals(&buffers);
    let mut measured_accepted_steps = 0_usize;
    let mut dt = first_report
        .suggested_next_dt
        .unwrap_or(first_report.dt_used);

    let ((), allocations) = measured_allocations(|| {
        while state.time_seconds < FINAL_TIME {
            let remaining = FINAL_TIME - state.time_seconds;
            let report = problem
                .step_soa_with_buffers_evaluation(
                    &mut state,
                    dt.min(remaining),
                    &mut workspace,
                    &mut buffers,
                    EvaluationRequest::Minimal,
                )
                .expect("persistent-SoA qualification step");
            total_rhs_evals += attempt_rhs_evals(&buffers);
            measured_accepted_steps += 1;
            dt = report.suggested_next_dt.unwrap_or(report.dt_used);
        }
    });

    QualificationOutcome {
        actual: [
            state.magnetization().x[0],
            state.magnetization().y[0],
            state.magnetization().z[0],
        ],
        allocations,
        measured_accepted_steps,
        total_rhs_evals,
    }
}

fn oracle_error(actual: [f64; 3]) -> f64 {
    let expected = constant_z_field_llg_from_positive_x(GAMMA, ALPHA, FIELD_Z_APM, FINAL_TIME);
    actual
        .iter()
        .zip(expected)
        .map(|(actual, expected)| (actual - expected).abs())
        .fold(0.0_f64, f64::max)
}

#[test]
fn adaptive_cpu_meets_steady_state_allocation_and_rhs_to_accuracy_budgets() {
    // Rayon grows worker-local scheduler storage lazily. Prime every exact
    // workload before measuring the steady-state reuse interval.
    for integrator in [TimeIntegrator::RK23, TimeIntegrator::RK45] {
        let _ = run_aos_compatible(integrator, Representation::Aos);
        let _ = run_aos_compatible(integrator, Representation::BufferSoa);
        let _ = run_persistent_soa(integrator);
    }

    for (integrator, rhs_budget) in [
        (
            TimeIntegrator::RK23,
            FDM_CPU_ADAPTIVE_RK23_MAX_RHS_EVALS_TO_ORACLE,
        ),
        (
            TimeIntegrator::RK45,
            FDM_CPU_ADAPTIVE_RK45_MAX_RHS_EVALS_TO_ORACLE,
        ),
    ] {
        for representation in [
            Representation::Aos,
            Representation::BufferSoa,
            Representation::PersistentSoa,
        ] {
            let outcome = match representation {
                Representation::Aos | Representation::BufferSoa => {
                    run_aos_compatible(integrator, representation)
                }
                Representation::PersistentSoa => run_persistent_soa(integrator),
            };
            let error = oracle_error(outcome.actual);
            let allocation_budget =
                if cfg!(feature = "parallel") && matches!(representation, Representation::Aos) {
                    outcome.measured_accepted_steps
                } else {
                    0
                };

            assert!(
                outcome.allocations <= allocation_budget,
                "{integrator:?} {representation:?} used {} steady-state allocations; budget is {allocation_budget} for {} accepted steps",
                outcome.allocations,
                outcome.measured_accepted_steps,
            );
            assert!(
                error < MAX_ORACLE_ERROR,
                "{integrator:?} {representation:?} oracle error {error:.6e} exceeds {MAX_ORACLE_ERROR:.6e}"
            );
            assert!(
                outcome.total_rhs_evals <= rhs_budget,
                "{integrator:?} {representation:?} used {} RHS evaluations; budget is {rhs_budget}",
                outcome.total_rhs_evals
            );
        }
    }
}
