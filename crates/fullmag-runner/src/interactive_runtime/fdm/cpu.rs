use super::super::artifacts::observed::*;
use super::super::*;

impl CpuInteractiveFdmPreviewRuntime {
    pub(crate) fn upload_magnetization(
        &mut self,
        magnetization: &[[f64; 3]],
    ) -> Result<(), RunError> {
        self.state
            .set_magnetization(magnetization.to_vec())
            .map_err(|error| RunError {
                message: format!("setting interactive CPU magnetization failed: {}", error),
            })?;
        self.state_soa = if self.problem.soa_fast_path_supported() {
            Some(self.state.to_soa())
        } else {
            None
        };
        self.last_step_report = None;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn soa_fast_path_active(&self) -> bool {
        self.state_soa.is_some()
    }

    pub(crate) fn step(&mut self, dt_step: f64) -> Result<StepReport, RunError> {
        if self.state_soa.is_none() && self.problem.soa_fast_path_supported() {
            self.state_soa = Some(self.state.to_soa());
        }

        let report = if let Some(state_soa) = self.state_soa.as_mut() {
            let report = self
                .problem
                .step_soa_with_buffers_evaluation(
                    state_soa,
                    dt_step,
                    &mut self.fft_workspace,
                    &mut self.integrator_buffers,
                    EvaluationRequest::Full,
                )
                .map_err(|error| RunError {
                    message: format!("interactive CPU step failed: {}", error),
                })?;
            state_soa.write_back_to(&mut self.state);
            report
        } else {
            self.problem
                .step_with_buffers(
                    &mut self.state,
                    dt_step,
                    &mut self.fft_workspace,
                    &mut self.integrator_buffers,
                )
                .map_err(|error| RunError {
                    message: format!("interactive CPU step failed: {}", error),
                })?
        };
        self.last_step_report = Some(report);
        Ok(report)
    }

    pub(crate) fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        let requested = [request.quantity.as_str()];
        if active_fdm_preview_quantities(FdmEngine::CpuReference, &self.plan_signature, &requested)
            .is_empty()
        {
            return Err(RunError {
                message: format!(
                    "preview quantity '{}' is not active for the current FDM problem",
                    request.quantity
                ),
            });
        }
        cpu_reference::snapshot_preview_from_state(
            &self.problem,
            &self.state,
            request,
            self.original_grid,
            self.plan_signature.active_mask.as_deref(),
        )
    }

