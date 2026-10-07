use crate::{
    AntennaFieldSolutionAsset, AntennaFieldSolutionSignatures, AntennaFieldSolveResult,
    AuxiliaryArtifact, RunError,
};
use crate::antenna_field_solution::AntennaDependencySignatures;
use fullmag_ir::{
    AntennaFieldSolutionRefIR, AntennaFieldSolvePlanIR, FieldTargetIR,
    ResolvedFemConservativeCurrentViewIR, ANTENNA_FIELD_SOLVE_PLAN_SCHEMA_VERSION,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const SOLUTION_MANIFEST_NAME: &str = "manifest.v1.json";

/// A published reference plus the dependencies required by the current model.
/// Content integrity and model currency are separate checks.
#[derive(Debug, Clone)]
pub struct ExpectedAntennaSolution {
    pub reference: AntennaFieldSolutionRefIR,
    pub current_solution_signature: String,
    pub field_solution_signature: String,
    pub target_projection_signatures: BTreeMap<String, String>,
    pub dependency_signatures: Option<AntennaDependencySignatures>,
    pub geometry_revision: Option<String>,
    pub material_revision: Option<String>,
    pub mesh_digest: Option<String>,
}

impl ExpectedAntennaSolution {
    pub fn new(
        reference: AntennaFieldSolutionRefIR,
        signatures: AntennaFieldSolutionSignatures,
    ) -> Self {
        Self {
            reference,
            current_solution_signature: signatures.current_solution_signature,
            field_solution_signature: signatures.field_solution_signature,
            target_projection_signatures: signatures.target_projection_signatures,
            dependency_signatures: signatures.dependency_signatures,
            geometry_revision: None,
            material_revision: None,
            mesh_digest: None,
        }
    }

    pub fn with_source_revisions(
        mut self,
        geometry_revision: String,
        material_revision: String,
        mesh_digest: String,
    ) -> Self {
        self.geometry_revision = Some(geometry_revision);
        self.material_revision = Some(material_revision);
        self.mesh_digest = Some(mesh_digest);
        self
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AntennaFieldStageStatus {
    Missing,
    Queued,
    Meshing,
    SolvingCurrent,
    EvaluatingField,
    ProjectingTargets,
    Ready,
    Cancelled,
    Failed,
    Stale,
    Degraded,
}

impl AntennaFieldStageStatus {
    pub fn can_transition_to(self, next: Self) -> bool {
        use AntennaFieldStageStatus::*;
        matches!(
            (self, next),
            (Missing, Queued | Stale)
                | (Queued, Meshing)
                // A verified immutable asset can skip the solve stages and
                // enter the projection boundary directly.  The diagnostic
                // on the transition carries the explicit reuse reason.
                | (Queued, ProjectingTargets)
                | (Meshing, SolvingCurrent)
                | (SolvingCurrent, EvaluatingField)
                | (EvaluatingField, ProjectingTargets)
                | (ProjectingTargets, Ready | Degraded)
                | (Ready | Degraded, Stale)
                | (Stale | Cancelled | Failed, Queued)
                | (
                    Queued | Meshing | SolvingCurrent | EvaluatingField | ProjectingTargets,
                    Cancelled | Failed
                )
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AntennaFieldStageTransition {
    pub from: AntennaFieldStageStatus,
    pub to: AntennaFieldStageStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AntennaFieldStageState {
    pub stage_id: String,
    pub solution_id: String,
    pub status: AntennaFieldStageStatus,
    #[serde(default)]
    pub transitions: Vec<AntennaFieldStageTransition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signatures: Option<AntennaFieldSolutionSignatures>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

impl AntennaFieldStageState {
    pub fn transition(
        &mut self,
        next: AntennaFieldStageStatus,
        diagnostic: Option<String>,
    ) -> Result<(), RunError> {
        if !self.status.can_transition_to(next) {
            return Err(RunError {
                message: format!(
                    "invalid antenna field stage transition {:?} -> {:?}",
                    self.status, next
                ),
            });
        }
        self.transitions.push(AntennaFieldStageTransition {
            from: self.status,
            to: next,
            diagnostic: diagnostic.clone(),
        });
        self.status = next;
        self.diagnostic = diagnostic;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedAntennaFieldSolution {
    pub reference: AntennaFieldSolutionRefIR,
    pub manifest_path: PathBuf,
    pub signatures: AntennaFieldSolutionSignatures,
    pub reused_existing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AntennaFieldSolutionCacheState {
    Missing,
    Stale {
        expected_asset_id: String,
        cached_asset_id: String,
        manifest_path: PathBuf,
    },
    Ready(PublishedAntennaFieldSolution),
}

fn sha256_json(value: &impl Serialize, label: &str) -> Result<String, RunError> {
    let bytes = serde_json::to_vec(value).map_err(|error| RunError {
        message: format!("serialize {label}: {error}"),
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn target_key(target: &FieldTargetIR) -> String {
    match target {
        FieldTargetIR::Global {} => "global".into(),
        FieldTargetIR::Object { object_id } => format!("object:{object_id}"),
        FieldTargetIR::Region {
            object_id,
            region_id,
        } => format!("region:{object_id}:{region_id}"),
    }
}

fn static_conservative_current_view_dependencies(
    view: &ResolvedFemConservativeCurrentViewIR,
) -> serde_json::Value {
    serde_json::json!({
        "stable_vertex_ids": view.stable_vertex_ids,
        "boundary_faces": view.boundary_faces,
        "identity": {
            "source_module_id": view.identity.source_module_id,
            "source_state_revision": view.identity.source_state_revision,
            "source_field_digest": view.identity.source_field_digest,
            "conductivity_digest": view.identity.conductivity_digest,
            "mesh_revision": view.identity.mesh_revision,
            "topology_revision": view.identity.topology_revision,
            "geometry_digest": view.identity.geometry_digest,
        },
        "pins": view.pins,
        "closure": view.closure,
        "algebraic_relative_tolerance": view.algebraic_relative_tolerance,
        "physical_relative_gate": view.physical_relative_gate,
        "physical_absolute_gate_a": view.physical_absolute_gate_a,
    })
}

pub fn antenna_field_solution_signatures(
    plan: &AntennaFieldSolvePlanIR,
) -> Result<AntennaFieldSolutionSignatures, RunError> {
    if plan.schema_version != ANTENNA_FIELD_SOLVE_PLAN_SCHEMA_VERSION {
        return Err(RunError {
            message: format!(
                "unsupported antenna field-solve plan schema '{}'",
                plan.schema_version
            ),
        });
    }
    if plan.conductor.charge_transport_plans.len() != 1 {
        return Err(RunError {
            message: "antenna field signatures require exactly one charge transport plan".into(),
        });
    }
    let mut charge_transport = plan.conductor.charge_transport_plans[0].clone();
    let request = charge_transport
        .antenna_field_solution_request
        .take()
        .ok_or_else(|| RunError {
            message: "antenna field signatures require a bound field-solution request".into(),
        })?;
    if request.stage_id != plan.stage_id
        || request.solution_id != plan.solution_id
        || request.source_object_id != plan.source_object_id
        || request.port_mode_id != plan.port_mode_id
    {
        return Err(RunError {
            message: "antenna field signature identity disagrees with the bound request".into(),
        });
    }
    let fem_charge = charge_transport
        .fem_cpu_double
        .as_ref()
        .ok_or_else(|| RunError {
            message: "antenna field signatures require a resolved FEM charge descriptor".into(),
        })?;
    let mut current_definition = fem_charge.charge_definition.clone();
    current_definition.conservative_current_view = None;

    // The H1 charge solve is independent of the subsequent conservative RT0
    // reconstruction and its closure. Execution selection and time envelopes
    // are likewise not dependencies of the normalized static current basis.
    let current_solution_signature = sha256_json(
        &serde_json::json!({
            "schema": "antenna_current_solution_signature.v4",
            "source_object_id": plan.source_object_id,
            "port_mode_id": plan.port_mode_id,
            "current_transport_id": charge_transport.module_id,
            "branches": request.branches,
            "geometry_revision": request.geometry_revision,
            "material_revision": request.material_revision,
            "mesh_digest": request.mesh_digest,
            "conductor_mesh": plan.conductor.mesh,
            "object_segments": plan.conductor.object_segments,
            "mesh_parts": plan.conductor.mesh_parts,
            "fe_order": plan.conductor.fe_order,
            "hmax": plan.conductor.hmax,
            "operator_version": charge_transport.operator_version,
            "physical_residual_version": charge_transport.physical_residual_version,
            "charge_definition": current_definition,
            "charge_domain": fem_charge.charge_domain,
            "charge_insulating_boundaries": fem_charge.charge_insulating_boundaries,
            "charge_driven_boundaries": fem_charge.charge_driven_boundaries,
            "charge_conductivity_spm_per_element": fem_charge.charge_conductivity_spm_per_element,
            "charge_gauge": fem_charge.charge_gauge,
            "charge_solver": fem_charge.charge_solver,
            "charge_dirichlet": fem_charge.charge_dirichlet,
            "resolved_charge_engine": fem_charge.resolved_charge_engine,
        }),
        "antenna current-solution signature",
    )?;
    let oersted_numerical_policy = match plan.conductor.oersted_realization {
        fullmag_ir::OerstedRealization::BiotSavartMidpoint => serde_json::json!({
            "operator_version": fullmag_ir::ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION,
            "base_quadrature_order": fullmag_ir::ANTENNA_DIRECT_OERSTED_BASE_QUADRATURE_ORDER,
            "maximum_subdivision_depth": fullmag_ir::ANTENNA_DIRECT_OERSTED_MAX_SUBDIVISION_DEPTH,
            "absolute_tolerance_apm": fullmag_ir::ANTENNA_DIRECT_OERSTED_ABSOLUTE_TOLERANCE_APM,
            "relative_tolerance": fullmag_ir::ANTENNA_DIRECT_OERSTED_RELATIVE_TOLERANCE,
            "maximum_source_target_pairs": fullmag_ir::ANTENNA_DIRECT_OERSTED_MAX_SOURCE_TARGET_PAIRS,
        }),
        fullmag_ir::OerstedRealization::FemVectorPotential => serde_json::json!({
            "operator_version": fullmag_ir::ANTENNA_VECTOR_POTENTIAL_OPERATOR_VERSION,
            "boundary_gauge": fullmag_ir::ANTENNA_VECTOR_POTENTIAL_BOUNDARY_GAUGE,
            "mu0_si": fullmag_ir::ANTENNA_VECTOR_POTENTIAL_MU0_SI,
            "relative_tolerance": fullmag_ir::ANTENNA_VECTOR_POTENTIAL_RELATIVE_TOLERANCE,
            "maximum_nd_dofs": fullmag_ir::ANTENNA_VECTOR_POTENTIAL_MAX_ND_DOFS,
            "maximum_h1_dofs": fullmag_ir::ANTENNA_VECTOR_POTENTIAL_MAX_H1_DOFS,
        }),
        fullmag_ir::OerstedRealization::InfiniteCylinder => {
            return Err(RunError {
                message: "antenna field signatures do not support the infinite-cylinder Oersted realization".into(),
            });
        }
    };
    let field_solution_signature = sha256_json(
        &serde_json::json!({
            "schema": "antenna_field_solution_signature.v2",
            "current_solution_signature": current_solution_signature,
            "conservative_current_view": fem_charge.conservative_current_view
                .as_ref()
                .map(static_conservative_current_view_dependencies),
            "oersted_realization": plan.conductor.oersted_realization,
            "oersted_numerical_policy": oersted_numerical_policy,
            "sampling": plan.field_sampling,
        }),
        "antenna field-solution signature",
    )?;
    let mut target_projection_signatures = BTreeMap::new();
    for target in &plan.target_refs {
        let key = target_key(target);
        if target_projection_signatures.contains_key(&key) {
            return Err(RunError {
                message: format!("duplicate antenna target projection '{key}'"),
            });
        }
        let signature = sha256_json(
            &serde_json::json!({
                "schema": "antenna_target_projection_signature.v1",
                "field_solution_signature": field_solution_signature,
                "sampling_topology_digest": plan.field_sampling.topology_digest,
                "target": target,
                "projection_method": "identity_or_target_mask.v1",
            }),
            "antenna target-projection signature",
        )?;
        target_projection_signatures.insert(key, signature);
    }
    let dependency_signatures = AntennaDependencySignatures {
        terminal: sha256_json(
            &serde_json::json!({
                "branches": request.branches,
                "charge_definition": current_definition,
                "charge_insulating_boundaries": fem_charge.charge_insulating_boundaries,
                "charge_driven_boundaries": fem_charge.charge_driven_boundaries,
                "charge_dirichlet": fem_charge.charge_dirichlet,
            }),
            "antenna terminal dependencies",
        )?,
        solver: sha256_json(
            &serde_json::json!({
                "operator_version": charge_transport.operator_version,
                "physical_residual_version": charge_transport.physical_residual_version,
                "charge_gauge": fem_charge.charge_gauge,
                "charge_solver": fem_charge.charge_solver,
                "resolved_charge_engine": fem_charge.resolved_charge_engine,
                "conservative_current_view": fem_charge.conservative_current_view
                    .as_ref()
                    .map(static_conservative_current_view_dependencies),
                "oersted_realization": plan.conductor.oersted_realization,
                "oersted_numerical_policy": oersted_numerical_policy,
            }),
            "antenna solver dependencies",
        )?,
        sampling: sha256_json(&plan.field_sampling, "antenna sampling dependencies")?,
    };
    Ok(AntennaFieldSolutionSignatures {
        current_solution_signature,
        field_solution_signature,
        target_projection_signatures,
        dependency_signatures: Some(dependency_signatures),
    })
}

pub fn antenna_field_solution_asset_id(signatures: &AntennaFieldSolutionSignatures) -> String {
    let digest = signatures
        .field_solution_signature
        .strip_prefix("sha256:")
        .unwrap_or(&signatures.field_solution_signature);
    format!("afs-{digest}")
}

/// Inspect the immutable source field for a plan without hiding stale revisions.
/// Target projection signatures are resolved separately against the LLG mesh;
/// changing a target does not invalidate the current/field asset. A malformed
/// or tampered asset is an error, while changed source dependencies are stale.
pub fn inspect_cached_antenna_field_solution(
    output_root: &Path,
    plan: &AntennaFieldSolvePlanIR,
) -> Result<AntennaFieldSolutionCacheState, RunError> {
    let signatures = antenna_field_solution_signatures(plan)?;
    let asset_id = antenna_field_solution_asset_id(&signatures);
    validate_storage_id("antenna solution_id", &plan.solution_id)?;
    validate_storage_id("antenna asset_id", &asset_id)?;
    let revision_dir = output_root
        .join(solution_prefix(&plan.solution_id))
        .join(&asset_id);
    let legacy_dir = output_root.join(solution_prefix(&plan.solution_id));
    let manifest_path = if revision_dir.join(SOLUTION_MANIFEST_NAME).exists() {
        revision_dir.join(SOLUTION_MANIFEST_NAME)
    } else if legacy_dir.join(SOLUTION_MANIFEST_NAME).exists() {
        legacy_dir.join(SOLUTION_MANIFEST_NAME)
    } else {
        let mut older_revisions = Vec::new();
        if legacy_dir.is_dir() {
            for entry in fs::read_dir(&legacy_dir).map_err(|error| RunError {
                message: format!(
                    "read antenna solution revisions '{}': {error}",
                    legacy_dir.display()
                ),
            })? {
                let entry = entry.map_err(|error| RunError {
                    message: format!("read antenna solution revision entry: {error}"),
                })?;
                if entry.file_type().map_err(|error| RunError {
                    message: format!("inspect antenna solution revision entry: {error}"),
                })?.is_dir() {
                    let candidate = entry.path().join(SOLUTION_MANIFEST_NAME);
                    if candidate.is_file() {
                        older_revisions.push(candidate);
                    }
                }
            }
        }
        older_revisions.sort();
        let Some(manifest_path) = older_revisions.into_iter().next() else {
            return Ok(AntennaFieldSolutionCacheState::Missing);
        };
        manifest_path
    };
    let manifest_bytes = fs::read(&manifest_path).map_err(|error| RunError {
        message: format!(
            "read cached antenna field-solution manifest '{}': {error}",
            manifest_path.display()
        ),
    })?;
    crate::antenna_field_solution::verify_antenna_field_solution_manifest(&manifest_bytes)?;
    let value: serde_json::Value =
        serde_json::from_slice(&manifest_bytes).map_err(|error| RunError {
            message: format!(
                "parse cached antenna field-solution manifest '{}': {error}",
                manifest_path.display()
            ),
        })?;
    let Some(content_digest) = value
        .get("content_digest")
        .and_then(serde_json::Value::as_str)
    else {
        return Err(RunError {
            message: "cached antenna field-solution manifest has no content_digest".into(),
        });
    };
    let Some(cached_asset_id) = value.get("asset_id").and_then(serde_json::Value::as_str) else {
        return Err(RunError {
            message: "cached antenna field-solution manifest has no asset_id".into(),
        });
    };
    let cached_signatures: AntennaFieldSolutionSignatures =
        serde_json::from_value(value.get("signatures").cloned().ok_or_else(|| RunError {
            message: "cached antenna field-solution manifest has no signatures".into(),
        })?)
        .map_err(|error| RunError {
            message: format!("validate cached antenna field-solution signatures: {error}"),
        })?;
    if cached_asset_id != asset_id
        || cached_signatures.current_solution_signature != signatures.current_solution_signature
        || cached_signatures.field_solution_signature != signatures.field_solution_signature
    {
        return Ok(AntennaFieldSolutionCacheState::Stale {
            expected_asset_id: asset_id,
            cached_asset_id: cached_asset_id.to_string(),
            manifest_path,
        });
    }
    let reference = AntennaFieldSolutionRefIR {
        stage_id: plan.stage_id.clone(),
        output_id: plan.solution_id.clone(),
        asset_id,
        content_digest: content_digest.to_string(),
    };
    // Signature construction already validates the single bound request. A
    // cache hit must satisfy the same source-currency gate as a consumer, not
    // only the immutable asset's self-reported signatures and byte digest.
    let request = plan.conductor.charge_transport_plans[0]
        .antenna_field_solution_request
        .as_ref()
        .ok_or_else(|| RunError {
            message: "antenna cache expectation requires a bound field-solution request".into(),
        })?;
    let expected = ExpectedAntennaSolution::new(reference.clone(), signatures)
        .with_source_revisions(
            request.geometry_revision.clone(),
            request.material_revision.clone(),
            request.mesh_digest.clone(),
        );
    let asset = load_expected_antenna_field_solution(output_root, &expected)?;
    if asset.manifest_bytes != manifest_bytes {
        return Err(RunError {
            message: "cached antenna field-solution manifest changed while reopening asset".into(),
        });
    }
    Ok(AntennaFieldSolutionCacheState::Ready(
        PublishedAntennaFieldSolution {
            reference,
            manifest_path,
            signatures: cached_signatures,
            reused_existing: true,
        },
    ))
}

/// Reopen an immutable solution only when its current and field signatures are
/// still current. The compatibility helper intentionally maps a stale
/// revision to `None`; callers that publish lifecycle state should use
/// [`inspect_cached_antenna_field_solution`] instead.
pub fn load_cached_antenna_field_solution(
    output_root: &Path,
    plan: &AntennaFieldSolvePlanIR,
) -> Result<Option<PublishedAntennaFieldSolution>, RunError> {
    match inspect_cached_antenna_field_solution(output_root, plan)? {
        AntennaFieldSolutionCacheState::Ready(solution) => Ok(Some(solution)),
        AntennaFieldSolutionCacheState::Missing | AntennaFieldSolutionCacheState::Stale { .. } => {
            Ok(None)
        }
    }
}

fn validate_relative_path(path: &Path, display: &str) -> Result<(), RunError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(RunError {
            message: format!("refusing unsafe antenna artifact path '{display}'"),
        });
    }
    Ok(())
}

fn validate_storage_id(label: &str, value: &str) -> Result<(), RunError> {
    let mut components = Path::new(value).components();
    let one_normal =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    if value.trim().is_empty() || !one_normal || value.contains('/') || value.contains('\\') {
        return Err(RunError {
            message: format!("{label} must be one safe path component"),
        });
    }
    Ok(())
}

fn solution_prefix(solution_id: &str) -> PathBuf {
    Path::new("antenna")
        .join("field_solutions")
        .join(solution_id)
}

fn physical_solution_revision_dir(output_root: &Path, output_id: &str, asset_id: &str) -> PathBuf {
    output_root.join(solution_prefix(output_id)).join(asset_id)
}

fn solution_artifacts<'a>(
    result: &'a AntennaFieldSolveResult,
) -> Result<Vec<(&'a AuxiliaryArtifact, PathBuf)>, RunError> {
    validate_storage_id("antenna solution_id", &result.solution_id)?;
    let prefix = solution_prefix(&result.solution_id);
    validate_relative_path(&prefix, &prefix.display().to_string())?;
    let mut seen = BTreeSet::new();
    let mut selected = Vec::new();
    for artifact in &result.auxiliary_artifacts {
        let full = Path::new(&artifact.relative_path);
        validate_relative_path(full, &artifact.relative_path)?;
        let Ok(relative) = full.strip_prefix(&prefix) else {
            continue;
        };
        validate_relative_path(relative, &artifact.relative_path)?;
        let key = relative.to_string_lossy().replace('\\', "/");
        if !seen.insert(key) {
            return Err(RunError {
                message: "duplicate antenna field-solution artifact path".into(),
            });
        }
        selected.push((artifact, relative.to_path_buf()));
    }
    if !selected
        .iter()
        .any(|(_, path)| path == Path::new(SOLUTION_MANIFEST_NAME))
    {
        return Err(RunError {
            message: "antenna field-solve result has no manifest.v1.json".into(),
        });
    }
    Ok(selected)
}

fn manifest_metadata(
    result: &AntennaFieldSolveResult,
) -> Result<(String, AntennaFieldSolutionSignatures), RunError> {
    if result.schema_version != "antenna_field_solve_result.v1"
        || result.stage_id.trim().is_empty()
        || result.port_mode_id.trim().is_empty()
        || result.field_solution.solution_id != result.solution_id
        || result.field_solution.port_mode_id != result.port_mode_id
        || result.field_solution.content_digest.is_empty()
    {
        return Err(RunError {
            message: "antenna field-solve result identity or schema is inconsistent".into(),
        });
    }
    let selected = solution_artifacts(result)?;
    let manifest_bytes = selected
        .iter()
        .find(|(_, path)| path == Path::new(SOLUTION_MANIFEST_NAME))
        .map(|(artifact, _)| artifact.bytes.clone())
        .expect("manifest presence was checked");
    let payloads = selected
        .into_iter()
        .filter(|(_, path)| path != Path::new(SOLUTION_MANIFEST_NAME))
        .map(|(artifact, _)| artifact.clone())
        .collect::<Vec<_>>();
    crate::verify_antenna_field_solution_asset(&manifest_bytes, &payloads)?;
    let value: serde_json::Value =
        serde_json::from_slice(&manifest_bytes).map_err(|error| RunError {
            message: format!("parse antenna field-solution manifest: {error}"),
        })?;
    let asset_id = value
        .get("asset_id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RunError {
            message: "antenna field-solution manifest has no asset_id".into(),
        })?
        .to_string();
    validate_storage_id("antenna asset_id", &asset_id)?;
    if value.get("status").and_then(serde_json::Value::as_str) != Some("ready")
        || value.get("solution_id").and_then(serde_json::Value::as_str)
            != Some(result.solution_id.as_str())
        || value.get("stage_id").and_then(serde_json::Value::as_str)
            != Some(result.stage_id.as_str())
        || value
            .get("source_object_id")
            .and_then(serde_json::Value::as_str)
            != Some(result.field_solution.source_object_id.as_str())
        || value
            .get("content_digest")
            .and_then(serde_json::Value::as_str)
            != Some(result.field_solution.content_digest.as_str())
        || !value
            .get("bases")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|bases| {
                bases.iter().any(|basis| {
                    basis
                        .get("port_mode_id")
                        .and_then(serde_json::Value::as_str)
                        == Some(result.port_mode_id.as_str())
                })
            })
    {
        return Err(RunError {
            message: "only a ready, identity-consistent antenna field solution may be published"
                .into(),
        });
    }
    let signatures =
        serde_json::from_value(value.get("signatures").cloned().ok_or_else(|| RunError {
            message: "antenna field-solution manifest has no signatures".into(),
        })?)
        .map_err(|error| RunError {
            message: format!("validate antenna field-solution signatures: {error}"),
        })?;
    Ok((asset_id, signatures))
}

fn write_solution_directory(
    temporary: &Path,
    artifacts: &[(&AuxiliaryArtifact, PathBuf)],
) -> Result<(), RunError> {
    fs::create_dir(temporary).map_err(|error| RunError {
        message: format!(
            "create temporary antenna solution directory '{}': {error}",
            temporary.display()
        ),
    })?;
    let mut ordered = artifacts.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|(_, path)| path == Path::new(SOLUTION_MANIFEST_NAME));
    for (artifact, relative) in ordered {
        let target = temporary.join(relative);
        let parent = target.parent().ok_or_else(|| RunError {
            message: "antenna solution artifact has no parent directory".into(),
        })?;
        fs::create_dir_all(parent).map_err(|error| RunError {
            message: format!(
                "create antenna artifact directory '{}': {error}",
                parent.display()
            ),
        })?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|error| RunError {
                message: format!("create antenna artifact '{}': {error}", target.display()),
            })?;
        file.write_all(&artifact.bytes).map_err(|error| RunError {
            message: format!("write antenna artifact '{}': {error}", target.display()),
        })?;
        file.sync_all().map_err(|error| RunError {
            message: format!("sync antenna artifact '{}': {error}", target.display()),
        })?;
    }
    Ok(())
}

/// Atomically publish only the immutable `antenna_field_solution.v1` subtree.
/// Transport diagnostics remain separate stage artifacts and are never used as
/// the ready pointer. Existing content with the same id is reused only when its
/// verified content digest is identical.
pub fn publish_antenna_field_solution_atomically(
    output_root: &Path,
    result: &AntennaFieldSolveResult,
) -> Result<PublishedAntennaFieldSolution, RunError> {
    publish_antenna_field_solution_atomically_with_hook(output_root, result, None)
}

pub fn publish_antenna_field_solution_atomically_interruptible(
    output_root: &Path,
    result: &AntennaFieldSolveResult,
    interrupt_requested: Option<&AtomicBool>,
) -> Result<PublishedAntennaFieldSolution, RunError> {
    let Some(interrupt_requested) = interrupt_requested else {
        return publish_antenna_field_solution_atomically(output_root, result);
    };
    let before_rename = || {
        if interrupt_requested.load(Ordering::Acquire) {
            return Err(RunError {
                message: "antenna field publication cancelled before atomic rename: interrupt_requested"
                    .into(),
            });
        }
        Ok(())
    };
    publish_antenna_field_solution_atomically_with_hook(
        output_root,
        result,
        Some(&before_rename),
    )
}

fn publish_antenna_field_solution_atomically_with_hook(
    output_root: &Path,
    result: &AntennaFieldSolveResult,
    before_rename: Option<&dyn Fn() -> Result<(), RunError>>,
) -> Result<PublishedAntennaFieldSolution, RunError> {
    let (asset_id, signatures) = manifest_metadata(result)?;
    if result.field_solution.content_digest.is_empty() {
        return Err(RunError {
            message: "antenna field-solve result has no content digest".into(),
        });
    }
    let reference = AntennaFieldSolutionRefIR {
        stage_id: result.stage_id.clone(),
        output_id: result.solution_id.clone(),
        asset_id: asset_id.clone(),
        content_digest: result.field_solution.content_digest.clone(),
    };
    validate_storage_id("antenna asset_id", &asset_id)?;
    let logical_prefix = solution_prefix(&result.solution_id);
    let legacy_dir = output_root.join(&logical_prefix);
    let final_dir = physical_solution_revision_dir(output_root, &result.solution_id, &asset_id);
    let expected_manifest = solution_artifacts(result)?
        .into_iter()
        .find(|(_, path)| path == Path::new(SOLUTION_MANIFEST_NAME))
        .map(|(artifact, _)| artifact.bytes.clone())
        .expect("manifest presence was checked");
    if final_dir.exists() {
        let existing = load_published_antenna_field_solution(output_root, &reference)?;
        if existing.manifest_bytes == expected_manifest {
            return Ok(PublishedAntennaFieldSolution {
                reference,
                manifest_path: final_dir.join(SOLUTION_MANIFEST_NAME),
                signatures,
                reused_existing: true,
            });
        }
        return Err(RunError {
            message: format!(
                "immutable antenna solution revision '{}' already exists with different content",
                asset_id
            ),
        });
    }
    // A legacy flat directory can coexist with revisioned assets. Reuse it
    // only when its verified bytes are identical; otherwise publish the new
    // content-addressed revision below it instead of mutating the old asset.
    let legacy_manifest = legacy_dir.join(SOLUTION_MANIFEST_NAME);
    if legacy_manifest.exists() {
        let legacy_matches_reference = fs::read(&legacy_manifest)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some_and(|value| {
                value.get("asset_id").and_then(serde_json::Value::as_str)
                    == Some(reference.asset_id.as_str())
                    && value
                        .get("content_digest")
                        .and_then(serde_json::Value::as_str)
                        == Some(reference.content_digest.as_str())
            });
        if legacy_matches_reference {
            let existing = load_published_antenna_field_solution(output_root, &reference)?;
            if existing.manifest_bytes == expected_manifest {
                return Ok(PublishedAntennaFieldSolution {
                    reference,
                    manifest_path: legacy_manifest,
                    signatures,
                    reused_existing: true,
                });
            }
        }
    }
    let revision_parent = final_dir.parent().ok_or_else(|| RunError {
        message: "antenna solution revision has no parent directory".into(),
    })?;
    fs::create_dir_all(revision_parent).map_err(|error| RunError {
        message: format!(
            "create antenna solution parent '{}': {error}",
            revision_parent.display()
        ),
    })?;
    let temporary = revision_parent.join(format!(
        ".{}.{}.tmp-{}",
        result.solution_id,
        asset_id,
        uuid::Uuid::new_v4().simple()
    ));
    let artifacts = solution_artifacts(result)?;
    if let Err(error) = write_solution_directory(&temporary, &artifacts) {
        let _ = fs::remove_dir_all(&temporary);
        return Err(error);
    }
    if let Some(before_rename) = before_rename {
        if let Err(error) = before_rename() {
            let _ = fs::remove_dir_all(&temporary);
            return Err(error);
        }
    }
    if let Err(error) = fs::rename(&temporary, &final_dir) {
        let _ = fs::remove_dir_all(&temporary);
        // Two workers may have passed the initial `final_dir.exists()` check.
        // If another worker won the rename race, verify its complete immutable
        // bytes and reuse it; never replace or merge the existing asset.
        if final_dir.exists() {
            if let Ok(existing) = load_published_antenna_field_solution(output_root, &reference) {
                if existing.manifest_bytes == expected_manifest {
                    return Ok(PublishedAntennaFieldSolution {
                        reference,
                        manifest_path: final_dir.join(SOLUTION_MANIFEST_NAME),
                        signatures,
                        reused_existing: true,
                    });
                }
                return Err(RunError {
                    message: format!(
                        "immutable antenna solution revision '{}' won a concurrent publication with different content",
                        asset_id
                    ),
                });
            }
        }
        return Err(RunError {
            message: format!(
                "atomically publish antenna solution '{}': {error}",
                final_dir.display()
            ),
        });
    }
    let published = load_published_antenna_field_solution(output_root, &reference)?;
    if published.manifest_bytes.is_empty() {
        return Err(RunError {
            message: "published antenna field solution cannot be reopened".into(),
        });
    }
    Ok(PublishedAntennaFieldSolution {
        reference,
        manifest_path: final_dir.join(SOLUTION_MANIFEST_NAME),
        signatures,
        reused_existing: false,
    })
}

fn collect_solution_files(
    directory: &Path,
    relative: &Path,
    prefix: &Path,
    output: &mut Vec<AuxiliaryArtifact>,
    skip_revision_siblings: bool,
) -> Result<(), RunError> {
    for entry in fs::read_dir(directory).map_err(|error| RunError {
        message: format!(
            "read antenna solution directory '{}': {error}",
            directory.display()
        ),
    })? {
        let entry = entry.map_err(|error| RunError {
            message: format!("read antenna solution directory entry: {error}"),
        })?;
        let file_type = entry.file_type().map_err(|error| RunError {
            message: format!("inspect antenna solution entry: {error}"),
        })?;
        let child_relative = relative.join(entry.file_name());
        if file_type.is_dir() {
            // A revisioned asset may live below a legacy flat solution
            // directory. Those sibling revisions are separate immutable
            // resources and must not be mixed into the legacy payload set.
            if skip_revision_siblings && entry.path().join(SOLUTION_MANIFEST_NAME).is_file() {
                continue;
            }
            collect_solution_files(&entry.path(), &child_relative, prefix, output, false)?;
        } else if file_type.is_file() {
            let full_relative = prefix.join(&child_relative);
            output.push(AuxiliaryArtifact {
                relative_path: full_relative.to_string_lossy().replace('\\', "/"),
                bytes: fs::read(entry.path()).map_err(|error| RunError {
                    message: format!("read antenna solution artifact: {error}"),
                })?,
            });
        } else {
            return Err(RunError {
                message: "antenna solution directory contains a non-file entry".into(),
            });
        }
    }
    Ok(())
}

pub fn load_published_antenna_field_solution(
    output_root: &Path,
    reference: &AntennaFieldSolutionRefIR,
) -> Result<AntennaFieldSolutionAsset, RunError> {
    load_published_antenna_field_solution_checked(output_root, reference, None)
}

/// Reopen a catalog output only if the complete immutable asset is valid and
/// contains the requested port. This proves integrity, not current-model currency.
pub fn load_published_antenna_field_solution_for_port(
    output_root: &Path,
    reference: &AntennaFieldSolutionRefIR,
    port_mode_id: &str,
) -> Result<AntennaFieldSolutionAsset, RunError> {
    let asset = load_published_antenna_field_solution(output_root, reference)?;
    let manifest: serde_json::Value =
        serde_json::from_slice(&asset.manifest_bytes).map_err(|error| RunError {
            message: format!("parse verified antenna catalog asset: {error}"),
        })?;
    if manifest.get("solution_id").and_then(serde_json::Value::as_str)
        != Some(reference.output_id.as_str())
        || !manifest.get("bases").and_then(serde_json::Value::as_array)
            .is_some_and(|bases| bases.iter().any(|basis| {
                basis.get("port_mode_id").and_then(serde_json::Value::as_str)
                    == Some(port_mode_id)
            }))
    {
        return Err(RunError {
            message: "antenna catalog asset does not contain the expected solution and port".into(),
        });
    }
    Ok(asset)
}

fn load_published_antenna_field_solution_checked(
    output_root: &Path,
    reference: &AntennaFieldSolutionRefIR,
    expected: Option<&ExpectedAntennaSolution>,
) -> Result<AntennaFieldSolutionAsset, RunError> {
    validate_storage_id("antenna output_id", &reference.output_id)?;
    validate_storage_id("antenna asset_id", &reference.asset_id)?;
    let prefix = solution_prefix(&reference.output_id);
    validate_relative_path(&prefix, &prefix.display().to_string())?;
    let revision_directory = output_root.join(&prefix).join(&reference.asset_id);
    let legacy_directory = output_root.join(&prefix);
    let directory = if revision_directory.join(SOLUTION_MANIFEST_NAME).exists() {
        revision_directory
    } else {
        legacy_directory
    };
    let manifest_path = directory.join(SOLUTION_MANIFEST_NAME);
    let manifest_bytes = fs::read(&manifest_path).map_err(|error| RunError {
        message: format!(
            "read antenna field-solution manifest '{}': {error}",
            manifest_path.display()
        ),
    })?;
    let value: serde_json::Value =
        serde_json::from_slice(&manifest_bytes).map_err(|error| RunError {
            message: format!("parse published antenna field-solution manifest: {error}"),
        })?;
    if value.get("asset_id").and_then(serde_json::Value::as_str)
        != Some(reference.asset_id.as_str())
    {
        return Err(RunError {
            message: "published antenna field-solution asset_id does not match the reference".into(),
        });
    }
    if value
        .get("content_digest")
        .and_then(serde_json::Value::as_str)
        != Some(reference.content_digest.as_str())
    {
        return Err(RunError {
            message: "published antenna field-solution content digest does not match the reference"
                .into(),
        });
    }
    if value.get("status").and_then(serde_json::Value::as_str) != Some("ready") {
        return Err(RunError {
            message: "published antenna field-solution asset is not ready".into(),
        });
    }
    if let Some(expected) = expected {
        let signatures = AntennaFieldSolutionSignatures {
            current_solution_signature: expected.current_solution_signature.clone(),
            field_solution_signature: expected.field_solution_signature.clone(),
            target_projection_signatures: expected.target_projection_signatures.clone(),
            dependency_signatures: expected.dependency_signatures.clone(),
        };
        let revisions = match (
            expected.geometry_revision.as_deref(),
            expected.material_revision.as_deref(),
            expected.mesh_digest.as_deref(),
        ) {
            (Some(geometry), Some(material), Some(mesh)) => Some((geometry, material, mesh)),
            (None, None, None) => None,
            _ => {
                return Err(RunError {
                    message: "expected antenna source revisions must include geometry, material, and mesh together".into(),
                });
            }
        };
        crate::antenna_field_solution::verify_antenna_field_solution_signatures_with_revisions(
            &manifest_bytes,
            &signatures,
            revisions,
        )?;
    }
    let mut payloads = Vec::new();
    collect_solution_files(&directory, Path::new(""), &prefix, &mut payloads, true)?;
    payloads.retain(|artifact| {
        artifact.relative_path
            != prefix
                .join(SOLUTION_MANIFEST_NAME)
                .to_string_lossy()
                .replace('\\', "/")
    });
    crate::verify_antenna_field_solution_asset(&manifest_bytes, &payloads)?;
    Ok(AntennaFieldSolutionAsset {
        manifest_bytes,
        payloads,
    })
}

pub fn load_expected_antenna_field_solution(
    output_root: &Path,
    expected: &ExpectedAntennaSolution,
) -> Result<AntennaFieldSolutionAsset, RunError> {
    load_published_antenna_field_solution_checked(
        output_root,
        &expected.reference,
        Some(expected),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::antenna_field_solution::{
        build_antenna_field_solution_artifacts, AntennaFieldBasisInput, AntennaFieldSolutionInput,
    };
    use std::sync::{Arc, Barrier};
    use std::thread;

    #[test]
    fn static_current_view_signature_excludes_evaluation_time_and_envelope() {
        let view: ResolvedFemConservativeCurrentViewIR =
            serde_json::from_value(serde_json::json!({
                "stable_vertex_ids": [10, 20, 30, 40],
                "boundary_faces": [],
                "identity": {
                    "source_module_id": "charge",
                    "source_state_revision": "state-1",
                    "source_field_digest": "field-1",
                    "conductivity_digest": "sigma-1",
                    "mesh_revision": "mesh-1",
                    "topology_revision": "topology-1",
                    "geometry_digest": "geometry-1",
                    "envelope_revision": "envelope-1",
                    "envelope_digest": "envelope-digest-1",
                    "evaluated_envelope_multiplier": 1.0,
                    "evaluation_time_s": 0.0,
                    "stage_identity": 1,
                },
                "pins": {
                    "required_source_state_revision": "state-1",
                    "required_source_field_digest": "field-1",
                    "required_mesh_revision": "mesh-1",
                    "required_topology_revision": "topology-1",
                },
                "closure": {
                    "kind": "closed_geometry",
                    "operator_version": "closure.v1",
                    "revision": "closure-1",
                    "digest": "closure-digest-1",
                    "source_cuts": [],
                },
                "algebraic_relative_tolerance": 1e-10,
                "physical_relative_gate": 1e-8,
                "physical_absolute_gate_a": 1e-12,
            }))
            .unwrap();
        let static_dependencies = static_conservative_current_view_dependencies(&view);

        let mut later = view.clone();
        later.identity.envelope_revision = "envelope-2".into();
        later.identity.envelope_digest = "envelope-digest-2".into();
        later.identity.evaluated_envelope_multiplier = 0.25;
        later.identity.evaluation_time_s = 2e-9;
        later.identity.stage_identity = 2;
        later.reference_mpi_gather_broadcast = true;
        assert_eq!(
            static_conservative_current_view_dependencies(&later),
            static_dependencies
        );

        later.identity.topology_revision = "topology-2".into();
        assert_ne!(
            static_conservative_current_view_dependencies(&later),
            static_dependencies
        );
        later = view.clone();
        later.stable_vertex_ids[0] = 11;
        assert_ne!(
            static_conservative_current_view_dependencies(&later),
            static_dependencies
        );
        later = view.clone();
        later.algebraic_relative_tolerance = 1e-11;
        assert_ne!(
            static_conservative_current_view_dependencies(&later),
            static_dependencies
        );
    }

    fn field_solve_result(solution_id: &str, h_x: f64) -> AntennaFieldSolveResult {
        field_solve_result_with_asset(solution_id, h_x, "afs-fixture")
    }

    fn field_solve_result_with_asset(
        solution_id: &str,
        h_x: f64,
        asset_id: &str,
    ) -> AntennaFieldSolveResult {
        let signatures = AntennaFieldSolutionSignatures {
            current_solution_signature: format!("sha256:{}", "1".repeat(64)),
            field_solution_signature: format!("sha256:{}", "2".repeat(64)),
            target_projection_signatures: BTreeMap::from([(
                "object:magnet".into(),
                format!("sha256:{}", "3".repeat(64)),
            )]),
            dependency_signatures: None,
        };
        let artifacts = build_antenna_field_solution_artifacts(&AntennaFieldSolutionInput {
            asset_id: asset_id.into(),
            solution_id: solution_id.into(),
            source_object_id: "antenna".into(),
            current_transport_id: "charge".into(),
            stage_id: "solve".into(),
            geometry_revision: "sha256:geometry".into(),
            material_revision: "sha256:material".into(),
            mesh_digest: "sha256:mesh".into(),
            requested_execution: serde_json::json!({"device": "auto"}),
            resolved_execution: serde_json::json!({"device": "cpu", "precision": "double"}),
            gauge_policy: "dirichlet_reference".into(),
            solver_policy: serde_json::json!({"relative_tolerance": 1e-10}),
            signatures,
            conductor_positions_xyz_m: vec![[0.0, 0.0, 0.0]],
            sample_positions_xyz_m: vec![[1.0, 0.0, 0.0]],
            sample_carrier: crate::antenna_field_solution::AntennaSampleCarrier {
                domain: fullmag_ir::FieldTargetIR::Object { object_id: "magnet".into() },
                carrier_kind: "fem_mesh_asset:magnet".into(),
                location: "node".into(),
                topology_digest: format!("sha256:{}", "4".repeat(64)),
            },
            sample_tet4_cells: None,
            bases: vec![AntennaFieldBasisInput {
                port_mode_id: "common".into(),
                measured_positive_terminal_current_a: 1.0,
                electric_potential_v: vec![1.0],
                current_density_xyz_apm2: vec![[1.0, 0.0, 0.0]],
                magnetic_field_xyz_apm: vec![[h_x, 0.0, 0.0]],
                current_balance_certificate_digest: "sha256:balance".into(),
                // Synthetic non-direct lifecycle fixture, not scientific OE-F2 evidence.
                quadrature_diagnostics: serde_json::json!({"operator_version": fullmag_ir::ANTENNA_VECTOR_POTENTIAL_OPERATOR_VERSION}),
                oersted_operator_version: fullmag_ir::ANTENNA_VECTOR_POTENTIAL_OPERATOR_VERSION.into(),
                direct_quadrature_snapshot: None,
            }],
        })
        .unwrap();
        let manifest = artifacts
            .iter()
            .find(|artifact| artifact.relative_path.ends_with("manifest.v1.json"))
            .unwrap();
        let content_digest = serde_json::from_slice::<serde_json::Value>(&manifest.bytes).unwrap()
            ["content_digest"]
            .as_str()
            .unwrap()
            .to_string();
        AntennaFieldSolveResult {
            schema_version: "antenna_field_solve_result.v1".into(),
            stage_id: "solve".into(),
            port_mode_id: "common".into(),
            solution_id: solution_id.into(),
            field_solution: crate::AntennaFieldSolutionSamples {
                solution_id: solution_id.into(),
                source_object_id: "antenna".into(),
                port_mode_id: "common".into(),
                sample_positions_xyz_m: vec![[1.0, 0.0, 0.0]],
                magnetic_field_xyz_apm_per_a: vec![[h_x, 0.0, 0.0]],
                sample_tet4_cells: None,
                content_digest,
            },
            quantities: Vec::new(),
            auxiliary_artifacts: artifacts,
            transport_provenance: Vec::new(),
        }
    }

    #[test]
    fn lifecycle_rejects_skipping_the_current_solve() {
        assert!(AntennaFieldStageStatus::Missing.can_transition_to(AntennaFieldStageStatus::Queued));
        assert!(AntennaFieldStageStatus::Missing.can_transition_to(AntennaFieldStageStatus::Stale));
        assert!(!AntennaFieldStageStatus::Queued
            .can_transition_to(AntennaFieldStageStatus::EvaluatingField));
        assert!(AntennaFieldStageStatus::Queued
            .can_transition_to(AntennaFieldStageStatus::ProjectingTargets));
        assert!(AntennaFieldStageStatus::SolvingCurrent
            .can_transition_to(AntennaFieldStageStatus::Failed));
        assert!(AntennaFieldStageStatus::Ready.can_transition_to(AntennaFieldStageStatus::Stale));
    }

    #[test]
    fn lifecycle_records_stale_cache_before_resolve() {
        let mut state = AntennaFieldStageState {
            stage_id: "solve".into(),
            solution_id: "solution".into(),
            status: AntennaFieldStageStatus::Missing,
            transitions: Vec::new(),
            signatures: None,
            diagnostic: None,
        };
        state
            .transition(
                AntennaFieldStageStatus::Stale,
                Some("immutable field solution is stale".into()),
            )
            .unwrap();
        state
            .transition(
                AntennaFieldStageStatus::Queued,
                Some("re-solving stale immutable field solution".into()),
            )
            .unwrap();
        assert_eq!(state.status, AntennaFieldStageStatus::Queued);
        assert_eq!(state.transitions[0].from, AntennaFieldStageStatus::Missing);
        assert_eq!(state.transitions[0].to, AntennaFieldStageStatus::Stale);
        assert_eq!(state.transitions[1].from, AntennaFieldStageStatus::Stale);
        assert_eq!(state.transitions[1].to, AntennaFieldStageStatus::Queued);
    }

    #[test]
    fn lifecycle_records_cache_reuse_without_fake_solve_stages() {
        let mut state = AntennaFieldStageState {
            stage_id: "solve".into(),
            solution_id: "solution".into(),
            status: AntennaFieldStageStatus::Missing,
            transitions: Vec::new(),
            signatures: None,
            diagnostic: None,
        };
        state
            .transition(AntennaFieldStageStatus::Queued, None)
            .unwrap();
        state
            .transition(
                AntennaFieldStageStatus::ProjectingTargets,
                Some("reused verified immutable field solution".into()),
            )
            .unwrap();
        state
            .transition(AntennaFieldStageStatus::Ready, None)
            .unwrap();

        let statuses: Vec<_> = state
            .transitions
            .iter()
            .map(|transition| transition.to)
            .collect();
        assert_eq!(
            statuses,
            vec![
                AntennaFieldStageStatus::Queued,
                AntennaFieldStageStatus::ProjectingTargets,
                AntennaFieldStageStatus::Ready,
            ]
        );
        assert_eq!(
            state.transitions[1].diagnostic.as_deref(),
            Some("reused verified immutable field solution")
        );
    }

    #[test]
    fn lifecycle_records_every_valid_transition_and_diagnostic() {
        let mut state = AntennaFieldStageState {
            stage_id: "solve".into(),
            solution_id: "solution".into(),
            status: AntennaFieldStageStatus::Missing,
            transitions: Vec::new(),
            signatures: None,
            diagnostic: None,
        };
        state
            .transition(AntennaFieldStageStatus::Queued, None)
            .unwrap();
        state
            .transition(
                AntennaFieldStageStatus::Meshing,
                Some("mesh cache miss".into()),
            )
            .unwrap();
        assert_eq!(state.transitions.len(), 2);
        assert_eq!(state.transitions[0].from, AntennaFieldStageStatus::Missing);
        assert_eq!(state.transitions[0].to, AntennaFieldStageStatus::Queued);
        assert_eq!(state.transitions[1].from, AntennaFieldStageStatus::Queued);
        assert_eq!(state.transitions[1].to, AntennaFieldStageStatus::Meshing);
        assert_eq!(state.transitions[1].diagnostic.as_deref(), Some("mesh cache miss"));
    }

    #[test]
    fn atomic_publication_reopens_and_reuses_identical_content() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-antenna-publish-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let result = field_solve_result("solution", 2.0);
        let first = publish_antenna_field_solution_atomically(&root, &result).unwrap();
        assert!(!first.reused_existing);
        assert!(first.manifest_path.is_file());
        let asset = load_published_antenna_field_solution(&root, &first.reference).unwrap();
        assert!(!asset.manifest_bytes.is_empty());
        assert_eq!(asset.payloads.len(), 5);

        let mut expected = ExpectedAntennaSolution::new(
            first.reference.clone(),
            AntennaFieldSolutionSignatures {
                current_solution_signature: format!("sha256:{}", "1".repeat(64)),
                field_solution_signature: format!("sha256:{}", "2".repeat(64)),
                target_projection_signatures: BTreeMap::from([(
                    "object:magnet".into(),
                    format!("sha256:{}", "3".repeat(64)),
                )]),
                dependency_signatures: None,
            },
        );
        assert_eq!(
            load_expected_antenna_field_solution(&root, &expected).unwrap(),
            asset
        );
        expected.current_solution_signature = format!("sha256:{}", "f".repeat(64));
        let stale = load_expected_antenna_field_solution(&root, &expected)
            .err()
            .expect("unchanged bytes cannot validate against changed dependencies");
        assert!(stale.message.contains("current_solution_signature"));
        assert!(first.manifest_path.is_file());

        expected.current_solution_signature = format!("sha256:{}", "1".repeat(64));
        expected.target_projection_signatures.clear();
        assert_eq!(
            load_expected_antenna_field_solution(&root, &expected).unwrap(),
            asset,
            "changing the target must not invalidate the source field asset"
        );
        expected.reference.content_digest = format!("sha256:{}", "f".repeat(64));
        let integrity = load_expected_antenna_field_solution(&root, &expected)
            .err()
            .expect("incorrect reference digest must fail independently of model currency");
        assert!(integrity.message.contains("content digest does not match"));
        assert!(!integrity.message.contains("stale for the current model"));

        let second = publish_antenna_field_solution_atomically(&root, &result).unwrap();
        assert!(second.reused_existing);
        assert_eq!(first.reference, second.reference);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn catalog_port_loader_checks_integrity_before_port_membership() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-antenna-catalog-port-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let result = field_solve_result("solution", 2.0);
        let published = publish_antenna_field_solution_atomically(&root, &result).unwrap();
        load_published_antenna_field_solution_for_port(&root, &published.reference, "common")
            .unwrap();
        let missing_port = load_published_antenna_field_solution_for_port(
            &root, &published.reference, "other",
        ).unwrap_err();
        assert!(missing_port.message.contains("expected solution and port"));
        let payload = published.manifest_path.parent().unwrap().join("common/H_per_A.f64le");
        fs::write(&payload, [0_u8; 24]).unwrap();
        let corrupt = load_published_antenna_field_solution_for_port(
            &root, &published.reference, "other",
        ).unwrap_err();
        assert!(!corrupt.message.contains("expected solution and port"));
        assert!(published.manifest_path.is_file());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn interruptible_publication_rejects_cancel_before_atomic_rename() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-antenna-publish-cancel-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let result = field_solve_result("solution", 2.0);
        let signal = AtomicBool::new(true);
        let error = publish_antenna_field_solution_atomically_interruptible(
            &root,
            &result,
            Some(&signal),
        )
        .expect_err("cancelled publication must not return a ready asset");
        assert!(error.message.contains("cancelled before atomic rename"));
        assert!(!root.join("antenna/field_solutions/solution").exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn concurrent_identical_publication_deduplicates_after_rename_race() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-antenna-publish-race-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let result = field_solve_result("solution", 2.0);
        let barrier = Arc::new(Barrier::new(2));

        let workers = (0..2)
            .map(|_| {
                let root = root.clone();
                let result = result.clone();
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    let before_rename = || {
                        barrier.wait();
                        Ok(())
                    };
                    publish_antenna_field_solution_atomically_with_hook(
                        &root,
                        &result,
                        Some(&before_rename),
                    )
                })
            })
            .collect::<Vec<_>>();
        let outcomes = workers
            .into_iter()
            .map(|worker| worker.join().expect("publication worker must not panic"))
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(outcomes.len(), 2);
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| !outcome.reused_existing)
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| outcome.reused_existing)
                .count(),
            1
        );
        let expected_manifest = result
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path.ends_with("manifest.v1.json"))
            .expect("fixture must contain a manifest")
            .bytes
            .clone();
        let published = load_published_antenna_field_solution(&root, &outcomes[0].reference)
            .expect("winner and deduplicated loser must expose one verified asset");
        assert_eq!(published.payloads.len(), 5);
        assert_eq!(published.manifest_bytes, expected_manifest);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn immutable_publication_rejects_changed_content_and_tampered_payloads() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-antenna-immutable-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let first = field_solve_result("solution", 2.0);
        publish_antenna_field_solution_atomically(&root, &first).unwrap();
        let changed = field_solve_result("solution", 3.0);
        assert!(publish_antenna_field_solution_atomically(&root, &changed).is_err());

        let mut tampered = field_solve_result("tampered", 2.0);
        tampered
            .auxiliary_artifacts
            .iter_mut()
            .find(|artifact| artifact.relative_path.ends_with("V_per_A.f64le"))
            .unwrap()
            .bytes[0] ^= 1;
        assert!(publish_antenna_field_solution_atomically(&root, &tampered)
            .unwrap_err()
            .message
            .contains("sha256"));
        assert!(!root.join("antenna/field_solutions/tampered").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn changed_content_addressed_revision_does_not_mutate_previous_asset() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-antenna-revisions-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let first = field_solve_result_with_asset("solution", 2.0, "afs-old");
        let first_published = publish_antenna_field_solution_atomically(&root, &first).unwrap();
        let second = field_solve_result_with_asset("solution", 3.0, "afs-new");
        let second_published = publish_antenna_field_solution_atomically(&root, &second).unwrap();

        assert!(!second_published.reused_existing);
        assert_ne!(
            first_published.manifest_path,
            second_published.manifest_path
        );
        let first_asset =
            load_published_antenna_field_solution(&root, &first_published.reference).unwrap();
        let second_asset =
            load_published_antenna_field_solution(&root, &second_published.reference).unwrap();
        assert_ne!(first_asset.manifest_bytes, second_asset.manifest_bytes);
        assert!(first_published.manifest_path.is_file());
        assert!(second_published.manifest_path.is_file());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn stale_expected_solution_is_rejected_before_payload_loading() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-antenna-stale-before-payload-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let result = field_solve_result("solution", 2.0);
        let published = publish_antenna_field_solution_atomically(&root, &result).unwrap();
        let expected = ExpectedAntennaSolution {
            reference: published.reference.clone(),
            current_solution_signature: format!("sha256:{}", "9".repeat(64)),
            field_solution_signature: published.signatures.field_solution_signature.clone(),
            target_projection_signatures: published.signatures.target_projection_signatures.clone(),
            dependency_signatures: published.signatures.dependency_signatures.clone(),
            geometry_revision: None,
            material_revision: None,
            mesh_digest: None,
        };
        let payload = published
            .manifest_path
            .parent()
            .unwrap()
            .join("common/V_per_A.f64le");
        fs::remove_file(payload).unwrap();
        let error = load_expected_antenna_field_solution(&root, &expected).unwrap_err();
        assert!(error.message.contains("stale for the current model"));
        let current = ExpectedAntennaSolution::new(
            published.reference,
            published.signatures,
        );
        let error = load_expected_antenna_field_solution(&root, &current).unwrap_err();
        assert!(error.message.contains("missing"));
        assert!(!error.message.contains("stale for the current model"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn stale_solution_reports_changed_source_revision_category() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-antenna-stale-category-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let result = field_solve_result("solution", 2.0);
        let published = publish_antenna_field_solution_atomically(&root, &result).unwrap();
        let mut expected = ExpectedAntennaSolution::new(
            published.reference.clone(),
            published.signatures.clone(),
        )
        .with_source_revisions(
            "sha256:geometry".into(),
            "sha256:material".into(),
            "sha256:mesh".into(),
        );
        load_expected_antenna_field_solution(&root, &expected).unwrap();

        expected.current_solution_signature = format!("sha256:{}", "9".repeat(64));
        expected.geometry_revision = Some("sha256:changed-geometry".into());
        let geometry = load_expected_antenna_field_solution(&root, &expected).unwrap_err();
        assert!(geometry.message.contains("changed dependencies: geometry"));
        expected.geometry_revision = Some("sha256:geometry".into());
        expected.material_revision = Some("sha256:changed-material".into());
        let material = load_expected_antenna_field_solution(&root, &expected).unwrap_err();
        assert!(material.message.contains("changed dependencies: material"));
        expected.material_revision = Some("sha256:material".into());
        let unknown = load_expected_antenna_field_solution(&root, &expected).unwrap_err();
        assert!(unknown.message.contains("current_solution_signature"));
        expected.geometry_revision = None;
        let incomplete = load_expected_antenna_field_solution(&root, &expected).unwrap_err();
        assert!(incomplete
            .message
            .contains("source revisions must include geometry, material, and mesh together"));
        assert!(published.manifest_path.is_file());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn legacy_flat_asset_remains_readable_after_revisioned_asset_is_added() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-antenna-legacy-revision-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let first = field_solve_result_with_asset("solution", 2.0, "afs-old");
        let first_published = publish_antenna_field_solution_atomically(&root, &first).unwrap();
        let legacy_dir = root.join("antenna/field_solutions/solution");
        let revision_dir = legacy_dir.join("afs-old");
        for entry in fs::read_dir(&revision_dir).unwrap() {
            let entry = entry.unwrap();
            fs::rename(entry.path(), legacy_dir.join(entry.file_name())).unwrap();
        }
        fs::remove_dir(&revision_dir).unwrap();

        let second = field_solve_result_with_asset("solution", 3.0, "afs-new");
        let second_published = publish_antenna_field_solution_atomically(&root, &second).unwrap();
        let first_asset =
            load_published_antenna_field_solution(&root, &first_published.reference).unwrap();
        let second_asset =
            load_published_antenna_field_solution(&root, &second_published.reference).unwrap();
        assert_eq!(first_asset.payloads.len(), 5);
        assert_eq!(second_asset.payloads.len(), 5);
        fs::remove_dir_all(&root).unwrap();
    }
}
