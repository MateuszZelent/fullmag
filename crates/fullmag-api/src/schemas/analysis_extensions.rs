//! Closed v2 schemas for object-scoped analysis extensions.
//!
//! These types intentionally sit above the analysis implementation.  They are
//! shared by the HTTP handler, OpenAPI document, generated frontend transport,
//! and resource hooks so that none of those layers can invent a second meaning
//! for planar topological charge.

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use std::fmt;
use utoipa::{IntoParams, ToSchema};

fn default_plane() -> TopologicalChargePlane {
    TopologicalChargePlane::Auto
}

fn default_support() -> TopologicalChargeSupportMode {
    TopologicalChargeSupportMode::Midplane
}

fn default_method() -> TopologicalChargeMethod {
    TopologicalChargeMethod::BergLuescherOrientedTrianglesV2
}

/// The ordered support plane.  The canonical `(u, v, n)` frame is published in
/// the response because `xz` has normal `-y`, not `+y`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TopologicalChargePlane {
    Auto,
    Xy,
    Xz,
    Yz,
}

/// Whether the result represents one exact midplane or a thickness profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TopologicalChargeSupportMode {
    Midplane,
    LayerProfile,
}

/// A bounded request for exact profile cuts.
///
/// Query parameters are strings, so deserialization accepts `auto` and decimal
/// integers only.  The numeric bounds are enforced at the public boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TopologicalChargeProfileSamples {
    Auto,
    Count(u16),
}

impl<'de> Deserialize<'de> for TopologicalChargeProfileSamples {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct ProfileSamplesVisitor;

        impl<'de> de::Visitor<'de> for ProfileSamplesVisitor {
            type Value = TopologicalChargeProfileSamples;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("`auto` or an integer from 3 through 257")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                if value == "auto" {
                    return Ok(TopologicalChargeProfileSamples::Auto);
                }
                let count = value
                    .parse::<u16>()
                    .map_err(|_| E::custom("expected `auto` or an integer from 3 through 257"))?;
                Self::validate_count(count).map_err(E::custom)
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                let count = u16::try_from(value)
                    .map_err(|_| E::custom("profile sample count exceeds 257"))?;
                Self::validate_count(count).map_err(E::custom)
            }
        }

        impl ProfileSamplesVisitor {
            fn validate_count(count: u16) -> Result<TopologicalChargeProfileSamples, &'static str> {
                if !(3..=257).contains(&count) {
                    return Err("profile sample count must be from 3 through 257");
                }
                Ok(TopologicalChargeProfileSamples::Count(count))
            }
        }

        deserializer.deserialize_any(ProfileSamplesVisitor)
    }
}

/// The single production discretization method for schema v2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TopologicalChargeMethod {
    BergLuescherOrientedTrianglesV2,
}

/// Expected scientific computation states.  Transport lifecycle is intentionally
/// absent: `idle`, `loading`, `stale`, and `error` belong to the resource hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TopologicalChargeStatus {
    Ready,
    NoCurrentMagnetization,
    EmptySupport,
    InvalidMagnetization,
    DegenerateSupport,
    UnderResolved,
    UnsupportedGeometry,
    UnsupportedDiscretization,
}

/// Scientific trust is intentionally distinct from whether computation produced
/// a finite diagnostic integral.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TopologicalChargeTrust {
    Qualified,
    DiagnosticBoundary,
    DiagnosticResolution,
    DiagnosticTopology,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TopologicalChargeQueryError {
    ProfileSamplesForMidplane,
    StageWithoutSnapshot,
}

impl fmt::Display for TopologicalChargeQueryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ProfileSamplesForMidplane => {
                formatter.write_str("profile_samples is only legal for support=layer_profile")
            }
            Self::StageWithoutSnapshot => formatter.write_str("stage_id requires snapshot_id"),
        }
    }
}

impl std::error::Error for TopologicalChargeQueryError {}

/// Typed query for the v2 analysis resource.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, IntoParams, ToSchema)]
pub struct TopologicalChargeQueryV2 {
    #[serde(default = "default_plane")]
    pub plane: TopologicalChargePlane,
    #[serde(default = "default_support")]
    pub support: TopologicalChargeSupportMode,
    #[serde(default)]
    pub profile_samples: Option<TopologicalChargeProfileSamples>,
    #[serde(default)]
    pub snapshot_id: Option<String>,
    #[serde(default)]
    pub stage_id: Option<String>,
    #[serde(default = "default_method")]
    pub method: TopologicalChargeMethod,
}

impl TopologicalChargeQueryV2 {
    pub fn validate(&self) -> Result<(), TopologicalChargeQueryError> {
        if self.support == TopologicalChargeSupportMode::Midplane && self.profile_samples.is_some()
        {
            return Err(TopologicalChargeQueryError::ProfileSamplesForMidplane);
        }
        if self.stage_id.is_some() && self.snapshot_id.is_none() {
            return Err(TopologicalChargeQueryError::StageWithoutSnapshot);
        }
        Ok(())
    }

