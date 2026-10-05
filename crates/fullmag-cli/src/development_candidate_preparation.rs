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
    OutputRead(BoundedOutput),
    ProbeOutputChunk(Vec<u8>),
    ProbeOutputFinished {
        exceeded_limit: bool,
        read_failed: bool,
    },
}

struct BoundedOutput {
    bytes: Vec<u8>,
    exceeded_limit: bool,
    read_failed: bool,
}

pub(crate) enum HelperPoll {
    Pending,
    Completed {
        helper_pid: u32,
        exit_code: Option<i32>,
        output: Vec<u8>,
    },
    Unconfirmed {
        helper_pid: u32,
        reason: &'static str,
    },
    Failed {
        helper_pid: u32,
        exit_code: Option<i32>,
        input_complete: bool,
        output: Vec<u8>,
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
    output_limit: usize,
    probe_case: bool,
    probe_tail_after_exit: Option<mpsc::SyncSender<()>>,
    input_complete: Option<bool>,
    output: Vec<u8>,
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
        Self::spawn_with_probe_case(
            python,
            helper,
            repo_root,
            request,
            output_limit,
            deadline,
            name,
            None,
        )
    }

    pub(crate) fn spawn_probe_case(
        python: &Path,
        helper: &Path,
        repo_root: &Path,
        request: Vec<u8>,
        output_limit: usize,
        deadline: Instant,
        name: &'static str,
        probe_case: &str,
    ) -> Result<Self> {
        Self::spawn_with_probe_case(
            python,
            helper,
            repo_root,
            request,
            output_limit,
            deadline,
            name,
            Some(probe_case),
        )
    }

