use super::*;
use fullmag_engine::OerstedCylinderConfig;
use fullmag_ir::{
    ExchangeBoundaryCondition, ExecutionPrecision, FdmMaterialIR, GridDimensions, IntegratorChoice,
    RelaxationAlgorithmIR, RelaxationControlIR,
};

fn make_test_plan() -> FdmPlanIR {
    FdmPlanIR {
        grid: GridDimensions { cells: [4, 4, 1] },
        cell_size: [2e-9, 2e-9, 2e-9],
        region_mask: vec![0; 16],
        active_mask: None,
        initial_magnetization: vec![[1.0, 0.0, 0.0]; 16],
        material: FdmMaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.5,
            ..Default::default()
        },
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: IntegratorChoice::Heun,
        fixed_timestep: Some(1e-14),
        adaptive_timestep: None,
        relaxation: None,
        boundary_correction: None,
        boundary_geometry: None,
        inter_region_exchange: vec![],
        enable_exchange: true,
        enable_demag: false,
        external_field: None,
        current_density: None,
        stt_degree: None,
        stt_beta: None,
        stt_spin_polarization: None,
        stt_lambda: None,
        stt_epsilon_prime: None,
        has_oersted_cylinder: false,
        oersted_current: None,
        oersted_radius: None,
        oersted_center: None,
        oersted_axis: None,
        oersted_field_xyz: None,
        oersted_time_dep_kind: 0,
        oersted_time_dep_freq: 0.0,
        oersted_time_dep_phase: 0.0,
        oersted_time_dep_offset: 0.0,
        oersted_time_dep_t_on: 0.0,
        oersted_time_dep_t_off: 0.0,
        oersted_realization: None,
        temperature: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        ..Default::default()
    }
}

fn cpu_fft_env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .expect("CPU FFT backend env lock should not be poisoned")
}

struct EnvVarGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvVarGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

fn make_relaxation_precession_test_plan() -> FdmPlanIR {
    FdmPlanIR {
        grid: GridDimensions { cells: [1, 1, 1] },
        cell_size: [5e-9, 5e-9, 5e-9],
        region_mask: vec![0],
        active_mask: None,
        initial_magnetization: vec![[1.0, 0.0, 0.0]],
        material: FdmMaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.1,
            ..Default::default()
        },
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: IntegratorChoice::Rk23,
        fixed_timestep: Some(1e-15),
        adaptive_timestep: None,
        field_refresh: None,
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-6),
                energy_tolerance_j: None,
                max_steps: Some(10),
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        }),
        enable_exchange: false,
        enable_demag: false,
        external_field: Some([0.0, 0.0, 8.0e5]),
        boundary_correction: None,
        boundary_geometry: None,
        inter_region_exchange: vec![],
        current_density: None,
        stt_degree: None,
        stt_beta: None,
        stt_spin_polarization: None,
        stt_lambda: None,
        stt_epsilon_prime: None,
        has_oersted_cylinder: false,
        oersted_current: None,
        oersted_radius: None,
        oersted_center: None,
        oersted_axis: None,
        oersted_field_xyz: None,
        oersted_time_dep_kind: 0,
        oersted_time_dep_freq: 0.0,
        oersted_time_dep_phase: 0.0,
        oersted_time_dep_offset: 0.0,
        oersted_time_dep_t_on: 0.0,
        oersted_time_dep_t_off: 0.0,
        oersted_realization: None,
        temperature: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        ..Default::default()
    }
}

#[test]
fn snapshot_preview_m_uses_direct_state_without_reobserving_state() {
    reset_observe_state_calls();

    let plan = FdmPlanIR {
        initial_magnetization: vec![
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [-1.0, 0.0, 0.0],
            [0.0, -1.0, 0.0],
            [0.0, 0.0, -1.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 1.0],
            [1.0, 0.0, 1.0],
            [-1.0, -1.0, 0.0],
            [0.0, -1.0, -1.0],
            [-1.0, 0.0, -1.0],
            [1.0, -1.0, 0.0],
            [0.0, 1.0, -1.0],
            [-1.0, 0.0, 1.0],
            [1.0, 1.0, 1.0],
        ],
        ..make_test_plan()
    };

    let preview = snapshot_preview(
        &plan,
        &LivePreviewRequest {
            quantity: "m".to_string(),
            auto_scale_enabled: false,
            ..Default::default()
        },
    )
    .expect("magnetization preview should build");

    assert_eq!(preview.quantity, "m");
    assert_eq!(preview.vector_field_values.len(), 16 * 3);
    assert_eq!(
        observe_state_call_count(),
        0,
        "magnetization preview should read the state directly"
    );
}

#[test]
fn snapshot_preview_rejects_unimplemented_cpu_fft_backend_for_demag() {
    let _lock = cpu_fft_env_lock();
    let _env = EnvVarGuard::set(CPU_FFT_BACKEND_ENV, "fftw");
    let plan = FdmPlanIR {
        enable_exchange: false,
        enable_demag: true,
        ..make_test_plan()
    };

    let err = match snapshot_preview(
        &plan,
        &LivePreviewRequest {
            quantity: "H_demag".to_string(),
            auto_scale_enabled: false,
            ..Default::default()
        },
    ) {
        Ok(_) => panic!("demag preview should reject unimplemented CPU FFT backend"),
        Err(err) => err,
    };

    assert!(err.message.contains(CPU_FFT_BACKEND_ENV));
    assert!(err.message.contains("fftw"));
    assert!(err
        .message
        .contains("supported CPU FDM FFT backends: rustfft"));
}

