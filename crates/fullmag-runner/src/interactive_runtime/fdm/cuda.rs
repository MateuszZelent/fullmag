use super::super::artifacts::fdm_cuda::*;
use super::super::*;
use std::collections::HashSet;

#[cfg(feature = "cuda")]
impl CudaInteractiveFdmPreviewRuntime {
    pub(crate) fn upload_magnetization(
        &mut self,
        magnetization: &[[f64; 3]],
    ) -> Result<(), RunError> {
        self.backend.upload_magnetization(magnetization)?;
        self.backend.refresh_observables()
    }

    pub(crate) fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        let requested = [request.quantity.as_str()];
        if active_fdm_preview_quantities(FdmEngine::CudaFdm, &self.plan_signature, &requested)
            .is_empty()
        {
            return Err(RunError {
                message: format!(
                    "preview quantity '{}' is not active for the current FDM problem",
                    request.quantity
                ),
            });
        }
        self.backend.copy_live_preview_field(
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
        let quantities =
            active_fdm_preview_quantities(FdmEngine::CudaFdm, &self.plan_signature, quantities);
        let mut cached = Vec::new();
        let mut seen = HashSet::new();

        for quantity in quantities
            .iter()
            .filter_map(|quantity| normalized_quantity_name(quantity).ok())
        {
            if !seen.insert(quantity) {
                continue;
            }
            let mut preview_request = request.clone();
            preview_request.quantity = quantity.to_string();
            cached.push(self.backend.copy_live_preview_field(
                &preview_request,
                self.original_grid,
                self.plan_signature.active_mask.as_deref(),
            )?);
        }

        Ok(cached)
    }

