//! Linux cgroup v2 CPU quota enforcement for an owned worker process.
//!
//! `FULLMAG_WORKER_CGROUP_ROOT` must name an already delegated cgroup v2
//! directory with the `cpu` controller both available and enabled for child
//! cgroups. The helper never enables controllers on the host's behalf and does
//! not fall back to affinity or environment hints when delegation is missing.
#![cfg(target_os = "linux")]

use std::ffi::{CStr, CString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use uuid::Uuid;

const ROOT_ENV: &str = "FULLMAG_WORKER_CGROUP_ROOT";
const CGROUP2_SUPER_MAGIC: u64 = 0x6367_7270;
const CPU_MAX_PERIOD_US: u64 = 100_000;
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const CLEANUP_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// A Linux worker's exact cgroup v2 child and the pre-opened attachment file.
///
/// Keep this value alive until the worker has exited and
/// [`terminate_and_remove`](Self::terminate_and_remove) succeeds. Dropping it
/// makes a best-effort bounded cleanup attempt.
pub struct LinuxWorkerCgroup {
    directory: OwnedCgroupDirectory,
    procs_file: File,
    attachment_configured: AtomicBool,
    removed: Mutex<bool>,
}

/// Prove that the configured delegation can create a child, enforce/read back
/// a real CPU quota, kill the empty cgroup, and remove that exact child.
pub fn probe_delegated_cpu_quota() -> io::Result<()> {
    let cgroup = LinuxWorkerCgroup::prepare(1_000)?;
    cgroup.terminate_and_remove()
}

impl LinuxWorkerCgroup {
    /// Create a unique child under `FULLMAG_WORKER_CGROUP_ROOT` and verify its
    /// hard quota before it can be attached to a worker.
    pub fn prepare(cpu_millis: u64) -> io::Result<Self> {
        let root = std::env::var_os(ROOT_ENV).filter(|value| !value.is_empty()).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("required delegated cgroup root {ROOT_ENV} is not configured"),
            )
        })?;
        Self::prepare_under(Path::new(&root), cpu_millis)
    }

    /// Register an async-signal-safe pre-exec hook which places the child PID
    /// into this cgroup before the worker executable starts.
    pub fn attach_to(&self, command: &mut Command) -> io::Result<()> {
        let removed = self.removed.lock().map_err(|_| poisoned_lock_error())?;
        if *removed {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "worker cgroup has already been removed",
            ));
        }
        self.directory.ensure_exact_path()?;
        self.attachment_configured
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "a worker cgroup attachment hook is already configured",
                )
            })?;

        // The closure captures only the already-open fd. Its child-side path
        // uses getpid, stack storage, and write; it allocates and locks nothing.
        let procs_fd = self.procs_file.as_raw_fd();
        unsafe {
            command.pre_exec(move || write_current_pid_to_cgroup(procs_fd));
        }
        drop(removed);
        Ok(())
    }

    /// Return whether `pid` appears in this exact cgroup's `cgroup.procs`.
    pub fn contains_pid(&self, pid: u32) -> io::Result<bool> {
        if pid == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "worker PID must be positive",
            ));
        }
        let removed = self.removed.lock().map_err(|_| poisoned_lock_error())?;
        if *removed {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "worker cgroup has already been removed",
            ));
        }
        self.directory.ensure_exact_path()?;
        let contents = read_control(&self.directory.child, "cgroup.procs")?;
        for line in contents.lines() {
            let observed = line.trim().parse::<u32>().map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid PID in worker cgroup.procs: {error}"),
                )
            })?;
            if observed == pid {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Kill all processes in this cgroup and descendants, wait a bounded time
    /// for `populated 0`, then remove only the child directory created here.
    pub fn terminate_and_remove(&self) -> io::Result<()> {
        let mut removed = self.removed.lock().map_err(|_| poisoned_lock_error())?;
        if *removed {
            return Ok(());
        }
        match self.directory.ensure_exact_path() {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                *removed = true;
                return Ok(());
            }
            Err(error) => return Err(error),
        }

        let mut kill = open_control(&self.directory.child, "cgroup.kill", libc::O_WRONLY)?;
        kill.write_all(b"1\n")?;

        let deadline = Instant::now() + CLEANUP_TIMEOUT;
        loop {
            let events = read_control(&self.directory.child, "cgroup.events")?;
            if !parse_cgroup_populated(&events)? {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "worker cgroup remained populated after cgroup.kill",
                ));
            }
            std::thread::sleep(
                CLEANUP_POLL_INTERVAL.min(deadline.saturating_duration_since(now)),
            );
        }

        self.directory.remove_exact()?;
        *removed = true;
        Ok(())
    }

    fn prepare_under(root: &Path, cpu_millis: u64) -> io::Result<Self> {
        let cpu_max = format_cpu_max(cpu_millis)?;
        let root_path = validate_root_path(root)?;
        let root_file = open_directory(&root_path)?;
        validate_delegated_root(&root_file)?;

        let (name, child_file, identity) = create_child_directory(&root_file, &root_path)?;
        let child_path = root_path.join(name.to_string_lossy().as_ref());
        let directory = OwnedCgroupDirectory {
            parent: root_file,
            child: child_file,
            name,
            path: child_path,
            identity,
        };
        let mut setup = SetupGuard::new(directory);

        let result = (|| {
            setup.directory().ensure_exact_path()?;
            require_cpu_controller(
                &read_control(&setup.directory().child, "cgroup.controllers")?,
                "new worker cgroup",
            )?;

            write_control(&setup.directory().child, "cpu.max", cpu_max.as_bytes())?;
            let observed = read_control(&setup.directory().child, "cpu.max")?;
            if parse_cpu_max(&observed)? != parse_cpu_max(&cpu_max)? {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "worker cgroup cpu.max readback mismatch: expected {:?}, got {:?}",
                        cpu_max.trim(),
                        observed.trim()
                    ),
                ));
            }

            // Opening all lifecycle controls here makes unavailable or
            // read-only cgroup.kill/cgroup.procs delegation fail before spawn.
            let procs = open_control(&setup.directory().child, "cgroup.procs", libc::O_WRONLY)?;
            let _kill = open_control(&setup.directory().child, "cgroup.kill", libc::O_WRONLY)?;
            let events = read_control(&setup.directory().child, "cgroup.events")?;
            if parse_cgroup_populated(&events)? {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "new worker cgroup is unexpectedly populated",
                ));
            }
            Ok(procs)
        })();

        match result {
            Ok(procs_file) => Ok(Self {
                directory: setup.disarm(),
                procs_file,
                attachment_configured: AtomicBool::new(false),
                removed: Mutex::new(false),
            }),
            Err(error) => Err(setup.cleanup_after(error)),
        }
    }
}

