mod worker_startup_gate;

use anyhow::{bail, Context, Result};
use fullmag_session::{
    FmsPreparationResourceOffer, FmsPreparationResourcePool,
    PreparationResourcePoolCommitDisposition, FMS_PREPARATION_RESOURCE_POOL_SCHEMA,
};
use std::path::PathBuf;

struct PreparationResourcePoolArgs {
    store_root: PathBuf,
    pool_id: String,
    expected_generation: u64,
    resources: Vec<FmsPreparationResourceOffer>,
    dry_run: bool,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("preparation resource pool publication failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    worker_startup_gate::verify_runtime_owner_build()?;
    let pool = FmsPreparationResourcePool {
        schema_version: FMS_PREPARATION_RESOURCE_POOL_SCHEMA.into(),
        pool_id: args.pool_id,
        generation: args
            .expected_generation
            .checked_add(1)
            .context("preparation resource pool generation overflow")?,
        resources: args.resources,
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
            store.commit_preparation_resource_pool(args.expected_generation, &pool)
        })
        .context("commit preparation resource pool")?;
        match disposition {
            PreparationResourcePoolCommitDisposition::Accepted => "accepted",
            PreparationResourcePoolCommitDisposition::Replayed => "replayed",
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
        }))?
    );
    Ok(())
}

fn parse_args() -> Result<PreparationResourcePoolArgs> {
    let mut store_root = None;
    let mut pool_id = None;
    let mut expected_generation = None;
    let mut resources = Vec::new();
    let mut dry_run = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        let flag = argument
            .to_str()
            .context("preparation resource pool option name must be valid UTF-8")?;
        let value = args.next().with_context(|| {
            format!("preparation resource pool option `{flag}` requires a value")
        })?;
        match flag {
            "--store-root" if store_root.is_none() => store_root = Some(PathBuf::from(value)),
            "--pool-id" if pool_id.is_none() => {
                pool_id = Some(
                    value
                        .into_string()
                        .map_err(|_| anyhow::anyhow!("pool id must be valid UTF-8"))?,
                )
            }
            "--expected-generation" if expected_generation.is_none() => {
                let value = value
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("expected generation must be valid UTF-8"))?;
                expected_generation = Some(
                    value
                        .parse::<u64>()
                        .context("expected generation must be a non-negative integer")?,
                );
            }
            "--resource-offer" => {
                let value = value
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("resource offer must be valid UTF-8 JSON"))?;
                resources.push(
                    serde_json::from_str(&value)
                        .context("resource offer must be valid preparation resource JSON")?,
                );
            }
            "--dry-run" if dry_run.is_none() => {
                let value = value
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("dry-run value must be valid UTF-8"))?;
                dry_run = Some(match value.as_str() {
                    "true" => true,
                    "false" => false,
                    _ => {
                        bail!("preparation resource pool option `--dry-run` must be true or false")
                    }
                });
            }
            "--store-root" | "--pool-id" | "--expected-generation" | "--dry-run" => {
                bail!("preparation resource pool option `{flag}` was supplied more than once")
            }
            _ => bail!("unknown preparation resource pool option `{flag}`"),
        }
    }

    Ok(PreparationResourcePoolArgs {
        store_root: store_root.context("missing required --store-root")?,
        pool_id: pool_id.context("missing required --pool-id")?,
        expected_generation: expected_generation
            .context("missing required --expected-generation")?,
        resources,
        dry_run: dry_run.unwrap_or(false),
    })
}
