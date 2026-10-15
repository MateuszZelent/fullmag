//! Bounded host sampling for the durable compute-node resource.
//!
//! Missing topology, affinity, quota, or runtime capabilities stay explicit.
//! A sample is observation only; it never creates a scheduler offer.

use std::{
    collections::BTreeSet,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use crate::process_environment::remove_local_compute_operator_token;
use chrono::{DateTime, Utc};
use fullmag_session::{
    compute_node_snapshot::{
        ComputeNodeSample, ComputeNodeSnapshot, ComputeNodeSnapshotData, CpuLogicalProcessor,
        CpuOsConstraints, CpuQuota, CpuSnapshot, CpuTopology, EnforcementSnapshot,
        EnforcementStatus, GpuDeviceSnapshot, GpuPartition, MemorySnapshot, Observation, Reported,
        SampleSource, UnavailableReason,
    },
    host_resource_ledger::{HostInventoryOwnerDescriptor, HostResourceLedger},
};

const NVIDIA_SAMPLE_TIMEOUT: Duration = Duration::from_secs(2);
const NVIDIA_MEMORY_MIB: u64 = 1024 * 1024;

/// Collect one bounded host sample and assign its durable revisions from the
/// last snapshot stored by the shared host ledger.
pub fn sample_compute_node(
    ledger: &HostResourceLedger,
    previous: Option<&ComputeNodeSnapshot>,
) -> Result<ComputeNodeSnapshot> {
    sample_compute_node_inner(ledger, None, previous)
}

/// Collect one host observation pinned to the active shared-host inventory owner.
pub fn sample_compute_node_for_owner(
    ledger: &HostResourceLedger,
    owner: &HostInventoryOwnerDescriptor,
    previous: Option<&ComputeNodeSnapshot>,
) -> Result<ComputeNodeSnapshot> {
    sample_compute_node_inner(ledger, Some(owner), previous)
}

fn sample_compute_node_inner(
    ledger: &HostResourceLedger,
    host_owner: Option<&HostInventoryOwnerDescriptor>,
    previous: Option<&ComputeNodeSnapshot>,
) -> Result<ComputeNodeSnapshot> {
    let cpu_topology_probe = observe_cpu_topology();
    let allowed_cpu_ids_probe = match &cpu_topology_probe {
        Ok(topology) => observe_allowed_cpu_ids(topology),
        Err(error) => Err(anyhow::anyhow!("CPU topology is unavailable: {error:#}")),
    };
    let cpu_quota_probe = observe_cpu_quota();
    let cpu_capacity_fallback = std::thread::available_parallelism()
        .context("detect effective logical CPU capacity")
        .and_then(|count| {
            u64::try_from(count.get())
                .context("logical CPU count does not fit in u64")?
                .checked_mul(1000)
                .context("logical CPU capacity overflow")
        });
    let cpu_capacity = effective_cpu_capacity_millis(
        cpu_capacity_fallback,
        &allowed_cpu_ids_probe,
        &cpu_quota_probe,
    );
    let cpu_capacity_unavailable_reason = cpu_quota_probe
        .as_ref()
        .err()
        .map(probe_failure_reason)
        .unwrap_or(UnavailableReason::ProbeFailed);
    let memory = observe_memory();
    let gpus = discover_nvidia_gpus();
    let now = Utc::now();
    let boot_id = current_host_boot_id(now.clone())?;

    let cpu_failed = cpu_capacity.is_err()
        || cpu_quota_probe.is_err()
        || cpu_topology_probe.is_err()
        || allowed_cpu_ids_probe.is_err();
    let memory_failed = memory.is_err();
    let gpu_failed = gpus.is_err();
    let cpu_effective_capacity_millis = match cpu_capacity {
        Ok(value) if value > 0 => Observation::Available { value },
        Ok(_) => Observation::Unavailable {
            reason: UnavailableReason::ProbeFailed,
        },
        Err(_) => Observation::Unavailable {
            reason: cpu_capacity_unavailable_reason,
        },
    };
    let (memory_total_bytes, memory_available_bytes) = match memory {
        Ok(memory) => (
            Observation::Available {
                value: memory.total_bytes,
            },
            Observation::Available {
                value: memory.available_bytes,
            },
        ),
        Err(_) => (
            Observation::Unavailable {
                reason: UnavailableReason::ProbeFailed,
            },
            Observation::Unavailable {
                reason: UnavailableReason::ProbeFailed,
            },
        ),
    };
    let gpu_inventory = match gpus {
        Ok(devices) => Reported::Available { value: devices },
        Err(error) => Reported::Unavailable {
            reason: gpu_failure_reason(&error),
            last_known: previous.and_then(|snapshot| snapshot.gpus.known_value().cloned()),
        },
    };

    let topology = reported_probe(
        cpu_topology_probe,
        previous.and_then(|snapshot| snapshot.cpu.topology.known_value().cloned()),
    );
    let allowed_cpu_ids = reported_probe(
        allowed_cpu_ids_probe,
        previous
            .and_then(|snapshot| snapshot.cpu.os_constraints.allowed_logical_cpu_ids.known_value())
            .cloned(),
    );
    let cpu_quota = reported_probe(
        cpu_quota_probe,
        previous
            .and_then(|snapshot| snapshot.cpu.os_constraints.quota.known_value())
            .cloned(),
    );
    let capabilities = Reported::Unavailable {
        reason: UnavailableReason::NotReported,
        last_known: previous.and_then(|snapshot| snapshot.capabilities.known_value().cloned()),
    };
    let sample_error = (cpu_failed && memory_failed && gpu_failed)
        .then_some(UnavailableReason::ProbeFailed);

    let data = ComputeNodeSnapshotData {
        node_id: ledger.node_id(),
        boot_id,
        runtime_owner_id: ledger.owner_id(),
        owner_epoch: ledger.policy().owner_epoch,
        host_owner_id: host_owner.map(|owner| owner.host_owner_id.clone()),
        host_owner_epoch: host_owner.map(|owner| owner.host_owner_epoch),
        inventory_revision: 1,
        capabilities_revision: 1,
        cpu: CpuSnapshot {
            topology,
            os_constraints: CpuOsConstraints {
                allowed_logical_cpu_ids: allowed_cpu_ids,
                quota: cpu_quota,
            },
            effective_capacity_millis: cpu_effective_capacity_millis,
            load_percent: Observation::Unavailable {
                reason: UnavailableReason::NotReported,
            },
        },
        memory: MemorySnapshot {
            total_bytes: memory_total_bytes,
            available_bytes: memory_available_bytes,
        },
        gpus: gpu_inventory,
        capabilities,
        sample: ComputeNodeSample::new(SampleSource::HostOs, now.clone(), sample_error, now.clone()),
        enforcement: EnforcementSnapshot {
            cpu_affinity: EnforcementStatus::Unavailable,
            cpu_quota: EnforcementStatus::Advisory,
            memory_cap: EnforcementStatus::Advisory,
            // Inventory visibility is not proof that a worker launch enforces
            // a UUID mask; E3 must publish that evidence separately.
            gpu_visibility: EnforcementStatus::Unavailable,
            storage_quota: EnforcementStatus::Advisory,
        },
    };
    ComputeNodeSnapshot::successor(data, previous, now)
}

fn effective_cpu_capacity_millis(
    fallback: Result<u64>,
    allowed_cpu_ids: &Result<BTreeSet<u32>>,
    quota: &Result<CpuQuota>,
) -> Result<u64> {
    let allowed_capacity = allowed_cpu_ids
        .as_ref()
        .ok()
        .map(|ids| {
            u64::try_from(ids.len())
                .context("allowed logical CPU count does not fit in u64")?
                .checked_mul(1000)
                .context("allowed logical CPU capacity overflow")
        })
        .transpose()?;
    let quota = quota.as_ref().map_err(|error| {
        anyhow::anyhow!(
            "effective CPU capacity is unknown because quota sampling failed: {error:#}"
        )
    })?;
    match (allowed_capacity, quota) {
        (Some(allowed), CpuQuota::Limited { capacity_millis }) => Ok(allowed.min(*capacity_millis)),
        (Some(allowed), CpuQuota::Unlimited) => Ok(allowed),
        (None, CpuQuota::Limited { capacity_millis }) => Ok(fallback?.min(*capacity_millis)),
        (None, CpuQuota::Unlimited) => fallback,
    }
}

fn reported_probe<T>(probe: Result<T>, last_known: Option<T>) -> Reported<T> {
    match probe {
        Ok(value) => Reported::Available { value },
        Err(error) => Reported::Unavailable {
            reason: probe_failure_reason(&error),
            last_known,
        },
    }
}

fn probe_failure_reason(error: &anyhow::Error) -> UnavailableReason {
    if error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied)
    }) {
        UnavailableReason::PermissionDenied
    } else if error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    }) {
        UnavailableReason::SourceUnavailable
    } else if error.to_string().contains("unsupported") {
        UnavailableReason::Unsupported
    } else {
        UnavailableReason::ProbeFailed
    }
}

