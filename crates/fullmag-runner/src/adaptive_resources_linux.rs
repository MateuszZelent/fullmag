use super::{
    allocation_integer, scheduler_process_cpu_allocation, ResourceSnapshot, WorkerPeak,
    WorkerProcessExitRace, WorkerSample, WorkerSampleError,
};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub struct ResourceSampler {
    last_cpu: Option<(u64, u64)>,
    last_groups: HashMap<PathBuf, (Instant, u64, f64)>,
    last_worker: HashMap<u32, (Instant, u64, u64)>,
    group_dirs: Vec<PathBuf>,
    affinity_cores: f64,
    affinity_ids: Vec<usize>,
    ticks_per_second: f64,
}

fn read_u64(path: &Path) -> Result<Option<u64>, String> {
    let value = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if value.trim() == "max" {
        return Ok(None);
    }
    value
        .trim()
        .parse()
        .map(Some)
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}
fn cgroup_dirs() -> Result<Vec<PathBuf>, String> {
    let membership = fs::read_to_string("/proc/self/cgroup").map_err(|e| e.to_string())?;
    let member = membership
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .ok_or("cgroup v2 telemetry unavailable; refusing to assume host limits")?;
    let mounts = fs::read_to_string("/proc/self/mountinfo").map_err(|e| e.to_string())?;
    for line in mounts.lines() {
        let Some((left, right)) = line.split_once(" - ") else {
            continue;
        };
        if right.split_whitespace().next() != Some("cgroup2") {
            continue;
        }
        let columns: Vec<_> = left.split_whitespace().collect();
        if columns.len() < 5 {
            continue;
        }
        // Escaped mount paths are rejected instead of joining unverified paths.
        if columns[3].contains('\\') || columns[4].contains('\\') {
            return Err("escaped cgroup mount paths are unsupported".into());
        }
        let mount = PathBuf::from(columns[4]);
        let relative = if member == "/" {
            // In a private cgroup namespace the membership root is this mount.
            Path::new("")
        } else {
            Path::new(member)
                .strip_prefix(columns[3])
                .map_err(|_| "cgroup membership does not belong to the mounted hierarchy")?
        };
        if relative
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err("invalid cgroup membership path".into());
        }
        let mut current = mount.join(relative);
        let mut directories = Vec::new();
        loop {
            if !current.starts_with(&mount) {
                return Err("cgroup escaped its mount".into());
            }
            directories.push(current.clone());
            if current == mount {
                break;
            }
            if !current.pop() {
                return Err("invalid cgroup hierarchy".into());
            }
        }
        return Ok(directories);
    }
    Err("cgroup v2 mount unavailable".into())
}

fn cpu_usage_scope_capacity(
    is_leaf: bool,
    affinity_cores: f64,
    quota_cores: Option<f64>,
) -> Option<f64> {
    // An unlimited ancestor contains sibling jobs outside our affinity.
    // Their aggregate usage has no finite budget to subtract from our team.
    // Competing demand on assigned CPUs is already measured by proc_cpu.
    quota_cores.or_else(|| is_leaf.then_some(affinity_cores))
}

