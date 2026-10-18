//! A Windows worker cannot start solver descendants before job assignment.
use std::collections::BTreeSet;
use std::io;
use std::ops::{Deref, DerefMut};
use std::process::{Child, Command, ExitStatus};

#[cfg(target_os = "linux")]
pub(super) use fullmag_runtime_control::worker_cgroup::LinuxWorkerCgroup;
#[cfg(not(target_os = "linux"))]
pub(super) struct LinuxWorkerCgroup;

#[cfg(windows)]
#[path = "worker_startup_gate.rs"]
mod startup_gate;

pub(super) struct OwnedWorkerProcess {
    child: Child,
    startup_failure: Option<String>,
    #[cfg(target_os = "linux")]
    linux_cgroup: Option<LinuxWorkerCgroup>,
    #[cfg(windows)]
    job: Option<WindowsJob>,
}

impl OwnedWorkerProcess {
    pub(super) fn spawn(
        command: &mut Command,
        cpu_ids: &BTreeSet<u32>,
        cpu_rate_limit: Option<u32>,
        linux_cgroup: Option<LinuxWorkerCgroup>,
    ) -> io::Result<Self> {
        #[cfg(windows)]
        {
            use std::process::Stdio;
            let _ = linux_cgroup;
            if !cpu_ids.is_empty() && cpu_rate_limit.is_none() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "pinned worker CPU allocation requires a hard Job Object CPU rate limit",
                ));
            }
            let job = WindowsJob::new(cpu_rate_limit)?;
            command
                .arg(startup_gate::STARTUP_GATE_FLAG)
                .arg(startup_gate::STARTUP_GATE_VERSION)
                .stdin(Stdio::piped());
            Self::spawn_in_job(command, job, cpu_ids)
        }
        #[cfg(not(windows))]
        {
            let _ = cpu_rate_limit;
            configure_cpu_affinity(command, cpu_ids)?;
            #[cfg(target_os = "linux")]
            if let Some(cgroup) = &linux_cgroup {
                cgroup.attach_to(command)?;
            }
            #[cfg(not(target_os = "linux"))]
            let _ = linux_cgroup;
            let mut child = command.spawn()?;
            #[cfg(target_os = "linux")]
            if let Some(cgroup) = &linux_cgroup {
                match cgroup.contains_pid(child.id()) {
                    Ok(true) => {}
                    Ok(false) => match child.try_wait() {
                        Ok(Some(_)) => {
                            // A short-lived worker may leave cgroup.procs before
                            // the parent reads it. The pre-exec migration itself
                            // succeeded or Command::spawn would have failed.
                        }
                        Ok(None) => {
                            return Err(cleanup_failed_linux_worker_spawn(
                                child,
                                cgroup,
                                io::Error::new(
                                    io::ErrorKind::PermissionDenied,
                                    "worker is not present in its assigned CPU quota cgroup",
                                ),
                            ));
                        }
                        Err(error) => {
                            return Err(cleanup_failed_linux_worker_spawn(child, cgroup, error));
                        }
                    },
                    Err(error) => {
                        return Err(cleanup_failed_linux_worker_spawn(child, cgroup, error));
                    }
                }
            }
            Ok(Self {
                child,
                startup_failure: None,
                #[cfg(target_os = "linux")]
                linux_cgroup,
            })
        }
    }

    #[cfg(windows)]
    fn spawn_in_job(
        command: &mut Command,
        job: WindowsJob,
        cpu_ids: &BTreeSet<u32>,
    ) -> io::Result<Self> {
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
        if let Err(error) = job.set_cpu_affinity(cpu_ids) {
            // The worker is still at the stdin barrier and has no solver.
            drop(child.stdin.take());
            let _ = child.kill();
            if let Err(cleanup) = child.wait() {
                return Err(io::Error::new(
                    error.kind(),
                    format!(
                        "CPU affinity failed before startup release: {error}; gated worker cleanup failed: {cleanup}"
                    ),
                ));
            }
            return Ok(Self {
                child,
                job: Some(job),
                startup_failure: Some(format!(
                    "CPU affinity failed before startup release: {error}"
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
        #[cfg(target_os = "linux")]
        if let Some(cgroup) = &self.linux_cgroup {
            return cgroup.terminate_and_remove();
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
        #[cfg(target_os = "linux")]
        if let Some(cgroup) = &self.linux_cgroup {
            cgroup.terminate_and_remove()?;
            self.linux_cgroup.take();
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn unowned_test_fixture(child: Child) -> Self {
        Self {
            child,
            startup_failure: None,
            #[cfg(target_os = "linux")]
            linux_cgroup: None,
            #[cfg(windows)]
            job: None,
        }
    }
}

#[cfg(target_os = "linux")]
fn cleanup_failed_linux_worker_spawn(
    mut child: Child,
    cgroup: &LinuxWorkerCgroup,
    error: io::Error,
) -> io::Error {
    let first_cgroup_cleanup = cgroup.terminate_and_remove();
    if first_cgroup_cleanup.is_err() {
        let _ = child.kill();
    }
    let child_reap = child.wait();
    let final_cgroup_cleanup = cgroup.terminate_and_remove();
    let mut message = format!("verify Linux worker quota cgroup membership: {error}");
    if let Err(cleanup) = first_cgroup_cleanup {
        message.push_str(&format!("; initial cgroup cleanup failed: {cleanup}"));
    }
    if let Err(reap) = child_reap {
        message.push_str(&format!("; worker reap failed: {reap}"));
    }
    if let Err(cleanup) = final_cgroup_cleanup {
        message.push_str(&format!("; final cgroup cleanup failed: {cleanup}"));
    }
    io::Error::new(error.kind(), message)
}

/// Convert a milli-CPU allocation into the Windows Job Object hard-cap scale.
/// Windows accepts a percentage of effective processor capacity in 1/100th
/// percent units; rounding down prevents the OS limit from exceeding the lease.
#[cfg(any(windows, test))]
pub(crate) fn cpu_rate_limit(cpu_millis: u64, effective_capacity_millis: u64) -> io::Result<u32> {
    if cpu_millis == 0 || effective_capacity_millis == 0 || cpu_millis > effective_capacity_millis
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "worker CPU budget must be positive and no greater than current effective capacity",
        ));
    }
    let rate = u128::from(cpu_millis) * 10_000 / u128::from(effective_capacity_millis);
    let rate = u32::try_from(rate).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "Windows CPU rate is out of range")
    })?;
    if rate == 0 || rate > 10_000 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "worker CPU budget is below Windows Job Object quota precision",
        ));
    }
    Ok(rate)
}

