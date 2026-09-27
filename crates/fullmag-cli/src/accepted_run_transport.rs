use anyhow::{bail, Context, Result};
use fullmag_application::{ProjectId, RunId};
use reqwest::blocking::{Client, Response};
use reqwest::{StatusCode, Url};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

const MAX_SUBMIT_REQUEST_BYTES: u64 = 96 * 1024 * 1024;
const ERROR_BODY_LIMIT: usize = 2_048;

pub(crate) fn submit_run_json(path: &Path, api_url: &str, submit_only: bool) -> Result<Value> {
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("reading submit request metadata {}", path.display()))?;
    if !metadata.is_file() {
        bail!(
            "accepted-run submit request is not a regular file: {}",
            path.display()
        );
    }
    if metadata.len() == 0 || metadata.len() > MAX_SUBMIT_REQUEST_BYTES {
        bail!(
            "accepted-run submit request size must be between 1 and {MAX_SUBMIT_REQUEST_BYTES} bytes"
        );
    }
    let request_bytes = std::fs::read(path)
        .with_context(|| format!("reading accepted-run submit request {}", path.display()))?;
    let request: Value = serde_json::from_slice(&request_bytes)
        .with_context(|| format!("parsing accepted-run submit request {}", path.display()))?;
    let project_id = request
        .pointer("/run_intent/specification/snapshot/project_id")
        .and_then(Value::as_str)
        .context("submit request is missing run_intent.specification.snapshot.project_id")?;
    let project_id = ProjectId::parse(project_id)
        .map_err(|error| anyhow::anyhow!("invalid submit project_id: {error}"))?;
    let run_id = request
        .pointer("/run_intent/specification/run_id")
        .and_then(Value::as_str)
        .context("submit request is missing run_intent.specification.run_id")?;
    let run_id =
        RunId::parse(run_id).map_err(|error| anyhow::anyhow!("invalid submit run_id: {error}"))?;

    let base = parse_api_origin(api_url)?;
    let runs_url = endpoint(
        &base,
        &["v2", "persistence", "projects", project_id.as_str(), "runs"],
    )?;
    let run_url = endpoint(
        &base,
        &[
            "v2",
            "persistence",
            "projects",
            project_id.as_str(),
            "runs",
            run_id.as_str(),
        ],
    )?;
    let materialization_url = endpoint(
        &base,
        &[
            "v2",
            "persistence",
            "projects",
            project_id.as_str(),
            "runs",
            run_id.as_str(),
            "materialization",
        ],
    )?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .context("build accepted-run HTTP client")?;

    let (submit_status, submit) = response_json(
        client
            .post(runs_url.clone())
            .json(&request)
            .send()
            .with_context(|| format!("POST {runs_url}"))?,
        &[StatusCode::OK, StatusCode::CREATED],
    )?;
    if submit.get("run_id").and_then(Value::as_str) != Some(run_id.as_str()) {
        bail!("accepted-run Submit response changed the requested run_id");
    }

    let (materialization, run) = if submit_only {
        (Value::Null, Value::Null)
    } else {
        let (status, body) = response_json(
            client
                .post(materialization_url.clone())
                .send()
                .with_context(|| format!("POST {materialization_url}"))?,
            &[StatusCode::OK],
        )?;
        let (run_status, run_body) = response_json(
            client
                .get(run_url.clone())
                .send()
                .with_context(|| format!("GET {run_url}"))?,
            &[StatusCode::OK],
        )?;
        if run_body.get("run_id").and_then(Value::as_str) != Some(run_id.as_str())
            || run_body.get("project_id").and_then(Value::as_str) != Some(project_id.as_str())
        {
            bail!("accepted-run readback identity differs from the submitted request");
        }
        (
            json!({"status": status.as_u16(), "body": body}),
            json!({"status": run_status.as_u16(), "body": run_body}),
        )
    };

    Ok(json!({
        "operation": "submit_accepted_run",
        "transport": "public_http_v2",
        "api_url": base.as_str(),
        "project_id": project_id.as_str(),
        "run_id": run_id.as_str(),
        "submit_only": submit_only,
        "submit": {"status": submit_status.as_u16(), "body": submit},
        "materialization": materialization,
        "run": run,
    }))
}

fn parse_api_origin(value: &str) -> Result<Url> {
    let mut url = Url::parse(value).context("parse --api-url")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || url.cannot_be_a_base()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        bail!("--api-url must be an HTTP(S) origin without a path, query, or fragment");
    }
    url.set_path("/");
    Ok(url)
}

fn endpoint(base: &Url, segments: &[&str]) -> Result<Url> {
    let mut url = base.clone();
    {
        let mut target = url
            .path_segments_mut()
            .map_err(|_| anyhow::anyhow!("--api-url cannot be used as a hierarchical base"))?;
        target.clear();
        target.extend(segments.iter().copied());
    }
    Ok(url)
}

fn response_json(response: Response, expected: &[StatusCode]) -> Result<(StatusCode, Value)> {
    let status = response.status();
    let body = response.text().context("read accepted-run HTTP response")?;
    if !expected.contains(&status) {
        let detail = body.chars().take(ERROR_BODY_LIMIT).collect::<String>();
        bail!("accepted-run HTTP request failed with {status}: {detail}");
    }
    let payload = serde_json::from_str(&body)
        .with_context(|| format!("accepted-run HTTP {status} response is not JSON"))?;
    Ok((status, payload))
}
