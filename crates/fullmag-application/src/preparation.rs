//! Application acceptance boundary for a prepared geometry/grid/mesh/space.
//!
//! The planner owns the producer contracts; this module owns the rule that a
//! preparation receipt must bind one exact plan to one complete set of
//! validated certificates before an application or runner can publish it.
//! It does not start a solver and does not infer execution from a receipt.

use crate::run_spec::{RunId, RunSpecification};
use fullmag_plan::{
    PreparationCertificate, PreparationMaterialization, PreparationPlan, PreparationPlanError,
    PreparationPlanSource, PreparationProducerKind, PreparationReuseDecision,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const PREPARATION_RECEIPT_SCHEMA: &str = "preparation_receipt.v1";
pub const PREPARATION_BINDING_SCHEMA: &str = "preparation_binding.v1";
pub const ACCEPTED_RUN_PREPARATION_SOURCE_SCHEMA: &str = "accepted_run_preparation_source.v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreparationReceiptError {
    Contract(String),
    Certificate(PreparationPlanError),
}

impl std::fmt::Display for PreparationReceiptError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Contract(message) => formatter.write_str(message),
            Self::Certificate(error) => write!(formatter, "preparation certificate: {error}"),
        }
    }
}

impl std::error::Error for PreparationReceiptError {}

impl From<PreparationPlanError> for PreparationReceiptError {
    fn from(error: PreparationPlanError) -> Self {
        Self::Certificate(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreparationMaterializationError {
    Contract(String),
    Planning(String),
    Preparation(PreparationPlanError),
    Receipt(PreparationReceiptError),
}

impl std::fmt::Display for PreparationMaterializationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Contract(message) => formatter.write_str(message),
            Self::Planning(message) => write!(formatter, "execution planning: {message}"),
            Self::Preparation(error) => write!(formatter, "preparation materialization: {error}"),
            Self::Receipt(error) => write!(formatter, "preparation receipt: {error}"),
        }
    }
}

impl std::error::Error for PreparationMaterializationError {}

impl From<PreparationPlanError> for PreparationMaterializationError {
    fn from(error: PreparationPlanError) -> Self {
        Self::Preparation(error)
    }
}

impl From<PreparationReceiptError> for PreparationMaterializationError {
    fn from(error: PreparationReceiptError) -> Self {
        Self::Receipt(error)
    }
}

/// Durable application-level proof that every preparation producer was
/// validated against the same immutable plan.  The record is still separate
/// from solver execution evidence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PreparationReceipt {
    pub schema_version: String,
    pub preparation_id: String,
    pub plan_fingerprint: String,
    pub plan: PreparationPlan,
    pub certificates: Vec<PreparationCertificate>,
    #[serde(default)]
    pub reuse: Vec<PreparationReuseDecision>,
    /// Identity binding for an accepted run step. Callers must set this only
    /// after resolving the exact immutable RunSpec, step, and ProblemIR.
    /// This is a structural consistency check, not a cryptographic signature.
    /// Live preparation remains unbound and cannot enter durable task input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_run_source: Option<AcceptedRunPreparationSource>,
}

/// Immutable source identity for using a preparation receipt in one accepted
/// study step. The ProblemIR digest is repeated so validation detects a receipt
/// rebound to another step or ProblemIR. This record is not a signature.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedRunPreparationSource {
    pub schema_version: String,
    pub run_id: RunId,
    /// Prefixed SHA-256 of the full accepted RunSpecification.
    pub specification_fingerprint: String,
    pub step_id: String,
    pub problem_fingerprint: String,
}

impl AcceptedRunPreparationSource {
    pub fn for_study_step(
        specification: &RunSpecification,
        step_id: impl Into<String>,
        problem_fingerprint: impl Into<String>,
    ) -> Result<Self, PreparationReceiptError> {
        let specification_fingerprint = specification.fingerprint().map_err(|error| {
            PreparationReceiptError::Contract(format!(
                "accepted run specification is invalid: {error}"
            ))
        })?;
        let source = Self {
            schema_version: ACCEPTED_RUN_PREPARATION_SOURCE_SCHEMA.into(),
            run_id: specification.run_id.clone(),
            specification_fingerprint: format!("sha256:{specification_fingerprint}"),
            step_id: step_id.into(),
            problem_fingerprint: problem_fingerprint.into(),
        };
        source.validate()?;
        Ok(source)
    }