#[cfg(test)]
mod cpu_rate_limit_tests {
    use super::cpu_rate_limit;

    #[test]
    fn converts_fractional_cpu_budget_to_windows_hard_cap_units() {
        assert_eq!(cpu_rate_limit(2_500, 8_000).unwrap(), 3_125);
        assert_eq!(cpu_rate_limit(1, 3).unwrap(), 3_333);
        assert_eq!(cpu_rate_limit(8_000, 8_000).unwrap(), 10_000);
    }

    #[test]
    fn rejects_unusable_or_out_of_range_cpu_budgets() {
        assert!(cpu_rate_limit(0, 8_000).is_err());
        assert!(cpu_rate_limit(1, 0).is_err());
        assert!(cpu_rate_limit(8_001, 8_000).is_err());
        assert!(cpu_rate_limit(1, 1_000_000).is_err());
    }
}

#[cfg(target_os = "linux")]
fn configure_cpu_affinity(command: &mut Command, cpu_ids: &BTreeSet<u32>) -> io::Result<()> {
    use std::os::unix::process::CommandExt;

    if cpu_ids.is_empty() {
        return Ok(());
    }
    let words = linux_cpu_affinity_words(cpu_ids, linux_kernel_affinity_mask_bytes()?)?;
    let byte_len = words
        .len()
        .checked_mul(std::mem::size_of::<usize>())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "CPU mask size overflow"))?;
    let mut observed_words = vec![0usize; words.len()];
    unsafe {
        command.pre_exec(move || {
            if libc::sched_setaffinity(0, byte_len, words.as_ptr().cast()) == -1 {
                return Err(io::Error::last_os_error());
            }
            if libc::sched_getaffinity(0, byte_len, observed_words.as_mut_ptr().cast()) == -1 {
                return Err(io::Error::last_os_error());
            }
            if observed_words != words {
                return Err(io::Error::from_raw_os_error(libc::EINVAL));
            }
            Ok(())
        });
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_kernel_affinity_mask_bytes() -> io::Result<usize> {
    const MAX_CPU_AFFINITY_BYTES: usize = 16 * 1024 * 1024;
    let mut byte_len = std::mem::size_of::<usize>();
    loop {
        let word_count = byte_len.div_ceil(std::mem::size_of::<usize>());
        let mut mask = vec![0usize; word_count];
        let result = unsafe {
            libc::sched_getaffinity(0, byte_len, mask.as_mut_ptr().cast())
        };
        if result == 0 {
            return Ok(byte_len);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINVAL) {
            return Err(error);
        }
        if byte_len >= MAX_CPU_AFFINITY_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "kernel CPU affinity mask exceeds the supported bound",
            ));
        }
        byte_len = byte_len
            .checked_mul(2)
            .unwrap_or(MAX_CPU_AFFINITY_BYTES)
            .min(MAX_CPU_AFFINITY_BYTES);
    }
}

