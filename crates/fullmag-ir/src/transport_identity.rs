//! Canonical byte identity for transport authoring and resolved requests.
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Language-neutral tagged JSON: sorted UTF-8 keys, little-endian lengths and finite f64 numbers.
/// Numeric IDs above 2^53 are rejected; mesh ordinals use the canonical topology v3 encoder instead.
pub fn tagged_json_digest(value: &Value) -> Result<String, String> {
    fn encode(value: &Value, hash: &mut Sha256) -> Result<(), String> {
        match value {
            Value::Null => hash.update(b"N"),
            Value::Bool(value) => hash.update(if *value { b"T" } else { b"F" }),
            Value::Number(value) => {
                let number = value.as_f64().filter(|v| v.is_finite()).ok_or_else(|| "transport identity requires finite numbers".to_string())?;
                if value.as_u64().is_some_and(|v| v > 9_007_199_254_740_992)
                    || value.as_i64().is_some_and(|v| v < -9_007_199_254_740_992) {
                    return Err("transport identity integer exceeds exact f64 range".into());
                }
                hash.update(b"D");
                let canonical = if number == 0.0 { 0.0f64 } else { number };
                hash.update(canonical.to_le_bytes());
            }
            Value::String(value) => {
                hash.update(b"S");
                hash.update((value.len() as u64).to_le_bytes());
                hash.update(value.as_bytes());
            }
            Value::Array(values) => {
                hash.update(b"A");
                hash.update((values.len() as u64).to_le_bytes());
                for value in values { encode(value, hash)?; }
            }
            Value::Object(values) => {
                hash.update(b"O");
                hash.update((values.len() as u64).to_le_bytes());
                let mut keys = values.keys().collect::<Vec<_>>();
                keys.sort_unstable();
                for key in keys {
                    encode(&Value::String(key.clone()), hash)?;
                    encode(&values[key], hash)?;
                }
            }
        }
        Ok(())
    }
    let mut hash = Sha256::new();
    hash.update(b"fullmag:transport-tagged-json:v1");
    encode(value, &mut hash)?;
    Ok(format!("sha256:{:x}", hash.finalize()))
}
