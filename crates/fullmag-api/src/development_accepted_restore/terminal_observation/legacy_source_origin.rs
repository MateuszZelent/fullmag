//! Explicit historical activation binding for a newly captured terminal origin.
//! No source is inferred from a session name, and this never grants execution.
use super::*;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyActivation {
    schema: String,
    activation_attempt: String,
    activation_receipt_sha256: String,
    startup_run_id: String,
    startup_intent_sha256: String,
    restored_run_id: String,
    restored_intent_sha256: String,
}

fn record(root: &Path, relative: &str) -> Result<(Vec<u8>, Value)> {
    let bytes = fullmag_session::repository_path::read_bounded_regular_file(
        root, relative, MAX_CONTROL_RECORD_BYTES,
    )?;
    let value = serde_json::from_slice(&bytes)?;
    Ok((bytes, value))
}

fn live(intent: &Value) -> Result<&Value> {
    intent.pointer("/specification/parameters/live_workspace")
        .filter(|value| value.is_object()).context("legacy source intent has no live binding")
}

fn validate_lineage(startup: &Value, restored: &Value) -> Result<()> {
    for intent in [startup, restored] {
        equal(intent, "schema_version", "run_intent.v1")?;
        let definition = string(intent, "definition_object_ref")?;
        validate_digest(definition, "legacy source definition")?;
        let snapshot = intent.pointer("/specification/snapshot")
            .context("legacy source intent has no snapshot")?;
        equal(snapshot, "definition_sha256", definition)?;
        fullmag_session::repository_path::validate_store_id(string(snapshot, "project_id")?)?;
        let revision = snapshot.get("definition_revision").and_then(Value::as_u64)
            .context("legacy source intent has no definition revision")?;
        let binding = live(intent)?;
        if binding.get("scene_revision").and_then(Value::as_u64) != Some(revision)
            || binding.get("session_epoch").and_then(Value::as_u64).is_none_or(|epoch| epoch == 0)
        {
            bail!("legacy source intent scene/native epoch differs");
        }
        fullmag_session::repository_path::validate_store_id(string(binding, "session_id")?)?;
        let execution = binding.get("execution_input").context("legacy source execution input is absent")?;
        equal(execution, "schema_version", "fullmag.scene_execution_input.v1")?;
        validate_digest(string(execution, "sha256")?, "legacy source execution input")?;
        if execution.as_object().is_none_or(|object| object.len() != 2) {
            bail!("legacy source execution input shape differs");
        }
    }
    let a = live(startup)?;
    let b = live(restored)?;
    if startup.get("definition_object_ref") != restored.get("definition_object_ref")
        || startup.pointer("/specification/snapshot") != restored.pointer("/specification/snapshot")
        || a.get("session_id") != b.get("session_id")
        || a.get("session_epoch") != b.get("session_epoch")
        || a.get("execution_input") != b.get("execution_input")
    {
        bail!("legacy activation belongs to another scene, execution input or accepted session");
    }
    Ok(())
}

fn validate_diagnostic_wrappers(
    receipt: &Value, inputs: &Value, response: &Value,
    provenance: &Value, authorization: &Value, parameters: &Value,
) -> Result<String> {
    let mut suffix = String::new();
    for name in ["solver_profile", "cuda_trace"] {
        let pin = format!("{name}_sha256");
        let values = [provenance.get(name), authorization.get(name), parameters.get(name)];
        let pins = [receipt.get(&pin), inputs.get(&pin), response.get(&pin)];
        if values.iter().any(|value| value.is_some()) || pins.iter().any(|value| value.is_some()) {
            let value = values[0].context("legacy activation diagnostic wrapper is absent")?;
            let digest = match name {
                "solver_profile" => crate::accepted_solver_profile::request_digest(value)?,
                _ => crate::accepted_solver_profile::cuda_trace::request_digest(value)?,
            };
            if values.iter().any(|other| *other != Some(value))
                || pins.iter().any(|other| other.and_then(Value::as_str) != Some(digest.as_str()))
            {
                bail!("legacy activation diagnostic wrapper differs");
            }
            if name == "solver_profile" { suffix.push('\0'); }
            else { suffix.push_str("\0cuda_trace\0"); }
            suffix.push_str(&digest);
        }
    }
    Ok(suffix)
}

