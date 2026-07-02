use super::{
    cached_display_refresh_due, display_refresh_due, InteractiveFdmPreviewRuntime,
    InteractiveFdmPreviewRuntimeInner,
};
use crate::dispatch::FdmEngine;
use crate::fdm::cpu::reference::{
    direct_h_eff_assembly_call_count, observe_state_call_count, reset_direct_field_assembly_calls,
    reset_observe_state_calls,
};
use crate::interactive::display::{DisplayKind, DisplaySelectionState};
use crate::types::{LivePreviewRequest, StepAction};
use fullmag_ir::{
    ExchangeBoundaryCondition, ExecutionPrecision, FdmMaterialIR, FdmPlanIR, GridDimensions,
    IntegratorChoice,
};

fn make_soa_fdm_plan() -> FdmPlanIR {
    FdmPlanIR {
        grid: GridDimensions { cells: [4, 2, 1] },
        cell_size: [2e-9, 2e-9, 2e-9],
        region_mask: vec![0; 8],
        active_mask: None,
        initial_magnetization: vec![
            [1.0, 0.1, 0.0],
            [0.2, 1.0, 0.1],
            [0.1, 0.0, 1.0],
            [1.0, -0.2, 0.1],
            [0.0, 1.0, 0.3],
            [0.3, 0.2, 1.0],
            [1.0, 0.0, -0.2],
            [0.1, 1.0, 0.2],
        ],
        material: FdmMaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.2,
            ..Default::default()
        },
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: IntegratorChoice::Heun,
        fixed_timestep: Some(1e-14),
        adaptive_timestep: None,
        enable_exchange: true,
        enable_demag: true,
        ..Default::default()
    }
}

#[test]
fn display_refresh_due_honors_selection_revision_and_every_n() {
    let mut display_state = DisplaySelectionState::default();
    display_state.revision = 7;
    display_state.selection.every_n = 50;

    assert!(display_refresh_due(None, &display_state, 0));
    assert!(display_refresh_due(Some(6), &display_state, 13));
    assert!(display_refresh_due(Some(7), &display_state, 0));
    assert!(display_refresh_due(Some(7), &display_state, 1));
    assert!(!display_refresh_due(Some(7), &display_state, 2));
    assert!(!display_refresh_due(Some(7), &display_state, 49));
    assert!(display_refresh_due(Some(7), &display_state, 50));
    assert!(display_refresh_due(Some(7), &display_state, 100));
}

#[test]
fn cached_display_refresh_due_honors_field_every_n() {
    let mut display_state = DisplaySelectionState::default();
    display_state.revision = 3;

    assert!(cached_display_refresh_due(None, &display_state, 0, 25));
    assert!(cached_display_refresh_due(Some(2), &display_state, 17, 25));
    assert!(cached_display_refresh_due(Some(3), &display_state, 0, 25));
    assert!(cached_display_refresh_due(Some(3), &display_state, 1, 25));
    assert!(!cached_display_refresh_due(Some(3), &display_state, 2, 25));
    assert!(!cached_display_refresh_due(Some(3), &display_state, 24, 25));
    assert!(cached_display_refresh_due(Some(3), &display_state, 25, 25));
}