#[test]
fn snapshot_vector_fields_share_direct_effective_field_cache_without_reobserving_state() {
    reset_observe_state_calls();
    reset_direct_field_assembly_calls();

    let fields = snapshot_vector_fields(
        &make_test_plan(),
        &["H_eff", "torque"],
        &LivePreviewRequest {
            auto_scale_enabled: false,
            ..Default::default()
        },
    )
    .expect("direct vector previews should build");

    assert_eq!(
        fields
            .iter()
            .map(|field| field.quantity.as_str())
            .collect::<Vec<_>>(),
        vec!["H_eff", "torque"]
    );
    assert_eq!(
        observe_state_call_count(),
        0,
        "direct vector previews should not force a full observables pass"
    );
    assert_eq!(
        direct_h_eff_assembly_call_count(),
        1,
        "H_eff and torque preview should share one direct effective-field assembly"
    );
}

#[test]
fn uniform_relaxation_produces_stable_energy() {
    let plan = make_test_plan();
    let result = execute_reference_fdm(&plan, 1e-12, &[], None, None).expect("run should succeed");

    assert_eq!(result.result.status, RunStatus::Completed);
    assert!(!result.result.steps.is_empty());
    for step in &result.result.steps {
        assert!(
            step.e_ex.abs() < 1e-30,
            "uniform m should have zero exchange energy, got {}",
            step.e_ex
        );
    }
}

#[test]
fn random_initial_relaxes_with_decreasing_energy() {
    let random_m0 = fullmag_plan::generate_random_unit_vectors(42, 16);

    let plan = FdmPlanIR {
        initial_magnetization: random_m0,
        ..make_test_plan()
    };

    let result = execute_reference_fdm(&plan, 5e-12, &[], None, None).expect("run should succeed");

    assert_eq!(result.result.status, RunStatus::Completed);
    let first_energy = result.result.steps.first().unwrap().e_ex;
    let last_energy = result.result.steps.last().unwrap().e_ex;
    assert!(
        last_energy <= first_energy,
        "exchange energy should decrease during relaxation: {} -> {}",
        first_energy,
        last_energy
    );
}

#[test]
fn exchange_energy_respects_planned_material_parameters() {
    let random_m0 = fullmag_plan::generate_random_unit_vectors(42, 16);
    let base_plan = FdmPlanIR {
        initial_magnetization: random_m0.clone(),
        ..make_test_plan()
    };
    let stronger_exchange_plan = FdmPlanIR {
        initial_magnetization: random_m0,
        material: FdmMaterialIR {
            exchange_stiffness: base_plan.material.exchange_stiffness * 2.0,
            ..base_plan.material.clone()
        },
        ..make_test_plan()
    };

    let base_result =
        execute_reference_fdm(&base_plan, 1e-14, &[], None, None).expect("base run should succeed");
    let stronger_result = execute_reference_fdm(&stronger_exchange_plan, 1e-14, &[], None, None)
        .expect("scaled run should succeed");

    let base_initial = base_result.result.steps.first().unwrap().e_ex;
    let stronger_initial = stronger_result.result.steps.first().unwrap().e_ex;
    let ratio = stronger_initial / base_initial;
    assert!(
        (ratio - 2.0).abs() < 1e-9,
        "exchange energy should scale with A: got ratio {}",
        ratio
    );
}

#[test]
fn scheduled_fields_include_initial_and_final_snapshots() {
    let plan = FdmPlanIR {
        initial_magnetization: fullmag_plan::generate_random_unit_vectors(42, 16),
        enable_demag: true,
        external_field: Some([1e5, 0.0, 0.0]),
        ..make_test_plan()
    };
    let outputs = [
        OutputIR::Field {
            name: "m".to_string(),
            every_seconds: 100e-12,
        },
        OutputIR::Field {
            name: "H_ex".to_string(),
            every_seconds: 100e-12,
        },
        OutputIR::Field {
            name: "H_demag".to_string(),
            every_seconds: 100e-12,
        },
        OutputIR::Field {
            name: "H_ext".to_string(),
            every_seconds: 100e-12,
        },
        OutputIR::Field {
            name: "H_eff".to_string(),
            every_seconds: 100e-12,
        },
        OutputIR::Scalar {
            name: "E_total".to_string(),
            every_seconds: 100e-12,
        },
    ];

    let executed = execute_reference_fdm(&plan, 1e-12, &outputs, None, None)
        .expect("scheduled field run should succeed");

    for field_name in ["m", "H_ex", "H_demag", "H_ext", "H_eff"] {
        let snapshots = executed
            .field_snapshots
            .iter()
            .filter(|snapshot| snapshot.name == field_name)
            .collect::<Vec<_>>();
        assert_eq!(
            snapshots.len(),
            2,
            "{field_name} should have initial and final snapshots"
        );
        assert_eq!(snapshots[0].step, 0);
        assert!(snapshots[1].step > 0);
    }
}

#[test]
fn demag_and_external_terms_produce_nonzero_observables() {
    let plan = FdmPlanIR {
        initial_magnetization: fullmag_plan::generate_random_unit_vectors(7, 16),
        enable_exchange: false,
        enable_demag: true,
        external_field: Some([5e4, 0.0, 0.0]),
        ..make_test_plan()
    };

    let executed =
        execute_reference_fdm(&plan, 1e-14, &[], None, None).expect("run should succeed");
    let stats = executed.result.steps.first().expect("scalar trace");

    assert!(stats.e_demag.is_finite());
    assert!(stats.e_ext.is_finite());
    assert!(stats.e_total.is_finite());
}