#[cfg(target_os = "linux")]
fn linux_cpu_affinity_words(
    cpu_ids: &BTreeSet<u32>,
    minimum_bytes: usize,
) -> io::Result<Vec<usize>> {
    const MAX_CPU_AFFINITY_BYTES: usize = 16 * 1024 * 1024;
    let Some(max_cpu_id) = cpu_ids.iter().next_back().copied() else {
        return Ok(Vec::new());
    };
    let max_cpu_id = usize::try_from(max_cpu_id)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "CPU ID exceeds usize"))?;
    let word_bits = usize::BITS as usize;
    let requested_word_count = max_cpu_id
        .checked_div(word_bits)
        .and_then(|word| word.checked_add(1))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "CPU mask size overflow"))?;
    let minimum_word_count = minimum_bytes.div_ceil(std::mem::size_of::<usize>());
    let word_count = requested_word_count.max(minimum_word_count);
    let byte_len = word_count
        .checked_mul(std::mem::size_of::<usize>())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "CPU mask size overflow"))?;
    if byte_len > MAX_CPU_AFFINITY_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "CPU affinity mask exceeds the supported bound",
        ));
    }
    let mut words = vec![0usize; word_count];
    for cpu_id in cpu_ids {
        let cpu_id = usize::try_from(*cpu_id)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "CPU ID exceeds usize"))?;
        words[cpu_id / word_bits] |= 1usize << (cpu_id % word_bits);
    }
    Ok(words)
}

#[cfg(all(test, target_os = "linux"))]
mod linux_cpu_affinity_tests {
    use super::{linux_cpu_affinity_words, linux_kernel_affinity_mask_bytes, OwnedWorkerProcess};
    use std::collections::BTreeSet;
    use std::process::{Command, Stdio};

    #[test]
    fn cpu_ids_form_a_dynamic_mask_with_the_kernel_minimum_width() {
        let second_word_cpu = usize::BITS + 1;
        let words = linux_cpu_affinity_words(
            &BTreeSet::from([0, second_word_cpu]),
            std::mem::size_of::<usize>(),
        )
        .unwrap();
        assert_eq!(words, vec![1, 2]);

        let words = linux_cpu_affinity_words(
            &BTreeSet::from([0]),
            2 * std::mem::size_of::<usize>(),
        )
        .unwrap();
        assert_eq!(words, vec![1, 0]);
    }

    #[test]
    fn cpu_affinity_mask_rejects_unbounded_cpu_ids() {
        assert!(linux_cpu_affinity_words(
            &BTreeSet::from([u32::MAX]),
            std::mem::size_of::<usize>(),
        )
        .is_err());
    }