#[cfg(target_os = "linux")]
fn observe_cpu_topology() -> Result<CpuTopology> {
    use std::{fs, path::Path};

    let cpu_root = Path::new("/sys/devices/system/cpu");
    let online = parse_cpu_id_list(
        &fs::read_to_string(cpu_root.join("online")).context("read Linux online CPU set")?,
    )?;
    if online.is_empty() {
        bail!("Linux reports no online logical CPUs");
    }
    let numa_by_cpu = observe_linux_numa_nodes()?;
    let mut logical_cpus = Vec::with_capacity(online.len());
    for id in &online {
        let topology_root = cpu_root.join(format!("cpu{id}/topology"));
        let socket_id = read_optional_linux_id(&topology_root.join("physical_package_id"))?;
        let core_id = read_optional_linux_id(&topology_root.join("core_id"))?;
        let siblings = parse_cpu_id_list(
            &fs::read_to_string(topology_root.join("thread_siblings_list"))
                .with_context(|| format!("read SMT siblings for Linux CPU {id}"))?,
        )?;
        let smt_sibling_ids = siblings.intersection(&online).copied().collect::<Vec<_>>();
        if smt_sibling_ids.is_empty() || smt_sibling_ids.binary_search(id).is_err() {
            bail!("Linux CPU {id} has an inconsistent online SMT sibling set");
        }
        logical_cpus.push(CpuLogicalProcessor {
            id: *id,
            socket_id,
            numa_node_id: numa_by_cpu.get(id).copied(),
            core_id,
            smt_sibling_ids,
            processor_group: None,
            group_logical_cpu_id: None,
        });
    }
    Ok(CpuTopology { logical_cpus })
}

