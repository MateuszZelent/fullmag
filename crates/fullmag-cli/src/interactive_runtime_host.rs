use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use fullmag_ir::{BackendPlanIR, ExecutionPlanIR, FemDomainMeshModeIR};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::control_room::*;
use crate::live_workspace::*;

use super::*;

#[derive(Debug, Default)]
struct CurrentLiveControlState {
    display_selection: CurrentDisplaySelection,
    queue: VecDeque<SessionCommand>,
}

#[derive(Debug, Deserialize)]
struct ApiStatusDisplaySelection {
    active_quantity_id: String,
    view_mode: String,
    field_component: String,
    auto_contrast: bool,
    slice_mode: String,
    slice_layer: i32,
    vector_density: u32,
    max_points: u32,
    x_chosen_size: u32,
    y_chosen_size: u32,
}

#[derive(Debug, Deserialize)]
struct ApiStatusResources {
    display_revision: u64,
}

#[derive(Debug, Deserialize)]
struct ApiStatusSnapshot {
    display: ApiStatusDisplaySelection,
    resources: ApiStatusResources,
}

pub(super) struct CurrentLiveDisplaySelectionHandle {
    shared: Arc<(Mutex<CurrentLiveControlState>, Condvar)>,
    stop: Arc<AtomicBool>,
    running_interrupt: Arc<Mutex<Option<InteractiveStageInterrupt>>>,
    running_interrupt_requested: Arc<AtomicBool>,
    worker_owner: bool,
}

