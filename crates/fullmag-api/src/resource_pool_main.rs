mod worker_startup_gate;

use anyhow::{bail, Context, Result};
use fullmag_session::{
    FmsResourceBudget, FmsResourceKind, FmsSchedulerResourceOffer, FmsSchedulerResourcePool,
    SchedulerResourcePoolCommitDisposition, FMS_SCHEDULER_RESOURCE_POOL_SCHEMA,
};
use std::path::{Path, PathBuf};
use std::process::Command;

struct ResourcePoolArgs {
    store_root: PathBuf,
    pool_id: String,
    expected_generation: u64,
    resources: Vec<FmsSchedulerResourceOffer>,
    discovery: Option<LocalDiscoveryArgs>,
    dry_run: bool,
}

struct LocalDiscoveryArgs {
    host_resource_id: String,
    include_cpu: bool,
    require_gpu: bool,
    cpu_reserve_millis: u64,
    memory_reserve_bytes: u64,
    storage_reserve_bytes: u64,
}

struct LocalDiscoveryResult {
    resources: Vec<FmsSchedulerResourceOffer>,
    cpu_millis_detected: u64,
    memory_bytes_detected: u64,
    storage_bytes_detected: u64,
    gpu_status: &'static str,
    gpu_reason: Option<String>,
    gpu_count: usize,
}

struct LocalGpu {
    resource_suffix: String,
    memory_free_bytes: u64,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("scheduler resource pool publication failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    worker_startup_gate::verify_runtime_owner_build()?;
    let discovery = args
        .discovery
        .as_ref()
        .map(|options| discover_local_resources(&args.store_root, options))
        .transpose()?;
    let resources = discovery
        .as_ref()
        .map(|result| result.resources.clone())
        .unwrap_or_else(|| args.resources.clone());
    let pool = FmsSchedulerResourcePool {
        schema_version: FMS_SCHEDULER_RESOURCE_POOL_SCHEMA.into(),
        pool_id: args.pool_id,
        generation: args
            .expected_generation
            .checked_add(1)
            .context("scheduler resource pool generation overflow")?,
        resources,
    };
    pool.validate()?;

    let status = if args.dry_run {
        "dry_run"
    } else {
        let store = fullmag_runtime_control::retry_store_writer_busy(|| {
            fullmag_session::SessionStore::open_existing(&args.store_root)
        })
        .with_context(|| format!("open session store `{}`", args.store_root.display()))?;
        let disposition = fullmag_runtime_control::retry_store_writer_busy(|| {
            store.commit_scheduler_resource_pool(args.expected_generation, &pool)
        })
        .context("commit scheduler resource pool")?;
        match disposition {
            SchedulerResourcePoolCommitDisposition::Accepted => "accepted",
            SchedulerResourcePoolCommitDisposition::Replayed => "replayed",
        }
    };

    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "status": status,
            "pool_id": pool.pool_id,
            "generation": pool.generation,
            "resource_count": pool.resources.len(),
            "resource_ids": pool
                .resources
                .iter()
                .map(|resource| resource.resource_id.as_str())
                .collect::<Vec<_>>(),
            "resources": pool.resources,
            "discovery": discovery.as_ref().map(|result| serde_json::json!({
                "allocation_policy": "equal_shared_capacity_partition",
                "cpu_millis_detected": result.cpu_millis_detected,
                "memory_bytes_detected": result.memory_bytes_detected,
                "storage_bytes_detected": result.storage_bytes_detected,
                "gpu_status": result.gpu_status,
                "gpu_reason": result.gpu_reason,
                "gpu_count": result.gpu_count,
            })),
        }))?
    );
    Ok(())
}