#[test]
fn cpu_interactive_runtime_keeps_supported_fdm_segment_on_persistent_soa_state() {
    let plan = make_soa_fdm_plan();
    let mut runtime = InteractiveFdmPreviewRuntime::from_fdm_plan(&plan, FdmEngine::CpuReference)
        .expect("CPU interactive runtime should build");
    let cpu = match &mut runtime.inner {
        InteractiveFdmPreviewRuntimeInner::Cpu(cpu) => cpu,
        #[cfg(feature = "cuda")]
        InteractiveFdmPreviewRuntimeInner::Cuda(_) => {
            panic!("CPU engine should build a CPU interactive runtime")
        }
    };
    assert!(cpu.soa_fast_path_active());

    let display_selection = || {
        let mut state = DisplaySelectionState::default();
        state.selection.quantity = "E_total".to_string();
        state.selection.kind = DisplayKind::GlobalScalar;
        state
    };
    let mut seen_steps = 0;
    let result = runtime
        .execute_with_live_preview(
            &plan,
            2e-14,
            plan.grid.cells,
            8,
            &display_selection,
            None,
            &mut |update| {
                seen_steps = seen_steps.max(update.stats.step);
                StepAction::Continue
            },
        )
        .expect("CPU interactive runtime should execute");

    assert!(seen_steps > 0);
    assert!(!result.final_magnetization.is_empty());
    let cpu = match &mut runtime.inner {
        InteractiveFdmPreviewRuntimeInner::Cpu(cpu) => cpu,
        #[cfg(feature = "cuda")]
        InteractiveFdmPreviewRuntimeInner::Cuda(_) => {
            panic!("CPU engine should keep a CPU interactive runtime")
        }
    };
    assert!(cpu.soa_fast_path_active());
}

#[test]
fn cpu_interactive_snapshot_preview_m_uses_direct_state_without_reobserving_state() {
    let plan = make_soa_fdm_plan();
    let mut runtime = InteractiveFdmPreviewRuntime::from_fdm_plan(&plan, FdmEngine::CpuReference)
        .expect("CPU interactive runtime should build");

    reset_observe_state_calls();
    let preview = runtime
        .snapshot_preview(&LivePreviewRequest {
            quantity: "m".to_string(),
            auto_scale_enabled: false,
            ..Default::default()
        })
        .expect("interactive magnetization preview should build");

    assert_eq!(preview.quantity, "m");
    assert_eq!(preview.vector_field_values.len(), 8 * 3);
    assert_eq!(
        observe_state_call_count(),
        0,
        "interactive magnetization preview should read CPU state directly"
    );
}

#[test]
fn cpu_interactive_snapshot_vector_fields_share_direct_effective_field_cache_without_reobserving_state(
) {
    let plan = make_soa_fdm_plan();
    let mut runtime = InteractiveFdmPreviewRuntime::from_fdm_plan(&plan, FdmEngine::CpuReference)
        .expect("CPU interactive runtime should build");

    reset_observe_state_calls();
    reset_direct_field_assembly_calls();
    let fields = runtime
        .snapshot_vector_fields(
            &["H_eff", "torque"],
            &LivePreviewRequest {
                auto_scale_enabled: false,
                ..Default::default()
            },
        )
        .expect("interactive vector previews should build");

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
        "interactive direct vector previews should not force a full observables pass"
    );
    assert_eq!(
        direct_h_eff_assembly_call_count(),
        1,
        "interactive H_eff and torque previews should share one direct effective-field assembly"
    );
}

#[test]
fn cpu_interactive_snapshot_step_stats_uses_last_step_report_without_reobserving_state() {
    let plan = make_soa_fdm_plan();
    let mut runtime = InteractiveFdmPreviewRuntime::from_fdm_plan(&plan, FdmEngine::CpuReference)
        .expect("CPU interactive runtime should build");
    let display_selection = || {
        let mut state = DisplaySelectionState::default();
        state.selection.quantity = "E_total".to_string();
        state.selection.kind = DisplayKind::GlobalScalar;
        state
    };
    runtime
        .execute_with_live_preview(
            &plan,
            2e-14,
            plan.grid.cells,
            8,
            &display_selection,
            None,
            &mut |_| StepAction::Continue,
        )
        .expect("CPU interactive runtime should execute");

    reset_observe_state_calls();
    let stats = runtime
        .snapshot_step_stats()
        .expect("interactive step stats snapshot should build");

    assert_eq!(stats.step, 2);
    assert!(stats.e_total.is_finite());
    assert_eq!(
        observe_state_call_count(),
        0,
        "interactive step stats snapshot should reuse the last StepReport"
    );
}