fn proc_cpu(affinity_ids: &[usize]) -> Result<(u64, u64), String> {
    let text = fs::read_to_string("/proc/stat").map_err(|e| e.to_string())?;
    let mut total = 0_u64;
    let mut idle = 0_u64;
    let mut found = 0;
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(cpu) = parts.next().and_then(|name| name.strip_prefix("cpu")) else {
            continue;
        };
        let Ok(index) = cpu.parse::<usize>() else {
            continue;
        };
        if !affinity_ids.contains(&index) {
            continue;
        }
        let values: Vec<u64> = parts
            .take(8)
            .map(str::parse)
            .collect::<Result<_, _>>()
            .map_err(|e| format!("CPU counters: {e}"))?;
        if values.len() < 5 {
            return Err("incomplete CPU counters".into());
        }
        total = total.saturating_add(values.iter().sum::<u64>());
        idle = idle.saturating_add(values[3]).saturating_add(values[4]);
        found += 1;
    }
    if found != affinity_ids.len() || found == 0 {
        return Err("affinity CPU counters unavailable".into());
    }
    Ok((total, idle))
}
fn memory() -> Result<(u64, u64), String> {
    let text = fs::read_to_string("/proc/meminfo").map_err(|e| e.to_string())?;
    let value = |key: &str| -> Result<u64, String> {
        text.lines()
            .find_map(|line| line.strip_prefix(key))
            .and_then(|value| value.split_whitespace().next())
            .ok_or_else(|| format!("missing {key}"))?
            .parse::<u64>()
            .map(|value| value.saturating_mul(1024))
            .map_err(|e| e.to_string())
    };
    Ok((value("MemTotal:")?, value("MemAvailable:")?))
}

fn slurm_memory_limit_mib(
    memory_per_node: Option<u64>,
    memory_per_cpu: Option<u64>,
    cpus_on_node: Option<u64>,
) -> Result<Option<u64>, String> {
    if let Some(memory) = memory_per_node {
        return Ok(Some(memory));
    }
    let Some(memory_per_cpu) = memory_per_cpu else {
        return Ok(None);
    };
    let node_cpus = cpus_on_node.ok_or("SLURM_MEM_PER_CPU requires SLURM_CPUS_ON_NODE")?;
    if node_cpus == 0 {
        return Err("zero Slurm CPUs available on this node".into());
    }
    memory_per_cpu
        .checked_mul(node_cpus)
        .map(Some)
        .ok_or_else(|| "Slurm per-CPU memory allocation overflow".into())
}

fn slurm_job_memory_scope_index(
    directories: &[PathBuf],
    job_id: &str,
    step_id: Option<&str>,
) -> Option<(usize, &'static str)> {
    let job_component = format!("job_{job_id}");
    if let Some(index) = directories
        .iter()
        .position(|directory| directory.file_name() == Some(OsStr::new(job_component.as_str())))
    {
        return Some((index, "slurm_memory_scope_job_cgroup_by_job_id"));
    }

    // Slurm cgroup v2 uses an opaque SLUID for the job-level component by
    // default. Its documented hierarchy is slurmstepd.scope/SLUID/step_<id>/...;
    // accept the step parent only when both the exact environment step and the
    // Slurm hierarchy marker are present in this process's cgroup ancestry.
    if let Some(step_id) = step_id {
        let step_component = format!("step_{step_id}");
        if let Some(step_index) = directories
            .iter()
            .position(|directory| directory.file_name() == Some(OsStr::new(step_component.as_str())))
        {
            let job_index = step_index + 1;
            let slurm_scope_parent = directories
                .get(step_index + 2)
                .and_then(|directory| directory.file_name())
                .and_then(OsStr::to_str)
                .is_some_and(|name| {
                    name == "slurmstepd.scope" || name.ends_with("_slurmstepd.scope")
                });
            if directories.get(job_index).is_some() && slurm_scope_parent {
                return Some((
                    job_index,
                    "slurm_memory_scope_job_cgroup_by_step_parent",
                ));
            }
        }
    }

    None
}

fn memory_headroom_bytes(limit_bytes: u64, used_bytes: u64) -> u64 {
    limit_bytes.saturating_sub(used_bytes)
}

fn slurm_job_finite_memory_scope(
    job_scope_index: usize,
    mount_root_index: usize,
    finite_memory_scopes: &[(usize, u64, u64)],
) -> Option<(usize, u64, u64)> {
    // Cgroup paths are ordered leaf-to-root. A finite job limit or one of its
    // ancestors bounds the whole job; a task/step descendant cannot stand in
    // for sibling usage when no Slurm memory hint is available. An unverified
    // mount root is not allocation authority, unless it is the exact job scope.
    finite_memory_scopes
        .iter()
        .copied()
        .filter(|(index, _, _)| {
            *index >= job_scope_index && (*index == job_scope_index || *index < mount_root_index)
        })
        .min_by_key(|(index, _, _)| *index)
}