fn discover_local_resources(
    store_root: &Path,
    options: &LocalDiscoveryArgs,
) -> Result<LocalDiscoveryResult> {
    let capacity = fullmag_runtime_control::local_resources::LocalCpuCapacity::observe(store_root)?;
    let cpu_millis_detected = capacity.cpu_millis;
    let memory_bytes_detected = capacity.memory_available_bytes;
    let storage_bytes_detected = capacity.storage_available_bytes;

    let (gpus, gpu_status, gpu_reason) = match discover_nvidia_gpus() {
        Ok(gpus) if gpus.is_empty() => (
            gpus,
            "unavailable",
            Some("nvidia-smi returned no GPU devices".to_string()),
        ),
        Ok(gpus) => (gpus, "available", None),
        Err(error) if options.require_gpu => {
            return Err(error).context("required GPU discovery failed");
        }
        Err(error) => (Vec::new(), "unavailable", Some(format!("{error:#}"))),
    };
    if options.require_gpu && gpus.is_empty() {
        bail!("required GPU discovery returned no devices");
    }

    let resource_count = gpus.len() + usize::from(options.include_cpu);
    if resource_count == 0 {
        bail!("local discovery produced no CPU or GPU resource offers");
    }
    let resource_count_u64 = u64::try_from(resource_count).context("resource count overflow")?;
    let allocatable_cpu = cpu_millis_detected
        .checked_sub(options.cpu_reserve_millis)
        .context("cpu reserve exceeds detected logical CPU capacity")?;
    let allocatable_memory = memory_bytes_detected
        .checked_sub(options.memory_reserve_bytes)
        .context("memory reserve exceeds detected available memory")?;
    let allocatable_storage = storage_bytes_detected
        .checked_sub(options.storage_reserve_bytes)
        .context("storage reserve exceeds detected available storage")?;
    let shared_budget = FmsResourceBudget {
        cpu_millis: allocatable_cpu / resource_count_u64,
        memory_bytes: allocatable_memory / resource_count_u64,
        gpu_memory_bytes: 0,
        storage_bytes: allocatable_storage / resource_count_u64,
    };
    if shared_budget.cpu_millis == 0
        || shared_budget.memory_bytes == 0
        || shared_budget.storage_bytes == 0
    {
        bail!("reserved capacity leaves a zero shared resource budget");
    }

    let mut resources = Vec::with_capacity(resource_count);
    if options.include_cpu {
        resources.push(FmsSchedulerResourceOffer {
            resource_id: format!("{}.cpu", options.host_resource_id),
            kind: FmsResourceKind::Cpu,
            budget: shared_budget.clone(),
        });
    }
    for gpu in &gpus {
        resources.push(FmsSchedulerResourceOffer {
            resource_id: format!("{}.gpu.{}", options.host_resource_id, gpu.resource_suffix),
            kind: FmsResourceKind::Gpu,
            budget: FmsResourceBudget {
                gpu_memory_bytes: gpu.memory_free_bytes,
                ..shared_budget.clone()
            },
        });
    }

    Ok(LocalDiscoveryResult {
        resources,
        cpu_millis_detected,
        memory_bytes_detected,
        storage_bytes_detected,
        gpu_status,
        gpu_reason,
        gpu_count: gpus.len(),
    })
}

fn discover_nvidia_gpus() -> Result<Vec<LocalGpu>> {
    let output = Command::new("nvidia-smi")
        .args([
            "--query-gpu=uuid,memory.free",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .context("launch nvidia-smi")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            format!("nvidia-smi exited with status {}", output.status)
        } else {
            stderr
        };
        bail!("sample NVIDIA GPU capacity: {detail}");
    }
    let stdout = String::from_utf8(output.stdout).context("nvidia-smi emitted invalid UTF-8")?;
    stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let (uuid, memory_mib) = line
                .split_once(',')
                .with_context(|| format!("unexpected nvidia-smi output shape: `{line}`"))?;
            let uuid = uuid.trim();
            if uuid.is_empty()
                || !uuid
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
            {
                bail!("nvidia-smi returned an invalid GPU UUID `{uuid}`");
            }
            let memory_mib = memory_mib
                .trim()
                .parse::<u64>()
                .with_context(|| format!("parse free GPU memory from `{line}`"))?;
            let memory_free_bytes = memory_mib
                .checked_mul(1024 * 1024)
                .context("GPU memory capacity overflow")?;
            if memory_free_bytes == 0 {
                bail!("nvidia-smi reported zero free memory for GPU `{uuid}`");
            }
            Ok(LocalGpu {
                resource_suffix: uuid.to_string(),
                memory_free_bytes,
            })
        })
        .collect()
}

