//! Typed preparation boundary for geometry, display, grid, mesh and space.
//!
//! The preparation plan is deliberately a source-level contract first.  It
//! records the immutable inputs and the producer identity that a later
//! materializer must use; it does not claim that a mesh, operator or solver
//! has executed.  Existing FDM/FEM certificates can be wrapped into the
//! corresponding producer without inventing a second certificate format.

use fullmag_ir::{
    BackendPlanIR, BackendTarget, ExecutionPlanIR, FdmGridCertificateIR,
    FemSharedDomainBuildReportIR, MeshIR, MeshQualityIR, PeriodicMeshCertificateV6IR,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const PREPARATION_PLAN_SCHEMA: &str = "preparation_plan.v1";
pub const PREPARATION_PLAN_ACCEPTED_RUN_SCHEMA: &str = "preparation_plan.v2";
pub const PREPARATION_CERTIFICATE_SCHEMA: &str = "preparation_certificate.v1";
pub const PREPARATION_STATE_TRANSFER_SCHEMA: &str = "preparation_state_transfer.v1";
pub const NATIVE_FEM_MESH_SPACE_ABI_VERSION: u32 = 1;
pub const NATIVE_FEM_MESH_SPACE_PRODUCER_ID: &str = "fullmag.mfem.mesh_space";
pub const NATIVE_FEM_MESH_SPACE_SCHEMA_VERSION: &str = "mfem_mesh_space_evidence.v1";
pub const NATIVE_FEM_MESH_SPACE_PRODUCER_VERSION: &str = "1";
pub const FEM_MESH_SOURCE_EVIDENCE_SCHEMA_VERSION: &str = "fem_mesh_source_evidence.v1";
pub const FEM_MESH_SOURCE_BOUND_PRODUCER_SCHEMA_VERSION: &str = "mfem_mesh_source_binding.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreparationProducerKind {
    Geometry,
    Display,
    Grid,
    Mesh,
    Space,
}

impl PreparationProducerKind {
    pub const ALL: [Self; 5] = [
        Self::Geometry,
        Self::Display,
        Self::Grid,
        Self::Mesh,
        Self::Space,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Geometry => "geometry",
            Self::Display => "display",
            Self::Grid => "grid",
            Self::Mesh => "mesh",
            Self::Space => "space",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreparationPlanError {
    Contract(String),
    Producer {
        kind: PreparationProducerKind,
        reason: String,
    },
}

impl std::fmt::Display for PreparationPlanError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Contract(message) => formatter.write_str(message),
            Self::Producer { kind, reason } => {
                write!(formatter, "{} producer is invalid: {reason}", kind.as_str())
            }
        }
    }
}

impl std::error::Error for PreparationPlanError {}

/// Evidence returned by the stateless native MFEM mesh/function-space producer.
#[derive(Debug, Clone, PartialEq)]
pub struct NativeFemMeshSpaceEvidence {
    pub abi_version: u32,
    pub producer_id: String,
    pub schema_version: String,
    pub producer_version: String,
    pub mesh_matches_canonical_input: bool,
    pub canonical_mesh_fingerprint: String,
    pub topology_fingerprint: String,
    pub marker_map_fingerprint: String,
    pub quality_fingerprint: String,
    pub space_fingerprint: String,
    pub mesh_dimension: u32,
    pub fe_family: String,
    pub fe_order: u32,
    pub node_count: u64,
    pub cell_count: u64,
    pub boundary_element_count: u64,
    pub local_dof_count: u64,
    pub true_dof_count: u64,
    pub quality_sample_count: u64,
    pub invalid_cell_count: u64,
    pub min_jacobian_determinant: f64,
    pub max_jacobian_determinant: f64,
}

impl NativeFemMeshSpaceEvidence {
    fn validate_for_mesh(
        &self,
        mesh: &fullmag_ir::MeshIR,
        expected_fe_order: u32,
    ) -> Result<(), PreparationPlanError> {
        if self.abi_version != NATIVE_FEM_MESH_SPACE_ABI_VERSION
            || self.producer_id != NATIVE_FEM_MESH_SPACE_PRODUCER_ID
            || self.schema_version != NATIVE_FEM_MESH_SPACE_SCHEMA_VERSION
            || self.producer_version != NATIVE_FEM_MESH_SPACE_PRODUCER_VERSION
        {
            return Err(PreparationPlanError::Contract(
                "native FEM mesh-space evidence has an unknown ABI or producer identity".into(),
            ));
        }
        if !self.mesh_matches_canonical_input {
            return Err(PreparationPlanError::Contract(
                "native FEM producer did not confirm canonical mesh/marker correspondence".into(),
            ));
        }
        for (name, fingerprint) in [
            (
                "canonical_mesh_fingerprint",
                &self.canonical_mesh_fingerprint,
            ),
            ("topology_fingerprint", &self.topology_fingerprint),
            ("marker_map_fingerprint", &self.marker_map_fingerprint),
            ("quality_fingerprint", &self.quality_fingerprint),
            ("space_fingerprint", &self.space_fingerprint),
        ] {
            if !is_sha256_fingerprint(fingerprint) {
                return Err(PreparationPlanError::Contract(format!(
                    "native FEM {name} must be sha256:<64 lowercase hex characters>"
                )));
            }
        }
        let expected_mesh_fingerprint = normalize_sha256(&mesh.topology_fingerprint_v6());
        if self.canonical_mesh_fingerprint != expected_mesh_fingerprint {
            return Err(PreparationPlanError::Contract(
                "native FEM evidence is bound to a different canonical mesh".into(),
            ));
        }
        if self.mesh_dimension != 3
            || self.fe_family != "H1"
            || self.fe_order != expected_fe_order
            || self.fe_order != 1
        {
            return Err(PreparationPlanError::Contract(
                "native FEM evidence does not match the resolved 3D H1 order-1 space".into(),
            ));
        }
        if self.node_count != mesh.nodes.len() as u64
            || self.cell_count != mesh.cells.types.len() as u64
            || self.boundary_element_count == 0
        {
            return Err(PreparationPlanError::Contract(
                "native FEM mesh cardinalities do not match the canonical mesh".into(),
            ));
        }
        if self.local_dof_count != self.node_count
            || self.true_dof_count != self.local_dof_count
            || self.local_dof_count == 0
        {
            return Err(PreparationPlanError::Contract(
                "native FEM H1 P1 local/true DOFs do not match canonical nodes".into(),
            ));
        }
        if self.invalid_cell_count != 0
            || self.quality_sample_count == 0
            || !self.min_jacobian_determinant.is_finite()
            || self.min_jacobian_determinant <= 0.0
            || !self.max_jacobian_determinant.is_finite()
            || self.max_jacobian_determinant < self.min_jacobian_determinant
        {
            return Err(PreparationPlanError::Contract(
                "native FEM quality evidence is incomplete or contains invalid cells".into(),
            ));
        }
        Ok(())
    }
}

/// Upstream mesh-builder evidence bound to the exact canonical mesh consumed
/// by the native MFEM producer.  This is provenance integrity, not a claim
/// that the normative per-topology quality acceptance gate has passed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PreparationFemMeshSourceEvidence {
    pub schema_version: String,
    pub canonical_input_mesh_fingerprint: String,
    pub mfem_topology_fingerprint: String,
    pub mesh_build_report_fingerprint: Option<String>,
    pub per_domain_quality_fingerprint: String,
    /// Empty when the source mesh did not carry per-domain summaries.
    pub per_domain_quality_cell_counts: BTreeMap<u32, u64>,
}

impl PreparationFemMeshSourceEvidence {
    fn from_mesh(
        mesh: &MeshIR,
        mesh_build_report: Option<&FemSharedDomainBuildReportIR>,
        canonical_input_mesh_fingerprint: &str,
        mfem_topology_fingerprint: &str,
        expected_cell_count: u64,
    ) -> Result<Self, PreparationPlanError> {
        if !is_sha256_fingerprint(canonical_input_mesh_fingerprint)
            || !is_sha256_fingerprint(mfem_topology_fingerprint)
        {
            return Err(PreparationPlanError::Contract(
                "FEM source evidence requires valid canonical-input and MFEM topology fingerprints"
                    .into(),
            ));
        }
        let expected_input_fingerprint = normalize_sha256(&mesh.topology_fingerprint_v6());
        if canonical_input_mesh_fingerprint != expected_input_fingerprint.as_str() {
            return Err(PreparationPlanError::Contract(
                "FEM source evidence canonical fingerprint does not match MeshIR".into(),
            ));
        }

        if mesh_build_report.is_some_and(|report| report.degraded) {
            return Err(PreparationPlanError::Contract(
                "FEM preparation rejects a degraded mesh build report".into(),
            ));
        }

        let mut marker_cell_counts = BTreeMap::<u32, u64>::new();
        for marker in &mesh.element_markers {
            *marker_cell_counts.entry(*marker).or_default() += 1;
        }
        let mut quality_cell_counts = BTreeMap::<u32, u64>::new();
        if !mesh.per_domain_quality.is_empty() {
            if mesh.element_markers.len() as u64 != expected_cell_count {
                return Err(PreparationPlanError::Contract(
                    "FEM per-domain quality cannot be bound because element marker count differs from the native mesh".into(),
                ));
            }
            for (marker, quality) in &mesh.per_domain_quality {
                let Some(expected_count) = marker_cell_counts.get(marker).copied() else {
                    return Err(PreparationPlanError::Contract(format!(
                        "FEM per-domain quality references marker {marker} absent from the canonical mesh"
                    )));
                };
                if quality.n_elements == 0 || u64::from(quality.n_elements) != expected_count {
                    return Err(PreparationPlanError::Contract(format!(
                        "FEM per-domain quality element count does not match marker {marker}"
                    )));
                }
                validate_mesh_quality_summary(*marker, quality)?;
                quality_cell_counts.insert(*marker, expected_count);
            }
            if quality_cell_counts != marker_cell_counts {
                return Err(PreparationPlanError::Contract(
                    "FEM per-domain quality marker coverage does not match the canonical mesh"
                        .into(),
                ));
            }
            let quality_cell_total = quality_cell_counts
                .values()
                .try_fold(0_u64, |total, count| total.checked_add(*count))
                .ok_or_else(|| {
                    PreparationPlanError::Contract(
                        "FEM per-domain quality cell count overflowed".into(),
                    )
                })?;
            if quality_cell_total != expected_cell_count {
                return Err(PreparationPlanError::Contract(
                    "FEM per-domain quality total differs from the native mesh cell count".into(),
                ));
            }
        }

        let build_report_fingerprint = mesh_build_report
            .map(|report| {
                fingerprint_canonical_payload(&serde_json::json!({
                    "schema_version": "fem_shared_domain_build_report.v1",
                    "canonical_input_mesh_fingerprint": canonical_input_mesh_fingerprint,
                    "report": report,
                }))
            })
            .transpose()?;
        let sorted_quality = mesh
            .per_domain_quality
            .iter()
            .map(|(marker, quality)| (*marker, quality.clone()))
            .collect::<BTreeMap<_, _>>();
        let per_domain_quality_fingerprint = fingerprint_canonical_payload(&serde_json::json!({
            "schema_version": "fem_per_domain_quality.v1",
            "canonical_input_mesh_fingerprint": canonical_input_mesh_fingerprint,
            "quality_by_marker": sorted_quality,
        }))?;

        let evidence = Self {
            schema_version: FEM_MESH_SOURCE_EVIDENCE_SCHEMA_VERSION.into(),
            canonical_input_mesh_fingerprint: canonical_input_mesh_fingerprint.into(),
            mfem_topology_fingerprint: mfem_topology_fingerprint.into(),
            mesh_build_report_fingerprint: build_report_fingerprint,
            per_domain_quality_fingerprint,
            per_domain_quality_cell_counts: quality_cell_counts,
        };
        evidence.validate()?;
        Ok(evidence)
    }