impl Drop for LinuxWorkerCgroup {
    fn drop(&mut self) {
        if self.attachment_configured.load(Ordering::Acquire) {
            let _ = self.terminate_and_remove();
        } else {
            let _ = self.remove_if_empty();
        }
    }
}

impl LinuxWorkerCgroup {
    fn remove_if_empty(&self) -> io::Result<()> {
        let mut removed = self.removed.lock().map_err(|_| poisoned_lock_error())?;
        if *removed {
            return Ok(());
        }
        match self.directory.ensure_exact_path() {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                *removed = true;
                return Ok(());
            }
            Err(error) => return Err(error),
        }
        if parse_cgroup_populated(&read_control(&self.directory.child, "cgroup.events")?)? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "refusing to remove an un-attached worker cgroup that is populated",
            ));
        }
        self.directory.remove_exact()?;
        *removed = true;
        Ok(())
    }
}

struct OwnedCgroupDirectory {
    parent: File,
    child: File,
    name: CString,
    path: PathBuf,
    identity: FileIdentity,
}

impl OwnedCgroupDirectory {
    fn ensure_exact_path(&self) -> io::Result<()> {
        let observed = identity_at(self.parent.as_raw_fd(), &self.name)?;
        if observed != self.identity {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "worker cgroup path {} no longer names the directory created by this process",
                    self.path.display()
                ),
            ));
        }
        Ok(())
    }

    fn remove_exact(&self) -> io::Result<()> {
        self.ensure_exact_path()?;
        let result = unsafe {
            libc::unlinkat(
                self.parent.as_raw_fd(),
                self.name.as_ptr(),
                libc::AT_REMOVEDIR,
            )
        };
        if result == -1 {
            let error = io::Error::last_os_error();
            return Err(io::Error::new(
                error.kind(),
                format!("remove owned worker cgroup {}: {error}", self.path.display()),
            ));
        }
        Ok(())
    }
}