fn cpu_quota_cores(value: &str) -> Result<Option<f64>, String> {
    let fields: Vec<_> = value.split_whitespace().collect();
    if fields.len() != 2 {
        return Err("invalid cgroup CPU quota".into());
    }
    if fields[0] == "max" {
        return Ok(None);
    }
    let quota: f64 = fields[0].parse().map_err(|_| "invalid CPU quota")?;
    let period: f64 = fields[1].parse().map_err(|_| "invalid CPU period")?;
    if !quota.is_finite() || !period.is_finite() || quota <= 0.0 || period <= 0.0 {
        return Err("non-positive cgroup CPU quota".into());
    }
    Ok(Some(quota / period))
}

impl ResourceSampler {
    pub fn new() -> Result<Self, String> {
        let mut affinity: libc::cpu_set_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::sched_getaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &mut affinity)
        };
        if result != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let cores = unsafe { libc::CPU_COUNT(&affinity) };
        let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if cores == 0 || ticks <= 0 {
            return Err("invalid CPU allocation or clock frequency".into());
        }
        Ok(Self {
            last_cpu: None,
            last_groups: HashMap::new(),
            last_worker: HashMap::new(),
            group_dirs: cgroup_dirs()?,
            affinity_cores: cores as f64,
            affinity_ids: (0..libc::CPU_SETSIZE as usize)
                .filter(|index| unsafe { libc::CPU_ISSET(*index, &affinity) })
                .collect(),
            ticks_per_second: ticks as f64,
        })
    }

    pub fn cpu_allocation_cores(
        &self,
        scheduler_cpu_cores: Option<u64>,
    ) -> Result<f64, String> {
        let mut cores = self.affinity_cores;
        if let Some(allocated_cores) = scheduler_cpu_cores {
            cores = cores.min(allocated_cores as f64);
        }
        for directory in &self.group_dirs {
            if let Some(value) = read_optional(&directory.join("cpu.max"))? {
                if let Some(quota_cores) = cpu_quota_cores(&value)? {
                    cores = cores.min(quota_cores);
                }
            }
        }
        if !cores.is_finite() || cores <= 0.0 {
            return Err("no positive effective CPU allocation is available".into());
        }
        Ok(cores)
    }

    pub fn sample(&mut self) -> Result<ResourceSnapshot, String> {
        let mut current_affinity: libc::cpu_set_t = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::sched_getaffinity(
                0,
                std::mem::size_of::<libc::cpu_set_t>(),
                &mut current_affinity,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let ids: Vec<_> = (0..libc::CPU_SETSIZE as usize)
            .filter(|index| unsafe { libc::CPU_ISSET(*index, &current_affinity) })
            .collect();
        if ids.is_empty() {
            return Err("empty CPU affinity".into());
        }
        let directories = cgroup_dirs()?;
        if ids != self.affinity_ids || directories != self.group_dirs {
            self.affinity_cores = ids.len() as f64;
            self.affinity_ids = ids;
            self.group_dirs = directories;
            self.last_cpu = None;
            self.last_groups.clear();
            return Err("allocation changed; CPU telemetry warming up".into());
        }
        let (total_memory, host_available) = memory()?;
        let mut limit = total_memory;
        let mut available = host_available;
        let mut cores = self.affinity_cores;
        let mut cpu_scopes = Vec::new();
        let mut finite_memory_scopes = Vec::new();
        let mut sources = vec!["sched_getaffinity".into(), "proc_memavailable".into()];
        for (index, directory) in self.group_dirs.iter().enumerate() {
            let mut quota_cores = None;
            if let Some(quota) = read_optional(&directory.join("cpu.max"))? {
                if let Some(allocated_cores) = cpu_quota_cores(&quota)? {
                    cores = cores.min(allocated_cores);
                    quota_cores = Some(allocated_cores);
                    sources.push("cgroup_v2_cpu_max".into());
                }
            }
            if let Some(scope_cores) = cpu_usage_scope_capacity(
                directory == &self.group_dirs[0],
                self.affinity_cores,
                quota_cores,
            ) {
                cpu_scopes.push((directory.clone(), scope_cores));
            }
            if read_optional(&directory.join("memory.max"))?.is_some() {
                if let Some(maximum) = read_u64(&directory.join("memory.max"))? {
                    let used = read_u64(&directory.join("memory.current"))?
                        .ok_or("invalid cgroup memory.current")?;
                    finite_memory_scopes.push((index, maximum, used));
                    limit = limit.min(maximum);
                    available = available.min(memory_headroom_bytes(maximum, used));
                    sources.push("cgroup_v2_memory_max".into());
                    sources.push(if index == 0 {
                        "cgroup_v2_memory_scope_leaf".into()
                    } else {
                        format!("cgroup_v2_memory_scope_ancestor_{index}")
                    });
                }
            }
        }
        let scheduler_cpus = scheduler_process_cpu_allocation()?;
        if let Some((cpus, source)) = scheduler_cpus {
            cores = cores.min(cpus as f64);
            sources.push("scheduler_cpu_allocation".into());
            sources.push(source.into());
        }
        let (slurm_memory, slurm_memory_source) = if std::env::var_os("SLURM_JOB_ID").is_some() {
            let per_node = allocation_integer("SLURM_MEM_PER_NODE")?;
            if let Some(mebibytes) = per_node {
                (Some(mebibytes), Some("slurm_memory_per_node"))
            } else {
                let per_cpu = allocation_integer("SLURM_MEM_PER_CPU")?;
                let node_cpus = if per_cpu.is_some() {
                    allocation_integer("SLURM_CPUS_ON_NODE")?
                } else {
                    None
                };
                (
                    slurm_memory_limit_mib(per_node, per_cpu, node_cpus)?,
                    per_cpu.map(|_| "slurm_memory_per_cpu_x_cpus_on_node"),
                )
            }
        } else {
            // Inherited settings outside a Slurm job are not an allocation.
            (None, None)
        };
        if std::env::var_os("SLURM_JOB_ID").is_some() {
            let job_id = std::env::var("SLURM_JOB_ID")
                .map_err(|_| "invalid SLURM_JOB_ID for memory accounting")?;
            if job_id.trim().is_empty() {
                return Err("empty SLURM_JOB_ID for memory accounting".into());
            }
            let step_id = std::env::var("SLURM_STEP_ID").ok();
            let (scope_index, scope_source) = slurm_job_memory_scope_index(
                &self.group_dirs,
                &job_id,
                step_id.as_deref(),
            )
            .ok_or("Slurm memory allocation cgroup scope unavailable; refusing unverified job usage")?;
            if let Some(mib) = slurm_memory {
                let scheduler_limit = mib
                    .checked_mul(1024 * 1024)
                    .ok_or("Slurm memory allocation overflow")?;
                if scheduler_limit == 0 {
                    return Err("zero scheduler memory allocation".into());
                }
                let job_usage = read_u64(&self.group_dirs[scope_index].join("memory.current"))?
                    .ok_or("invalid Slurm job cgroup memory.current")?;
                available = available.min(memory_headroom_bytes(scheduler_limit, job_usage));
                limit = limit.min(scheduler_limit);
                sources.push("slurm_memory_allocation".into());
                sources.push(
                    slurm_memory_source
                        .ok_or("Slurm memory allocation source unavailable")?
                        .into(),
                );
            } else {
                let (limit_scope_index, cgroup_limit, used) =
                    slurm_job_finite_memory_scope(
                        scope_index,
                        self.group_dirs.len().saturating_sub(1),
                        &finite_memory_scopes,
                    )
                        .ok_or("Slurm job memory allocation unavailable; require finite job cgroup memory.max or a finite ancestor")?;
                available = available.min(memory_headroom_bytes(cgroup_limit, used));
                limit = limit.min(cgroup_limit);
                sources.push("slurm_job_memory_cgroup_allocation".into());
                sources.push(if limit_scope_index == scope_index {
                    "slurm_memory_limit_scope_job_cgroup".into()
                } else {
                    "slurm_memory_limit_scope_job_ancestor".into()
                });
            }
            sources.push(scope_source.into());
        } else if finite_memory_scopes.is_empty() {
            return Err("finite cgroup or scheduler memory allocation unavailable".into());
        }
        let current = proc_cpu(&self.affinity_ids)?;
        let previous = self
            .last_cpu
            .replace(current)
            .ok_or("CPU telemetry warming up")?;
        let delta = current
            .0
            .checked_sub(previous.0)
            .ok_or("CPU counter reset")?;
        let idle = current
            .1
            .checked_sub(previous.1)
            .ok_or("CPU idle counter reset")?;
        if delta == 0 || idle > delta {
            return Err("CPU telemetry has no valid interval".into());
        }
        let affinity_busy_percent = 100.0 * (delta - idle) as f64 / delta as f64;
        let mut cpu_available_cores = self.affinity_cores * (1.0 - affinity_busy_percent / 100.0);
        let mut allocation_busy_percent = None;
        // Keep each authority in its own capacity domain. A busy 12-core
        // ancestor must not be interpreted as the same percentage of a 4-core
        // leaf allocation. Intersect free capacities in cores instead.
        for (directory, scope_cores) in &mut cpu_scopes {
            if directory == &self.group_dirs[0] {
                *scope_cores = scope_cores.min(cores);
            }
        }
        // Drop histories when an ancestor loses its quota. If a finite quota
        // returns, require a fresh interval rather than reusing an old window.
        self.last_groups
            .retain(|directory, _| cpu_scopes.iter().any(|(scope, _)| scope == directory));
        let now = Instant::now();
        let mut group_warming_up = false;
        sources.push("cgroup_v2_cpu_usage".into());
        for (directory, scope_cores) in cpu_scopes {
            let group_text =
                fs::read_to_string(directory.join("cpu.stat")).map_err(|e| e.to_string())?;
            let usage = group_text
                .lines()
                .find_map(|line| line.strip_prefix("usage_usec "))
                .ok_or("missing cgroup CPU usage")?
                .trim()
                .parse::<u64>()
                .map_err(|e| e.to_string())?;
            if let Some((before, previous_usage, previous_quota)) = self
                .last_groups
                .insert(directory.clone(), (now, usage, scope_cores))
            {
                if previous_quota != scope_cores {
                    group_warming_up = true;
                    continue;
                }
                let seconds = now.saturating_duration_since(before).as_secs_f64();
                if seconds <= 0.0 || usage < previous_usage {
                    return Err("invalid cgroup CPU interval".into());
                }
                let used_cores = (usage - previous_usage) as f64 / 1e6 / seconds;
                cpu_available_cores = cpu_available_cores.min((scope_cores - used_cores).max(0.0));
                if directory == self.group_dirs[0] {
                    allocation_busy_percent = Some((used_cores / cores * 100.0).clamp(0.0, 100.0));
                }
            } else {
                group_warming_up = true;
            }
        }
        if group_warming_up {
            return Err("cgroup CPU telemetry warming up".into());
        }
        sources.sort();
        sources.dedup();
        Ok(ResourceSnapshot {
            sampled_at: Instant::now(),
            sampled_at_unix_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_millis()
                .try_into()
                .map_err(|_| "timestamp overflow")?,
            allocated_cpu_cores: cores,
            cpu_busy_percent: allocation_busy_percent
                .ok_or("allocation CPU telemetry unavailable")?,
            cpu_available_cores: cpu_available_cores.min(cores),
            memory_limit_bytes: limit,
            memory_available_bytes: available.min(limit),
            allocation_sources: sources,
        })
    }

    pub fn forget_worker(&mut self, pid: u32) {
        self.last_worker.remove(&pid);
    }

    pub fn worker_peak(&mut self, pid: u32) -> Result<WorkerSample, WorkerSampleError> {
        let membership = read_worker_proc_file(pid, "cgroup")?;
        let parent_membership =
            fs::read_to_string("/proc/self/cgroup")
                .map_err(|error| WorkerSampleError::Other(error.to_string()))?;
        if membership != parent_membership {
            return Err(WorkerSampleError::Other(
                "worker allocation differs from its parent pool".into(),
            ));
        }
        let (start, ticks, rss) = process_measurement(pid)?;
        if self
            .last_worker
            .get(&pid)
            .is_some_and(|(_, previous_start, _)| *previous_start != start)
        {
            return Err(WorkerSampleError::Other(
                "worker PID identity changed".into(),
            ));
        }
        let now = Instant::now();
        let mut cpu_interval = None;
        let cpu = match self.last_worker.insert(pid, (now, start, ticks)) {
            Some((before, previous_start, previous_ticks))
                if start == previous_start && ticks >= previous_ticks =>
            {
                let elapsed = now.saturating_duration_since(before).as_secs_f64();
                if elapsed > 0.0 {
                    cpu_interval = Some(Duration::from_secs_f64(elapsed));
                    (ticks - previous_ticks) as f64 / self.ticks_per_second / elapsed
                } else {
                    0.0
                }
            }
            _ => 0.0,
        };
        Ok(WorkerSample {
            peak: WorkerPeak { cpu_cores: cpu, rss_bytes: rss },
            cpu_interval,
        })
    }
}