    pub fn validate(&self) -> Result<(), PreparationPlanError> {
        if self.schema_version != FEM_MESH_SOURCE_EVIDENCE_SCHEMA_VERSION {
            return Err(PreparationPlanError::Contract(format!(
                "schema_version must be {FEM_MESH_SOURCE_EVIDENCE_SCHEMA_VERSION}"
            )));
        }
        for (name, fingerprint) in [
            (
                "canonical_input_mesh_fingerprint",
                &self.canonical_input_mesh_fingerprint,
            ),
            ("mfem_topology_fingerprint", &self.mfem_topology_fingerprint),
            (
                "per_domain_quality_fingerprint",
                &self.per_domain_quality_fingerprint,
            ),
        ] {
            if !is_sha256_fingerprint(fingerprint) {
                return Err(PreparationPlanError::Contract(format!(
                    "FEM source evidence {name} must be sha256:<64 lowercase hex characters>"
                )));
            }
        }
        if self
            .mesh_build_report_fingerprint
            .as_ref()
            .is_some_and(|fingerprint| !is_sha256_fingerprint(fingerprint))
        {
            return Err(PreparationPlanError::Contract(
                "FEM source evidence build-report fingerprint must be sha256:<64 lowercase hex characters>".into(),
            ));
        }
        if self
            .per_domain_quality_cell_counts
            .values()
            .any(|cell_count| *cell_count == 0)
        {
            return Err(PreparationPlanError::Contract(
                "FEM source evidence per-domain cell counts must be positive".into(),
            ));
        }
        Ok(())
    }

    pub fn canonical_sha256(&self) -> Result<String, PreparationPlanError> {
        self.validate()?;
        fingerprint_canonical_payload(self)
    }
}

fn validate_mesh_quality_summary(
    marker: u32,
    quality: &MeshQualityIR,
) -> Result<(), PreparationPlanError> {
    let values = [
        quality.sicn_min,
        quality.sicn_max,
        quality.sicn_mean,
        quality.sicn_p5,
        quality.gamma_min,
        quality.gamma_mean,
        quality.volume_min,
        quality.volume_max,
        quality.volume_mean,
        quality.volume_std,
        quality.avg_quality,
    ];
    if values.iter().any(|value| !value.is_finite())
        || quality.sicn_min > quality.sicn_p5
        || quality.sicn_p5 > quality.sicn_max
        || quality.sicn_min > quality.sicn_mean
        || quality.sicn_mean > quality.sicn_max
        || quality.gamma_min > quality.gamma_mean
        || quality.volume_min > quality.volume_mean
        || quality.volume_mean > quality.volume_max
        || quality.volume_std < 0.0
    {
        return Err(PreparationPlanError::Contract(format!(
            "FEM per-domain quality summary for marker {marker} is non-finite or internally inconsistent"
        )));
    }
    Ok(())
}

/// One immutable producer identity used by a preparation plan.
///
/// `input_fingerprint` binds the producer to the exact source snapshot and
/// policy. `output_fingerprint` identifies the realized artifact, if the
/// producer has already produced one.  Neither field is execution evidence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PreparationProducer {
    pub kind: PreparationProducerKind,
    pub producer_id: String,
    pub schema_version: String,
    pub producer_version: String,
    pub input_fingerprint: String,
    pub output_fingerprint: String,
}

impl PreparationProducer {
    pub fn new(
        kind: PreparationProducerKind,
        producer_id: impl Into<String>,
        schema_version: impl Into<String>,
        producer_version: impl Into<String>,
        input_fingerprint: impl Into<String>,
        output_fingerprint: impl Into<String>,
    ) -> Result<Self, PreparationPlanError> {
        let producer = Self {
            kind,
            producer_id: producer_id.into(),
            schema_version: schema_version.into(),
            producer_version: producer_version.into(),
            input_fingerprint: input_fingerprint.into(),
            output_fingerprint: output_fingerprint.into(),
        };
        producer.validate()?;
        Ok(producer)
    }

    /// Adapt an existing FDM grid certificate to the unified preparation
    /// producer vocabulary. The certificate's raw digest is normalized to the
    /// `sha256:<hex>` form used by preparation contracts.
    pub fn from_fdm_grid_certificate(
        input_fingerprint: impl Into<String>,
        producer_version: impl Into<String>,
        certificate: &FdmGridCertificateIR,
    ) -> Result<Self, PreparationPlanError> {
        Self::new(
            PreparationProducerKind::Grid,
            "fullmag.fdm.grid",
            "fdm_grid_certificate.v1",
            producer_version,
            input_fingerprint,
            normalize_sha256(&certificate.grid_fingerprint),
        )
    }

    /// Adapt the existing FEM periodic mesh certificate without changing its
    /// topology fingerprint or claiming that a function space was built.
    pub fn from_fem_mesh_certificate(
        input_fingerprint: impl Into<String>,
        producer_version: impl Into<String>,
        certificate: &PeriodicMeshCertificateV6IR,
    ) -> Result<Self, PreparationPlanError> {
        Self::new(
            PreparationProducerKind::Mesh,
            "fullmag.fem.periodic_mesh",
            "periodic_mesh_certificate.v6",
            producer_version,
            input_fingerprint,
            normalize_sha256(&certificate.topology_fingerprint),
        )
    }

    pub fn validate(&self) -> Result<(), PreparationPlanError> {
        if self.producer_id.trim().is_empty()
            || self.schema_version.trim().is_empty()
            || self.producer_version.trim().is_empty()
        {
            return Err(PreparationPlanError::Producer {
                kind: self.kind,
                reason: "producer_id, schema_version and producer_version are required".into(),
            });
        }
        for (name, fingerprint) in [
            ("input_fingerprint", &self.input_fingerprint),
            ("output_fingerprint", &self.output_fingerprint),
        ] {
            if !is_sha256_fingerprint(fingerprint) {
                return Err(PreparationPlanError::Producer {
                    kind: self.kind,
                    reason: format!("{name} must be sha256:<64 lowercase hex characters>"),
                });
            }
        }
        Ok(())
    }

    pub fn canonical_fingerprint(&self) -> Result<String, PreparationPlanError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|error| PreparationPlanError::Producer {
            kind: self.kind,
            reason: format!("producer fingerprint serialization failed: {error}"),
        })?;
        Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
    }
}

/// Immutable preparation intent shared by the FDM and FEM materializers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PreparationPlan {
    pub schema_version: String,
    pub problem_fingerprint: String,
    /// Live v1 plans keep the revision field. Accepted-run v2 plans omit it
    /// and carry an immutable source identity instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<PreparationPlanSource>,
    pub requested_backend: BackendTarget,
    pub resolved_backend: BackendTarget,
    pub geometry: PreparationProducer,
    pub display: PreparationProducer,
    pub grid: PreparationProducer,
    pub mesh: PreparationProducer,
    pub space: PreparationProducer,
}

/// Explicit source identity for preparation that belongs to an accepted run.
/// Live-session source identity remains represented by the legacy v1
/// `scene_revision` field so existing Live receipts retain their wire shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PreparationPlanSource {
    AcceptedRunStep {
        run_id: String,
        specification_fingerprint: String,
        step_id: String,
    },
}

impl PreparationPlanSource {
    pub fn accepted_run_step(
        run_id: impl Into<String>,
        specification_fingerprint: impl Into<String>,
        step_id: impl Into<String>,
    ) -> Result<Self, PreparationPlanError> {
        let source = Self::AcceptedRunStep {
            run_id: run_id.into(),
            specification_fingerprint: specification_fingerprint.into(),
            step_id: step_id.into(),
        };
        source.validate()?;
        Ok(source)
    }

    pub fn validate(&self) -> Result<(), PreparationPlanError> {
        match self {
            Self::AcceptedRunStep {
                run_id,
                specification_fingerprint,
                step_id,
            } => {
                if !is_plan_identifier(run_id) || !is_study_step_identifier(step_id) {
                    return Err(PreparationPlanError::Contract(
                        "accepted preparation run_id and step_id must be identifiers".into(),
                    ));
                }
                if !is_sha256_fingerprint(specification_fingerprint) {
                    return Err(PreparationPlanError::Contract(
                        "accepted preparation specification_fingerprint must be sha256:<64 lowercase hex characters>".into(),
                    ));
                }
            }
        }
        Ok(())
    }
}

enum PreparationPlanIdentity {
    LiveScene { scene_revision: u64 },
    AcceptedRun(PreparationPlanSource),
}

/// Materialization of the preparation boundary from validated FDM or native FEM evidence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PreparationMaterialization {
    pub plan: PreparationPlan,
    pub certificates: Vec<PreparationCertificate>,
}

impl PreparationMaterialization {
    /// Materialize the FDM preparation producers from an already resolved
    /// execution plan.  The caller supplies fingerprints for the canonical
    /// geometry and display projections so those projections remain separate
    /// from numerical ProblemIR identity.
    #[allow(clippy::too_many_arguments)]
    pub fn from_fdm_execution_plan(
        problem_fingerprint: impl Into<String>,
        scene_revision: u64,
        requested_backend: BackendTarget,
        execution_plan: &ExecutionPlanIR,
        geometry_fingerprint: impl Into<String>,
        display_fingerprint: impl Into<String>,
    ) -> Result<Self, PreparationPlanError> {
        Self::from_fdm_execution_plan_with_identity(
            problem_fingerprint,
            PreparationPlanIdentity::LiveScene { scene_revision },
            requested_backend,
            execution_plan,
            geometry_fingerprint,
            display_fingerprint,
        )
    }

