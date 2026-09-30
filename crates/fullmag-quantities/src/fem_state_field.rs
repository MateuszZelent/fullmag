//! Typed semantics for the serial FEM H1/P1 magnetization field.
//!
//! This module describes the producer contract only.  It does not qualify a
//! mesh, a solver result, or a physical magnetization state.  The producer
//! must supply the topology identity and the exact node support mask that was
//! used for the field.

use crate::{
    ActiveSupportDescriptor, ComplexEncoding, DatasetContractError, DatasetFieldDescriptor,
    FieldAxisDescriptor, FieldFrameDescriptor, FieldFrameKind, FieldNormalization, FieldResolution,
    FieldSampleLocation, FieldValueRepresentation, FunctionSpaceDescriptor, FunctionSpaceOrdering,
    HarmonicConvention, QuantityId,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{error::Error, fmt};

/// Wire format for the typed FEM H1/P1 magnetization producer envelope.
pub const FEM_P1_MAGNETIZATION_FIELD_SEMANTICS_FORMAT: &str = "fullmag.fem_p1_m_field_semantics.v1";

/// Stable producer identity for the serial FEM H1/P1 magnetization field.
pub const FEM_P1_MAGNETIZATION_PRODUCER_ID: &str = "fullmag.fem.p1.magnetization";

/// Producer contract revision.  This is kept separate from the envelope
/// format so a producer can evolve its implementation without changing the
/// surrounding storage schema accidentally.
pub const FEM_P1_MAGNETIZATION_PRODUCER_VERSION: &str = "1";

const ACTIVE_SUPPORT_PREIMAGE_FORMAT: &str = "fullmag.fem_p1_m.active_support.v1";
const LAYOUT_PREIMAGE_FORMAT: &str = "fullmag.fem_p1_m.layout.v1";
const FUNCTION_SPACE_FAMILY: &str = "H1";
const FUNCTION_SPACE_ORDER: u32 = 1;
const VECTOR_DIMENSION: u32 = 3;
const FRAME_ID: &str = "frame:lab";
const BASIS_PREFIX: &str = "basis:fem-h1-p1-nodal-global:";
const SPACE_PREFIX: &str = "space:fem-h1-p1:";
const CARRIER_PREFIX: &str = "carrier:fem-h1-p1-magnetization:";
const COMPONENT_AXIS_ID: &str = "component";
const NODE_AXIS_ID: &str = "node";

/// Error returned when a FEM H1/P1 magnetization envelope is malformed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FemP1MagnetizationFieldError(String);

impl FemP1MagnetizationFieldError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for FemP1MagnetizationFieldError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for FemP1MagnetizationFieldError {}

/// Strict producer-owned semantics for an H1/P1 nodal magnetization field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FemP1MagnetizationFieldSemantics {
    pub format: String,
    pub producer_id: String,
    pub producer_version: String,
    pub active_node_mask: Vec<bool>,
    pub descriptor: DatasetFieldDescriptor,
}

impl FemP1MagnetizationFieldSemantics {
    /// Construct the exact descriptor for a serial H1/P1 nodal field.
    pub fn new(
        topology_fingerprint: &str,
        node_count: usize,
        active_node_mask: Vec<bool>,
    ) -> Result<Self, FemP1MagnetizationFieldError> {
        let topology_fingerprint = normalize_topology_fingerprint(topology_fingerprint)?;
        validate_node_support(node_count, &active_node_mask)?;
        let descriptor = build_descriptor(&topology_fingerprint, node_count, &active_node_mask)?;
        Ok(Self {
            format: FEM_P1_MAGNETIZATION_FIELD_SEMANTICS_FORMAT.to_string(),
            producer_id: FEM_P1_MAGNETIZATION_PRODUCER_ID.to_string(),
            producer_version: FEM_P1_MAGNETIZATION_PRODUCER_VERSION.to_string(),
            active_node_mask,
            descriptor,
        })
    }