#[test]
fn scalar_only_due_outputs_use_step_report_without_reobserving_state() {
    let grid = GridShape::new(1, 1, 1).expect("valid grid");
    let problem = ExchangeLlgProblem::with_terms(
        grid,
        CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
        MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
        LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            magnetoelastic: None,
            ..Default::default()
        },
    );
    let state = problem
        .new_state(vec![[1.0, 0.0, 0.0]])
        .expect("state should build");
    let report = StepReport {
        time_seconds: state.time_seconds,
        dt_used: 2e-15,
        step_rejected: false,
        suggested_next_dt: None,
        exchange_energy_joules: 1.0,
        demag_energy_joules: 2.0,
        external_energy_joules: 3.0,
        anisotropy_energy_joules: 7.0,
        dmi_energy_joules: 11.0,
        total_energy_joules: 24.0,
        max_effective_field_amplitude: 11.0,
        max_demag_field_amplitude: 5.0,
        max_rhs_amplitude: 17.0,
        max_torque_Apm: 19.0,
    };
    let mut scalar_schedules = vec![OutputSchedule {
        name: "E_total".to_string(),
        every_seconds: 1.0,
        next_time: 0.0,
        last_sampled_time: None,
    }];
    let mut field_schedules = Vec::new();
    let mut steps = Vec::new();
    let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        ..Default::default()
    });

    record_due_outputs(
        &problem,
        &state,
        4,
        report.dt_used,
        23,
        Some(&report),
        &mut scalar_schedules,
        &mut field_schedules,
        &mut steps,
        &mut artifacts,
    )
    .expect("scalar row should record");

    let stats = steps.first().expect("recorded scalar row");
    assert_eq!(stats.step, 4);
    assert_eq!(stats.dt, report.dt_used);
    assert_eq!(stats.e_ex, report.exchange_energy_joules);
    assert_eq!(stats.e_demag, report.demag_energy_joules);
    assert_eq!(stats.e_ext, report.external_energy_joules);
    assert_eq!(stats.e_ani, report.anisotropy_energy_joules);
    assert_eq!(stats.e_dmi, report.dmi_energy_joules);
    assert_eq!(stats.e_total, report.total_energy_joules);
    assert_eq!(stats.max_dm_dt, report.max_rhs_amplitude);
    assert_eq!(stats.max_torque_Apm, report.max_torque_Apm);
    assert_eq!(stats.mx, 1.0);
    assert_eq!(stats.my, 0.0);
    assert_eq!(stats.mz, 0.0);
}

#[test]
fn live_scalar_updates_use_step_report_without_reobserving_every_step() {
    reset_observe_state_calls();

    let plan = FdmPlanIR {
        initial_magnetization: fullmag_plan::generate_random_unit_vectors(13, 16),
        ..make_test_plan()
    };
    let mut live_updates = 0usize;
    let mut on_step = |update: StepUpdate| -> StepAction {
        live_updates += 1;
        assert!(update.magnetization.is_none());
        assert!(update.preview_field.is_none());
        assert!(update.cached_preview_fields.is_none());
        StepAction::Continue
    };

    let executed = execute_reference_fdm(
        &plan,
        3e-14,
        &[],
        Some(LiveStepConsumer {
            grid: plan.grid.cells,
            field_every_n: u64::MAX,
            initial_snapshot: false,
            display_selection: None,
            interrupt_requested: None,
            on_step: &mut on_step,
        }),
        None,
    )
    .expect("live scalar-only CPU FDM run should succeed");

    assert_eq!(executed.result.status, RunStatus::Completed);
    assert!(live_updates >= 2, "expected per-step live updates");

    let observe_calls = observe_state_call_count();
    assert!(
            observe_calls <= 3,
            "scalar-only live updates should reuse StepReport instead of reobserving every step; observe_state calls: {observe_calls}"
        );
}

#[test]
fn live_direct_preview_uses_state_without_reobserving_every_refresh() {
    reset_observe_state_calls();

    let plan = FdmPlanIR {
        initial_magnetization: fullmag_plan::generate_random_unit_vectors(19, 16),
        ..make_test_plan()
    };
    let display_selection = || {
        let mut state = crate::DisplaySelectionState::default();
        state.selection.quantity = "m".to_string();
        state.selection.every_n = 1;
        state
    };
    let mut preview_updates = 0usize;
    let mut on_step = |update: StepUpdate| -> StepAction {
        if update.preview_field.is_some() {
            preview_updates += 1;
        }
        assert!(update.magnetization.is_none());
        assert!(update.cached_preview_fields.is_none());
        StepAction::Continue
    };

    let executed = execute_reference_fdm(
        &plan,
        3e-14,
        &[],
        Some(LiveStepConsumer {
            grid: plan.grid.cells,
            field_every_n: u64::MAX,
            initial_snapshot: false,
            display_selection: Some(&display_selection),
            interrupt_requested: None,
            on_step: &mut on_step,
        }),
        None,
    )
    .expect("live direct-preview CPU FDM run should succeed");

    assert_eq!(executed.result.status, RunStatus::Completed);
    assert!(preview_updates >= 2, "expected repeated preview updates");
    let observe_calls = observe_state_call_count();
    assert!(
            observe_calls <= 2,
            "direct live previews should not force full observables every refresh; observe_state calls: {observe_calls}"
        );
}