    pub(crate) fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        self.backend.snapshot_step_stats(self.original_grid)
    }

    fn begin_cached_preview_prefetch(
        &self,
        display_state: &DisplaySelectionState,
    ) -> Result<Option<Vec<NativeFdmPreviewSnapshot>>, RunError> {
        let quantities = active_fdm_preview_quantities(
            FdmEngine::CudaFdm,
            &self.plan_signature,
            &cached_preview_quantities_for(display_state),
        );
        if quantities.is_empty() {
            return Ok(None);
        }
        let base_request = display_state.preview_request();
        let mut snapshots = Vec::with_capacity(quantities.len());
        let mut seen = HashSet::new();
        for quantity in quantities
            .into_iter()
            .filter_map(|quantity| normalized_quantity_name(quantity).ok())
        {
            if !seen.insert(quantity) {
                continue;
            }
            let mut request = base_request.clone();
            request.quantity = quantity.to_string();
            snapshots.push(
                self.backend
                    .begin_live_preview_snapshot(&request, self.original_grid)?,
            );
        }
        Ok(Some(snapshots))
    }

    fn resolve_cached_preview_prefetch(
        &self,
        snapshots: Vec<NativeFdmPreviewSnapshot>,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        snapshots
            .into_iter()
            .map(|snapshot| {
                snapshot.into_live_preview_field(self.plan_signature.active_mask.as_deref())
            })
            .collect()
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
                    "interactive CUDA runtime plan mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }
        let base_step = self.total_steps;
        let base_time = self.total_time;
        let mut dt = crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            crate::types::TimestepExecutionLane::fdm_cuda(plan.precision),
        )?
        .initial_dt();
        let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
        let mut torque_confirmation = RelaxationTorqueConfirmation::default();
        let mut backend_completion: Option<fullmag_ir::StageCompletionIR> = None;
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut last_cached_preview_revision: Option<u64> = None;
        let cell_count = (self.original_grid[0] as usize)
            * (self.original_grid[1] as usize)
            * (self.original_grid[2] as usize);
        let mut cancelled = false;
        let mut paused = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let mut current_local_stats = self.backend.snapshot_step_stats(grid)?;
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;
        self.backend
            .apply_average_m_to_step_stats(&mut current_local_stats)?;
        let initial_display_state = (checkpoint.display_selection)();
        let mut pending_cached_preview_snapshots =
            self.begin_cached_preview_prefetch(&initial_display_state)?;

        while self.total_time - base_time < until_seconds {
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
                Some(self.backend.copy_live_preview_field(
                    &preview_cfg,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                )?)
            } else {
                None
            };
            let cached_preview_fields = if cached_display_due {
                match pending_cached_preview_snapshots.take() {
                    Some(snapshots) => Some(self.resolve_cached_preview_prefetch(snapshots)?),
                    None => {
                        let preview_cfg = display_state.preview_request();
                        let quantities = cached_preview_quantities_for(&display_state);
                        if quantities.is_empty() {
                            None
                        } else {
                            Some(self.snapshot_vector_fields(&quantities, &preview_cfg)?)
                        }
                    }
                }
            } else {
                None
            };
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: current_local_stats.clone(),
                grid,
                fem_mesh_generation_id: None,
                magnetization: None,
                preview_field,
                cached_preview_fields,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                terminal_field_snapshot: false,
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

            let dt_step = dt.min(until_seconds - (self.total_time - base_time));
            let Some(total_stats) = self
                .backend
                .step_interruptible(dt_step, interrupt_requested)?
            else {
                continue;
            };
            artifacts.observe_physics_execution();
            self.total_steps = total_stats.step;
            self.total_time = total_stats.time;
            if let Some(next) = total_stats.dt_suggested {
                dt = next;
            }
            let post_step_display_state = (checkpoint.display_selection)();
            // Only start async cached-preview GPU→CPU copies when the next
            // iteration will actually consume them.
            let next_cached_step = (total_stats.step - base_step) + 1;
            if cached_display_refresh_due(
                last_cached_preview_revision,
                &post_step_display_state,
                next_cached_step,
                field_every_n,
            ) {
                pending_cached_preview_snapshots =
                    self.begin_cached_preview_prefetch(&post_step_display_state)?;
            } else {
                pending_cached_preview_snapshots = None;
            }

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
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.backend.copy_live_preview_field(
                    &preview_cfg,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                )?)
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let scalar_output_due = scalar_schedules
                .iter()
                .any(|schedule| is_due(local_stats.time, schedule.next_time));
            if scalar_row_due || scalar_output_due {
                self.backend
                    .apply_average_m_to_step_stats(&mut local_stats)?;
                current_local_stats = local_stats.clone();
                latest_local_stats = Some(local_stats.clone());
            }
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: local_stats.clone(),
                grid,
                fem_mesh_generation_id: None,
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
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
            let stop_for_relaxation = if let Some(control) = plan.relaxation.as_ref() {
                if let Some(completion) = self.backend.stage_completion()? {
                    backend_completion = Some(completion);
                    true
                } else {
                    local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                        || torque_confirmation.observe_stats(
                            control,
                            &total_stats,
                            energy_plateau_range,
                            plan.gyromagnetic_ratio,
                            plan.material.damping,
                            pure_damping_relax,
                        )
                }
            } else {
                false
            };
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
        let completion = if let Some(mut completion) = backend_completion {
            completion.status = match status {
                RunStatus::Completed => "completed",
                RunStatus::Cancelled => "cancelled",
                RunStatus::Paused => "paused",
                RunStatus::Failed => "failed",
            }
            .to_string();
            completion
        } else {
            crate::relaxation::resolve_stage_completion(
                status,
                plan.relaxation.as_ref(),
                crate::relaxation::RelaxationCompletionMetrics {
                    max_torque_apm: Some(current_local_stats.max_torque_Apm),
                    torque_confirmed: torque_confirmation.confirmed(),
                    accepted_energy_plateau_range_j: energy_plateau.range(),
                    steps: current_local_stats.step,
                    relaxation_time_s: Some(current_local_stats.time),
                    numerical_stagnation: false,
                },
            )
        };

        Ok(RunResult {
            status,
            steps,
            final_magnetization: self.backend.copy_m(cell_count)?,
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
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        artifact_writer: Option<ArtifactPipelineSender>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        if !self.plan_signature.eq(&normalize_plan_signature(plan)) {
            return Err(RunError {
                message:
                    "interactive CUDA runtime plan mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }

        let cell_count = (self.original_grid[0] as usize)
            * (self.original_grid[1] as usize)
            * (self.original_grid[2] as usize);
        let initial_magnetization = self.backend.copy_m(cell_count)?;
        let mut artifacts = if let Some(writer) = artifact_writer {
            ArtifactRecorder::streaming(self.provenance.clone(), writer)
        } else {
            ArtifactRecorder::in_memory(self.provenance.clone())
        };
        let mut scalar_schedules = collect_scalar_schedules(outputs)?;
        let mut field_schedules = collect_field_schedules(outputs)?;
        let default_scalar_trace = scalar_schedules.is_empty();
        capture_initial_cuda_runtime_fields(
            &self.backend,
            cell_count,
            &mut field_schedules,
            &mut artifacts,
        )?;

        let base_step = self.total_steps;
        let base_time = self.total_time;
        let mut dt = crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            crate::types::TimestepExecutionLane::fdm_cuda(plan.precision),
        )?
        .initial_dt();
        let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
        let mut torque_confirmation = RelaxationTorqueConfirmation::default();
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut last_cached_preview_revision: Option<u64> = None;
        let mut cancelled = false;
        let mut paused = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let mut latest_local_stats: Option<StepStats> = None;
        let mut current_local_stats = self.backend.snapshot_step_stats(grid)?;
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;
        self.backend
            .apply_average_m_to_step_stats(&mut current_local_stats)?;
        let initial_display_state = (checkpoint.display_selection)();
        let mut pending_cached_preview_snapshots =
            self.begin_cached_preview_prefetch(&initial_display_state)?;

        while self.total_time - base_time < until_seconds {
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
                Some(self.backend.copy_live_preview_field(
                    &preview_cfg,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                )?)
            } else {
                None
            };
            let cached_preview_fields = if cached_display_due {
                match pending_cached_preview_snapshots.take() {
                    Some(snapshots) => Some(self.resolve_cached_preview_prefetch(snapshots)?),
                    None => {
                        let preview_cfg = display_state.preview_request();
                        let quantities = cached_preview_quantities_for(&display_state);
                        if quantities.is_empty() {
                            None
                        } else {
                            Some(self.snapshot_vector_fields(&quantities, &preview_cfg)?)
                        }
                    }
                }
            } else {
                None
            };
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: current_local_stats.clone(),
                grid,
                fem_mesh_generation_id: None,
                magnetization: None,
                preview_field,
                cached_preview_fields,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                terminal_field_snapshot: false,
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

            let dt_step = dt.min(until_seconds - (self.total_time - base_time));
            let Some(total_stats) = self
                .backend
                .step_interruptible(dt_step, interrupt_requested)?
            else {
                continue;
            };
            self.total_steps = total_stats.step;
            self.total_time = total_stats.time;
            if let Some(next) = total_stats.dt_suggested {
                dt = next;
            }
            let post_step_display_state = (checkpoint.display_selection)();
            // Only start async cached-preview GPU→CPU copies when the next
            // iteration will actually consume them.
            let next_cached_step = (total_stats.step - base_step) + 1;
            if cached_display_refresh_due(
                last_cached_preview_revision,
                &post_step_display_state,
                next_cached_step,
                field_every_n,
            ) {
                pending_cached_preview_snapshots =
                    self.begin_cached_preview_prefetch(&post_step_display_state)?;
            } else {
                pending_cached_preview_snapshots = None;
            }

            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            latest_local_stats = Some(local_stats.clone());
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
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.backend.copy_live_preview_field(
                    &preview_cfg,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                )?)
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let scalar_output_due = scalar_schedules
                .iter()
                .any(|schedule| is_due(local_stats.time, schedule.next_time));
            if scalar_row_due || scalar_output_due {
                self.backend
                    .apply_average_m_to_step_stats(&mut local_stats)?;
                current_local_stats = local_stats.clone();
                latest_local_stats = Some(local_stats.clone());
            }
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: local_stats.clone(),
                grid,
                fem_mesh_generation_id: None,
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                scalar_row_due,
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

            record_due_cuda_runtime_outputs(
                &self.backend,
                cell_count,
                &local_stats,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
            )?;

            let energy_plateau_range = energy_plateau.record(total_stats.e_total);
            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                    || torque_confirmation.observe_stats(
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

        record_final_cuda_runtime_outputs(
            &self.backend,
            cell_count,
            latest_local_stats,
            default_scalar_trace,
            &scalar_schedules,
            &field_schedules,
            &mut steps,
            &mut artifacts,
        )?;

        let final_magnetization = self.backend.copy_m(cell_count)?;
        let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
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
                torque_confirmed: torque_confirmation.confirmed(),
                accepted_energy_plateau_range_j: energy_plateau.range(),
                steps: current_local_stats.step,
                relaxation_time_s: Some(current_local_stats.time),
                numerical_stagnation: false,
            },
        );
        Ok(ExecutedRun {
            result: RunResult {
                status,
                steps,
                final_magnetization,
                completion: Some(completion),
            },
            initial_magnetization,
            field_snapshots,
            field_snapshot_count,
            auxiliary_artifacts: vec![],
            provenance,
        })
    }
}
