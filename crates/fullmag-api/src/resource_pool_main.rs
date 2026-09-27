use anyhow::{bail, Context, Result};
use fullmag_session::{
    FmsSchedulerResourceOffer, FmsSchedulerResourcePool, SchedulerResourcePoolCommitDisposition,
    FMS_SCHEDULER_RESOURCE_POOL_SCHEMA,
};
use std::path::PathBuf;

struct ResourcePoolArgs {
    store_root: PathBuf,
    pool_id: String,
    expected_generation: u64,
    resources: Vec<FmsSchedulerResourceOffer>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("scheduler resource pool publication failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let store = fullmag_runtime_control::retry_store_writer_busy(|| {
        fullmag_session::SessionStore::open_existing(&args.store_root)
    })
    .with_context(|| format!("open session store `{}`", args.store_root.display()))?;
    let pool = FmsSchedulerResourcePool {
        schema_version: FMS_SCHEDULER_RESOURCE_POOL_SCHEMA.into(),
        pool_id: args.pool_id,
        generation: args
            .expected_generation
            .checked_add(1)
            .context("scheduler resource pool generation overflow")?,
        resources: args.resources,
    };
    let disposition = fullmag_runtime_control::retry_store_writer_busy(|| {
        store.commit_scheduler_resource_pool(args.expected_generation, &pool)
    })
    .context("commit scheduler resource pool")?;
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "status": match disposition {
                SchedulerResourcePoolCommitDisposition::Accepted => "accepted",
                SchedulerResourcePoolCommitDisposition::Replayed => "replayed",
            },
            "pool_id": pool.pool_id,
            "generation": pool.generation,
            "resource_count": pool.resources.len(),
            "resource_ids": pool
                .resources
                .iter()
                .map(|resource| resource.resource_id.as_str())
                .collect::<Vec<_>>(),
        }))?
    );
    Ok(())
}

fn parse_args() -> Result<ResourcePoolArgs> {
    let mut store_root = None;
    let mut pool_id = None;
    let mut expected_generation = None;
    let mut resources = Vec::new();
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        let flag = argument
            .into_string()
            .map_err(|_| anyhow::anyhow!("resource pool option name must be valid UTF-8"))?;
        let value = args
            .next()
            .with_context(|| format!("resource pool option `{flag}` requires a value"))?;
        match flag.as_str() {
            "--store-root" if store_root.is_none() => store_root = Some(PathBuf::from(value)),
            "--pool-id" if pool_id.is_none() => {
                pool_id = Some(value.into_string().map_err(|_| {
                    anyhow::anyhow!("resource pool option `--pool-id` must be valid UTF-8")
                })?)
            }
            "--expected-generation" if expected_generation.is_none() => {
                expected_generation = Some(
                    value
                        .into_string()
                        .map_err(|_| {
                            anyhow::anyhow!(
                                "resource pool option `--expected-generation` must be valid UTF-8"
                            )
                        })?
                        .parse::<u64>()
                        .context(
                            "resource pool option `--expected-generation` must be a non-negative integer",
                        )?,
                )
            }
            "--resource-offer" => {
                let value = value.into_string().map_err(|_| {
                    anyhow::anyhow!("resource pool option `--resource-offer` must be valid UTF-8")
                })?;
                resources.push(
                    serde_json::from_str::<FmsSchedulerResourceOffer>(&value).context(
                        "resource pool option `--resource-offer` must be valid resource JSON",
                    )?,
                );
            }
            "--store-root" | "--pool-id" | "--expected-generation" => {
                bail!("resource pool option `{flag}` was supplied more than once")
            }
            _ => bail!("unknown resource pool option `{flag}`"),
        }
    }
    let parsed = ResourcePoolArgs {
        store_root: store_root.context("missing required --store-root")?,
        pool_id: pool_id.context("missing required --pool-id")?,
        expected_generation: expected_generation
            .context("missing required --expected-generation")?,
        resources,
    };
    FmsSchedulerResourcePool {
        schema_version: FMS_SCHEDULER_RESOURCE_POOL_SCHEMA.into(),
        pool_id: parsed.pool_id.clone(),
        generation: parsed
            .expected_generation
            .checked_add(1)
            .context("scheduler resource pool generation overflow")?,
        resources: parsed.resources.clone(),
    }
    .validate()?;
    Ok(parsed)
}