#[test]
fn live_magnetization_payload_reads_state_without_reobserving_every_refresh() {
    reset_observe_state_calls();

    let plan = FdmPlanIR {
        initial_magnetization: fullmag_plan::generate_random_unit_vectors(29, 16),
        ..make_test_plan()
    };
    let mut magnetization_updates = 0usize;
    let mut on_step = |update: StepUpdate| -> StepAction {
        if let Some(values) = update.magnetization.as_ref() {
            magnetization_updates += 1;
            assert_eq!(values.len(), plan.initial_magnetization.len() * 3);
        }
        assert!(update.preview_field.is_none());
        assert!(update.cached_preview_fields.is_none());
        StepAction::Continue
    };

    let executed = execute_reference_fdm(
        &plan,
        3e-14,
        &[],
        Some(LiveStepConsumer {
            grid: plan.grid.cells,
            field_every_n: 1,
            initial_snapshot: false,
            display_selection: None,
            interrupt_requested: None,
            on_step: &mut on_step,
        }),
        None,
    )
    .expect("live magnetization payload CPU FDM run should succeed");

    assert_eq!(executed.result.status, RunStatus::Completed);
    assert!(
        magnetization_updates >= 2,
        "expected repeated live magnetization payloads"
    );
    let observe_calls = observe_state_call_count();
    assert!(
            observe_calls <= 1,
            "live magnetization payload should read state directly instead of full observables per refresh; observe_state calls: {observe_calls}"
        );
}