fn validate_activation_records(
    receipt: &Value, provenance: &Value, authorization: &Value, result: &Value,
    startup: &Value, restored: &Value, origin: &Value, binding: &LegacyActivation,
    project: &str, volume: &str, source_root: &str, provenance_sha256: &str,
) -> Result<()> {
    for (field, expected) in [
        ("schema", ACTIVATION_OPERATION_SCHEMA), ("phase", "activation"),
        ("state", "succeeded"), ("activation_state", "activated"),
        ("attempt", binding.activation_attempt.as_str()), ("compose_project", project),
        ("control_volume", volume), ("source_root", source_root),
        ("run_id", binding.startup_run_id.as_str()),
    ] { equal(receipt, field, expected)?; }
    if receipt.get("control_namespace").is_some_and(|value| value.as_str() != Some(""))
        || receipt.get("error").is_some_and(|value| !value.is_null() && value.as_str() != Some(""))
        || receipt.get("reconciliation").is_some_and(|value| !value.is_null() && value != &Value::Bool(false))
    { bail!("legacy source activation is not an ordinary confirmed activation"); }
    let started = receipt.get("started_at").and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0).context("activation start time is absent")?;
    let finished = receipt.get("finished_at").and_then(Value::as_f64)
        .filter(|value| value.is_finite()).context("activation finish time is absent")?;
    if finished < started { bail!("legacy activation terminal predates start"); }
    let inputs = receipt.get("inputs").context("legacy activation inputs are absent")?;
    let request = string(receipt, "request_id")?;
    let source_sha = string(receipt, "source_sha256")?;
    validate_startup_provenance_record(provenance, source_root, source_sha, request)?;
    if authorization != provenance { bail!("legacy source authorization differs from provenance"); }
    for key in ["request_id", "source_sha256", "source_root", "source_relative"] {
        equal(inputs, key, string(receipt, key)?)?;
        equal(provenance, key, string(receipt, key)?)?;
    }
    for value in [receipt, inputs] { equal(value, "provenance_sha256", provenance_sha256)?; }
    equal(receipt, "provenance_path", &format!("/opt/fullmag/control/activation/attempts/{}/startup-provenance.json", binding.activation_attempt))?;
    equal(provenance, "container_source_root", source_origin::SOURCE_ROOT)?;
    equal(provenance, "container_script_path", &format!("{}/{}", source_origin::SOURCE_ROOT, string(origin, "source_relative")?))?;
    for key in ["source_relative", "source_sha256", "source_size_bytes"] {
        if provenance.get(key).is_none() || provenance.get(key) != origin.get(key) {
            bail!("legacy source origin differs from activated provenance: {key}");
        }
    }
    equal(result, "schema", "fullmag.startup-script-activation.v1")?;
    equal(result, "state", "activated")?;
    let response = result.get("response").context("legacy activation result response is absent")?;
    equal(response, "schema", "fullmag.startup-script-activation.v1")?;
    equal(response, "status", "accepted")?;
    for value in [result, response] {
        equal(value, "request_id", request)?;
        equal(value, "source_sha256", source_sha)?;
    }
    for key in ["run_id", "session_id"] { equal(response, key, string(receipt, key)?)?; }
    validate_lineage(startup, restored)?;
    equal(startup, "run_id", &binding.startup_run_id)?;
    equal(startup.get("specification").context("startup specification absent")?,
        "run_id", &binding.startup_run_id)?;
    equal(restored, "run_id", &binding.restored_run_id)?;
    equal(restored.get("specification").context("restored specification absent")?,
        "run_id", &binding.restored_run_id)?;
    equal(startup, "idempotency_key", &format!("live-http-{}", fullmag_session::hex_sha256(request.as_bytes())))?;
    let parameters = startup.pointer("/specification/parameters").context("startup parameters absent")?;
    let suffix = validate_diagnostic_wrappers(receipt, inputs, response, provenance, authorization, parameters)?;
    let session = format!("docker-startup-{}", fullmag_session::hex_sha256(format!("{request}\0{source_sha}{suffix}").as_bytes()));
    equal(receipt, "session_id", &session)?;
    let startup_live = live(startup)?;
    for (key, expected) in [("session_id", session.as_str()), ("command_id", request),
        ("request_idempotency_key", request), ("startup_source_sha256", source_sha)] {
        equal(startup_live, key, expected)?;
    }
    if startup_live.get("command") != Some(&json!({
        "kind": "startup_script", "request_id": request, "source_sha256": source_sha,
    })) { bail!("legacy activation startup command differs"); }
    Ok(())
}

