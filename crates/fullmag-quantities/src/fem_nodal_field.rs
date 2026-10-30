//! Strict producer-owned semantics for real nodal FEM H1/P1 output fields.
//!
//! The node count and support mask describe the producer's declared mesh-node
//! support. They do not establish or prove a solver's native degree-of-freedom
//! mapping.

use crate::{
    quantity_spec, ActiveSupportDescriptor, ComplexEncoding, DatasetContractError,
    DatasetFieldDescriptor, FieldAxisDescriptor, FieldFrameDescriptor, FieldFrameKind,
    FieldNormalization, FieldResolution, FieldSampleLocation, FieldValueRepresentation,
    FunctionSpaceDescriptor, FunctionSpaceOrdering, QuantityDomain, QuantityId, QuantityLocation,
    QuantityShape, QuantitySpec,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{error::Error, fmt};

/// Wire format for strict producer-owned real nodal H1/P1 field semantics.
pub const FEM_P1_NODAL_FIELD_SEMANTICS_FORMAT: &str = "fullmag.fem_p1_nodal_field_semantics.v1";

/// Stable producer identity for ordinary real nodal output fields.
pub const FEM_P1_NODAL_FIELD_PRODUCER_ID: &str = "fullmag.fem.p1.nodal-output@1";

/// Producer contract revision.
pub const FEM_P1_NODAL_FIELD_PRODUCER_VERSION: &str = "1";

const ACTIVE_SUPPORT_PREIMAGE_FORMAT: &str = "fullmag.fem_p1_nodal_field.active_support.v1";
const LAYOUT_PREIMAGE_FORMAT: &str = "fullmag.fem_p1_nodal_field.layout.v1";
const FUNCTION_SPACE_FAMILY: &str = "H1";
const FUNCTION_SPACE_ORDER: u32 = 1;
const FRAME_ID: &str = "frame:lab";
const NODE_AXIS_ID: &str = "node";
const COMPONENT_AXIS_ID: &str = "component";
const AXIS_UNIT: &str = "1";
const FUNCTION_SPACE_PREFIX: &str = "space:fem-h1-p1-nodal-output:";
const BASIS_PREFIX: &str = "basis:fem-h1-p1-nodal-output:";
const CARRIER_PREFIX: &str = "carrier:fem-h1-p1-nodal-output:";

/// Error returned when a nodal FEM field envelope is malformed or unsupported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FemP1NodalFieldError(String);

impl FemP1NodalFieldError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for FemP1NodalFieldError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for FemP1NodalFieldError {}

/// Strict semantics for a producer-declared real scalar or vector H1/P1 field.
///
/// `active_node_mask` identifies the declared support in mesh-node index order.
/// This declaration alone does not prove that values use native solver DOF order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FemP1NodalFieldSemantics {
    pub format: String,
    pub producer_id: String,
    pub producer_version: String,
    pub quantity_id: QuantityId,
    pub active_node_mask: Vec<bool>,
    pub descriptor: DatasetFieldDescriptor,
}

impl FemP1NodalFieldSemantics {
    /// Return whether the canonical catalog identifies this as a supported real nodal field.
    pub fn supports_quantity(quantity: QuantityId) -> bool {
        supported_quantity_spec(quantity).is_ok()
    }

    /// Construct the canonical descriptor for one supported nodal quantity.
    ///
    /// The supplied mask is required even for full-domain quantities; this
    /// avoids allocating an unbounded all-true mask from `node_count` alone.
    pub fn new(
        quantity: QuantityId,
        topology_fingerprint: &str,
        node_count: usize,
        active_node_mask: Vec<bool>,
    ) -> Result<Self, FemP1NodalFieldError> {
        let topology_fingerprint = normalize_topology_fingerprint(topology_fingerprint)?;
        let spec = supported_quantity_spec(quantity)?;
        validate_node_support(spec.domain, node_count, &active_node_mask)?;
        let descriptor = build_descriptor(
            quantity,
            spec,
            &topology_fingerprint,
            node_count,
            &active_node_mask,
        )?;
        Ok(Self {
            format: FEM_P1_NODAL_FIELD_SEMANTICS_FORMAT.to_string(),
            producer_id: FEM_P1_NODAL_FIELD_PRODUCER_ID.to_string(),
            producer_version: FEM_P1_NODAL_FIELD_PRODUCER_VERSION.to_string(),
            quantity_id: quantity,
            active_node_mask,
            descriptor,
        })
    }

