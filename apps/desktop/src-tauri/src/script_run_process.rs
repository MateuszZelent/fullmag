//! Process-tree control for a script run.
//!
//! A run is the `fullmag` CLI plus everything it starts (the Python helper, the
//! API, the web server). On Windows the CLI is assigned to a job object with
//! kill-on-close, so the whole tree ends when the host ends, crashes included,
//! and `kill` ends it on demand. Elsewhere the child leads its own process
//! group and is signalled as a group.

use std::io;
use std::process::{Child, Command};

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const STILL_ACTIVE: u32 = 259;

    pub fn configure(command: &mut Command) {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    pub struct ProcessTree {
        job: HANDLE,
    }

    // A job handle is a plain kernel handle; it may move between threads.
    unsafe impl Send for ProcessTree {}

    impl ProcessTree {
        pub fn adopt(child: &Child) -> io::Result<Self> {
            // SAFETY: plain Win32 calls with valid, owned handles; the job
            // handle is closed on every error path before returning.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let configured = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if configured == 0 {
                    let error = io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(error);
                }
                if AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
                    let error = io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(error);
                }
                Ok(Self { job })
            }
        }

        /// End every process of the tree.
        pub fn kill(&self) {
            // SAFETY: the job handle is valid until drop.
            unsafe {
                TerminateJobObject(self.job, 1);
            }
        }
    }

    impl Drop for ProcessTree {
        fn drop(&mut self) {
            // Closing the handle ends whatever is left (kill-on-close).
            // SAFETY: the handle is owned and closed once.
            unsafe {
                CloseHandle(self.job);
            }
        }
    }

    pub fn pid_alive(pid: u32) -> bool {
        // SAFETY: OpenProcess returns an owned handle or null.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok != 0 && code == STILL_ACTIVE
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    use std::os::unix::process::CommandExt;

    pub fn configure(command: &mut Command) {
        command.process_group(0);
    }

    pub struct ProcessTree {
        pgid: u32,
    }

    impl ProcessTree {
        pub fn adopt(child: &Child) -> io::Result<Self> {
            Ok(Self { pgid: child.id() })
        }

        pub fn kill(&self) {
            let _ = Command::new("kill")
                .args(["-KILL", "--", &format!("-{}", self.pgid)])
                .status();
        }
    }

    impl Drop for ProcessTree {
        fn drop(&mut self) {
            self.kill();
        }
    }

    pub fn pid_alive(pid: u32) -> bool {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

pub use imp::{configure, pid_alive, ProcessTree};
