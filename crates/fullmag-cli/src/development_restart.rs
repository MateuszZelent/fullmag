//! Consumes durable UI intent through the exact owned native coordinator.
//! This does not hydrate browser state or make restart a public UI capability.

use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use fullmag_runtime_control::application_attach::BackgroundApplicationAttach;
use fullmag_session::development_restart_transport::{
    self as transport, RestartRequest, RestartResult, RestartResultState,
};

use crate::{
    control_room::{ControlRoomGuard, DevelopmentRestartInput},
    scratch_runtime::{ScratchRuntimeHandle, ScratchRuntimePauseGuard},
};

struct ResultPublication {
    root: PathBuf,
    worktree: String,
    request: RestartRequest,
    result: RestartResult,
}

struct ConsumerReadinessCandidate {
    api_instance_id: String,
    candidate: crate::development_api_owner::SelectedDevelopmentCandidate,
}

#[derive(PartialEq, Eq)]
struct ConsumerSelectionIdentity {
    api_instance_id: String,
    ready_build_id: String,
    ready_source_sha256: String,
}

#[derive(Default)]
pub(crate) struct NativeRestartPump {
    attempted_api: Option<String>,
    pending_result: Option<ResultPublication>,
    retained_pause: Option<ScratchRuntimePauseGuard>,
    suspended: bool,
    known_closed_before_commit: bool,
    pending_attach_resume: Option<String>,
    readiness_candidate: Option<ConsumerReadinessCandidate>,
    readiness_selection_attempt: Option<ConsumerSelectionIdentity>,
    last_readiness_attempt: Option<Instant>,
    pub(crate) last_execution: Option<serde_json::Value>,
}

impl NativeRestartPump {
    /// Each old API has one immutable slot. Once attempted, it is never
    /// executed again, including when result publication is uncertain.
    pub(crate) fn step(
        &mut self,
        repo_root: &Path,
        guard: &mut ControlRoomGuard,
        runtime_attach: &mut Option<BackgroundApplicationAttach>,
        scratch: &mut Option<ScratchRuntimeHandle>,
    ) -> Result<()> {
        self.step_observed(repo_root, guard, runtime_attach, scratch, |_| {})
    }

