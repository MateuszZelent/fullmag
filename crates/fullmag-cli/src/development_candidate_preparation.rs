//! Bounded, pollable subprocess ownership for native candidate preparation.

use std::{
    io::{Read, Write},
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
    sync::mpsc::{self, Receiver, TryRecvError},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};

const MAX_CANDIDATE_HELPER_REQUEST_BYTES: usize = 16 * 1024;
const MAX_CANDIDATE_HELPER_OUTPUT_BYTES: usize = 16 * 1024;

enum HelperEvent {
    InputWritten(bool),
    OutputRead(std::result::Result<Vec<u8>, ()>),
}

pub(crate) enum HelperPoll {
    Pending,
    Completed {
        helper_pid: u32,
        output: Vec<u8>,
    },
    Unconfirmed {
        helper_pid: u32,
        reason: &'static str,
    },
    Failed {
        helper_pid: u32,
        exit_code: Option<i32>,
        reason: &'static str,
    },
}

/// A helper process plus its bounded stdin/stdout transports. Polling never
/// waits for process exit or pipe completion; those advance between pump ticks.
pub(crate) struct CandidateHelperProcess {
    child: Option<Child>,
    receiver: Receiver<HelperEvent>,
    writer: Option<JoinHandle<()>>,
    reader: Option<JoinHandle<()>>,
    helper_pid: u32,
    deadline: Instant,
    cleanup_deadline: Option<Instant>,
    input_complete: Option<bool>,
    output: Option<Vec<u8>>,
    output_complete: bool,
    exit_status: Option<ExitStatus>,
    failure: Option<&'static str>,
    kill_requested: bool,
    terminal: bool,
}