    /// Materialize an FDM preparation plan from an immutable accepted-run
    /// step. This path has no Live scene revision and binds its plan to the
    /// exact RunSpecification and step supplied by the accepted snapshot.
    #[allow(clippy::too_many_arguments)]
    pub fn from_fdm_execution_plan_for_accepted_run(
        problem_fingerprint: impl Into<String>,
        source: PreparationPlanSource,
        requested_backend: BackendTarget,
        execution_plan: &ExecutionPlanIR,
        geometry_fingerprint: impl Into<String>,
        display_fingerprint: impl Into<String>,
    ) -> Result<Self, PreparationPlanError> {
        source.validate()?;
        Self::from_fdm_execution_plan_with_identity(
            problem_fingerprint,
            PreparationPlanIdentity::AcceptedRun(source),
            requested_backend,
            execution_plan,
            geometry_fingerprint,
            display_fingerprint,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn from_fdm_execution_plan_with_identity(
        problem_fingerprint: impl Into<String>,
        identity: PreparationPlanIdentity,
        requested_backend: BackendTarget,
        execution_plan: &ExecutionPlanIR,
        geometry_fingerprint: impl Into<String>,
        display_fingerprint: impl Into<String>,
    ) -> Result<Self, PreparationPlanError> {
        if execution_plan.common.requested_backend != requested_backend {
            return Err(PreparationPlanError::Contract(
                "preparation requested backend does not match the execution plan".into(),
            ));
        }
        if execution_plan.common.resolved_backend != BackendTarget::Fdm {
            return Err(PreparationPlanError::Contract(format!(
                "FDM preparation requires resolved backend 'fdm', got '{}'",
                execution_plan.common.resolved_backend.as_str()
            )));
        }

        let problem_fingerprint = problem_fingerprint.into();
        let geometry_fingerprint = geometry_fingerprint.into();
        let display_fingerprint = display_fingerprint.into();
        let evidence = FdmPreparationEvidence::from_execution_plan(execution_plan)?;

        let geometry = PreparationProducer::new(
            PreparationProducerKind::Geometry,
            "fullmag.geometry",
            "geometry_projection.v1",
            "1",
            problem_fingerprint.clone(),
            geometry_fingerprint,
        )?;
        let display = PreparationProducer::new(
            PreparationProducerKind::Display,
            "fullmag.display",
            "display_projection.v1",
            "1",
            problem_fingerprint.clone(),
            display_fingerprint,
        )?;
        let grid = PreparationProducer::from_fdm_grid_certificate(
            problem_fingerprint.clone(),
            "fullmag-plan.fdm.v1",
            evidence.grid_certificate,
        )?;
        let mesh_output = fingerprint_payload(&serde_json::json!({
            "schema_version": "fdm_cell_domain.v1",
            "grid_fingerprint": grid.output_fingerprint,
            "marker_map_fingerprint": evidence.marker_map_fingerprint,
            "mode": evidence.mode,
        }))?;
        let mesh = PreparationProducer::new(
            PreparationProducerKind::Mesh,
            "fullmag.fdm.cell_domain",
            "fdm_cell_domain.v1",
            "1",
            grid.output_fingerprint.clone(),
            mesh_output,
        )?;
        let space_output = fingerprint_payload(&serde_json::json!({
            "schema_version": "fdm_grid_space.v1",
            "cell_domain_fingerprint": mesh.output_fingerprint,
            "active_cells": evidence.active_cells,
            "marker_map_fingerprint": evidence.marker_map_fingerprint,
        }))?;
        let space = PreparationProducer::new(
            PreparationProducerKind::Space,
            "fullmag.fdm.grid_space",
            "fdm_grid_space.v1",
            "1",
            mesh.output_fingerprint.clone(),
            space_output,
        )?;

        let plan = match identity {
            PreparationPlanIdentity::LiveScene { scene_revision } => PreparationPlan::new(
                problem_fingerprint,
                scene_revision,
                requested_backend,
                BackendTarget::Fdm,
                geometry,
                display,
                grid,
                mesh,
                space,
            )?,
            PreparationPlanIdentity::AcceptedRun(source) => PreparationPlan::new_for_accepted_run(
                problem_fingerprint,
                source,
                requested_backend,
                BackendTarget::Fdm,
                geometry,
                display,
                grid,
                mesh,
                space,
            )?,
        };

        let marker_map = PreparationMarkerCertificate {
            marker_map_fingerprint: evidence.marker_map_fingerprint.clone(),
            marker_ids: evidence.marker_ids.clone(),
        };
        let quality = PreparationQualityCertificate {
            cell_count: evidence.cell_count,
            invalid_cell_count: 0,
            min_quality: Some(1.0),
            max_aspect_ratio: Some(evidence.max_aspect_ratio),
            jacobian: None,
            quality_fingerprint: evidence.quality_fingerprint,
            mesh_source: None,
        };
        let certificates = vec![
            PreparationCertificate {
                schema_version: PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.geometry.clone(),
                quality: None,
                marker_map: None,
                cell_count: None,
                space: None,
            },
            PreparationCertificate {
                schema_version: PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.display.clone(),
                quality: None,
                marker_map: None,
                cell_count: None,
                space: None,
            },
            PreparationCertificate {
                schema_version: PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.grid.clone(),
                quality: None,
                marker_map: None,
                cell_count: Some(evidence.cell_count),
                space: None,
            },
            PreparationCertificate {
                schema_version: PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.mesh.clone(),
                quality: Some(quality),
                marker_map: Some(marker_map.clone()),
                cell_count: Some(evidence.cell_count),
                space: None,
            },
            PreparationCertificate {
                schema_version: PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.space.clone(),
                quality: None,
                marker_map: Some(marker_map),
                cell_count: None,
                space: Some(PreparationSpaceCertificate {
                    mesh_fingerprint: plan.mesh.output_fingerprint.clone(),
                    marker_map_fingerprint: Some(evidence.marker_map_fingerprint),
                    dof_count: evidence.active_cells,
                    space_fingerprint: plan.space.output_fingerprint.clone(),
                    fe_family: None,
                    fe_order: None,
                    local_dof_count: None,
                    true_dof_count: None,
                }),
            },
        ];

        for certificate in &certificates {
            certificate.validate_for(&plan)?;
        }
        Ok(Self { plan, certificates })
    }

    /// Materialize FEM producers only after the native backend has built and
    /// validated the MFEM mesh and H1 function space for this exact plan.
    #[allow(clippy::too_many_arguments)]
    pub fn from_fem_execution_plan(
        problem_fingerprint: impl Into<String>,
        scene_revision: u64,
        requested_backend: BackendTarget,
        execution_plan: &ExecutionPlanIR,
        geometry_fingerprint: impl Into<String>,
        display_fingerprint: impl Into<String>,
        native: &NativeFemMeshSpaceEvidence,
    ) -> Result<Self, PreparationPlanError> {
        if execution_plan.common.requested_backend != requested_backend {
            return Err(PreparationPlanError::Contract(
                "preparation requested backend does not match the execution plan".into(),
            ));
        }
        if execution_plan.common.resolved_backend != BackendTarget::Fem {
            return Err(PreparationPlanError::Contract(format!(
                "FEM preparation requires resolved backend 'fem', got '{}'",
                execution_plan.common.resolved_backend.as_str()
            )));
        }
        let BackendPlanIR::Fem(fem) = &execution_plan.backend_plan else {
            return Err(PreparationPlanError::Contract(
                "FEM preparation requires a time-domain FEM execution plan".into(),
            ));
        };
        native.validate_for_mesh(&fem.mesh, fem.fe_order)?;
        let mesh_source_evidence = PreparationFemMeshSourceEvidence::from_mesh(
            &fem.mesh,
            fem.mesh_build_report.as_ref(),
            &native.canonical_mesh_fingerprint,
            &native.topology_fingerprint,
            native.cell_count,
        )?;
        let mesh_source_fingerprint = mesh_source_evidence.canonical_sha256()?;

        let problem_fingerprint = problem_fingerprint.into();
        let geometry = PreparationProducer::new(
            PreparationProducerKind::Geometry,
            "fullmag.geometry",
            "geometry_projection.v1",
            "1",
            problem_fingerprint.clone(),
            geometry_fingerprint,
        )?;
        let display = PreparationProducer::new(
            PreparationProducerKind::Display,
            "fullmag.display",
            "display_projection.v1",
            "1",
            problem_fingerprint.clone(),
            display_fingerprint,
        )?;
        let grid_output = fingerprint_payload(&serde_json::json!({
            "schema_version": "fem_discrete_domain.v1",
            "topology_fingerprint": native.topology_fingerprint,
            "marker_map_fingerprint": native.marker_map_fingerprint,
            "mesh_dimension": native.mesh_dimension,
            "node_count": native.node_count,
            "cell_count": native.cell_count,
        }))?;
        let grid = PreparationProducer::new(
            PreparationProducerKind::Grid,
            "fullmag.fem.discrete_domain",
            "fem_discrete_domain.v1",
            NATIVE_FEM_MESH_SPACE_PRODUCER_VERSION,
            problem_fingerprint.clone(),
            grid_output,
        )?;
        let mesh = PreparationProducer::new(
            PreparationProducerKind::Mesh,
            NATIVE_FEM_MESH_SPACE_PRODUCER_ID,
            FEM_MESH_SOURCE_BOUND_PRODUCER_SCHEMA_VERSION,
            NATIVE_FEM_MESH_SPACE_PRODUCER_VERSION,
            mesh_source_fingerprint,
            native.topology_fingerprint.clone(),
        )?;
        let space = PreparationProducer::new(
            PreparationProducerKind::Space,
            NATIVE_FEM_MESH_SPACE_PRODUCER_ID,
            NATIVE_FEM_MESH_SPACE_SCHEMA_VERSION,
            NATIVE_FEM_MESH_SPACE_PRODUCER_VERSION,
            native.topology_fingerprint.clone(),
            native.space_fingerprint.clone(),
        )?;
        let plan = PreparationPlan::new(
            problem_fingerprint,
            scene_revision,
            requested_backend,
            BackendTarget::Fem,
            geometry,
            display,
            grid,
            mesh,
            space,
        )?;

        let mut marker_ids = fem
            .mesh
            .element_markers
            .iter()
            .chain(fem.mesh.boundary_markers.iter())
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        for pair in &fem.mesh.periodic_boundary_pairs {
            marker_ids.insert(pair.marker_a);
            marker_ids.insert(pair.marker_b);
        }
        let marker_map = PreparationMarkerCertificate {
            marker_map_fingerprint: native.marker_map_fingerprint.clone(),
            marker_ids: marker_ids.into_iter().collect(),
        };
        let quality = PreparationQualityCertificate {
            cell_count: native.cell_count,
            invalid_cell_count: native.invalid_cell_count,
            min_quality: None,
            max_aspect_ratio: None,
            jacobian: Some(PreparationJacobianQualityCertificate {
                sample_count: native.quality_sample_count,
                min_determinant: native.min_jacobian_determinant,
                max_determinant: native.max_jacobian_determinant,
            }),
            quality_fingerprint: native.quality_fingerprint.clone(),
            mesh_source: Some(mesh_source_evidence),
        };
        let certificates = vec![
            PreparationCertificate {
                schema_version: PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.geometry.clone(),
                quality: None,
                marker_map: None,
                cell_count: None,
                space: None,
            },
            PreparationCertificate {
                schema_version: PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.display.clone(),
                quality: None,
                marker_map: None,
                cell_count: None,
                space: None,
            },
            PreparationCertificate {
                schema_version: PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.grid.clone(),
                quality: None,
                marker_map: Some(marker_map.clone()),
                cell_count: Some(native.cell_count),
                space: None,
            },
            PreparationCertificate {
                schema_version: PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.mesh.clone(),
                quality: Some(quality),
                marker_map: Some(marker_map.clone()),
                cell_count: Some(native.cell_count),
                space: None,
            },
            PreparationCertificate {
                schema_version: PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.space.clone(),
                quality: None,
                marker_map: Some(marker_map),
                cell_count: None,
                space: Some(PreparationSpaceCertificate {
                    mesh_fingerprint: plan.mesh.output_fingerprint.clone(),
                    marker_map_fingerprint: Some(native.marker_map_fingerprint.clone()),
                    dof_count: native.true_dof_count,
                    space_fingerprint: plan.space.output_fingerprint.clone(),
                    fe_family: Some(native.fe_family.clone()),
                    fe_order: Some(native.fe_order),
                    local_dof_count: Some(native.local_dof_count),
                    true_dof_count: Some(native.true_dof_count),
                }),
            },
        ];
        for certificate in &certificates {
            certificate.validate_for(&plan)?;
        }
        Ok(Self { plan, certificates })
    }
}

struct FdmPreparationEvidence<'a> {
    grid_certificate: &'a FdmGridCertificateIR,
    active_cells: u64,
    cell_count: u64,
    marker_map_fingerprint: String,
    marker_ids: Vec<u32>,
    max_aspect_ratio: f64,
    quality_fingerprint: String,
    mode: String,
}

impl<'a> FdmPreparationEvidence<'a> {
    fn from_execution_plan(
        execution_plan: &'a ExecutionPlanIR,
    ) -> Result<Self, PreparationPlanError> {
        match &execution_plan.backend_plan {
            BackendPlanIR::Fdm(fdm) => {
                let certificate = fdm.grid_certificate.as_ref().ok_or_else(|| {
                    PreparationPlanError::Contract(
                        "FDM execution plan is missing its grid certificate".into(),
                    )
                })?;
                certificate
                    .validate_against_masks(fdm.active_mask.as_deref(), &fdm.region_mask)
                    .map_err(|error| {
                        PreparationPlanError::Contract(format!(
                            "FDM grid certificate does not match the resolved plan: {error}"
                        ))
                    })?;
                let marker_ids = fdm
                    .region_mask
                    .iter()
                    .copied()
                    .filter(|id| *id != 0)
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>();
                Self::new(
                    certificate,
                    marker_ids,
                    fdm.region_mask.as_slice(),
                    fdm.active_mask.as_deref(),
                    "single_grid",
                )
            }
            BackendPlanIR::FdmMultilayer(multilayer) => {
                let certificate = multilayer.grid_certificate.as_ref().ok_or_else(|| {
                    PreparationPlanError::Contract(
                        "FDM multilayer execution plan is missing its grid certificate".into(),
                    )
                })?;
                let topology_tokens = fullmag_ir::fdm_multilayer_topology_tokens(
                    &multilayer.mode,
                    &multilayer.layers,
                );
                certificate
                    .validate_against_topology_tokens(None, &topology_tokens)
                    .map_err(|error| {
                        PreparationPlanError::Contract(format!(
                            "FDM multilayer grid certificate does not match the resolved plan: {error}"
                        ))
                    })?;
                let mut marker_ids = std::collections::BTreeSet::new();
                for layer in &multilayer.layers {
                    if let Some(legend) = &layer.native_region_legend {
                        marker_ids.extend(legend.iter().map(|entry| entry.numeric_id));
                    }
                    if let Some(mask) = &layer.native_region_mask {
                        marker_ids.extend(mask.iter().copied().filter(|id| *id != 0));
                    }
                }
                let marker_ids = marker_ids.into_iter().collect::<Vec<_>>();
                let marker_map_fingerprint = fingerprint_payload(&serde_json::json!({
                    "schema_version": "fdm_multilayer_marker_map.v1",
                    "layers": multilayer
                        .layers
                        .iter()
                        .map(|layer| {
                            serde_json::json!({
                                "layer_id": layer.layer_id,
                                "object_id": layer.object_id,
                                "region_legend": layer.native_region_legend,
                                "region_mask": layer.native_region_mask,
                            })
                        })
                        .collect::<Vec<_>>(),
                }))?;
                Self::new_with_marker_fingerprint(
                    certificate,
                    marker_ids,
                    marker_map_fingerprint,
                    &topology_tokens,
                    None,
                    &multilayer.mode,
                )
            }
            _ => Err(PreparationPlanError::Contract(
                "preparation materialization currently supports FDM execution plans only; FEM requires native space evidence".into(),
            )),
        }
    }

