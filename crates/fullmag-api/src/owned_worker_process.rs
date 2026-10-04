//! A Windows worker cannot start solver descendants before job assignment.
use std::io;
use std::ops::{Deref, DerefMut};
use std::process::{Child, Command, ExitStatus};

#[cfg(windows)]
#[path = "worker_startup_gate.rs"]
mod startup_gate;

pub(super) struct OwnedWorkerProcess {
    child: Child,
    startup_failure: Option<String>,
    #[cfg(windows)]
    job: Option<WindowsJob>,
}

impl OwnedWorkerProcess {
    pub(super) fn spawn(command: &mut Command) -> io::Result<Self> {
        #[cfg(windows)]
        {
            use std::process::Stdio;
            let job = WindowsJob::new()?;
            command
                .arg(startup_gate::STARTUP_GATE_FLAG)
                .arg(startup_gate::STARTUP_GATE_VERSION)
                .stdin(Stdio::piped());
            Self::spawn_in_job(command, job)
        }
        #[cfg(not(windows))]
        {
            Ok(Self {
                child: command.spawn()?,
                startup_failure: None,
            })
        }
    }

    #[cfg(windows)]
    fn spawn_in_job(command: &mut Command, job: WindowsJob) -> io::Result<Self> {
        use std::io::Write;
        let mut child = command.spawn()?;
        if let Err(error) = job.assign(&child) {
            // The worker is still at the stdin barrier and has no solver.
            drop(child.stdin.take());
            let _ = child.kill();
            if let Err(cleanup) = child.wait() {
                return Err(io::Error::new(
                    error.kind(),
                    format!(
                        "job assignment failed: {error}; gated worker cleanup failed: {cleanup}"
                    ),
                ));
            }
            return Ok(Self {
                child,
                job: Some(job),
                startup_failure: Some(format!(
                    "job assignment failed before startup release: {error}"
                )),
            });
        }
        let mut owned = Self {
            child,
            job: Some(job),
            startup_failure: None,
        };
        let release = owned
            .child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("worker startup pipe is unavailable"))
            .and_then(|mut pipe| pipe.write_all(&[startup_gate::STARTUP_GATE_RELEASE]));
        if let Err(error) = release {
            let _ = owned.kill();
            if let Err(cleanup) = owned.wait() {
                return Err(io::Error::new(
                    error.kind(),
                    format!("startup release failed: {error}; tree cleanup failed: {cleanup}"),
                ));
            }
            owned.startup_failure = Some(format!("worker startup release failed: {error}"));
        }
        Ok(owned)
    }

    pub(super) fn take_startup_failure(&mut self) -> Option<String> {
        self.startup_failure.take()
    }

    pub(super) fn kill(&mut self) -> io::Result<()> {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            return job.terminate();
        }
        self.child.kill()
    }

    pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        if status.is_some() {
            self.finish_tree().map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!(
                        "worker root exit {status:?}; process-tree cleanup is unconfirmed: {error}"
                    ),
                )
            })?;
        }
        Ok(status)
    }

    pub(super) fn wait(&mut self) -> io::Result<ExitStatus> {
        let status = self.child.wait()?;
        self.finish_tree().map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("worker root exit {status}; process-tree cleanup is unconfirmed: {error}"),
            )
        })?;
        Ok(status)
    }

    fn finish_tree(&mut self) -> io::Result<()> {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            // Close descendant pipe writers before the supervisor joins its
            // stdout/stderr readers, including after a root-only normal exit.
            job.terminate()?;
            self.job.take();
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn unowned_test_fixture(child: Child) -> Self {
        Self {
            child,
            startup_failure: None,
            #[cfg(windows)]
            job: None,
        }
    }
}

impl Deref for OwnedWorkerProcess {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}

impl DerefMut for OwnedWorkerProcess {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

#[cfg(windows)]
struct WindowsJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
    finished: std::cell::Cell<bool>,
}

#[cfg(windows)]
impl WindowsJob {
    fn new() -> io::Result<Self> {
        use windows_sys::Win32::System::JobObjects::*;
        // An unnamed, non-inheritable handle belongs only to this supervisor.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self {
            handle,
            finished: std::cell::Cell::new(false),
        };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let success = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if success == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    fn assign(&self, child: &Child) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        let success = unsafe {
            windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(
                self.handle,
                child.as_raw_handle(),
            )
        };
        if success == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn terminate(&self) -> io::Result<()> {
        if self.finished.get() {
            return Ok(());
        }
        if self.active_processes()? == 0 {
            self.finished.set(true);
            return Ok(());
        }
        if unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle, 1) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if self.active_processes()? == 0 {
                self.finished.set(true);
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "worker job still has active descendants",
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    fn active_processes(&self) -> io::Result<u32> {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        };
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let success = unsafe {
            QueryInformationJobObject(
                self.handle,
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&accounting) as u32,
                std::ptr::null_mut(),
            )
        };
        if success == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(accounting.ActiveProcesses)
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::path::PathBuf;
    use std::process::Stdio;
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    struct ProcessHandle(windows_sys::Win32::Foundation::HANDLE);
    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    #[test]
    fn kill_normal_exit_and_owner_drop_end_solver_descendants() {
        let directory =
            std::env::temp_dir().join(format!("fullmag-job-tree-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let fixture = directory.join("gated-worker.ps1");
        std::fs::write(&fixture, r#"
$ErrorActionPreference = 'Stop'
if ([Console]::OpenStandardInput().ReadByte() -ne 1) { exit 17 }
$child = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 60') -WindowStyle Hidden -PassThru
[Console]::Out.WriteLine($child.Id)
[Console]::Out.Flush()
if ($env:FULLMAG_TEST_ROOT_EXIT -eq 'true') { exit 0 }
Start-Sleep -Seconds 60
"#).unwrap();
        let powershell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        for mode in ["kill", "normal-exit", "drop"] {
            let mut command = Command::new(&powershell);
            command
                .args([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(&fixture)
                .env(
                    "FULLMAG_TEST_ROOT_EXIT",
                    if mode == "normal-exit" {
                        "true"
                    } else {
                        "false"
                    },
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit());
            // The fixture implements the same stdin barrier without worker CLI flags.
            let mut owned =
                OwnedWorkerProcess::spawn_in_job(&mut command, WindowsJob::new().unwrap()).unwrap();
            let stdout = owned.stdout.take().unwrap();
            let (sender, receiver) = std::sync::mpsc::channel();
            let reader = std::thread::spawn(move || {
                let mut line = String::new();
                let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
                let _ = sender.send(result);
            });
            let line = receiver
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap()
                .unwrap();
            reader.join().unwrap();
            let pid = line.trim().parse::<u32>().unwrap();
            let descendant = ProcessHandle(unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) });
            assert!(!descendant.0.is_null());
            match mode {
                "kill" => {
                    owned.kill().unwrap();
                    owned.kill().unwrap();
                    owned.wait().unwrap();
                    drop(owned);
                }
                "normal-exit" => {
                    assert!(owned.wait().unwrap().success());
                    drop(owned);
                }
                _ => drop(owned),
            }
            assert_eq!(
                unsafe { WaitForSingleObject(descendant.0, 10_000) },
                WAIT_OBJECT_0,
                "descendant survived {mode}"
            );
        }
        std::fs::remove_file(fixture).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
