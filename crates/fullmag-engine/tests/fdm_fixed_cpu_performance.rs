use std::{
    alloc::{GlobalAlloc, Layout, System},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

use fullmag_engine::{
    constant_z_field_llg_from_positive_x, CellSize, EffectiveFieldTerms, EvaluationRequest,
    ExchangeLlgProblem, GridShape, LlgConfig, MaterialParameters, SolverSession, TimeIntegrator,
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
static LIVE_BYTES: AtomicUsize = AtomicUsize::new(0);

#[global_allocator]
static ALLOCATOR: ProcessAllocationCounter = ProcessAllocationCounter;

fn record_allocation(bytes: usize) {
    LIVE_BYTES.fetch_add(bytes, Ordering::SeqCst);
    if COUNT_ALLOCATIONS.load(Ordering::SeqCst) {
        ALLOCATION_COUNT.fetch_add(1, Ordering::SeqCst);
        ALLOCATION_BYTES.fetch_add(bytes, Ordering::SeqCst);
    }
}

fn record_reallocation(old_size: usize, new_size: usize) {
    if new_size >= old_size {
        LIVE_BYTES.fetch_add(new_size - old_size, Ordering::SeqCst);
    } else {
        LIVE_BYTES.fetch_sub(old_size - new_size, Ordering::SeqCst);
    }
    if COUNT_ALLOCATIONS.load(Ordering::SeqCst) {
        ALLOCATION_COUNT.fetch_add(1, Ordering::SeqCst);
        ALLOCATION_BYTES.fetch_add(new_size, Ordering::SeqCst);
    }
}

unsafe impl GlobalAlloc for ProcessAllocationCounter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            record_allocation(layout.size());
        }
        pointer
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        LIVE_BYTES.fetch_sub(layout.size(), Ordering::SeqCst);
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            record_allocation(layout.size());
        }
        pointer
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let pointer = unsafe { System.realloc(ptr, layout, new_size) };
        if !pointer.is_null() {
            record_reallocation(layout.size(), new_size);
        }
        pointer
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

fn run_abm3_session_digest() -> String {
    let mut session =
        SolverSession::new(fixed_problem(TimeIntegrator::ABM3), vec![[1.0, 0.0, 0.0]])
            .expect("session");
    for _ in 0..8 {
        session.step(DT).expect("session step");
    }
    session.state().transactional_state_digest()
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
                state.publish_accepted_to(&mut published_state);
            }

            let mut copied_bytes = 0_u64;
            let mut full_field_copy_count = 0_u64;
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
                    let copy = state.publish_accepted_to(&mut published_state);
                    copied_bytes = copied_bytes.saturating_add(copy.copied_bytes);
                    full_field_copy_count =
                        full_field_copy_count.saturating_add(copy.full_field_copy_count);
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
            assert_eq!(
                copied_bytes,
                MEASURED_STEPS as u64 * std::mem::size_of::<[f64; 3]>() as u64,
                "{integrator:?} {evaluation:?} must copy exactly one accepted magnetization per step",
            );
            assert_eq!(full_field_copy_count, MEASURED_STEPS as u64);
            let final_sync = state.write_back_to(&mut published_state);
            let expected_final_field_copies = if integrator == TimeIntegrator::ABM3 {
                4
            } else {
                1
            };
            assert_eq!(
                final_sync.full_field_copy_count, expected_final_field_copies,
                "{integrator:?} {evaluation:?} final sync copied an unexpected number of full fields",
            );
            assert_eq!(
                final_sync.copied_bytes,
                expected_final_field_copies * std::mem::size_of::<[f64; 3]>() as u64,
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

    // Prime process-global worker state, then prove sequential sessions release
    // every task-owned allocation instead of retaining workspace capacity.
    drop(run_abm3_session_digest());
    let retained_baseline = LIVE_BYTES.load(Ordering::SeqCst);
    for _ in 0..32 {
        drop(run_abm3_session_digest());
        assert_eq!(
            LIVE_BYTES.load(Ordering::SeqCst),
            retained_baseline,
            "completed FDM CPU sessions must not retain task-owned heap capacity",
        );
    }

    // Each concurrent session owns independent state/workspace buffers. Exact
    // digests catch cross-session aliasing, not just crashes or finite values.
    let expected_digest = run_abm3_session_digest();
    let sessions = (0..8)
        .map(|_| std::thread::spawn(run_abm3_session_digest))
        .collect::<Vec<_>>();
    for session in sessions {
        assert_eq!(
            session.join().expect("session thread"),
            expected_digest,
            "concurrent FDM CPU sessions must remain bitwise independent",
        );
    }
}
