//! Native host capacity observation shared by publishers and application launchers.
//! A measurement is neither a resource offer nor backend qualification.
use anyhow::{bail, Context, Result};
use fullmag_session::{
    runtime_service::RuntimeServiceConfig, FmsPreparationResourceOffer, FmsResourceBudget,
    FmsResourceKind, FmsSchedulerResourceOffer,
};
use std::path::Path;

pub const APPLICATION_TARGET_ID: &str = "native-local";

/// Allocate two disjoint CPU slots from a measured snapshot, retaining at least
/// one quarter for the host. These are admission budgets, not OS hard limits.
pub fn application_service_config(
    store_root: &Path,
    capacity: LocalCpuCapacity,
) -> Result<RuntimeServiceConfig> {
    let share = |available: u64| {
        let host_reserve = available / 4 + u64::from(available % 4 != 0);
        (available - host_reserve) / 2
    };
    let budget = FmsResourceBudget {
        cpu_millis: share(capacity.cpu_millis),
        memory_bytes: share(capacity.memory_available_bytes),
        storage_bytes: share(capacity.storage_available_bytes),
        gpu_memory_bytes: 0,
    };
    if budget.cpu_millis == 0 || budget.memory_bytes == 0 || budget.storage_bytes == 0 {
        bail!("insufficient measured CPU, memory or storage for both native service pools");
    }
    let config = RuntimeServiceConfig {
        schema_version: "runtime_service_config.v1".into(),
        store_root: store_root.to_path_buf(),
        target_id: APPLICATION_TARGET_ID.into(),
        compute_pool_id: "native-local.compute".into(),
        preparation_pool_id: "native-local.preparation".into(),
        compute_resources: vec![FmsSchedulerResourceOffer {
            resource_id: "native-local.compute.cpu".into(),
            kind: FmsResourceKind::Cpu,
            budget: budget.clone(),
        }],
        preparation_resources: vec![FmsPreparationResourceOffer {
            resource_id: "native-local.preparation.cpu".into(),
            budget,
        }],
        // Long scientific work is not bounded by the UI startup timeout.
        worker_timeout_seconds: 31_536_000,
        preparation_timeout_seconds: 31_536_000,
        heartbeat_interval_milliseconds: 1000,
        startup_timeout_seconds: 60,
        drain_timeout_seconds: 1800,
    };
    config.validate()?;
    Ok(config)
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn capacity(value: u64) -> LocalCpuCapacity {
        LocalCpuCapacity {
            cpu_millis: value,
            memory_available_bytes: value,
            storage_available_bytes: value,
        }
    }

    fn store_root() -> std::path::PathBuf {
        std::env::current_dir().unwrap().join("session-store")
    }

    #[test]
    fn application_pools_share_capacity_and_keep_host_reserve() {
        for available in [3, 4, 7, 1000, 16_000, u64::MAX] {
            let config = application_service_config(&store_root(), capacity(available)).unwrap();
            let compute = &config.compute_resources[0];
            let preparation = &config.preparation_resources[0];
            assert_eq!(compute.kind, FmsResourceKind::Cpu);
            assert_eq!(compute.budget, preparation.budget);
            assert_ne!(compute.resource_id, preparation.resource_id);
            assert_ne!(config.compute_pool_id, config.preparation_pool_id);
            for allocated in [
                compute.budget.cpu_millis,
                compute.budget.memory_bytes,
                compute.budget.storage_bytes,
            ] {
                assert!(allocated > 0);
                let reserved = available - allocated * 2;
                assert!(reserved >= available / 4 + u64::from(available % 4 != 0));
            }
            assert_eq!(compute.budget.gpu_memory_bytes, 0);
            assert_eq!(config.target_id, APPLICATION_TARGET_ID);
        }
    }

    #[test]
    fn single_core_is_partitioned_without_rounding_up() {
        let config = application_service_config(&store_root(), capacity(1000)).unwrap();
        assert_eq!(config.compute_resources[0].budget.cpu_millis, 375);
        assert_eq!(config.preparation_resources[0].budget.cpu_millis, 375);
    }

    #[test]
    fn each_missing_capacity_refuses_resource_publication() {
        for insufficient in [0, 1, 2] {
            for measured in [
                LocalCpuCapacity {
                    cpu_millis: insufficient,
                    ..capacity(1000)
                },
                LocalCpuCapacity {
                    memory_available_bytes: insufficient,
                    ..capacity(1000)
                },
                LocalCpuCapacity {
                    storage_available_bytes: insufficient,
                    ..capacity(1000)
                },
            ] {
                assert!(application_service_config(&store_root(), measured).is_err());
            }
        }
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
