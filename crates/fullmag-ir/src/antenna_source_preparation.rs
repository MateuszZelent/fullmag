//! Input-only frozen source declarations; these pins never authenticate a historical solve.
use crate::{PreparedAntennaClosedLoopSourceIR, StructuredCurrentClosureIR};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const RETAINED_PREPARATION_ASSET_SOURCE_SCHEMA: &str = "retained_preparation_asset_source.v1";

fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && value.trim() == value
        && !value.chars().any(char::is_control)
}
// Match the existing portable store/step identifier rules without a dependency on session runtime.
fn store_identifier(value: &str) -> bool {
    let stem = value.split('.').next().unwrap_or_default().to_ascii_uppercase();
    !value.is_empty() && value.len() <= 200 && value.is_ascii()
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && !matches!(value, "." | "..") && !value.ends_with('.')
        && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        && !(stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}
fn step_identifier(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256
        && !value.chars().any(|c| c.is_control() || matches!(c, '/' | '\\'))
}
fn bare_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn digest(value: &str) -> bool { value.strip_prefix("sha256:").is_some_and(bare_digest) }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AntennaSourcePreparationAssetRefIR {
    pub asset_id: String,
    pub content_sha256: String,
}
impl AntennaSourcePreparationAssetRefIR {
    pub fn validation_errors(&self, path: &str) -> Vec<String> {
        if !self.asset_id.strip_prefix("script-file-").is_some_and(bare_digest)
            || !bare_digest(&self.content_sha256) {
            vec![format!("{path} requires an observed script-file asset ID and lowercase content SHA256")]
        } else { Vec::new() }
    }
}

/// Scalar projection of the actual durable receipt, not a receipt or an execution grant.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AntennaSourcePreparationReceiptPinsIR {
    pub receipt_schema_version: String,
    pub run_id: String,
    pub task_id: String,
    pub step_id: String,
    pub input_fingerprint: String,
    pub preparation_id: String,
    pub plan_fingerprint: String,
    pub payload_sha256: String,
    pub receipt_sha256: String,
}
impl AntennaSourcePreparationReceiptPinsIR {
    pub fn validation_errors(&self, path: &str) -> Vec<String> {
        let mut errors = Vec::new();
        let expected_task = format!("task-{:x}", Sha256::digest(format!("{}\0{}", self.run_id, self.step_id).as_bytes()));
        if self.receipt_schema_version != "task_preparation_receipt.v1"
            || !store_identifier(&self.run_id) || !step_identifier(&self.step_id)
            || !store_identifier(&self.task_id) || !store_identifier(&self.preparation_id)
            || self.task_id != expected_task || self.preparation_id != format!("prep-{}", self.task_id)
            || !digest(&self.plan_fingerprint)
            || [&self.input_fingerprint, &self.payload_sha256, &self.receipt_sha256].iter().any(|value| !bare_digest(value)) {
            errors.push(format!("{path} requires canonical original receipt pins and deterministic run/step/task/preparation identity"));
        }
        errors
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RetainedPreparationAssetSourceIR {
    pub schema_version: String,
    pub object_id: String,
    pub geometry_id: String,
    pub preparation_asset: AntennaSourcePreparationAssetRefIR,
    pub historical_prepared_source: PreparedAntennaClosedLoopSourceIR,
    pub historical_preparation: AntennaSourcePreparationReceiptPinsIR,
    #[serde(deserialize_with = "deserialize_authored_closure")]
    pub authored_closure: StructuredCurrentClosureIR,
}
impl RetainedPreparationAssetSourceIR {
    pub fn validation_errors(&self, path: &str) -> Vec<String> {
        let mut errors = self.preparation_asset.validation_errors(&format!("{path}.preparation_asset"));
        errors.extend(self.historical_preparation.validation_errors(&format!("{path}.historical_preparation")));
        errors.extend(self.historical_prepared_source.validation_errors(&format!("{path}.historical_prepared_source")));
        errors.extend(self.authored_closure.validation_errors(&format!("{path}.authored_closure")));
        let StructuredCurrentClosureIR::ClosedGeometry { schema_version, source_cuts, .. } = &self.authored_closure;
        if self.schema_version != RETAINED_PREPARATION_ASSET_SOURCE_SCHEMA
            || !identifier(&self.object_id) || !identifier(&self.geometry_id)
            || self.object_id != self.historical_prepared_source.object_id
            || self.geometry_id != self.historical_prepared_source.geometry_id
            || schema_version != "structured_current_closure.v2" || source_cuts.len() != 1
            || source_cuts.iter().any(|cut| cut.region.object_id != self.object_id) {
            errors.push(format!("{path} requires its exact owner, original prepared source and actual authored v2 closure"));
        }
        errors
    }
}

fn deserialize_authored_closure<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<StructuredCurrentClosureIR, D::Error> {
    use serde::de::Error;
    let value = serde_json::Value::deserialize(deserializer)?;
    let closed = |value: &serde_json::Value, allowed: &[&str]| -> Result<(), D::Error> {
        let object = value.as_object().ok_or_else(|| D::Error::custom("authored closure object missing"))?;
        if object.keys().any(|key| !allowed.contains(&key.as_str())) { return Err(D::Error::custom("unknown authored closure field")); }
        Ok(())
    };
    closed(&value, &["kind", "schema_version", "closure_id", "source_cuts"])?;
    if let Some(cuts) = value.get("source_cuts").and_then(serde_json::Value::as_array) {
        for cut in cuts {
            closed(cut, &["source_cut_id", "circuit_id", "region", "plane", "drive"])?;
            closed(&cut["region"], &["object_id", "region_id"])?;
            closed(&cut["plane"], &["coordinate_frame", "axis", "offset_m", "normal"])?;
            closed(&cut["drive"], &["kind", "schema_version", "drive_id", "potential_jump_V"])?;
        }
    }
    serde_json::from_value(value).map_err(D::Error::custom)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pins() -> AntennaSourcePreparationReceiptPinsIR {
        let run_id = "run-source".to_owned(); let step_id = "source-step".to_owned();
        let task_id = format!("task-{:x}", Sha256::digest(format!("{run_id}\0{step_id}").as_bytes()));
        AntennaSourcePreparationReceiptPinsIR {
            receipt_schema_version:"task_preparation_receipt.v1".into(), run_id, step_id,
            preparation_id:format!("prep-{task_id}"), task_id,
            input_fingerprint:"a".repeat(64), plan_fingerprint:format!("sha256:{}", "b".repeat(64)),
            payload_sha256:"c".repeat(64), receipt_sha256:"d".repeat(64),
        }
    }
    #[test]
    fn receipt_projection_checks_actual_schema_and_deterministic_owner_chain() {
        assert!(pins().validation_errors("pins").is_empty());
        for case in ["schema", "task", "step", "preparation", "input", "plan", "payload", "receipt"] {
            let mut value = pins();
            match case {
                "schema" => value.receipt_schema_version = "closed_loop_preparation_receipt.v1".into(),
                "task" => value.task_id = "task-foreign".into(),
                "step" => value.step_id = "foreign".into(),
                "preparation" => value.preparation_id = "prep-foreign".into(),
                "input" => value.input_fingerprint = "A".repeat(64),
                "plan" => value.plan_fingerprint = "b".repeat(64),
                "payload" => value.payload_sha256 = "sha256:bad".into(),
                "receipt" => value.receipt_sha256.clear(),
                _ => unreachable!(),
            }
            assert!(!value.validation_errors("pins").is_empty(), "{case}");
        }
    }
    #[test]
    fn input_reference_has_no_path_or_legacy_receipt_fallback() {
        let value = AntennaSourcePreparationAssetRefIR {asset_id:format!("script-file-{}", "e".repeat(64)),content_sha256:"f".repeat(64)};
        assert!(value.validation_errors("asset").is_empty());
        let mut wire = serde_json::to_value(&value).unwrap(); wire["source"] = "hidden-cache.json".into();
        assert!(serde_json::from_value::<AntennaSourcePreparationAssetRefIR>(wire).is_err());
        let mut wrong = value; wrong.asset_id = "hidden-cache.json".into();
        assert!(!wrong.validation_errors("asset").is_empty());
        let mut wire = serde_json::to_value(pins()).unwrap(); wire["payload"] = serde_json::json!({});
        assert!(serde_json::from_value::<AntennaSourcePreparationReceiptPinsIR>(wire).is_err());
    }
}