fn parse_args() -> Result<ResourcePoolArgs> {
    let mut store_root = None;
    let mut pool_id = None;
    let mut expected_generation = None;
    let mut resources = Vec::new();
    let mut discover_local = None;
    let mut host_resource_id = None;
    let mut include_cpu = None;
    let mut require_gpu = None;
    let mut cpu_reserve_millis = None;
    let mut memory_reserve_bytes = None;
    let mut storage_reserve_bytes = None;
    let mut dry_run = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        let flag = argument
            .into_string()
            .map_err(|_| anyhow::anyhow!("resource pool option name must be valid UTF-8"))?;
        let value = args
            .next()
            .with_context(|| format!("resource pool option `{flag}` requires a value"))?
            .into_string()
            .map_err(|_| anyhow::anyhow!("resource pool option `{flag}` must be valid UTF-8"))?;
        match flag.as_str() {
            "--store-root" if store_root.is_none() => store_root = Some(PathBuf::from(value)),
            "--pool-id" if pool_id.is_none() => pool_id = Some(value),
            "--expected-generation" if expected_generation.is_none() => {
                expected_generation = Some(parse_u64(&flag, &value)?)
            }
            "--resource-offer" => resources.push(
                serde_json::from_str::<FmsSchedulerResourceOffer>(&value).context(
                    "resource pool option `--resource-offer` must be valid resource JSON",
                )?,
            ),
            "--discover-local" if discover_local.is_none() => {
                discover_local = Some(parse_bool(&flag, &value)?)
            }
            "--host-resource-id" if host_resource_id.is_none() => host_resource_id = Some(value),
            "--include-cpu" if include_cpu.is_none() => {
                include_cpu = Some(parse_bool(&flag, &value)?)
            }
            "--require-gpu" if require_gpu.is_none() => {
                require_gpu = Some(parse_bool(&flag, &value)?)
            }
            "--cpu-reserve-millis" if cpu_reserve_millis.is_none() => {
                cpu_reserve_millis = Some(parse_u64(&flag, &value)?)
            }
            "--memory-reserve-bytes" if memory_reserve_bytes.is_none() => {
                memory_reserve_bytes = Some(parse_u64(&flag, &value)?)
            }
            "--storage-reserve-bytes" if storage_reserve_bytes.is_none() => {
                storage_reserve_bytes = Some(parse_u64(&flag, &value)?)
            }
            "--dry-run" if dry_run.is_none() => dry_run = Some(parse_bool(&flag, &value)?),
            known
                if matches!(
                    known,
                    "--store-root"
                        | "--pool-id"
                        | "--expected-generation"
                        | "--discover-local"
                        | "--host-resource-id"
                        | "--include-cpu"
                        | "--require-gpu"
                        | "--cpu-reserve-millis"
                        | "--memory-reserve-bytes"
                        | "--storage-reserve-bytes"
                        | "--dry-run"
                ) =>
            {
                bail!("resource pool option `{flag}` was supplied more than once")
            }
            _ => bail!("unknown resource pool option `{flag}`"),
        }
    }

    let discovery = if discover_local.unwrap_or(false) {
        if !resources.is_empty() {
            bail!("--discover-local cannot be combined with --resource-offer");
        }
        Some(LocalDiscoveryArgs {
            host_resource_id: host_resource_id.context("missing required --host-resource-id")?,
            include_cpu: include_cpu.unwrap_or(true),
            require_gpu: require_gpu.unwrap_or(false),
            cpu_reserve_millis: cpu_reserve_millis
                .context("missing required --cpu-reserve-millis")?,
            memory_reserve_bytes: memory_reserve_bytes
                .context("missing required --memory-reserve-bytes")?,
            storage_reserve_bytes: storage_reserve_bytes
                .context("missing required --storage-reserve-bytes")?,
        })
    } else {
        if host_resource_id.is_some()
            || include_cpu.is_some()
            || require_gpu.is_some()
            || cpu_reserve_millis.is_some()
            || memory_reserve_bytes.is_some()
            || storage_reserve_bytes.is_some()
        {
            bail!("local discovery options require --discover-local true");
        }
        None
    };
    Ok(ResourcePoolArgs {
        store_root: store_root.context("missing required --store-root")?,
        pool_id: pool_id.context("missing required --pool-id")?,
        expected_generation: expected_generation
            .context("missing required --expected-generation")?,
        resources,
        discovery,
        dry_run: dry_run.unwrap_or(false),
    })
}

fn parse_bool(flag: &str, value: &str) -> Result<bool> {
    match value {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => bail!("resource pool option `{flag}` must be `true` or `false`"),
    }
}

fn parse_u64(flag: &str, value: &str) -> Result<u64> {
    value
        .parse::<u64>()
        .with_context(|| format!("resource pool option `{flag}` must be a non-negative integer"))
}