    /// Regenerate and compare the complete descriptor against current mesh metadata.
    pub fn validate(
        &self,
        expected_quantity: QuantityId,
        topology_fingerprint: &str,
        node_count: usize,
    ) -> Result<(), FemP1NodalFieldError> {
        if self.format != FEM_P1_NODAL_FIELD_SEMANTICS_FORMAT {
            return Err(FemP1NodalFieldError::new(format!(
                "unsupported FEM P1 nodal field semantics format '{}'",
                self.format
            )));
        }
        if self.producer_id != FEM_P1_NODAL_FIELD_PRODUCER_ID {
            return Err(FemP1NodalFieldError::new(format!(
                "unexpected FEM P1 nodal field producer_id '{}'",
                self.producer_id
            )));
        }
        if self.producer_version != FEM_P1_NODAL_FIELD_PRODUCER_VERSION {
            return Err(FemP1NodalFieldError::new(format!(
                "unsupported FEM P1 nodal field producer_version '{}'",
                self.producer_version
            )));
        }
        if self.quantity_id != expected_quantity {
            return Err(FemP1NodalFieldError::new(format!(
                "FEM P1 nodal field quantity '{}' does not match expected quantity '{}'",
                self.quantity_id.as_str(),
                expected_quantity.as_str()
            )));
        }

        let topology_fingerprint = normalize_topology_fingerprint(topology_fingerprint)?;
        let spec = supported_quantity_spec(expected_quantity)?;
        validate_node_support(spec.domain, node_count, &self.active_node_mask)?;
        self.descriptor
            .validate()
            .map_err(descriptor_validation_error)?;
        let expected = build_descriptor(
            expected_quantity,
            spec,
            &topology_fingerprint,
            node_count,
            &self.active_node_mask,
        )?;
        if self.descriptor != expected {
            return Err(FemP1NodalFieldError::new(
                "FEM P1 nodal field descriptor does not match quantity, topology, support, or producer contract",
            ));
        }
        Ok(())
    }
}

fn supported_quantity_spec(
    quantity: QuantityId,
) -> Result<&'static QuantitySpec, FemP1NodalFieldError> {
    if matches!(
        quantity,
        QuantityId::ModeAmplitude
            | QuantityId::ModeReal
            | QuantityId::ModeImag
            | QuantityId::ModePhase
    ) {
        return Err(FemP1NodalFieldError::new(format!(
            "modal quantity '{}' requires modal field semantics",
            quantity.as_str()
        )));
    }

    if quantity == QuantityId::FrozenSpins {
        return Err(FemP1NodalFieldError::new(
            "Frozen Spins is a degree-of-freedom mask, not an ordinary H1/P1 physical field",
        ));
    }

    let spec = quantity_spec(quantity.as_str()).ok_or_else(|| {
        FemP1NodalFieldError::new(format!(
            "quantity '{}' is missing from the canonical quantity catalog",
            quantity.as_str()
        ))
    })?;
    if spec.location != QuantityLocation::Node {
        return Err(FemP1NodalFieldError::new(format!(
            "quantity '{}' is not nodal",
            quantity.as_str()
        )));
    }
    match (spec.shape, spec.n_comp) {
        (QuantityShape::SpatialScalar, 1) | (QuantityShape::VectorField, 3) => Ok(spec),
        _ => Err(FemP1NodalFieldError::new(format!(
            "quantity '{}' is not a scalar or vector nodal field",
            quantity.as_str()
        ))),
    }
}

