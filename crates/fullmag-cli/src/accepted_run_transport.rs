use anyhow::{bail, Context, Result};
use fullmag_application::{ProjectId, RunId, RunIntent, RunIntentAuthoring};
use reqwest::blocking::{Client, Response};
use reqwest::{StatusCode, Url};
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;
use std::time::Duration;

const MAX_SUBMIT_REQUEST_BYTES: u64 = 96 * 1024 * 1024;
const ERROR_BODY_LIMIT: usize = 2_048;

pub(crate) fn prepare_run_json(path: &Path, project_id: &str, api_url: &str) -> Result<Value> {
    let project_id = ProjectId::parse(project_id)?;
    let mut file = std::fs::File::open(path)
        .with_context(|| format!("opening run authoring request {}", path.display()))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_SUBMIT_REQUEST_BYTES {
        bail!("run authoring request must be a regular file between 1 and {MAX_SUBMIT_REQUEST_BYTES} bytes");
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_SUBMIT_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_SUBMIT_REQUEST_BYTES {
        bail!("run authoring request grew beyond its transport limit");
    }
    let request: Value = serde_json::from_slice(&bytes).context("parse run authoring request")?;
    let base = parse_api_origin(api_url)?;
    let url = endpoint(
        &base,
        &[
            "v2",
            "persistence",
            "projects",
            project_id.as_str(),
            "run-intent",
        ],
    )?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()?;
    let (_, prepared) = response_json(
        client
            .post(url.clone())
            .json(&request)
            .send()
            .with_context(|| format!("POST {url}"))?,
        &[StatusCode::OK],
    )?;
    prepared_submission(&project_id, request, prepared)
}

fn prepared_submission(project_id: &ProjectId, request: Value, prepared: Value) -> Result<Value> {
    let authored: RunIntentAuthoring = serde_json::from_value(
        request
            .get("run_authoring")
            .context("missing run_authoring")?
            .clone(),
    )?;
    let revision = request
        .get("expected_revision")
        .and_then(Value::as_u64)
        .context("missing expected_revision")?;
    let intent_value = prepared
        .get("run_intent")
        .context("missing prepared run_intent")?;
    let intent: RunIntent = serde_json::from_value(intent_value.clone())?;
    intent.validate()?;
    let specification = &intent.specification;
    let returned_authoring = RunIntentAuthoring {
        run_id: specification.run_id.clone(),
        idempotency_key: intent.idempotency_key.clone(),
        parameters: specification.parameters.clone(),
        seeds: specification.seeds.clone(),
        dependencies: specification.dependencies.clone(),
        scheduling_priority: specification.scheduling_priority,
        requested_execution: specification.requested_execution.clone(),
    };
    let fingerprint = intent.payload_fingerprint()?;
    if prepared.get("project_id").and_then(Value::as_str) != Some(project_id.as_str())
        || prepared.get("definition_revision").and_then(Value::as_u64) != Some(revision)
        || specification.snapshot.project_id != *project_id
        || specification.snapshot.definition_revision != revision
        || serde_json::to_value(returned_authoring)? != serde_json::to_value(authored)?
        || prepared.get("payload_fingerprint").and_then(Value::as_str) != Some(fingerprint.as_str())
    {
        bail!("prepared run response differs from the authored identity or fingerprint");
    }
    // Keep the exact archive and compiled inputs; only the producer creates
    // RunIntent. No implicit Submit, materialization, or filesystem output.
    Ok(json!({
        "archive_base64": request.get("archive_base64").context("missing archive_base64")?,
        "run_intent": intent_value,
        "study_plan": request.get("study_plan").context("missing study_plan")?,
        "study_problem_catalog": request.get("study_problem_catalog").context("missing study_problem_catalog")?,
        "asset_paths": request.get("asset_paths").context("missing asset_paths")?,
    }))
}

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
    submit_run_request(&request, api_url, submit_only)
}

pub(crate) fn validate_submit_request_size(request: &Value) -> Result<()> {
    let encoded = serde_json::to_vec(request)?;
    if encoded.is_empty() || encoded.len() as u64 > MAX_SUBMIT_REQUEST_BYTES {
        bail!("accepted-run request exceeds public JSON transport limit");
    }
    Ok(())
}

