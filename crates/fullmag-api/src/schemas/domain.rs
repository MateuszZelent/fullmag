use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use utoipa::ToSchema;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DomainMeta {
    pub domain_id: String,
    #[schema(example = "fem")]
    pub discretization: String,
    pub generation_id: u64,
    pub dimension: u8,
    pub coordinate_system: String,
    pub units: HashMap<String, String>,
    pub bounds: Bounds3,
    pub counts: DomainCounts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grid: Option<StructuredGridDescriptor>,
    pub element_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct Bounds3 {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DomainCounts {
    pub cells: Option<u64>,
    pub nodes: Option<u64>,
    pub elements: Option<u64>,
    pub boundary_faces: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct StructuredGridDescriptor {
    pub shape: [u32; 3],
    pub origin: [f64; 3],
    pub spacing: [f64; 3],
}