fn validate_node_support(
    domain: QuantityDomain,
    node_count: usize,
    active_node_mask: &[bool],
) -> Result<(), FemP1NodalFieldError> {
    if node_count == 0 {
        return Err(FemP1NodalFieldError::new(
            "FEM P1 nodal field node_count must be positive",
        ));
    }
    if active_node_mask.len() != node_count {
        return Err(FemP1NodalFieldError::new(format!(
            "active_node_mask length {} does not equal node_count {}",
            active_node_mask.len(),
            node_count
        )));
    }
    match domain {
        QuantityDomain::FullDomain if active_node_mask.iter().any(|active| !active) => {
            Err(FemP1NodalFieldError::new(
                "full-domain nodal quantity requires an all-true active_node_mask",
            ))
        }
        QuantityDomain::MagneticOnly if !active_node_mask.iter().any(|active| *active) => {
            Err(FemP1NodalFieldError::new(
                "magnetic-only nodal quantity requires at least one active node",
            ))
        }
        QuantityDomain::FullDomain | QuantityDomain::MagneticOnly => Ok(()),
    }
}

fn build_descriptor(
    quantity: QuantityId,
    spec: &QuantitySpec,
    topology_fingerprint: &str,
    node_count: usize,
    active_node_mask: &[bool],
) -> Result<DatasetFieldDescriptor, FemP1NodalFieldError> {
    let node_count_u64 = u64::try_from(node_count).map_err(|_| {
        FemP1NodalFieldError::new("node_count does not fit the dataset axis length")
    })?;
    let tensor_rank = match spec.shape {
        QuantityShape::SpatialScalar => 0,
        QuantityShape::VectorField => 1,
        _ => {
            return Err(FemP1NodalFieldError::new(format!(
                "quantity '{}' has an unsupported shape",
                quantity.as_str()
            )));
        }
    };
    let component_count = u32::from(spec.n_comp);
    let axes = if tensor_rank == 0 {
        vec![FieldAxisDescriptor {
            axis_id: NODE_AXIS_ID.to_string(),
            unit: AXIS_UNIT.to_string(),
            length: node_count_u64,
        }]
    } else {
        vec![
            FieldAxisDescriptor {
                axis_id: NODE_AXIS_ID.to_string(),
                unit: AXIS_UNIT.to_string(),
                length: node_count_u64,
            },
            FieldAxisDescriptor {
                axis_id: COMPONENT_AXIS_ID.to_string(),
                unit: AXIS_UNIT.to_string(),
                length: u64::from(spec.n_comp),
            },
        ]
    };
    let component_axis = (tensor_rank == 1).then_some(COMPONENT_AXIS_ID);
    let space_id = format!(
        "{FUNCTION_SPACE_PREFIX}{}:{topology_fingerprint}",
        quantity.as_str()
    );
    let basis_id = format!("{BASIS_PREFIX}{}:{topology_fingerprint}", quantity.as_str());
    let support_fingerprint =
        active_support_fingerprint(quantity, topology_fingerprint, active_node_mask)?;
    let carrier_id = format!(
        "{CARRIER_PREFIX}{}:{topology_fingerprint}:{support_fingerprint}",
        quantity.as_str()
    );
    let layout_digest = layout_digest(
        quantity,
        topology_fingerprint,
        node_count_u64,
        active_node_mask,
        tensor_rank,
        &axes,
        component_axis,
        &support_fingerprint,
        &space_id,
        component_count,
        &basis_id,
        &carrier_id,
    )?;
    let unit = if quantity == QuantityId::M {
        "1"
    } else {
        spec.unit
    };

    let descriptor = DatasetFieldDescriptor {
        quantity_id: quantity,
        unit: unit.to_string(),
        tensor_rank,
        frame: FieldFrameDescriptor {
            kind: FieldFrameKind::Laboratory,
            frame_id: FRAME_ID.to_string(),
        },
        sample_location: FieldSampleLocation::Node,
        active_support: ActiveSupportDescriptor {
            support_fingerprint,
            selection: None,
        },
        function_space: Some(FunctionSpaceDescriptor {
            space_id,
            family: FUNCTION_SPACE_FAMILY.to_string(),
            order: FUNCTION_SPACE_ORDER,
            vector_dimension: component_count,
            ordering: FunctionSpaceOrdering::ByNode,
            basis_id,
            constraints_fingerprint: None,
            partition_fingerprint: None,
            orientation_mapping_ref: None,
        }),
        topology_id: topology_fingerprint.to_string(),
        carrier_id,
        layout_digest,
        axes,
        component_axis: component_axis.map(str::to_string),
        complex_encoding: ComplexEncoding::Real,
        harmonic_convention: None,
        normalization: FieldNormalization::None,
        value_representation: FieldValueRepresentation::PhysicalField,
        modal_semantics: None,
        resolution: FieldResolution::Quantitative,
    };
    descriptor.validate().map_err(descriptor_validation_error)?;
    Ok(descriptor)
}