    pub(crate) fn step_observed(
        &mut self,
        repo_root: &Path,
        guard: &mut ControlRoomGuard,
        runtime_attach: &mut Option<BackgroundApplicationAttach>,
        scratch: &mut Option<ScratchRuntimeHandle>,
        observe: impl FnMut(crate::control_room::DevelopmentRestartProgress),
    ) -> Result<()> {
        if let Some(publication) = self.pending_result.as_ref() {
            transport::publish_result(
                &publication.root,
                &publication.worktree,
                &publication.request,
                &publication.result,
            )
            .context("native restart result publication remains unconfirmed")?;
            self.pending_result = None;
        }
        if self.suspended {
            return Ok(());
        }
        self.resume_attach(repo_root, runtime_attach)?;
        let Some((root, worktree, generation, old_api)) = guard.development_restart_scope() else {
            return Ok(());
        };
        if self.attempted_api.as_deref() == Some(old_api.as_str()) {
            return Ok(());
        }
        let Some(request) =
            transport::read_pending_request(&root, &worktree, &old_api, &generation)?
        else {
            self.refresh_consumer_readiness(repo_root, guard, &old_api)?;
            return Ok(());
        };
        if transport::read_result(
            &root,
            &worktree,
            &request.request_id,
            &request.status_token_sha256,
        )?
        .is_some()
        {
            self.readiness_candidate = None;
            guard.confirm_development_consumer_readiness(None)?;
            self.attempted_api = Some(old_api);
            return Ok(());
        }
        // Stop advertising before beginning any capture or process handoff.
        // A failed withdrawal is retryable here because no attempt was claimed.
        self.readiness_candidate = None;
        guard.confirm_development_consumer_readiness(None)?;
        // Set the in-process claim before any helper, observer or commit.
        self.attempted_api = Some(old_api.clone());
        let result = self.consume(repo_root, guard, runtime_attach, scratch, &request, observe);
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                // Publication may be retried; process replacement never is.
                // Only fixed public reasons are persisted, never host paths,
                // private credentials or the captured UI payload in logs.
                eprintln!("[fullmag] development restart attempt failed: {error:#}");
                let precommit = self.known_closed_before_commit
                    || (!self.suspended && guard.restart_failure_is_precommit(&old_api));
                if !precommit {
                    self.suspended = true;
                }
                terminal_result(
                    &request,
                    if precommit {
                        RestartResultState::Failed
                    } else {
                        RestartResultState::Unknown
                    },
                    if precommit {
                        "restart_preparation_refused"
                    } else {
                        "restart_outcome_unconfirmed"
                    },
                )?
            }
        };
        self.pending_result = Some(ResultPublication {
            root,
            worktree,
            request,
            result,
        });
        // Persist completion immediately. If this barrier fails, the captured
        // exact result remains owned for the next tick without re-execution.
        if let Some(publication) = self.pending_result.as_ref() {
            transport::publish_result(
                &publication.root,
                &publication.worktree,
                &publication.request,
                &publication.result,
            )
            .context("native restart result publication remains unconfirmed")?;
        }
        self.pending_result = None;
        Ok(())
    }

    fn refresh_consumer_readiness(
        &mut self,
        repo_root: &Path,
        guard: &ControlRoomGuard,
        api_instance_id: &str,
    ) -> Result<()> {
        if self
            .last_readiness_attempt
            .is_some_and(|last| last.elapsed() < Duration::from_secs(1))
        {
            return Ok(());
        }
        self.last_readiness_attempt = Some(Instant::now());
        let status = guard.development_consumer_status()?;
        let (Some(build), Some(source)) = (status.ready_build_id, status.ready_source_sha256)
        else {
            self.readiness_candidate = None;
            self.readiness_selection_attempt = None;
            // A status read cannot prolong a previously issued lease.
            guard.confirm_development_consumer_readiness(None)?;
            return Ok(());
        };
        let matches = self.readiness_candidate.as_ref().is_some_and(|selected| {
            selected.api_instance_id == api_instance_id
                && selected.candidate.ready_build_id == build
                && selected.candidate.ready_source_sha256 == source
        });
        if !matches {
            let selection_identity = ConsumerSelectionIdentity {
                api_instance_id: api_instance_id.to_owned(),
                ready_build_id: build.clone(),
                ready_source_sha256: source.clone(),
            };
            if self.readiness_selection_attempt.as_ref() == Some(&selection_identity) {
                // A selector failure may already have sealed a bundle. Do not
                // repeatedly create copies for one unchanged ready observation.
                return Ok(());
            }
            self.readiness_candidate = None;
            guard.confirm_development_consumer_readiness(None)?;
            self.readiness_selection_attempt = Some(selection_identity);
            let candidate = guard.select_ready_development_candidate(repo_root)?;
            if candidate.ready_build_id != build || candidate.ready_source_sha256 != source {
                bail!("ready candidate changed during consumer readiness selection");
            }
            self.readiness_candidate = Some(ConsumerReadinessCandidate {
                api_instance_id: api_instance_id.to_owned(),
                candidate,
            });
            // Retain the validated bundle before sending renewal. A lost ACK
            // retries this candidate rather than sealing another copy.
            let selected = self
                .readiness_candidate
                .as_ref()
                .context("selected consumer readiness candidate custody is missing")?;
            guard.confirm_development_consumer_readiness(Some(&selected.candidate))?;
        } else if let Some(selected) = self.readiness_candidate.as_ref() {
            guard.confirm_development_consumer_readiness(Some(&selected.candidate))?;
        }
        Ok(())
    }

    fn consume(
        &mut self,
        repo_root: &Path,
        guard: &mut ControlRoomGuard,
        runtime_attach: &mut Option<BackgroundApplicationAttach>,
        scratch: &mut Option<ScratchRuntimeHandle>,
        request: &RestartRequest,
        mut observe: impl FnMut(crate::control_room::DevelopmentRestartProgress),
    ) -> Result<RestartResult> {
        let candidate = guard
            .select_ready_development_candidate(repo_root)
            .context("unable to select the ready development candidate")?;
        let mut helpers = vec![
            candidate.selector_helper_pid,
            candidate.owner_verifier_helper_pid,
        ];
        let mut paused = None;
        let mut attach_cancelled = false;
        let restarted = guard.restart_development_api_with_quiescence(
            repo_root,
            DevelopmentRestartInput { request, candidate_bundle_root: &candidate.bundle_root },
            Duration::from_secs(20),
            || {
                if let Some(observer) = scratch.as_ref() {
                    paused = Some(observer.pause_if_idle(Duration::from_secs(2))?);
                }
                // Joining this observer never kills the resident service. The
                // coordinator's cold proof refuses configured warm service.
                drop(runtime_attach.take());
                attach_cancelled = true;
                Ok(())
            },
            |event| {
                if let crate::control_room::DevelopmentRestartProgress::RestorePreparationHelperWaited { helper_pid } = &event {
                    helpers.push(*helper_pid);
                }
                observe(event);
            },
        );
        let restarted = match restarted {
            Ok(restarted) => restarted,
            Err(error) => {
                if guard.restart_failure_is_precommit(&request.old_api_instance_id) {
                    drop(paused); // Resume the same scratch worker and state.
                    if attach_cancelled {
                        self.pending_attach_resume = Some(request.old_api_instance_id.clone());
                        self.resume_attach(repo_root, runtime_attach)?;
                    }
                } else if guard.restart_failed_after_precommit_exit(&request.old_api_instance_id) {
                    self.known_closed_before_commit = true;
                    self.suspended = true;
                    if let Some(pause) = paused {
                        scratch
                            .as_mut()
                            .context("paused observer custody was lost")?
                            .shutdown_paused(pause)?;
                        drop(scratch.take());
                    }
                } else {
                    // An unknown handoff must not resume an observer against
                    // either an uncertain old API or its replacement.
                    self.retained_pause = paused;
                    self.suspended = true;
                }
                return Err(error);
            }
        };
        helpers.push(restarted.stage_helper_pid);
        if let Some(pid) = restarted.readback_helper_pid {
            helpers.push(pid);
        }
        helpers.push(restarted.replacement.candidate_owner_helper_pid);
        self.last_execution = Some(serde_json::json!({
            "api_pid": restarted.replacement.api_pid,
            "old_api_exit_code": restarted.old_api_terminal.code(),
            "helper_processes": helpers.into_iter().map(|pid| serde_json::json!({
                "pid":pid, "waited":true, "exit_code":0,
            })).collect::<Vec<_>>(),
        }));
        if let Some(pause) = paused {
            let observer = scratch
                .as_mut()
                .context("paused scratch observer custody was lost")?;
            observer.shutdown_paused(pause)?;
            drop(scratch.take());
        }
        let binding = fullmag_runtime_control::application_attach::prepare_for_authoring(
            repo_root,
            &crate::control_room::runtime_state_root(repo_root),
            crate::control_room::api_port(),
        )?;
        if binding.api_instance_id() != restarted.new_api_instance_id {
            self.suspended = true;
            bail!("replacement API identity changed before observer rebind");
        }
        *runtime_attach = binding.start()?;
        *scratch = Some(crate::scratch_runtime::spawn(
            crate::control_room::api_port(),
            candidate.bundle_root.join("bin/fullmag.exe"),
            None,
            restarted.new_api_instance_id.clone(),
        ));
        let mut result = terminal_result(request, RestartResultState::Ready, "restart_completed")?;
        result.new_api_instance_id = Some(restarted.new_api_instance_id);
        result.session_id = restarted.session_id;
        result.session_epoch = Some(restarted.session_epoch);
        result.editor = Some(restarted.editor);
        result.workspace = Some(restarted.workspace);
        result.project_document = Some(restarted.project_document);
        Ok(result)
    }
    fn resume_attach(
        &mut self,
        repo_root: &Path,
        runtime_attach: &mut Option<BackgroundApplicationAttach>,
    ) -> Result<()> {
        let Some(expected) = self.pending_attach_resume.as_deref() else {
            return Ok(());
        };
        let binding = fullmag_runtime_control::application_attach::prepare_for_authoring(
            repo_root,
            &crate::control_room::runtime_state_root(repo_root),
            crate::control_room::api_port(),
        )?;
        if binding.api_instance_id() != expected {
            self.pending_attach_resume = None;
            self.suspended = true;
            bail!("old API identity changed before observer resume");
        }
        *runtime_attach = binding.start()?;
        self.pending_attach_resume = None;
        Ok(())
    }
}

fn terminal_result(
    request: &RestartRequest,
    state: RestartResultState,
    reason: &str,
) -> Result<RestartResult> {
    let request_value = serde_json::to_value(request)?;
    Ok(RestartResult {
        schema: transport::RESTART_RESULT_SCHEMA.to_owned(),
        request_id: request.request_id.clone(),
        old_api_instance_id: request.old_api_instance_id.clone(),
        generation_id: request.generation_id.clone(),
        request_sha256: fullmag_session::canonical_json_sha256(&request_value),
        status_token_sha256: request.status_token_sha256.clone(),
        state,
        new_api_instance_id: None,
        session_id: None,
        session_epoch: None,
        editor: None,
        workspace: None,
        project_document: None,
        public_reason: Some(reason.to_owned()),
    })
}