#[cfg(target_os = "linux")]
fn read_optional_linux_id(path: &std::path::Path) -> Result<Option<u32>> {
    match std::fs::read_to_string(path) {
        Ok(value) => {
            let value = value.trim();
            if value == "-1" {
                Ok(None)
            } else {
                value.parse::<u32>().map(Some).with_context(|| {
                    format!("parse Linux topology identifier at {}", path.display())
                })
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

#[cfg(target_os = "linux")]
fn observe_linux_numa_nodes() -> Result<std::collections::BTreeMap<u32, u32>> {
    use std::{collections::BTreeMap, fs, path::Path};

    let node_root = Path::new("/sys/devices/system/node");
    let entries = match fs::read_dir(node_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error).context("read Linux NUMA node directory"),
    };
    let mut numa_by_cpu = BTreeMap::new();
    for entry in entries {
        let entry = entry.context("read Linux NUMA node entry")?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(node_id) = name.strip_prefix("node") else {
            continue;
        };
        if node_id.is_empty() || !node_id.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let node_id = node_id
            .parse::<u32>()
            .context("parse Linux NUMA node identifier")?;
        let cpus = parse_cpu_id_list(
            &fs::read_to_string(entry.path().join("cpulist"))
                .with_context(|| format!("read CPU list for Linux NUMA node {node_id}"))?,
        )?;
        for cpu_id in cpus {
            if let Some(previous_node) = numa_by_cpu.insert(cpu_id, node_id) {
                if previous_node != node_id {
                    bail!("Linux CPU {cpu_id} is assigned to multiple NUMA nodes");
                }
            }
        }
    }
    Ok(numa_by_cpu)
}

#[cfg(target_os = "linux")]
fn observe_allowed_cpu_ids(topology: &CpuTopology) -> Result<BTreeSet<u32>> {
    // pid=0 reports the sampling thread's effective set; E3 still has to
    // enforce and verify the child worker's own affinity.
    const MAX_CPU_SET_BYTES: usize = 16 * 1024 * 1024;

    let max_cpu_id = topology
        .logical_cpus
        .last()
        .context("CPU topology is empty")?
        .id;
    let bit_count = usize::try_from(max_cpu_id)
        .context("Linux CPU identifier does not fit in usize")?
        .checked_add(1)
        .context("Linux CPU identifier range overflow")?;
    let required_bytes = bit_count
        .checked_add(7)
        .context("Linux CPU affinity buffer size overflow")?
        / 8;
    let word_bytes = std::mem::size_of::<usize>();
    let min_bytes = std::mem::size_of::<libc::cpu_set_t>();
    let mut buffer_bytes = required_bytes.max(min_bytes);
    buffer_bytes = buffer_bytes
        .checked_add(word_bytes - 1)
        .context("Linux CPU affinity buffer alignment overflow")?
        / word_bytes
        * word_bytes;
    if buffer_bytes > MAX_CPU_SET_BYTES {
        bail!("Linux CPU affinity set exceeds the supported probe bound");
    }

    let topology_ids = topology
        .logical_cpus
        .iter()
        .map(|cpu| cpu.id)
        .collect::<BTreeSet<_>>();
    loop {
        let mut words = vec![0usize; buffer_bytes / word_bytes];
        let result = unsafe {
            libc::sched_getaffinity(
                0,
                buffer_bytes,
                words.as_mut_ptr().cast::<libc::cpu_set_t>(),
            )
        };
        if result == 0 {
            let mut allowed = BTreeSet::new();
            for cpu_id in &topology_ids {
                let cpu_id = usize::try_from(*cpu_id)
                    .context("Linux CPU identifier does not fit in usize")?;
                let word = cpu_id / usize::BITS as usize;
                let bit = cpu_id % usize::BITS as usize;
                if words
                    .get(word)
                    .is_some_and(|value| value & (1usize << bit) != 0)
                {
                    allowed.insert(u32::try_from(cpu_id).context("CPU identifier overflow")?);
                }
            }
            if allowed.is_empty() {
                bail!("Linux effective CPU affinity is empty");
            }
            return Ok(allowed);
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EINVAL) && buffer_bytes < MAX_CPU_SET_BYTES {
            buffer_bytes = buffer_bytes
                .checked_mul(2)
                .context("Linux CPU affinity buffer size overflow")?
                .min(MAX_CPU_SET_BYTES);
            continue;
        }
        return Err(error).context("read Linux effective CPU affinity");
    }
}

#[cfg(target_os = "linux")]
fn parse_cpu_id_list(value: &str) -> Result<BTreeSet<u32>> {
    let mut ids = BTreeSet::new();
    for segment in value.trim().split(',') {
        let segment = segment.trim();
        if segment.is_empty() {
            bail!("CPU list contains an empty segment");
        }
        let mut range = segment.split('-');
        let start = range
            .next()
            .context("CPU list segment is missing its start")?
            .parse::<u32>()
            .context("parse CPU list range start")?;
        let end = match range.next() {
            Some(end) => end.parse::<u32>().context("parse CPU list range end")?,
            None => start,
        };
        if range.next().is_some() || end < start || end - start > 1_000_000 {
            bail!("CPU list contains an invalid or oversized range");
        }
        for id in start..=end {
            if !ids.insert(id) {
                bail!("CPU list repeats logical CPU {id}");
            }
        }
    }
    Ok(ids)
}

#[cfg(target_os = "linux")]
fn observe_cpu_quota() -> Result<CpuQuota> {
    use std::fs;

    let memberships = parse_linux_cgroup_memberships(
        &fs::read_to_string("/proc/self/cgroup").context("read Linux cgroup membership")?,
    )?;
    let mounts = parse_linux_cgroup_mounts(
        &fs::read_to_string("/proc/self/mountinfo").context("read Linux cgroup mounts")?,
    )?;

    if let Some(membership) = memberships
        .iter()
        .find(|entry| {
            entry.version == LinuxCgroupVersion::V1 && entry.controllers.contains("cpu")
        })
    {
        let mount = mounts
            .iter()
            .filter(|mount| {
                mount.version == LinuxCgroupVersion::V1
                    && mount.controllers.contains("cpu")
                    && membership.path.starts_with(&mount.root)
            })
            .max_by_key(|mount| mount.root.components().count())
            .context("Linux cgroup v1 CPU controller mount is unavailable")?;
        let current = linux_cgroup_mount_path(&membership.path, &mount.root, &mount.mount_point)?;
        return read_linux_v1_cpu_quota(&current, &mount.mount_point);
    }

    let membership = memberships
        .iter()
        .find(|entry| entry.version == LinuxCgroupVersion::V2)
        .context("Linux does not expose a unified cgroup membership")?;
    let mount = mounts
        .iter()
        .filter(|mount| {
            mount.version == LinuxCgroupVersion::V2 && membership.path.starts_with(&mount.root)
        })
        .max_by_key(|mount| mount.root.components().count())
        .context("Linux does not expose a matching cgroup v2 mount")?;
    let current = linux_cgroup_mount_path(&membership.path, &mount.root, &mount.mount_point)?;
    read_linux_v2_cpu_quota(&current, &mount.mount_point)
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinuxCgroupVersion {
    V1,
    V2,
}

#[cfg(target_os = "linux")]
struct LinuxCgroupMembership {
    version: LinuxCgroupVersion,
    controllers: BTreeSet<String>,
    path: std::path::PathBuf,
}

#[cfg(target_os = "linux")]
struct LinuxCgroupMount {
    version: LinuxCgroupVersion,
    controllers: BTreeSet<String>,
    root: std::path::PathBuf,
    mount_point: std::path::PathBuf,
}

#[cfg(target_os = "linux")]
fn parse_linux_cgroup_memberships(input: &str) -> Result<Vec<LinuxCgroupMembership>> {
    use std::path::PathBuf;

    let mut memberships = Vec::new();
    for line in input.lines().filter(|line| !line.trim().is_empty()) {
        let mut fields = line.splitn(3, ':');
        let hierarchy = fields.next().context("cgroup membership is missing hierarchy")?;
        let controllers = fields
            .next()
            .context("cgroup membership is missing controllers")?;
        let path = fields.next().context("cgroup membership is missing path")?;
        let version = if hierarchy == "0" && controllers.is_empty() {
            LinuxCgroupVersion::V2
        } else {
            LinuxCgroupVersion::V1
        };
        if !path.starts_with('/') || PathBuf::from(path).components().any(|component| {
            matches!(component, std::path::Component::ParentDir)
        }) {
            bail!("Linux cgroup membership path is not absolute and normalized");
        }
        memberships.push(LinuxCgroupMembership {
            version,
            controllers: controllers
                .split(',')
                .filter(|controller| !controller.is_empty())
                .map(str::to_owned)
                .collect(),
            path: PathBuf::from(path),
        });
    }
    if memberships.is_empty() {
        bail!("Linux returned no cgroup memberships");
    }
    Ok(memberships)
}

#[cfg(target_os = "linux")]
fn parse_linux_cgroup_mounts(input: &str) -> Result<Vec<LinuxCgroupMount>> {
    use std::path::PathBuf;

    let mut mounts = Vec::new();
    for line in input.lines().filter(|line| !line.trim().is_empty()) {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        let separator = fields
            .iter()
            .position(|field| *field == "-")
            .context("mountinfo row is missing its filesystem separator")?;
        if separator < 6 || fields.len() <= separator + 3 {
            bail!("Linux cgroup mountinfo row is truncated");
        }
        let file_system = fields[separator + 1];
        let version = match file_system {
            "cgroup2" => LinuxCgroupVersion::V2,
            "cgroup" => LinuxCgroupVersion::V1,
            _ => continue,
        };
        let super_options = fields[separator + 3]
            .split(',')
            .filter(|option| !option.is_empty())
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        mounts.push(LinuxCgroupMount {
            version,
            controllers: if version == LinuxCgroupVersion::V1 {
                super_options
            } else {
                BTreeSet::new()
            },
            root: PathBuf::from(decode_mountinfo_path(fields[3])?),
            mount_point: PathBuf::from(decode_mountinfo_path(fields[4])?),
        });
    }
    Ok(mounts)
}

#[cfg(target_os = "linux")]
fn decode_mountinfo_path(value: &str) -> Result<String> {
    let source = value.as_bytes();
    let mut decoded = Vec::with_capacity(source.len());
    let mut index = 0usize;
    while index < source.len() {
        if source[index] != b'\\' {
            decoded.push(source[index]);
            index += 1;
            continue;
        }
        if index + 3 >= source.len()
            || !(source[index + 1..index + 4]
                .iter()
                .all(|byte| (b'0'..=b'7').contains(byte)))
        {
            bail!("Linux mountinfo path contains an invalid escape");
        }
        let escaped = u16::from(source[index + 1] - b'0') * 64
            + u16::from(source[index + 2] - b'0') * 8
            + u16::from(source[index + 3] - b'0');
        decoded.push(u8::try_from(escaped).context("mountinfo escape exceeds one byte")?);
        index += 4;
    }
    String::from_utf8(decoded).context("Linux mountinfo path is not UTF-8")
}

#[cfg(target_os = "linux")]
fn linux_cgroup_mount_path(
    cgroup_path: &std::path::Path,
    mount_root: &std::path::Path,
    mount_point: &std::path::Path,
) -> Result<std::path::PathBuf> {
    let relative = cgroup_path
        .strip_prefix(mount_root)
        .context("Linux cgroup path is outside its mount root")?;
    if relative
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        bail!("Linux cgroup path escapes its mount root");
    }
    Ok(mount_point.join(relative))
}

#[cfg(target_os = "linux")]
fn read_linux_v2_cpu_quota(
    current: &std::path::Path,
    mount_point: &std::path::Path,
) -> Result<CpuQuota> {
    use std::fs;

    let mut path = current.to_path_buf();
    let mut found_quota_file = false;
    let mut tightest_limit: Option<u64> = None;
    loop {
        match fs::read_to_string(path.join("cpu.max")) {
            Ok(value) => {
                found_quota_file = true;
                if let CpuQuota::Limited { capacity_millis } = parse_linux_v2_cpu_quota(&value)? {
                    tightest_limit = Some(
                        tightest_limit.map_or(capacity_millis, |current| current.min(capacity_millis)),
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("read cgroup v2 cpu.max"),
        }
        if path == mount_point {
            break;
        }
        if !path.starts_with(mount_point) || !path.pop() {
            bail!("Linux cgroup v2 parent path escaped its mount point");
        }
    }
    if !found_quota_file {
        return Ok(CpuQuota::Unlimited);
    }
    Ok(match tightest_limit {
        Some(capacity_millis) => CpuQuota::Limited { capacity_millis },
        None => CpuQuota::Unlimited,
    })
}

#[cfg(target_os = "linux")]
fn parse_linux_v2_cpu_quota(value: &str) -> Result<CpuQuota> {
    let fields = value.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 2 {
        bail!("cgroup v2 cpu.max must contain quota and period");
    }
    let period = fields[1]
        .parse::<u64>()
        .context("parse cgroup v2 CPU quota period")?;
    if period == 0 {
        bail!("cgroup v2 CPU quota period must be positive");
    }
    if fields[0] == "max" {
        return Ok(CpuQuota::Unlimited);
    }
    let quota = fields[0]
        .parse::<u64>()
        .context("parse cgroup v2 CPU quota")?;
    limited_cpu_quota(quota, period)
}

#[cfg(target_os = "linux")]
fn read_linux_v1_cpu_quota(
    current: &std::path::Path,
    mount_point: &std::path::Path,
) -> Result<CpuQuota> {
    use std::fs;

    let mut path = current.to_path_buf();
    let mut tightest_limit: Option<u64> = None;
    loop {
        let quota = fs::read_to_string(path.join("cpu.cfs_quota_us"))
            .with_context(|| format!("read cgroup v1 CPU quota at {}", path.display()))?;
        let period = fs::read_to_string(path.join("cpu.cfs_period_us"))
            .with_context(|| format!("read cgroup v1 CPU period at {}", path.display()))?;
        let quota = quota
            .trim()
            .parse::<i64>()
            .context("parse cgroup v1 CPU quota")?;
        let period = period
            .trim()
            .parse::<u64>()
            .context("parse cgroup v1 CPU period")?;
        if quota == -1 {
            if period == 0 {
                bail!("cgroup v1 CPU quota period must be positive");
            }
        } else if quota <= 0 {
            bail!("cgroup v1 CPU quota must be -1 or positive");
        } else if let CpuQuota::Limited { capacity_millis } =
            limited_cpu_quota(quota as u64, period)?
        {
            tightest_limit = Some(
                tightest_limit.map_or(capacity_millis, |current| current.min(capacity_millis)),
            );
        }
        if path == mount_point {
            break;
        }
        if !path.starts_with(mount_point) || !path.pop() {
            bail!("Linux cgroup v1 parent path escaped its mount point");
        }
    }
    Ok(match tightest_limit {
        Some(capacity_millis) => CpuQuota::Limited { capacity_millis },
        None => CpuQuota::Unlimited,
    })
}

#[cfg(target_os = "linux")]
fn limited_cpu_quota(quota: u64, period: u64) -> Result<CpuQuota> {
    if quota == 0 || period == 0 {
        bail!("CPU quota and period must be positive");
    }
    let capacity_millis = quota
        .checked_mul(1000)
        .context("CPU quota capacity overflow")?
        / period;
    if capacity_millis == 0 {
        bail!("CPU quota is below the snapshot's milli-CPU precision");
    }
    Ok(CpuQuota::Limited { capacity_millis })
}

#[cfg(windows)]
fn observe_cpu_quota() -> Result<CpuQuota> {
    let process = unsafe { GetCurrentProcess() };
    let mut in_job = 0i32;
    if unsafe { IsProcessInJob(process, std::ptr::null_mut(), &mut in_job) } == 0 {
        return Err(std::io::Error::last_os_error())
            .context("check Windows CPU quota job membership");
    }
    if in_job != 0 {
        bail!(
            "Windows effective CPU quota is unsupported inside a Job Object because ancestor job limits are not observable"
        );
    }
    Ok(CpuQuota::Unlimited)
}

#[cfg(not(any(target_os = "linux", windows)))]
fn observe_cpu_quota() -> Result<CpuQuota> {
    bail!("CPU quota sampling is unsupported on this operating system")
}

#[cfg(windows)]
fn observe_cpu_topology() -> Result<CpuTopology> {
    const RELATION_PROCESSOR_CORE: u32 = 0;
    const MAX_TOPOLOGY_BYTES: usize = 16 * 1024 * 1024;

    let mut required_bytes = 0u32;
    unsafe {
        GetLogicalProcessorInformationEx(
            RELATION_PROCESSOR_CORE,
            std::ptr::null_mut(),
            &mut required_bytes,
        );
    }
    let required_bytes = usize::try_from(required_bytes)
        .context("Windows CPU topology size does not fit in usize")?;
    if required_bytes == 0 || required_bytes > MAX_TOPOLOGY_BYTES {
        bail!("Windows returned an invalid CPU topology size");
    }
    let word_bytes = std::mem::size_of::<usize>();
    let mut words = vec![0usize; required_bytes.div_ceil(word_bytes)];
    let mut returned_bytes = u32::try_from(required_bytes)
        .context("Windows CPU topology buffer size does not fit in u32")?;
    let succeeded = unsafe {
        GetLogicalProcessorInformationEx(
            RELATION_PROCESSOR_CORE,
            words.as_mut_ptr().cast(),
            &mut returned_bytes,
        )
    };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error()).context("read Windows CPU topology");
    }
    let returned_bytes = usize::try_from(returned_bytes)
        .context("Windows CPU topology length does not fit in usize")?;
    if returned_bytes > words.len() * word_bytes {
        bail!("Windows returned a CPU topology length beyond its buffer");
    }
    let bytes = unsafe {
        std::slice::from_raw_parts(words.as_ptr().cast::<u8>(), returned_bytes)
    };
    parse_windows_cpu_core_records(bytes)
}

#[cfg(windows)]
fn parse_windows_cpu_core_records(bytes: &[u8]) -> Result<CpuTopology> {
    const RELATION_PROCESSOR_CORE: u32 = 0;
    const RECORD_HEADER_BYTES: usize = 8;
    const PROCESSOR_RELATIONSHIP_BYTES: usize = 24;
    const GROUP_MASK_OFFSET: usize = RECORD_HEADER_BYTES + PROCESSOR_RELATIONSHIP_BYTES;

    let mut offset = 0usize;
    let mut logical_cpus = Vec::new();
    while offset < bytes.len() {
        let header_end = offset
            .checked_add(RECORD_HEADER_BYTES)
            .context("Windows CPU topology record offset overflow")?;
        if header_end > bytes.len() {
            bail!("Windows CPU topology ends with a truncated record header");
        }
        let relationship = u32::from_ne_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .context("read Windows CPU topology relationship")?,
        );
        let record_bytes = usize::try_from(u32::from_ne_bytes(
            bytes[offset + 4..header_end]
                .try_into()
                .context("read Windows CPU topology record size")?,
        ))
        .context("Windows CPU topology record size does not fit in usize")?;
        let record_end = offset
            .checked_add(record_bytes)
            .context("Windows CPU topology record end overflow")?;
        if relationship != RELATION_PROCESSOR_CORE
            || record_bytes < GROUP_MASK_OFFSET + std::mem::size_of::<usize>() + 8
            || record_end > bytes.len()
        {
            bail!("Windows returned an invalid processor-core record");
        }
        let group_count_offset = offset + RECORD_HEADER_BYTES + 22;
        let group_count = u16::from_ne_bytes(
            bytes[group_count_offset..group_count_offset + 2]
                .try_into()
                .context("read Windows processor group count")?,
        );
        if group_count != 1 {
            bail!("Windows processor core does not have exactly one processor group");
        }
        let mask_offset = offset + GROUP_MASK_OFFSET;
        let mask = usize::from_ne_bytes(
            bytes[mask_offset..mask_offset + std::mem::size_of::<usize>()]
                .try_into()
                .context("read Windows processor core mask")?,
        );
        let group_offset = mask_offset + std::mem::size_of::<usize>();
        let group = u16::from_ne_bytes(
            bytes[group_offset..group_offset + 2]
                .try_into()
                .context("read Windows processor group")?,
        );
        if mask == 0 {
            bail!("Windows returned an empty processor-core mask");
        }
        let sibling_ids = (0..usize::BITS)
            .filter(|bit| mask & (1usize << *bit) != 0)
            .map(|bit| {
                u32::from(group)
                    .checked_mul(64)
                    .and_then(|base| base.checked_add(bit))
                    .context("Windows logical CPU identifier overflow")
            })
            .collect::<Result<Vec<_>>>()?;
        let core_id = *sibling_ids
            .first()
            .context("Windows processor-core mask contains no logical processors")?;
        for id in &sibling_ids {
            let group_local_id = u16::try_from(*id % 64)
                .context("Windows processor-group logical CPU id overflow")?;
            logical_cpus.push(CpuLogicalProcessor {
                id: *id,
                socket_id: None,
                numa_node_id: observe_windows_numa_node(group, group_local_id),
                core_id: Some(core_id),
                smt_sibling_ids: sibling_ids.clone(),
                processor_group: Some(group),
                group_logical_cpu_id: Some(group_local_id),
            });
        }
        offset = record_end;
    }
    logical_cpus.sort_by_key(|cpu| cpu.id);
    if logical_cpus.is_empty() || logical_cpus.windows(2).any(|pair| pair[0].id == pair[1].id) {
        bail!("Windows CPU topology is empty or repeats a logical processor");
    }
    Ok(CpuTopology { logical_cpus })
}

#[cfg(windows)]
fn observe_windows_numa_node(group: u16, group_local_id: u16) -> Option<u32> {
    let processor = WindowsProcessorNumber {
        group,
        number: u8::try_from(group_local_id).ok()?,
        reserved: 0,
    };
    let mut node_id = 0u16;
    if unsafe { GetNumaProcessorNodeEx(&processor, &mut node_id) } == 0 {
        None
    } else {
        Some(u32::from(node_id))
    }
}

#[cfg(windows)]
fn observe_allowed_cpu_ids(topology: &CpuTopology) -> Result<BTreeSet<u32>> {
    if let Some(allowed) = observe_current_job_cpu_affinity(topology)? {
        return Ok(allowed);
    }

    let process = unsafe { GetCurrentProcess() };
    let mut group_count = 1u16;
    let mut process_groups = [0u16; 1];
    if unsafe {
        GetProcessGroupAffinity(process, &mut group_count, process_groups.as_mut_ptr())
    } == 0
    {
        if group_count > 1 {
            bail!("multi-group Windows CPU affinity is unsupported by this probe");
        }
        return Err(std::io::Error::last_os_error()).context("read Windows process groups");
    }
    if group_count != 1 {
        bail!("multi-group Windows CPU affinity is unsupported by this probe");
    }
    let mut primary_group_affinity = WindowsGroupAffinity::default();
    if unsafe { GetThreadGroupAffinity(GetCurrentThread(), &mut primary_group_affinity) } == 0 {
        return Err(std::io::Error::last_os_error()).context("read Windows thread processor group");
    }
    let mut process_mask = 0usize;
    let mut system_mask = 0usize;
    if unsafe {
        GetProcessAffinityMask(
            process,
            &mut process_mask,
            &mut system_mask,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error()).context("read Windows process affinity mask");
    }
    if process_groups[0] != primary_group_affinity.group {
        bail!("Windows process and sampling thread use different primary groups");
    }
    if process_mask == 0 || process_mask & !system_mask != 0 {
        bail!("Windows returned an invalid process affinity mask");
    }
    let allowed_mask = process_mask & primary_group_affinity.mask & system_mask;
    if allowed_mask == 0 {
        bail!("Windows process and primary-thread affinity have no common CPU");
    }
    let allowed = (0..usize::BITS)
        .filter(|bit| allowed_mask & (1usize << *bit) != 0)
        .map(|bit| {
            u32::from(primary_group_affinity.group)
                .checked_mul(64)
                .and_then(|base| base.checked_add(bit))
                .context("Windows allowed CPU identifier overflow")
        })
        .collect::<Result<BTreeSet<_>>>()?;
    let topology_ids = topology
        .logical_cpus
        .iter()
        .map(|cpu| cpu.id)
        .collect::<BTreeSet<_>>();
    if !allowed.is_subset(&topology_ids) {
        bail!("Windows process affinity references a CPU outside current topology");
    }
    Ok(allowed)
}

#[cfg(windows)]
fn observe_current_job_cpu_affinity(
    topology: &CpuTopology,
) -> Result<Option<BTreeSet<u32>>> {
    const JOB_OBJECT_GROUP_INFORMATION_EX: i32 = 14;

    let process = unsafe { GetCurrentProcess() };
    let mut in_job = 0i32;
    if unsafe { IsProcessInJob(process, std::ptr::null_mut(), &mut in_job) } == 0 {
        return Err(std::io::Error::last_os_error()).context("check Windows worker job membership");
    }
    if in_job == 0 {
        return Ok(None);
    }

    let topology_groups = topology
        .logical_cpus
        .iter()
        .filter_map(|cpu| cpu.processor_group)
        .collect::<BTreeSet<_>>();
    if topology_groups.is_empty() {
        bail!("Windows job affinity requires processor-group topology");
    }
    let mut affinities = vec![WindowsGroupAffinity::default(); topology_groups.len()];
    let buffer_bytes = affinities
        .len()
        .checked_mul(std::mem::size_of::<WindowsGroupAffinity>())
        .and_then(|bytes| u32::try_from(bytes).ok())
        .context("Windows job affinity buffer size overflow")?;
    let mut returned_bytes = 0u32;
    if unsafe {
        QueryInformationJobObject(
            std::ptr::null_mut(),
            JOB_OBJECT_GROUP_INFORMATION_EX,
            affinities.as_mut_ptr().cast(),
            buffer_bytes,
            &mut returned_bytes,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error())
            .context("read Windows worker job processor-group affinity");
    }
    let entry_bytes = std::mem::size_of::<WindowsGroupAffinity>();
    if returned_bytes == 0
        || returned_bytes > buffer_bytes
        || returned_bytes as usize % entry_bytes != 0
    {
        bail!("Windows job returned an invalid processor-group affinity size");
    }
    affinities.truncate(returned_bytes as usize / entry_bytes);
    Ok(Some(cpu_ids_for_group_affinities(&affinities, topology)?))
}

#[cfg(windows)]
fn cpu_ids_for_group_affinities(
    affinities: &[WindowsGroupAffinity],
    topology: &CpuTopology,
) -> Result<BTreeSet<u32>> {
    let mut allowed = BTreeSet::new();
    let mut seen_groups = BTreeSet::new();
    for affinity in affinities {
        if affinity.mask == 0 || !seen_groups.insert(affinity.group) {
            bail!("Windows job affinity has an empty or repeated processor group");
        }
        let mut topology_mask = 0usize;
        for cpu in topology
            .logical_cpus
            .iter()
            .filter(|cpu| cpu.processor_group == Some(affinity.group))
        {
            let group_local_id = cpu
                .group_logical_cpu_id
                .context("Windows CPU topology is missing a group-local identifier")?;
            if u32::from(group_local_id) >= usize::BITS {
                bail!("Windows group-local CPU identifier exceeds the affinity mask width");
            }
            let bit = 1usize << group_local_id;
            topology_mask |= bit;
            if affinity.mask & bit != 0 {
                allowed.insert(cpu.id);
            }
        }
        if topology_mask & affinity.mask != affinity.mask {
            bail!("Windows job affinity references a CPU outside current topology");
        }
    }
    if allowed.is_empty() {
        bail!("Windows job affinity has no CPU in the observed topology");
    }
    Ok(allowed)
}

#[cfg(not(any(target_os = "linux", windows)))]
fn observe_cpu_topology() -> Result<CpuTopology> {
    bail!("CPU topology sampling is unsupported on this operating system")
}

#[cfg(not(any(target_os = "linux", windows)))]
fn observe_allowed_cpu_ids(_topology: &CpuTopology) -> Result<BTreeSet<u32>> {
    bail!("allowed CPU sampling is unsupported on this operating system")
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
#[allow(dead_code)]
struct WindowsProcessorNumber {
    group: u16,
    number: u8,
    reserved: u8,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct WindowsGroupAffinity {
    mask: usize,
    group: u16,
    reserved: [u16; 3],
}

#[cfg(windows)]
#[link(name = "kernel32")]
#[allow(non_snake_case)]
unsafe extern "system" {
    fn GetLogicalProcessorInformationEx(
        relationship: u32,
        buffer: *mut std::ffi::c_void,
        returned_length: *mut u32,
    ) -> i32;
    fn GetCurrentThread() -> *mut std::ffi::c_void;
    fn GetThreadGroupAffinity(
        thread: *mut std::ffi::c_void,
        group_affinity: *mut WindowsGroupAffinity,
    ) -> i32;
    fn GetNumaProcessorNodeEx(
        processor: *const WindowsProcessorNumber,
        node_number: *mut u16,
    ) -> i32;
    fn GetCurrentProcess() -> *mut std::ffi::c_void;
    fn IsProcessInJob(
        process: *mut std::ffi::c_void,
        job: *mut std::ffi::c_void,
        result: *mut i32,
    ) -> i32;
    fn QueryInformationJobObject(
        job: *mut std::ffi::c_void,
        information_class: i32,
        information: *mut std::ffi::c_void,
        information_length: u32,
        returned_length: *mut u32,
    ) -> i32;
    fn GetProcessAffinityMask(
        process: *mut std::ffi::c_void,
        process_affinity_mask: *mut usize,
        system_affinity_mask: *mut usize,
    ) -> i32;
    fn GetProcessGroupAffinity(
        process: *mut std::ffi::c_void,
        group_count: *mut u16,
        group_array: *mut u16,
    ) -> i32;
}

struct MemoryObservation {
    total_bytes: u64,
    available_bytes: u64,
}

#[cfg(target_os = "linux")]
fn observe_memory() -> Result<MemoryObservation> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").context("read /proc/meminfo")?;
    let parse_kib = |name: &str| -> Result<u64> {
        let line = meminfo
            .lines()
            .find(|line| line.starts_with(name))
            .with_context(|| format!("/proc/meminfo does not expose {name}"))?;
        let kib = line
            .split_whitespace()
            .nth(1)
            .with_context(|| format!("{name} is missing its value"))?
            .parse::<u64>()
            .with_context(|| format!("parse {name}"))?;
        kib.checked_mul(1024).with_context(|| format!("{name} overflow"))
    };
    let memory = MemoryObservation {
        total_bytes: parse_kib("MemTotal:")?,
        available_bytes: parse_kib("MemAvailable:")?,
    };
    validate_memory(memory)
}

#[cfg(windows)]
fn observe_memory() -> Result<MemoryObservation> {
    use windows_sys::Win32::System::SystemInformation::{
        GlobalMemoryStatusEx, MEMORYSTATUSEX,
    };

    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return Err(std::io::Error::last_os_error()).context("GlobalMemoryStatusEx");
    }
    validate_memory(MemoryObservation {
        total_bytes: status.ullTotalPhys,
        available_bytes: status.ullAvailPhys,
    })
}

#[cfg(not(any(target_os = "linux", windows)))]
fn observe_memory() -> Result<MemoryObservation> {
    bail!("host memory sampling is unsupported on this operating system")
}

fn validate_memory(memory: MemoryObservation) -> Result<MemoryObservation> {
    if memory.total_bytes == 0 || memory.available_bytes > memory.total_bytes {
        bail!("host memory sample is outside its valid range");
    }
    Ok(memory)
}

fn discover_nvidia_gpus() -> Result<Vec<GpuDeviceSnapshot>> {
    const QUERY_WITH_MIG_MODE: &str =
        "uuid,pci.bus_id,name,memory.total,utilization.gpu,temperature.gpu,mig.mode.current";
    const LEGACY_QUERY: &str =
        "uuid,pci.bus_id,name,memory.total,utilization.gpu,temperature.gpu";

    let deadline = Instant::now() + NVIDIA_SAMPLE_TIMEOUT;
    let (output, includes_mig_mode) = match query_nvidia_smi(QUERY_WITH_MIG_MODE, deadline) {
        Ok(output) => (output, true),
        Err(mig_query_error) if Instant::now() < deadline => {
            let output = query_nvidia_smi(LEGACY_QUERY, deadline)
                .with_context(|| format!("MIG-aware nvidia-smi query failed: {mig_query_error:#}"))?;
            (output, false)
        }
        Err(error) => return Err(error),
    };
    let stdout = String::from_utf8(output).context("nvidia-smi output is not UTF-8")?;
    parse_nvidia_smi_output(&stdout, includes_mig_mode)
}

fn query_nvidia_smi(query: &str, deadline: Instant) -> Result<Vec<u8>> {
    let query_arg = format!("--query-gpu={query}");
    let mut command = Command::new("nvidia-smi");
    remove_local_compute_operator_token(&mut command);
    let mut child = command
        .args([query_arg.as_str(), "--format=csv,noheader,nounits"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("launch nvidia-smi")?;
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("nvidia-smi exceeded its two-second sampling limit");
        }
        thread::sleep(Duration::from_millis(25));
    }
    let output = child.wait_with_output().context("collect nvidia-smi output")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        bail!("nvidia-smi exited with {}: {stderr}", output.status);
    }
    Ok(output.stdout)
}

fn parse_nvidia_smi_output(output: &str, includes_mig_mode: bool) -> Result<Vec<GpuDeviceSnapshot>> {
    let mut devices = output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
        .map(|(ordinal, line)| {
            let columns = line.split(',').map(str::trim).collect::<Vec<_>>();
            let expected_columns = if includes_mig_mode { 7 } else { 6 };
            if columns.len() != expected_columns {
                bail!("nvidia-smi returned an unexpected GPU row shape");
            }
            if columns[0].is_empty()
                || !columns[0]
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                bail!("nvidia-smi returned an invalid GPU UUID");
            }
            let ordinal = u32::try_from(ordinal).context("GPU ordinal does not fit in u32")?;
            let partition = if includes_mig_mode && columns[6].eq_ignore_ascii_case("disabled") {
                GpuPartition::FullDevice
            } else {
                // An enabled MIG parent or an unsupported/unknown report is not
                // safe to allocate as one exclusive physical device.
                GpuPartition::Unknown
            };
            Ok(GpuDeviceSnapshot {
                uuid: columns[0].to_owned(),
                pci_id: reported_text(columns[1]),
                name: reported_text(columns[2]),
                local_ordinal: Observation::Available { value: ordinal },
                vram_bytes: reported_mib(columns[3])?,
                utilization_percent: observed_percent(columns[4])?,
                temperature_millicelsius: observed_temperature(columns[5])?,
                partition: Reported::Available { value: partition },
                topology: Reported::Unavailable {
                    reason: UnavailableReason::NotReported,
                    last_known: None,
                },
                runtime_compatibility: Reported::Unavailable {
                    reason: UnavailableReason::NotReported,
                    last_known: None,
                },
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if devices.is_empty() {
        bail!("nvidia-smi reported no NVIDIA devices");
    }
    devices.sort_by(|left, right| left.uuid.cmp(&right.uuid));
    Ok(devices)
}

fn reported_text(value: &str) -> Reported<String> {
    if value.is_empty() || is_unavailable_text(value) {
        Reported::Unavailable {
            reason: UnavailableReason::NotReported,
            last_known: None,
        }
    } else {
        Reported::Available {
            value: value.to_owned(),
        }
    }
}

fn reported_mib(value: &str) -> Result<Reported<u64>> {
    match parse_optional_u64(value, "GPU memory")? {
        Some(mib) => Ok(Reported::Available {
            value: mib
                .checked_mul(NVIDIA_MEMORY_MIB)
                .context("GPU memory byte count overflow")?,
        }),
        None => Ok(Reported::Unavailable {
            reason: UnavailableReason::NotReported,
            last_known: None,
        }),
    }
}

fn observed_percent(value: &str) -> Result<Observation<u8>> {
    match parse_optional_u64(value, "GPU utilization")? {
        Some(percent) if percent <= 100 => Ok(Observation::Available {
            value: u8::try_from(percent).context("GPU utilization does not fit in u8")?,
        }),
        Some(_) => bail!("nvidia-smi returned GPU utilization above 100 percent"),
        None => Ok(Observation::Unavailable {
            reason: UnavailableReason::NotReported,
        }),
    }
}

fn observed_temperature(value: &str) -> Result<Observation<i32>> {
    match parse_optional_u64(value, "GPU temperature")? {
        Some(celsius) => {
            let milli = celsius
                .checked_mul(1000)
                .context("GPU temperature overflow")?;
            Ok(Observation::Available {
                value: i32::try_from(milli).context("GPU temperature does not fit in i32")?,
            })
        }
        None => Ok(Observation::Unavailable {
            reason: UnavailableReason::NotReported,
        }),
    }
}

fn parse_optional_u64(value: &str, field: &str) -> Result<Option<u64>> {
    if is_unavailable_text(value) {
        return Ok(None);
    }
    value
        .parse::<u64>()
        .map(Some)
        .with_context(|| format!("parse {field} from nvidia-smi"))
}

fn is_unavailable_text(value: &str) -> bool {
    matches!(value.trim(), "N/A" | "[N/A]" | "-" | "Not Supported")
}

fn gpu_failure_reason(error: &anyhow::Error) -> UnavailableReason {
    if error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    }) || error.to_string().contains("reported no NVIDIA devices")
    {
        UnavailableReason::SourceUnavailable
    } else if error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied)
    }) {
        UnavailableReason::PermissionDenied
    } else {
        UnavailableReason::ProbeFailed
    }
}