impl CandidateHelperProcess {
    pub(crate) fn spawn(
        python: &Path,
        helper: &Path,
        repo_root: &Path,
        request: Vec<u8>,
        output_limit: usize,
        deadline: Instant,
        name: &'static str,
    ) -> Result<Self> {
        if request.len() > MAX_CANDIDATE_HELPER_REQUEST_BYTES
            || output_limit > MAX_CANDIDATE_HELPER_OUTPUT_BYTES
        {
            bail!("candidate helper transport exceeds its byte limit");
        }
        let mut command = Command::new(python);
        command
            .arg("-B")
            .arg(helper)
            .arg("--repo-root")
            .arg(repo_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_remove("FULLMAG_DEVELOPMENT_OWNER_TOKEN")
            .env_remove("FULLMAG_DEVELOPMENT_OWNER_PROBE_TOKEN");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .context("unable to start managed development candidate helper")?;
        let helper_pid = child.id();
        let (sender, receiver) = mpsc::channel();
        let mut failure = None;
        let mut input_complete = None;
        let mut output_complete = false;
        let writer = match child.stdin.take() {
            Some(stdin) => {
                let input_sender = sender.clone();
                match thread::Builder::new()
                    .name(format!("{name}-stdin"))
                    .spawn(move || {
                        let written = {
                            let mut stdin = stdin;
                            stdin.write_all(&request).is_ok()
                        };
                        let _ = input_sender.send(HelperEvent::InputWritten(written));
                    }) {
                    Ok(writer) => Some(writer),
                    Err(_) => {
                        input_complete = Some(false);
                        failure = Some("unable to start development candidate input transport");
                        None
                    }
                }
            }
            None => {
                input_complete = Some(false);
                failure = Some("development candidate helper stdin is unavailable");
                None
            }
        };

        let reader = match child.stdout.take() {
            Some(stdout) => {
                let output_sender = sender.clone();
                match thread::Builder::new()
                    .name(format!("{name}-stdout"))
                    .spawn(move || {
                        let output = read_bounded_output(stdout, output_limit);
                        let _ = output_sender.send(HelperEvent::OutputRead(output));
                    }) {
                    Ok(reader) => Some(reader),
                    Err(_) => {
                        output_complete = true;
                        failure.get_or_insert(
                            "unable to start development candidate output transport",
                        );
                        None
                    }
                }
            }
            None => {
                output_complete = true;
                failure.get_or_insert("development candidate helper stdout is unavailable");
                None
            }
        };
        drop(sender);

        Ok(Self {
            child: Some(child),
            receiver,
            writer,
            reader,
            helper_pid,
            deadline,
            cleanup_deadline: None,
            input_complete,
            output: None,
            output_complete,
            exit_status: None,
            failure,
            kill_requested: false,
            terminal: false,
        })
    }

    pub(crate) fn helper_pid(&self) -> u32 {
        self.helper_pid
    }

    pub(crate) fn is_terminal(&self) -> bool {
        self.terminal
    }

    pub(crate) fn is_running(&mut self) -> Result<bool> {
        if self.terminal {
            return Ok(false);
        }
        let child = self
            .child
            .as_mut()
            .context("development candidate helper process custody is missing")?;
        match child.try_wait() {
            Ok(Some(status)) => {
                self.exit_status = Some(status);
                self.cleanup_deadline
                    .get_or_insert_with(|| Instant::now() + Duration::from_secs(2));
                Ok(false)
            }
            Ok(None) => Ok(true),
            Err(error) => Err(error).context("unable to observe candidate helper liveness"),
        }
    }

    pub(crate) fn cancel(&mut self) {
        self.failure
            .get_or_insert("development candidate helper was canceled");
        self.cleanup_deadline
            .get_or_insert_with(|| Instant::now() + Duration::from_secs(5));
        self.request_termination();
    }

    pub(crate) fn poll(&mut self) -> Result<HelperPoll> {
        if self.terminal {
            bail!("development candidate helper was polled after completion");
        }
        self.collect_events();
        self.reconcile_finished_transports();
        if self.failure.is_some() || Instant::now() >= self.deadline {
            self.failure
                .get_or_insert("development candidate helper timed out");
            self.cleanup_deadline
                .get_or_insert_with(|| Instant::now() + Duration::from_secs(5));
            self.request_termination();
        }

        if self.exit_status.is_none() {
            let child = self
                .child
                .as_mut()
                .context("development candidate helper process custody is missing")?;
            match child.try_wait() {
                Ok(Some(status)) => self.exit_status = Some(status),
                Ok(None) => {}
                Err(_) => {
                    self.failure
                        .get_or_insert("unable to observe development candidate helper exit");
                    self.cleanup_deadline
                        .get_or_insert_with(|| Instant::now() + Duration::from_secs(5));
                    self.request_termination();
                    return Ok(self.unconfirmed_or_pending());
                }
            }
        }
        if self.exit_status.is_some() {
            self.cleanup_deadline
                .get_or_insert_with(|| Instant::now() + Duration::from_secs(2));
        }
        self.collect_events();
        self.reconcile_finished_transports();

        let Some(status) = self.exit_status else {
            return Ok(self.unconfirmed_or_pending());
        };
        if self.input_complete.is_none()
            || !self.output_complete
            || self.writer.is_some()
            || self.reader.is_some()
        {
            return Ok(self.unconfirmed_or_pending());
        }

        let input_complete = self.input_complete == Some(true);
        let output = self.output.take().unwrap_or_default();
        self.join_transports()?;
        self.child.take();
        self.terminal = true;

        let reason = self.failure.or_else(|| {
            if !input_complete {
                Some("development candidate helper did not receive its complete request")
            } else if !status.success() {
                Some("development candidate helper failed")
            } else {
                None
            }
        });
        match reason {
            Some(reason) => Ok(HelperPoll::Failed {
                helper_pid: self.helper_pid,
                exit_code: status.code(),
                reason,
            }),
            None => Ok(HelperPoll::Completed {
                helper_pid: self.helper_pid,
                output,
            }),
        }
    }

    fn collect_events(&mut self) {
        loop {
            match self.receiver.try_recv() {
                Ok(HelperEvent::InputWritten(written)) => {
                    if self.input_complete.replace(written).is_some() || !written {
                        self.failure
                            .get_or_insert("development candidate helper request transport failed");
                    }
                }
                Ok(HelperEvent::OutputRead(Ok(output))) => {
                    self.output_complete = true;
                    if self.output.replace(output).is_some() {
                        self.failure.get_or_insert(
                            "development candidate helper output completed more than once",
                        );
                    }
                }
                Ok(HelperEvent::OutputRead(Err(()))) => {
                    self.output_complete = true;
                    self.failure.get_or_insert(
                        "development candidate helper output failed or exceeded its limit",
                    );
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    let input_missing = self.input_complete.is_none();
                    let output_missing = !self.output_complete;
                    if input_missing {
                        self.input_complete = Some(false);
                    }
                    if output_missing {
                        self.output_complete = true;
                    }
                    if input_missing || output_missing {
                        self.failure.get_or_insert(
                            "development candidate helper transport channel closed early",
                        );
                    }
                    break;
                }
            }
        }
    }

    fn reconcile_finished_transports(&mut self) {
        if self.writer.as_ref().is_some_and(JoinHandle::is_finished) {
            let writer = self
                .writer
                .take()
                .expect("finished writer handle is present");
            if writer.join().is_err() {
                self.failure
                    .get_or_insert("development candidate helper input transport panicked");
            }
            self.collect_events();
            if self.input_complete.is_none() {
                self.input_complete = Some(false);
                self.failure.get_or_insert(
                    "development candidate helper input transport ended without acknowledgement",
                );
            }
        }
        if self.reader.as_ref().is_some_and(JoinHandle::is_finished) {
            let reader = self
                .reader
                .take()
                .expect("finished reader handle is present");
            if reader.join().is_err() {
                self.failure
                    .get_or_insert("development candidate helper output transport panicked");
            }
            self.collect_events();
            if !self.output_complete {
                self.output_complete = true;
                self.failure.get_or_insert(
                    "development candidate helper output transport ended without acknowledgement",
                );
            }
        }
    }

    fn unconfirmed_or_pending(&self) -> HelperPoll {
        match self.cleanup_deadline {
            Some(deadline) if Instant::now() >= deadline => HelperPoll::Unconfirmed {
                helper_pid: self.helper_pid,
                reason: self
                    .failure
                    .unwrap_or("development candidate helper cleanup remains unconfirmed"),
            },
            _ => HelperPoll::Pending,
        }
    }

    fn request_termination(&mut self) {
        if self.kill_requested || self.exit_status.is_some() {
            return;
        }
        let Some(child) = self.child.as_mut() else {
            return;
        };
        match child.kill() {
            Ok(()) => self.kill_requested = true,
            Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => {
                self.kill_requested = true;
            }
            Err(_) => {}
        }
    }

    fn join_transports(&mut self) -> Result<()> {
        let writer = self.writer.take();
        let reader = self.reader.take();
        let writer_panicked = writer.is_some_and(|thread| thread.join().is_err());
        let reader_panicked = reader.is_some_and(|thread| thread.join().is_err());
        if writer_panicked || reader_panicked {
            bail!("development candidate helper transport panicked");
        }
        Ok(())
    }
}

impl Drop for CandidateHelperProcess {
    fn drop(&mut self) {
        if self.terminal {
            return;
        }
        let mut exit_confirmed = self.exit_status.is_some();
        if !exit_confirmed {
            if let Some(child) = self.child.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        self.exit_status = Some(status);
                        exit_confirmed = true;
                    }
                    Ok(None) | Err(_) => {
                        let _ = child.kill();
                        let deadline = Instant::now() + Duration::from_millis(500);
                        while Instant::now() < deadline {
                            match child.try_wait() {
                                Ok(Some(status)) => {
                                    self.exit_status = Some(status);
                                    exit_confirmed = true;
                                    break;
                                }
                                Ok(None) | Err(_) => thread::sleep(Duration::from_millis(10)),
                            }
                        }
                    }
                }
            }
        }
        self.collect_events();
        self.reconcile_finished_transports();
        let transports_confirmed = self.writer.is_none() && self.reader.is_none();
        if !exit_confirmed || !transports_confirmed {
            eprintln!(
                "[fullmag] candidate preparation helper cleanup remains unconfirmed for pid {} (process_exit_confirmed={}, transports_confirmed={})",
                self.helper_pid, exit_confirmed, transports_confirmed
            );
        }
    }
}

fn read_bounded_output(stdout: impl Read, output_limit: usize) -> std::result::Result<Vec<u8>, ()> {
    let mut output = Vec::new();
    stdout
        .take((output_limit + 1) as u64)
        .read_to_end(&mut output)
        .map_err(|_| ())?;
    if output.len() > output_limit {
        return Err(());
    }
    Ok(output)
}
