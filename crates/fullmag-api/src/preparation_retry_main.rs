use anyhow::{bail, Context, Result};
use fullmag_session::{
    FmsPreparationRetryDecision, PreparationRetryDecisionCommitDisposition,
    FMS_PREPARATION_RETRY_DECISION_SCHEMA,
};
use std::path::PathBuf;

struct PreparationRetryArgs {
    store_root: PathBuf,
    decision_id: Option<String>,
    run_id: String,
    task_id: String,
    failed_preparation_attempt_id: String,
    retry_sequence: u32,
    max_attempts: u32,
    reason: String,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("preparation retry decision failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let decision_id = match args.decision_id {
        Some(value) => value,
        None => deterministic_decision_id(&args)?,
    };
    let mut decision = FmsPreparationRetryDecision {
        schema_version: FMS_PREPARATION_RETRY_DECISION_SCHEMA.into(),
        decision_id,
        run_id: args.run_id,
        task_id: args.task_id,
        failed_preparation_attempt_id: args.failed_preparation_attempt_id,
        retry_sequence: args.retry_sequence,
        max_attempts: args.max_attempts,
        reason: args.reason,
        created_at: chrono::Utc::now(),
    };
    decision.validate()?;
    let store = fullmag_runtime_control::retry_store_writer_busy(|| {
        fullmag_session::SessionStore::open_existing(&args.store_root)
    })
    .with_context(|| format!("open session store `{}`", args.store_root.display()))?;
    if let Some(existing) =
        store.read_preparation_retry_decision(&decision.run_id, &decision.decision_id)?
    {
        decision.created_at = existing.created_at;
    }
    let disposition = fullmag_runtime_control::retry_store_writer_busy(|| {
        store.commit_preparation_retry_decision(&decision)
    })
    .context("commit preparation retry decision")?;
    let durable = store
        .read_preparation_retry_decision(&decision.run_id, &decision.decision_id)?
        .context("durable preparation retry decision disappeared after commit")?;
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "status": match disposition {
                PreparationRetryDecisionCommitDisposition::Accepted => "accepted",
                PreparationRetryDecisionCommitDisposition::Replayed => "replayed",
            },
            "decision": durable,
        }))?
    );
    Ok(())
}

fn deterministic_decision_id(args: &PreparationRetryArgs) -> Result<String> {
    let payload = serde_json::to_vec(&serde_json::json!({
        "run_id": args.run_id,
        "task_id": args.task_id,
        "failed_preparation_attempt_id": args.failed_preparation_attempt_id,
        "retry_sequence": args.retry_sequence,
        "max_attempts": args.max_attempts,
        "reason": args.reason,
    }))?;
    let digest = fullmag_session::hex_sha256(&payload);
    Ok(format!(
        "prep-retry-{}-{}",
        args.retry_sequence,
        &digest[..32]
    ))
}

fn parse_args() -> Result<PreparationRetryArgs> {
    let mut values = std::collections::BTreeMap::new();
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        let flag = argument
            .into_string()
            .map_err(|_| anyhow::anyhow!("preparation retry option name must be valid UTF-8"))?;
        if !flag.starts_with("--") || values.contains_key(&flag) {
            bail!("invalid or duplicate preparation retry option `{flag}`");
        }
        let value = args
            .next()
            .with_context(|| format!("preparation retry option `{flag}` requires a value"))?;
        values.insert(flag, value);
    }

    let store_root = PathBuf::from(take_required_string(&mut values, "--store-root")?);
    let decision_id = values
        .remove("--decision-id")
        .map(|value| os_string("--decision-id", value))
        .transpose()?;
    let run_id = take_required_string(&mut values, "--run-id")?;
    let task_id = take_required_string(&mut values, "--task-id")?;
    let failed_preparation_attempt_id =
        take_required_string(&mut values, "--failed-preparation-attempt-id")?;
    let retry_sequence = take_required_string(&mut values, "--retry-sequence")?
        .parse::<u32>()
        .context("preparation retry sequence must be a positive integer")?;
    let max_attempts = take_required_string(&mut values, "--max-attempts")?
        .parse::<u32>()
        .context("preparation retry max attempts must be a positive integer")?;
    let reason = take_required_string(&mut values, "--reason")?;
    if let Some(flag) = values.keys().next() {
        bail!("unknown preparation retry option `{flag}`");
    }
    Ok(PreparationRetryArgs {
        store_root,
        decision_id,
        run_id,
        task_id,
        failed_preparation_attempt_id,
        retry_sequence,
        max_attempts,
        reason,
    })
}

fn take_required_string(
    values: &mut std::collections::BTreeMap<String, std::ffi::OsString>,
    flag: &str,
) -> Result<String> {
    os_string(
        flag,
        values
            .remove(flag)
            .with_context(|| format!("missing required {flag}"))?,
    )
}

fn os_string(flag: &str, value: std::ffi::OsString) -> Result<String> {
    value
        .into_string()
        .map_err(|_| anyhow::anyhow!("preparation retry option `{flag}` must be valid UTF-8"))
}