    fn new(
        certificate: &'a FdmGridCertificateIR,
        marker_ids: Vec<u32>,
        region_mask: &[u32],
        active_mask: Option<&[bool]>,
        mode: &str,
    ) -> Result<Self, PreparationPlanError> {
        let marker_map_fingerprint = certificate
            .region_legend_fingerprint
            .as_deref()
            .map(normalize_sha256)
            .unwrap_or(fingerprint_payload(&serde_json::json!({
                "schema_version": "fdm_region_mask.v1",
                "region_mask": region_mask,
            }))?);
        Self::new_with_marker_fingerprint(
            certificate,
            marker_ids,
            marker_map_fingerprint,
            region_mask,
            active_mask,
            mode,
        )
    }

    fn new_with_marker_fingerprint(
        certificate: &'a FdmGridCertificateIR,
        marker_ids: Vec<u32>,
        marker_map_fingerprint: String,
        _topology_payload: &[u32],
        _active_mask: Option<&[bool]>,
        mode: &str,
    ) -> Result<Self, PreparationPlanError> {
        if certificate.active_cells == 0 {
            return Err(PreparationPlanError::Contract(
                "FDM preparation requires at least one active cell".into(),
            ));
        }
        if marker_ids.is_empty() {
            return Err(PreparationPlanError::Contract(
                "FDM preparation requires at least one resolved region marker".into(),
            ));
        }
        let cell_count = certificate
            .counts
            .iter()
            .try_fold(1_u64, |product, count| product.checked_mul(*count as u64))
            .ok_or_else(|| {
                PreparationPlanError::Contract("FDM preparation cell count overflows u64".into())
            })?;
        let minimum_cell = certificate
            .cell_m
            .iter()
            .copied()
            .fold(f64::INFINITY, f64::min);
        let maximum_cell = certificate.cell_m.iter().copied().fold(0.0_f64, f64::max);
        let max_aspect_ratio = maximum_cell / minimum_cell;
        let quality_fingerprint = fingerprint_payload(&serde_json::json!({
            "schema_version": "fdm_cell_quality.v1",
            "counts": certificate.counts,
            "cell_m": certificate.cell_m,
            "active_cells": certificate.active_cells,
        }))?;
        Ok(Self {
            grid_certificate: certificate,
            active_cells: certificate.active_cells,
            cell_count,
            marker_map_fingerprint,
            marker_ids,
            max_aspect_ratio,
            quality_fingerprint,
            mode: mode.to_string(),
        })
    }
}

fn fingerprint_payload<T: Serialize>(payload: &T) -> Result<String, PreparationPlanError> {
    let encoded = serde_json::to_vec(payload).map_err(|error| {
        PreparationPlanError::Contract(format!(
            "preparation fingerprint serialization failed: {error}"
        ))
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(encoded)))
}

fn fingerprint_canonical_payload<T: Serialize>(
    payload: &T,
) -> Result<String, PreparationPlanError> {
    let value = serde_json::to_value(payload).map_err(|error| {
        PreparationPlanError::Contract(format!(
            "preparation fingerprint serialization failed: {error}"
        ))
    })?;
    let canonical = canonicalize_json(value);
    let encoded = serde_json::to_vec(&canonical).map_err(|error| {
        PreparationPlanError::Contract(format!(
            "canonical preparation fingerprint encoding failed: {error}"
        ))
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(encoded)))
}

fn canonicalize_json(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.into_iter().map(canonicalize_json).collect())
        }
        serde_json::Value::Object(values) => {
            let sorted = values.into_iter().collect::<BTreeMap<_, _>>();
            let mut canonical = serde_json::Map::new();
            for (key, value) in sorted {
                canonical.insert(key, canonicalize_json(value));
            }
            serde_json::Value::Object(canonical)
        }
        scalar => scalar,
    }
}

impl PreparationPlan {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        problem_fingerprint: impl Into<String>,
        scene_revision: u64,
        requested_backend: BackendTarget,
        resolved_backend: BackendTarget,
        geometry: PreparationProducer,
        display: PreparationProducer,
        grid: PreparationProducer,
        mesh: PreparationProducer,
        space: PreparationProducer,
    ) -> Result<Self, PreparationPlanError> {
        let plan = Self {
            schema_version: PREPARATION_PLAN_SCHEMA.into(),
            problem_fingerprint: problem_fingerprint.into(),
            scene_revision: Some(scene_revision),
            source: None,
            requested_backend,
            resolved_backend,
            geometry,
            display,
            grid,
            mesh,
            space,
        };
        plan.validate()?;
        Ok(plan)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new_for_accepted_run(
        problem_fingerprint: impl Into<String>,
        source: PreparationPlanSource,
        requested_backend: BackendTarget,
        resolved_backend: BackendTarget,
        geometry: PreparationProducer,
        display: PreparationProducer,
        grid: PreparationProducer,
        mesh: PreparationProducer,
        space: PreparationProducer,
    ) -> Result<Self, PreparationPlanError> {
        let plan = Self {
            schema_version: PREPARATION_PLAN_ACCEPTED_RUN_SCHEMA.into(),
            problem_fingerprint: problem_fingerprint.into(),
            scene_revision: None,
            source: Some(source),
            requested_backend,
            resolved_backend,
            geometry,
            display,
            grid,
            mesh,
            space,
        };
        plan.validate()?;
        Ok(plan)
    }

    pub fn producers(&self) -> [&PreparationProducer; 5] {
        [
            &self.geometry,
            &self.display,
            &self.grid,
            &self.mesh,
            &self.space,
        ]
    }

    pub fn producer(&self, kind: PreparationProducerKind) -> &PreparationProducer {
        match kind {
            PreparationProducerKind::Geometry => &self.geometry,
            PreparationProducerKind::Display => &self.display,
            PreparationProducerKind::Grid => &self.grid,
            PreparationProducerKind::Mesh => &self.mesh,
            PreparationProducerKind::Space => &self.space,
        }
    }

    pub fn validate(&self) -> Result<(), PreparationPlanError> {
        if !is_sha256_fingerprint(&self.problem_fingerprint) {
            return Err(PreparationPlanError::Contract(
                "problem_fingerprint must be sha256:<64 lowercase hex characters>".into(),
            ));
        }
        match self.schema_version.as_str() {
            PREPARATION_PLAN_SCHEMA => {
                if self.source.is_some() || self.scene_revision.is_none() {
                    return Err(PreparationPlanError::Contract(
                        "preparation_plan.v1 requires scene_revision and cannot declare an accepted-run source".into(),
                    ));
                }
                if self.scene_revision == Some(0) {
                    return Err(PreparationPlanError::Contract(
                        "scene_revision must be greater than zero".into(),
                    ));
                }
            }
            PREPARATION_PLAN_ACCEPTED_RUN_SCHEMA => {
                if self.scene_revision.is_some() {
                    return Err(PreparationPlanError::Contract(
                        "preparation_plan.v2 cannot carry a Live scene_revision".into(),
                    ));
                }
                self.source
                    .as_ref()
                    .ok_or_else(|| {
                        PreparationPlanError::Contract(
                            "preparation_plan.v2 requires an accepted-run source".into(),
                        )
                    })?
                    .validate()?;
            }
            other => {
                return Err(PreparationPlanError::Contract(format!(
                    "unsupported preparation plan schema `{other}`"
                )));
            }
        }
        if matches!(self.requested_backend, BackendTarget::Hybrid)
            || !matches!(
                self.resolved_backend,
                BackendTarget::Fdm | BackendTarget::Fem
            )
        {
            return Err(PreparationPlanError::Contract(
                "preparation requires a supported FDM or FEM resolved backend".into(),
            ));
        }
        if self.resolved_backend == BackendTarget::Fem
            && (self.grid.producer_id != "fullmag.fem.discrete_domain"
                || self.grid.schema_version != "fem_discrete_domain.v1"
                || self.mesh.producer_id != NATIVE_FEM_MESH_SPACE_PRODUCER_ID
                || (self.mesh.schema_version != FEM_MESH_SOURCE_BOUND_PRODUCER_SCHEMA_VERSION
                    && self.mesh.schema_version != NATIVE_FEM_MESH_SPACE_SCHEMA_VERSION)
                || self.space.producer_id != NATIVE_FEM_MESH_SPACE_PRODUCER_ID
                || self.space.schema_version != NATIVE_FEM_MESH_SPACE_SCHEMA_VERSION)
        {
            return Err(PreparationPlanError::Contract(
                "FEM preparation plan must use the native MFEM domain, mesh and space producers"
                    .into(),
            ));
        }
        for (expected, producer) in PreparationProducerKind::ALL
            .into_iter()
            .zip(self.producers())
        {
            producer.validate()?;
            if producer.kind != expected {
                return Err(PreparationPlanError::Contract(format!(
                    "preparation producer order requires {}, got {}",
                    expected.as_str(),
                    producer.kind.as_str()
                )));
            }
        }
        Ok(())
    }

    pub fn canonical_json_bytes(&self) -> Result<Vec<u8>, PreparationPlanError> {
        self.validate()?;
        serde_json::to_vec(self).map_err(|error| {
            PreparationPlanError::Contract(format!("serialization failed: {error}"))
        })
    }

    pub fn canonical_sha256(&self) -> Result<String, PreparationPlanError> {
        Ok(format!(
            "sha256:{:x}",
            Sha256::digest(self.canonical_json_bytes()?)
        ))
    }
}