struct SetupGuard {
    directory: Option<OwnedCgroupDirectory>,
}

impl SetupGuard {
    fn new(directory: OwnedCgroupDirectory) -> Self {
        Self {
            directory: Some(directory),
        }
    }

    fn directory(&self) -> &OwnedCgroupDirectory {
        self.directory
            .as_ref()
            .expect("setup guard owns its new cgroup until disarmed")
    }

    fn disarm(mut self) -> OwnedCgroupDirectory {
        self.directory
            .take()
            .expect("setup guard owns its new cgroup until disarmed")
    }

    fn cleanup_after(mut self, primary: io::Error) -> io::Error {
        let Some(directory) = self.directory.as_ref() else {
            return primary;
        };
        match directory.remove_exact() {
            Ok(()) => {
                self.directory.take();
                primary
            }
            Err(cleanup) => io::Error::new(
                primary.kind(),
                format!("{primary}; removing newly created cgroup also failed: {cleanup}"),
            ),
        }
    }
}

impl Drop for SetupGuard {
    fn drop(&mut self) {
        if let Some(directory) = self.directory.as_ref() {
            let _ = directory.remove_exact();
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    device: libc::dev_t,
    inode: libc::ino_t,
    file_type: libc::mode_t,
}

fn validate_root_path(root: &Path) -> io::Result<PathBuf> {
    if !root.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "delegated cgroup root must be an absolute path",
        ));
    }
    let metadata = fs::symlink_metadata(root)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "delegated cgroup root must be a real directory, not a symlink",
        ));
    }
    fs::canonicalize(root)
}

fn open_directory(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(path)
}

fn validate_delegated_root(root: &File) -> io::Result<()> {
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::zeroed();
    let result = unsafe { libc::fstatfs(root.as_raw_fd(), stat.as_mut_ptr()) };
    if result == -1 {
        return Err(io::Error::last_os_error());
    }
    let stat = unsafe { stat.assume_init() };
    if stat.f_type as u64 != CGROUP2_SUPER_MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "delegated worker root is not on a cgroup v2 filesystem",
        ));
    }
    require_cpu_controller(
        &read_control(root, "cgroup.controllers")?,
        "delegated cgroup root controllers",
    )?;
    require_cpu_controller(
        &read_control(root, "cgroup.subtree_control")?,
        "delegated cgroup root subtree_control",
    )
}

fn require_cpu_controller(contents: &str, source: &str) -> io::Result<()> {
    if contents
        .split_whitespace()
        .any(|controller| controller.strip_prefix('+').unwrap_or(controller) == "cpu")
    {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("{source} does not expose the delegated cpu controller"),
        ))
    }
}

fn create_child_directory(
    root: &File,
    root_path: &Path,
) -> io::Result<(CString, File, FileIdentity)> {
    for _ in 0..8 {
        let name = CString::new(format!("fullmag-worker-{}", Uuid::new_v4()))
            .expect("generated cgroup name has no NUL byte");
        let made = unsafe {
            libc::mkdirat(root.as_raw_fd(), name.as_ptr(), 0o700 as libc::mode_t)
        };
        if made == -1 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::AlreadyExists {
                continue;
            }
            return Err(io::Error::new(
                error.kind(),
                format!("create worker cgroup under {}: {error}", root_path.display()),
            ));
        }

        let identity = match identity_at(root.as_raw_fd(), &name) {
            Ok(identity) if identity.file_type == libc::S_IFDIR => identity,
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "new worker cgroup path was replaced before it could be opened",
                ));
            }
            Err(error) => return Err(error),
        };

        match open_at(
            root.as_raw_fd(),
            &name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        ) {
            Ok(child) => match file_identity(child.as_raw_fd()) {
                Ok(opened_identity) if opened_identity == identity => {
                    return Ok((name, child, identity));
                }
                Ok(_) => {
                    drop(child);
                    let error = io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "opened worker cgroup differs from the directory created here",
                    );
                    return Err(cleanup_creation_error(
                        error,
                        remove_created_directory(root, &name, identity),
                    ));
                }
                Err(error) => {
                    drop(child);
                    return Err(cleanup_creation_error(
                        error,
                        remove_created_directory(root, &name, identity),
                    ));
                }
            },
            Err(error) => {
                return Err(cleanup_creation_error(
                    error,
                    remove_created_directory(root, &name, identity),
                ));
            }
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique worker cgroup directory",
    ))
}

