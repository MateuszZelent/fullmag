use serde::Deserialize;
use serde_json::Value;

// An artifact document with duplicate keys has ambiguous scientific meaning.
// Reject it instead of accepting serde_json's last-key-wins projection.
pub struct UnambiguousJson(pub Value);

impl<'de> Deserialize<'de> for UnambiguousJson {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = UnambiguousJson;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("JSON without duplicate object keys")
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(UnambiguousJson(Value::Null))
            }
            fn visit_bool<E: serde::de::Error>(
                self,
                value: bool,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UnambiguousJson(Value::Bool(value)))
            }
            fn visit_i64<E: serde::de::Error>(
                self,
                value: i64,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UnambiguousJson(Value::Number(value.into())))
            }
            fn visit_u64<E: serde::de::Error>(
                self,
                value: u64,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UnambiguousJson(Value::Number(value.into())))
            }
            fn visit_f64<E: serde::de::Error>(
                self,
                value: f64,
            ) -> std::result::Result<Self::Value, E> {
                serde_json::Number::from_f64(value)
                    .map(|number| UnambiguousJson(Value::Number(number)))
                    .ok_or_else(|| E::custom("non-finite JSON number"))
            }
            fn visit_str<E: serde::de::Error>(
                self,
                value: &str,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UnambiguousJson(Value::String(value.into())))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut access: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(UnambiguousJson(value)) = access.next_element()? {
                    values.push(value);
                }
                Ok(UnambiguousJson(Value::Array(values)))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut access: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some((key, UnambiguousJson(value))) =
                    access.next_entry::<String, UnambiguousJson>()?
                {
                    if values.contains_key(&key) {
                        return Err(serde::de::Error::custom(format!(
                            "duplicate JSON key {key}"
                        )));
                    }
                    values.insert(key, value);
                }
                Ok(UnambiguousJson(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_duplicate_keys_at_every_nesting_level() {
        for bytes in [
            r#"{"stage":"one","stage":"two"}"#,
            r#"{"payload":{"sha":"one","sha":"two"}}"#,
            r#"[{"path":"one","path":"two"}]"#,
        ] {
            assert!(serde_json::from_str::<UnambiguousJson>(bytes).is_err());
        }
    }

    #[test]
    fn preserves_unambiguous_json_values() {
        let bytes = r#"{"null":null,"bool":true,"i":-2,"u":3,"f":0.125,"a":["x",{}]}"#;
        assert_eq!(
            serde_json::from_str::<UnambiguousJson>(bytes).unwrap().0,
            serde_json::from_str::<Value>(bytes).unwrap(),
        );
    }
}