#[derive(Serialize)]
struct ActiveSupportPreimage<'a> {
    format: &'static str,
    quantity_id: &'static str,
    topology_fingerprint: &'a str,
    active_node_mask: &'a [bool],
}

fn active_support_fingerprint(
    quantity: QuantityId,
    topology_fingerprint: &str,
    active_node_mask: &[bool],
) -> Result<String, FemP1NodalFieldError> {
    digest_json(&ActiveSupportPreimage {
        format: ACTIVE_SUPPORT_PREIMAGE_FORMAT,
        quantity_id: quantity.as_str(),
        topology_fingerprint,
        active_node_mask,
    })
}

#[derive(Serialize)]
struct LayoutPreimage<'a> {
    format: &'static str,
    quantity_id: &'static str,
    topology_fingerprint: &'a str,
    node_count: u64,
    active_node_mask: &'a [bool],
    tensor_rank: u8,
    axes: &'a [FieldAxisDescriptor],
    component_axis: Option<&'a str>,
    support_fingerprint: &'a str,
    function_space_id: &'a str,
    function_space_family: &'static str,
    function_space_order: u32,
    function_space_vector_dimension: u32,
    function_space_ordering: &'static str,
    basis_id: &'a str,
    carrier_id: &'a str,
}

#[allow(clippy::too_many_arguments)]
fn layout_digest(
    quantity: QuantityId,
    topology_fingerprint: &str,
    node_count: u64,
    active_node_mask: &[bool],
    tensor_rank: u8,
    axes: &[FieldAxisDescriptor],
    component_axis: Option<&str>,
    support_fingerprint: &str,
    space_id: &str,
    vector_dimension: u32,
    basis_id: &str,
    carrier_id: &str,
) -> Result<String, FemP1NodalFieldError> {
    digest_json(&LayoutPreimage {
        format: LAYOUT_PREIMAGE_FORMAT,
        quantity_id: quantity.as_str(),
        topology_fingerprint,
        node_count,
        active_node_mask,
        tensor_rank,
        axes,
        component_axis,
        support_fingerprint,
        function_space_id: space_id,
        function_space_family: FUNCTION_SPACE_FAMILY,
        function_space_order: FUNCTION_SPACE_ORDER,
        function_space_vector_dimension: vector_dimension,
        function_space_ordering: "by_node",
        basis_id,
        carrier_id,
    })
}

fn normalize_topology_fingerprint(value: &str) -> Result<String, FemP1NodalFieldError> {
    let hex = value.strip_prefix("sha256:").unwrap_or(value);
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(FemP1NodalFieldError::new(
            "topology_fingerprint must be a lowercase 64-hex SHA-256 digest, with optional sha256: prefix",
        ));
    }
    Ok(format!("sha256:{hex}"))
}