#[cfg(target_os = "linux")]
pub fn current_host_boot_id(_now: DateTime<Utc>) -> Result<String> {
    let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .context("read Linux boot identity")?;
    let boot_id = boot_id.trim();
    if boot_id.is_empty()
        || !boot_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        bail!("Linux boot identity is malformed");
    }
    Ok(format!("linux-boot-{boot_id}"))
}

#[cfg(windows)]
pub fn current_host_boot_id(now: DateTime<Utc>) -> Result<String> {
    use windows_sys::Win32::System::SystemInformation::GetTickCount64;

    // Windows exposes uptime directly through this API. The derived boot time
    // stays stable across service restarts; a wall-clock correction can only
    // conservatively create a new identity and reset inventory revisions.
    let uptime_millis = i64::try_from(unsafe { GetTickCount64() })
        .context("Windows uptime does not fit in i64 milliseconds")?;
    let boot_time_seconds = now
        .timestamp_millis()
        .checked_sub(uptime_millis)
        .context("Windows boot-time estimate overflow")?
        .div_euclid(1000);
    Ok(format!("windows-boot-{boot_time_seconds}"))
}

#[cfg(not(any(target_os = "linux", windows)))]
pub fn current_host_boot_id(_now: DateTime<Utc>) -> Result<String> {
    bail!("host boot identity sampling is unsupported on this operating system")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(all(windows, target_pointer_width = "64"))]
    #[test]
    fn windows_job_affinity_reports_exact_cpu_ids_across_groups() {
        let topology = CpuTopology {
            logical_cpus: vec![
                CpuLogicalProcessor {
                    id: 0,
                    socket_id: None,
                    numa_node_id: None,
                    core_id: None,
                    smt_sibling_ids: vec![0],
                    processor_group: Some(0),
                    group_logical_cpu_id: Some(0),
                },
                CpuLogicalProcessor {
                    id: 63,
                    socket_id: None,
                    numa_node_id: None,
                    core_id: None,
                    smt_sibling_ids: vec![63],
                    processor_group: Some(0),
                    group_logical_cpu_id: Some(63),
                },
                CpuLogicalProcessor {
                    id: 64,
                    socket_id: None,
                    numa_node_id: None,
                    core_id: None,
                    smt_sibling_ids: vec![64],
                    processor_group: Some(1),
                    group_logical_cpu_id: Some(0),
                },
            ],
        };
        let affinities = [
            WindowsGroupAffinity {
                mask: 1 | (1usize << 63),
                group: 0,
                reserved: [0; 3],
            },
            WindowsGroupAffinity {
                mask: 1,
                group: 1,
                reserved: [0; 3],
            },
        ];
        assert_eq!(
            cpu_ids_for_group_affinities(&affinities, &topology).unwrap(),
            BTreeSet::from([0, 63, 64])
        );
        assert!(cpu_ids_for_group_affinities(
            &[WindowsGroupAffinity {
                mask: 0b10,
                group: 1,
                reserved: [0; 3],
            }],
            &topology,
        )
        .is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_cpu_id_list_expands_ranges_and_rejects_ambiguous_sets() {
        assert_eq!(
            parse_cpu_id_list("0-2,5,8-9").unwrap(),
            [0, 1, 2, 5, 8, 9].into_iter().collect()
        );
        assert!(parse_cpu_id_list("0-2,2-3").is_err());
        assert!(parse_cpu_id_list("5-3").is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_cgroup_v2_quota_preserves_fractional_capacity() {
        assert_eq!(
            parse_linux_v2_cpu_quota("50000 100000\n").unwrap(),
            CpuQuota::Limited {
                capacity_millis: 500
            }
        );
        assert_eq!(
            parse_linux_v2_cpu_quota("max 100000").unwrap(),
            CpuQuota::Unlimited
        );
        assert!(parse_linux_v2_cpu_quota("50000 0").is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn exact_cpu_set_and_quota_bound_effective_capacity() {
        let allowed = [0, 1, 2, 3].into_iter().collect();
        assert_eq!(
            effective_cpu_capacity_millis(
                Ok(1000),
                &Ok(allowed),
                &Ok(CpuQuota::Limited {
                    capacity_millis: 1500
                }),
            )
            .unwrap(),
            1500
        );
        assert_eq!(
            effective_cpu_capacity_millis(
                Ok(2000),
                &Ok([0, 1].into_iter().collect()),
                &Ok(CpuQuota::Limited {
                    capacity_millis: 500
                }),
            )
            .unwrap(),
            500
        );
    }

    #[test]
    fn unknown_cpu_quota_does_not_publish_fallback_capacity() {
        let fallback: Result<u64> = Ok(2000);
        let allowed: Result<BTreeSet<u32>> = Ok([0, 1].into_iter().collect());
        let quota: Result<CpuQuota> = Err(anyhow::anyhow!("quota sampling is unsupported"));

        assert!(effective_cpu_capacity_millis(fallback, &allowed, &quota).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_mountinfo_paths_decode_escaped_spaces_and_respect_mount_roots() {
        assert_eq!(
            decode_mountinfo_path("/sys/fs/cgroup/cpu\\040set").unwrap(),
            "/sys/fs/cgroup/cpu set"
        );
        assert_eq!(
            linux_cgroup_mount_path(
                std::path::Path::new("/tenant/job"),
                std::path::Path::new("/tenant"),
                std::path::Path::new("/sys/fs/cgroup"),
            )
            .unwrap(),
            std::path::PathBuf::from("/sys/fs/cgroup/job")
        );
    }

    #[test]
    fn nvidia_rows_preserve_stable_identity_and_mark_unknown_partition() {
        let devices = parse_nvidia_smi_output(
            concat!(
                "GPU-b,pci-0000:02:00.0,NVIDIA B,8192,63,71,Enabled\n",
                "GPU-a,pci-0000:01:00.0,NVIDIA A,4096,N/A,N/A,N/A\n",
            ),
            true,
        )
        .unwrap();
        assert_eq!(devices[0].uuid, "GPU-a");
        assert_eq!(devices[0].local_ordinal, Observation::Available { value: 1 });
        assert_eq!(
            devices[0].partition,
            Reported::Available {
                value: GpuPartition::Unknown
            }
        );
        assert_eq!(
            devices[0].utilization_percent,
            Observation::Unavailable {
                reason: UnavailableReason::NotReported
            }
        );
        assert_eq!(devices[1].vram_bytes, Reported::Available { value: 8192 * NVIDIA_MEMORY_MIB });
        assert_eq!(devices[1].temperature_millicelsius, Observation::Available { value: 71_000 });
    }

    #[test]
    fn disabled_mig_mode_is_the_only_full_device_report() {
        let devices = parse_nvidia_smi_output(
            "GPU-a,pci-0000:01:00.0,NVIDIA A,4096,0,42,Disabled\n",
            true,
        )
        .unwrap();

        assert_eq!(
            devices[0].partition,
            Reported::Available {
                value: GpuPartition::FullDevice
            }
        );
    }

    #[test]
    fn legacy_nvidia_query_preserves_telemetry_without_claiming_partition() {
        let devices = parse_nvidia_smi_output(
            "GPU-a,pci-0000:01:00.0,NVIDIA A,4096,0,42\n",
            false,
        )
        .unwrap();

        assert_eq!(
            devices[0].partition,
            Reported::Available {
                value: GpuPartition::Unknown
            }
        );
    }

    #[test]
    fn empty_or_malformed_gpu_discovery_is_not_reported_as_no_gpu() {
        assert!(parse_nvidia_smi_output("", true).is_err());
        assert!(parse_nvidia_smi_output("GPU-x,only-two-fields", false).is_err());
    }
}