    #[test]
    fn spawned_process_observes_the_exact_requested_affinity_mask() {
        let byte_len = linux_kernel_affinity_mask_bytes().unwrap();
        let word_count = byte_len.div_ceil(std::mem::size_of::<usize>());
        let mut allowed_words = vec![0usize; word_count];
        assert_eq!(
            unsafe { libc::sched_getaffinity(0, byte_len, allowed_words.as_mut_ptr().cast()) },
            0,
            "read current allowed CPU mask"
        );
        let cpu_id = allowed_words
            .iter()
            .enumerate()
            .find_map(|(word_index, word)| {
                (*word != 0).then(|| {
                    u32::try_from(
                        word_index * usize::BITS as usize + word.trailing_zeros() as usize,
                    )
                    .unwrap()
                })
            })
            .expect("current process must have an allowed CPU");
        let requested_cpu_ids = BTreeSet::from([cpu_id]);
        let expected_words = linux_cpu_affinity_words(&requested_cpu_ids, byte_len).unwrap();
        let mut command = Command::new("sh");
        command
            .args(["-c", "exec sleep 5"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let mut worker =
            OwnedWorkerProcess::spawn(&mut command, &requested_cpu_ids, None, None).unwrap();
        let mut observed_words = vec![0usize; word_count];
        let readback = unsafe {
            libc::sched_getaffinity(
                libc::pid_t::try_from(worker.id()).unwrap(),
                byte_len,
                observed_words.as_mut_ptr().cast(),
            )
        };
        let readback_error = (readback == -1).then(std::io::Error::last_os_error);
        let kill_result = worker.kill();
        let wait_result = worker.wait();

        assert_eq!(readback, 0, "read child CPU mask: {readback_error:?}");
        assert_eq!(observed_words, expected_words);
        kill_result.unwrap();
        wait_result.unwrap();
    }
}

#[cfg(all(not(windows), not(target_os = "linux")))]
fn configure_cpu_affinity(_command: &mut Command, cpu_ids: &BTreeSet<u32>) -> io::Result<()> {
    if cpu_ids.is_empty() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "CPU affinity enforcement is unsupported on this operating system",
        ))
    }
}

#[cfg(windows)]
fn windows_cpu_affinity_group_masks(
    cpu_ids: &BTreeSet<u32>,
) -> io::Result<Vec<WindowsGroupAffinity>> {
    let mut masks = std::collections::BTreeMap::<u16, usize>::new();
    for cpu_id in cpu_ids {
        let cpu_group = u16::try_from(*cpu_id / 64)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "CPU group exceeds u16"))?;
        let group_local_id = *cpu_id % 64;
        if group_local_id >= usize::BITS {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "CPU ID exceeds the process affinity mask width",
            ));
        }
        *masks.entry(cpu_group).or_default() |= 1usize << group_local_id;
    }
    Ok(masks
        .into_iter()
        .map(|(group, mask)| WindowsGroupAffinity {
            mask,
            group,
            reserved: [0; 3],
        })
        .collect())
}