fn cleanup_creation_error(primary: io::Error, cleanup: io::Result<()>) -> io::Error {
    match cleanup {
        Ok(()) => primary,
        Err(cleanup) => io::Error::new(
            primary.kind(),
            format!("{primary}; removing newly created cgroup also failed: {cleanup}"),
        ),
    }
}

fn remove_created_directory(
    root: &File,
    name: &CStr,
    expected: FileIdentity,
) -> io::Result<()> {
    let observed = identity_at(root.as_raw_fd(), name)?;
    if observed != expected || observed.file_type != libc::S_IFDIR {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "new worker cgroup path no longer names its created directory",
        ));
    }
    let result = unsafe {
        libc::unlinkat(root.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR)
    };
    if result == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn identity_at(parent_fd: RawFd, name: &CStr) -> io::Result<FileIdentity> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    let result = unsafe {
        libc::fstatat(
            parent_fd,
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == -1 {
        return Err(io::Error::last_os_error());
    }
    let stat = unsafe { stat.assume_init() };
    Ok(identity_from_stat(&stat))
}

fn file_identity(fd: RawFd) -> io::Result<FileIdentity> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    let result = unsafe { libc::fstat(fd, stat.as_mut_ptr()) };
    if result == -1 {
        return Err(io::Error::last_os_error());
    }
    let stat = unsafe { stat.assume_init() };
    Ok(identity_from_stat(&stat))
}

fn identity_from_stat(stat: &libc::stat) -> FileIdentity {
    FileIdentity {
        device: stat.st_dev,
        inode: stat.st_ino,
        file_type: stat.st_mode & libc::S_IFMT,
    }
}

fn open_at(parent_fd: RawFd, name: &CStr, flags: libc::c_int) -> io::Result<File> {
    let fd = unsafe { libc::openat(parent_fd, name.as_ptr(), flags, 0) };
    if fd == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn open_control(directory: &File, name: &str, access: libc::c_int) -> io::Result<File> {
    let name = CString::new(name).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "cgroup control name contains NUL")
    })?;
    open_at(
        directory.as_raw_fd(),
        &name,
        access | libc::O_CLOEXEC | libc::O_NOFOLLOW,
    )
}

fn read_control(directory: &File, name: &str) -> io::Result<String> {
    let mut file = open_control(directory, name, libc::O_RDONLY)?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)?;
    Ok(contents)
}

fn write_control(directory: &File, name: &str, contents: &[u8]) -> io::Result<()> {
    open_control(directory, name, libc::O_WRONLY)?.write_all(contents)
}

fn format_cpu_max(cpu_millis: u64) -> io::Result<String> {
    if cpu_millis == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "worker CPU quota must be positive",
        ));
    }
    // 100000 us / 1000 milli-CPU is exactly 100 us per milli-CPU.
    let quota = cpu_millis.checked_mul(CPU_MAX_PERIOD_US / 1_000).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "worker CPU quota overflows cpu.max")
    })?;
    Ok(format!("{quota} {CPU_MAX_PERIOD_US}\n"))
}