    pub fn resolved_profile_sample_count(&self) -> Option<u16> {
        match (self.support, self.profile_samples) {
            (TopologicalChargeSupportMode::Midplane, _) => None,
            (TopologicalChargeSupportMode::LayerProfile, None)
            | (
                TopologicalChargeSupportMode::LayerProfile,
                Some(TopologicalChargeProfileSamples::Auto),
            ) => Some(33),
            (
                TopologicalChargeSupportMode::LayerProfile,
                Some(TopologicalChargeProfileSamples::Count(count)),
            ) => Some(count),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeRequestEcho {
    pub requested_plane: TopologicalChargePlane,
    pub requested_support: TopologicalChargeSupportMode,
    pub requested_profile_samples: Option<TopologicalChargeProfileSamples>,
    pub snapshot_id: Option<String>,
    pub stage_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeResolvedSupport {
    pub plane: TopologicalChargePlane,
    pub support: TopologicalChargeSupportMode,
    pub profile_sample_count: Option<u16>,
    pub source_kind: String,
    pub coordinate_m: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeSupportFrame {
    pub u_axis: [i8; 3],
    pub v_axis: [i8; 3],
    pub normal_axis: [i8; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeLayerSample {
    pub index: u16,
    pub coordinate_m: f64,
    pub integration_weight_m: f64,
    pub status: TopologicalChargeStatus,
    pub trust: TopologicalChargeTrust,
    pub charge: Option<f64>,
    pub valid_triangle_count: u64,
    pub total_triangle_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeQuality {
    pub total_vertex_count: u64,
    pub valid_vertex_count: u64,
    pub total_triangle_count: u64,
    pub valid_triangle_count: u64,
    pub invalid_triangle_count: u64,
    pub exceptional_triangle_count: u64,
    pub max_edge_angle_rad: Option<f64>,
    pub min_abs_solid_angle_denominator: Option<f64>,
    pub connected_component_count: u32,
    pub boundary_edge_count: u64,
    pub boundary_loop_count: u32,
    pub euler_characteristic: Option<i64>,
    pub boundary_max_deviation_rad: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeProvenance {
    pub source_kind: String,
    pub field_id: String,
    pub field_revision: String,
    pub field_storage_domain: String,
    pub field_node_mapping_id: Option<String>,
    pub scene_revision: String,
    pub mesh_revision: Option<String>,
    pub mesh_generation_id: Option<String>,
    pub domain_generation_id: String,
    pub snapshot_id: Option<String>,
    pub stage_id: Option<String>,
    pub discretization: String,
    pub fe_order: Option<u8>,
    pub cache_key_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeMethodDescriptor {
    pub id: TopologicalChargeMethod,
    pub version: String,
    pub quantity_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeWarning {
    pub code: String,
    pub severity: String,
    pub message: String,
}

/// Versioned resource published by the topological-charge endpoint.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopologicalChargeResourceV2 {
    #[schema(example = "topological_charge.v2")]
    pub schema_version: String,
    pub resource_revision: String,
    pub object_id: String,
    pub status: TopologicalChargeStatus,
    pub trust: TopologicalChargeTrust,
    pub charge: Option<f64>,
    pub nearest_integer: Option<i64>,
    pub integer_error: Option<f64>,
    pub request: TopologicalChargeRequestEcho,
    pub resolved_support: TopologicalChargeResolvedSupport,
    pub support_frame: TopologicalChargeSupportFrame,
    #[serde(default)]
    pub profile: Vec<TopologicalChargeLayerSample>,
    pub quality: TopologicalChargeQuality,
    pub provenance: TopologicalChargeProvenance,
    pub method: TopologicalChargeMethodDescriptor,
    pub computed_at_unix_ms: u64,
    #[serde(default)]
    pub warnings: Vec<TopologicalChargeWarning>,
}

#[cfg(test)]
mod tests {
    use super::{
        TopologicalChargeMethod, TopologicalChargePlane, TopologicalChargeProfileSamples,
        TopologicalChargeQueryError, TopologicalChargeQueryV2, TopologicalChargeSupportMode,
    };

    fn base_query() -> TopologicalChargeQueryV2 {
        TopologicalChargeQueryV2 {
            plane: TopologicalChargePlane::Auto,
            support: TopologicalChargeSupportMode::Midplane,
            profile_samples: None,
            snapshot_id: None,
            stage_id: None,
            method: TopologicalChargeMethod::BergLuescherOrientedTrianglesV2,
        }
    }

    #[test]
    fn topological_charge_schema_rejects_profile_samples_for_midplane() {
        let mut query = base_query();
        query.profile_samples = Some(TopologicalChargeProfileSamples::Count(17));

        assert_eq!(
            query.validate(),
            Err(TopologicalChargeQueryError::ProfileSamplesForMidplane)
        );
    }

    #[test]
    fn topological_charge_schema_rejects_stage_without_snapshot() {
        let mut query = base_query();
        query.stage_id = Some("stage-1".to_string());

        assert_eq!(
            query.validate(),
            Err(TopologicalChargeQueryError::StageWithoutSnapshot)
        );
    }

    #[test]
    fn topological_charge_schema_resolves_auto_profile_to_33_exact_cuts() {
        let mut query = base_query();
        query.support = TopologicalChargeSupportMode::LayerProfile;
        query.profile_samples = Some(TopologicalChargeProfileSamples::Auto);

        assert_eq!(query.validate(), Ok(()));
        assert_eq!(query.resolved_profile_sample_count(), Some(33));
    }

    #[test]
    fn topological_charge_schema_accepts_only_bounded_profile_counts() {
        let lower =
            serde_json::from_value::<TopologicalChargeProfileSamples>(serde_json::json!("3"));
        let upper =
            serde_json::from_value::<TopologicalChargeProfileSamples>(serde_json::json!("257"));
        let below =
            serde_json::from_value::<TopologicalChargeProfileSamples>(serde_json::json!("2"));
        let above =
            serde_json::from_value::<TopologicalChargeProfileSamples>(serde_json::json!("258"));

        assert_eq!(lower.unwrap(), TopologicalChargeProfileSamples::Count(3));
        assert_eq!(upper.unwrap(), TopologicalChargeProfileSamples::Count(257));
        assert!(below.is_err());
        assert!(above.is_err());
    }
}