    pub fn validate(&self) -> Result<(), PreparationReceiptError> {
        if self.schema_version != ACCEPTED_RUN_PREPARATION_SOURCE_SCHEMA {
            return Err(PreparationReceiptError::Contract(format!(
                "schema_version must be {ACCEPTED_RUN_PREPARATION_SOURCE_SCHEMA}"
            )));
        }
        if !is_identifier(self.run_id.as_str()) || !is_study_step_identifier(&self.step_id) {
            return Err(PreparationReceiptError::Contract(
                "accepted preparation run_id and step_id must be identifiers".into(),
            ));
        }
        if !is_sha256_fingerprint(&self.specification_fingerprint)
            || !is_sha256_fingerprint(&self.problem_fingerprint)
        {
            return Err(PreparationReceiptError::Contract(
                "accepted preparation source fingerprints must use sha256:<64 lowercase hex characters>"
                    .into(),
            ));
        }
        Ok(())
    }
}

impl PreparationReceipt {
    pub fn ready(
        preparation_id: impl Into<String>,
        plan: PreparationPlan,
        certificates: Vec<PreparationCertificate>,
        reuse: Vec<PreparationReuseDecision>,
    ) -> Result<Self, PreparationReceiptError> {
        Self::ready_with_source(preparation_id, plan, certificates, reuse, None)
    }

    pub fn ready_for_accepted_run(
        preparation_id: impl Into<String>,
        plan: PreparationPlan,
        certificates: Vec<PreparationCertificate>,
        reuse: Vec<PreparationReuseDecision>,
        specification: &RunSpecification,
        step_id: impl Into<String>,
    ) -> Result<Self, PreparationReceiptError> {
        let source = AcceptedRunPreparationSource::for_study_step(
            specification,
            step_id,
            plan.problem_fingerprint.clone(),
        )?;
        Self::ready_with_source(preparation_id, plan, certificates, reuse, Some(source))
    }

    fn ready_with_source(
        preparation_id: impl Into<String>,
        plan: PreparationPlan,
        certificates: Vec<PreparationCertificate>,
        reuse: Vec<PreparationReuseDecision>,
        accepted_run_source: Option<AcceptedRunPreparationSource>,
    ) -> Result<Self, PreparationReceiptError> {
        let receipt = Self {
            schema_version: PREPARATION_RECEIPT_SCHEMA.into(),
            preparation_id: preparation_id.into(),
            plan_fingerprint: plan.canonical_sha256()?,
            plan,
            certificates,
            reuse,
            accepted_run_source,
        };
        receipt.validate()?;
        Ok(receipt)
    }

