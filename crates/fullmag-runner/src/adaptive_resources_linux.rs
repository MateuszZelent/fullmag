use super::{
    ResourceSnapshot, WorkerPeak, WorkerProcessExitRace, WorkerSample, WorkerSampleError,
};
use std::collections::HashMap;
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

fn allocation_integer(name: &str) -> Result<Option<u64>, String> {
    match std::env::var(name) {
        Ok(value) => value
            .parse::<u64>()
            .map(Some)
            .map_err(|_| format!("invalid scheduler allocation {name}")),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
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
        let mut finite_memory_authority = false;
        let mut sources = vec!["sched_getaffinity".into(), "proc_memavailable".into()];
        for directory in &self.group_dirs {
            let mut quota_cores = None;
            if let Some(quota) = read_optional(&directory.join("cpu.max"))? {
                let fields: Vec<_> = quota.split_whitespace().collect();
                if fields.len() != 2 {
                    return Err("invalid cgroup CPU quota".into());
                }
                if fields[0] != "max" {
                    let quota: f64 = fields[0].parse().map_err(|_| "invalid CPU quota")?;
                    let period: f64 = fields[1].parse().map_err(|_| "invalid CPU period")?;
                    if !quota.is_finite() || !period.is_finite() || quota <= 0.0 || period <= 0.0 {
                        return Err("non-positive cgroup CPU quota".into());
                    }
                    cores = cores.min(quota / period);
                    quota_cores = Some(quota / period);
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
                    finite_memory_authority = true;
                    limit = limit.min(maximum);
                    available = available.min(maximum.saturating_sub(used));
                    sources.push("cgroup_v2_memory_max".into());
                }
            }
        }
        let scheduler_active = ["SLURM_JOB_ID", "PBS_JOBID", "JOB_ID"]
            .iter()
            .any(|name| std::env::var_os(name).is_some());
        let scheduler_cpus = allocation_integer("SLURM_CPUS_PER_TASK")?
            .or(allocation_integer("SLURM_CPUS_ON_NODE")?)
            .or(allocation_integer("PBS_NP")?)
            .or(allocation_integer("NSLOTS")?);
        if let Some(cpus) = scheduler_cpus {
            if cpus == 0 {
                return Err("zero scheduler CPU allocation".into());
            }
            cores = cores.min(cpus as f64);
            sources.push("scheduler_cpu_allocation".into());
        } else if scheduler_active {
            return Err(
                "HPC job has no explicit CPU allocation; refusing node-wide assumptions".into(),
            );
        }
        let slurm_memory = if std::env::var_os("SLURM_JOB_ID").is_some() {
            allocation_integer("SLURM_MEM_PER_NODE")?
                .or(allocation_integer("SLURM_MEM_PER_CPU")?.map(|value| {
                    value.saturating_mul(scheduler_cpus.unwrap_or(self.affinity_cores as u64))
                }))
        } else {
            // Inherited settings outside a Slurm job are not an allocation.
            None
        };
        if !finite_memory_authority && slurm_memory.is_none() {
            return Err("finite cgroup or scheduler memory allocation unavailable".into());
        }
        if let Some(mib) = slurm_memory {
            let scheduler_limit = mib.saturating_mul(1024 * 1024);
            if scheduler_limit == 0 {
                return Err("zero scheduler memory allocation".into());
            }
            // Account the entire job/container group, including every worker and other consumers.
            let self_rss = read_u64(&self.group_dirs[0].join("memory.current"))?
                .ok_or("invalid cgroup memory accounting")?;
            available = available.min(scheduler_limit.saturating_sub(self_rss));
            limit = limit.min(scheduler_limit);
            sources.push("slurm_memory_allocation".into());
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
}
