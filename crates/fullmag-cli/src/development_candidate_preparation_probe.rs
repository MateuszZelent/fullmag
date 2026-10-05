//! Managed, private fault checks for the candidate helper process owner.

use std::{
    io::{Read, Write},
    path::Path,
    thread,
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::candidate_preparation::{CandidateHelperProcess, HelperPoll};

const REQUEST_SCHEMA: &str = "fullmag.development-candidate-preparation-check-request.v1";
const HELPER_REQUEST_SCHEMA: &str = "fullmag.development-candidate-helper-probe-request.v1";
const HELPER_ACK_SCHEMA: &str = "fullmag.development-candidate-helper-probe-ack.v1";
const RESULT_SCHEMA: &str = "fullmag.development-cli-candidate-preparation-check.v1";
const MAX_PROBE_REQUEST_BYTES: usize = 4 * 1024;
const HELPER_OUTPUT_LIMIT: usize = 16 * 1024;
const OVERFLOW_OUTPUT_LIMIT: usize = 64;
const HELPER_REQUEST_LIMIT: usize = 16 * 1024;
const TERMINAL_WAIT_LIMIT: Duration = Duration::from_secs(7);

const CASES: [&str; 7] = [
    "success",
    "nonzero_exit",
    "output_overflow",
    "explicit_cancel",
    "timeout",
    "incomplete_stdin",
    "child_early_exit",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProbeRequest {
    schema: String,
    worktree_id: String,
}

#[derive(Serialize)]
struct HelperRequest<'a> {
    schema: &'static str,
    case: &'a str,
    padding: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HelperAcknowledgement {
    schema: String,
    case: String,
}

#[derive(Serialize)]
struct ProcessEvidence<'a> {
    case: &'a str,
    pid: u32,
    waited: bool,
    exit_code: Option<i32>,
    outcome: &'static str,
}

#[derive(Serialize)]
struct ProbeChecks {
    late_ack_refused: bool,
    success_completed: bool,
    nonzero_exit_failed: bool,
    output_overflow_failed: bool,
    explicit_cancel_reaped: bool,
    timeout_reaped: bool,
    incomplete_stdin_failed: bool,
    child_early_exit_reaped: bool,
    poll_nonblocking: bool,
}

impl ProbeChecks {
    fn passed(&self) -> bool {
        self.late_ack_refused
            && self.success_completed
            && self.nonzero_exit_failed
            && self.output_overflow_failed
            && self.explicit_cancel_reaped
            && self.timeout_reaped
            && self.incomplete_stdin_failed
            && self.child_early_exit_reaped
            && self.poll_nonblocking
    }
}

enum TerminalOutcome {
    Completed {
        helper_pid: u32,
        exit_code: Option<i32>,
        output: Vec<u8>,
    },
    Failed {
        helper_pid: u32,
        exit_code: Option<i32>,
        input_complete: bool,
        output: Vec<u8>,
        reason: &'static str,
    },
}

impl TerminalOutcome {
    fn pid(&self) -> u32 {
        match self {
            Self::Completed { helper_pid, .. } | Self::Failed { helper_pid, .. } => *helper_pid,
        }
    }

    fn exit_code(&self) -> Option<i32> {
        match self {
            Self::Completed { exit_code, .. } | Self::Failed { exit_code, .. } => *exit_code,
        }
    }

    fn output(&self) -> &[u8] {
        match self {
            Self::Completed { output, .. } | Self::Failed { output, .. } => output,
        }
    }

    fn process_evidence<'a>(&self, case: &'a str) -> ProcessEvidence<'a> {
        ProcessEvidence {
            case,
            pid: self.pid(),
            // CandidateHelperProcess returns a terminal outcome only after it
            // observed exit and joined both bounded transport threads.
            waited: true,
            exit_code: self.exit_code(),
            outcome: match self {
                Self::Completed { .. } => "completed",
                Self::Failed { .. } => "failed",
            },
        }
    }
}

