use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldCatalog {
    pub revision: u64,
    pub domain_generation_id: u64,
    pub quantities: Vec<FieldDescriptor>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldDescriptor {
    pub quantity_id: String,
    pub label: String,
    pub kind: String,
    pub components: u8,
    pub location: String,
    pub unit: String,
    pub field_revision: u64,
    pub domain_generation_id: u64,
    pub available: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldMeta {
    pub quantity_id: String,
    pub label: String,
    pub kind: String,
    pub components: u8,
    pub location: String,
    pub unit: String,
    pub field_revision: u64,
    pub domain_generation_id: u64,
    pub stats: Option<FieldStats>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldStats {
    pub min: f64,
    pub max: f64,
    pub mean: f64,
}