    pub fn validate(&self) -> Result<(), PreparationReceiptError> {
        if self.schema_version != PREPARATION_RECEIPT_SCHEMA {
            return Err(PreparationReceiptError::Contract(format!(
                "schema_version must be {PREPARATION_RECEIPT_SCHEMA}"
            )));
        }
        if !is_identifier(&self.preparation_id) {
            return Err(PreparationReceiptError::Contract(
                "preparation_id must be a non-empty identifier without separators".into(),
            ));
        }
        self.plan.validate()?;
        let expected_fingerprint = self.plan.canonical_sha256()?;
        if self.plan_fingerprint != expected_fingerprint {
            return Err(PreparationReceiptError::Contract(
                "plan_fingerprint does not match the embedded preparation plan".into(),
            ));
        }
        if let Some(source) = &self.accepted_run_source {
            source.validate()?;
            if source.problem_fingerprint != self.plan.problem_fingerprint {
                return Err(PreparationReceiptError::Contract(
                    "accepted run preparation source does not match the plan ProblemIR".into(),
                ));
            }
        }
        match (&self.plan.source, &self.accepted_run_source) {
            (None, None) => {}
            (
                Some(PreparationPlanSource::AcceptedRunStep {
                    run_id,
                    specification_fingerprint,
                    step_id,
                }),
                Some(receipt_source),
            ) if run_id.as_str() == receipt_source.run_id.as_str()
                && specification_fingerprint == &receipt_source.specification_fingerprint
                && step_id.as_str() == receipt_source.step_id.as_str() => {}
            (None, Some(_)) if self.plan.scene_revision.is_some() => {}
            (None, Some(_)) => {
                return Err(PreparationReceiptError::Contract(
                    "accepted run preparation receipt requires a v2 accepted-run plan source or a legacy bound Live v1 receipt".into(),
                ));
            }
            (Some(_), None) => {
                return Err(PreparationReceiptError::Contract(
                    "accepted-run preparation plan requires an accepted_run_source receipt binding"
                        .into(),
                ));
            }
            (Some(_), Some(_)) => {
                return Err(PreparationReceiptError::Contract(
                    "preparation plan source differs from accepted_run_source receipt binding"
                        .into(),
                ));
            }
        }
        let mut seen = std::collections::BTreeSet::new();
        for certificate in &self.certificates {
            certificate.validate_for(&self.plan)?;
            if !seen.insert(certificate.producer.kind) {
                return Err(PreparationReceiptError::Contract(format!(
                    "duplicate {} preparation certificate",
                    certificate.producer.kind.as_str()
                )));
            }
        }
        for kind in PreparationProducerKind::ALL {
            if !seen.contains(&kind) {
                return Err(PreparationReceiptError::Contract(format!(
                    "preparation receipt is missing the {} certificate",
                    kind.as_str()
                )));
            }
        }
        Ok(())
    }

    /// Record the accepted source identities on a validated receipt.
    /// Callers must first resolve the RunSpec, step, and ProblemIR from the
    /// accepted snapshot; this method checks identities but does not attest
    /// where its input values came from. Rebinding to another source is rejected.
    pub fn bind_to_accepted_run(
        mut self,
        specification: &RunSpecification,
        step_id: impl Into<String>,
    ) -> Result<Self, PreparationReceiptError> {
        self.validate()?;
        let source = AcceptedRunPreparationSource::for_study_step(
            specification,
            step_id,
            self.plan.problem_fingerprint.clone(),
        )?;
        let specification_fingerprint = source.specification_fingerprint.clone();
        let expected_plan_source = PreparationPlanSource::accepted_run_step(
            source.run_id.as_str(),
            specification_fingerprint,
            source.step_id.as_str(),
        )
        .map_err(|error| PreparationReceiptError::Contract(error.to_string()))?;
        match self.plan.source.as_ref() {
            Some(plan_source) if plan_source == &expected_plan_source => {}
            Some(_) => {
                return Err(PreparationReceiptError::Contract(
                    "preparation plan is sourced from another accepted run step".into(),
                ));
            }
            None if self.plan.scene_revision.is_some()
                && self.accepted_run_source.as_ref() == Some(&source) => {}
            None => {
                return Err(PreparationReceiptError::Contract(
                    "an unbound Live v1 preparation plan cannot be rebound into an accepted run"
                        .into(),
                ));
            }
        }
        if self
            .accepted_run_source
            .as_ref()
            .is_some_and(|existing| existing != &source)
        {
            return Err(PreparationReceiptError::Contract(
                "preparation receipt is already bound to another accepted run step".into(),
            ));
        }
        self.accepted_run_source = Some(source);
        self.validate()?;
        Ok(self)
    }
}

/// A compact reference carried across the execution boundary after a receipt
/// has been accepted.  The worker receives the identity and immutable hashes,
/// while the full receipt remains in the durable run catalog.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PreparationBinding {
    pub schema_version: String,
    pub preparation_id: String,
    pub plan_fingerprint: String,
    pub receipt_sha256: String,
}

