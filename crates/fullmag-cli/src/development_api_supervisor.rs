//! Owns the exact development API child through cold handoff acceptance.
//!
//! This supervisor never starts a replacement API and never releases the
//! durable admission fence. Unknown commit or process outcomes retain the
//! child handle for explicit reconciliation.

use std::{
    path::Path,
    process::{Child, ExitStatus},
    thread,
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use serde_json::Value;

use crate::development_api_owner::{
    AuthoringAcquisition, CommittedColdHandoff, LostAckColdCommit, OwnedDevelopmentApi,
    StagedAuthoringHandoff,
};
use fullmag_runtime_control::development_cold_idle::ColdIdleProof;
use fullmag_session::store::DevelopmentHandoffCommit;

const MIN_WAIT_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_WAIT_TIMEOUT: Duration = Duration::from_secs(30);
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DevelopmentApiSupervisorState {
    Running,
    OutcomeUnknown,
    CommitNotSent,
    Accepted,
    ExitedBeforeCommit,
    Shutdown,
}

/// Receipt of a committed cold handoff after the exact old API child exited.
pub(crate) struct AcceptedColdApiExit {
    pub(crate) terminal: ExitStatus,
    pub(crate) accepted: DevelopmentHandoffCommit,
    pub(crate) acknowledgement: Option<Value>,
    pub(crate) readback_helper_pid: Option<u32>,
}

/// Holds the exact child handle and the credentials that authenticate it.
/// Dropping this value does not kill the child or release the store fence.
pub(crate) struct DevelopmentApiSupervisor {
    child: Child,
    owner: OwnedDevelopmentApi,
    state: DevelopmentApiSupervisorState,
}

impl DevelopmentApiSupervisor {
    pub(crate) fn new(child: Child, owner: OwnedDevelopmentApi) -> Result<Self> {
        let child_pid = child.id();
        let owner_pid = owner.child_pid();
        if child_pid == 0 || owner_pid == 0 || child_pid != owner_pid {
            bail!("development API child does not match the confirmed owner PID");
        }
        Ok(Self {
            child,
            owner,
            state: DevelopmentApiSupervisorState::Running,
        })
    }

    pub(crate) fn owner(&self) -> &OwnedDevelopmentApi {
        &self.owner
    }

    pub(crate) fn state(&self) -> DevelopmentApiSupervisorState {
        self.state
    }

    pub(crate) fn is_outcome_unknown(&self) -> bool {
        self.state == DevelopmentApiSupervisorState::OutcomeUnknown
    }

    /// Send the normal one-shot commit, wait for this exact child to exit, then
    /// reconcile the durable record. No timeout or error releases the fence.
    pub(crate) fn commit_and_wait(
        &mut self,
        repo_root: &Path,
        acquisition: &mut AuthoringAcquisition,
        staged: &StagedAuthoringHandoff,
        proof: &ColdIdleProof,
        store_root: &Path,
        timeout: Duration,
    ) -> Result<AcceptedColdApiExit> {
        self.commit_and_wait_inner(
            repo_root,
            acquisition,
            staged,
            proof,
            store_root,
            timeout,
            false,
        )
    }

    /// Probe-only lost-ack path. The underlying acquisition enforces the
    /// dedicated managed-probe environment gates before transmitting.
    pub(crate) fn commit_and_wait_lost_ack_probe(
        &mut self,
        repo_root: &Path,
        acquisition: &mut AuthoringAcquisition,
        staged: &StagedAuthoringHandoff,
        proof: &ColdIdleProof,
        store_root: &Path,
        timeout: Duration,
    ) -> Result<AcceptedColdApiExit> {
        if std::env::var("FULLMAG_DEVELOPMENT_OWNER_PROBE").as_deref() != Ok("1")
            || std::env::var("FULLMAG_DEVELOPMENT_OWNER_PROBE_LOST_ACK").as_deref() != Ok("1")
        {
            bail!("lost-ack commit requires the managed lost-ack development API probe");
        }
        self.commit_and_wait_inner(
            repo_root,
            acquisition,
            staged,
            proof,
            store_root,
            timeout,
            true,
        )
    }

    fn commit_and_wait_inner(
        &mut self,
        repo_root: &Path,
        acquisition: &mut AuthoringAcquisition,
        staged: &StagedAuthoringHandoff,
        proof: &ColdIdleProof,
        store_root: &Path,
        timeout: Duration,
        discard_acknowledgement: bool,
    ) -> Result<AcceptedColdApiExit> {
        self.validate_before_commit(acquisition, timeout)?;

        // From this point onward a request may have reached the API. Every
        // error keeps the state closed to retries, aborts, and implicit kills.
        self.state = DevelopmentApiSupervisorState::OutcomeUnknown;
        let submission = if discard_acknowledgement {
            acquisition
                .commit_cold_handoff_lost_ack_probe(repo_root, staged, proof)
                .map(SubmissionOutcome::Discarded)
        } else {
            acquisition
                .commit_cold_handoff(repo_root, staged, proof)
                .map(SubmissionOutcome::Acknowledged)
        };
        if !acquisition.commit_may_have_been_sent() {
            self.state = DevelopmentApiSupervisorState::CommitNotSent;
            return match submission {
                Err(error) => Err(error).context("cold commit was refused before transmission"),
                Ok(_) => {
                    anyhow::bail!("cold commit returned without crossing transmission boundary")
                }
            };
        }
        let (acknowledgement, readback_helper_pid, submission_error) = match submission {
            Ok(SubmissionOutcome::Acknowledged(committed)) => (
                Some(committed.acknowledgement),
                Some(committed.readback_helper_pid),
                None,
            ),
            Ok(SubmissionOutcome::Discarded(lost)) => (None, Some(lost.readback_helper_pid), None),
            Err(error) => (None, None, Some(error)),
        };

        let deadline = Instant::now() + timeout;
        let terminal = self.wait_for_child(deadline).map_err(|wait_error| {
            match submission_error.as_ref() {
                Some(commit_error) => wait_error.context(format!(
                    "commit request returned an error ({commit_error:#}); child exit remains unknown"
                )),
                None if acknowledgement.is_some() => wait_error
                    .context("commit acknowledgement was observed; owned API exit remains unknown"),
                None => wait_error,
            }
        })?;
        if !terminal.success() {
            let detail = submission_error
                .as_ref()
                .map(|error| format!("; commit request returned an error: {error:#}"))
                .unwrap_or_default();
            bail!(
                "owned development API exited unsuccessfully; handoff remains unreconciled{detail}"
            );
        }

        let reconciled = acquisition.reconcile_committed_handoff_after_exit(
            &terminal,
            store_root,
            staged,
            proof,
            acknowledgement.as_ref(),
        );
        let accepted = match reconciled {
            Ok(accepted) => accepted,
            Err(reconciliation_error) => {
                if let Some(commit_error) = submission_error {
                    return Err(reconciliation_error.context(format!(
                        "commit request returned an error ({commit_error:#}); durable reconciliation failed"
                    )));
                }
                return Err(reconciliation_error);
            }
        };

        self.state = DevelopmentApiSupervisorState::Accepted;
        Ok(AcceptedColdApiExit {
            terminal,
            accepted,
            acknowledgement,
            readback_helper_pid,
        })
    }

    fn validate_before_commit(
        &mut self,
        acquisition: &AuthoringAcquisition,
        timeout: Duration,
    ) -> Result<()> {
        if self.state != DevelopmentApiSupervisorState::Running {
            bail!("development API supervisor is not in the running state");
        }
        if !(MIN_WAIT_TIMEOUT..=MAX_WAIT_TIMEOUT).contains(&timeout) {
            bail!("development API exit timeout must be between 1 and 30 seconds");
        }
        if !acquisition.is_owned_by(&self.owner) {
            bail!("authoring acquisition belongs to another development API owner");
        }
        let observed = match self.child.try_wait() {
            Ok(observed) => observed,
            Err(error) => {
                self.state = DevelopmentApiSupervisorState::OutcomeUnknown;
                return Err(error).context(
                    "unable to confirm owned development API is running; commit was not sent",
                );
            }
        };
        match observed {
            None => Ok(()),
            Some(_) => {
                self.state = DevelopmentApiSupervisorState::ExitedBeforeCommit;
                bail!("owned development API exited before cold commit; commit was not sent")
            }
        }
    }

    fn wait_for_child(&mut self, deadline: Instant) -> Result<ExitStatus> {
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) => return Ok(status),
                Ok(None) => {}
                Err(error) => {
                    return Err(error).context(
                        "owned development API wait failed; child retained and outcome unknown",
                    )
                }
            }
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|duration| !duration.is_zero())
                .context("owned development API exit timed out; child retained, outcome unknown")?;
            thread::sleep(remaining.min(CHILD_POLL_INTERVAL));
        }
    }

    /// Explicitly stop only a still-running child before commit. An unknown
    /// commit outcome is never force-killed or automatically reconciled here.
    pub(crate) fn shutdown(&mut self) -> Result<()> {
        match self.state {
            DevelopmentApiSupervisorState::Accepted
            | DevelopmentApiSupervisorState::ExitedBeforeCommit
            | DevelopmentApiSupervisorState::Shutdown => return Ok(()),
            DevelopmentApiSupervisorState::OutcomeUnknown => {
                bail!("cannot shut down a development API with an unknown handoff outcome")
            }
            DevelopmentApiSupervisorState::Running
            | DevelopmentApiSupervisorState::CommitNotSent => {}
        }

        let observed = match self.child.try_wait() {
            Ok(observed) => observed,
            Err(error) => {
                self.state = DevelopmentApiSupervisorState::OutcomeUnknown;
                return Err(error)
                    .context("unable to inspect the owned development API before shutdown");
            }
        };
        match observed {
            Some(_) => {
                self.state = DevelopmentApiSupervisorState::ExitedBeforeCommit;
                return Ok(());
            }
            None => {}
        }

        if let Err(error) = self.child.kill() {
            self.state = DevelopmentApiSupervisorState::OutcomeUnknown;
            return Err(error).context("unable to stop the exact owned development API child");
        }
        match self.child.wait() {
            Ok(_) => {
                self.state = DevelopmentApiSupervisorState::Shutdown;
                Ok(())
            }
            Err(error) => {
                self.state = DevelopmentApiSupervisorState::OutcomeUnknown;
                Err(error).context("owned development API shutdown wait is unknown")
            }
        }
    }
}

enum SubmissionOutcome {
    Acknowledged(CommittedColdHandoff),
    Discarded(LostAckColdCommit),
}