pub(super) fn verify(
    python: &Path,
    helper: &Path,
    repo_root: &Path,
    expected_worktree_id: &str,
) -> Result<()> {
    require_probe_gates()?;
    let mut raw = Vec::new();
    std::io::stdin()
        .take((MAX_PROBE_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut raw)?;
    if raw.len() > MAX_PROBE_REQUEST_BYTES {
        bail!("candidate preparation probe request exceeds its limit");
    }
    let request: ProbeRequest =
        serde_json::from_slice(&raw).context("invalid candidate preparation probe request")?;
    if request.schema != REQUEST_SCHEMA || request.worktree_id != expected_worktree_id {
        bail!("candidate preparation probe request differs from the managed worktree");
    }
    fullmag_session::repository_path::validate_store_id(&request.worktree_id)
        .context("candidate preparation probe worktree id is invalid")?;

    let mut processes = Vec::with_capacity(CASES.len());
    let mut max_poll_elapsed_ms = 0u128;

    let mut success_job = start_case(
        python,
        helper,
        repo_root,
        "success",
        helper_request("success", None)?,
        HELPER_OUTPUT_LIMIT,
        Instant::now() + Duration::from_secs(5),
    )?;
    let success = wait_for_terminal(&mut success_job, &mut max_poll_elapsed_ms)?;
    let success_completed = matches!(
        &success,
        TerminalOutcome::Completed {
            exit_code: Some(0),
            ..
        }
    ) && has_expected_ack(success.output(), "success");
    processes.push(success.process_evidence("success"));

    let mut nonzero_job = start_case(
        python,
        helper,
        repo_root,
        "nonzero_exit",
        helper_request("nonzero_exit", None)?,
        HELPER_OUTPUT_LIMIT,
        Instant::now() + Duration::from_secs(5),
    )?;
    let nonzero = wait_for_terminal(&mut nonzero_job, &mut max_poll_elapsed_ms)?;
    let nonzero_exit_failed = matches!(
        &nonzero,
        TerminalOutcome::Failed {
            exit_code: Some(7),
            input_complete: true,
            reason: "development candidate helper failed",
            ..
        }
    ) && has_expected_ack(nonzero.output(), "nonzero_exit");
    processes.push(nonzero.process_evidence("nonzero_exit"));

    let mut overflow_job = start_case(
        python,
        helper,
        repo_root,
        "output_overflow",
        helper_request("output_overflow", None)?,
        OVERFLOW_OUTPUT_LIMIT,
        Instant::now() + Duration::from_secs(5),
    )?;
    let overflow = wait_for_terminal(&mut overflow_job, &mut max_poll_elapsed_ms)?;
    let expected_overflow_output = vec![b'x'; OVERFLOW_OUTPUT_LIMIT + 1];
    let output_overflow_failed = matches!(
        &overflow,
        TerminalOutcome::Failed {
            exit_code: Some(_),
            input_complete: true,
            reason: "development candidate helper output exceeded its limit",
            ..
        }
    ) && overflow.output() == expected_overflow_output.as_slice();
    processes.push(overflow.process_evidence("output_overflow"));

    let mut cancel_job = start_case(
        python,
        helper,
        repo_root,
        "explicit_cancel",
        helper_request("explicit_cancel", None)?,
        HELPER_OUTPUT_LIMIT,
        Instant::now() + Duration::from_secs(10),
    )?;
    let first_poll_started = Instant::now();
    let first_poll = cancel_job.poll();
    let first_poll_elapsed_ms = first_poll_started.elapsed().as_millis();
    max_poll_elapsed_ms = max_poll_elapsed_ms.max(first_poll_elapsed_ms);
    let mut cancel_terminal = None;
    let poll_nonblocking = match first_poll? {
        HelperPoll::Pending => cancel_job.is_running()? && first_poll_elapsed_ms < 1000,
        terminal @ (HelperPoll::Completed { .. }
        | HelperPoll::Failed { .. }
        | HelperPoll::Unconfirmed { .. }) => {
            cancel_terminal = Some(terminal_outcome(terminal)?);
            false
        }
    };
    let cancel_acknowledged_live = if cancel_terminal.is_none() && poll_nonblocking {
        match wait_for_ack_before(
            &mut cancel_job,
            "explicit_cancel",
            Instant::now() + Duration::from_secs(3),
            &mut max_poll_elapsed_ms,
        )? {
            AckWait::AcknowledgedLive => true,
            AckWait::DeadlineExpired => false,
            AckWait::Terminal(terminal) => {
                cancel_terminal = Some(terminal);
                false
            }
        }
    } else {
        false
    };
    // The helper already acknowledged the request while remaining live.
    // A past cutoff must refuse that same ACK instead of accepting it late.
    let late_ack_refused = if cancel_acknowledged_live {
        matches!(
            wait_for_ack_before(
                &mut cancel_job,
                "explicit_cancel",
                Instant::now() - Duration::from_millis(1),
                &mut max_poll_elapsed_ms,
            )?,
            AckWait::DeadlineExpired
        )
    } else {
        false
    };
    let canceled = if let Some(terminal) = cancel_terminal {
        terminal
    } else {
        cancel_job.cancel();
        wait_for_terminal(&mut cancel_job, &mut max_poll_elapsed_ms)?
    };
    let explicit_cancel_reaped = cancel_acknowledged_live
        && matches!(
            &canceled,
            TerminalOutcome::Failed {
                exit_code: Some(_),
                input_complete: true,
                reason: "development candidate helper was canceled",
                ..
            }
        )
        && has_expected_ack(canceled.output(), "explicit_cancel");
    processes.push(canceled.process_evidence("explicit_cancel"));

    let timeout_deadline = Instant::now() + Duration::from_secs(3);
    let mut timeout_job = start_case(
        python,
        helper,
        repo_root,
        "timeout",
        helper_request("timeout", None)?,
        HELPER_OUTPUT_LIMIT,
        timeout_deadline,
    )?;
    let first_timeout_poll_started = Instant::now();
    let first_timeout_poll = timeout_job.poll();
    let first_timeout_poll_elapsed_ms = first_timeout_poll_started.elapsed().as_millis();
    max_poll_elapsed_ms = max_poll_elapsed_ms.max(first_timeout_poll_elapsed_ms);
    let mut timeout_terminal = None;
    let timeout_initially_live = match first_timeout_poll? {
        HelperPoll::Pending => timeout_job.is_running()?,
        terminal @ (HelperPoll::Completed { .. }
        | HelperPoll::Failed { .. }
        | HelperPoll::Unconfirmed { .. }) => {
            timeout_terminal = Some(terminal_outcome(terminal)?);
            false
        }
    };
    let timeout_acknowledged_live = if timeout_terminal.is_none() && timeout_initially_live {
        match wait_for_ack_before(
            &mut timeout_job,
            "timeout",
            timeout_deadline - Duration::from_millis(250),
            &mut max_poll_elapsed_ms,
        )? {
            AckWait::AcknowledgedLive => true,
            AckWait::DeadlineExpired => false,
            AckWait::Terminal(terminal) => {
                timeout_terminal = Some(terminal);
                false
            }
        }
    } else {
        false
    };
    let timed_out = if let Some(terminal) = timeout_terminal {
        terminal
    } else {
        wait_for_terminal(&mut timeout_job, &mut max_poll_elapsed_ms)?
    };
    let timeout_reaped = timeout_acknowledged_live
        && matches!(
            &timed_out,
            TerminalOutcome::Failed {
                exit_code: Some(_),
                input_complete: true,
                reason: "development candidate helper timed out",
                ..
            }
        )
        && has_expected_ack(timed_out.output(), "timeout");
    processes.push(timed_out.process_evidence("timeout"));

    let incomplete_request = helper_request("incomplete_stdin", Some(16_200))?;
    if incomplete_request.len() > HELPER_REQUEST_LIMIT {
        bail!("incomplete stdin fixture does not fit the production request bound");
    }
    let mut incomplete_job = start_case(
        python,
        helper,
        repo_root,
        "incomplete_stdin",
        incomplete_request,
        HELPER_OUTPUT_LIMIT,
        Instant::now() + Duration::from_secs(5),
    )?;
    let incomplete = wait_for_terminal(&mut incomplete_job, &mut max_poll_elapsed_ms)?;
    let incomplete_stdin_failed = matches!(
        &incomplete,
        TerminalOutcome::Failed {
            exit_code: Some(0),
            input_complete: false,
            ..
        }
    ) && has_expected_ack(incomplete.output(), "incomplete_stdin");
    processes.push(incomplete.process_evidence("incomplete_stdin"));

    let mut early_exit_job = start_case(
        python,
        helper,
        repo_root,
        "child_early_exit",
        helper_request("child_early_exit", None)?,
        HELPER_OUTPUT_LIMIT,
        Instant::now() + Duration::from_secs(5),
    )?;
    let early_exit = wait_for_terminal(&mut early_exit_job, &mut max_poll_elapsed_ms)?;
    let child_early_exit_reaped = matches!(
        &early_exit,
        TerminalOutcome::Failed {
            exit_code: Some(9),
            input_complete: true,
            ..
        }
    );
    processes.push(early_exit.process_evidence("child_early_exit"));

    let checks = ProbeChecks {
        late_ack_refused,
        success_completed,
        nonzero_exit_failed,
        output_overflow_failed,
        explicit_cancel_reaped,
        timeout_reaped,
        incomplete_stdin_failed,
        child_early_exit_reaped,
        poll_nonblocking: poll_nonblocking && max_poll_elapsed_ms < 1000,
    };
    let passed = checks.passed();
    let result = json!({
        "schema": RESULT_SCHEMA,
        "status": if passed { "passed" } else { "failed" },
        "poll_elapsed_ms": max_poll_elapsed_ms,
        "checks": checks,
        "processes": processes,
    });
    println!("{result}");
    std::io::stdout().flush()?;
    if !passed {
        bail!("candidate preparation helper fault checks did not all pass");
    }
    Ok(())
}

fn require_probe_gates() -> Result<()> {
    if std::env::var("FULLMAG_DEVELOPMENT_OWNER_PROBE").as_deref() != Ok("1")
        || std::env::var("FULLMAG_DEVELOPMENT_RESTART_PROBE_CASE").as_deref()
            != Ok("preparation-faults")
    {
        bail!("candidate preparation fault helper requires the managed probe gates");
    }
    Ok(())
}

fn helper_request(case: &str, padding_bytes: Option<usize>) -> Result<Vec<u8>> {
    let request = HelperRequest {
        schema: HELPER_REQUEST_SCHEMA,
        case,
        padding: padding_bytes.map(|length| "x".repeat(length)),
    };
    let bytes = serde_json::to_vec(&request)?;
    if bytes.len() > HELPER_REQUEST_LIMIT {
        bail!("candidate helper request exceeds its bound");
    }
    Ok(bytes)
}

fn start_case(
    python: &Path,
    helper: &Path,
    repo_root: &Path,
    case: &str,
    request: Vec<u8>,
    output_limit: usize,
    deadline: Instant,
) -> Result<CandidateHelperProcess> {
    if !CASES.contains(&case) {
        bail!("candidate preparation probe case is not allowed");
    }
    let process = CandidateHelperProcess::spawn_probe_case(
        python,
        helper,
        repo_root,
        request,
        output_limit,
        deadline,
        "candidate-preparation-fault",
        case,
    )?;
    let pid = process.helper_pid();
    if pid == 0 {
        bail!("candidate helper probe process has an invalid PID");
    }
    println!(
        "{}",
        json!({
            "schema":"fullmag.development-cli-candidate-preparation-helper-progress.v1",
            "event":"started",
            "case":case,
            "pid":pid,
        })
    );
    std::io::stdout().flush()?;
    Ok(process)
}

fn wait_for_terminal(
    helper: &mut CandidateHelperProcess,
    max_poll_elapsed_ms: &mut u128,
) -> Result<TerminalOutcome> {
    let deadline = Instant::now() + TERMINAL_WAIT_LIMIT;
    loop {
        let poll_started = Instant::now();
        let poll = helper.poll();
        *max_poll_elapsed_ms = (*max_poll_elapsed_ms).max(poll_started.elapsed().as_millis());
        match poll? {
            HelperPoll::Pending => {
                if Instant::now() >= deadline {
                    bail!("candidate helper terminal state was not confirmed before the probe deadline");
                }
                thread::sleep(Duration::from_millis(10));
            }
            terminal => return terminal_outcome(terminal),
        }
    }
}

enum AckWait {
    AcknowledgedLive,
    DeadlineExpired,
    Terminal(TerminalOutcome),
}

fn wait_for_ack_before(
    helper: &mut CandidateHelperProcess,
    expected_case: &str,
    deadline: Instant,
    max_poll_elapsed_ms: &mut u128,
) -> Result<AckWait> {
    loop {
        let poll_started = Instant::now();
        let poll = helper.poll();
        *max_poll_elapsed_ms = (*max_poll_elapsed_ms).max(poll_started.elapsed().as_millis());
        match poll? {
            HelperPoll::Pending => {
                if Instant::now() >= deadline {
                    return Ok(AckWait::DeadlineExpired);
                }
                let request_written = helper.probe_input_complete() == Some(true);
                let acknowledged = helper
                    .probe_output()
                    .is_some_and(|output| has_expected_ack(output, expected_case));
                if request_written
                    && acknowledged
                    && helper.is_running()?
                    && Instant::now() < deadline
                {
                    return Ok(AckWait::AcknowledgedLive);
                }
                if Instant::now() >= deadline {
                    return Ok(AckWait::DeadlineExpired);
                }
                thread::sleep(Duration::from_millis(10));
            }
            terminal => return Ok(AckWait::Terminal(terminal_outcome(terminal)?)),
        }
    }
}

fn has_expected_ack(output: &[u8], expected_case: &str) -> bool {
    let Ok(acknowledgement) = serde_json::from_slice::<HelperAcknowledgement>(output) else {
        return false;
    };
    acknowledgement.schema == HELPER_ACK_SCHEMA && acknowledgement.case == expected_case
}

fn terminal_outcome(poll: HelperPoll) -> Result<TerminalOutcome> {
    match poll {
        HelperPoll::Completed {
            helper_pid,
            exit_code,
            output,
        } => Ok(TerminalOutcome::Completed {
            helper_pid,
            exit_code,
            output,
        }),
        HelperPoll::Failed {
            helper_pid,
            exit_code,
            input_complete,
            output,
            reason,
        } => Ok(TerminalOutcome::Failed {
            helper_pid,
            exit_code,
            input_complete,
            output,
            reason,
        }),
        HelperPoll::Unconfirmed { helper_pid, reason } => {
            bail!("candidate helper cleanup is unconfirmed for PID {helper_pid}: {reason}")
        }
        HelperPoll::Pending => {
            bail!("candidate helper terminal conversion was called while pending")
        }
    }
}