impl PreparationBinding {
    /// Create the execution reference only from a validated receipt.
    pub fn from_receipt(receipt: &PreparationReceipt) -> Result<Self, PreparationReceiptError> {
        receipt.validate()?;
        let payload = serde_json::to_value(receipt).map_err(|error| {
            PreparationReceiptError::Contract(format!(
                "preparation receipt fingerprint serialization failed: {error}"
            ))
        })?;
        let canonical = canonicalize_json(payload);
        let bytes = serde_json::to_vec(&canonical).map_err(|error| {
            PreparationReceiptError::Contract(format!(
                "preparation receipt fingerprint encoding failed: {error}"
            ))
        })?;
        Self::new(
            receipt.preparation_id.clone(),
            receipt.plan_fingerprint.clone(),
            format!("sha256:{:x}", Sha256::digest(bytes)),
        )
    }

    /// Decode/construct a durable reference after its source receipt was
    /// validated by the owning store or application adapter.
    pub(crate) fn new(
        preparation_id: impl Into<String>,
        plan_fingerprint: impl Into<String>,
        receipt_sha256: impl Into<String>,
    ) -> Result<Self, PreparationReceiptError> {
        let binding = Self {
            schema_version: PREPARATION_BINDING_SCHEMA.into(),
            preparation_id: preparation_id.into(),
            plan_fingerprint: plan_fingerprint.into(),
            receipt_sha256: receipt_sha256.into(),
        };
        binding.validate()?;
        Ok(binding)
    }

    pub fn validate(&self) -> Result<(), PreparationReceiptError> {
        if self.schema_version != PREPARATION_BINDING_SCHEMA {
            return Err(PreparationReceiptError::Contract(format!(
                "schema_version must be {PREPARATION_BINDING_SCHEMA}"
            )));
        }
        if !is_identifier(&self.preparation_id) {
            return Err(PreparationReceiptError::Contract(
                "preparation_id must be a non-empty identifier without separators".into(),
            ));
        }
        if !is_sha256_fingerprint(&self.plan_fingerprint)
            || !is_sha256_fingerprint(&self.receipt_sha256)
        {
            return Err(PreparationReceiptError::Contract(
                "preparation binding fingerprints must use sha256:<64 lowercase hex characters>"
                    .into(),
            ));
        }
        Ok(())
    }
}

/// Materialize and accept the FDM preparation boundary from one immutable
/// ProblemIR snapshot. The display projection is supplied separately so
/// visual changes have their own producer identity. This performs planning and
/// certificate construction only; it does not start a solver or claim
/// managed, browser or physics qualification.
pub fn materialize_fdm_preparation_from_problem(
    preparation_id: impl Into<String>,
    scene_revision: u64,
    problem: &fullmag_ir::ProblemIR,
    display_projection: &Value,
) -> Result<PreparationReceipt, PreparationMaterializationError> {
    if !display_projection.is_object() {
        return Err(PreparationMaterializationError::Contract(
            "display projection must be a JSON object".into(),
        ));
    }
    if scene_revision == 0 {
        return Err(PreparationMaterializationError::Contract(
            "scene_revision must be greater than zero".into(),
        ));
    }

    let execution_plan = fullmag_plan::plan(problem)
        .map_err(|error| PreparationMaterializationError::Planning(error.to_string()))?;
    let problem_fingerprint = fingerprint_json(problem)?;
    let geometry_projection = serde_json::json!({
        "schema_version": "geometry_projection.v1",
        "geometry": &problem.geometry,
        "geometry_assets": &problem.geometry_assets,
        "regions": &problem.regions,
        "object_regions": &problem.object_regions,
        "mesh_semantics": &problem.mesh_semantics,
    });
    let display_projection = serde_json::json!({
        "schema_version": "display_projection.v1",
        "payload": display_projection,
    });
    let materialization = PreparationMaterialization::from_fdm_execution_plan(
        problem_fingerprint,
        scene_revision,
        problem.backend_policy.requested_backend,
        &execution_plan,
        fingerprint_json(&geometry_projection)?,
        fingerprint_json(&display_projection)?,
    )?;
    PreparationReceipt::ready(
        preparation_id,
        materialization.plan,
        materialization.certificates,
        Vec::new(),
    )
    .map_err(PreparationMaterializationError::from)
}

