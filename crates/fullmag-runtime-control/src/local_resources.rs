//! Native host capacity observation shared by publishers and application launchers.
//! A measurement is neither a resource offer nor backend qualification.
use anyhow::{bail, Context, Result};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalCpuCapacity {
    pub cpu_millis: u64,
    pub memory_available_bytes: u64,
    pub storage_available_bytes: u64,
}

impl LocalCpuCapacity {
    /// Observe one host and the filesystem containing the supplied existing path.
    /// Errors are preserved; no capacity is invented when observation fails.
    pub fn observe(storage_path: &Path) -> Result<Self> {
        let cpu_millis = u64::try_from(
            std::thread::available_parallelism()
                .context("detect logical CPU capacity")?
                .get(),
        )
        .context("logical CPU count does not fit in u64")?
        .checked_mul(1_000)
        .context("logical CPU capacity overflow")?;
        Ok(Self {
            cpu_millis,
            memory_available_bytes: available_memory_bytes()?,
            storage_available_bytes: available_storage_bytes(storage_path)?,
        })
    }
}

#[cfg(target_os = "linux")]
fn available_memory_bytes() -> Result<u64> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").context("read /proc/meminfo")?;
    let line = meminfo
        .lines()
        .find(|line| line.starts_with("MemAvailable:"))
        .context("/proc/meminfo does not expose MemAvailable")?;
    let kib = line
        .split_whitespace()
        .nth(1)
        .context("MemAvailable is missing its value")?
        .parse::<u64>()
        .context("parse MemAvailable")?;
    kib.checked_mul(1024).context("available memory overflow")
}

#[cfg(windows)]
fn available_memory_bytes() -> Result<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    if ok == 0 {
        bail!(
            "GlobalMemoryStatusEx failed: {}",
            std::io::Error::last_os_error()
        );
    }
    Ok(status.ullAvailPhys)
}

#[cfg(not(any(target_os = "linux", windows)))]
fn available_memory_bytes() -> Result<u64> {
    bail!("local memory discovery is unsupported on this operating system")
}

#[cfg(unix)]
fn available_storage_bytes(path: &Path) -> Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .context("storage path contains an embedded NUL byte")?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    let result = unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) };
    if result != 0 {
        bail!("statvfs failed: {}", std::io::Error::last_os_error());
    }
    let stats = unsafe { stats.assume_init() };
    stats
        .f_bavail
        .checked_mul(stats.f_frsize)
        .context("available storage capacity overflow")
}

#[cfg(windows)]
fn available_storage_bytes(path: &Path) -> Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut available = 0_u64;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        bail!(
            "GetDiskFreeSpaceExW failed: {}",
            std::io::Error::last_os_error()
        );
    }
    Ok(available)
}