    /// Validate the producer envelope against the current mesh metadata.
    ///
    /// The descriptor is regenerated from the supplied topology and the
    /// stored mask.  Consequently, changing an axis, ordering, unit,
    /// function-space order, or any other descriptor field is rejected even
    /// when the generic dataset validator would accept that variation.
    pub fn validate(
        &self,
        topology_fingerprint: &str,
        node_count: usize,
    ) -> Result<(), FemP1MagnetizationFieldError> {
        if self.format != FEM_P1_MAGNETIZATION_FIELD_SEMANTICS_FORMAT {
            return Err(FemP1MagnetizationFieldError::new(format!(
                "unsupported FEM H1/P1 magnetization semantics format '{}'",
                self.format
            )));
        }
        if self.producer_id != FEM_P1_MAGNETIZATION_PRODUCER_ID {
            return Err(FemP1MagnetizationFieldError::new(format!(
                "unexpected FEM H1/P1 magnetization producer_id '{}'",
                self.producer_id
            )));
        }
        if self.producer_version != FEM_P1_MAGNETIZATION_PRODUCER_VERSION {
            return Err(FemP1MagnetizationFieldError::new(format!(
                "unsupported FEM H1/P1 magnetization producer_version '{}'",
                self.producer_version
            )));
        }

        let topology_fingerprint = normalize_topology_fingerprint(topology_fingerprint)?;
        validate_node_support(node_count, &self.active_node_mask)?;
        self.descriptor
            .validate()
            .map_err(descriptor_validation_error)?;
        let expected = build_descriptor(&topology_fingerprint, node_count, &self.active_node_mask)?;
        if self.descriptor != expected {
            return Err(FemP1MagnetizationFieldError::new(
                "FEM H1/P1 magnetization descriptor does not match topology, node support, or producer contract",
            ));
        }
        Ok(())
    }
}

/// Normalize a bare SHA-256 topology fingerprint to the wire form accepted by
/// the quantity contracts.  Uppercase hexadecimal is rejected so identity is
/// byte-stable across producers.
pub fn normalize_topology_fingerprint(value: &str) -> Result<String, FemP1MagnetizationFieldError> {
    let hex = value.strip_prefix("sha256:").unwrap_or(value);
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(FemP1MagnetizationFieldError::new(
            "topology_fingerprint must be a lowercase 64-hex SHA-256 digest, with optional sha256: prefix",
        ));
    }
    Ok(format!("sha256:{hex}"))
}

fn validate_node_support(
    node_count: usize,
    active_node_mask: &[bool],
) -> Result<(), FemP1MagnetizationFieldError> {
    if node_count == 0 {
        return Err(FemP1MagnetizationFieldError::new(
            "FEM H1/P1 magnetization node_count must be positive",
        ));
    }
    if active_node_mask.len() != node_count {
        return Err(FemP1MagnetizationFieldError::new(format!(
            "active_node_mask length {} does not equal node_count {}",
            active_node_mask.len(),
            node_count
        )));
    }
    if !active_node_mask.iter().any(|active| *active) {
        return Err(FemP1MagnetizationFieldError::new(
            "active_node_mask must contain at least one active node",
        ));
    }
    Ok(())
}

fn build_descriptor(
    topology_fingerprint: &str,
    node_count: usize,
    active_node_mask: &[bool],
) -> Result<DatasetFieldDescriptor, FemP1MagnetizationFieldError> {
    let node_count_u64 = u64::try_from(node_count).map_err(|_| {
        FemP1MagnetizationFieldError::new("node_count does not fit the dataset axis length")
    })?;
    let support_fingerprint = active_support_fingerprint(topology_fingerprint, active_node_mask)?;
    let space_id = format!("{SPACE_PREFIX}{topology_fingerprint}");
    let basis_id = format!("{BASIS_PREFIX}{topology_fingerprint}");
    let carrier_id = format!("{CARRIER_PREFIX}{topology_fingerprint}");
    let layout_digest = layout_digest(
        topology_fingerprint,
        node_count_u64,
        &support_fingerprint,
        &space_id,
        &basis_id,
        &carrier_id,
    )?;

    let descriptor = DatasetFieldDescriptor {
        quantity_id: QuantityId::M,
        unit: "1".to_string(),
        tensor_rank: 1,
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
            vector_dimension: VECTOR_DIMENSION,
            ordering: FunctionSpaceOrdering::ByNode,
            basis_id,
            constraints_fingerprint: None,
            partition_fingerprint: None,
            orientation_mapping_ref: None,
        }),
        topology_id: topology_fingerprint.to_string(),
        carrier_id,
        layout_digest,
        axes: vec![
            FieldAxisDescriptor {
                axis_id: NODE_AXIS_ID.to_string(),
                unit: "1".to_string(),
                length: node_count_u64,
            },
            FieldAxisDescriptor {
                axis_id: COMPONENT_AXIS_ID.to_string(),
                unit: "1".to_string(),
                length: u64::from(VECTOR_DIMENSION),
            },
        ],
        component_axis: Some(COMPONENT_AXIS_ID.to_string()),
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
    topology_fingerprint: &'a str,
    active_node_mask: &'a [bool],
}

