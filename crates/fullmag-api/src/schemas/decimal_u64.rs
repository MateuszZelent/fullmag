use serde::{Deserialize, Deserializer, Serializer};

pub fn serialize<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(&value.to_string())
}

pub fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    String::deserialize(deserializer)?
        .parse()
        .map_err(serde::de::Error::custom)
}

pub mod optional {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match value {
            Some(value) => serializer.serialize_some(&value.to_string()),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<String>::deserialize(deserializer)?
            .map(|value| value.parse().map_err(serde::de::Error::custom))
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use serde::Serialize;

    use crate::schemas::fields::FieldCatalog;
    use crate::schemas::realtime::{RealtimeResourceChange, RealtimeResourceName};
    use crate::schemas::status::DomainSummary;

    #[derive(Serialize)]
    struct Fixture {
        #[serde(with = "super")]
        generation_id: u64,
    }

    #[test]
    fn serializes_generation_above_javascript_safe_integer_exactly() {
        let value = serde_json::to_value(Fixture {
            generation_id: 9_007_199_254_741_001,
        })
        .expect("generation fixture should serialize");

        assert_eq!(value["generation_id"], "9007199254741001");
    }

    #[test]
    fn public_status_catalog_and_realtime_generations_are_decimal_strings() {
        const GENERATION: u64 = 9_007_199_254_741_001;
        let status = serde_json::to_value(DomainSummary {
            generation_id: GENERATION,
            discretization: "fem".to_owned(),
            cell_count: 1,
        })
        .expect("status domain should serialize");
        let catalog = serde_json::to_value(FieldCatalog {
            revision: 1,
            domain_generation_id: GENERATION,
            quantities: Vec::new(),
        })
        .expect("field catalog should serialize");
        let realtime = serde_json::to_value(RealtimeResourceChange {
            resource: RealtimeResourceName::Fields,
            revision: 1,
            resource_id: None,
            quantity_ids: Vec::new(),
            broad: false,
            domain_generation_id: Some(GENERATION),
            recommended_fetch: None,
        })
        .expect("realtime change should serialize");

        for value in [status["generation_id"].clone(), catalog["domain_generation_id"].clone(), realtime["domain_generation_id"].clone()] {
            assert_eq!(value, "9007199254741001");
        }
    }
}