fn read_worker_proc_file(pid: u32, file: &str) -> Result<String, WorkerSampleError> {
    let path = format!("/proc/{pid}/{file}");
    fs::read_to_string(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            WorkerSampleError::ProcessExitRace(WorkerProcessExitRace::ProcFileNotFound(path))
        } else {
            WorkerSampleError::Other(format!("read worker proc file {path}: {error}"))
        }
    })
}

fn process_measurement(pid: u32) -> Result<(u64, u64, u64), WorkerSampleError> {
    let text = read_worker_proc_file(pid, "stat")?;
    // comm may contain spaces or parentheses; fields begin after its LAST closing parenthesis.
    let (_, fields) = text.rsplit_once(')').ok_or("invalid process stat")?;
    let fields: Vec<_> = fields.split_whitespace().collect();
    let value = |index: usize| -> Result<u64, String> {
        fields
            .get(index)
            .ok_or("incomplete process stat")?
            .parse()
            .map_err(|e| format!("process stat: {e}"))
    };
    let ticks = value(11)?.saturating_add(value(12)?);
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page <= 0 {
        return Err("invalid page size".into());
    }
    let current_rss = value(21)?
        .checked_mul(page as u64)
        .ok_or("worker RSS overflow")?;
    // VmHWM is the kernel-maintained RSS high water mark. Periodic current
    // RSS alone can miss an allocation peak between admission samples.
    let status = read_worker_proc_file(pid, "status")?;
    let high_water_line = status
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))
        .ok_or_else(|| {
            WorkerSampleError::ProcessExitRace(WorkerProcessExitRace::HighWaterMarkUnavailable)
        })?;
    let fields: Vec<_> = high_water_line.split_whitespace().collect();
    if fields.len() != 2 || fields[1] != "kB" {
        return Err("invalid worker memory high water mark units".into());
    }
    let high_water_rss = fields[0]
        .parse::<u64>()
        .map_err(|error| format!("worker memory high water mark: {error}"))?
        .checked_mul(1024)
        .ok_or("worker memory high water mark overflow")?;
    Ok((value(19)?, ticks, current_rss.max(high_water_rss)))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    #[test]
    fn worker_owned_proc_not_found_is_a_typed_exit_race() {
        let pid = u32::MAX;
        assert_eq!(
            super::read_worker_proc_file(pid, "stat"),
            Err(super::WorkerSampleError::ProcessExitRace(
                super::WorkerProcessExitRace::ProcFileNotFound(format!("/proc/{pid}/stat"))
            ))
        );
    }

    #[test]
    fn unlimited_ancestor_usage_does_not_consume_leaf_affinity_budget() {
        assert_eq!(super::cpu_usage_scope_capacity(false, 4.0, None), None);
        assert_eq!(super::cpu_usage_scope_capacity(true, 4.0, None), Some(4.0));
        assert_eq!(
            super::cpu_usage_scope_capacity(false, 4.0, Some(12.0)),
            Some(12.0)
        );
        assert_eq!(
            super::cpu_usage_scope_capacity(true, 4.0, Some(2.0)),
            Some(2.0)
        );
    }

    #[test]
    fn slurm_memory_per_cpu_uses_node_cpu_count_not_task_cpu_count() {
        assert_eq!(
            super::slurm_memory_limit_mib(None, Some(512), Some(16)).unwrap(),
            Some(8192)
        );
        assert_eq!(
            super::slurm_memory_limit_mib(Some(4096), Some(512), None).unwrap(),
            Some(4096),
            "a per-node memory request does not require a CPU multiplier"
        );
        assert!(super::slurm_memory_limit_mib(None, Some(512), None).is_err());
    }

    #[test]
    fn cpu_quota_is_an_additional_effective_allocation_cap() {
        assert_eq!(super::cpu_quota_cores("200000 100000").unwrap(), Some(2.0));
        assert_eq!(super::cpu_quota_cores("max 100000").unwrap(), None);
        assert!(super::cpu_quota_cores("invalid").is_err());
    }

    #[test]
    fn slurm_memory_headroom_uses_job_cgroup_usage_including_sibling_tasks() {
        let directories = vec![
            PathBuf::from("/sys/fs/cgroup/slurm/uid_7/job_42/step_0/task_0"),
            PathBuf::from("/sys/fs/cgroup/slurm/uid_7/job_42/step_0"),
            PathBuf::from("/sys/fs/cgroup/slurm/uid_7/job_42"),
            PathBuf::from("/sys/fs/cgroup/slurm/uid_7"),
            PathBuf::from("/sys/fs/cgroup/slurm"),
        ];
        let scope = super::slurm_job_memory_scope_index(&directories, "42", Some("0"))
            .expect("current cgroup ancestry includes the exact Slurm job");
        assert_eq!(scope.0, 2);
        assert_eq!(scope.1, "slurm_memory_scope_job_cgroup_by_job_id");

        // memory.current at the job cgroup includes this task and its siblings.
        let current_by_scope = [2_u64, 9, 15, 40];
        let allocation = 20;
        assert_eq!(
            super::memory_headroom_bytes(allocation, current_by_scope[scope.0]),
            5
        );
        assert_ne!(
            super::memory_headroom_bytes(allocation, current_by_scope[0]),
            5,
            "the task leaf must not be subtracted from a job-wide allocation"
        );
    }

    #[test]
    fn slurm_without_memory_environment_rejects_leaf_limit_but_accepts_job_limit() {
        let directories = vec![
            PathBuf::from("/sys/fs/cgroup/slurm/uid_7/job_42/step_0/task_0"),
            PathBuf::from("/sys/fs/cgroup/slurm/uid_7/job_42/step_0"),
            PathBuf::from("/sys/fs/cgroup/slurm/uid_7/job_42"),
            PathBuf::from("/sys/fs/cgroup/slurm/uid_7"),
            PathBuf::from("/sys/fs/cgroup/slurm"),
        ];
        let (job_scope_index, _) =
            super::slurm_job_memory_scope_index(&directories, "42", Some("0"))
                .expect("the process belongs to the exact Slurm job cgroup");
        assert_eq!(super::slurm_memory_limit_mib(None, None, None).unwrap(), None);

        let leaf_only = [(0, 64_u64 << 20, 16_u64 << 20)];
        assert_eq!(
            super::slurm_job_finite_memory_scope(
                job_scope_index,
                directories.len() - 1,
                &leaf_only
            ),
            None,
            "a finite task leaf cannot stand in for the Slurm job allocation"
        );

        let job_scope_limit = [
            (0, 64_u64 << 20, 16_u64 << 20),
            (job_scope_index, 128_u64 << 20, 96_u64 << 20),
        ];
        let (limit_index, limit, used) =
            super::slurm_job_finite_memory_scope(
                job_scope_index,
                directories.len() - 1,
                &job_scope_limit,
            )
            .expect("finite job memory.max is an allocation authority");
        assert_eq!(limit_index, job_scope_index);
        assert_eq!(super::memory_headroom_bytes(limit, used), 32_u64 << 20);

        let ancestor_only = [(3, 256_u64 << 20, 224_u64 << 20)];
        assert_eq!(
            super::slurm_job_finite_memory_scope(
                job_scope_index,
                directories.len() - 1,
                &ancestor_only,
            ),
            Some((3, 256_u64 << 20, 224_u64 << 20)),
            "a finite cgroup ancestor above the verified job cgroup covers it"
        );
        let mount_root_only = [(directories.len() - 1, 512_u64 << 20, 128_u64 << 20)];
        assert_eq!(
            super::slurm_job_finite_memory_scope(
                job_scope_index,
                directories.len() - 1,
                &mount_root_only,
            ),
            None,
            "an unverified mount root cannot stand in for a Slurm allocation"
        );
    }

    #[test]
    fn slurm_step_parent_is_accepted_only_inside_slurmstepd_hierarchy() {
        let directories = vec![
            PathBuf::from("/sys/fs/cgroup/system.slice/slurmstepd.scope/sABC/step_batch/user/task_0"),
            PathBuf::from("/sys/fs/cgroup/system.slice/slurmstepd.scope/sABC/step_batch/user"),
            PathBuf::from("/sys/fs/cgroup/system.slice/slurmstepd.scope/sABC/step_batch"),
            PathBuf::from("/sys/fs/cgroup/system.slice/slurmstepd.scope/sABC"),
            PathBuf::from("/sys/fs/cgroup/system.slice/slurmstepd.scope"),
            PathBuf::from("/sys/fs/cgroup/system.slice"),
        ];
        assert_eq!(
            super::slurm_job_memory_scope_index(&directories, "42", Some("batch")),
            Some((3, "slurm_memory_scope_job_cgroup_by_step_parent"))
        );

        let unrelated = vec![
            PathBuf::from("/sys/fs/cgroup/container/step_0/task_0"),
            PathBuf::from("/sys/fs/cgroup/container/step_0"),
            PathBuf::from("/sys/fs/cgroup/container"),
        ];
        assert_eq!(
            super::slurm_job_memory_scope_index(&unrelated, "42", Some("0")),
            None,
            "a leaf limit or a coincidentally named step is not job-wide authority"
        );
    }

    #[test]
    fn private_cgroup_root_without_job_provenance_is_unavailable() {
        let directories = vec![
            PathBuf::from("/sys/fs/cgroup/private/task_0"),
            PathBuf::from("/sys/fs/cgroup/private"),
        ];
        assert_eq!(
            super::slurm_job_memory_scope_index(&directories, "42", None),
            None,
            "a finite or unbounded private namespace root does not prove sibling scope"
        );
    }
}