/// Materialize a FEM preparation receipt from one immutable ProblemIR and
/// native evidence that MFEM built its mesh and H1 function space.
pub fn materialize_fem_preparation_from_problem(
    preparation_id: impl Into<String>,
    scene_revision: u64,
    problem: &fullmag_ir::ProblemIR,
    display_projection: &Value,
    native: &fullmag_plan::NativeFemMeshSpaceEvidence,
) -> Result<PreparationReceipt, PreparationMaterializationError> {
    if !display_projection.is_object() {
        return Err(PreparationMaterializationError::Contract(
            "display projection must be a JSON object".into(),
        ));
    }
    if scene_revision == 0 {
        return Err(PreparationMaterializationError::Contract(
            "scene_revision must be greater than zero".into(),
        ));
    }

    let execution_plan = fullmag_plan::plan(problem)
        .map_err(|error| PreparationMaterializationError::Planning(error.to_string()))?;
    let problem_fingerprint = fingerprint_json(problem)?;
    let geometry_projection = serde_json::json!({
        "schema_version": "geometry_projection.v1",
        "geometry": &problem.geometry,
        "geometry_assets": &problem.geometry_assets,
        "regions": &problem.regions,
        "object_regions": &problem.object_regions,
        "mesh_semantics": &problem.mesh_semantics,
    });
    let display_projection = serde_json::json!({
        "schema_version": "display_projection.v1",
        "payload": display_projection,
    });
    let materialization = PreparationMaterialization::from_fem_execution_plan(
        problem_fingerprint,
        scene_revision,
        problem.backend_policy.requested_backend,
        &execution_plan,
        fingerprint_json(&geometry_projection)?,
        fingerprint_json(&display_projection)?,
        native,
    )?;
    PreparationReceipt::ready(
        preparation_id,
        materialization.plan,
        materialization.certificates,
        Vec::new(),
    )
    .map_err(PreparationMaterializationError::from)
}

pub(crate) fn fingerprint_json<T: Serialize>(
    value: &T,
) -> Result<String, PreparationMaterializationError> {
    let value = serde_json::to_value(value).map_err(|error| {
        PreparationMaterializationError::Contract(format!(
            "preparation fingerprint serialization failed: {error}"
        ))
    })?;
    let canonical = canonicalize_json(value);
    let bytes = serde_json::to_vec(&canonical).map_err(|error| {
        PreparationMaterializationError::Contract(format!(
            "preparation fingerprint encoding failed: {error}"
        ))
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn canonicalize_json(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize_json).collect()),
        Value::Object(values) => {
            let mut keys = values.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let mut canonical = Map::new();
            for key in keys {
                let child = values
                    .get(&key)
                    .cloned()
                    .expect("key collected from the same JSON object");
                canonical.insert(key, canonicalize_json(child));
            }
            Value::Object(canonical)
        }
        other => other,
    }
}