pub(crate) fn submit_run_request(request: &Value, api_url: &str, submit_only: bool) -> Result<Value> {
    validate_submit_request_size(request)?;
    let intent: RunIntent = serde_json::from_value(
        request
            .get("run_intent")
            .context("submit request is missing run_intent")?
            .clone(),
    )
    .context("parse accepted-run intent")?;
    intent.validate().context("validate accepted-run intent")?;
    let project_id = &intent.specification.snapshot.project_id;
    let run_id = &intent.specification.run_id;
    let fingerprint = intent.payload_fingerprint()?;

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
    validate_run_receipt(run_id, &fingerprint, &submit)
        .context("validate accepted-run Submit response before materialization")?;

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
        validate_run_receipt(run_id, &fingerprint, &run_body)
            .context("validate accepted-run readback")?;
        if run_body.get("project_id").and_then(Value::as_str) != Some(project_id.as_str()) {
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

fn validate_run_receipt(run_id: &RunId, fingerprint: &str, receipt: &Value) -> Result<()> {
    if receipt.get("run_id").and_then(Value::as_str) != Some(run_id.as_str())
        || receipt.get("payload_fingerprint").and_then(Value::as_str) != Some(fingerprint)
    {
        bail!("accepted-run receipt identity or fingerprint differs from the submitted request");
    }
    Ok(())
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
    if !expected.contains(&status) {
        let mut bytes = Vec::new();
        response
            .take(ERROR_BODY_LIMIT as u64)
            .read_to_end(&mut bytes)
            .context("read bounded accepted-run HTTP error")?;
        let detail = String::from_utf8_lossy(&bytes);
        bail!("accepted-run HTTP request failed with {status}: {detail}");
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_SUBMIT_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .context("read bounded accepted-run HTTP response")?;
    if bytes.len() as u64 > MAX_SUBMIT_REQUEST_BYTES {
        bail!("accepted-run HTTP response exceeds the transport limit");
    }
    let payload = serde_json::from_slice(&bytes)
        .with_context(|| format!("accepted-run HTTP {status} response is not JSON"))?;
    Ok((status, payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preparation() -> (ProjectId, Value, Value) {
        let submission: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/runtime/accepted-fem-preparation-run-v2.json"
        ))
        .unwrap();
        let intent: RunIntent = serde_json::from_value(submission["run_intent"].clone()).unwrap();
        let specification = &intent.specification;
        let authored = RunIntentAuthoring {
            run_id: specification.run_id.clone(),
            idempotency_key: intent.idempotency_key.clone(),
            parameters: specification.parameters.clone(),
            seeds: specification.seeds.clone(),
            dependencies: specification.dependencies.clone(),
            scheduling_priority: specification.scheduling_priority,
            requested_execution: specification.requested_execution.clone(),
        };
        let request = json!({
            "archive_base64": submission["archive_base64"],
            "expected_revision": specification.snapshot.definition_revision,
            "run_authoring": authored,
            "study_plan": submission["study_plan"],
            "study_problem_catalog": submission["study_problem_catalog"],
            "asset_paths": submission["asset_paths"],
        });
        let prepared = json!({
            "project_id": specification.snapshot.project_id,
            "definition_revision": specification.snapshot.definition_revision,
            "payload_fingerprint": intent.payload_fingerprint().unwrap(),
            "run_intent": intent,
        });
        (specification.snapshot.project_id.clone(), request, prepared)
    }

    #[test]
    fn prepared_request_preserves_the_existing_submit_shape_and_exact_inputs() {
        let (project_id, request, prepared) = preparation();
        let result = prepared_submission(&project_id, request.clone(), prepared.clone()).unwrap();
        assert_eq!(result.as_object().unwrap().len(), 5);
        for key in [
            "archive_base64",
            "study_plan",
            "study_problem_catalog",
            "asset_paths",
        ] {
            assert_eq!(result[key], request[key]);
        }
        assert_eq!(result["run_intent"], prepared["run_intent"]);
        assert!(result.get("run_authoring").is_none());
        assert!(result.get("expected_revision").is_none());
    }

    #[test]
    fn prepared_request_rejects_rebound_identity_and_fingerprint() {
        let (project_id, request, prepared) = preparation();
        for path in [
            "/project_id",
            "/definition_revision",
            "/payload_fingerprint",
            "/run_intent/specification/run_id",
            "/run_intent/idempotency_key",
        ] {
            let mut invalid = prepared.clone();
            *invalid.pointer_mut(path).unwrap() = if path == "/definition_revision" {
                json!(request["expected_revision"].as_u64().unwrap() + 1)
            } else {
                json!("different")
            };
            assert!(
                prepared_submission(&project_id, request.clone(), invalid).is_err(),
                "{path}"
            );
        }
        let mut changed = request;
        changed["run_authoring"]["scheduling_priority"] = json!(19);
        assert!(prepared_submission(&project_id, changed, prepared).is_err());
    }

    #[test]
    fn run_receipt_requires_the_exact_submitted_identity_and_fingerprint() {
        let (_, _, prepared) = preparation();
        let intent: RunIntent = serde_json::from_value(prepared["run_intent"].clone()).unwrap();
        let run_id = &intent.specification.run_id;
        let fingerprint = intent.payload_fingerprint().unwrap();
        let receipt = json!({
            "run_id": run_id,
            "payload_fingerprint": fingerprint,
        });
        validate_run_receipt(run_id, &fingerprint, &receipt).unwrap();
        for key in ["run_id", "payload_fingerprint"] {
            for replacement in [Value::Null, json!("different"), json!(42)] {
                let mut invalid = receipt.clone();
                invalid[key] = replacement;
                assert!(validate_run_receipt(run_id, &fingerprint, &invalid).is_err());
            }
            let mut missing = receipt.clone();
            missing.as_object_mut().unwrap().remove(key);
            assert!(validate_run_receipt(run_id, &fingerprint, &missing).is_err());
        }
    }
}