fn digest_json<T: Serialize>(value: &T) -> Result<String, FemP1NodalFieldError> {
    let bytes = serde_json::to_vec(value).map_err(|error| {
        FemP1NodalFieldError::new(format!(
            "cannot serialize FEM P1 nodal field identity: {error}"
        ))
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn descriptor_validation_error(error: DatasetContractError) -> FemP1NodalFieldError {
    FemP1NodalFieldError::new(format!("invalid FEM P1 nodal field descriptor: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn topology(byte: char) -> String {
        format!("sha256:{}", byte.to_string().repeat(64))
    }

    fn semantics(quantity: QuantityId, mask: Vec<bool>) -> FemP1NodalFieldSemantics {
        FemP1NodalFieldSemantics::new(quantity, &topology('a'), mask.len(), mask)
            .expect("valid nodal field semantics")
    }

    #[test]
    fn magnetization_uses_legacy_canonical_unit_with_new_semantics_identity() {
        let value = semantics(QuantityId::M, vec![true, false, true, true]);

        assert_eq!(value.format, FEM_P1_NODAL_FIELD_SEMANTICS_FORMAT);
        assert_eq!(value.producer_id, FEM_P1_NODAL_FIELD_PRODUCER_ID);
        assert_eq!(value.descriptor.quantity_id, QuantityId::M);
        assert_eq!(value.descriptor.unit, "1");
        assert_eq!(value.descriptor.tensor_rank, 1);
        assert_eq!(value.descriptor.sample_location, FieldSampleLocation::Node);
        assert_eq!(value.descriptor.axes[0].length, 4);
        assert_eq!(value.descriptor.axes[1].length, 3);
        assert_eq!(
            value.descriptor.component_axis.as_deref(),
            Some("component")
        );
        assert_eq!(value.active_node_mask, vec![true, false, true, true]);
        value
            .validate(QuantityId::M, &topology('a'), 4)
            .expect("valid M semantics");
    }

    #[test]
    fn h_eff_requires_full_support_and_uses_catalog_unit() {
        let value = semantics(QuantityId::HEff, vec![true; 4]);

        assert_eq!(value.descriptor.unit, "A/m");
        assert_eq!(value.descriptor.tensor_rank, 1);
        assert_eq!(value.descriptor.axes[0].length, 4);
        assert_eq!(value.descriptor.axes[1].length, 3);
        assert_eq!(
            value
                .descriptor
                .function_space
                .as_ref()
                .unwrap()
                .vector_dimension,
            3
        );
        assert!(FemP1NodalFieldSemantics::new(
            QuantityId::HEff,
            &topology('a'),
            4,
            vec![true, true, true, false],
        )
        .is_err());
    }

    #[test]
    fn scalar_nodal_catalog_quantity_has_only_node_axis() {
        let value = semantics(QuantityId::DemagPhi, vec![true; 3]);

        assert_eq!(value.descriptor.unit, "A");
        assert_eq!(value.descriptor.tensor_rank, 0);
        assert_eq!(value.descriptor.axes.len(), 1);
        assert_eq!(value.descriptor.axes[0].axis_id, "node");
        assert_eq!(value.descriptor.axes[0].length, 3);
        assert_eq!(value.descriptor.component_axis, None);
        assert_eq!(
            value
                .descriptor
                .function_space
                .as_ref()
                .unwrap()
                .vector_dimension,
            1
        );
    }

    #[test]
    fn rejects_zero_count_mismatched_mask_and_empty_magnetic_support() {
        assert!(
            FemP1NodalFieldSemantics::new(QuantityId::M, &topology('a'), 0, Vec::new()).is_err()
        );
        assert!(
            FemP1NodalFieldSemantics::new(QuantityId::M, &topology('a'), 3, vec![true, true],)
                .is_err()
        );
        assert!(
            FemP1NodalFieldSemantics::new(QuantityId::M, &topology('a'), 3, vec![false; 3],)
                .is_err()
        );
        assert!(FemP1NodalFieldSemantics::new(
            QuantityId::HEff,
            &topology('a'),
            3,
            vec![true, false, true],
        )
        .is_err());
    }

    #[test]
    fn rejects_non_nodal_modal_mask_and_tensor_quantities() {
        for quantity in [
            QuantityId::FrozenSpins,
            QuantityId::EdenEx,
            QuantityId::ETotal,
            QuantityId::ModeAmplitude,
            QuantityId::ModeReal,
            QuantityId::ModeImag,
            QuantityId::ModePhase,
            QuantityId::SpinCurrentTensor,
        ] {
            assert!(
                FemP1NodalFieldSemantics::new(quantity, &topology('a'), 3, vec![true; 3]).is_err(),
                "{} must not be treated as an ordinary nodal field",
                quantity.as_str()
            );
        }
    }

    #[test]
    fn serde_round_trip_is_exact_and_unknown_fields_are_rejected() {
        let value = semantics(QuantityId::HEff, vec![true; 3]);
        let json = serde_json::to_string(&value).expect("serialize semantics");
        let decoded: FemP1NodalFieldSemantics =
            serde_json::from_str(&json).expect("deserialize semantics");
        assert_eq!(decoded, value);
        decoded
            .validate(QuantityId::HEff, &topology('a'), 3)
            .expect("round-tripped semantics validate");

        let mut wire = serde_json::to_value(&value).expect("wire value");
        wire["unrecognized"] = Value::Bool(true);
        assert!(serde_json::from_value::<FemP1NodalFieldSemantics>(wire).is_err());
    }

    #[test]
    fn validate_rejects_wire_changes_to_identity_layout_or_physics_metadata() {
        let original = semantics(QuantityId::HEff, vec![true; 4]);
        let mut mutations: Vec<(&str, Box<dyn Fn(&mut Value)>)> = vec![
            (
                "unit",
                Box::new(|wire| wire["descriptor"]["unit"] = Value::String("T".into())),
            ),
            (
                "rank",
                Box::new(|wire| wire["descriptor"]["tensor_rank"] = Value::from(0)),
            ),
            (
                "axes",
                Box::new(|wire| wire["descriptor"]["axes"][0]["length"] = Value::from(3)),
            ),
            (
                "descriptor quantity",
                Box::new(|wire| wire["descriptor"]["quantity_id"] = Value::String("m".into())),
            ),
            (
                "envelope quantity",
                Box::new(|wire| wire["quantity_id"] = Value::String("m".into())),
            ),
            (
                "topology",
                Box::new(|wire| {
                    wire["descriptor"]["topology_id"] = Value::String(topology('b'));
                }),
            ),
            (
                "producer",
                Box::new(|wire| wire["producer_id"] = Value::String("other.producer@1".into())),
            ),
            (
                "normalization",
                Box::new(|wire| {
                    wire["descriptor"]["normalization"] = Value::String("unit_vector".into());
                }),
            ),
        ];

        for (name, mutate) in mutations.drain(..) {
            let mut wire = serde_json::to_value(&original).expect("wire value");
            mutate(&mut wire);
            let decoded: FemP1NodalFieldSemantics =
                serde_json::from_value(wire).expect("mutated wire remains well-formed");
            assert!(
                decoded
                    .validate(QuantityId::HEff, &topology('a'), 4)
                    .is_err(),
                "mutated {name} must be rejected"
            );
        }
    }

    #[test]
    fn fingerprints_bind_quantity_topology_and_support_deterministically() {
        let first = semantics(QuantityId::M, vec![true, false, true, true]);
        let repeat = semantics(QuantityId::M, vec![true, false, true, true]);
        let other_support = semantics(QuantityId::M, vec![true, true, false, true]);
        let other_quantity = semantics(QuantityId::HEx, vec![true, false, true, true]);
        let other_topology = FemP1NodalFieldSemantics::new(
            QuantityId::M,
            &topology('b'),
            4,
            vec![true, false, true, true],
        )
        .expect("second topology");
        for other in [&other_quantity, &other_topology] {
            assert_ne!(
                first.descriptor.layout_digest,
                other.descriptor.layout_digest
            );
            assert_ne!(
                first.descriptor.active_support.support_fingerprint,
                other.descriptor.active_support.support_fingerprint,
            );
        }

        assert_eq!(
            first.descriptor.active_support.support_fingerprint,
            repeat.descriptor.active_support.support_fingerprint
        );
        assert_eq!(
            first.descriptor.layout_digest,
            repeat.descriptor.layout_digest
        );
        assert_ne!(
            first.descriptor.active_support.support_fingerprint,
            other_support.descriptor.active_support.support_fingerprint
        );
        assert_ne!(
            first.descriptor.layout_digest,
            other_support.descriptor.layout_digest
        );
    }
}