fn is_identifier(value: &str) -> bool {
    !value.trim().is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn is_study_step_identifier(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 256
        && !value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
}

fn is_sha256_fingerprint(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::BackendTarget;
    use fullmag_plan::{
        PreparationMarkerCertificate, PreparationProducer, PreparationQualityCertificate,
        PreparationSpaceCertificate,
    };

    fn fingerprint(hex: char) -> String {
        format!("sha256:{}", hex.to_string().repeat(64))
    }

    fn fem_problem_with_mesh_asset() -> fullmag_ir::ProblemIR {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = BackendTarget::Fem;
        problem.air_box_policy = Some(fullmag_ir::AirBoxPolicyIR {
            boundary_marker: Some(99),
            ..Default::default()
        });
        problem.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fdm_grid_assets: Vec::new(),
            fem_mesh_assets: Vec::new(),
            fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
                mesh_source: None,
                mesh: Some(fullmag_ir::MeshIR {
                    mesh_name: "preparation-strip".into(),
                    nodes: vec![
                        [0.0, 0.0, 0.0],
                        [1.0e-9, 0.0, 0.0],
                        [0.0, 1.0e-9, 0.0],
                        [0.0, 0.0, 1.0e-9],
                        [-2.0e-9, -2.0e-9, -2.0e-9],
                        [2.0e-9, -2.0e-9, -2.0e-9],
                        [-2.0e-9, 2.0e-9, -2.0e-9],
                        [-2.0e-9, -2.0e-9, 2.0e-9],
                    ],
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![
                        [0, 1, 2, 3],
                        [4, 5, 6, 7],
                    ]),
                    element_markers: vec![1, 0],
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
                        [0, 1, 2],
                        [4, 5, 6],
                    ]),
                    boundary_markers: vec![1, 99],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
                region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                    geometry_name: "strip".into(),
                    marker: 1,
                }],
                object_region_markers: Vec::new(),
                build_report: None,
            }),
        });
        problem.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
        if let fullmag_ir::StudyIR::TimeEvolution {
            dynamics: fullmag_ir::DynamicsIR::Llg { fixed_timestep, .. },
            ..
        } = &mut problem.study
        {
            *fixed_timestep = Some(1.0e-15);
        }
        problem
    }

    fn native_evidence_for_problem(
        problem: &fullmag_ir::ProblemIR,
    ) -> fullmag_plan::NativeFemMeshSpaceEvidence {
        let execution_plan =
            fullmag_plan::plan(problem).expect("test FEM problem should produce a FEM plan");
        let fullmag_ir::BackendPlanIR::Fem(fem) = execution_plan.backend_plan else {
            panic!("test problem should resolve to FEM");
        };
        let mesh = fem.mesh;
        fullmag_plan::NativeFemMeshSpaceEvidence {
            abi_version: fullmag_plan::preparation::NATIVE_FEM_MESH_SPACE_ABI_VERSION,
            producer_id: fullmag_plan::preparation::NATIVE_FEM_MESH_SPACE_PRODUCER_ID.into(),
            schema_version: fullmag_plan::preparation::NATIVE_FEM_MESH_SPACE_SCHEMA_VERSION.into(),
            producer_version: fullmag_plan::preparation::NATIVE_FEM_MESH_SPACE_PRODUCER_VERSION
                .into(),
            mesh_matches_canonical_input: true,
            canonical_mesh_fingerprint: mesh.topology_fingerprint_v6(),
            topology_fingerprint: fingerprint('8'),
            marker_map_fingerprint: fingerprint('9'),
            quality_fingerprint: fingerprint('a'),
            space_fingerprint: fingerprint('b'),
            mesh_dimension: 3,
            fe_family: "H1".into(),
            fe_order: fem.fe_order,
            node_count: mesh.nodes.len() as u64,
            cell_count: mesh.cells.len() as u64,
            boundary_element_count: mesh.facets.len() as u64,
            local_dof_count: mesh.nodes.len() as u64,
            true_dof_count: mesh.nodes.len() as u64,
            quality_sample_count: 4,
            invalid_cell_count: 0,
            min_jacobian_determinant: 1.0e-27,
            max_jacobian_determinant: 2.0e-27,
        }
    }

    fn producer(kind: PreparationProducerKind, output: char) -> PreparationProducer {
        PreparationProducer::new(
            kind,
            format!("fullmag.{}", kind.as_str()),
            format!("{}.producer.v1", kind.as_str()),
            "test",
            fingerprint('a'),
            fingerprint(output),
        )
        .unwrap()
    }

    fn plan() -> PreparationPlan {
        PreparationPlan::new(
            fingerprint('b'),
            1,
            BackendTarget::Auto,
            BackendTarget::Fdm,
            producer(PreparationProducerKind::Geometry, '1'),
            producer(PreparationProducerKind::Display, '2'),
            producer(PreparationProducerKind::Grid, '3'),
            producer(PreparationProducerKind::Mesh, '4'),
            producer(PreparationProducerKind::Space, '5'),
        )
        .unwrap()
    }

    fn certificates(plan: &PreparationPlan) -> Vec<PreparationCertificate> {
        let marker_map = fingerprint('c');
        vec![
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.geometry.clone(),
                quality: None,
                marker_map: None,
                cell_count: None,
                space: None,
            },
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.display.clone(),
                quality: None,
                marker_map: None,
                cell_count: None,
                space: None,
            },
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.grid.clone(),
                quality: None,
                marker_map: None,
                cell_count: Some(4),
                space: None,
            },
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.mesh.clone(),
                quality: Some(PreparationQualityCertificate {
                    cell_count: 4,
                    invalid_cell_count: 0,
                    min_quality: Some(0.2),
                    max_aspect_ratio: Some(3.0),
                    jacobian: None,
                    quality_fingerprint: fingerprint('d'),
                    mesh_source: None,
                }),
                marker_map: Some(PreparationMarkerCertificate {
                    marker_map_fingerprint: marker_map.clone(),
                    marker_ids: vec![1],
                }),
                cell_count: Some(4),
                space: None,
            },
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.space.clone(),
                quality: None,
                marker_map: Some(PreparationMarkerCertificate {
                    marker_map_fingerprint: marker_map.clone(),
                    marker_ids: vec![1],
                }),
                cell_count: None,
                space: Some(PreparationSpaceCertificate {
                    mesh_fingerprint: plan.mesh.output_fingerprint.clone(),
                    marker_map_fingerprint: Some(marker_map),
                    dof_count: 8,
                    space_fingerprint: plan.space.output_fingerprint.clone(),
                    fe_family: None,
                    fe_order: None,
                    local_dof_count: None,
                    true_dof_count: None,
                }),
            },
        ]
    }

    #[test]
    fn receipt_requires_all_certificates_bound_to_one_plan() {
        let plan = plan();
        let receipt =
            PreparationReceipt::ready("prep-1", plan.clone(), certificates(&plan), vec![]).unwrap();
        receipt.validate().unwrap();

        let mut incomplete = receipt;
        incomplete.certificates.pop();
        let error = incomplete.validate().unwrap_err();
        assert!(error.to_string().contains("missing the space certificate"));
    }

    #[test]
    fn receipt_rejects_plan_digest_or_certificate_rebinding() {
        let plan = plan();
        let mut receipt =
            PreparationReceipt::ready("prep-1", plan.clone(), certificates(&plan), vec![]).unwrap();
        receipt.plan.scene_revision = Some(2);
        assert!(receipt.validate().is_err());

        let mut certificates = certificates(&plan);
        certificates[2].cell_count = Some(0);
        let error = PreparationReceipt::ready("prep-1", plan, certificates, vec![]).unwrap_err();
        assert!(error.to_string().contains("cell_count"));
    }

    #[test]
    fn preparation_projection_fingerprints_are_independent_of_json_key_order() {
        let first = serde_json::json!({
            "geometry": {"z": 3, "a": [true, {"b": 2, "a": 1}]},
            "display": {"color": "viridis"}
        });
        let second = serde_json::json!({
            "display": {"color": "viridis"},
            "geometry": {"a": [true, {"a": 1, "b": 2}], "z": 3}
        });
        assert_eq!(
            fingerprint_json(&first).unwrap(),
            fingerprint_json(&second).unwrap()
        );
    }

    #[test]
    fn fdm_materialization_binds_one_problem_and_display_projection() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.object_regions.push(fullmag_ir::ObjectRegionIR {
            region_id: "strip:core".into(),
            owner_object: "strip".into(),
            name: "core".into(),
            shape: fullmag_ir::RegionShapeIR::Box {
                size: [200e-9, 20e-9, 6e-9],
                center: [0.0, 0.0, 0.0],
            },
            frame: fullmag_ir::RegionFrameIR::Object,
            enabled: true,
            priority: 1,
            mesh_policy: None,
            material_overrides: Vec::new(),
            texture_override: None,
            material_transition: None,
            realization_policy: fullmag_ir::RegionRealizationPolicyIR::Inherit,
        });
        let receipt = materialize_fdm_preparation_from_problem(
            "prep-materialized",
            7,
            &problem,
            &serde_json::json!({
                "selected_object_ids": ["strip"],
                "camera": {"position": [1.0, 2.0, 3.0]}
            }),
        )
        .expect("bootstrap FDM problem should materialize preparation");

        receipt.validate().unwrap();
        assert_eq!(receipt.preparation_id, "prep-materialized");
        assert_eq!(receipt.plan.scene_revision, Some(7));
        assert_eq!(receipt.plan.resolved_backend, BackendTarget::Fdm);
        assert_eq!(receipt.certificates.len(), 5);
        assert_eq!(receipt.plan.mesh.schema_version, "fdm_cell_domain.v1");
        assert_eq!(receipt.plan.space.schema_version, "fdm_grid_space.v1");
    }

    #[test]
    fn fem_materialization_returns_a_valid_receipt_bound_to_problem_and_native_evidence() {
        let problem = fem_problem_with_mesh_asset();
        let native = native_evidence_for_problem(&problem);
        let receipt = materialize_fem_preparation_from_problem(
            "prep-fem-materialized",
            9,
            &problem,
            &serde_json::json!({"camera": {"position": [1.0, 2.0, 3.0]}}),
            &native,
        )
        .expect("matching FEM evidence should materialize a complete receipt");

        receipt.validate().unwrap();
        assert_eq!(receipt.preparation_id, "prep-fem-materialized");
        assert_eq!(receipt.plan.scene_revision, Some(9));
        assert_eq!(receipt.plan.requested_backend, BackendTarget::Fem);
        assert_eq!(receipt.plan.resolved_backend, BackendTarget::Fem);
        assert_eq!(receipt.certificates.len(), 5);
        assert_eq!(
            receipt.plan.mesh.output_fingerprint,
            native.topology_fingerprint
        );
        assert_eq!(
            receipt.plan.space.output_fingerprint,
            native.space_fingerprint
        );

        let mesh_certificate = receipt
            .certificates
            .iter()
            .find(|certificate| certificate.producer.kind == PreparationProducerKind::Mesh)
            .unwrap();
        let mesh_source = mesh_certificate
            .quality
            .as_ref()
            .and_then(|quality| quality.mesh_source.as_ref())
            .expect("FEM receipt should retain source-mesh provenance");
        let quality = mesh_certificate
            .quality
            .as_ref()
            .expect("FEM mesh receipt should retain native Jacobian evidence");
        assert!(
            mesh_source.mesh_build_report_fingerprint.is_none(),
            "missing build report must remain explicit, not be treated as accepted quality"
        );
        assert!(
            mesh_source.per_domain_quality_cell_counts.is_empty(),
            "missing per-domain summaries must remain explicit, not imply acceptance"
        );
        assert!(quality.min_quality.is_none());
        assert!(quality.max_aspect_ratio.is_none());
        assert!(quality.jacobian.is_some());
        assert_eq!(
            receipt.plan.mesh.input_fingerprint,
            mesh_source.canonical_sha256().unwrap()
        );
        assert_eq!(mesh_certificate.cell_count, Some(native.cell_count));
    }

    #[test]
    fn fem_materialization_rejects_native_evidence_from_another_canonical_mesh() {
        let problem = fem_problem_with_mesh_asset();
        let mut native = native_evidence_for_problem(&problem);
        native.canonical_mesh_fingerprint = fingerprint('f');

        let error = materialize_fem_preparation_from_problem(
            "prep-fem-invalid",
            9,
            &problem,
            &serde_json::json!({}),
            &native,
        )
        .expect_err("a receipt must not be published for rebound native mesh evidence");
        assert!(error.to_string().contains("different canonical mesh"));
    }

    #[test]
    fn preparation_binding_hashes_the_validated_receipt() {
        let plan = plan();
        let receipt =
            PreparationReceipt::ready("prep-binding", plan.clone(), certificates(&plan), vec![])
                .unwrap();
        let binding = PreparationBinding::from_receipt(&receipt).unwrap();
        binding.validate().unwrap();
        assert_eq!(binding.preparation_id, receipt.preparation_id);
        assert_eq!(binding.plan_fingerprint, receipt.plan_fingerprint);
        assert!(binding.receipt_sha256.starts_with("sha256:"));

        let mut changed = receipt;
        changed.plan.scene_revision = Some(2);
        assert!(PreparationBinding::from_receipt(&changed).is_err());
    }
}