    fn spawn_with_probe_case(
        python: &Path,
        helper: &Path,
        repo_root: &Path,
        request: Vec<u8>,
        output_limit: usize,
        deadline: Instant,
        name: &'static str,
        probe_case: Option<&str>,
    ) -> Result<Self> {
        let probe_case_enabled = probe_case.is_some();
        if request.len() > MAX_CANDIDATE_HELPER_REQUEST_BYTES
            || output_limit > MAX_CANDIDATE_HELPER_OUTPUT_BYTES
        {
            bail!("candidate helper transport exceeds its byte limit");
        }
        // This fixture forces a real broken pipe independently of Windows'
        // pipe buffer size. Production input remains one write_all operation.
        let incomplete_prefix = if probe_case == Some("incomplete_stdin") {
            let marker = b"\"padding\":\"";
            let offset = request
                .windows(marker.len())
                .position(|bytes| bytes == marker)
                .context("incomplete stdin probe request has no padded prefix")?;
            let prefix = offset + marker.len();
            if prefix >= request.len() {
                bail!("incomplete stdin probe request has no remaining payload");
            }
            Some(prefix)
        } else {
            None
        };
        let (tail_signal, tail_ready) = if incomplete_prefix.is_some() {
            let (signal, ready) = mpsc::sync_channel::<()>(1);
            (Some(signal), Some(ready))
        } else {
            (None, None)
        };
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
        if let Some(probe_case) = probe_case {
            command.env("FULLMAG_CANDIDATE_HELPER_PROBE_CASE", probe_case);
        } else {
            command.env_remove("FULLMAG_CANDIDATE_HELPER_PROBE_CASE");
        }
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
                            match (incomplete_prefix, tail_ready) {
                                (Some(prefix), Some(ready)) => {
                                    stdin.write_all(&request[..prefix]).is_ok()
                                        && ready.recv_timeout(Duration::from_secs(3)).is_ok()
                                        && stdin.write_all(&request[prefix..]).is_ok()
                                }
                                (None, None) => stdin.write_all(&request).is_ok(),
                                _ => false,
                            }
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
                        if probe_case_enabled {
                            read_probe_output(stdout, output_limit, output_sender);
                        } else {
                            let output = read_bounded_output(stdout, output_limit);
                            let _ = output_sender.send(HelperEvent::OutputRead(output));
                        }
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
            output_limit,
            probe_case: probe_case_enabled,
            probe_tail_after_exit: tail_signal,
            input_complete,
            output: Vec::new(),
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

    pub(crate) fn probe_output(&self) -> Option<&[u8]> {
        self.probe_case.then_some(self.output.as_slice())
    }

    pub(crate) fn probe_input_complete(&self) -> Option<bool> {
        self.probe_case.then_some(self.input_complete).flatten()
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
            // Only the incomplete-input fixture delays its tail until actual
            // process exit. An ACK alone races with failure-triggered kill.
            if let Some(signal) = self.probe_tail_after_exit.take() {
                let _ = signal.try_send(());
            }
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
        let output = std::mem::take(&mut self.output);
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
                input_complete,
                output,
                reason,
            }),
            None => Ok(HelperPoll::Completed {
                helper_pid: self.helper_pid,
                exit_code: status.code(),
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
                Ok(HelperEvent::OutputRead(output)) => {
                    let BoundedOutput {
                        bytes,
                        exceeded_limit,
                        read_failed,
                    } = output;
                    if self.output_complete {
                        self.failure.get_or_insert(
                            "development candidate helper output completed more than once",
                        );
                    }
                    self.output_complete = true;
                    self.output = bytes;
                    if exceeded_limit {
                        self.failure.get_or_insert(
                            "development candidate helper output exceeded its limit",
                        );
                    }
                    if read_failed {
                        self.failure
                            .get_or_insert("development candidate helper output read failed");
                    }
                }
                Ok(HelperEvent::ProbeOutputChunk(chunk)) => {
                    if !self.probe_case {
                        self.failure
                            .get_or_insert("production helper received probe output progress");
                    }
                    let remaining = self
                        .output_limit
                        .saturating_add(1)
                        .saturating_sub(self.output.len());
                    if chunk.len() > remaining {
                        self.failure.get_or_insert(
                            "development candidate helper output exceeded its limit",
                        );
                    }
                    self.output
                        .extend_from_slice(&chunk[..chunk.len().min(remaining)]);
                }
                Ok(HelperEvent::ProbeOutputFinished {
                    exceeded_limit,
                    read_failed,
                }) => {
                    if !self.probe_case || self.output_complete {
                        self.failure.get_or_insert(
                            "development candidate helper probe output completed unexpectedly",
                        );
                    }
                    self.output_complete = true;
                    if exceeded_limit {
                        self.failure.get_or_insert(
                            "development candidate helper output exceeded its limit",
                        );
                    }
                    if read_failed {
                        self.failure
                            .get_or_insert("development candidate helper output read failed");
                    }
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

fn read_bounded_output(mut stdout: impl Read, output_limit: usize) -> BoundedOutput {
    let mut bytes = Vec::new();
    let mut exceeded_limit = false;
    let mut read_failed = false;
    let mut buffer = [0u8; 4096];
    loop {
        let remaining = output_limit.saturating_add(1).saturating_sub(bytes.len());
        if remaining == 0 {
            exceeded_limit = true;
            break;
        }
        let read_limit = buffer.len().min(remaining);
        match stdout.read(&mut buffer[..read_limit]) {
            Ok(0) => break,
            Ok(count) => {
                bytes.extend_from_slice(&buffer[..count]);
                if bytes.len() > output_limit {
                    exceeded_limit = true;
                    break;
                }
            }
            Err(_) => {
                read_failed = true;
                break;
            }
        }
    }
    BoundedOutput {
        bytes,
        exceeded_limit,
        read_failed,
    }
}

fn read_probe_output(
    mut stdout: impl Read,
    output_limit: usize,
    sender: mpsc::Sender<HelperEvent>,
) {
    let mut bytes_read = 0usize;
    let mut exceeded_limit = false;
    let mut read_failed = false;
    let mut buffer = [0u8; 1024];
    loop {
        let remaining = output_limit.saturating_add(1).saturating_sub(bytes_read);
        if remaining == 0 {
            exceeded_limit = true;
            break;
        }
        let read_limit = buffer.len().min(remaining);
        match stdout.read(&mut buffer[..read_limit]) {
            Ok(0) => break,
            Ok(count) => {
                bytes_read += count;
                if sender
                    .send(HelperEvent::ProbeOutputChunk(buffer[..count].to_vec()))
                    .is_err()
                {
                    return;
                }
                // The incomplete-input fixture closes stdin before its ACK.
                // Only then allow the writer to attempt the remaining bytes.
                if bytes_read > output_limit {
                    exceeded_limit = true;
                    break;
                }
            }
            Err(_) => {
                read_failed = true;
                break;
            }
        }
    }
    let _ = sender.send(HelperEvent::ProbeOutputFinished {
        exceeded_limit,
        read_failed,
    });
}
