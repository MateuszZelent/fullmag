//! Fail-closed capacity admission for private archive decoding.
use std::path::Path;
use anyhow::{bail, Context, Result};

#[derive(Debug)]
pub struct ArchiveCapacityUnavailable(anyhow::Error);
impl std::fmt::Display for ArchiveCapacityUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "archive staging capacity unavailable: {}", self.0)
    }
}
impl std::error::Error for ArchiveCapacityUnavailable {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.0.root_cause()) }
}

pub(crate) fn require_capacity(root: &Path, required: u64) -> Result<()> {
    let result = (|| -> Result<()> {
        let available = available_bytes(root)?;
        if available < required {
            bail!("archive staging requires {required} available bytes; only {available} available");
        }
        Ok(())
    })();
    result.map_err(|cause| anyhow::Error::new(ArchiveCapacityUnavailable(cause)))
}

#[cfg(windows)]
fn available_bytes(root: &Path) -> Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(path: *const u16, available: *mut u64, total: *mut u64, free: *mut u64) -> i32;
    }
    let wide = root.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<_>>();
    let mut available = 0;
    // The input is NUL-terminated and the output points to a live u64.
    let success = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, std::ptr::null_mut(), std::ptr::null_mut()) };
    if success == 0 { return Err(std::io::Error::last_os_error()).context("querying archive staging capacity"); }
    Ok(available)
}

#[cfg(unix)]
fn available_bytes(root: &Path) -> Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(root.as_os_str().as_bytes())?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // statvfs initializes the output only on success.
    if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error()).context("querying archive staging capacity");
    }
    let stat = unsafe { stat.assume_init() };
    (stat.f_bavail as u64).checked_mul(stat.f_frsize as u64).context("archive staging capacity overflow")
}

#[cfg(not(any(unix, windows)))]
fn available_bytes(_root: &Path) -> Result<u64> {
    bail!("archive capacity admission is unsupported on this host")
}
