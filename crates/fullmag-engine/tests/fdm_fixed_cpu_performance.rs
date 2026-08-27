use std::{
    alloc::{GlobalAlloc, Layout, System},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

use fullmag_engine::{
    constant_z_field_llg_from_positive_x, CellSize, EffectiveFieldTerms, EvaluationRequest,
    ExchangeLlgProblem, GridShape, LlgConfig, MaterialParameters, TimeIntegrator,
};

const GAMMA: f64 = 2.211e5;
const ALPHA: f64 = 0.1;
const FIELD_Z_APM: f64 = 1.0e4;
const DT: f64 = 1.0e-13;
const WARMUP_STEPS: usize = 4;
const MEASURED_STEPS: usize = 100;
const MAX_ORACLE_ERROR: f64 = 2.0e-8;

struct ProcessAllocationCounter;

static COUNT_ALLOCATIONS: AtomicBool = AtomicBool::new(false);
static ALLOCATION_COUNT: AtomicUsize = AtomicUsize::new(0);
static ALLOCATION_BYTES: AtomicUsize = AtomicUsize::new(0);

#[global_allocator]
static ALLOCATOR: ProcessAllocationCounter = ProcessAllocationCounter;

fn record_allocation(bytes: usize) {
    if COUNT_ALLOCATIONS.load(Ordering::SeqCst) {
        ALLOCATION_COUNT.fetch_add(1, Ordering::SeqCst);
        ALLOCATION_BYTES.fetch_add(bytes, Ordering::SeqCst);
    }
}

unsafe impl GlobalAlloc for ProcessAllocationCounter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_allocation(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_allocation(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record_allocation(new_size);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

fn measured_allocations(operation: impl FnOnce()) -> (usize, usize) {
    ALLOCATION_COUNT.store(0, Ordering::SeqCst);
    ALLOCATION_BYTES.store(0, Ordering::SeqCst);
    COUNT_ALLOCATIONS.store(true, Ordering::SeqCst);
    operation();
    COUNT_ALLOCATIONS.store(false, Ordering::SeqCst);
    (
        ALLOCATION_COUNT.load(Ordering::SeqCst),
        ALLOCATION_BYTES.load(Ordering::SeqCst),
    )
}

fn fixed_problem(integrator: TimeIntegrator) -> ExchangeLlgProblem {
    ExchangeLlgProblem::with_terms(
        GridShape::new(1, 1, 1).expect("grid"),
        CellSize::new(1.0, 1.0, 1.0).expect("cell"),
        MaterialParameters::new(1.0, 1.0e-30, ALPHA).expect("material"),
        LlgConfig::new(GAMMA, integrator).expect("LLG"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            external_field: Some([0.0, 0.0, FIELD_Z_APM]),
            ..Default::default()
        },
    )
}

#[test]
fn fixed_cpu_production_path_has_zero_steady_state_allocations_and_bytes() {
    for integrator in [
        TimeIntegrator::Heun,
        TimeIntegrator::RK4,
        TimeIntegrator::ABM3,
    ] {
        for evaluation in [EvaluationRequest::Minimal, EvaluationRequest::Full] {
            let problem = fixed_problem(integrator);
            let mut published_state = problem
                .uniform_state([1.0, 0.0, 0.0])
                .expect("published state");
            let mut state = published_state.to_soa();
            let mut workspace = problem.create_workspace();
            let mut buffers = problem.create_integrator_buffers();

            for _ in 0..WARMUP_STEPS {
                problem
                    .step_soa_with_buffers_evaluation(
                        &mut state,
                        DT,
                        &mut workspace,
                        &mut buffers,
                        evaluation,
                    )
                    .expect("warmup step");
                state.write_back_to(&mut published_state);
            }

            let (allocations, allocated_bytes) = measured_allocations(|| {
                for _ in 0..MEASURED_STEPS {
                    problem
                        .step_soa_with_buffers_evaluation(
                            &mut state,
                            DT,
                            &mut workspace,
                            &mut buffers,
                            evaluation,
                        )
                        .expect("measured step");
                    state.write_back_to(&mut published_state);
                }
            });

            assert_eq!(
                allocations, 0,
                "{integrator:?} {evaluation:?} allocated {allocations} times after warmup"
            );
            assert_eq!(
                allocated_bytes, 0,
                "{integrator:?} {evaluation:?} allocated {allocated_bytes} bytes after warmup"
            );
            assert_eq!(state.time_seconds, published_state.time_seconds);
            assert_eq!(
                state.transactional_state_digest(),
                published_state.transactional_state_digest(),
                "{integrator:?} {evaluation:?} published state must preserve the full transactional state",
            );
            let expected = constant_z_field_llg_from_positive_x(
                GAMMA,
                ALPHA,
                FIELD_Z_APM,
                (WARMUP_STEPS + MEASURED_STEPS) as f64 * DT,
            );
            let error = published_state.magnetization()[0]
                .iter()
                .zip(expected)
                .map(|(actual, expected)| (actual - expected).abs())
                .fold(0.0_f64, f64::max);
            assert!(
                error <= MAX_ORACLE_ERROR,
                "{integrator:?} {evaluation:?} oracle error {error:.6e} exceeds {MAX_ORACLE_ERROR:.6e}"
            );
        }
    }
}