    pub(crate) fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        let quantities = active_fdm_preview_quantities(
            FdmEngine::CpuReference,
            &self.plan_signature,
            quantities,
        );
        cpu_reference::snapshot_vector_fields_from_state(
            &self.problem,
            &self.state,
            &quantities,
            request,
            self.original_grid,
            self.plan_signature.active_mask.as_deref(),
        )
    }

    pub(crate) fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        if let Some(report) = self
            .last_step_report
            .as_ref()
            .filter(|report| same_time(report.time_seconds, self.state.time_seconds))
        {
            return Ok(make_step_stats_from_report(
                self.total_steps,
                self.state.time_seconds,
                report,
                0,
                self.state.magnetization(),
            ));
        }

        let observables = cpu_reference::observe_state(&self.problem, &self.state)?;
        Ok(make_step_stats(
            self.total_steps,
            self.state.time_seconds,
            0.0,
            0,
            &observables,
        ))
    }

    pub(crate) fn execute_with_live_preview(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        grid: [u32; 3],
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<RunResult, RunError> {
        if !self.plan_signature.eq(&normalize_plan_signature(plan)) {
            return Err(RunError {
                message:
                    "interactive CPU runtime plan mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }
        if plan.relaxation.as_ref().is_some_and(|control| {
            matches!(
                control.algorithm,
                RelaxationAlgorithmIR::ProjectedGradientBb | RelaxationAlgorithmIR::NonlinearCg
            )
        }) {
            return Err(RunError {
                message:
                    "interactive CPU runtime does not yet support BB/NCG direct-minimization relaxation"
                        .to_string(),
            });
        }

        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let base_step = self.total_steps;
        let base_time = self.state.time_seconds;
        let mut dt =
            crate::resolve_initial_timestep(plan.fixed_timestep, plan.adaptive_timestep.as_ref())
                .unwrap_or(crate::DEFAULT_ADAPTIVE_DT_INITIAL);
        let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut last_cached_preview_revision: Option<u64> = None;
        let mut cancelled = false;
        let mut paused = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let initial_observables = cpu_reference::observe_state(&self.problem, &self.state)?;
        let mut current_observables = initial_observables;
        let mut current_local_stats = make_step_stats(
            self.total_steps,
            self.state.time_seconds,
            0.0,
            0,
            &current_observables,
        );
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;

        while self.state.time_seconds - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let cached_display_due = cached_display_refresh_due(
                last_cached_preview_revision,
                &display_state,
                current_local_stats.step,
                field_every_n,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(build_grid_preview_field(
                    &preview_cfg,
                    select_observables(&current_observables, &preview_cfg.quantity)?,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                ))
            } else {
                None
            };
            let cached_preview_fields = if cached_display_due {
                build_cached_grid_preview_fields(
                    &display_state,
                    &current_observables,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                )
            } else {
                None
            };
            let action = on_step(StepUpdate {
            coupled_checkpoint: None,
                stats: current_local_stats.clone(),
                grid,
                fem_mesh: None,
                magnetization: None,
                preview_field,
                cached_preview_fields,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_display_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let dt_step = dt.min(until_seconds - (self.state.time_seconds - base_time));
            let wall_start = std::time::Instant::now();
            let report = self.step(dt_step)?;
            let wall_elapsed = wall_start.elapsed().as_nanos() as u64;
            self.total_steps += 1;
            if let Some(next) = report.suggested_next_dt {
                dt = next;
            }

            // Build lightweight StepStats from the StepReport (no redundant
            // observe).  Full observe_state is deferred until we know that
            // preview or cached-preview data is actually needed.
            let total_stats = make_step_stats_from_report(
                self.total_steps,
                self.state.time_seconds,
                &report,
                wall_elapsed,
                self.state.magnetization(),
            );
            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let cached_display_due = cached_display_refresh_due(
                last_cached_preview_revision,
                &display_state,
                local_stats.step,
                field_every_n,
            );

            // Only run the expensive full observe when vector-field data is
            // actually needed (preview refresh or cached preview refresh).
            let needs_observables =
                (preview_due && !display_is_global_scalar(&display_state)) || cached_display_due;

            if needs_observables {
                let observables = cpu_reference::observe_state(&self.problem, &self.state)?;
                current_observables = observables;
            }

            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(build_grid_preview_field(
                    &preview_cfg,
                    select_observables(&current_observables, &preview_cfg.quantity)?,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                ))
            } else {
                None
            };
            let cached_preview_fields = if cached_display_due {
                build_cached_grid_preview_fields(
                    &display_state,
                    &current_observables,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                )
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
            coupled_checkpoint: None,
                stats: local_stats.clone(),
                grid,
                fem_mesh: None,
                magnetization: None,
                preview_field,
                cached_preview_fields,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_display_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            steps.push(local_stats.clone());
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let energy_plateau_range = energy_plateau.record(total_stats.e_total);
            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                    || relaxation_converged(
                        control,
                        &total_stats,
                        energy_plateau_range,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            if stop_for_relaxation {
                break;
            }
        }

        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = crate::relaxation::resolve_stage_completion(
            status,
            plan.relaxation.as_ref(),
            crate::relaxation::RelaxationCompletionMetrics {
                max_torque_apm: Some(current_local_stats.max_torque_Apm),
                accepted_energy_plateau_range_j: energy_plateau.range(),
                steps: current_local_stats.step,
                relaxation_time_s: Some(current_local_stats.time),
                numerical_stagnation: false,
            },
        );

        Ok(RunResult {
            status,
            steps,
            final_magnetization: self.state.magnetization().to_vec(),
            completion: Some(completion),
        })
    }

    pub(crate) fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        grid: [u32; 3],
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        _interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        artifact_writer: Option<ArtifactPipelineSender>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        if !self.plan_signature.eq(&normalize_plan_signature(plan)) {
            return Err(RunError {
                message:
                    "interactive CPU runtime plan mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }
        if plan.relaxation.as_ref().is_some_and(|control| {
            matches!(
                control.algorithm,
                RelaxationAlgorithmIR::ProjectedGradientBb | RelaxationAlgorithmIR::NonlinearCg
            )
        }) {
            return Err(RunError {
                message:
                    "interactive CPU runtime does not yet support BB/NCG direct-minimization relaxation"
                        .to_string(),
            });
        }

        let initial_magnetization = self.state.magnetization().to_vec();
        let mut artifacts = if let Some(writer) = artifact_writer {
            ArtifactRecorder::streaming(self.provenance.clone(), writer)
        } else {
            ArtifactRecorder::in_memory(self.provenance.clone())
        };
        let mut scalar_schedules = collect_scalar_schedules(outputs)?;
        let mut field_schedules = collect_field_schedules(outputs)?;
        let default_scalar_trace = scalar_schedules.is_empty();
        let initial_observables = cpu_reference::observe_state(&self.problem, &self.state)?;
        let mut steps = Vec::new();
        if default_scalar_trace {
            let stats = make_step_stats(0, 0.0, 0.0, 0, &initial_observables);
            artifacts.record_scalar(&stats)?;
            steps.push(stats);
        } else {
            record_due_cpu_outputs(
                &initial_observables,
                0,
                0.0,
                0.0,
                0,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
            )?;
        }
        let result = self.execute_cpu_streaming_loop(
            plan,
            until_seconds,
            grid,
            field_every_n,
            display_selection,
            on_step,
            default_scalar_trace,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut artifacts,
        )?;
        let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
        Ok(ExecutedRun {
            result,
            initial_magnetization,
            field_snapshots,
            field_snapshot_count,
            provenance,
            auxiliary_artifacts: vec![],
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn execute_cpu_streaming_loop(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        grid: [u32; 3],
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
        default_scalar_trace: bool,
        scalar_schedules: &mut [OutputSchedule],
        field_schedules: &mut [OutputSchedule],
        steps: &mut Vec<StepStats>,
        artifacts: &mut ArtifactRecorder,
    ) -> Result<RunResult, RunError> {
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let base_step = self.total_steps;
        let base_time = self.state.time_seconds;
        let mut dt =
            crate::resolve_initial_timestep(plan.fixed_timestep, plan.adaptive_timestep.as_ref())
                .unwrap_or(crate::DEFAULT_ADAPTIVE_DT_INITIAL);
        let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested: None, // CPU FDM checks interrupt via on_step StepAction
            last_preview_revision: None,
        };
        let mut cancelled = false;
        let mut paused = false;
        let mut latest_local_stats: Option<StepStats> = None;
        let mut current_observables = cpu_reference::observe_state(&self.problem, &self.state)?;
        let mut current_local_stats = make_step_stats(
            self.total_steps,
            self.state.time_seconds,
            0.0,
            0,
            &current_observables,
        );
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;

        while self.state.time_seconds - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(build_grid_preview_field(
                    &preview_cfg,
                    select_observables(&current_observables, &preview_cfg.quantity)?,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                ))
            } else {
                None
            };
            let action = on_step(StepUpdate {
            coupled_checkpoint: None,
                stats: current_local_stats.clone(),
                grid,
                fem_mesh: None,
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let dt_step = dt.min(until_seconds - (self.state.time_seconds - base_time));
            let wall_start = std::time::Instant::now();
            let report = self.step(dt_step)?;
            let wall_elapsed = wall_start.elapsed().as_nanos() as u64;
            self.total_steps += 1;
            if let Some(next) = report.suggested_next_dt {
                dt = next;
            }

            // Build lightweight StepStats from the StepReport (no redundant
            // observe).  Full observe_state is deferred until we know that
            // outputs, preview, or field data is actually needed.
            let total_stats = make_step_stats_from_report(
                self.total_steps,
                self.state.time_seconds,
                &report,
                wall_elapsed,
                self.state.magnetization(),
            );
            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            latest_local_stats = Some(local_stats.clone());

            // Determine what outputs are due BEFORE deciding whether to run
            // the expensive observe_state.
            let scalar_output_due = scalar_schedules
                .iter()
                .any(|schedule| is_due(local_stats.time, schedule.next_time));
            let due_field_names: Vec<String> = field_schedules
                .iter()
                .filter(|schedule| is_due(local_stats.time, schedule.next_time))
                .map(|schedule| schedule.name.clone())
                .collect();

            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let needs_observables = scalar_output_due
                || !due_field_names.is_empty()
                || (preview_due && !display_is_global_scalar(&display_state));

            // Only run the expensive full observe when actually needed.
            if needs_observables {
                let observables = cpu_reference::observe_state(&self.problem, &self.state)?;
                current_observables = observables;
            }

            if scalar_output_due || !due_field_names.is_empty() {
                record_due_cpu_outputs(
                    &current_observables,
                    local_stats.step,
                    local_stats.time,
                    report.dt_used,
                    wall_elapsed,
                    scalar_schedules,
                    field_schedules,
                    steps,
                    artifacts,
                )?;
            }

            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(build_grid_preview_field(
                    &preview_cfg,
                    select_observables(&current_observables, &preview_cfg.quantity)?,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                ))
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
            coupled_checkpoint: None,
                stats: local_stats.clone(),
                grid,
                fem_mesh: None,
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            // Cooperative checkpoint: poll for pending control requests
            let control = checkpoint.check_control();
            if control != crate::interactive::commands::RuntimeControlOutcome::Continue {
                cancelled = true;
                break;
            }

            let energy_plateau_range = energy_plateau.record(total_stats.e_total);
            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                    || relaxation_converged(
                        control,
                        &total_stats,
                        energy_plateau_range,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            if stop_for_relaxation {
                break;
            }
        }

        if let Some(final_stats) = latest_local_stats {
            let final_observables = cpu_reference::observe_state(&self.problem, &self.state)?;
            record_final_cpu_outputs(
                &final_observables,
                final_stats.step,
                final_stats.time,
                final_stats.dt,
                default_scalar_trace,
                field_schedules,
                steps,
                artifacts,
            )?;
        }

        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = crate::relaxation::resolve_stage_completion(
            status,
            plan.relaxation.as_ref(),
            crate::relaxation::RelaxationCompletionMetrics {
                max_torque_apm: Some(current_local_stats.max_torque_Apm),
                accepted_energy_plateau_range_j: energy_plateau.range(),
                steps: current_local_stats.step,
                relaxation_time_s: Some(current_local_stats.time),
                numerical_stagnation: false,
            },
        );

        Ok(RunResult {
            status,
            steps: steps.clone(),
            final_magnetization: self.state.magnetization().to_vec(),
            completion: Some(completion),
        })
    }
}
