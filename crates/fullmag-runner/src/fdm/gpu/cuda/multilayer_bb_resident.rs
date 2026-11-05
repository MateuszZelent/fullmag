//! Thin host scalar controller over resident CUDA PG-BB vectors.
use super::super::LayerContext;
use crate::fdm::gpu::cuda::native::NativeFdmBackend;
use crate::relaxation::direct_minimizer::{
    backtracked_step_size, direct_minimizer_backtrack_exhausted,
    projected_gradient_armijo_accepts_with_tolerance, projected_gradient_step_size_from_products,
    DirectMinimizerAlgorithm, DEFAULT_STEP_SIZE,
};
use crate::relaxation::multilayer_bb::{MultilayerBbEvent, MultilayerBbOutcome};
use crate::relaxation::{RelaxationEnergyPlateauWindow, RelaxationTorqueConfirmation};
use crate::types::{RunError, StateObservables, StepAction, StepStats};
use fullmag_ir::{FdmMultilayerPlanIR, RelaxationControlIR};
use std::cell::RefCell;
use std::time::{Duration, Instant};

fn error(message: impl Into<String>) -> RunError {
    RunError {
        message: message.into(),
    }
}
fn ns(at: Instant) -> u64 {
    at.elapsed().as_nanos().min(u64::MAX as u128) as u64
}

// 20 doubles per layer: six energies, three maxima, three sums of m,
// active count, weighted |g|², chord, ss/sy/yy, changed count, invalid count.
struct Evaluation {
    state: StateObservables,
    products: [f64; 6],
}
fn evaluate(
    backend: &RefCell<NativeFdmBackend>,
    plan: &FdmMultilayerPlanIR,
    contexts: &[LayerContext],
    template: &StateObservables,
    packed: &mut [[f64; 20]],
) -> Result<Evaluation, RunError> {
    backend.borrow_mut().multilayer_bb_op(0, 0.0, packed)?;
    let mut state = template.clone();
    state.exchange_energy = 0.0;
    state.demag_energy = 0.0;
    state.external_energy = 0.0;
    state.anisotropy_energy = 0.0;
    state.dmi_energy = 0.0;
    state.rotated_dmi_energy = 0.0;
    state.max_h_eff = 0.0;
    state.max_h_demag = 0.0;
    state.max_torque_Apm = 0.0;
    let mut products = [0.0; 6];
    for ((v, _layer), context) in packed.iter().zip(&plan.layers).zip(contexts) {
        if v.iter().any(|x| !x.is_finite()) || v[19] != 0.0 {
            return Err(error(
                "resident multilayer BB returned nonfinite/unnormalized state",
            ));
        }
        state.exchange_energy += v[0];
        state.demag_energy += v[1];
        state.external_energy += v[2];
        state.anisotropy_energy += v[3];
        state.dmi_energy += v[4];
        state.rotated_dmi_energy += v[5];
        state.max_torque_Apm = state.max_torque_Apm.max(v[6]);
        state.max_h_eff = state.max_h_eff.max(v[7]);
        state.max_h_demag = state.max_h_demag.max(v[8]);
        let total = v[..5].iter().sum();
        let count = v[12].max(1.0);
        let weight = v[12]
            * context.problem.cell_size.volume()
            * context.problem.material.saturation_magnetisation;
        state.per_object_scalars.insert(
            context.magnet_name.clone(),
            std::collections::HashMap::from([
                ("e_ex".into(), v[0]),
                ("e_demag".into(), v[1]),
                ("e_ext".into(), v[2]),
                ("e_ani".into(), v[3]),
                ("e_dmi".into(), v[4]),
                ("e_rotated_dmi".into(), v[5]),
                ("e_total".into(), total),
                ("mx".into(), v[9] / count),
                ("my".into(), v[10] / count),
                ("mz".into(), v[11] / count),
                ("m_weight".into(), weight),
                ("max_dm_dt".into(), 0.0),
                ("max_h_eff".into(), v[7]),
                ("max_h_demag".into(), v[8]),
            ]),
        );
        for k in 0..6 {
            products[k] += v[13 + k];
        }
    }
    state.total_energy = state.exchange_energy
        + state.demag_energy
        + state.external_energy
        + state.anisotropy_energy
        + state.dmi_energy;
    state.max_torque_all_Apm = state.max_torque_Apm;
    Ok(Evaluation { state, products })
}
/// Every trial-side error crosses the accepted-state restoration seam.
/// Keep the primary failure legible if restoration or its fresh field fails.
fn restore_after_error(
    primary: RunError,
    backend: &RefCell<NativeFdmBackend>,
    plan: &FdmMultilayerPlanIR,
    contexts: &[LayerContext],
    template: &StateObservables,
    packed: &mut [[f64; 20]],
) -> RunError {
    let restore = backend.borrow_mut().multilayer_bb_op(3, 0.0, packed);
    let restored =
        restore.and_then(|()| evaluate(backend, plan, contexts, template, packed).map(|_| ()));
    match restored {
        Ok(()) => primary,
        Err(restore) => error(format!(
            "{}; accepted-state restore failed: {}",
            primary.message, restore.message
        )),
    }
}

