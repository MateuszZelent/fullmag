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
    identity: crate::development_api_owner::CandidatePreparationIdentity,
    candidate: crate::development_api_owner::SelectedDevelopmentCandidate,
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
    candidate_preparation: Option<crate::development_api_owner::CandidatePreparationJob>,
    readiness_selection_attempt: Option<crate::development_api_owner::CandidatePreparationIdentity>,
    last_readiness_attempt: Option<Instant>,
    pub(crate) last_execution: Option<serde_json::Value>,
}

impl NativeRestartPump {
    /// Read-only evidence for the managed executable probe; never selects or renews.
    pub(crate) fn readiness_candidate_for_probe(
        &self,
    ) -> Option<&crate::development_api_owner::SelectedDevelopmentCandidate> {
        self.readiness_candidate
            .as_ref()
            .map(|entry| &entry.candidate)
    }

    pub(crate) fn candidate_preparation_state_for_probe(&mut self) -> Result<Option<(u32, bool)>> {
        let Some(job) = self.candidate_preparation.as_mut() else {
            return Ok(None);
        };
        job.helper_running()
    }

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
        mut observe: impl FnMut(crate::control_room::DevelopmentRestartProgress),
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
            self.readiness_candidate = None;
            self.cancel_candidate_preparation()?;
            return Ok(());
        }
        self.resume_attach(repo_root, runtime_attach)?;
        let Some((root, worktree, generation, old_api)) = guard.development_restart_scope() else {
            self.readiness_candidate = None;
            self.cancel_candidate_preparation()?;
            return Ok(());
        };
        if self.attempted_api.as_deref() == Some(old_api.as_str()) {
            self.readiness_candidate = None;
            self.cancel_candidate_preparation()?;
            return Ok(());
        }
        let Some(request) =
            transport::read_pending_request(&root, &worktree, &old_api, &generation)?
        else {
            self.refresh_consumer_readiness(
                repo_root,
                guard,
                &old_api,
                &worktree,
                &generation,
                true,
                &mut observe,
            )?;
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
            self.cancel_candidate_preparation()?;
            guard.confirm_development_consumer_readiness(None)?;
            self.attempted_api = Some(old_api);
            return Ok(());
        }
        // A durable request stays pending while candidate preparation runs.
        // Consumption never performs a synchronous selector or reseal.
        self.refresh_consumer_readiness(
            repo_root,
            guard,
            &old_api,
            &worktree,
            &generation,
            false,
            &mut observe,
        )?;
        let Some(selected) = self.readiness_candidate.take() else {
            return Ok(());
        };
        let status = guard.development_consumer_status()?;
        if selected.identity.api_instance_id != old_api
            || selected.identity.worktree_id != worktree
            || selected.identity.generation_id != generation
            || status.ready_build_id.as_deref() != Some(selected.identity.ready_build_id.as_str())
            || status.ready_source_sha256.as_deref()
                != Some(selected.identity.ready_source_sha256.as_str())
        {
            guard.confirm_development_consumer_readiness(None)?;
            self.last_readiness_attempt = Some(Instant::now());
            return Ok(());
        }
        // Stop advertising before beginning any capture or process handoff.
        // A failed withdrawal is retryable here because no attempt was claimed.
        guard.confirm_development_consumer_readiness(None)?;
        // Set the in-process claim before any helper, observer or commit.
        self.attempted_api = Some(old_api.clone());
        let result = self.consume(
            repo_root,
            guard,
            runtime_attach,
            scratch,
            &request,
            selected.candidate,
            observe,
        );
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
        worktree_id: &str,
        generation_id: &str,
        allow_renewal: bool,
        observe: &mut impl FnMut(crate::control_room::DevelopmentRestartProgress),
    ) -> Result<()> {
        let status = guard.development_consumer_status()?;
        let (Some(build), Some(source)) = (status.ready_build_id, status.ready_source_sha256)
        else {
            if self.readiness_candidate.take().is_some() {
                self.force_withdraw_consumer_readiness(guard)?;
            } else {
                self.withdraw_consumer_readiness(guard)?;
            }
            if !self.cancel_candidate_preparation()? {
                return Ok(());
            }
            return Ok(());
        };
        let identity = crate::development_api_owner::CandidatePreparationIdentity {
            api_instance_id: api_instance_id.to_owned(),
            worktree_id: worktree_id.to_owned(),
            generation_id: generation_id.to_owned(),
            ready_build_id: build,
            ready_source_sha256: source,
        };
        let candidate_matches = self
            .readiness_candidate
            .as_ref()
            .is_some_and(|selected| selected.identity == identity);
        if !candidate_matches && self.readiness_candidate.is_some() {
            self.readiness_candidate = None;
            self.force_withdraw_consumer_readiness(guard)?;
        }

        if self
            .candidate_preparation
            .as_ref()
            .is_some_and(|job| job.identity != identity)
        {
            self.withdraw_consumer_readiness(guard)?;
            if !self.cancel_candidate_preparation()? {
                return Ok(());
            }
        }

        if candidate_matches {
            if allow_renewal && self.readiness_renewal_due() {
                let selected = self
                    .readiness_candidate
                    .as_ref()
                    .context("selected consumer readiness candidate custody is missing")?;
                guard.confirm_development_consumer_readiness(Some(&selected.candidate))?;
                self.last_readiness_attempt = Some(Instant::now());
            }
            return Ok(());
        }

        if self.candidate_preparation.is_none() {
            if self.readiness_selection_attempt.as_ref() == Some(&identity) {
                return Ok(());
            }
            self.withdraw_consumer_readiness(guard)?;
            let job =
                match guard.start_development_candidate_preparation(repo_root, identity.clone()) {
                    Ok(job) => job,
                    Err(error) => {
                        self.readiness_selection_attempt = Some(identity);
                        eprintln!("[fullmag] candidate preparation could not start: {error:#}");
                        return Ok(());
                    }
                };
            let helper_pid = job
                .helper_pid()
                .context("candidate preparation started without a helper process")?;
            observe(
                crate::control_room::DevelopmentRestartProgress::CandidatePreparationStarted {
                    helper_pid,
                    api_instance_id: identity.api_instance_id.clone(),
                    ready_build_id: identity.ready_build_id.clone(),
                    ready_source_sha256: identity.ready_source_sha256.clone(),
                },
            );
            self.candidate_preparation = Some(job);
        }

        let poll = {
            let job = self
                .candidate_preparation
                .as_mut()
                .context("candidate preparation job custody is missing")?;
            guard.poll_development_candidate_preparation(repo_root, job)
        };
        match poll {
            crate::development_api_owner::CandidatePreparationPoll::Pending { .. } => Ok(()),
            crate::development_api_owner::CandidatePreparationPoll::Unconfirmed { .. } => {
                // Keep ownership of the helper and its I/O transports. A new
                // identity cannot start until process and transport cleanup is confirmed.
                Ok(())
            }
            crate::development_api_owner::CandidatePreparationPoll::Unavailable {
                helper_pid: _,
            } => {
                let completed_identity = self
                    .candidate_preparation
                    .take()
                    .map(|job| job.identity)
                    .unwrap_or(identity.clone());
                self.readiness_selection_attempt = Some(completed_identity);
                Ok(())
            }
            crate::development_api_owner::CandidatePreparationPoll::Ready(candidate) => {
                let completed_identity = self
                    .candidate_preparation
                    .take()
                    .map(|job| job.identity)
                    .context("ready candidate lost preparation identity")?;
                self.readiness_selection_attempt = Some(completed_identity.clone());
                if completed_identity != identity
                    || candidate.ready_build_id != identity.ready_build_id
                    || candidate.ready_source_sha256 != identity.ready_source_sha256
                    || candidate.generation_id != identity.generation_id
                    || candidate.worktree_id != identity.worktree_id
                {
                    self.force_withdraw_consumer_readiness(guard)?;
                    return Ok(());
                }
                self.readiness_candidate = Some(ConsumerReadinessCandidate {
                    identity: identity.clone(),
                    candidate,
                });
                // Candidate selection may span many pump ticks. Confirm only
                // after a fresh owner read still pins the same ready identity.
                let current = guard.development_consumer_status()?;
                if current.ready_build_id.as_deref() != Some(identity.ready_build_id.as_str())
                    || current.ready_source_sha256.as_deref()
                        != Some(identity.ready_source_sha256.as_str())
                {
                    self.readiness_candidate = None;
                    self.force_withdraw_consumer_readiness(guard)?;
                    return Ok(());
                }
                if allow_renewal {
                    let selected = self
                        .readiness_candidate
                        .as_ref()
                        .context("selected consumer readiness candidate custody is missing")?;
                    guard.confirm_development_consumer_readiness(Some(&selected.candidate))?;
                    self.last_readiness_attempt = Some(Instant::now());
                }
                Ok(())
            }
        }
    }

    fn readiness_renewal_due(&self) -> bool {
        self.last_readiness_attempt
            .map_or(true, |last| last.elapsed() >= Duration::from_secs(1))
    }

    fn withdraw_consumer_readiness(&mut self, guard: &ControlRoomGuard) -> Result<()> {
        if self.readiness_renewal_due() {
            self.force_withdraw_consumer_readiness(guard)?;
        }
        Ok(())
    }

    fn force_withdraw_consumer_readiness(&mut self, guard: &ControlRoomGuard) -> Result<()> {
        guard.confirm_development_consumer_readiness(None)?;
        self.last_readiness_attempt = Some(Instant::now());
        Ok(())
    }

    fn cancel_candidate_preparation(&mut self) -> Result<bool> {
        let Some(job) = self.candidate_preparation.as_mut() else {
            return Ok(true);
        };
        let identity = job.identity.clone();
        match job.drain_after_cancel() {
            Ok(true) => {
                self.candidate_preparation = None;
                self.readiness_selection_attempt = Some(identity);
                Ok(true)
            }
            Ok(false) => Ok(false),
            Err(error) => {
                eprintln!("[fullmag] candidate preparation cleanup remains unconfirmed: {error:#}");
                Ok(false)
            }
        }
    }

    fn consume(
        &mut self,
        repo_root: &Path,
        guard: &mut ControlRoomGuard,
        runtime_attach: &mut Option<BackgroundApplicationAttach>,
        scratch: &mut Option<ScratchRuntimeHandle>,
        request: &RestartRequest,
        candidate: crate::development_api_owner::SelectedDevelopmentCandidate,
        mut observe: impl FnMut(crate::control_room::DevelopmentRestartProgress),
    ) -> Result<RestartResult> {
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