#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct WindowsGroupAffinity {
    mask: usize,
    group: u16,
    reserved: [u16; 3],
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
    fn new(cpu_rate_limit: Option<u32>) -> io::Result<Self> {
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
        if let Some(cpu_rate_limit) = cpu_rate_limit {
            job.set_cpu_rate_limit(cpu_rate_limit)?;
        }
        Ok(job)
    }

    fn set_cpu_rate_limit(&self, cpu_rate: u32) -> io::Result<()> {
        const JOB_OBJECT_CPU_RATE_CONTROL_INFORMATION: i32 = 15;
        const JOB_OBJECT_CPU_RATE_CONTROL_ENABLE: u32 = 0x1;
        const JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP: u32 = 0x4;

        if !(1..=10_000).contains(&cpu_rate) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Windows Job Object CPU rate must be between 1 and 10000",
            ));
        }
        let requested = WindowsCpuRateControlInformation {
            control_flags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE
                | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
            cpu_rate,
        };
        let information_bytes = std::mem::size_of_val(&requested) as u32;
        let set = unsafe {
            windows_sys::Win32::System::JobObjects::SetInformationJobObject(
                self.handle,
                JOB_OBJECT_CPU_RATE_CONTROL_INFORMATION,
                (&requested as *const WindowsCpuRateControlInformation).cast(),
                information_bytes,
            )
        };
        if set == 0 {
            return Err(io::Error::last_os_error());
        }

        let mut observed = WindowsCpuRateControlInformation::default();
        let mut returned_bytes = 0u32;
        let query = unsafe {
            windows_sys::Win32::System::JobObjects::QueryInformationJobObject(
                self.handle,
                JOB_OBJECT_CPU_RATE_CONTROL_INFORMATION,
                (&mut observed as *mut WindowsCpuRateControlInformation).cast(),
                information_bytes,
                &mut returned_bytes,
            )
        };
        if query == 0 {
            return Err(io::Error::last_os_error());
        }
        if returned_bytes != information_bytes || observed != requested {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Windows job applied a different CPU rate limit than requested",
            ));
        }
        Ok(())
    }

    fn set_cpu_affinity(&self, cpu_ids: &BTreeSet<u32>) -> io::Result<()> {
        const JOB_OBJECT_GROUP_INFORMATION_EX: i32 = 14;

        let requested = windows_cpu_affinity_group_masks(cpu_ids)?;
        if requested.is_empty() {
            return Ok(());
        }
        let information_bytes = requested
            .len()
            .checked_mul(std::mem::size_of::<WindowsGroupAffinity>())
            .and_then(|bytes| u32::try_from(bytes).ok())
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "Windows CPU affinity size overflow")
            })?;
        let set = unsafe {
            windows_sys::Win32::System::JobObjects::SetInformationJobObject(
                self.handle,
                JOB_OBJECT_GROUP_INFORMATION_EX,
                requested.as_ptr().cast(),
                information_bytes,
            )
        };
        if set == 0 {
            return Err(io::Error::last_os_error());
        }

        let mut observed = vec![WindowsGroupAffinity::default(); requested.len()];
        let mut returned_bytes = 0u32;
        let query = unsafe {
            windows_sys::Win32::System::JobObjects::QueryInformationJobObject(
                self.handle,
                JOB_OBJECT_GROUP_INFORMATION_EX,
                observed.as_mut_ptr().cast(),
                information_bytes,
                &mut returned_bytes,
            )
        };
        if query == 0 {
            return Err(io::Error::last_os_error());
        }
        if returned_bytes != information_bytes || observed != requested {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Windows job applied a different CPU group affinity than requested",
            ));
        }
        Ok(())
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
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct WindowsCpuRateControlInformation {
    control_flags: u32,
    cpu_rate: u32,
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

    #[cfg(target_pointer_width = "64")]
    #[test]
    fn windows_cpu_affinity_maps_cpu_ids_across_processor_groups() {
        assert_eq!(
            windows_cpu_affinity_group_masks(&BTreeSet::new()).unwrap(),
            Vec::<WindowsGroupAffinity>::new()
        );
        assert_eq!(
            windows_cpu_affinity_group_masks(&BTreeSet::from([65, 67])).unwrap(),
            vec![WindowsGroupAffinity {
                mask: 0b1010,
                group: 1,
                reserved: [0; 3],
            }]
        );
        assert_eq!(
            windows_cpu_affinity_group_masks(&BTreeSet::from([63, 64])).unwrap(),
            vec![
                WindowsGroupAffinity {
                    mask: 1usize << 63,
                    group: 0,
                    reserved: [0; 3],
                },
                WindowsGroupAffinity {
                    mask: 1,
                    group: 1,
                    reserved: [0; 3],
                },
            ]
        );
        assert!(windows_cpu_affinity_group_masks(&BTreeSet::from([u32::MAX])).is_err());
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
            let mut owned = OwnedWorkerProcess::spawn_in_job(
                &mut command,
                WindowsJob::new(None).unwrap(),
                &BTreeSet::new(),
            )
            .unwrap();
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