/// Quality evidence attached to a realized mesh/grid certificate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PreparationQualityCertificate {
    pub cell_count: u64,
    pub invalid_cell_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_quality: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_aspect_ratio: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jacobian: Option<PreparationJacobianQualityCertificate>,
    pub quality_fingerprint: String,
    /// Present for current FEM receipts; legacy FEM receipts remain readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_source: Option<PreparationFemMeshSourceEvidence>,
}

/// Positive order-two Jacobian determinant samples from a realized FEM mesh.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PreparationJacobianQualityCertificate {
    pub sample_count: u64,
    pub min_determinant: f64,
    pub max_determinant: f64,
}

impl PreparationQualityCertificate {
    pub fn validate(&self) -> Result<(), PreparationPlanError> {
        if self.cell_count == 0 {
            return Err(PreparationPlanError::Contract(
                "quality certificate cell_count must be greater than zero".into(),
            ));
        }
        if self.invalid_cell_count != 0 {
            return Err(PreparationPlanError::Contract(
                "quality certificate contains invalid cells".into(),
            ));
        }
        match (&self.min_quality, &self.max_aspect_ratio, &self.jacobian) {
            (Some(min_quality), Some(max_aspect_ratio), None) => {
                if !min_quality.is_finite() || *min_quality <= 0.0 {
                    return Err(PreparationPlanError::Contract(
                        "quality certificate min_quality must be finite and positive".into(),
                    ));
                }
                if !max_aspect_ratio.is_finite() || *max_aspect_ratio < 1.0 {
                    return Err(PreparationPlanError::Contract(
                        "quality certificate max_aspect_ratio must be finite and at least one"
                            .into(),
                    ));
                }
            }
            (None, None, Some(jacobian)) => {
                if jacobian.sample_count == 0
                    || !jacobian.min_determinant.is_finite()
                    || jacobian.min_determinant <= 0.0
                    || !jacobian.max_determinant.is_finite()
                    || jacobian.max_determinant < jacobian.min_determinant
                {
                    return Err(PreparationPlanError::Contract(
                        "quality certificate Jacobian evidence is incomplete or invalid".into(),
                    ));
                }
            }
            _ => {
                return Err(PreparationPlanError::Contract(
                    "quality certificate must contain either FDM quality metrics or FEM Jacobian evidence".into(),
                ));
            }
        }
        if !is_sha256_fingerprint(&self.quality_fingerprint) {
            return Err(PreparationPlanError::Contract(
                "quality_fingerprint must be sha256:<64 lowercase hex characters>".into(),
            ));
        }
        if let Some(mesh_source) = &self.mesh_source {
            mesh_source.validate()?;
        }
        Ok(())
    }
}

/// Explicit marker/cell ownership evidence.  The list is intentionally
/// independent from the topology fingerprint: marker changes must invalidate
/// dependent spaces even when the node/cell topology is unchanged.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PreparationMarkerCertificate {
    pub marker_map_fingerprint: String,
    pub marker_ids: Vec<u32>,
}

impl PreparationMarkerCertificate {
    pub fn validate(&self) -> Result<(), PreparationPlanError> {
        if !is_sha256_fingerprint(&self.marker_map_fingerprint) {
            return Err(PreparationPlanError::Contract(
                "marker_map_fingerprint must be sha256:<64 lowercase hex characters>".into(),
            ));
        }
        if self.marker_ids.is_empty() {
            return Err(PreparationPlanError::Contract(
                "marker certificate must contain at least one marker".into(),
            ));
        }
        if self.marker_ids.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(PreparationPlanError::Contract(
                "marker_ids must be strictly increasing and unique".into(),
            ));
        }
        Ok(())
    }
}

/// Function-space evidence is a separate artifact.  A valid mesh does not
/// imply that a space or operator can be reused.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PreparationSpaceCertificate {
    pub mesh_fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker_map_fingerprint: Option<String>,
    pub dof_count: u64,
    pub space_fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fe_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fe_order: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_dof_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub true_dof_count: Option<u64>,
}

impl PreparationSpaceCertificate {
    pub fn validate(&self) -> Result<(), PreparationPlanError> {
        if !is_sha256_fingerprint(&self.mesh_fingerprint) {
            return Err(PreparationPlanError::Contract(
                "space mesh_fingerprint must be sha256:<64 lowercase hex characters>".into(),
            ));
        }
        if let Some(marker_map_fingerprint) = &self.marker_map_fingerprint {
            if !is_sha256_fingerprint(marker_map_fingerprint) {
                return Err(PreparationPlanError::Contract(
                    "space marker_map_fingerprint must be sha256:<64 lowercase hex characters>"
                        .into(),
                ));
            }
        }
        if self.dof_count == 0 {
            return Err(PreparationPlanError::Contract(
                "space dof_count must be greater than zero".into(),
            ));
        }
        if !is_sha256_fingerprint(&self.space_fingerprint) {
            return Err(PreparationPlanError::Contract(
                "space_fingerprint must be sha256:<64 lowercase hex characters>".into(),
            ));
        }
        match (
            self.fe_family.as_deref(),
            self.fe_order,
            self.local_dof_count,
            self.true_dof_count,
        ) {
            (None, None, None, None) => {}
            (Some("H1"), Some(order), Some(local), Some(true_dofs))
                if order > 0
                    && local > 0
                    && true_dofs > 0
                    && true_dofs <= local
                    && self.dof_count == true_dofs => {}
            _ => {
                return Err(PreparationPlanError::Contract(
                    "space FE family/order and local/true DOF evidence must be complete and consistent".into(),
                ));
            }
        }
        Ok(())
    }
}

/// A validated certificate for one preparation producer.  It is an
/// acceptance record for inputs/outputs, not evidence that a solver ran.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PreparationCertificate {
    pub schema_version: String,
    pub producer: PreparationProducer,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<PreparationQualityCertificate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker_map: Option<PreparationMarkerCertificate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cell_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space: Option<PreparationSpaceCertificate>,
}