pub(super) fn validate(
    control_root: &Path, store: &fullmag_session::SessionStore,
    preflight: &Value, proof: &Proof,
) -> Result<()> {
    let Some(value) = preflight.get("source_origin_legacy_activation") else { return Ok(()) };
    let binding: LegacyActivation = serde_json::from_value(value.clone())?;
    if binding.schema != "fullmag.terminal-legacy-source-activation.v1"
        || binding.restored_run_id != proof.run_id || binding.restored_intent_sha256 != proof.intent_sha256
    { bail!("legacy source activation is not pinned to this terminal intent"); }
    validate_attempt(&binding.activation_attempt, "legacy source activation")?;
    fullmag_session::repository_path::validate_store_id(&binding.startup_run_id)?;
    validate_digest(&binding.activation_receipt_sha256, "legacy activation receipt")?;
    validate_digest(&binding.startup_intent_sha256, "legacy startup intent")?;
    let origin = preflight.get("source_origin").context("legacy activation has no source origin")?;
    let base = format!("activation/attempts/{}", binding.activation_attempt);
    let receipt = control_json(control_root, &format!("{base}/receipt.json"), &binding.activation_receipt_sha256)?;
    raw(control_root, &format!("{base}/terminal.json"), &binding.activation_receipt_sha256)?;
    let (provenance_raw, provenance) = record(control_root, &format!("{base}/startup-provenance.json"))?;
    let (_, authorization) = record(control_root, &format!("{base}/authorization.json"))?;
    let (_, result) = record(control_root, &format!("{base}/result.json"))?;
    fullmag_session::repository_path::read_bounded_regular_file(control_root, &format!("{base}/build.log"), 32 * 1024 * 1024)?;
    let startup_raw = raw(store.root(), &format!("runs/{}/run_intent.json", binding.startup_run_id), &binding.startup_intent_sha256)?;
    let restored_raw = raw(store.root(), &format!("runs/{}/run_intent.json", proof.run_id), &proof.intent_sha256)?;
    let startup = serde_json::from_slice(&startup_raw)?;
    let restored = serde_json::from_slice(&restored_raw)?;
    validate_activation_records(&receipt, &provenance, &authorization, &result,
        &startup, &restored, origin, &binding, &proof.compose_project, &proof.control_volume,
        &proof.source_root, &fullmag_session::hex_sha256(&provenance_raw))?;
    let startup_intent = store.read_run_intent(&binding.startup_run_id)?.context("legacy startup intent absent")?;
    startup_intent.validate()?;
    if serde_json::to_value(&startup_intent)? != startup { bail!("legacy startup typed intent differs"); }
    let catalog = store.read_run_catalog(&binding.startup_run_id)?.context("legacy startup catalog absent")?;
    catalog.validate()?;
    terminal_catalog_outcome(&catalog)?;
    ensure_terminal_run_has_no_active_leases(store, &binding.startup_run_id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn intent() -> Value {
        json!({"schema_version":"run_intent.v1", "definition_object_ref":"a".repeat(64),
            "specification":{"snapshot":{"project_id":"project-a", "definition_revision":1,
                "definition_sha256":"a".repeat(64)},"parameters":{"live_workspace":{
                    "session_id":"session-a", "session_epoch":2,"scene_revision":1,
                    "execution_input":{"schema_version":"fullmag.scene_execution_input.v1", "sha256":"b".repeat(64)}
                }}}})
    }
    fn validate_fixture(value: &Value) -> Result<()> {
        let binding: LegacyActivation = serde_json::from_value(value["binding"].clone())?;
        validate_activation_records(&value["receipt"], &value["provenance"], &value["authorization"],
            &value["result"], &value["startup"], &value["restored"], &value["origin"], &binding,
            string(value, "project")?, string(value, "volume")?, string(value, "source_root")?,
            string(value, "provenance_sha256")?)
    }

    #[test]
    fn activation_records_bind_the_source_to_the_same_accepted_scene() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/terminal-legacy-source-activation.v1.json")).unwrap();
        validate_fixture(&fixture).unwrap();
        for (pointer, value) in [
            ("/receipt/activation_state", json!("unknown")),
            ("/receipt/compose_project", json!("foreign")),
            ("/receipt/control_volume", json!("foreign")),
            ("/receipt/provenance_sha256", json!("f".repeat(64))),
            ("/receipt/finished_at", json!(0)),
            ("/result/response/status", json!("rejected")),
            ("/result/response/run_id", json!("foreign")),
            ("/result/response/source_sha256", json!("f".repeat(64))),
            ("/provenance/container_script_path", json!("/outside.py")),
            ("/authorization/source_sha256", json!("f".repeat(64))),
            ("/origin/source_relative", json!("../outside.py")),
            ("/origin/source_size_bytes", json!(321)),
            ("/restored/specification/parameters/live_workspace/session_epoch", json!(3)),
            ("/startup/specification/parameters/live_workspace/command/kind", json!("relax")),
        ] {
            let mut changed=fixture.clone(); *changed.pointer_mut(pointer).unwrap()=value;
            assert!(validate_fixture(&changed).is_err(), "{pointer}");
        }
    }

    #[test]
    fn lineage_requires_exact_definition_execution_input_and_accepted_session() {
        let startup=intent(); let mut restored=intent();
        assert!(validate_lineage(&startup,&restored).is_ok());
        for pointer in ["/definition_object_ref", "/specification/snapshot/project_id",
            "/specification/snapshot/definition_sha256", "/specification/parameters/live_workspace/session_id",
            "/specification/parameters/live_workspace/execution_input/sha256"] {
            restored=intent(); *restored.pointer_mut(pointer).unwrap()=json!("c".repeat(64));
            assert!(validate_lineage(&startup,&restored).is_err(),"{pointer}");
        }
        for pointer in ["/specification/parameters/live_workspace/session_epoch",
            "/specification/parameters/live_workspace/scene_revision", "/specification/snapshot/definition_revision"] {
            restored=intent(); *restored.pointer_mut(pointer).unwrap()=json!(3);
            assert!(validate_lineage(&startup,&restored).is_err(),"{pointer}");
        }
        restored=intent(); restored["specification"]["parameters"]["live_workspace"]["execution_input"]=Value::Null;
        assert!(validate_lineage(&startup,&restored).is_err());
    }
    #[test]
    fn legacy_activation_shape_is_closed_and_does_not_supply_an_absolute_path() {
        let value=json!({"schema":"fullmag.terminal-legacy-source-activation.v1",
            "activation_attempt":"a".repeat(32),"activation_receipt_sha256":"b".repeat(64),
            "startup_run_id":"run-startup", "startup_intent_sha256":"c".repeat(64),
            "restored_run_id":"run-restored", "restored_intent_sha256":"d".repeat(64)});
        assert!(serde_json::from_value::<LegacyActivation>(value.clone()).is_ok());
        let mut changed=value; changed["script_path"]=json!("/outside.py");
        assert!(serde_json::from_value::<LegacyActivation>(changed).is_err());
    }
}