impl Clone for CurrentLiveDisplaySelectionHandle {
    fn clone(&self) -> Self {
        Self {
            shared: Arc::clone(&self.shared),
            stop: Arc::clone(&self.stop),
            running_interrupt: Arc::clone(&self.running_interrupt),
            running_interrupt_requested: Arc::clone(&self.running_interrupt_requested),
            worker_owner: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum InteractiveStageInterrupt {
    Pause,
    Break,
    Close,
    /// Skip the current stage in a sequence and advance to the next.
    Skip,
}

impl CurrentLiveDisplaySelectionHandle {
    pub(super) fn spawn() -> Self {
        let initial_display_selection = current_live_display_selection().unwrap_or_default();
        let handle = Self {
            shared: Arc::new((
                Mutex::new(CurrentLiveControlState {
                    display_selection: initial_display_selection,
                    queue: VecDeque::new(),
                }),
                Condvar::new(),
            )),
            stop: Arc::new(AtomicBool::new(false)),
            running_interrupt: Arc::new(Mutex::new(None)),
            running_interrupt_requested: Arc::new(AtomicBool::new(false)),
            worker_owner: true,
        };
        let worker = handle.clone();
        std::thread::spawn(move || {
            let mut after_seq = 0u64;
            while !worker.stop.load(Ordering::Relaxed) {
                match wait_for_current_live_control(after_seq, 1_000) {
                    Ok(Some(command)) => {
                        after_seq = after_seq.max(command.seq);
                        eprintln!(
                            "[fullmag-host] RX <- api command {} seq={} id={}",
                            command.kind, command.seq, command.command_id
                        );
                        // Parse into typed command to determine control classification
                        let typed = crate::command_bridge::classify_command(&command);
                        if let Some(ref typed_cmd) = typed {
                            let requests_interrupt =
                                crate::command_bridge::is_interrupt_command(typed_cmd);
                            worker
                                .running_interrupt_requested
                                .store(requests_interrupt, Ordering::Relaxed);
                        }
                        let (lock, cvar) = &*worker.shared;
                        let mut state = lock.lock().unwrap_or_else(|poison| poison.into_inner());
                        state.queue.push_back(command);
                        cvar.notify_all();
                    }
                    Ok(None) => sync_display_selection_from_status(&worker.shared),
                    Err(_) => std::thread::sleep(Duration::from_millis(100)),
                }
            }
            let (_, cvar) = &*worker.shared;
            cvar.notify_all();
        });
        handle
    }

    pub(super) fn display_selection_snapshot(&self) -> CurrentDisplaySelection {
        let (lock, _) = &*self.shared;
        lock.lock()
            .map(|state| state.display_selection.clone())
            .unwrap_or_default()
    }

    pub(super) fn preview_request(&self) -> fullmag_runner::LivePreviewRequest {
        self.display_selection_snapshot().preview_request()
    }

    pub(super) fn apply_display_sync_command(&self, command: &SessionCommand) {
        let (lock, _) = &*self.shared;
        if let Ok(mut state) = lock.lock() {
            apply_display_sync_to_state(&mut state, command);
        }
    }

    fn pop_front_matching(
        &self,
        predicate: impl Fn(&SessionCommand) -> bool,
    ) -> Option<SessionCommand> {
        let (lock, _) = &*self.shared;
        let mut state = lock.lock().ok()?;
        let index = state.queue.iter().position(predicate)?;
        state.queue.remove(index)
    }

    pub(super) fn wait_next_command(&self, timeout: Duration) -> Option<SessionCommand> {
        let (lock, cvar) = &*self.shared;
        let mut state = lock.lock().unwrap_or_else(|poison| poison.into_inner());
        if state.queue.is_empty() {
            let waited = cvar.wait_timeout(state, timeout).ok()?;
            state = waited.0;
        }
        state.queue.pop_front()
    }

    /// Drain all consecutive display-sync commands, apply each to
    /// the internal display selection state, and return only the **last** one.
    /// Non-display commands are returned immediately without draining.
    /// This prevents redundant refresh work when several display revisions are
    /// observed in quick succession.
    pub(super) fn wait_next_command_coalesced(&self, timeout: Duration) -> Option<SessionCommand> {
        let cmd = self.wait_next_command(timeout)?;
        if !is_display_sync_kind(&cmd.kind) {
            return Some(cmd);
        }
        apply_display_sync_to_state_external(&self.shared, &cmd);
        let mut latest = cmd;
        let mut coalesced_count = 0u32;
        // Drain any additional display-sync commands already queued.
        loop {
            let (lock, _) = &*self.shared;
            let mut state = match lock.lock() {
                Ok(s) => s,
                Err(_) => break,
            };
            let sync_idx = state
                .queue
                .iter()
                .position(|c| is_display_sync_kind(&c.kind));
            match sync_idx {
                Some(idx) => {
                    let next = state.queue.remove(idx).unwrap();
                    apply_display_sync_to_state(&mut state, &next);
                    drop(state);
                    latest = next;
                    coalesced_count += 1;
                }
                None => break,
            }
        }
        if coalesced_count > 0 {
            eprintln!(
                "[fullmag-host] coalesced {} redundant display syncs (keeping seq={})",
                coalesced_count, latest.seq
            );
        }
        Some(latest)
    }

    /// Push a synthetic command to the front of the queue (used by sequence runner).
    pub(super) fn push_command_front(&self, command: SessionCommand) {
        let (lock, cvar) = &*self.shared;
        let mut state = lock.lock().unwrap_or_else(|poison| poison.into_inner());
        state.queue.push_front(command);
        cvar.notify_one();
    }

    /// Apply an initial visualization quantity hint from script `runtime_metadata`.
    ///
    /// Pushes a synthetic display-sync command before the solver loop starts, so
    /// the control room opens with the requested quantity already selected.
    pub(super) fn set_quantity_hint(&self, quantity: &str, every_n: Option<u32>) {
        let mut selection = CurrentDisplaySelection::default();
        selection.selection.quantity = quantity.to_string();
        if let Some(every_n) = every_n {
            selection.selection.every_n = every_n;
        }
        selection.selection.canonicalize();
        let command = synthetic_display_sync_command(selection);
        self.push_command_front(command);
    }

    pub(super) fn take_solver_profile_command(&self) -> Option<SessionCommand> {
        self.pop_front_matching(|command| command.kind == "set_solver_profile")
    }

    fn set_running_interrupt(&self, interrupt: InteractiveStageInterrupt) {
        if let Ok(mut slot) = self.running_interrupt.lock() {
            *slot = Some(interrupt);
        }
    }

    pub(super) fn clear_running_interrupt(&self) {
        if let Ok(mut slot) = self.running_interrupt.lock() {
            *slot = None;
        }
        self.running_interrupt_requested
            .store(false, Ordering::Relaxed);
    }

    pub(super) fn take_running_interrupt(&self) -> Option<InteractiveStageInterrupt> {
        self.running_interrupt
            .lock()
            .ok()
            .and_then(|mut slot| slot.take())
    }

    pub(super) fn running_interrupt_signal(&self) -> Arc<AtomicBool> {
        self.running_interrupt_requested.clone()
    }

    pub(super) fn process_running_control(&self) -> Option<fullmag_runner::StepAction> {
        self.running_interrupt_requested
            .store(false, Ordering::Relaxed);
        loop {
            // Pop any command that parses as a LiveControlCommand
            let Some(command) = self.pop_front_matching(|command| {
                crate::command_bridge::classify_command(command).is_some()
            }) else {
                return None;
            };

            let typed = crate::command_bridge::classify_command(&command);

            match typed {
                Some(fullmag_runner::LiveControlCommand::SetDisplaySelection(_)) => {
                    self.apply_display_sync_command(&command);
                }
                Some(fullmag_runner::LiveControlCommand::Pause) => {
                    self.set_running_interrupt(InteractiveStageInterrupt::Pause);
                    eprintln!(
                        "interactive: received '{}' command — pausing stage",
                        command.kind
                    );
                    return Some(fullmag_runner::StepAction::Pause);
                }
                Some(fullmag_runner::LiveControlCommand::Break) => {
                    self.set_running_interrupt(InteractiveStageInterrupt::Break);
                    eprintln!(
                        "interactive: received '{}' command — cancelling stage",
                        command.kind
                    );
                    return Some(fullmag_runner::StepAction::Stop);
                }
                Some(fullmag_runner::LiveControlCommand::Close) => {
                    self.set_running_interrupt(InteractiveStageInterrupt::Close);
                    eprintln!(
                        "interactive: received '{}' command — cancelling stage",
                        command.kind
                    );
                    return Some(fullmag_runner::StepAction::Stop);
                }
                Some(fullmag_runner::LiveControlCommand::SkipStage) => {
                    self.set_running_interrupt(InteractiveStageInterrupt::Skip);
                    eprintln!("interactive: received 'skip' command — skipping current stage",);
                    return Some(fullmag_runner::StepAction::Stop);
                }
                // Run/Relax/Resume are not handled during running — they go to orchestrator
                _ => {}
            }
        }
    }
}

fn is_display_sync_kind(kind: &str) -> bool {
    kind == "display_sync"
}

fn apply_display_sync_to_state(state: &mut CurrentLiveControlState, command: &SessionCommand) {
    let typed = crate::command_bridge::classify_command(command);
    match typed {
        Some(fullmag_runner::LiveControlCommand::SetDisplaySelection(_)) => {
            let resolved = command.display_selection.clone().or_else(|| {
                command
                    .preview_config
                    .as_ref()
                    .map(CurrentDisplaySelection::from_preview_request)
            });
            if let Some(display_selection) = resolved {
                state.display_selection = display_selection;
            }
        }
        _ => {}
    }
}

fn apply_display_sync_to_state_external(
    shared: &Arc<(Mutex<CurrentLiveControlState>, Condvar)>,
    command: &SessionCommand,
) {
    let (lock, _) = &**shared;
    if let Ok(mut state) = lock.lock() {
        apply_display_sync_to_state(&mut state, command);
    }
}

fn synthetic_display_sync_command(selection: CurrentDisplaySelection) -> SessionCommand {
    let created_at_unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);

    SessionCommand {
        seq: selection.revision,
        command_id: format!("display-sync-{}", selection.revision),
        kind: "display_sync".to_string(),
        created_at_unix_ms,
        target: None,
        reason: None,
        precondition: None,
        client_intent_id: None,
        requested_at_unix_ms: None,
        until_seconds: None,
        max_steps: None,
        torque_tolerance: None,
        energy_tolerance: None,
        integrator: None,
        fixed_timestep: None,
        max_error: None,
        solver_policy: None,
        relax_algorithm: None,
        relax_alpha: None,
        mesh_options: None,
        mesh_target: None,
        mesh_reason: None,
        state_path: None,
        state_format: None,
        state_dataset: None,
        state_sample_index: None,
        display_selection: Some(selection.clone()),
        preview_config: Some(selection.preview_request()),
        stages: None,
        profile: None,
    }
}

fn sync_display_selection_from_status(shared: &Arc<(Mutex<CurrentLiveControlState>, Condvar)>) {
    let Ok(next_selection) = current_live_display_selection() else {
        return;
    };

    let (lock, cvar) = &**shared;
    if let Ok(mut state) = lock.lock() {
        if state.display_selection.revision == next_selection.revision {
            return;
        }
        state.display_selection = next_selection.clone();
        state
            .queue
            .retain(|command| !is_display_sync_kind(&command.kind));
        state
            .queue
            .push_back(synthetic_display_sync_command(next_selection));
        cvar.notify_all();
    }
}

impl Drop for CurrentLiveDisplaySelectionHandle {
    fn drop(&mut self) {
        if !self.worker_owner {
            return;
        }
        self.stop.store(true, Ordering::Relaxed);
        let (_, cvar) = &*self.shared;
        cvar.notify_all();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InteractivePreviewStatus {
    Running,
    AwaitingCommand,
    Paused,
    Closed,
}

#[derive(Debug, Clone)]
struct InteractivePreviewSourceState {
    status: InteractivePreviewStatus,
    continuation_magnetization: Option<Vec<[f64; 3]>>,
    generation: u64,
}

pub(super) struct InteractiveRuntimeHost {
    control: CurrentLiveDisplaySelectionHandle,
    preview_source: Arc<Mutex<InteractivePreviewSourceState>>,
    runtime: Option<fullmag_runner::InteractiveRuntime>,
    base_problem: ProblemIR,
    runtime_capable: bool,
    dynamic_idle_preview_supported: bool,
    multilayer_idle_snapshot: bool,
}

impl InteractiveRuntimeHost {
    pub(super) fn new(
        control: CurrentLiveDisplaySelectionHandle,
        base_problem: ProblemIR,
        backend_plan: &BackendPlanIR,
    ) -> Self {
        let dynamic_idle_preview_supported =
            supports_dynamic_idle_preview(&base_problem, backend_plan);
        let multilayer_idle_snapshot = matches!(backend_plan, BackendPlanIR::FdmMultilayer(_));
        Self {
            control,
            preview_source: Arc::new(Mutex::new(InteractivePreviewSourceState {
                status: InteractivePreviewStatus::Closed,
                continuation_magnetization: None,
                generation: 0,
            })),
            runtime: None,
            base_problem,
            runtime_capable: supports_idle_interactive_runtime(backend_plan),
            dynamic_idle_preview_supported,
            multilayer_idle_snapshot,
        }
    }

    pub(super) fn control(&self) -> CurrentLiveDisplaySelectionHandle {
        self.control.clone()
    }

    pub(super) fn wait_next_command_coalesced(&self, timeout: Duration) -> Option<SessionCommand> {
        self.control.wait_next_command_coalesced(timeout)
    }

    /// Push a synthetic command to the front of the internal queue.
    pub(super) fn push_command_front(&self, command: SessionCommand) {
        self.control.push_command_front(command);
    }

    pub(super) fn mark_running(&self) {
        if let Ok(mut preview_state) = self.preview_source.lock() {
            preview_state.status = InteractivePreviewStatus::Running;
            preview_state.generation = preview_state.generation.saturating_add(1);
        }
        self.control.clear_running_interrupt();
    }

    pub(super) fn mark_closed(&self) {
        if let Ok(mut preview_state) = self.preview_source.lock() {
            preview_state.status = InteractivePreviewStatus::Closed;
        }
        self.control.clear_running_interrupt();
    }

    pub(super) fn enter_awaiting_command(
        &mut self,
        continuation_magnetization: Option<Vec<[f64; 3]>>,
        live_workspace: &LocalLiveWorkspace,
    ) {
        let awaiting_generation = if let Ok(mut preview_state) = self.preview_source.lock() {
            preview_state.status = InteractivePreviewStatus::AwaitingCommand;
            preview_state.continuation_magnetization = continuation_magnetization.clone();
            preview_state.generation = preview_state.generation.saturating_add(1);
            preview_state.generation
        } else {
            0
        };

        let continuation_slice = continuation_magnetization.as_deref();
        self.ensure_base_runtime_ready(continuation_slice, live_workspace);

        if self.dynamic_idle_preview_supported && !self.multilayer_idle_snapshot {
            let preview_request = self.control.preview_request();
            spawn_interactive_preview_cache_refresh(
                self.base_problem.clone(),
                Arc::clone(&self.preview_source),
                live_workspace.clone(),
                preview_request,
                awaiting_generation,
            );
        }

        self.refresh_idle_preview(continuation_slice, live_workspace);
    }

    pub(super) fn enter_paused(
        &mut self,
        continuation_magnetization: Option<Vec<[f64; 3]>>,
        live_workspace: &LocalLiveWorkspace,
    ) {
        let paused_generation = if let Ok(mut preview_state) = self.preview_source.lock() {
            preview_state.status = InteractivePreviewStatus::Paused;
            preview_state.continuation_magnetization = continuation_magnetization.clone();
            preview_state.generation = preview_state.generation.saturating_add(1);
            preview_state.generation
        } else {
            0
        };

        if self.dynamic_idle_preview_supported {
            if self.multilayer_idle_snapshot {
                if let Err(error) = self.refresh_multilayer_idle_preview(
                    continuation_magnetization.as_deref(),
                    live_workspace,
                ) {
                    live_workspace.push_log(
                        "warn",
                        format!("Idle multilayer preview refresh warning: {error}"),
                    );
                }
            } else {
                let preview_request = self.control.preview_request();
                spawn_interactive_preview_cache_refresh(
                    self.base_problem.clone(),
                    Arc::clone(&self.preview_source),
                    live_workspace.clone(),
                    preview_request,
                    paused_generation,
                );
            }
        }
    }

    pub(super) fn replace_base_problem(&mut self, base_problem: ProblemIR) {
        self.base_problem = base_problem;
        self.runtime = None;
    }

    pub(super) fn handle_display_sync(
        &mut self,
        command: &SessionCommand,
        live_workspace: &LocalLiveWorkspace,
    ) -> bool {
        if !is_display_sync_kind(command.kind.as_str()) {
            return false;
        }

        self.control.apply_display_sync_command(command);
        let continuation_magnetization = self.continuation_magnetization();
        let current_generation = self
            .preview_source
            .lock()
            .map(|state| state.generation)
            .unwrap_or(0);

        if self.dynamic_idle_preview_supported && !self.multilayer_idle_snapshot {
            let preview_request = self.control.preview_request();
            spawn_interactive_preview_cache_refresh(
                self.base_problem.clone(),
                Arc::clone(&self.preview_source),
                live_workspace.clone(),
                preview_request,
                current_generation,
            );
        }

        self.refresh_idle_preview(continuation_magnetization.as_deref(), live_workspace);
        true
    }

    pub(super) fn compute_current_fields(
        &mut self,
        continuation_magnetization: Option<&[[f64; 3]]>,
        live_workspace: &LocalLiveWorkspace,
    ) -> Result<()> {
        let display_selection = self.control.display_selection_snapshot();
        let preview_request = display_selection.preview_request();
        let materialization_request = full_field_materialization_request(preview_request.clone());
        self.ensure_base_runtime_ready(continuation_magnetization, live_workspace);

        if let Some(runtime) = self.runtime.as_mut() {
            refresh_interactive_preview_runtime_display(
                runtime,
                &display_selection,
                live_workspace,
            )?;
            let quantities = fullmag_runner::quantities::field_materialization_quantity_ids();
            let cached_fields =
                runtime.snapshot_vector_fields(&quantities, &materialization_request)?;
            live_workspace.update(|state| {
                replace_cached_preview_fields(state, cached_fields.clone());
            });
            return Ok(());
        }

        let (preview_field, cached_fields, auxiliary_artifacts) =
            snapshot_interactive_preview_payload(
                &self.base_problem,
                continuation_magnetization,
                &preview_request,
            )?;
        live_workspace.replace_auxiliary_artifacts(&auxiliary_artifacts)?;
        live_workspace.update(|state| {
            state.live_state.updated_at_unix_ms = unix_time_millis().unwrap_or(0);
            state.live_state.latest_step.preview_field = Some(preview_field.clone());
            replace_cached_preview_fields(state, cached_fields.clone());
        });
        Ok(())
    }

    pub(super) fn compute_current_energies(
        &mut self,
        continuation_magnetization: Option<&[[f64; 3]]>,
        live_workspace: &LocalLiveWorkspace,
    ) -> Result<()> {
        self.ensure_base_runtime_ready(continuation_magnetization, live_workspace);

        if let Some(runtime) = self.runtime.as_mut() {
            let step_stats = runtime.snapshot_step_stats()?;
            live_workspace.update(|state| {
                apply_step_stats_to_idle_live_state(state, &step_stats);
            });
        }

        Ok(())
    }

    pub(super) fn ensure_runtime_for_problem(
        &mut self,
        problem: &ProblemIR,
        plan: &ExecutionPlanIR,
        stage_fem_mesh_asset: Option<&fullmag_runner::StageFemMeshAsset>,
        field_every_n: u64,
        continuation_magnetization: Option<&[[f64; 3]]>,
        live_workspace: &LocalLiveWorkspace,
    ) -> Result<()> {
        if !self.runtime_capable {
            return Ok(());
        }
        ensure_interactive_preview_runtime(
            &mut self.runtime,
            problem,
            plan,
            stage_fem_mesh_asset,
            field_every_n,
            continuation_magnetization,
        )?;
        if let Some(runtime) = self.runtime.as_mut() {
            runtime.set_solver_profile_config(&live_workspace.solver_profile_config())?;
        }
        self.publish_runtime_engine_metadata(live_workspace);
        Ok(())
    }

    pub(super) fn runtime_mut(&mut self) -> Option<&mut fullmag_runner::InteractiveRuntime> {
        self.runtime.as_mut()
    }

    pub(super) fn take_running_interrupt(&self) -> Option<InteractiveStageInterrupt> {
        self.control.take_running_interrupt()
    }

    pub(super) fn load_state(
        &mut self,
        magnetization: Vec<[f64; 3]>,
        live_workspace: &LocalLiveWorkspace,
    ) -> Result<()> {
        let generation = if let Ok(mut preview_state) = self.preview_source.lock() {
            preview_state.status = InteractivePreviewStatus::AwaitingCommand;
            preview_state.continuation_magnetization = Some(magnetization.clone());
            preview_state.generation = preview_state.generation.saturating_add(1);
            preview_state.generation
        } else {
            0
        };

        self.ensure_base_runtime_ready(Some(&magnetization), live_workspace);
        if let Some(runtime) = self.runtime.as_mut() {
            runtime
                .upload_magnetization(&magnetization)
                .map_err(|error| anyhow!(error.to_string()))?;
        }

        live_workspace.update(|state| {
            state.live_state.updated_at_unix_ms = unix_time_millis().unwrap_or(0);
            state.live_state.latest_step.magnetization =
                Some(flatten_magnetization(&magnetization));
            clear_cached_preview_fields(state);
        });

        if self.dynamic_idle_preview_supported && !self.multilayer_idle_snapshot {
            let preview_request = self.control.preview_request();
            spawn_interactive_preview_cache_refresh(
                self.base_problem.clone(),
                Arc::clone(&self.preview_source),
                live_workspace.clone(),
                preview_request,
                generation,
            );
        }

        self.refresh_idle_preview(Some(&magnetization), live_workspace);
        Ok(())
    }

    fn continuation_magnetization(&self) -> Option<Vec<[f64; 3]>> {
        self.preview_source
            .lock()
            .map(|state| state.continuation_magnetization.clone())
            .unwrap_or(None)
    }

    fn ensure_base_runtime_ready(
        &mut self,
        continuation_magnetization: Option<&[[f64; 3]]>,
        live_workspace: &LocalLiveWorkspace,
    ) {
        if !self.runtime_capable {
            return;
        }

        if self.runtime.is_none() {
            match create_interactive_preview_runtime_from_problem(
                &self.base_problem,
                continuation_magnetization,
            ) {
                Ok(runtime) => {
                    self.runtime = Some(runtime);
                    self.publish_runtime_engine_metadata(live_workspace);
                }
                Err(error) => {
                    eprintln!("interactive preview runtime warning: {}", error);
                    live_workspace.push_log(
                        "warn",
                        format!("Idle live preview runtime unavailable: {}", error),
                    );
                    return;
                }
            }
        } else if let (Some(runtime), Some(magnetization)) =
            (self.runtime.as_mut(), continuation_magnetization)
        {
            if let Err(error) = runtime.upload_magnetization(magnetization) {
                eprintln!("interactive preview runtime warning: {}", error);
                live_workspace.push_log(
                    "warn",
                    format!("Idle live preview runtime resync failed: {}", error),
                );
                self.runtime = None;
            } else {
                self.publish_runtime_engine_metadata(live_workspace);
            }
        }
    }

    fn publish_runtime_engine_metadata(&self, live_workspace: &LocalLiveWorkspace) {
        let Some(runtime) = self.runtime.as_ref() else {
            return;
        };
        let runtime_engine =
            runtime_engine_metadata_from_provenance(&runtime.execution_provenance());
        live_workspace.update(|state| {
            upsert_runtime_engine_metadata(&mut state.metadata, runtime_engine.clone());
        });
    }

    fn refresh_idle_preview(
        &mut self,
        continuation_magnetization: Option<&[[f64; 3]]>,
        live_workspace: &LocalLiveWorkspace,
    ) {
        if let Some(runtime) = self.runtime.as_mut() {
            let display_selection = self.control.display_selection_snapshot();
            if let Err(error) = refresh_interactive_preview_runtime_display(
                runtime,
                &display_selection,
                live_workspace,
            ) {
                eprintln!("interactive preview runtime warning: {}", error);
                live_workspace.push_log(
                    "warn",
                    format!("Idle live preview snapshot failed: {}", error),
                );
                self.runtime = None;
            } else {
                return;
            }
        }

        if self.dynamic_idle_preview_supported {
            if self.multilayer_idle_snapshot {
                if let Err(error) =
                    self.refresh_multilayer_idle_preview(continuation_magnetization, live_workspace)
                {
                    eprintln!("multilayer idle preview refresh warning: {error}");
                    live_workspace.push_log(
                        "warn",
                        format!("Idle multilayer preview refresh warning: {error}"),
                    );
                }
                return;
            }
            let preview_request = self.control.preview_request();
            if let Err(error) = refresh_interactive_preview_snapshot(
                &self.base_problem,
                continuation_magnetization,
                &preview_request,
                live_workspace,
            ) {
                eprintln!("interactive preview refresh warning: {}", error);
                live_workspace.push_log(
                    "warn",
                    format!("Idle live preview refresh warning: {}", error),
                );
            }
        }
    }

    fn refresh_multilayer_idle_preview(
        &self,
        continuation_magnetization: Option<&[[f64; 3]]>,
        live_workspace: &LocalLiveWorkspace,
    ) -> Result<()> {
        let request = self.control.preview_request();
        let mut problem = self.base_problem.clone();
        if let Some(previous_final_magnetization) = continuation_magnetization {
            apply_continuation_initial_state(&mut problem, previous_final_magnetization)?;
        }
        let quantities = fullmag_runner::quantities::field_materialization_quantity_ids();
        let materialization_request = full_field_materialization_request(request.clone());
        let batch = fullmag_runner::snapshot_problem_vector_field_batch(
            &problem,
            &quantities,
            &materialization_request,
        )?;
        live_workspace.replace_auxiliary_artifacts(&batch.auxiliary_artifacts)?;
        let cached_fields = batch.fields;
        let requested_quantity =
            fullmag_runner::quantities::normalize_quantity_id(&request.quantity)
                .map_err(|error| anyhow!(error.to_string()))?
                .as_str();
        let preview_field = cached_fields
            .iter()
            .find(|field| field.quantity == requested_quantity)
            .cloned()
            .ok_or_else(|| {
                anyhow!(
                    "multilayer preview quantity '{}' is unavailable for the current plan",
                    request.quantity
                )
            })?;
        live_workspace.update(|state| {
            state.live_state.updated_at_unix_ms = unix_time_millis().unwrap_or(0);
            state.live_state.latest_step.preview_field = Some(preview_field.clone());
            replace_cached_preview_fields(state, cached_fields.clone());
        });
        Ok(())
    }
}

fn supports_idle_interactive_runtime(backend_plan: &BackendPlanIR) -> bool {
    match backend_plan {
        BackendPlanIR::Fdm(_) => true,
        BackendPlanIR::Fem(fem) => {
            fem.domain_mesh_mode != FemDomainMeshModeIR::SharedDomainMeshWithAir
        }
        _ => false,
    }
}

fn supports_dynamic_idle_preview(problem: &ProblemIR, backend_plan: &BackendPlanIR) -> bool {
    match backend_plan {
        BackendPlanIR::Fem(fem) => {
            fem.domain_mesh_mode != FemDomainMeshModeIR::SharedDomainMeshWithAir
        }
        // Multilayer does not yet have a persistent InteractiveRuntime backend,
        // but its CPU reference snapshot path is safe for idle display-sync and
        // explicit compute_fields. Keep this separate from the running-stage
        // live-preview capability, which must not select an unsupported runtime.
        BackendPlanIR::FdmMultilayer(_) => fullmag_runner::resolve_runtime_engine(problem)
            .map(|runtime| runtime.accelerator == "cpu")
            .unwrap_or(false),
        _ => supports_dynamic_live_preview(backend_plan),
    }
}

fn refresh_interactive_preview_snapshot(
    base_problem: &ProblemIR,
    continuation_magnetization: Option<&[[f64; 3]]>,
    request: &fullmag_runner::LivePreviewRequest,
    live_workspace: &LocalLiveWorkspace,
) -> Result<()> {
    let mut problem = base_problem.clone();
    if let Some(previous_final_magnetization) = continuation_magnetization {
        apply_continuation_initial_state(&mut problem, previous_final_magnetization)?;
    }
    let preview_field = fullmag_runner::snapshot_problem_preview(&problem, request)?;
    live_workspace.update(|state| {
        state.live_state.updated_at_unix_ms = unix_time_millis().unwrap_or(0);
        state.live_state.latest_step.preview_field = Some(preview_field.clone());
        upsert_cached_preview_field(state, &preview_field);
    });
    Ok(())
}

fn create_interactive_preview_runtime(
    base_problem: &ProblemIR,
    plan: &ExecutionPlanIR,
    stage_fem_mesh_asset: Option<&fullmag_runner::StageFemMeshAsset>,
    field_every_n: u64,
    continuation_magnetization: Option<&[[f64; 3]]>,
) -> Result<fullmag_runner::InteractiveRuntime> {
    fullmag_runner::create_planned_interactive_runtime_with_stage_fem_mesh_asset_and_preview_cadence(
        base_problem,
        plan,
        stage_fem_mesh_asset,
        field_every_n,
        continuation_magnetization,
    )
    .map_err(|error| anyhow!(error.to_string()))
}

fn create_interactive_preview_runtime_from_problem(
    base_problem: &ProblemIR,
    continuation_magnetization: Option<&[[f64; 3]]>,
) -> Result<fullmag_runner::InteractiveRuntime> {
    fullmag_runner::create_interactive_runtime(base_problem, continuation_magnetization)
        .map_err(|error| anyhow!(error.to_string()))
}

fn ensure_interactive_preview_runtime(
    runtime: &mut Option<fullmag_runner::InteractiveRuntime>,
    problem: &ProblemIR,
    plan: &ExecutionPlanIR,
    stage_fem_mesh_asset: Option<&fullmag_runner::StageFemMeshAsset>,
    field_every_n: u64,
    continuation_magnetization: Option<&[[f64; 3]]>,
) -> Result<()> {
    let needs_rebuild = runtime.as_ref().map_or(true, |current| {
        !current.can_continue_with_plan(plan).unwrap_or(true)
    });
    if needs_rebuild {
        *runtime = Some(create_interactive_preview_runtime(
            problem,
            plan,
            stage_fem_mesh_asset,
            field_every_n,
            continuation_magnetization,
        )?);
    }

    Ok(())
}

fn refresh_interactive_preview_runtime_display(
    runtime: &mut fullmag_runner::InteractiveRuntime,
    display_selection: &CurrentDisplaySelection,
    live_workspace: &LocalLiveWorkspace,
) -> Result<()> {
    let payload = runtime.set_display_selection(display_selection.selection.clone())?;
    let step_stats = runtime.snapshot_step_stats()?;
    let preview_field = match payload {
        fullmag_runner::DisplayPayload::VectorField(mut field)
        | fullmag_runner::DisplayPayload::SpatialScalar(mut field) => {
            field.config_revision = display_selection.revision;
            Some(field)
        }
        fullmag_runner::DisplayPayload::GlobalScalar { .. } => None,
    };
    live_workspace.update(|state| {
        apply_step_stats_to_idle_live_state(state, &step_stats);
        state.live_state.latest_step.preview_field = preview_field.clone();
        if let Some(preview_field) = preview_field.as_ref() {
            upsert_cached_preview_field(state, preview_field);
        }
    });
    Ok(())
}

fn apply_step_stats_to_idle_live_state(
    state: &mut LocalLiveWorkspaceState,
    step_stats: &fullmag_runner::StepStats,
) {
    if step_stats.step < state.live_state.latest_step.step {
        return;
    }
    state.live_state.updated_at_unix_ms = unix_time_millis().unwrap_or(0);
    state.live_state.latest_step.step = step_stats.step;
    state.live_state.latest_step.time = step_stats.time;
    state.live_state.latest_step.dt = step_stats.dt;
    state.live_state.latest_step.pseudo_time_s = step_stats.pseudo_time_s;
    state.live_state.latest_step.e_ex = step_stats.e_ex;
    state.live_state.latest_step.e_demag = step_stats.e_demag;
    state.live_state.latest_step.e_ext = step_stats.e_ext;
    state.live_state.latest_step.e_ani = step_stats.e_ani;
    state.live_state.latest_step.e_dmi = step_stats.e_dmi;
    state.live_state.latest_step.e_total = step_stats.e_total;
    state.live_state.latest_step.max_dm_dt = step_stats.max_dm_dt;
    state.live_state.latest_step.max_h_eff = step_stats.max_h_eff;
    state.live_state.latest_step.max_h_demag = step_stats.max_h_demag;
    state.live_state.latest_step.max_torque_Apm = step_stats.max_torque_Apm;
    state.live_state.latest_step.max_torque_T = step_stats.max_torque_T;
    state.live_state.latest_step.per_object_scalars = step_stats.per_object_scalars.clone();
    state.latest_scalar_row = Some(scalar_row_from_stats(step_stats));
}

#[cfg(test)]
mod tests {
    use super::{
        apply_step_stats_to_idle_live_state, CurrentLiveControlState,
        CurrentLiveDisplaySelectionHandle,
    };
    use crate::live_workspace::{bootstrap_live_state, LocalLiveWorkspaceState};
    use crate::types::{
        CurrentLiveLatestFields, CurrentLivePreviewFieldCache, RunManifest, SessionCommand,
        SessionManifest,
    };
    use fullmag_runner::StepStats;
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Condvar, Mutex};

    fn workspace_state_for_energy_refresh() -> LocalLiveWorkspaceState {
        let mut live_state = bootstrap_live_state("awaiting_command");
        live_state.latest_step.step = 7;
        live_state.latest_step.time = 2.5e-12;
        live_state.latest_step.magnetization = Some(vec![1.0, 0.0, 0.0]);

        LocalLiveWorkspaceState {
            fem_mesh: None,
            session: SessionManifest {
                session_id: "session-test".to_string(),
                run_id: "run-test".to_string(),
                status: "awaiting_command".to_string(),
                interactive_session_requested: true,
                script_path: "examples/test.py".to_string(),
                problem_name: "test".to_string(),
                requested_backend: "fdm".to_string(),
                explicit_selection: true,
                authored_requested_device: "cpu".to_string(),
                requested_device: "cpu".to_string(),
                requested_precision: "double".to_string(),
                requested_mode: "strict".to_string(),
                requested_cpu_threads: None,
                execution_mode: "strict".to_string(),
                precision: "double".to_string(),
                resolved_backend: Some("fdm".to_string()),
                resolved_device: Some("cpu".to_string()),
                resolved_precision: Some("double".to_string()),
                resolved_mode: Some("strict".to_string()),
                resolved_runtime_family: None,
                resolved_engine_id: None,
                resolved_worker: None,
                resolved_cpu_threads: None,
                resolved_fallback: None,
                fem_crossover_decision: None,
                artifact_dir: "/tmp/artifacts".to_string(),
                started_at_unix_ms: 0,
                finished_at_unix_ms: 0,
                plan_summary: serde_json::json!({}),
            },
            run: RunManifest {
                run_id: "run-test".to_string(),
                session_id: "session-test".to_string(),
                status: "awaiting_command".to_string(),
                total_steps: 7,
                final_time: None,
                final_e_ex: None,
                final_e_demag: None,
                final_e_ext: None,
                final_e_ani: None,
                final_e_dmi: None,
                final_e_total: None,
                artifact_dir: "/tmp/artifacts".to_string(),
            },
            live_state,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            simulation_preparation: None,
            latest_scalar_row: None,
            latest_fields: CurrentLiveLatestFields::default(),
            replace_latest_fields: false,
            field_generation: None,
            preview_fields: CurrentLivePreviewFieldCache::default(),
            pending_preview_fields: CurrentLivePreviewFieldCache::default(),
            superseded_pending_preview_fields: Vec::new(),
            clear_preview_cache: false,
            preview_cache_revision: 0,
            engine_log: Vec::new(),
            solver_profile: fullmag_runner::SolverProfileState::default(),
            published_fem_mesh_generation_id: None,
        }
    }

    fn queued_command(seq: u64, kind: &str) -> SessionCommand {
        SessionCommand {
            seq,
            command_id: format!("cmd-{seq}-{kind}"),
            kind: kind.to_string(),
            created_at_unix_ms: seq as u128,
            target: None,
            reason: None,
            precondition: None,
            client_intent_id: None,
            requested_at_unix_ms: None,
            until_seconds: None,
            max_steps: None,
            torque_tolerance: None,
            energy_tolerance: None,
            integrator: None,
            fixed_timestep: None,
            max_error: None,
            solver_policy: None,
            relax_algorithm: None,
            relax_alpha: None,
            mesh_options: None,
            mesh_target: None,
            mesh_reason: None,
            state_path: None,
            state_format: None,
            state_dataset: None,
            state_sample_index: None,
            display_selection: None,
            preview_config: None,
            stages: None,
            profile: None,
        }
    }

    #[test]
    fn running_control_consumes_interrupt_behind_non_control_commands() {
        let handle = CurrentLiveDisplaySelectionHandle {
            shared: Arc::new((
                Mutex::new(CurrentLiveControlState {
                    display_selection: Default::default(),
                    queue: VecDeque::from([
                        queued_command(1, "compute_fields"),
                        queued_command(2, "compute_energies"),
                        queued_command(3, "pause"),
                    ]),
                }),
                Condvar::new(),
            )),
            stop: Arc::new(AtomicBool::new(false)),
            running_interrupt: Arc::new(Mutex::new(None)),
            running_interrupt_requested: Arc::new(AtomicBool::new(false)),
            worker_owner: true,
        };

        assert_eq!(
            handle.process_running_control(),
            Some(fullmag_runner::StepAction::Pause)
        );
        assert_eq!(
            handle.take_running_interrupt(),
            Some(super::InteractiveStageInterrupt::Pause)
        );
    }

    #[test]
    fn dropping_running_control_clone_does_not_stop_owner_worker() {
        let handle = CurrentLiveDisplaySelectionHandle {
            shared: Arc::new((
                Mutex::new(CurrentLiveControlState {
                    display_selection: Default::default(),
                    queue: VecDeque::new(),
                }),
                Condvar::new(),
            )),
            stop: Arc::new(AtomicBool::new(false)),
            running_interrupt: Arc::new(Mutex::new(None)),
            running_interrupt_requested: Arc::new(AtomicBool::new(false)),
            worker_owner: true,
        };

        let clone = handle.clone();
        drop(clone);

        assert!(!handle.stop.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn compute_current_energies_state_refresh_preserves_step_time_and_magnetization() {
        let mut state = workspace_state_for_energy_refresh();
        let magnetization_before = state.live_state.latest_step.magnetization.clone();

        apply_step_stats_to_idle_live_state(
            &mut state,
            &StepStats {
                step: 7,
                time: 2.5e-12,
                e_ex: 1.0,
                e_demag: 2.0,
                e_total: 3.0,
                ..StepStats::default()
            },
        );

        assert_eq!(state.live_state.latest_step.step, 7);
        assert_eq!(state.live_state.latest_step.time, 2.5e-12);
        assert_eq!(
            state.live_state.latest_step.magnetization,
            magnetization_before
        );
        assert_eq!(state.live_state.latest_step.e_total, 3.0);
        assert_eq!(
            state.latest_scalar_row.as_ref().map(|row| row.step),
            Some(7)
        );
    }

    #[test]
    fn idle_preview_step_zero_cannot_regress_terminal_step() {
        let mut state = workspace_state_for_energy_refresh();
        apply_step_stats_to_idle_live_state(
            &mut state,
            &StepStats {
                step: 123,
                time: 4.0e-9,
                e_total: 9.0,
                ..StepStats::default()
            },
        );

        apply_step_stats_to_idle_live_state(
            &mut state,
            &StepStats {
                step: 0,
                time: 0.0,
                e_total: 1.0,
                ..StepStats::default()
            },
        );

        assert_eq!(state.live_state.latest_step.step, 123);
        assert_eq!(state.live_state.latest_step.time, 4.0e-9);
        assert_eq!(state.live_state.latest_step.e_total, 9.0);
        assert_eq!(
            state.latest_scalar_row.as_ref().map(|row| row.step),
            Some(123)
        );
    }

    #[test]
    fn idle_preview_refresh_uses_field_materialization_quantities() {
        let source = include_str!("interactive_runtime_host.rs");
        let function_body = source
            .split("\nfn refresh_interactive_preview_fields(")
            .nth(1)
            .and_then(|rest| {
                rest.split("fn snapshot_interactive_preview_payload(")
                    .next()
            })
            .expect("refresh_interactive_preview_fields should be present");

        assert!(
            function_body.contains("field_materialization_quantity_ids()"),
            "idle preview refresh replaces the cache, so it must preserve spatial scalar fields such as eden_total"
        );
        assert!(
            !function_body.contains("cached_preview_quantity_ids()"),
            "idle preview refresh must not rebuild the cache from the vector-only preview list"
        );
    }

    #[test]
    fn explicit_compute_fields_publishes_auxiliary_carriers_after_batch_materialization() {
        let source = include_str!("interactive_runtime_host.rs");
        let function_body = source
            .split("pub(super) fn compute_current_fields(")
            .nth(1)
            .and_then(|rest| rest.split("pub(super) fn compute_current_energies(").next())
            .expect("compute_current_fields should be present");

        assert!(function_body.contains("snapshot_interactive_preview_payload"));
        assert!(function_body.contains("replace_auxiliary_artifacts"));
        assert!(function_body.contains("full_field_materialization_request"));
        assert!(source.contains("snapshot_problem_vector_field_batch"));
    }

    #[test]
    fn stage_runtime_reuse_uses_continuation_compatibility() {
        let source = include_str!("interactive_runtime_host.rs");
        let ensure = source
            .split("fn ensure_interactive_preview_runtime(")
            .nth(1)
            .expect("interactive runtime ensure function");

        assert!(ensure.contains("can_continue_with_plan(plan)"));
        assert!(!ensure.contains("current.matches_plan(plan)"));
    }
}

fn refresh_interactive_preview_fields(
    base_problem: &ProblemIR,
    continuation_magnetization: Option<&[[f64; 3]]>,
    request: &fullmag_runner::LivePreviewRequest,
) -> Result<Vec<fullmag_runner::LivePreviewField>> {
    let mut problem = base_problem.clone();
    if let Some(previous_final_magnetization) = continuation_magnetization {
        apply_continuation_initial_state(&mut problem, previous_final_magnetization)?;
    }
    let quantities = fullmag_runner::quantities::field_materialization_quantity_ids();

    Ok(fullmag_runner::snapshot_problem_vector_fields(
        &problem,
        &quantities,
        request,
    )?)
}

fn snapshot_interactive_preview_payload(
    base_problem: &ProblemIR,
    continuation_magnetization: Option<&[[f64; 3]]>,
    request: &fullmag_runner::LivePreviewRequest,
) -> Result<(
    fullmag_runner::LivePreviewField,
    Vec<fullmag_runner::LivePreviewField>,
    Vec<fullmag_runner::AuxiliaryArtifact>,
)> {
    let mut problem = base_problem.clone();
    if let Some(previous_final_magnetization) = continuation_magnetization {
        apply_continuation_initial_state(&mut problem, previous_final_magnetization)?;
    }
    let quantities = fullmag_runner::quantities::field_materialization_quantity_ids();
    let preview_field = fullmag_runner::snapshot_problem_preview(&problem, request)?;
    let materialization_request = full_field_materialization_request(request.clone());
    let batch = fullmag_runner::snapshot_problem_vector_field_batch(
        &problem,
        &quantities,
        &materialization_request,
    )?;
    Ok((preview_field, batch.fields, batch.auxiliary_artifacts))
}

fn spawn_interactive_preview_cache_refresh(
    base_problem: ProblemIR,
    source_state: Arc<Mutex<InteractivePreviewSourceState>>,
    live_workspace: LocalLiveWorkspace,
    request: fullmag_runner::LivePreviewRequest,
    generation: u64,
) {
    std::thread::spawn(move || {
        let continuation_magnetization = source_state
            .lock()
            .map(|state| {
                if supports_idle_preview_cache_refresh(state.status)
                    && state.generation == generation
                {
                    state.continuation_magnetization.clone()
                } else {
                    None
                }
            })
            .unwrap_or(None);

        let Ok(preview_fields) = refresh_interactive_preview_fields(
            &base_problem,
            continuation_magnetization.as_deref(),
            &request,
        ) else {
            return;
        };

        let should_publish = source_state
            .lock()
            .map(|state| {
                supports_idle_preview_cache_refresh(state.status) && state.generation == generation
            })
            .unwrap_or(false);
        if !should_publish {
            return;
        }

        live_workspace.update(|state| {
            replace_cached_preview_fields(state, preview_fields.clone());
        });
    });
}

fn supports_idle_preview_cache_refresh(status: InteractivePreviewStatus) -> bool {
    matches!(
        status,
        InteractivePreviewStatus::AwaitingCommand | InteractivePreviewStatus::Paused
    )
}

fn wait_for_current_live_control(
    after_seq: u64,
    timeout_ms: u64,
) -> Result<Option<SessionCommand>> {
    let response = match current_live_api_client()
        .get(internal_live_api_url("control/wait"))
        .query(&[
            ("afterSeq", after_seq.to_string()),
            ("timeoutMs", timeout_ms.to_string()),
        ])
        .send()
    {
        Ok(response) => response,
        Err(_) => return Ok(None),
    };

    match response.status() {
        reqwest::StatusCode::NO_CONTENT => Ok(None),
        reqwest::StatusCode::NOT_FOUND => Ok(None),
        status if status.is_success() => response
            .json::<SessionCommand>()
            .context("failed to decode current live control command")
            .map(Some),
        status => bail!(
            "current live control wait endpoint returned HTTP {}",
            status
        ),
    }
}

fn current_live_display_selection() -> Result<CurrentDisplaySelection> {
    let status = current_live_api_client()
        .get(format!("{}/v1/live/current/status", api_base_url()))
        .send()
        .context("failed to fetch current live status for display selection")?
        .error_for_status()
        .context("current live status endpoint returned error")?
        .json::<ApiStatusSnapshot>()
        .context("failed to decode current live status")?;

    Ok(CurrentDisplaySelection::from_preview_request(
        &fullmag_runner::LivePreviewRequest {
            revision: status.resources.display_revision,
            quantity: status.display.active_quantity_id,
            component: if status.display.view_mode.eq_ignore_ascii_case("3d") {
                "3D".to_string()
            } else {
                status.display.field_component
            },
            layer: status.display.slice_layer.max(0) as u32,
            all_layers: status.display.slice_mode == "all",
            every_n: status.display.vector_density,
            x_chosen_size: status.display.x_chosen_size,
            y_chosen_size: status.display.y_chosen_size,
            auto_scale_enabled: status.display.auto_contrast,
            max_points: status.display.max_points,
        },
    ))
}

fn upsert_runtime_engine_metadata(metadata: &mut Option<Value>, runtime_engine: Value) {
    match metadata {
        Some(Value::Object(map)) => {
            map.insert("runtime_engine".to_string(), runtime_engine);
        }
        _ => {
            *metadata = Some(json!({
                "runtime_engine": runtime_engine,
            }));
        }
    }
}

fn runtime_engine_metadata_from_provenance(
    provenance: &fullmag_runner::ExecutionProvenance,
) -> Value {
    let (backend_family, engine_id, engine_label, accelerator) =
        match provenance.execution_engine.as_str() {
            "native_fem_gpu" => ("fem", "fem_native_gpu", "GPU FEM", "gpu"),
            "native_fem_cpu" => (
                "fem",
                "fem_cpu_native",
                "CPU FEM (MFEM/libCEED/hypre)",
                "cpu",
            ),
            "fem_cpu_baseline_internal" => (
                "fem",
                "fem_cpu_baseline_internal",
                "CPU FEM Baseline",
                "cpu",
            ),
            "cpu_baseline_fem_eigen" => (
                "fem_eigen",
                "fem_eigen_cpu_baseline",
                "CPU FEM Eigen Baseline",
                "cpu",
            ),
            "cuda_fdm" => ("fdm", "fdm_cuda", "CUDA FDM", "cuda"),
            "cpu_reference_multilayer" => (
                "fdm_multilayer",
                "fdm_multilayer_cpu_reference",
                "CPU FDM Multilayer",
                "cpu",
            ),
            "cuda_assisted_multilayer" | "cuda_native_multilayer_single_grid" => (
                "fdm_multilayer",
                "fdm_multilayer_cuda",
                "CUDA FDM Multilayer",
                "cuda",
            ),
            "cpu_reference" => ("fdm", "fdm_cpu_reference", "CPU FDM", "cpu"),
            other if other.contains("fem") && other.contains("gpu") => {
                ("fem", "fem_native_gpu", "GPU FEM", "gpu")
            }
            other if other.contains("fem") && other.contains("eigen") && other.contains("cpu") => (
                "fem_eigen",
                "fem_eigen_cpu_baseline",
                "CPU FEM Eigen Baseline",
                "cpu",
            ),
            other if other.contains("fem") && other.contains("cpu") => (
                "fem",
                "fem_cpu_native",
                "CPU FEM (MFEM/libCEED/hypre)",
                "cpu",
            ),
            other if other.contains("cuda") => ("fdm", "fdm_cuda", "CUDA FDM", "cuda"),
            _ => ("unknown", "unknown", "Runtime", "unknown"),
        };

    json!({
        "backend_family": backend_family,
        "engine_id": engine_id,
        "engine_label": engine_label,
        "accelerator": accelerator,
        "execution_engine": provenance.execution_engine,
        "precision": provenance.precision,
        "device_name": provenance.device_name,
        "compute_capability": provenance.compute_capability,
        "cuda_driver_version": provenance.cuda_driver_version,
        "cuda_runtime_version": provenance.cuda_runtime_version,
    })
}