#[test]
fn live_initial_snapshot_emits_step_zero_magnetization_before_first_step() {
    let plan = FdmPlanIR {
        initial_magnetization: fullmag_plan::generate_random_unit_vectors(19, 16),
        ..make_test_plan()
    };
    let expected_initial: Vec<f64> = plan
        .initial_magnetization
        .iter()
        .flat_map(|value| {
            let norm = (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt();
            [value[0] / norm, value[1] / norm, value[2] / norm]
        })
        .collect();
    let display_selection = || {
        let mut state = crate::DisplaySelectionState::default();
        state.selection.quantity = "m".to_string();
        state.selection.every_n = 1;
        state
    };
    let mut first_update: Option<StepUpdate> = None;
    let mut on_step = |update: StepUpdate| -> StepAction {
        if first_update.is_none() {
            first_update = Some(update);
            return StepAction::Stop;
        }
        StepAction::Stop
    };

    let executed = execute_reference_fdm(
        &plan,
        3e-14,
        &[],
        Some(LiveStepConsumer {
            grid: plan.grid.cells,
            field_every_n: u64::MAX,
            initial_snapshot: true,
            display_selection: Some(&display_selection),
            interrupt_requested: None,
            on_step: &mut on_step,
        }),
        None,
    )
    .expect("initial live snapshot CPU FDM run should stop cleanly");

    assert_eq!(executed.result.status, RunStatus::Cancelled);
    let first_update = first_update.expect("expected initial live update");
    assert_eq!(first_update.stats.step, 0);
    assert_eq!(first_update.stats.time, 0.0);
    let actual_initial = first_update
        .magnetization
        .as_deref()
        .expect("initial live snapshot should include magnetization");
    assert_eq!(actual_initial.len(), expected_initial.len());
    for (actual, expected) in actual_initial.iter().zip(expected_initial.iter()) {
        assert!(
            (actual - expected).abs() <= 1e-12,
            "initial magnetization component differs: actual={actual}, expected={expected}"
        );
    }
    assert!(first_update.preview_field.is_some());
    assert!(!first_update.finished);
}

#[test]
fn live_callback_pause_returns_paused_status_and_stops_stepping() {
    let plan = make_test_plan();
    let mut update_steps = Vec::new();
    let mut on_step = |update: StepUpdate| -> StepAction {
        update_steps.push(update.stats.step);
        StepAction::Pause
    };

    let executed = execute_reference_fdm(
        &plan,
        5e-14,
        &[],
        Some(LiveStepConsumer {
            grid: plan.grid.cells,
            field_every_n: 1,
            initial_snapshot: false,
            display_selection: None,
            interrupt_requested: None,
            on_step: &mut on_step,
        }),
        None,
    )
    .expect("pause callback CPU FDM run should pause cleanly");

    assert_eq!(executed.result.status, RunStatus::Paused);
    assert_eq!(
        update_steps,
        vec![1],
        "runner should stop after the first live pause callback instead of continuing"
    );
    assert!(
        executed
            .result
            .steps
            .last()
            .is_some_and(|stats| stats.step <= 1),
        "paused run should not advance to the requested final time"
    );
}

#[test]
fn default_final_scalar_trace_uses_last_step_report_without_reobserving_state() {
    reset_observe_state_calls();

    let plan = FdmPlanIR {
        initial_magnetization: fullmag_plan::generate_random_unit_vectors(17, 16),
        ..make_test_plan()
    };

    let executed = execute_reference_fdm(&plan, 2e-14, &[], None, None)
        .expect("default scalar trace CPU FDM run should succeed");

    assert_eq!(executed.result.status, RunStatus::Completed);
    assert_eq!(
        executed.result.steps.len(),
        2,
        "default scalar trace should keep initial and final scalar rows"
    );
    assert!(
        same_time(
            executed.result.steps.last().expect("final scalar row").time,
            2e-14
        ),
        "final scalar row should remain at the requested final time"
    );

    let observe_calls = observe_state_call_count();
    assert!(
            observe_calls <= 1,
            "default scalar trace should reuse the initial scalar snapshot and last StepReport without extra full observables; observe_state calls: {observe_calls}"
        );
}

#[test]
fn magnetization_only_due_outputs_read_state_without_reobserving_state() {
    reset_observe_state_calls();

    let grid = GridShape::new(1, 1, 2).expect("valid grid");
    let problem = ExchangeLlgProblem::with_terms(
        grid,
        CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
        MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
        LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            magnetoelastic: None,
            ..Default::default()
        },
    );
    let mut state = problem
        .new_state(vec![[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
        .expect("state should build");
    state.time_seconds = 2e-12;
    let report = StepReport {
        time_seconds: state.time_seconds,
        dt_used: 1e-14,
        step_rejected: false,
        suggested_next_dt: None,
        exchange_energy_joules: 1.0,
        demag_energy_joules: 2.0,
        external_energy_joules: 3.0,
        anisotropy_energy_joules: 4.0,
        dmi_energy_joules: 5.0,
        total_energy_joules: 15.0,
        max_effective_field_amplitude: 6.0,
        max_demag_field_amplitude: 7.0,
        max_rhs_amplitude: 8.0,
        max_torque_Apm: 9.0,
    };
    let mut scalar_schedules = vec![OutputSchedule {
        name: "E_total".to_string(),
        every_seconds: 1e-12,
        next_time: 0.0,
        last_sampled_time: None,
    }];
    let mut field_schedules = vec![
        OutputSchedule {
            name: "m".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
        OutputSchedule {
            name: "m.z".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
    ];
    let mut steps = Vec::new();
    let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        ..Default::default()
    });

    record_due_outputs(
        &problem,
        &state,
        5,
        report.dt_used,
        37,
        Some(&report),
        &mut scalar_schedules,
        &mut field_schedules,
        &mut steps,
        &mut artifacts,
    )
    .expect("magnetization-only outputs should record");

    let observe_calls = observe_state_call_count();
    assert_eq!(
        observe_calls, 0,
        "magnetization-only field outputs should use state values and StepReport scalars"
    );
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].e_total, report.total_energy_joules);
    let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
    assert_eq!(field_snapshot_count, 2);
    let field_names = field_snapshots
        .iter()
        .map(|snapshot| snapshot.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(field_names, vec!["m", "m.z"]);
    assert_eq!(field_snapshots[0].values, state.magnetization());
    assert_eq!(
        field_snapshots[1].values,
        vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]
    );
}

#[test]
fn external_field_due_outputs_read_problem_field_without_reobserving_state() {
    reset_observe_state_calls();

    let grid = GridShape::new(1, 1, 2).expect("valid grid");
    let problem = ExchangeLlgProblem::with_terms_and_mask(
        grid,
        CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
        MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
        LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            external_field: Some([2.0, 3.0, 4.0]),
            per_node_field: Some(vec![[0.5, 0.25, 0.125], [9.0, 9.0, 9.0]]),
            magnetoelastic: None,
            ..Default::default()
        },
        Some(vec![true, false]),
    )
    .expect("masked problem should build");
    let mut state = problem
        .new_state(vec![[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
        .expect("state should build");
    state.time_seconds = 2e-12;
    let mut scalar_schedules = Vec::new();
    let mut field_schedules = vec![
        OutputSchedule {
            name: "H_ext".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
        OutputSchedule {
            name: "H_ext.y".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
    ];
    let mut steps = Vec::new();
    let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        ..Default::default()
    });

    record_due_outputs(
        &problem,
        &state,
        6,
        1e-14,
        41,
        None,
        &mut scalar_schedules,
        &mut field_schedules,
        &mut steps,
        &mut artifacts,
    )
    .expect("external-field outputs should record");

    let observe_calls = observe_state_call_count();
    assert_eq!(
        observe_calls, 0,
        "H_ext outputs should use the direct external-field accessor instead of full observables"
    );
    let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
    assert_eq!(field_snapshot_count, 2);
    assert_eq!(field_snapshots[0].name, "H_ext");
    assert_eq!(
        field_snapshots[0].values,
        vec![[2.5, 3.25, 4.125], [0.0, 0.0, 0.0]]
    );
    assert_eq!(field_snapshots[1].name, "H_ext.y");
    assert_eq!(
        field_snapshots[1].values,
        vec![[3.25, 0.0, 0.0], [0.0, 0.0, 0.0]]
    );
}

#[test]
fn oersted_field_due_outputs_read_per_node_field_without_reobserving_state() {
    reset_observe_state_calls();

    let grid = GridShape::new(1, 1, 2).expect("valid grid");
    let problem = ExchangeLlgProblem::with_terms(
        grid,
        CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
        MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
        LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            per_node_field: Some(vec![[0.0, 0.0, 2.0], [1.0, 0.5, 0.25]]),
            magnetoelastic: None,
            ..Default::default()
        },
    );
    let mut state = problem
        .new_state(vec![[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
        .expect("state should build");
    state.time_seconds = 2e-12;
    let mut scalar_schedules = Vec::new();
    let mut field_schedules = vec![
        OutputSchedule {
            name: "H_OE".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
        OutputSchedule {
            name: "H_OE.z".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
    ];
    let mut steps = Vec::new();
    let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        ..Default::default()
    });

    record_due_outputs(
        &problem,
        &state,
        7,
        1e-14,
        43,
        None,
        &mut scalar_schedules,
        &mut field_schedules,
        &mut steps,
        &mut artifacts,
    )
    .expect("Oersted-field outputs should record");

    let observe_calls = observe_state_call_count();
    assert_eq!(
        observe_calls, 0,
        "H_OE outputs should use the direct per-node field instead of full observables"
    );
    let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
    assert_eq!(field_snapshot_count, 2);
    assert_eq!(field_snapshots[0].name, "H_OE");
    assert_eq!(
        field_snapshots[0].values,
        vec![[0.0, 0.0, 2.0], [1.0, 0.5, 0.25]]
    );
    assert_eq!(field_snapshots[1].name, "H_OE.z");
    assert_eq!(
        field_snapshots[1].values,
        vec![[2.0, 0.0, 0.0], [0.25, 0.0, 0.0]]
    );
}

#[test]
fn exchange_field_due_outputs_read_problem_field_without_reobserving_state() {
    reset_observe_state_calls();

    let grid = GridShape::new(3, 1, 1).expect("valid grid");
    let problem = ExchangeLlgProblem::with_terms(
        grid,
        CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
        MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
        LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
        EffectiveFieldTerms {
            exchange: true,
            demag: false,
            magnetoelastic: None,
            ..Default::default()
        },
    );
    let mut state = problem
        .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
        .expect("state should build");
    state.time_seconds = 2e-12;
    let expected_exchange = problem
        .exchange_field(&state)
        .expect("exchange field should assemble");
    let mut scalar_schedules = Vec::new();
    let mut field_schedules = vec![
        OutputSchedule {
            name: "H_ex".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
        OutputSchedule {
            name: "H_ex.y".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
    ];
    let mut steps = Vec::new();
    let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        ..Default::default()
    });

    record_due_outputs(
        &problem,
        &state,
        8,
        1e-14,
        47,
        None,
        &mut scalar_schedules,
        &mut field_schedules,
        &mut steps,
        &mut artifacts,
    )
    .expect("exchange-field outputs should record");

    let observe_calls = observe_state_call_count();
    assert_eq!(
        observe_calls, 0,
        "H_ex outputs should use the direct exchange-field accessor instead of full observables"
    );
    let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
    assert_eq!(field_snapshot_count, 2);
    assert_eq!(field_snapshots[0].name, "H_ex");
    assert_eq!(field_snapshots[0].values, expected_exchange);
    assert_eq!(field_snapshots[1].name, "H_ex.y");
    assert_eq!(
        field_snapshots[1].values,
        expected_exchange
            .iter()
            .map(|value| [value[1], 0.0, 0.0])
            .collect::<Vec<_>>()
    );
}

#[test]
fn demag_field_due_outputs_read_problem_field_without_reobserving_state() {
    reset_observe_state_calls();

    let grid = GridShape::new(2, 1, 1).expect("valid grid");
    let problem = ExchangeLlgProblem::with_terms(
        grid,
        CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
        MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
        LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
        EffectiveFieldTerms {
            exchange: false,
            demag: true,
            magnetoelastic: None,
            ..Default::default()
        },
    );
    let mut state = problem
        .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
        .expect("state should build");
    state.time_seconds = 2e-12;
    let expected_demag = problem
        .demag_field(&state)
        .expect("demag field should assemble");
    let mut scalar_schedules = Vec::new();
    let mut field_schedules = vec![
        OutputSchedule {
            name: "H_demag".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
        OutputSchedule {
            name: "H_demag.x".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
    ];
    let mut steps = Vec::new();
    let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        ..Default::default()
    });

    record_due_outputs(
        &problem,
        &state,
        9,
        1e-14,
        53,
        None,
        &mut scalar_schedules,
        &mut field_schedules,
        &mut steps,
        &mut artifacts,
    )
    .expect("demag-field outputs should record");

    let observe_calls = observe_state_call_count();
    assert_eq!(
        observe_calls, 0,
        "H_demag outputs should use the direct demag-field accessor instead of full observables"
    );
    let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
    assert_eq!(field_snapshot_count, 2);
    assert_eq!(field_snapshots[0].name, "H_demag");
    assert_eq!(field_snapshots[0].values, expected_demag);
    assert_eq!(field_snapshots[1].name, "H_demag.x");
    assert_eq!(
        field_snapshots[1].values,
        expected_demag
            .iter()
            .map(|value| [value[0], 0.0, 0.0])
            .collect::<Vec<_>>()
    );
}

#[test]
fn dmi_field_due_outputs_read_problem_field_without_reobserving_state() {
    let grid = GridShape::new(3, 3, 3).expect("valid grid");
    let problem = ExchangeLlgProblem::with_terms(
        grid,
        CellSize::new(1.0, 1.5, 2.0).expect("valid cell size"),
        MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
        LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            interfacial_dmi: Some(0.04 * crate::MU0),
            bulk_dmi: Some(-0.02 * crate::MU0),
            magnetoelastic: None,
            ..Default::default()
        },
    );
    let mut state = problem
        .new_state(
            (0..grid.cell_count())
                .map(|i| {
                    let x = i % grid.nx;
                    let y = (i / grid.nx) % grid.ny;
                    let z = i / (grid.nx * grid.ny);
                    [
                        1.0 + 0.11 * x as f64 - 0.03 * z as f64,
                        0.2 + 0.07 * y as f64 + 0.02 * z as f64,
                        0.4 - 0.05 * x as f64 + 0.09 * z as f64,
                    ]
                })
                .collect(),
        )
        .expect("state should build");
    state.time_seconds = 2e-12;
    let expected_dmi = problem
        .observe(&state)
        .expect("observables should assemble")
        .effective_field;
    reset_observe_state_calls();

    let mut scalar_schedules = Vec::new();
    let mut field_schedules = vec![
        OutputSchedule {
            name: "H_dmi".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
        OutputSchedule {
            name: "H_dmi.x".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
    ];
    let mut steps = Vec::new();
    let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        ..Default::default()
    });

    record_due_outputs(
        &problem,
        &state,
        10,
        1e-14,
        59,
        None,
        &mut scalar_schedules,
        &mut field_schedules,
        &mut steps,
        &mut artifacts,
    )
    .expect("DMI-field outputs should record");

    let observe_calls = observe_state_call_count();
    assert_eq!(
        observe_calls, 0,
        "H_dmi outputs should use the direct DMI-field accessor instead of full observables"
    );
    let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
    assert_eq!(field_snapshot_count, 2);
    assert_eq!(field_snapshots[0].name, "H_dmi");
    assert_eq!(field_snapshots[0].values, expected_dmi);
    assert_eq!(field_snapshots[1].name, "H_dmi.x");
    assert_eq!(
        field_snapshots[1].values,
        expected_dmi
            .iter()
            .map(|value| [value[0], 0.0, 0.0])
            .collect::<Vec<_>>()
    );
}

#[test]
fn anisotropy_field_due_outputs_read_problem_field_without_reobserving_state() {
    let grid = GridShape::new(2, 1, 1).expect("valid grid");
    let problem = ExchangeLlgProblem::with_terms(
        grid,
        CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
        MaterialParameters::new(1.0, 1.0, 0.2).expect("valid material"),
        LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            uniaxial_anisotropy: Some(UniaxialAnisotropyConfig {
                ku1: 0.5 * crate::MU0,
                ku2: 0.25 * crate::MU0,
                axis: [0.0, 0.0, 1.0],
            }),
            ..Default::default()
        },
    );
    let mut state = problem
        .new_state(vec![[0.6, 0.0, 0.8], [0.8, 0.0, 0.6]])
        .expect("state should build");
    state.time_seconds = 2e-12;
    let expected_anisotropy = problem
        .observe(&state)
        .expect("observables should assemble")
        .effective_field;
    reset_observe_state_calls();

    let mut scalar_schedules = Vec::new();
    let mut field_schedules = vec![
        OutputSchedule {
            name: "H_ani".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
        OutputSchedule {
            name: "H_ani.z".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
    ];
    let mut steps = Vec::new();
    let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        ..Default::default()
    });

    record_due_outputs(
        &problem,
        &state,
        11,
        1e-14,
        61,
        None,
        &mut scalar_schedules,
        &mut field_schedules,
        &mut steps,
        &mut artifacts,
    )
    .expect("anisotropy-field outputs should record");

    let observe_calls = observe_state_call_count();
    assert_eq!(
        observe_calls, 0,
        "H_ani outputs should use the direct anisotropy-field accessor instead of full observables"
    );
    let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
    assert_eq!(field_snapshot_count, 2);
    assert_eq!(field_snapshots[0].name, "H_ani");
    assert_eq!(field_snapshots[0].values, expected_anisotropy);
    assert_eq!(field_snapshots[1].name, "H_ani.z");
    assert_eq!(
        field_snapshots[1].values,
        expected_anisotropy
            .iter()
            .map(|value| [value[2], 0.0, 0.0])
            .collect::<Vec<_>>()
    );
}

#[test]
fn effective_field_due_outputs_read_observable_field_without_reobserving_state() {
    let grid = GridShape::new(2, 1, 1).expect("valid grid");
    let problem = ExchangeLlgProblem::with_terms(
        grid,
        CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
        MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
        LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            external_field: Some([1.0, 2.0, 3.0]),
            oersted_cylinder: Some(OerstedCylinderConfig {
                current: 1.0,
                radius: 1.0,
                center: [0.0, 0.0, 0.0],
                axis: [0.0, 0.0, 1.0],
                time_dep_kind: 0,
                time_dep_freq: 0.0,
                time_dep_phase: 0.0,
                time_dep_offset: 0.0,
                time_dep_t_on: 0.0,
                time_dep_t_off: 0.0,
            }),
            magnetoelastic: None,
            ..Default::default()
        },
    );
    let mut state = problem
        .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
        .expect("state should build");
    state.time_seconds = 2e-12;
    let expected_effective = problem
        .observe(&state)
        .expect("observables should assemble")
        .effective_field;
    assert_ne!(
            expected_effective,
            problem
                .effective_field(&state)
                .expect("public effective field should assemble"),
            "this regression preserves the current H_eff artifact contract, not the broader stepping helper"
        );
    reset_observe_state_calls();

    let mut scalar_schedules = Vec::new();
    let mut field_schedules = vec![
        OutputSchedule {
            name: "H_eff".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
        OutputSchedule {
            name: "H_eff.y".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
    ];
    let mut steps = Vec::new();
    let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        ..Default::default()
    });

    record_due_outputs(
        &problem,
        &state,
        10,
        1e-14,
        59,
        None,
        &mut scalar_schedules,
        &mut field_schedules,
        &mut steps,
        &mut artifacts,
    )
    .expect("effective-field outputs should record");

    let observe_calls = observe_state_call_count();
    assert_eq!(
            observe_calls, 0,
            "H_eff outputs should use the observable effective-field accessor instead of full observables"
        );
    let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
    assert_eq!(field_snapshot_count, 2);
    assert_eq!(field_snapshots[0].name, "H_eff");
    assert_eq!(field_snapshots[0].values, expected_effective);
    assert_eq!(field_snapshots[1].name, "H_eff.y");
    assert_eq!(
        field_snapshots[1].values,
        expected_effective
            .iter()
            .map(|value| [value[1], 0.0, 0.0])
            .collect::<Vec<_>>()
    );
}

#[test]
fn torque_due_outputs_read_observable_effective_field_without_reobserving_state() {
    let grid = GridShape::new(2, 1, 1).expect("valid grid");
    let problem = ExchangeLlgProblem::with_terms(
        grid,
        CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
        MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
        LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            external_field: Some([1.0, 2.0, 3.0]),
            oersted_cylinder: Some(OerstedCylinderConfig {
                current: 1.0,
                radius: 1.0,
                center: [0.0, 0.0, 0.0],
                axis: [0.0, 0.0, 1.0],
                time_dep_kind: 0,
                time_dep_freq: 0.0,
                time_dep_phase: 0.0,
                time_dep_offset: 0.0,
                time_dep_t_on: 0.0,
                time_dep_t_off: 0.0,
            }),
            magnetoelastic: None,
            ..Default::default()
        },
    );
    let mut state = problem
        .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
        .expect("state should build");
    state.time_seconds = 2e-12;
    let observables = problem
        .observe(&state)
        .expect("observables should assemble");
    let expected_torque = compute_torque_field(
        &observables.magnetization,
        &observables.effective_field,
        problem.material.damping,
        problem.dynamics.precession_enabled,
    );
    reset_observe_state_calls();

    let mut scalar_schedules = Vec::new();
    let mut field_schedules = vec![
        OutputSchedule {
            name: "torque".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
        OutputSchedule {
            name: "torque.z".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
    ];
    let mut steps = Vec::new();
    let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        ..Default::default()
    });

    record_due_outputs(
        &problem,
        &state,
        11,
        1e-14,
        61,
        None,
        &mut scalar_schedules,
        &mut field_schedules,
        &mut steps,
        &mut artifacts,
    )
    .expect("torque outputs should record");

    let observe_calls = observe_state_call_count();
    assert_eq!(
        observe_calls, 0,
        "torque outputs should derive from observable effective field instead of full observables"
    );
    let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
    assert_eq!(field_snapshot_count, 2);
    assert_eq!(field_snapshots[0].name, "torque");
    assert_eq!(field_snapshots[0].values, expected_torque);
    assert_eq!(field_snapshots[1].name, "torque.z");
    assert_eq!(
        field_snapshots[1].values,
        expected_torque
            .iter()
            .map(|value| [value[2], 0.0, 0.0])
            .collect::<Vec<_>>()
    );
}

#[test]
fn effective_field_and_torque_due_outputs_share_direct_effective_field_cache() {
    let grid = GridShape::new(2, 1, 1).expect("valid grid");
    let problem = ExchangeLlgProblem::with_terms(
        grid,
        CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
        MaterialParameters::new(1.0, 0.5 * crate::MU0, 0.2).expect("valid material"),
        LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
        EffectiveFieldTerms {
            exchange: false,
            demag: false,
            external_field: Some([1.0, 2.0, 3.0]),
            oersted_cylinder: Some(OerstedCylinderConfig {
                current: 1.0,
                radius: 1.0,
                center: [0.0, 0.0, 0.0],
                axis: [0.0, 0.0, 1.0],
                time_dep_kind: 0,
                time_dep_freq: 0.0,
                time_dep_phase: 0.0,
                time_dep_offset: 0.0,
                time_dep_t_on: 0.0,
                time_dep_t_off: 0.0,
            }),
            magnetoelastic: None,
            ..Default::default()
        },
    );
    let mut state = problem
        .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
        .expect("state should build");
    state.time_seconds = 2e-12;
    let observables = problem
        .observe(&state)
        .expect("observables should assemble");
    let expected_torque = compute_torque_field(
        &observables.magnetization,
        &observables.effective_field,
        problem.material.damping,
        problem.dynamics.precession_enabled,
    );
    reset_observe_state_calls();
    reset_direct_field_assembly_calls();

    let mut scalar_schedules = Vec::new();
    let mut field_schedules = vec![
        OutputSchedule {
            name: "H_eff".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
        OutputSchedule {
            name: "H_eff.y".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
        OutputSchedule {
            name: "torque".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
        OutputSchedule {
            name: "torque.z".to_string(),
            every_seconds: 1e-12,
            next_time: 0.0,
            last_sampled_time: None,
        },
    ];
    let mut steps = Vec::new();
    let mut artifacts = ArtifactRecorder::in_memory(ExecutionProvenance {
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        ..Default::default()
    });

    record_due_outputs(
        &problem,
        &state,
        12,
        1e-14,
        67,
        None,
        &mut scalar_schedules,
        &mut field_schedules,
        &mut steps,
        &mut artifacts,
    )
    .expect("direct outputs should record");

    assert_eq!(
        observe_state_call_count(),
        0,
        "direct H_eff/torque outputs should not assemble full observables"
    );
    assert_eq!(
            direct_h_eff_assembly_call_count(),
            1,
            "one output pass should assemble observable H_eff once and reuse it for H_eff siblings and torque"
        );
    let (field_snapshots, field_snapshot_count, _) = artifacts.finish();
    assert_eq!(field_snapshot_count, 4);
    assert_eq!(field_snapshots[0].name, "H_eff");
    assert_eq!(field_snapshots[0].values, observables.effective_field);
    assert_eq!(field_snapshots[1].name, "H_eff.y");
    assert_eq!(
        field_snapshots[1].values,
        observables
            .effective_field
            .iter()
            .map(|value| [value[1], 0.0, 0.0])
            .collect::<Vec<_>>()
    );
    assert_eq!(field_snapshots[2].name, "torque");
    assert_eq!(field_snapshots[2].values, expected_torque);
    assert_eq!(field_snapshots[3].name, "torque.z");
    assert_eq!(
        field_snapshots[3].values,
        expected_torque
            .iter()
            .map(|value| [value[2], 0.0, 0.0])
            .collect::<Vec<_>>()
    );
}

#[path = "tests/final_relax.rs"]
mod final_relax;
