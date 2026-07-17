use super::super::artifacts::fem_native::*;
use super::super::*;

#[cfg(feature = "fem-gpu")]
impl GpuInteractiveFemPreviewRuntime {
    pub(crate) fn upload_magnetization(
        &mut self,
        magnetization: &[[f64; 3]],
    ) -> Result<(), RunError> {
        self.backend.upload_magnetization(magnetization)?;
        let _ = self.backend.snapshot_step_stats(self.node_count)?;
        Ok(())
    }

    pub(crate) fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        let requested = [request.quantity.as_str()];
        if active_fem_preview_quantities(FemEngine::NativeGpu, &self.plan_signature, &requested)
            .is_empty()
        {
            return Err(RunError {
                message: format!(
                    "preview quantity '{}' is not active for the current FEM problem",
                    request.quantity
                ),
            });
        }
        if normalized_quantity_name(&request.quantity).ok() == Some("H_ant") {
            return Ok(build_mesh_preview_field_with_active_mask(
                request,
                &self.antenna_field,
                None,
            ));
        }
        self.backend
            .copy_live_preview_field(request, self.node_count)
    }

    pub(crate) fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        let quantities =
            active_fem_preview_quantities(FemEngine::NativeGpu, &self.plan_signature, quantities);
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
            if quantity == "H_ant" {
                cached.push(build_mesh_preview_field_with_active_mask(
                    &preview_request,
                    &self.antenna_field,
                    None,
                ));
            } else {
                cached.push(
                    self.backend
                        .copy_live_preview_field(&preview_request, self.node_count)?,
                );
            }
        }

        Ok(cached)
    }

    pub(crate) fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        self.backend.snapshot_step_stats(self.node_count)
    }

    pub(crate) fn execute_with_live_preview(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<RunResult, RunError> {
        if !self.plan_signature.eq(&normalize_fem_plan_signature(plan)) {
            return Err(RunError {
                message:
                    "interactive FEM GPU runtime plan mismatch; caller must rebuild runtime before executing"
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
            crate::types::TimestepExecutionLane::fem_gpu(plan.precision),
        )?
        .initial_dt();
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
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let mut current_local_stats = self.backend.snapshot_step_stats(self.node_count)?;
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;

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
                Some(self.snapshot_preview(&preview_cfg)?)
            } else {
                None
            };
            let cached_preview_fields = if cached_display_due {
                let preview_cfg = display_state.preview_request();
                let quantities = crate::quantities::field_materialization_quantity_ids();
                if quantities.is_empty() {
                    None
                } else {
                    Some(self.snapshot_vector_fields(&quantities, &preview_cfg)?)
                }
            } else {
                None
            };
            let action = on_step(StepUpdate {
                stats: current_local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh: (current_local_stats.step == 0).then_some(self.mesh.clone()),
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
                Some(self.snapshot_preview(&preview_cfg)?)
            } else {
                None
            };
            let cached_preview_fields = if cached_display_due {
                let preview_cfg = display_state.preview_request();
                let quantities = crate::quantities::field_materialization_quantity_ids();
                if quantities.is_empty() {
                    None
                } else {
                    Some(self.snapshot_vector_fields(&quantities, &preview_cfg)?)
                }
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh: (local_stats.step <= 1).then_some(self.mesh.clone()),
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
                max_torque_apm: None,
                accepted_energy_plateau_range_j: energy_plateau.range(),
                steps: current_local_stats.step,
                relaxation_time_s: Some(current_local_stats.time),
                numerical_stagnation: false,
            },
        );

        Ok(RunResult {
            status,
            steps,
            final_magnetization: self.backend.copy_m(self.node_count)?,
            completion: Some(completion),
        })
    }

    pub(crate) fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        field_every_n: u64,
        artifact_writer: Option<ArtifactPipelineSender>,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        if !self.plan_signature.eq(&normalize_fem_plan_signature(plan)) {
            return Err(RunError {
                message:
                    "interactive FEM GPU runtime plan mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }

        let initial_magnetization = self.backend.copy_m(self.node_count)?;
        let mut artifacts = if let Some(writer) = artifact_writer {
            ArtifactRecorder::streaming(self.provenance.clone(), writer)
        } else {
            ArtifactRecorder::in_memory(self.provenance.clone())
        };
        let mut scalar_schedules = collect_scalar_schedules(outputs)?;
        let mut field_schedules = collect_field_schedules(outputs)?;
        let default_scalar_trace = scalar_schedules.is_empty();
        capture_initial_native_fem_runtime_fields(
            &self.backend,
            self.node_count,
            &mut field_schedules,
            &mut artifacts,
        )?;

        let base_step = self.total_steps;
        let base_time = self.total_time;
        let mut dt = crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            crate::types::TimestepExecutionLane::fem_gpu(plan.precision),
        )?
        .initial_dt();
        let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut cancelled = false;
        let mut paused = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let mut latest_local_stats: Option<StepStats> = None;
        let mut current_local_stats = self.backend.snapshot_step_stats(self.node_count)?;
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;

        while self.total_time - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.snapshot_preview(&preview_cfg)?)
            } else {
                None
            };
            let action = on_step(StepUpdate {
                stats: current_local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh: (current_local_stats.step == 0).then_some(self.mesh.clone()),
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
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.snapshot_preview(&preview_cfg)?)
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
                stats: local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh: (local_stats.step <= 1).then_some(self.mesh.clone()),
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

            record_due_native_fem_runtime_outputs(
                &self.backend,
                self.node_count,
                &local_stats,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
            )?;

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

        record_final_native_fem_runtime_outputs(
            &self.backend,
            self.node_count,
            latest_local_stats,
            default_scalar_trace,
            &scalar_schedules,
            &field_schedules,
            &mut steps,
            &mut artifacts,
        )?;

        let final_magnetization = self.backend.copy_m(self.node_count)?;
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
                max_torque_apm: None,
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
