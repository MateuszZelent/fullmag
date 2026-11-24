//! Shape, bounds and byte integrity only. Accepted source and physical evidence require runtime validation.
use super::*;
use crate::AntennaSampleCarrier;
use fullmag_ir::{
    AntennaFieldSolveStageIR, AntennaOerstedRealizationIR, AntennaSurfaceFieldPolicyIR,
    BackendTarget, ExecutionDevice, ExecutionMode, ExecutionPrecision, FieldTargetIR,
    RequestedTransportExecutionIR,
};
use std::collections::BTreeMap;

pub const RETAINED_CURRENT_FIELD_CODEC_ID: &str = "fullmag.antenna.retained_current_field_bundle";
pub const RETAINED_CURRENT_FIELD_CODEC_VERSION: &str = "v1";
pub const RETAINED_CURRENT_FIELD_SCHEMA: &str = "antenna_retained_current_field_solution.v1";
pub const RETAINED_CURRENT_EVIDENCE_SCHEMA: &str = "fem_rt0_surface_evidence.v1";
pub const RETAINED_CURRENT_OPERATOR: &str =
    "fem_oersted_rt0_surface.mpfr128_160_rndn_etoff.inspection.v1";
pub const RETAINED_CURRENT_BASIS: &str = "fem_generic_affine_rt0.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetainedCurrentPayloadRef {
    pub sha256: String,
    pub byte_count: u64,
    pub layout: String,
    pub unit: String,
}
impl RetainedCurrentPayloadRef {
    fn validate(&self, layout: &str, unit: &str, length: Option<u64>) -> Result<(), ArtifactError> {
        require(
            bare_digest(&self.sha256)
                && self.byte_count > 0
                && self.byte_count <= MAX_PACKAGE_BYTES
                && self.layout == layout
                && self.unit == unit
                && length.is_none_or(|n| n == self.byte_count),
            "payload metadata differs from its required kind, count or byte budget",
        )
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetainedCurrentPayloads {
    pub sample_xyz: RetainedCurrentPayloadRef,
    pub sample_cells: RetainedCurrentPayloadRef,
    pub h_raw: RetainedCurrentPayloadRef,
    pub evidence: RetainedCurrentPayloadRef,
}
impl RetainedCurrentPayloads {
    pub fn entries(&self) -> [(&'static str, &RetainedCurrentPayloadRef); 4] {
        [
            ("sample_xyz", &self.sample_xyz),
            ("sample_cells", &self.sample_cells),
            ("h_raw", &self.h_raw),
            ("evidence", &self.evidence),
        ]
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetainedCurrentResolvedExecution {
    pub requested_execution: RequestedTransportExecutionIR,
    pub execution: RequestedTransportExecutionIR,
    pub operator_version: String,
    pub basis_version: String,
    pub evidence_schema: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetainedCurrentFieldManifest {
    pub schema_version: String,
    pub status: String,
    pub qualification: String,
    pub content_digest: String,
    pub stage_id: String,
    pub output_id: String,
    pub port_mode_id: String,
    pub source_object_id: String,
    pub current_transport_id: String,
    pub parent: RetainedCurrentParent,
    pub sample_carrier: AntennaSampleCarrier,
    pub source_vertex_count: u64,
    pub source_cell_count: u64,
    pub target_count: u64,
    pub sample_cell_count: u64,
    pub requested_intent: AntennaFieldSolveStageIR,
    pub resolved_execution: RetainedCurrentResolvedExecution,
    pub field_policy: AntennaSurfaceFieldPolicyIR,
    pub payloads: RetainedCurrentPayloads,
}
fn execution_is_supported(e: &RequestedTransportExecutionIR) -> bool {
    e.discretization == BackendTarget::Fem
        && e.device == ExecutionDevice::Cpu
        && e.precision == ExecutionPrecision::Double
        && e.execution_mode == ExecutionMode::Strict
}
fn bytes_for(count: u64, width: u64) -> Result<u64, ArtifactError> {
    count
        .checked_mul(width)
        .filter(|n| *n > 0 && *n <= MAX_PACKAGE_BYTES)
        .ok_or_else(|| ArtifactError {
            message: "retained current count/byte budget overflow".into(),
        })
}
impl RetainedCurrentFieldManifest {
    pub fn validate_metadata(&self) -> Result<(), ArtifactError> {
        require(
            self.schema_version == RETAINED_CURRENT_FIELD_SCHEMA
                && self.status == "inspection_only"
                && self.qualification == "not_verified",
            "unsupported manifest schema/status/qualification",
        )?;
        for value in [
            &self.stage_id,
            &self.output_id,
            &self.port_mode_id,
            &self.source_object_id,
            &self.current_transport_id,
        ] {
            require(id(value), "invalid child identifier")?;
        }
        self.parent.validate_metadata()?;
        let intent = &self.requested_intent;
        let retained = intent
            .retained_current_source
            .as_ref()
            .ok_or_else(|| ArtifactError {
                message: "retained current source absent".into(),
            })?;
        require(
            retained
                .validation_errors("retained_current_source")
                .is_empty()
                && self.parent.owner.matches_source(retained),
            "authored retained source differs from parent pins",
        )?;
        require(
            intent.conservative_current_view_ref.is_none()
                && intent.oersted_realization == AntennaOerstedRealizationIR::AnalyticRt0Surface
                && intent.surface_field_policy.as_ref() == Some(&self.field_policy),
            "retained field requires explicit surface policy without legacy view",
        )?;
        require(
            intent.id == self.stage_id
                && intent.source_object_id == self.source_object_id
                && intent.current_transport_id == self.current_transport_id
                && intent.port_mode_ids == [self.port_mode_id.clone()]
                && intent.outputs.len() == 1
                && intent.outputs[0].id == self.output_id
                && intent.outputs[0].quantity == "H_ant_basis",
            "child stage/source/module/port/output mismatch",
        )?;
        require(
            self.sample_carrier.domain == intent.field_sampling_domain
                && self.sample_carrier.location == "node"
                && digest(&self.sample_carrier.topology_digest),
            "sampling domain/location/digest mismatch",
        )?;
        match &self.sample_carrier.domain {
            FieldTargetIR::Global {} => require(
                self.sample_carrier.carrier_kind == "fem_domain_mesh_asset",
                "Global carrier kind mismatch",
            )?,
            FieldTargetIR::Object { object_id } => require(
                id(object_id)
                    && self
                        .sample_carrier
                        .carrier_kind
                        .strip_prefix("fem_mesh_asset:")
                        .is_some_and(id),
                "Object carrier kind mismatch",
            )?,
            FieldTargetIR::Region { .. } => {
                return require(false, "region retained field sampling is unsupported");
            }
        }
        require(
            self.field_policy
                .validation_errors("field_policy")
                .is_empty(),
            "invalid surface field policy",
        )?;
        let e = &self.resolved_execution;
        require(
            execution_is_supported(&e.requested_execution)
                && execution_is_supported(&e.execution)
                && e.operator_version == RETAINED_CURRENT_OPERATOR
                && e.basis_version == RETAINED_CURRENT_BASIS
                && e.evidence_schema == RETAINED_CURRENT_EVIDENCE_SCHEMA,
            "unsupported retained field execution/encoding",
        )?;
        require(
            self.source_cell_count > 0
                && self.source_vertex_count >= 4
                && self
                    .source_cell_count
                    .checked_mul(4)
                    .is_some_and(|n| self.source_vertex_count <= n)
                && self.target_count >= 4
                && self.sample_cell_count > 0,
            "invalid source or sampling counts",
        )?;
        require(
            self.source_cell_count
                .checked_mul(self.target_count)
                .is_some_and(|pairs| pairs <= self.field_policy.limits.total[0])
                && self.source_cell_count <= self.field_policy.limits.per_target[0],
            "source/target pair budget exceeded",
        )?;
        require(
            self.target_count <= u32::MAX as u64,
            "sampling index capacity exceeded",
        )?;
        let xyz = bytes_for(self.target_count, 24)?;
        self.payloads
            .sample_xyz
            .validate("sample_xyz_f64_le", "m", Some(xyz))?;
        self.payloads
            .h_raw
            .validate("sample_xyz_f64_le", "A/m", Some(xyz))?;
        self.payloads.sample_cells.validate(
            "tet4_u32_le",
            "1",
            Some(bytes_for(self.sample_cell_count, 16)?),
        )?;
        self.payloads
            .evidence
            .validate(RETAINED_CURRENT_EVIDENCE_SCHEMA, "1", None)?;
        let total = self
            .payloads
            .entries()
            .iter()
            .try_fold(0_u64, |n, (_, p)| n.checked_add(p.byte_count))
            .ok_or_else(|| ArtifactError {
                message: "retained payload aggregate overflow".into(),
            })?;
        require(
            total <= MAX_PACKAGE_BYTES,
            "retained payload aggregate exceeds package budget",
        )?;
        require(
            digest(&self.content_digest)
                && self.content_digest == self.expected_content_digest()?,
            "retained field content digest mismatch",
        )
    }

    /// Domain-separated sorted JSON over semantic pins and exact ordered-payload hashes.
    /// The external package CAS and this digest itself are deliberately excluded.
    pub fn expected_content_digest(&self) -> Result<String, ArtifactError> {
        metadata_bound(self)?;
        let mut value = serde_json::to_value(self).map_err(|e| ArtifactError {
            message: e.to_string(),
        })?;
        value
            .as_object_mut()
            .expect("manifest is a struct")
            .remove("content_digest");
        fn ordered(value: serde_json::Value) -> serde_json::Value {
            match value {
                serde_json::Value::Object(values) => serde_json::Value::Object(
                    values
                        .into_iter()
                        .collect::<BTreeMap<_, _>>()
                        .into_iter()
                        .map(|(k, v)| (k, ordered(v)))
                        .collect(),
                ),
                serde_json::Value::Array(values) => {
                    serde_json::Value::Array(values.into_iter().map(ordered).collect())
                }
                other => other,
            }
        }
        let bytes = serde_json::to_vec(&ordered(value)).map_err(|e| ArtifactError {
            message: e.to_string(),
        })?;
        require(
            bytes.len() as u64 <= MAX_METADATA_BYTES,
            "signature metadata budget",
        )?;
        let mut hash = Sha256::new();
        hash.update(b"fullmag.antenna.retained_current_field.signature.v1\0");
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
        Ok(format!("sha256:{:x}", hash.finalize()))
    }
    pub fn metadata_dependencies(&self) -> Result<Vec<RetainedCurrentDependency>, ArtifactError> {
        self.validate_metadata()?;
        Ok(vec![
            RetainedCurrentDependency {
                role: RetainedCurrentDependencyRole::ParentPackage,
                object: self.parent.owner.package.clone(),
            },
            RetainedCurrentDependency {
                role: RetainedCurrentDependencyRole::ParentOutputManifest,
                object: self.parent.owner.output_manifest.clone(),
            },
            RetainedCurrentDependency {
                role: RetainedCurrentDependencyRole::ParentEvidenceCapsule,
                object: self.parent.evidence_capsule.clone(),
            },
        ])
    }
}
pub fn parse_retained_current_manifest(
    bytes: &[u8],
) -> Result<RetainedCurrentFieldManifest, ArtifactError> {
    let manifest: RetainedCurrentFieldManifest = parse(bytes)?;
    manifest.validate_metadata()?;
    Ok(manifest)
}

/// Validate only the four explicit embedded payloads; never discovers or executes a parent.
/// Source consistency, carrier topology digest and numerical evidence verification remain mandatory upstream.
pub fn validate_payloads(
    manifest: &RetainedCurrentFieldManifest,
    payloads: &BTreeMap<String, Vec<u8>>,
) -> Result<(), ArtifactError> {
    manifest.validate_metadata()?;
    require(
        payloads.len() == 4,
        "retained payload closure must contain exactly four entries",
    )?;
    for (key, expected) in manifest.payloads.entries() {
        let bytes = payloads.get(key).ok_or_else(|| ArtifactError {
            message: format!("missing retained payload {key}"),
        })?;
        require(
            bytes.len() as u64 == expected.byte_count && sha256(bytes) == expected.sha256,
            "retained payload length/hash mismatch",
        )?;
        if matches!(key, "sample_xyz" | "h_raw") {
            require(
                bytes
                    .chunks_exact(8)
                    .all(|b| f64::from_le_bytes(b.try_into().expect("eight bytes")).is_finite()),
                "nonfinite retained xyz/field",
            )?;
        }
    }
    for row in payloads["sample_cells"].chunks_exact(16) {
        let ids: [u32; 4] = std::array::from_fn(|i| {
            u32::from_le_bytes(row[4 * i..4 * i + 4].try_into().expect("four bytes"))
        });
        require(
            ids.iter().all(|id| u64::from(*id) < manifest.target_count)
                && (0..4).all(|i| (i + 1..4).all(|j| ids[i] != ids[j])),
            "invalid retained Tet4 connectivity",
        )?;
    }
    Ok(())
}