fn active_support_fingerprint(
    topology_fingerprint: &str,
    active_node_mask: &[bool],
) -> Result<String, FemP1MagnetizationFieldError> {
    let preimage = ActiveSupportPreimage {
        format: ACTIVE_SUPPORT_PREIMAGE_FORMAT,
        topology_fingerprint,
        active_node_mask,
    };
    digest_json(&preimage)
}

#[derive(Serialize)]
struct LayoutPreimage<'a> {
    format: &'static str,
    topology_fingerprint: &'a str,
    node_count: u64,
    active_support_fingerprint: &'a str,
    function_space_id: &'a str,
    function_space_family: &'static str,
    function_space_order: u32,
    vector_dimension: u32,
    ordering: &'static str,
    basis_id: &'a str,
    carrier_id: &'a str,
    node_axis_length: u64,
    component_axis_length: u64,
}

fn layout_digest(
    topology_fingerprint: &str,
    node_count: u64,
    support_fingerprint: &str,
    space_id: &str,
    basis_id: &str,
    carrier_id: &str,
) -> Result<String, FemP1MagnetizationFieldError> {
    let preimage = LayoutPreimage {
        format: LAYOUT_PREIMAGE_FORMAT,
        topology_fingerprint,
        node_count,
        active_support_fingerprint: support_fingerprint,
        function_space_id: space_id,
        function_space_family: FUNCTION_SPACE_FAMILY,
        function_space_order: FUNCTION_SPACE_ORDER,
        vector_dimension: VECTOR_DIMENSION,
        ordering: "by_node",
        basis_id,
        carrier_id,
        node_axis_length: node_count,
        component_axis_length: u64::from(VECTOR_DIMENSION),
    };
    digest_json(&preimage)
}