impl PreparationCertificate {
    pub fn validate_for(&self, plan: &PreparationPlan) -> Result<(), PreparationPlanError> {
        if self.schema_version != PREPARATION_CERTIFICATE_SCHEMA {
            return Err(PreparationPlanError::Contract(format!(
                "schema_version must be {PREPARATION_CERTIFICATE_SCHEMA}"
            )));
        }
        plan.validate()?;
        self.producer.validate()?;
        let expected = plan.producer(self.producer.kind);
        if &self.producer != expected {
            return Err(PreparationPlanError::Contract(format!(
                "{} certificate producer does not match the preparation plan",
                self.producer.kind.as_str()
            )));
        }
        if let Some(quality) = &self.quality {
            quality.validate()?;
            if self
                .cell_count
                .is_some_and(|cell_count| cell_count != quality.cell_count)
            {
                return Err(PreparationPlanError::Contract(
                    "quality certificate cell_count differs from its producer certificate".into(),
                ));
            }
            match plan.resolved_backend {
                BackendTarget::Fdm
                    if quality.min_quality.is_some()
                        && quality.max_aspect_ratio.is_some()
                        && quality.jacobian.is_none() => {}
                BackendTarget::Fem
                    if quality.min_quality.is_none()
                        && quality.max_aspect_ratio.is_none()
                        && quality.jacobian.is_some() => {}
                _ => {
                    return Err(PreparationPlanError::Contract(
                        "quality evidence does not match the resolved backend".into(),
                    ));
                }
            }
            if self.producer.kind == PreparationProducerKind::Mesh
                && plan.resolved_backend == BackendTarget::Fem
            {
                let requires_source_evidence =
                    plan.mesh.schema_version == FEM_MESH_SOURCE_BOUND_PRODUCER_SCHEMA_VERSION;
                match quality.mesh_source.as_ref() {
                    Some(source_evidence) => {
                        if source_evidence.mfem_topology_fingerprint
                            != self.producer.output_fingerprint
                        {
                            return Err(PreparationPlanError::Contract(
                                "FEM source evidence references a different MFEM mesh topology"
                                    .into(),
                            ));
                        }
                        if source_evidence.canonical_sha256()? != self.producer.input_fingerprint {
                            return Err(PreparationPlanError::Contract(
                                "FEM source evidence does not match the mesh producer input fingerprint".into(),
                            ));
                        }
                        let quality_cell_total = source_evidence
                            .per_domain_quality_cell_counts
                            .values()
                            .try_fold(0_u64, |total, count| total.checked_add(*count))
                            .ok_or_else(|| {
                                PreparationPlanError::Contract(
                                    "FEM source evidence per-domain cell count overflowed".into(),
                                )
                            })?;
                        if !source_evidence.per_domain_quality_cell_counts.is_empty()
                            && quality_cell_total != quality.cell_count
                        {
                            return Err(PreparationPlanError::Contract(
                                "FEM per-domain quality totals differ from the mesh certificate cell count".into(),
                            ));
                        }
                        if self.marker_map.as_ref().is_some_and(|marker_map| {
                            source_evidence
                                .per_domain_quality_cell_counts
                                .keys()
                                .any(|marker| !marker_map.marker_ids.contains(marker))
                        }) {
                            return Err(PreparationPlanError::Contract(
                                "FEM per-domain quality references a marker absent from the mesh certificate".into(),
                            ));
                        }
                    }
                    None if requires_source_evidence => {
                        return Err(PreparationPlanError::Contract(
                            "current FEM mesh certificate requires versioned source evidence"
                                .into(),
                        ));
                    }
                    None => {}
                }
            } else if quality.mesh_source.is_some() {
                return Err(PreparationPlanError::Contract(
                    "FEM mesh source evidence is only valid on the FEM mesh certificate".into(),
                ));
            }
        }
        if let Some(marker_map) = &self.marker_map {
            marker_map.validate()?;
        }
        if let Some(cell_count) = self.cell_count {
            if cell_count == 0 {
                return Err(PreparationPlanError::Contract(
                    "certificate cell_count must be greater than zero".into(),
                ));
            }
        }
        if let Some(space) = &self.space {
            space.validate()?;
            if self.producer.kind != PreparationProducerKind::Space {
                return Err(PreparationPlanError::Contract(
                    "space evidence is only valid for the space producer".into(),
                ));
            }
            if space.space_fingerprint != self.producer.output_fingerprint {
                return Err(PreparationPlanError::Contract(
                    "space fingerprint does not match the producer output".into(),
                ));
            }
            if space.mesh_fingerprint != plan.mesh.output_fingerprint {
                return Err(PreparationPlanError::Contract(
                    "space certificate references a different mesh fingerprint".into(),
                ));
            }
            if let (Some(space_markers), Some(marker_map)) =
                (&space.marker_map_fingerprint, &self.marker_map)
            {
                if space_markers != &marker_map.marker_map_fingerprint {
                    return Err(PreparationPlanError::Contract(
                        "space certificate references a different marker map".into(),
                    ));
                }
            }
            if plan.resolved_backend == BackendTarget::Fem
                && (space.fe_family.as_deref() != Some("H1")
                    || space.marker_map_fingerprint.is_none()
                    || self.marker_map.is_none())
            {
                return Err(PreparationPlanError::Contract(
                    "FEM space certificate requires H1 and matching marker-map evidence".into(),
                ));
            }
        }
        match self.producer.kind {
            PreparationProducerKind::Grid => {
                if self.cell_count.is_none() {
                    return Err(PreparationPlanError::Contract(
                        "grid certificate requires cell_count".into(),
                    ));
                }
                if plan.resolved_backend == BackendTarget::Fem && self.marker_map.is_none() {
                    return Err(PreparationPlanError::Contract(
                        "FEM domain certificate requires marker-map evidence".into(),
                    ));
                }
            }
            PreparationProducerKind::Mesh => {
                if self.cell_count.is_none() || self.quality.is_none() {
                    return Err(PreparationPlanError::Contract(
                        "mesh certificate requires cell_count and quality evidence".into(),
                    ));
                }
                if self.marker_map.is_none() {
                    return Err(PreparationPlanError::Contract(
                        "mesh certificate requires marker-map evidence".into(),
                    ));
                }
            }
            PreparationProducerKind::Space => {
                if self.space.is_none() {
                    return Err(PreparationPlanError::Contract(
                        "space certificate requires function-space evidence".into(),
                    ));
                }
            }
            PreparationProducerKind::Geometry | PreparationProducerKind::Display => {}
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PreparationReuseDisposition {
    Reuse,
    Rebuild,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PreparationReuseReason {
    ProducerIdentityChanged,
    SchemaChanged,
    VersionChanged,
    InputChanged,
    OutputChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PreparationReuseDecision {
    pub kind: PreparationProducerKind,
    pub disposition: PreparationReuseDisposition,
    pub reason: Option<PreparationReuseReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_output_fingerprint: Option<String>,
    pub current_output_fingerprint: String,
}

/// Compare each producer independently.  In particular, reusing a mesh never
/// grants reuse of the function space or an operator.
pub fn assess_selective_reuse(
    previous: &PreparationPlan,
    current: &PreparationPlan,
) -> Result<Vec<PreparationReuseDecision>, PreparationPlanError> {
    previous.validate()?;
    current.validate()?;
    Ok(PreparationProducerKind::ALL
        .into_iter()
        .map(|kind| {
            let old = previous.producer(kind);
            let new = current.producer(kind);
            let (disposition, reason) = if old == new {
                (PreparationReuseDisposition::Reuse, None)
            } else if old.producer_id != new.producer_id {
                (
                    PreparationReuseDisposition::Rebuild,
                    Some(PreparationReuseReason::ProducerIdentityChanged),
                )
            } else if old.schema_version != new.schema_version {
                (
                    PreparationReuseDisposition::Rebuild,
                    Some(PreparationReuseReason::SchemaChanged),
                )
            } else if old.producer_version != new.producer_version {
                (
                    PreparationReuseDisposition::Rebuild,
                    Some(PreparationReuseReason::VersionChanged),
                )
            } else if old.input_fingerprint != new.input_fingerprint {
                (
                    PreparationReuseDisposition::Rebuild,
                    Some(PreparationReuseReason::InputChanged),
                )
            } else {
                (
                    PreparationReuseDisposition::Rebuild,
                    Some(PreparationReuseReason::OutputChanged),
                )
            };
            PreparationReuseDecision {
                kind,
                disposition,
                reason,
                previous_output_fingerprint: Some(old.output_fingerprint.clone()),
                current_output_fingerprint: new.output_fingerprint.clone(),
            }
        })
        .collect())
}

/// Explicit state transfer boundary.  A state transfer is a separate
/// artifact and never follows from mesh or space reuse implicitly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PreparationStateTransfer {
    pub schema_version: String,
    pub source_kind: PreparationProducerKind,
    pub target_kind: PreparationProducerKind,
    pub source_fingerprint: String,
    pub target_fingerprint: String,
    pub mapping_fingerprint: String,
}

impl PreparationStateTransfer {
    pub fn validate(&self) -> Result<(), PreparationPlanError> {
        if self.schema_version != PREPARATION_STATE_TRANSFER_SCHEMA {
            return Err(PreparationPlanError::Contract(format!(
                "schema_version must be {PREPARATION_STATE_TRANSFER_SCHEMA}"
            )));
        }
        for (name, fingerprint) in [
            ("source_fingerprint", &self.source_fingerprint),
            ("target_fingerprint", &self.target_fingerprint),
            ("mapping_fingerprint", &self.mapping_fingerprint),
        ] {
            if !is_sha256_fingerprint(fingerprint) {
                return Err(PreparationPlanError::Contract(format!(
                    "{name} must be sha256:<64 lowercase hex characters>"
                )));
            }
        }
        if matches!(
            self.source_kind,
            PreparationProducerKind::Geometry | PreparationProducerKind::Display
        ) || matches!(
            self.target_kind,
            PreparationProducerKind::Geometry | PreparationProducerKind::Display
        ) {
            return Err(PreparationPlanError::Contract(
                "state transfer requires grid, mesh or space artifacts".into(),
            ));
        }
        Ok(())
    }
}

fn normalize_sha256(value: &str) -> String {
    if value.starts_with("sha256:") {
        value.to_string()
    } else {
        format!("sha256:{value}")
    }
}

fn is_sha256_fingerprint(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_plan_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn is_study_step_identifier(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 256
        && !value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fingerprint(hex: char) -> String {
        format!("sha256:{}", hex.to_string().repeat(64))
    }

    fn quality_summary(n_elements: u32) -> MeshQualityIR {
        MeshQualityIR {
            n_elements,
            sicn_min: 0.2,
            sicn_max: 0.9,
            sicn_mean: 0.6,
            sicn_p5: 0.3,
            sicn_histogram: Vec::new(),
            gamma_min: 0.1,
            gamma_mean: 0.7,
            gamma_histogram: Vec::new(),
            volume_min: 1.0,
            volume_max: 3.0,
            volume_mean: 2.0,
            volume_std: 0.4,
            avg_quality: 0.6,
        }
    }

    fn source_mesh(reverse_insert_order: bool) -> MeshIR {
        let mut mesh = MeshIR::default();
        mesh.element_markers = vec![1, 1, 2];
        let first = quality_summary(2);
        let second = quality_summary(1);
        if reverse_insert_order {
            mesh.per_domain_quality.insert(2, second);
            mesh.per_domain_quality.insert(1, first);
        } else {
            mesh.per_domain_quality.insert(1, first);
            mesh.per_domain_quality.insert(2, second);
        }
        mesh
    }

    fn build_report() -> FemSharedDomainBuildReportIR {
        serde_json::from_value(serde_json::json!({
            "build_mode": "shared_domain",
            "degraded": false,
        }))
        .unwrap()
    }

    fn source_evidence(
        mesh: &MeshIR,
        report: Option<&FemSharedDomainBuildReportIR>,
    ) -> PreparationFemMeshSourceEvidence {
        let canonical_mesh_fingerprint = normalize_sha256(&mesh.topology_fingerprint_v6());
        PreparationFemMeshSourceEvidence::from_mesh(
            mesh,
            report,
            &canonical_mesh_fingerprint,
            &fingerprint('b'),
            3,
        )
        .unwrap()
    }

    fn fem_plan_for_source_evidence(
        source: &PreparationFemMeshSourceEvidence,
        mesh_schema: &str,
    ) -> PreparationPlan {
        PreparationPlan::new(
            fingerprint('c'),
            7,
            BackendTarget::Fem,
            BackendTarget::Fem,
            PreparationProducer::new(
                PreparationProducerKind::Geometry,
                "fullmag.geometry",
                "geometry_projection.v1",
                "1",
                fingerprint('c'),
                fingerprint('d'),
            )
            .unwrap(),
            PreparationProducer::new(
                PreparationProducerKind::Display,
                "fullmag.display",
                "display_projection.v1",
                "1",
                fingerprint('c'),
                fingerprint('e'),
            )
            .unwrap(),
            PreparationProducer::new(
                PreparationProducerKind::Grid,
                "fullmag.fem.discrete_domain",
                "fem_discrete_domain.v1",
                "1",
                fingerprint('c'),
                fingerprint('f'),
            )
            .unwrap(),
            PreparationProducer::new(
                PreparationProducerKind::Mesh,
                NATIVE_FEM_MESH_SPACE_PRODUCER_ID,
                mesh_schema,
                "1",
                if mesh_schema == FEM_MESH_SOURCE_BOUND_PRODUCER_SCHEMA_VERSION {
                    source.canonical_sha256().unwrap()
                } else {
                    source.canonical_input_mesh_fingerprint.clone()
                },
                source.mfem_topology_fingerprint.clone(),
            )
            .unwrap(),
            PreparationProducer::new(
                PreparationProducerKind::Space,
                NATIVE_FEM_MESH_SPACE_PRODUCER_ID,
                NATIVE_FEM_MESH_SPACE_SCHEMA_VERSION,
                "1",
                source.mfem_topology_fingerprint.clone(),
                fingerprint('1'),
            )
            .unwrap(),
        )
        .unwrap()
    }

    fn fem_mesh_certificate(
        plan: &PreparationPlan,
        mesh_source: Option<PreparationFemMeshSourceEvidence>,
    ) -> PreparationCertificate {
        PreparationCertificate {
            schema_version: PREPARATION_CERTIFICATE_SCHEMA.into(),
            producer: plan.mesh.clone(),
            quality: Some(PreparationQualityCertificate {
                cell_count: 3,
                invalid_cell_count: 0,
                min_quality: None,
                max_aspect_ratio: None,
                jacobian: Some(PreparationJacobianQualityCertificate {
                    sample_count: 12,
                    min_determinant: 1.0e-27,
                    max_determinant: 2.0e-27,
                }),
                quality_fingerprint: fingerprint('a'),
                mesh_source,
            }),
            marker_map: Some(PreparationMarkerCertificate {
                marker_map_fingerprint: fingerprint('2'),
                marker_ids: vec![1, 2],
            }),
            cell_count: Some(3),
            space: None,
        }
    }

    fn producer(kind: PreparationProducerKind, suffix: &str) -> PreparationProducer {
        PreparationProducer::new(
            kind,
            format!("fullmag.{}.v1", kind.as_str()),
            format!("{}.producer.v1", kind.as_str()),
            "test",
            fingerprint('a'),
            fingerprint(suffix.chars().next().unwrap_or('b')),
        )
        .unwrap()
    }

    fn plan() -> PreparationPlan {
        PreparationPlan::new(
            fingerprint('c'),
            7,
            BackendTarget::Auto,
            BackendTarget::Fdm,
            producer(PreparationProducerKind::Geometry, "d"),
            producer(PreparationProducerKind::Display, "e"),
            producer(PreparationProducerKind::Grid, "f"),
            producer(PreparationProducerKind::Mesh, "0"),
            producer(PreparationProducerKind::Space, "1"),
        )
        .unwrap()
    }

    #[test]
    fn accepted_run_plan_uses_v2_source_without_live_scene_revision() {
        let legacy = plan();
        let legacy_json = serde_json::to_value(&legacy).unwrap();
        assert_eq!(legacy_json["schema_version"], PREPARATION_PLAN_SCHEMA);
        assert_eq!(legacy_json["scene_revision"], 7);
        assert!(legacy_json.get("source").is_none());
        assert_eq!(
            serde_json::from_value::<PreparationPlan>(legacy_json).unwrap(),
            legacy,
            "the v1 Live plan payload remains readable without a migration"
        );

        let accepted = PreparationPlan::new_for_accepted_run(
            fingerprint('c'),
            PreparationPlanSource::accepted_run_step("run-1", fingerprint('b'), "step-1").unwrap(),
            BackendTarget::Auto,
            BackendTarget::Fdm,
            producer(PreparationProducerKind::Geometry, "d"),
            producer(PreparationProducerKind::Display, "e"),
            producer(PreparationProducerKind::Grid, "f"),
            producer(PreparationProducerKind::Mesh, "0"),
            producer(PreparationProducerKind::Space, "1"),
        )
        .unwrap();
        let accepted_json = serde_json::to_value(&accepted).unwrap();
        assert_eq!(
            accepted_json["schema_version"],
            PREPARATION_PLAN_ACCEPTED_RUN_SCHEMA
        );
        assert!(accepted_json.get("scene_revision").is_none());
        assert_eq!(accepted_json["source"]["kind"], "accepted_run_step");

        let mut invalid = accepted;
        invalid.scene_revision = Some(1);
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn preparation_plan_is_stable_and_contains_all_typed_producers() {
        let plan = plan();
        assert_eq!(plan.producers().len(), 5);
        assert_eq!(plan.producers()[0].kind, PreparationProducerKind::Geometry);
        assert_eq!(
            plan.canonical_json_bytes().unwrap(),
            plan.canonical_json_bytes().unwrap()
        );
        assert!(plan.canonical_sha256().unwrap().starts_with("sha256:"));
    }

    #[test]
    fn preparation_plan_rejects_mismatched_producer_slot_and_unresolved_backend() {
        let mut wrong_slot = plan();
        wrong_slot.mesh.kind = PreparationProducerKind::Grid;
        let error = wrong_slot.validate().unwrap_err();
        assert!(error.to_string().contains("requires mesh"));

        let mut unresolved = plan();
        unresolved.resolved_backend = BackendTarget::Auto;
        let error = unresolved.validate().unwrap_err();
        assert!(error.to_string().contains("resolved backend"));
    }

    #[test]
    fn fem_source_evidence_fingerprint_is_stable_and_binds_report_and_quality() {
        let mut first_report = build_report();
        let mut second_report = build_report();
        let target: fullmag_ir::FemPerObjectTargetIR =
            serde_json::from_value(serde_json::json!({})).unwrap();
        first_report
            .effective_per_object_targets
            .insert("body-a".into(), target.clone());
        first_report
            .effective_per_object_targets
            .insert("body-b".into(), target.clone());
        second_report
            .effective_per_object_targets
            .insert("body-b".into(), target.clone());
        second_report
            .effective_per_object_targets
            .insert("body-a".into(), target);

        let first_mesh = source_mesh(false);
        let second_mesh = source_mesh(true);
        let first = source_evidence(&first_mesh, Some(&first_report));
        let second = source_evidence(&second_mesh, Some(&second_report));
        assert_eq!(
            first.canonical_sha256().unwrap(),
            second.canonical_sha256().unwrap()
        );
        assert_eq!(
            first.per_domain_quality_cell_counts,
            BTreeMap::from([(1, 2), (2, 1)])
        );

        let mut changed_report = second_report;
        changed_report.build_mode = "imported_mesh".into();
        let changed = source_evidence(&second_mesh, Some(&changed_report));
        assert_ne!(
            first.canonical_sha256().unwrap(),
            changed.canonical_sha256().unwrap()
        );

        let mut changed_quality_mesh = second_mesh;
        changed_quality_mesh
            .per_domain_quality
            .get_mut(&1)
            .unwrap()
            .sicn_mean = 0.65;
        let changed_quality = source_evidence(&changed_quality_mesh, Some(&first_report));
        assert_ne!(
            first.canonical_sha256().unwrap(),
            changed_quality.canonical_sha256().unwrap()
        );
    }

    #[test]
    fn fem_source_evidence_rejects_degraded_or_misaligned_mesh_metadata() {
        let mesh = source_mesh(false);
        let canonical_mesh_fingerprint = normalize_sha256(&mesh.topology_fingerprint_v6());
        let mut degraded = build_report();
        degraded.degraded = true;
        let error = PreparationFemMeshSourceEvidence::from_mesh(
            &mesh,
            Some(&degraded),
            &canonical_mesh_fingerprint,
            &fingerprint('b'),
            3,
        )
        .unwrap_err();
        assert!(error.to_string().contains("degraded mesh build report"));

        let mut wrong_count = source_mesh(false);
        wrong_count
            .per_domain_quality
            .get_mut(&1)
            .unwrap()
            .n_elements = 1;
        let error = PreparationFemMeshSourceEvidence::from_mesh(
            &wrong_count,
            None,
            &normalize_sha256(&wrong_count.topology_fingerprint_v6()),
            &fingerprint('b'),
            3,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("element count does not match marker"));
    }

    #[test]
    fn current_fem_mesh_certificate_requires_bound_source_evidence() {
        let mesh = source_mesh(false);
        let report = build_report();
        let evidence = source_evidence(&mesh, Some(&report));
        let plan =
            fem_plan_for_source_evidence(&evidence, FEM_MESH_SOURCE_BOUND_PRODUCER_SCHEMA_VERSION);
        fem_mesh_certificate(&plan, Some(evidence.clone()))
            .validate_for(&plan)
            .unwrap();

        let error = fem_mesh_certificate(&plan, None)
            .validate_for(&plan)
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("requires versioned source evidence"));

        let mut rebound = evidence;
        rebound.mfem_topology_fingerprint = fingerprint('9');
        let error = fem_mesh_certificate(&plan, Some(rebound))
            .validate_for(&plan)
            .unwrap_err();
        assert!(error.to_string().contains("different MFEM mesh topology"));
    }

    #[test]
    fn legacy_fem_mesh_receipts_remain_readable_without_source_evidence() {
        let mesh = source_mesh(false);
        let evidence = source_evidence(&mesh, None);
        let plan = fem_plan_for_source_evidence(&evidence, NATIVE_FEM_MESH_SPACE_SCHEMA_VERSION);
        fem_mesh_certificate(&plan, None)
            .validate_for(&plan)
            .unwrap();
    }

    #[test]
    fn existing_fdm_grid_certificate_is_wrapped_without_changing_its_digest() {
        let certificate =
            FdmGridCertificateIR::new([0.0; 3], [2, 2, 1], [1.0e-9; 3], 4, 1024).unwrap();
        let producer =
            PreparationProducer::from_fdm_grid_certificate(fingerprint('a'), "test", &certificate)
                .unwrap();
        assert_eq!(
            producer.output_fingerprint,
            format!("sha256:{}", certificate.grid_fingerprint)
        );
        assert_eq!(producer.kind, PreparationProducerKind::Grid);
    }

    #[test]
    fn quality_and_space_certificates_preserve_fdm_and_describe_fem_explicitly() {
        let legacy_fdm_quality: PreparationQualityCertificate =
            serde_json::from_value(serde_json::json!({
                "cell_count": 4,
                "invalid_cell_count": 0,
                "min_quality": 0.2,
                "max_aspect_ratio": 3.0,
                "quality_fingerprint": fingerprint('a'),
            }))
            .unwrap();
        legacy_fdm_quality.validate().unwrap();

        let fem_quality = PreparationQualityCertificate {
            cell_count: 1,
            invalid_cell_count: 0,
            min_quality: None,
            max_aspect_ratio: None,
            jacobian: Some(PreparationJacobianQualityCertificate {
                sample_count: 4,
                min_determinant: 1.0e-27,
                max_determinant: 1.0e-27,
            }),
            quality_fingerprint: fingerprint('b'),
            mesh_source: None,
        };
        fem_quality.validate().unwrap();

        let fem_space = PreparationSpaceCertificate {
            mesh_fingerprint: fingerprint('c'),
            marker_map_fingerprint: Some(fingerprint('d')),
            dof_count: 4,
            space_fingerprint: fingerprint('e'),
            fe_family: Some("H1".into()),
            fe_order: Some(1),
            local_dof_count: Some(4),
            true_dof_count: Some(4),
        };
        fem_space.validate().unwrap();
        let mut partial_space = fem_space;
        partial_space.fe_order = None;
        assert!(partial_space.validate().is_err());
    }

    #[test]
    fn mesh_and_space_certificates_require_matching_quality_markers_and_topology() {
        let plan = plan();
        let marker_fingerprint = fingerprint('e');
        let mesh_certificate = PreparationCertificate {
            schema_version: PREPARATION_CERTIFICATE_SCHEMA.into(),
            producer: plan.mesh.clone(),
            quality: Some(PreparationQualityCertificate {
                cell_count: 8,
                invalid_cell_count: 0,
                min_quality: Some(0.25),
                max_aspect_ratio: Some(4.0),
                jacobian: None,
                quality_fingerprint: fingerprint('f'),
                mesh_source: None,
            }),
            marker_map: Some(PreparationMarkerCertificate {
                marker_map_fingerprint: marker_fingerprint.clone(),
                marker_ids: vec![1, 2],
            }),
            cell_count: Some(8),
            space: None,
        };
        mesh_certificate.validate_for(&plan).unwrap();

        let mut space_certificate = PreparationCertificate {
            schema_version: PREPARATION_CERTIFICATE_SCHEMA.into(),
            producer: plan.space.clone(),
            quality: None,
            marker_map: Some(PreparationMarkerCertificate {
                marker_map_fingerprint: marker_fingerprint.clone(),
                marker_ids: vec![1, 2],
            }),
            cell_count: None,
            space: Some(PreparationSpaceCertificate {
                mesh_fingerprint: plan.mesh.output_fingerprint.clone(),
                marker_map_fingerprint: Some(marker_fingerprint),
                dof_count: 16,
                space_fingerprint: plan.space.output_fingerprint.clone(),
                fe_family: None,
                fe_order: None,
                local_dof_count: None,
                true_dof_count: None,
            }),
        };
        space_certificate.validate_for(&plan).unwrap();
        space_certificate.space.as_mut().unwrap().mesh_fingerprint = fingerprint('9');
        let error = space_certificate.validate_for(&plan).unwrap_err();
        assert!(error.to_string().contains("different mesh fingerprint"));
    }

    #[test]
    fn selective_reuse_is_per_producer_and_does_not_promote_space() {
        let previous = plan();
        let mut current = plan();
        current.space.producer_version = "space-v2".into();
        let decisions = assess_selective_reuse(&previous, &current).unwrap();
        let mesh = decisions
            .iter()
            .find(|decision| decision.kind == PreparationProducerKind::Mesh)
            .unwrap();
        let space = decisions
            .iter()
            .find(|decision| decision.kind == PreparationProducerKind::Space)
            .unwrap();
        assert_eq!(mesh.disposition, PreparationReuseDisposition::Reuse);
        assert_eq!(space.disposition, PreparationReuseDisposition::Rebuild);
        assert_eq!(space.reason, Some(PreparationReuseReason::VersionChanged));
    }

    #[test]
    fn state_transfer_is_explicit_and_rejects_display_artifacts() {
        let transfer = PreparationStateTransfer {
            schema_version: PREPARATION_STATE_TRANSFER_SCHEMA.into(),
            source_kind: PreparationProducerKind::Grid,
            target_kind: PreparationProducerKind::Mesh,
            source_fingerprint: fingerprint('a'),
            target_fingerprint: fingerprint('b'),
            mapping_fingerprint: fingerprint('c'),
        };
        transfer.validate().unwrap();

        let mut invalid = transfer;
        invalid.source_kind = PreparationProducerKind::Display;
        let error = invalid.validate().unwrap_err();
        assert!(error.to_string().contains("state transfer"));
    }

    fn fdm_execution_plan_fixture() -> fullmag_ir::ExecutionPlanIR {
        let active_mask = [true, true, false, true];
        let region_mask = [1, 1, 0, 2];
        let certificate = fullmag_ir::FdmGridCertificateIR::new_with_masks(
            [0.0; 3],
            [2, 2, 1],
            [1.0e-9, 2.0e-9, 1.0e-9],
            3,
            1024,
            Some(&active_mask),
            &region_mask,
        )
        .unwrap()
        .with_region_legend(vec![
            fullmag_ir::FdmRegionLegendEntryIR {
                numeric_id: 1,
                object_id: "body-a".into(),
                region_id: "body-a:core".into(),
                priority: 0,
            },
            fullmag_ir::FdmRegionLegendEntryIR {
                numeric_id: 2,
                object_id: "body-b".into(),
                region_id: "body-b:core".into(),
                priority: 1,
            },
        ]);
        let mut fdm = fullmag_ir::FdmPlanIR::default();
        fdm.grid = fullmag_ir::GridDimensions { cells: [2, 2, 1] };
        fdm.cell_size = [1.0e-9, 2.0e-9, 1.0e-9];
        fdm.grid_certificate = Some(certificate);
        fdm.active_mask = Some(active_mask.to_vec());
        fdm.region_mask = region_mask.to_vec();
        fullmag_ir::ExecutionPlanIR {
            common: fullmag_ir::CommonPlanMeta {
                ir_version: fullmag_ir::IR_VERSION.into(),
                requested_backend: fullmag_ir::BackendTarget::Auto,
                resolved_backend: fullmag_ir::BackendTarget::Fdm,
                execution_mode: fullmag_ir::ExecutionMode::Strict,
                material_field_plans: Vec::new(),
            },
            backend_plan: fullmag_ir::BackendPlanIR::Fdm(fdm),
            output_plan: fullmag_ir::OutputPlanIR {
                outputs: Vec::new(),
            },
            provenance: fullmag_ir::ProvenancePlanIR::default(),
        }
    }

    fn fem_mesh_fixture() -> MeshIR {
        MeshIR::from_legacy_tet4(
            "preparation-tet".into(),
            vec![
                [0.0, 0.0, 0.0],
                [1.0e-9, 0.0, 0.0],
                [0.0, 1.0e-9, 0.0],
                [0.0, 0.0, 1.0e-9],
            ],
            vec![[0, 1, 2, 3]],
            vec![7],
            vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
            vec![11, 12, 13, 14],
            Vec::new(),
            Vec::new(),
            std::collections::HashMap::new(),
        )
    }

    fn fem_execution_plan_fixture(mesh: MeshIR, fe_order: u32) -> ExecutionPlanIR {
        let mut fem = fullmag_ir::FemPlanIR::default();
        fem.mesh_name = mesh.mesh_name.clone();
        fem.mesh = mesh;
        fem.fe_order = fe_order;
        ExecutionPlanIR {
            common: fullmag_ir::CommonPlanMeta {
                ir_version: fullmag_ir::IR_VERSION.into(),
                requested_backend: BackendTarget::Auto,
                resolved_backend: BackendTarget::Fem,
                execution_mode: fullmag_ir::ExecutionMode::Strict,
                material_field_plans: Vec::new(),
            },
            backend_plan: BackendPlanIR::Fem(fem),
            output_plan: fullmag_ir::OutputPlanIR {
                outputs: Vec::new(),
            },
            provenance: fullmag_ir::ProvenancePlanIR::default(),
        }
    }

    fn native_fem_mesh_space_evidence(mesh: &MeshIR, fe_order: u32) -> NativeFemMeshSpaceEvidence {
        NativeFemMeshSpaceEvidence {
            abi_version: NATIVE_FEM_MESH_SPACE_ABI_VERSION,
            producer_id: NATIVE_FEM_MESH_SPACE_PRODUCER_ID.into(),
            schema_version: NATIVE_FEM_MESH_SPACE_SCHEMA_VERSION.into(),
            producer_version: NATIVE_FEM_MESH_SPACE_PRODUCER_VERSION.into(),
            mesh_matches_canonical_input: true,
            canonical_mesh_fingerprint: normalize_sha256(&mesh.topology_fingerprint_v6()),
            topology_fingerprint: fingerprint('8'),
            marker_map_fingerprint: fingerprint('9'),
            quality_fingerprint: fingerprint('a'),
            space_fingerprint: fingerprint('b'),
            mesh_dimension: 3,
            fe_family: "H1".into(),
            fe_order,
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

    #[test]
    fn fdm_materialization_emits_all_producers_without_fem_claims() {
        let execution_plan = fdm_execution_plan_fixture();
        let materialized = PreparationMaterialization::from_fdm_execution_plan(
            fingerprint('a'),
            7,
            fullmag_ir::BackendTarget::Auto,
            &execution_plan,
            fingerprint('b'),
            fingerprint('c'),
        )
        .unwrap();

        assert_eq!(
            materialized.plan.resolved_backend,
            fullmag_ir::BackendTarget::Fdm
        );
        assert_eq!(materialized.certificates.len(), 5);
        assert_eq!(
            materialized.plan.mesh.producer_id,
            "fullmag.fdm.cell_domain"
        );
        assert_eq!(
            materialized.plan.space.producer_id,
            "fullmag.fdm.grid_space"
        );
        assert!(materialized
            .certificates
            .iter()
            .all(|certificate| certificate.validate_for(&materialized.plan).is_ok()));
    }

    #[test]
    fn fdm_materialization_rejects_missing_grid_evidence() {
        let mut execution_plan = fdm_execution_plan_fixture();
        if let fullmag_ir::BackendPlanIR::Fdm(plan) = &mut execution_plan.backend_plan {
            plan.grid_certificate = None;
        }
        let error = PreparationMaterialization::from_fdm_execution_plan(
            fingerprint('a'),
            7,
            fullmag_ir::BackendTarget::Auto,
            &execution_plan,
            fingerprint('b'),
            fingerprint('c'),
        )
        .unwrap_err();
        assert!(error.to_string().contains("missing its grid certificate"));
    }

    #[test]
    fn fem_materialization_emits_mesh_and_h1_space_certificates_bound_to_native_evidence() {
        let mesh = fem_mesh_fixture();
        let execution_plan = fem_execution_plan_fixture(mesh.clone(), 1);
        let native = native_fem_mesh_space_evidence(&mesh, 1);
        let materialized = PreparationMaterialization::from_fem_execution_plan(
            fingerprint('a'),
            7,
            BackendTarget::Auto,
            &execution_plan,
            fingerprint('c'),
            fingerprint('d'),
            &native,
        )
        .expect("matching native FEM evidence should materialize a complete plan");

        assert_eq!(materialized.plan.resolved_backend, BackendTarget::Fem);
        assert_eq!(
            materialized.plan.mesh.output_fingerprint,
            native.topology_fingerprint
        );
        assert_eq!(
            materialized.plan.space.output_fingerprint,
            native.space_fingerprint
        );
        assert_eq!(materialized.certificates.len(), 5);
        assert!(materialized
            .certificates
            .iter()
            .all(|certificate| certificate.validate_for(&materialized.plan).is_ok()));

        let mesh_certificate = materialized
            .certificates
            .iter()
            .find(|certificate| certificate.producer.kind == PreparationProducerKind::Mesh)
            .unwrap();
        assert_eq!(mesh_certificate.cell_count, Some(1));
        assert_eq!(
            mesh_certificate
                .quality
                .as_ref()
                .and_then(|quality| quality.mesh_source.as_ref())
                .map(|source| source.canonical_input_mesh_fingerprint.as_str()),
            Some(native.canonical_mesh_fingerprint.as_str())
        );

        let space_certificate = materialized
            .certificates
            .iter()
            .find(|certificate| certificate.producer.kind == PreparationProducerKind::Space)
            .unwrap();
        let space = space_certificate.space.as_ref().unwrap();
        assert_eq!(space.fe_family.as_deref(), Some("H1"));
        assert_eq!(space.fe_order, Some(1));
        assert_eq!(space.local_dof_count, Some(4));
        assert_eq!(space.true_dof_count, Some(4));
        assert_eq!(space.dof_count, 4);
    }

    #[test]
    fn fem_materialization_rejects_mesh_rebinding_and_unimplemented_higher_order_space() {
        let mesh = fem_mesh_fixture();
        let execution_plan = fem_execution_plan_fixture(mesh.clone(), 1);
        let mut rebound = native_fem_mesh_space_evidence(&mesh, 1);
        rebound.canonical_mesh_fingerprint = fingerprint('f');
        let error = PreparationMaterialization::from_fem_execution_plan(
            fingerprint('a'),
            7,
            BackendTarget::Auto,
            &execution_plan,
            fingerprint('c'),
            fingerprint('d'),
            &rebound,
        )
        .unwrap_err();
        assert!(error.to_string().contains("different canonical mesh"));

        let higher_order_plan = fem_execution_plan_fixture(mesh.clone(), 2);
        let higher_order_evidence = native_fem_mesh_space_evidence(&mesh, 2);
        let error = PreparationMaterialization::from_fem_execution_plan(
            fingerprint('a'),
            7,
            BackendTarget::Auto,
            &higher_order_plan,
            fingerprint('c'),
            fingerprint('d'),
            &higher_order_evidence,
        )
        .unwrap_err();
        assert!(error.to_string().contains("resolved 3D H1 order-1 space"));
    }
}