fn parse_cpu_max(value: &str) -> io::Result<(u64, u64)> {
    let fields = value.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 2 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "cgroup v2 cpu.max must contain quota and period",
        ));
    }
    let quota = fields[0].parse::<u64>().map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("parse cgroup v2 CPU quota: {error}"),
        )
    })?;
    let period = fields[1].parse::<u64>().map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("parse cgroup v2 CPU period: {error}"),
        )
    })?;
    if quota == 0 || period == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "cgroup v2 CPU quota and period must be positive",
        ));
    }
    Ok((quota, period))
}

fn parse_cgroup_populated(value: &str) -> io::Result<bool> {
    let mut populated = None;
    for line in value.lines().filter(|line| !line.trim().is_empty()) {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.first().copied() != Some("populated") {
            continue;
        }
        if fields.len() != 2 || populated.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "cgroup.events has a malformed or duplicate populated entry",
            ));
        }
        populated = Some(match fields[1] {
            "0" => false,
            "1" => true,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "cgroup.events populated value must be 0 or 1",
                ));
            }
        });
    }
    populated.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "cgroup.events is missing its populated entry",
        )
    })
}

fn write_current_pid_to_cgroup(procs_fd: RawFd) -> io::Result<()> {
    // Command::pre_exec invokes this after fork. Keep the path limited to
    // async-signal-safe syscalls and stack-only decimal conversion.
    let pid = unsafe { libc::getpid() };
    if pid <= 0 {
        return Err(io::Error::from_raw_os_error(libc::EINVAL));
    }
    let mut digits = [0_u8; 10];
    let mut digit_count = 0;
    let mut value = pid as u32;
    loop {
        digits[digit_count] = b'0' + (value % 10) as u8;
        digit_count += 1;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    let mut bytes = [0_u8; 11];
    for index in 0..digit_count {
        bytes[index] = digits[digit_count - index - 1];
    }
    bytes[digit_count] = b'\n';
    let byte_count = digit_count + 1;
    loop {
        let result = unsafe {
            libc::write(
                procs_fd,
                bytes.as_ptr().cast(),
                byte_count,
            )
        };
        if result == -1 {
            let errno = unsafe { *libc::__errno_location() };
            if errno == libc::EINTR {
                continue;
            }
            return Err(io::Error::from_raw_os_error(errno));
        }
        if result as usize == byte_count {
            return Ok(());
        }
        // cgroup.procs parses each write as one PID. A short write must not be
        // completed with a second write, which would be a separate command.
        return Err(io::Error::from_raw_os_error(libc::EIO));
    }
}

fn poisoned_lock_error() -> io::Error {
    io::Error::other("worker cgroup lifecycle lock was poisoned")
}

#[cfg(test)]
mod tests {
    use super::{format_cpu_max, parse_cgroup_populated, parse_cpu_max, require_cpu_controller};
    use std::io::ErrorKind;

    #[test]
    fn formats_millicpu_as_exact_fixed_period_quota() {
        assert_eq!(format_cpu_max(2_500).unwrap(), "250000 100000\n");
        assert_eq!(format_cpu_max(1).unwrap(), "100 100000\n");
    }

    #[test]
    fn rejects_zero_and_overflowing_quotas() {
        assert_eq!(format_cpu_max(0).unwrap_err().kind(), ErrorKind::InvalidInput);
        assert_eq!(
            format_cpu_max(u64::MAX).unwrap_err().kind(),
            ErrorKind::InvalidInput
        );
    }

    #[test]
    fn parses_quota_readback_and_rejects_unlimited_or_malformed_values() {
        assert_eq!(parse_cpu_max("250000 100000\n").unwrap(), (250_000, 100_000));
        assert_eq!(parse_cpu_max("max 100000").unwrap_err().kind(), ErrorKind::InvalidData);
        assert!(parse_cpu_max("100000").is_err());
    }

    #[test]
    fn parses_populated_state_and_requires_cpu_delegation() {
        assert!(parse_cgroup_populated("populated 1\nfrozen 0\n").unwrap());
        assert!(!parse_cgroup_populated("populated 0\n").unwrap());
        assert!(parse_cgroup_populated("frozen 0\n").is_err());
        assert!(require_cpu_controller("cpu cpuset\n", "fixture").is_ok());
        assert!(require_cpu_controller("cpuset\n", "fixture").is_err());
    }
}