fn digest_json<T: Serialize>(value: &T) -> Result<String, FemP1MagnetizationFieldError> {
    let bytes = serde_json::to_vec(value).map_err(|error| {
        FemP1MagnetizationFieldError::new(format!("cannot serialize FEM field identity: {error}"))
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn descriptor_validation_error(error: DatasetContractError) -> FemP1MagnetizationFieldError {
    FemP1MagnetizationFieldError::new(format!(
        "invalid FEM H1/P1 magnetization descriptor: {error}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn topology(digit: char) -> String {
        std::iter::repeat(digit).take(64).collect()
    }

    fn valid_semantics() -> FemP1MagnetizationFieldSemantics {
        FemP1MagnetizationFieldSemantics::new(&topology('a'), 4, vec![true, false, true, true])
            .expect("valid FEM H1/P1 semantics")
    }

    #[test]
    fn builds_canonical_nodal_magnetization_descriptor() {
        let semantics = valid_semantics();
        semantics
            .validate(&topology('a'), 4)
            .expect("valid semantics validate");
        semantics
            .validate(&format!("sha256:{}", topology('a')), 4)
            .expect("canonical topology validates");
        assert_eq!(
            semantics.format,
            FEM_P1_MAGNETIZATION_FIELD_SEMANTICS_FORMAT
        );
        assert_eq!(semantics.producer_id, FEM_P1_MAGNETIZATION_PRODUCER_ID);
        assert_eq!(
            semantics.producer_version,
            FEM_P1_MAGNETIZATION_PRODUCER_VERSION
        );
        assert_eq!(semantics.descriptor.quantity_id, QuantityId::M);
        assert_eq!(semantics.descriptor.unit, "1");
        assert_eq!(semantics.descriptor.tensor_rank, 1);
        assert_eq!(semantics.descriptor.frame.kind, FieldFrameKind::Laboratory);
        assert_eq!(semantics.descriptor.frame.frame_id, FRAME_ID);
        assert_eq!(
            semantics.descriptor.sample_location,
            FieldSampleLocation::Node
        );
        assert_eq!(semantics.descriptor.axes[0].axis_id, NODE_AXIS_ID);
        assert_eq!(semantics.descriptor.axes[0].length, 4);
        assert_eq!(semantics.descriptor.axes[1].axis_id, COMPONENT_AXIS_ID);
        assert_eq!(semantics.descriptor.axes[1].length, 3);
        assert_eq!(
            semantics.descriptor.component_axis.as_deref(),
            Some(COMPONENT_AXIS_ID)
        );
        assert_eq!(
            semantics.descriptor.function_space.as_ref().unwrap().family,
            FUNCTION_SPACE_FAMILY
        );
        assert_eq!(
            semantics.descriptor.function_space.as_ref().unwrap().order,
            FUNCTION_SPACE_ORDER
        );
        assert_eq!(
            semantics
                .descriptor
                .function_space
                .as_ref()
                .unwrap()
                .vector_dimension,
            VECTOR_DIMENSION
        );
        assert_eq!(
            semantics
                .descriptor
                .function_space
                .as_ref()
                .unwrap()
                .ordering,
            FunctionSpaceOrdering::ByNode
        );
        assert!(semantics
            .descriptor
            .function_space
            .as_ref()
            .unwrap()
            .basis_id
            .contains(&topology('a')));
        assert!(semantics.descriptor.carrier_id.contains(&topology('a')));
        assert_eq!(semantics.descriptor.complex_encoding, ComplexEncoding::Real);
        assert_eq!(semantics.descriptor.harmonic_convention, None);
        assert_eq!(semantics.descriptor.normalization, FieldNormalization::None);
        assert_eq!(
            semantics.descriptor.value_representation,
            FieldValueRepresentation::PhysicalField
        );
        assert_eq!(
            semantics.descriptor.resolution,
            FieldResolution::Quantitative
        );
    }

    #[test]
    fn support_and_layout_identity_include_exact_mesh_support() {
        let first =
            FemP1MagnetizationFieldSemantics::new(&topology('a'), 4, vec![true, false, true, true])
                .expect("first semantics");
        let second =
            FemP1MagnetizationFieldSemantics::new(&topology('a'), 4, vec![true, true, false, true])
                .expect("second semantics");
        assert_ne!(
            first.descriptor.active_support.support_fingerprint,
            second.descriptor.active_support.support_fingerprint
        );
        assert_ne!(
            first.descriptor.layout_digest,
            second.descriptor.layout_digest
        );
    }

    #[test]
    fn rejects_topology_mask_axes_units_harmonic_order_and_ordering_mutations() {
        let mut semantics = valid_semantics();
        assert!(semantics.validate(&topology('b'), 4).is_err());

        semantics.active_node_mask[0] = false;
        assert!(semantics.validate(&topology('a'), 4).is_err());
        semantics.active_node_mask[0] = true;

        semantics.descriptor.axes[0].length = 3;
        assert!(semantics.validate(&topology('a'), 4).is_err());
        semantics.descriptor.axes[0].length = 4;

        semantics.descriptor.unit = "A/m".to_string();
        assert!(semantics.validate(&topology('a'), 4).is_err());
        semantics.descriptor.unit = "1".to_string();

        semantics.descriptor.harmonic_convention = Some(HarmonicConvention::ExpPositiveIOmegaT);
        assert!(semantics.validate(&topology('a'), 4).is_err());
        semantics.descriptor.harmonic_convention = None;

        semantics
            .descriptor
            .function_space
            .as_mut()
            .unwrap()
            .ordering = FunctionSpaceOrdering::ByComponent;
        assert!(semantics.validate(&topology('a'), 4).is_err());
        semantics
            .descriptor
            .function_space
            .as_mut()
            .unwrap()
            .ordering = FunctionSpaceOrdering::ByNode;

        semantics.descriptor.function_space.as_mut().unwrap().order = 2;
        assert!(semantics.validate(&topology('a'), 4).is_err());
    }

    #[test]
    fn rejects_invalid_topology_and_support_shape() {
        assert!(FemP1MagnetizationFieldSemantics::new("not-a-digest", 4, vec![true; 4]).is_err());
        assert!(FemP1MagnetizationFieldSemantics::new(&topology('a'), 0, Vec::new()).is_err());
        assert!(FemP1MagnetizationFieldSemantics::new(&topology('a'), 4, vec![true; 3]).is_err());
        assert!(FemP1MagnetizationFieldSemantics::new(&topology('a'), 4, vec![false; 4]).is_err());
        assert!(FemP1MagnetizationFieldSemantics::new(
            &format!("sha256:{}", topology('A')),
            4,
            vec![true; 4]
        )
        .is_err());
    }

    #[test]
    fn serde_rejects_unknown_envelope_fields() {
        let semantics = valid_semantics();
        let mut value = serde_json::to_value(&semantics).expect("serialize semantics");
        value
            .as_object_mut()
            .expect("object envelope")
            .insert("unexpected".to_string(), Value::Bool(true));
        assert!(serde_json::from_value::<FemP1MagnetizationFieldSemantics>(value).is_err());
    }
}