fn stats(
    state: &StateObservables,
    step: u64,
    lambda: f64,
    started: Instant,
    backtracks: u32,
    evaluations: u64,
    evaluate_ns: u64,
    retract_ns: u64,
    copy_ns: u64,
    scalar_reads: u64,
    scalar_bytes: u64,
) -> StepStats {
    let mut s =
        crate::fdm::multilayer::make_multilayer_step_stats(step, 0.0, 0.0, ns(started), state);
    s.pseudo_time_s = None;
    s.relaxation_line_search_wall_time_ns = evaluate_ns;
    s.relaxation_retraction_wall_time_ns = retract_ns;
    s.relaxation_state_copy_wall_time_ns = copy_ns;
    s.rejected_attempts = backtracks;
    s.relaxation_energy_rejected_attempts = u64::from(backtracks);
    s.hot_loop_control_scalar_d2h_bytes = scalar_bytes;
    s.hot_loop_control_scalar_host_sync_count = scalar_reads;
    for values in s.per_object_scalars.values_mut() {
        values.insert("accepted_step_m_per_A".into(), lambda);
        values.insert("line_search_backtracks".into(), f64::from(backtracks));
        values.insert("energy_evaluations".into(), evaluations as f64);
        values.insert("field_evaluations".into(), evaluations as f64);
    }
    s
}
fn poll(
    observe: &mut dyn FnMut(MultilayerBbEvent<'_>) -> Result<StepAction, RunError>,
    s: &StepStats,
) -> Result<bool, RunError> {
    loop {
        match observe(MultilayerBbEvent::Poll { stats: s })? {
            StepAction::Continue => return Ok(false),
            StepAction::Stop => return Ok(true),
            StepAction::Pause => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

pub(super) fn execute_resident_bb(
    backend: &RefCell<NativeFdmBackend>,
    plan: &FdmMultilayerPlanIR,
    contexts: &[LayerContext],
    mut template: StateObservables,
    control: &RelaxationControlIR,
    observe: &mut dyn FnMut(MultilayerBbEvent<'_>) -> Result<StepAction, RunError>,
) -> Result<MultilayerBbOutcome, RunError> {
    // The scalar template deliberately owns no full field carriers.
    template.magnetization.clear();
    template.torque_field.clear();
    template.exchange_field.clear();
    template.demag_field.clear();
    template.external_field.clear();
    template.antenna_field.clear();
    template.drive_field.clear();
    template.effective_field.clear();
    template.anisotropy_field.clear();
    template.dmi_field.clear();
    template.rotated_dmi_field.clear();
    template.max_dm_dt = 0.0;
    template.max_rhs_all_norm_per_s = 0.0;
    let started = Instant::now();
    let mut packed = vec![[0.0; 20]; plan.layers.len()];
    let mut current = evaluate(backend, plan, contexts, &template, &mut packed)?;
    backend.borrow_mut().multilayer_bb_op(1, 0.0, &mut packed)?;
    if !current.products[0].is_finite() || current.products[0] < 0.0 {
        return Err(error(
            "resident multilayer BB has a nonfinite physical gradient norm",
        ));
    }
    let mut accepted_steps = 0;
    let mut evaluations = 1;
    let mut control_reads = 1;
    let mut lambda = DEFAULT_STEP_SIZE;
    let mut use_bb1 = true;
    let mut resets = 0;
    let mut cancelled = false;
    let mut stagnation = false;
    let mut converged = false;
    let mut plateau = RelaxationEnergyPlateauWindow::default();
    let mut confirmation = RelaxationTorqueConfirmation::default();
    let mut s = stats(
        &current.state,
        0,
        0.0,
        started,
        0,
        evaluations,
        0,
        0,
        0,
        control_reads,
        control_reads * plan.layers.len() as u64 * 160,
    );
    match observe(MultilayerBbEvent::Accepted {
        observables: &current.state,
        stats: &s,
    })? {
        StepAction::Stop => cancelled = true,
        StepAction::Pause => cancelled = poll(observe, &s)?,
        StepAction::Continue => {}
    }
    while !cancelled {
        if confirmation.observe_at_accepted_step(
            control,
            plateau.range(),
            s.max_torque_Apm,
            accepted_steps,
        ) {
            converged = true;
            break;
        }
        if accepted_steps >= control.stop.max_steps.unwrap_or(u64::MAX) {
            break;
        }
        if poll(observe, &s)? {
            cancelled = true;
            break;
        }
        let mut trial_lambda = lambda;
        let mut backtracks = 0;
        let mut unrepresentable = current.products[0] == 0.0;
        let mut candidate = None;
        let mut last_energy = current.state.total_energy;
        let mut evaluate_ns = 0;
        let mut retract_ns = 0;
        let mut copy_ns = 0;
        while !unrepresentable {
            match observe(MultilayerBbEvent::Poll { stats: &s }) {
                Ok(StepAction::Continue) => {}
                Err(primary) => {
                    return Err(restore_after_error(
                        primary,
                        backend,
                        plan,
                        contexts,
                        &template,
                        &mut packed,
                    ))
                }
                action => {
                    backend.borrow_mut().multilayer_bb_op(3, 0.0, &mut packed)?;
                    current = evaluate(backend, plan, contexts, &template, &mut packed)?;
                    evaluations += 1;
                    control_reads += 1;
                    match action {
                        Ok(StepAction::Stop) => {
                            cancelled = true;
                            break;
                        }
                        Ok(StepAction::Pause) => {
                            if poll(observe, &s)? {
                                cancelled = true;
                                break;
                            }
                        }
                        _ => {}
                    }
                }
            }
            let at = Instant::now();
            let trial_status = backend
                .borrow_mut()
                .multilayer_bb_op(2, trial_lambda, &mut packed);
            if let Err(primary) = trial_status {
                return Err(restore_after_error(
                    primary,
                    backend,
                    plan,
                    contexts,
                    &template,
                    &mut packed,
                ));
            }
            control_reads += 1;
            retract_ns += ns(at);
            if packed.iter().any(|layer| layer[19] != 0.0) {
                if direct_minimizer_backtrack_exhausted(
                    DirectMinimizerAlgorithm::ProjectedGradientBb,
                    backtracks,
                ) {
                    break;
                }
                trial_lambda = backtracked_step_size(trial_lambda);
                backtracks += 1;
                continue;
            }
            if packed.iter().all(|layer| layer[18] == 0.0) {
                unrepresentable = true;
                break;
            }
            let at = Instant::now();
            let trial = match evaluate(backend, plan, contexts, &template, &mut packed) {
                Ok(v) => v,
                Err(primary) => {
                    return Err(restore_after_error(
                        primary,
                        backend,
                        plan,
                        contexts,
                        &template,
                        &mut packed,
                    ));
                }
            };
            evaluate_ns += ns(at);
            evaluations += 1;
            control_reads += 1;
            last_energy = trial.state.total_energy;
            if trial.products[5] == 0.0 {
                unrepresentable = true;
                break;
            }
            if projected_gradient_armijo_accepts_with_tolerance(
                current.state.total_energy,
                trial.state.total_energy,
                trial.products[1],
                0.0,
            ) {
                candidate = Some(trial);
                break;
            }
            if direct_minimizer_backtrack_exhausted(
                DirectMinimizerAlgorithm::ProjectedGradientBb,
                backtracks,
            ) {
                break;
            }
            trial_lambda = backtracked_step_size(trial_lambda);
            backtracks += 1;
        }
        if cancelled {
            break;
        }
        let Some(trial) = candidate else {
            backend.borrow_mut().multilayer_bb_op(3, 0.0, &mut packed)?;
            current = evaluate(backend, plan, contexts, &template, &mut packed)?;
            evaluations += 1;
            control_reads += 1;
            if unrepresentable
                && control
                    .stop
                    .torque_tolerance_apm
                    .is_some_and(|limit| s.max_torque_Apm <= limit)
            {
                for _ in 0..3 {
                    if poll(observe, &s)? {
                        cancelled = true;
                        break;
                    }
                    current = evaluate(backend, plan, contexts, &template, &mut packed)?;
                    evaluations += 1;
                    control_reads += 1;
                    s = stats(
                        &current.state,
                        accepted_steps,
                        0.0,
                        started,
                        backtracks,
                        evaluations,
                        evaluate_ns,
                        retract_ns,
                        copy_ns,
                        control_reads,
                        control_reads * plan.layers.len() as u64 * 160,
                    );
                    if confirmation.observe(control, plateau.range(), s.max_torque_Apm) {
                        converged = true;
                        break;
                    }
                }
                if converged || cancelled {
                    break;
                }
            }
            if unrepresentable {
                stagnation = true;
                break;
            }
            return Err(error(format!("multilayer PG-BB Armijo line search exhausted; accepted state restored; accepted_energy={:.17e} J; trial_energy={:.17e} J; lambda={:.17e} m/A; backtracks={backtracks}",current.state.total_energy,last_energy,trial_lambda)));
        };
        let next = projected_gradient_step_size_from_products(
            trial.products[2],
            trial.products[3],
            trial.products[4],
            use_bb1,
            resets,
        );
        lambda = next.step_size;
        use_bb1 = next.use_bb1;
        resets = next.reset_consecutive;
        let at = Instant::now();
        backend.borrow_mut().multilayer_bb_op(1, 0.0, &mut packed)?;
        copy_ns += ns(at);
        current = trial;
        accepted_steps += 1;
        plateau.record(current.state.total_energy);
        s = stats(
            &current.state,
            accepted_steps,
            trial_lambda,
            started,
            backtracks,
            evaluations,
            evaluate_ns,
            retract_ns,
            copy_ns,
            control_reads,
            control_reads * plan.layers.len() as u64 * 160,
        );
        match observe(MultilayerBbEvent::Accepted {
            observables: &current.state,
            stats: &s,
        })? {
            StepAction::Stop => cancelled = true,
            StepAction::Pause => cancelled = poll(observe, &s)?,
            StepAction::Continue => {}
        }
    }
    // Restore/torque-confirmation evaluations also belong to cumulative totals.
    s.hot_loop_control_scalar_d2h_bytes = control_reads * plan.layers.len() as u64 * 160;
    s.hot_loop_control_scalar_host_sync_count = control_reads;
    for values in s.per_object_scalars.values_mut() {
        values.insert("energy_evaluations".into(), evaluations as f64);
        values.insert("field_evaluations".into(), evaluations as f64);
    }
    Ok(MultilayerBbOutcome {
        final_observables: current.state,
        final_stats: s,
        accepted_steps,
        converged,
        torque_confirmed: confirmation.confirmed(),
        final_energy_plateau_range_j: plateau.range(),
        cancelled,
        numerical_stagnation: stagnation,
    })
}
