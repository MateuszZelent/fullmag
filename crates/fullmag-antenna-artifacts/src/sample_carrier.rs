//! Backend-neutral sample carrier DTO; scientific validation belongs to its consumer.
use fullmag_ir::FieldTargetIR;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaSampleCarrier {
    pub domain: FieldTargetIR,
    pub carrier_kind: String,
    pub location: String,
    pub topology_digest: String,
}
