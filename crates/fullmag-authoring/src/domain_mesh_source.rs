//! Authoring assertions for an existing shared FEM mesh source.
//! These assertions never remap markers or add history to executable IR.
use crate::{SceneDocumentValidationError, SceneObject};
use fullmag_ir::{FemDomainRegionMarkerIR, RegionRefIR};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ScriptBuilderDomainMarkerTable {
    RegionMarkers,
    ObjectRegionMarkers,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScriptBuilderDomainMarkerOwner {
    pub table: ScriptBuilderDomainMarkerTable,
    pub geometry_name: String,
    pub marker: u32,
    #[serde(deserialize_with = "deserialize_target")]
    pub target: RegionRefIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScriptBuilderSharedDomainMeshSource {
    Generated {},
    Explicit {
        source: String,
        #[serde(deserialize_with = "deserialize_markers")]
        region_markers: Vec<FemDomainRegionMarkerIR>,
        #[serde(default, skip_serializing_if = "Option::is_none",
                deserialize_with = "deserialize_optional_markers")]
        object_region_markers: Option<Vec<FemDomainRegionMarkerIR>>,
        marker_owners: Vec<ScriptBuilderDomainMarkerOwner>,
    },
}

pub(crate) fn deserialize_present_source<'de, D>(
    deserializer: D,
) -> Result<Option<ScriptBuilderSharedDomainMeshSource>, D::Error>
where D: Deserializer<'de> {
    ScriptBuilderSharedDomainMeshSource::deserialize(deserializer).map(Some)
}

fn deserialize_target<'de, D>(deserializer: D) -> Result<RegionRefIR, D::Error>
where D: Deserializer<'de> {
    let value = serde_json::Value::deserialize(deserializer)?;
    let object = value.as_object().ok_or_else(|| serde::de::Error::custom("owner target must be an object"))?;
    if object.keys().any(|key| key != "object_id" && key != "region_id")
        || object.get("region_id").is_some_and(|value| !value.is_string()) {
        return Err(serde::de::Error::custom("invalid owner target fields"));
    }
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}

fn deserialize_markers<'de, D>(deserializer: D) -> Result<Vec<FemDomainRegionMarkerIR>, D::Error>
where D: Deserializer<'de> {
    let values = Vec::<serde_json::Value>::deserialize(deserializer)?;
    for value in &values {
        let object = value.as_object().ok_or_else(|| serde::de::Error::custom("marker must be an object"))?;
        if object.len() != 2 || !object.contains_key("geometry_name") || !object.contains_key("marker") {
            return Err(serde::de::Error::custom("invalid marker fields"));
        }
    }
    serde_json::from_value(serde_json::Value::Array(values)).map_err(serde::de::Error::custom)
}

fn deserialize_optional_markers<'de, D>(deserializer: D) -> Result<Option<Vec<FemDomainRegionMarkerIR>>, D::Error>
where D: Deserializer<'de> {
    deserialize_markers(deserializer).map(Some)
}

fn nonempty(value: &str) -> bool {
    !value.is_empty() && value.trim() == value && !value.contains(char::from(0))
}

pub fn validate_shared_domain_mesh_source(
    source: &ScriptBuilderSharedDomainMeshSource,
    objects: &[SceneObject],
) -> Result<(), SceneDocumentValidationError> {
    let fail = |reason: &str| SceneDocumentValidationError::new(format!("shared domain marker owner: {reason}"));
    let ScriptBuilderSharedDomainMeshSource::Explicit {
        source, region_markers, object_region_markers, marker_owners,
    } = source else { return Ok(()); };
    if !nonempty(source) { return Err(fail("empty or invalid source")); }
    let mut expected = BTreeSet::new();
    let mut all_markers = BTreeSet::new();
    for (table, rows) in [
        (ScriptBuilderDomainMarkerTable::RegionMarkers, region_markers.as_slice()),
        (ScriptBuilderDomainMarkerTable::ObjectRegionMarkers,
         object_region_markers.as_deref().unwrap_or(&[])),
    ] {
        let mut names = BTreeSet::new();
        for row in rows {
            if !nonempty(&row.geometry_name) || row.marker == 0
                || !names.insert(row.geometry_name.as_str()) || !all_markers.insert(row.marker) {
                return Err(fail("invalid or duplicate marker entry"));
            }
            expected.insert((table, row.geometry_name.clone(), row.marker));
        }
    }
    let mut seen = BTreeSet::new();
    for owner in marker_owners {
        let key = (owner.table, owner.geometry_name.clone(), owner.marker);
        if !expected.contains(&key) || !seen.insert(key) || !nonempty(&owner.target.object_id)
            || owner.target.region_id.as_ref().is_some_and(|id| !nonempty(id)) {
            return Err(fail("invalid, duplicate or unknown owner assertion"));
        }
        let actual = match owner.table {
            ScriptBuilderDomainMarkerTable::RegionMarkers => {
                if owner.target.region_id.is_some() { return Err(fail("root target cannot name a region")); }
                let matches = objects.iter().filter(|object| {
                    let key = object.geometry.geometry_name.clone().unwrap_or_else(|| {
                        let label = crate::adapters::builder_geometry_name_for_object(object);
                        if object.role == "magnet" { format!("{label}_geom") } else { label }
                    });
                    key == owner.geometry_name
                }).collect::<Vec<_>>();
                if matches.len() != 1 { return Err(fail("missing or ambiguous geometry owner")); }
                RegionRefIR { object_id: matches[0].id.clone(), region_id: None }
            }
            ScriptBuilderDomainMarkerTable::ObjectRegionMarkers => {
                let regions = objects.iter().filter(|object| object.role == "magnet")
                    .flat_map(|object| object.regions.iter().map(move |region| (object, region)))
                    .collect::<Vec<_>>();
                let exact = regions.iter().copied().filter(|(_, region)| region.region_id == owner.geometry_name)
                    .collect::<Vec<_>>();
                let matches = if exact.is_empty() {
                    regions.iter().copied().filter(|(_, region)| region.enabled && region.name == owner.geometry_name)
                        .collect::<Vec<_>>()
                } else { exact };
                if matches.len() != 1 || !matches[0].1.enabled {
                    return Err(fail("missing, disabled or ambiguous region owner"));
                }
                let (object, region) = matches[0];
                if !region.owner_object.is_empty() && region.owner_object != object.id {
                    return Err(fail("region owner differs from its container"));
                }
                RegionRefIR { object_id: object.id.clone(), region_id: Some(region.region_id.clone()) }
            }
        };
        if actual != owner.target { return Err(fail("owner changed")); }
    }
    if seen != expected { return Err(fail("owner assertions do not cover both source tables")); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_domain_source_common_marker_owner_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/domain_marker_owner_cases.json"
        )).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let decoded = serde_json::from_value::<ScriptBuilderSharedDomainMeshSource>(case["source"].clone());
            let result = decoded.map_err(|error| error.to_string()).and_then(|source| {
                let objects: Vec<SceneObject> = serde_json::from_value(case["objects"].clone()).unwrap();
                validate_shared_domain_mesh_source(&source, &objects).map_err(|error| error.to_string())
            });
            assert_eq!(result.is_ok(), case["valid"].as_bool().unwrap(), "{}: {result:?}", case["id"]);
        }
    }
}
