use crate::dispatch::{FdmEngine, FemEngine};
use crate::quantities::QuantityId;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeEngineId {
    FdmCpuReference,
    FdmCuda,
    FemCpuNative,
    FemNativeGpu,
    FemEigenCpuBaseline,
    FemEigenNativeGpu,
    FemFrequencyResponseDenseValidation,
    FemFrequencyResponseProductionCpu,
}

impl RuntimeEngineId {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FdmCpuReference => "fdm_cpu_reference",
            Self::FdmCuda => "fdm_cuda",
            Self::FemCpuNative => "fem_cpu_native",
            Self::FemNativeGpu => "fem_native_gpu",
            Self::FemEigenCpuBaseline => "fem_eigen_cpu_baseline",
            Self::FemEigenNativeGpu => "fem_eigen_native_gpu",
            Self::FemFrequencyResponseDenseValidation => "fem_frequency_response_dense_validation",
            Self::FemFrequencyResponseProductionCpu => "fem_frequency_response_production_cpu",
        }
    }
}

pub type FeatureCapabilityStatus = fullmag_ir::FemMixedTopologyCapabilityStatusIR;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeatureCapability {
    pub status: FeatureCapabilityStatus,
    pub reason: String,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub supported_layer_counts: Vec<u32>,
}

pub const MIXED_P1_MESH_FEATURE_CAPABILITY_IDS: [&str; 4] = [
    "mesh.topology.mixed_p1",
    "mesh.swept.prism",
    "mesh.transition.pyramid_tet",
    "mesh.exact_layer_count",
];

pub const MIXED_P1_FEATURE_CAPABILITY_IDS: [&str; 6] = [
    "mesh.topology.mixed_p1",
    "mesh.swept.prism",
    "mesh.transition.pyramid_tet",
    "mesh.exact_layer_count",
    "fem.cpu.exchange_demag.mixed_p1",
    "fem.gpu.exchange_demag.mixed_p1",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendCapabilities {
    pub engine_id: RuntimeEngineId,
    pub capability_profile_version: String,
    pub supported_terms: Vec<String>,
    /// Executable restrictions for terms advertised by this resolved plan
    /// profile. The semantic term name remains stable in `supported_terms`;
    /// clients must use this map for command gating and explanatory text.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub term_scopes: BTreeMap<String, String>,
    /// Cross-cutting feature availability. Feature IDs are intentionally
    /// separate from executable physics terms in `supported_terms`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub feature_capabilities: BTreeMap<String, FeatureCapability>,
    pub supported_demag_realizations: Vec<String>,
    pub preview_quantities: Vec<String>,
    pub snapshot_quantities: Vec<String>,
    pub scalar_outputs: Vec<String>,
    /// Runner-owned provider resolution for the selected plan/runtime lane.
    /// The legacy quantity lists above remain compatibility projections only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_quantity_registry: Option<ResolvedQuantityProviderRegistry>,
    pub approximate_operators: Vec<String>,
    pub supports_frequency_response: bool,
    pub supports_coupled_magnetoelastic_quasistatic: bool,
    pub supports_coupled_magnetoelastic_elastodynamic: bool,
    pub supports_frequency_domain_elastodynamics: bool,
    pub supports_coupled_eigenmodes: bool,
    pub supports_lossy_fallback_override: bool,
}

/// Provider plane for one quantity in the resolved backend/plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantityProviderCapability {
    Available,
    Unavailable,
}

/// Data-plane request exposed for one resolved quantity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantityRequestCapability {
    FieldVector,
    ScalarResource,
    UnsupportedShape,
    Unavailable,
}

/// Materialization truth is deliberately independent from provider support.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantityMaterializationCapability {
    NotApplicable,
    Unmaterialized,
    Pending,
    Materialized,
    LegacyUnverified,
    Unavailable,
}

/// Renderer support for the resolved shape without frontend coercion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantityRenderCapability {
    Renderable,
    UnsupportedShape,
    Unavailable,
}

/// Publication policy from the canonical catalog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantityPublicationCapability {
    Interactive,
    ExportOnly,
    Hidden,
}

/// Verification state carried by a concrete field payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldPayloadState {
    Current,
    LegacyUnverified,
    Unmaterialized,
}

/// Generic field carrier metadata. Consumers select by these properties and
/// never by quantity-specific branches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldCarrierDescriptor {
    pub carrier_id: String,
    pub carrier_fingerprint: String,
    /// Compatibility projection of `scope_kind` for existing clients.
    pub scope: String,
    pub scope_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    pub components: u8,
    pub indexing: String,
    pub view: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_version: Option<String>,
    pub payload_state: FieldPayloadState,
}

/// Five independent capability planes resolved for one runtime lane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedQuantityCapability {
    pub quantity_id: String,
    pub provider: QuantityProviderCapability,
    pub request: QuantityRequestCapability,
    pub materialization: QuantityMaterializationCapability,
    pub render: QuantityRenderCapability,
    pub publication: QuantityPublicationCapability,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    pub lane: String,
    pub precision: String,
    pub carriers: Vec<FieldCarrierDescriptor>,
}

/// Request-local evidence supplied by API/resource owners to the canonical
/// resolver. Provider and publication truth remain runner-owned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedQuantityCapabilityContext<'a> {
    pub scope: &'a str,
    pub precision: &'a str,
    pub materialization: QuantityMaterializationCapability,
    pub carriers: Vec<FieldCarrierDescriptor>,
}

fn canonical_quantity_set(ids: impl IntoIterator<Item = impl AsRef<str>>) -> BTreeSet<String> {
    ids.into_iter()
        .filter_map(|candidate| {
            fullmag_quantities::normalize_quantity_id(candidate.as_ref())
                .ok()
                .map(|id| id.as_str().to_string())
        })
        .collect()
}

/// Resolved provider registry for one already-selected runtime plan.
///
/// `BackendCapabilities` keeps `preview_quantities`, `snapshot_quantities` and
/// `scalar_outputs` as compatibility projections for existing clients.  They
/// are not read independently by API handlers.  This registry is the one
/// runner-owned provider plane used by the quantity resolver, which prevents a
/// scalar output from accidentally making a spatial field requestable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedQuantityProviderRegistry {
    pub field_quantities: Vec<String>,
    pub scalar_quantities: Vec<String>,
    pub lane: String,
    pub precision: String,
    #[serde(default)]
    pub source: QuantityProviderRegistrySource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantityProviderRegistrySource {
    CompatibilityProfile,
    ResolvedPlan,
}

impl Default for QuantityProviderRegistrySource {
    fn default() -> Self {
        Self::CompatibilityProfile
    }
}

impl ResolvedQuantityProviderRegistry {
    pub fn from_resolved_plan<I, J>(
        lane: impl Into<String>,
        precision: impl Into<String>,
        field_quantities: I,
        scalar_quantities: J,
    ) -> Self
    where
        I: IntoIterator,
        I::Item: AsRef<str>,
        J: IntoIterator,
        J::Item: AsRef<str>,
    {
        Self {
            field_quantities: canonical_quantity_set(field_quantities)
                .into_iter()
                .collect(),
            scalar_quantities: canonical_quantity_set(scalar_quantities)
                .into_iter()
                .collect(),
            lane: lane.into(),
            precision: precision.into(),
            source: QuantityProviderRegistrySource::ResolvedPlan,
        }
    }

    fn from_compatibility_profile<I, J>(
        lane: impl Into<String>,
        precision: impl Into<String>,
        field_quantities: I,
        scalar_quantities: J,
    ) -> Self
    where
        I: IntoIterator,
        I::Item: AsRef<str>,
        J: IntoIterator,
        J::Item: AsRef<str>,
    {
        let mut registry =
            Self::from_resolved_plan(lane, precision, field_quantities, scalar_quantities);
        registry.source = QuantityProviderRegistrySource::CompatibilityProfile;
        registry
    }

    fn contains(&self, spec: &fullmag_quantities::QuantitySpec) -> bool {
        match spec.shape {
            fullmag_quantities::QuantityShape::GlobalScalar => {
                self.scalar_quantities
                    .iter()
                    .any(|id| id == spec.id.as_str())
                    || spec.scalar_metric_key.is_some_and(|key| {
                        self.scalar_quantities
                            .iter()
                            .any(|candidate| candidate.eq_ignore_ascii_case(key))
                    })
            }
            _ => self
                .field_quantities
                .iter()
                .any(|id| id == spec.id.as_str()),
        }
    }
}

fn precision_label(precision: fullmag_ir::ExecutionPrecision) -> &'static str {
    match precision {
        fullmag_ir::ExecutionPrecision::Single => "single",
        fullmag_ir::ExecutionPrecision::Double => "double",
    }
}

/// Attach a compatibility registry to a static lane profile. Planned runtime
/// resolution replaces this projection with the active-plan registry before
/// the capability snapshot is published.
fn attach_compatibility_registry(
    mut capabilities: BackendCapabilities,
    precision: fullmag_ir::ExecutionPrecision,
) -> BackendCapabilities {
    let mut field_quantities = capabilities
        .preview_quantities
        .iter()
        .chain(capabilities.snapshot_quantities.iter())
        .map(String::as_str)
        .collect::<Vec<_>>();
    if capabilities.engine_id == RuntimeEngineId::FemCpuNative {
        field_quantities.extend([
            "V_electric",
            "J_charge",
            "spin_current_tensor",
            "torque_stt",
        ]);
    }
    let scalar_quantities = capabilities
        .scalar_outputs
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    capabilities.resolved_quantity_registry = Some(
        ResolvedQuantityProviderRegistry::from_compatibility_profile(
            capabilities.engine_id.as_str(),
            precision_label(precision),
            field_quantities,
            scalar_quantities,
        ),
    );
    capabilities
}

/// Resolve provider, request, materialization, render and publication from one
/// runner-owned source. API quantity catalogs and field resources must call
/// this function instead of interpreting preview/snapshot lists independently.
pub fn resolve_quantity_capability(
    capabilities: &BackendCapabilities,
    spec: &fullmag_quantities::QuantitySpec,
    context: ResolvedQuantityCapabilityContext<'_>,
) -> ResolvedQuantityCapability {
    let registry = capabilities.resolved_quantity_registry.as_ref();
    let registry_available = registry.is_some();
    let registry_is_resolved_plan = registry
        .is_some_and(|registry| registry.source == QuantityProviderRegistrySource::ResolvedPlan);
    let registry_identity_matches = registry.is_some_and(|registry| {
        registry.lane == capabilities.engine_id.as_str()
            && (registry.precision == context.precision || registry.precision == "unknown")
    });
    let provider_registered = registry_is_resolved_plan
        && registry_identity_matches
        && registry.is_some_and(|registry| registry.contains(spec));
    let provider = if provider_registered {
        QuantityProviderCapability::Available
    } else {
        QuantityProviderCapability::Unavailable
    };
    let request = if !provider_registered {
        QuantityRequestCapability::Unavailable
    } else {
        match spec.shape {
            fullmag_quantities::QuantityShape::VectorField
            | fullmag_quantities::QuantityShape::SpatialScalar
            | fullmag_quantities::QuantityShape::TensorField => {
                QuantityRequestCapability::FieldVector
            }
            fullmag_quantities::QuantityShape::GlobalScalar => {
                QuantityRequestCapability::ScalarResource
            }
        }
    };
    let render = if !provider_registered {
        QuantityRenderCapability::Unavailable
    } else {
        match spec.shape {
            fullmag_quantities::QuantityShape::VectorField
            | fullmag_quantities::QuantityShape::SpatialScalar
                if spec.ui_exposed && spec.supports_preview_3d =>
            {
                QuantityRenderCapability::Renderable
            }
            fullmag_quantities::QuantityShape::TensorField => {
                QuantityRenderCapability::UnsupportedShape
            }
            _ => QuantityRenderCapability::Unavailable,
        }
    };
    let publication = if spec.ui_exposed && spec.interactive_preview {
        QuantityPublicationCapability::Interactive
    } else if spec.supports_export {
        QuantityPublicationCapability::ExportOnly
    } else {
        QuantityPublicationCapability::Hidden
    };
    let materialization = if !provider_registered {
        QuantityMaterializationCapability::Unavailable
    } else if spec.shape == fullmag_quantities::QuantityShape::GlobalScalar {
        QuantityMaterializationCapability::NotApplicable
    } else if request == QuantityRequestCapability::UnsupportedShape {
        QuantityMaterializationCapability::Unavailable
    } else {
        context.materialization
    };
    let reason_code = if !registry_available {
        Some("quantity_registry_unavailable")
    } else if !registry_is_resolved_plan {
        Some("quantity_registry_not_resolved_plan")
    } else if !registry_identity_matches {
        Some("quantity_registry_identity_mismatch")
    } else if !provider_registered {
        Some("quantity_unsupported")
    } else if request == QuantityRequestCapability::UnsupportedShape {
        Some("unsupported_shape")
    } else if materialization == QuantityMaterializationCapability::LegacyUnverified {
        Some("legacy_unverified")
    } else if materialization == QuantityMaterializationCapability::Pending {
        Some("field_materialization_pending")
    } else if materialization == QuantityMaterializationCapability::Unmaterialized {
        Some("field_unmaterialized")
    } else {
        None
    };

    ResolvedQuantityCapability {
        quantity_id: spec.id.as_str().to_string(),
        provider,
        request,
        materialization,
        render,
        publication,
        scope: context.scope.to_string(),
        reason_code: reason_code.map(str::to_string),
        lane: registry
            .map(|registry| registry.lane.clone())
            .unwrap_or_else(|| capabilities.engine_id.as_str().to_string()),
        precision: registry
            .map(|registry| registry.precision.clone())
            .unwrap_or_else(|| context.precision.to_string()),
        carriers: if request == QuantityRequestCapability::FieldVector {
            context.carriers
        } else {
            Vec::new()
        },
    }
}

// These are semantic-only in the current public contract. Keep them explicit so
// prescribed-strain H_mel or FEM eigen support cannot be misread as a driven
// frequency-domain or two-way magnetoelastic solver.
const DEFERRED_STUDY_CAPABILITY: bool = false;

/// The FDM plan family whose public execution scope is being reported.
///
/// This is intentionally separate from the selected engine: the public
/// multilayer plan rejects several interactions that the single-grid engine
/// can execute. `supported_terms` is an executable-plan catalog, not a source
/// inventory of dormant kernels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FdmCapabilityProfile {
    SingleGrid,
    Multilayer,
}

fn quantity_names(ids: &[QuantityId]) -> Vec<String> {
    ids.iter().map(|id| id.as_str().to_string()).collect()
}

fn fdm_supported_terms(profile: FdmCapabilityProfile, cuda: bool) -> Vec<String> {
    let terms = match profile {
        FdmCapabilityProfile::SingleGrid => vec![
            "exchange",
            "demag_tensor_fft_newell",
            "zeeman",
            "thermal",
            "uniaxial_anisotropy",
            "cubic_anisotropy",
            "interfacial_dmi",
            "bulk_dmi",
            "stt",
            "sot",
            "oersted",
        ],
        FdmCapabilityProfile::Multilayer => vec![
            "exchange",
            "demag_tensor_fft_newell",
            "zeeman",
            "uniaxial_anisotropy",
            "cubic_anisotropy",
            "interfacial_dmi",
        ],
    };
    let mut terms = terms.into_iter().map(str::to_string).collect::<Vec<_>>();
    if cuda && profile == FdmCapabilityProfile::SingleGrid {
        terms.push("boundary_correction".to_string());
    }
    terms
}

fn fdm_term_scopes(profile: FdmCapabilityProfile, cuda: bool) -> BTreeMap<String, String> {
    if profile == FdmCapabilityProfile::Multilayer {
        return BTreeMap::new();
    }

    let mut scopes = BTreeMap::from([
        (
            "thermal".to_string(),
            "single_grid; fixed_timestep; adaptive=unsupported; H_therm=unmaterialized".to_string(),
        ),
        (
            "sot".to_string(),
            "single_grid; uniform_module; conservative_energy=none".to_string(),
        ),
    ]);
    scopes.insert(
        "oersted".to_string(),
        if cuda {
            "single_grid; cylinder_axis=+z/time_dependence=constant; field=precomputed_static"
                .to_string()
        } else {
            "single_grid; cylinder_any_axis; time_dependence=constant|sinusoidal|pulse; field=current_solution"
                .to_string()
        },
    );
    scopes
}

fn feature_capability(
    status: FeatureCapabilityStatus,
    reason: &str,
    scope: &str,
) -> FeatureCapability {
    FeatureCapability {
        status,
        reason: reason.to_string(),
        scope: scope.to_string(),
        supported_layer_counts: Vec::new(),
    }
}

fn mixed_p1_feature_capabilities(
    fem_engine: Option<FemEngine>,
) -> BTreeMap<String, FeatureCapability> {
    const FDM_REASON: &str =
        "Mixed-P1 shared-domain topology is FEM-only; FDM retains Cartesian cells.";
    const OPERATOR_SCOPE: &str =
        "double; one axis-aligned P1 Box; one conforming shared-domain airbox; requested_layers=realized_layers={1,2,3}; magnetic_node_planes=requested_layers+1; uniform Ms/Aex; exchange; uniform Zeeman; Poisson Robin|Dirichlet; PG-BB|NCG|overdamped LLG; no fallback";

    let mesh_status = match fem_engine {
        Some(FemEngine::CpuNative | FemEngine::NativeGpu) => FeatureCapabilityStatus::Implemented,
        None => FeatureCapabilityStatus::Unsupported,
    };
    let mesh_reason = match fem_engine {
        Some(FemEngine::CpuNative | FemEngine::NativeGpu) => {
            "Implemented for the certificate-bound explicit CPU/GPU double strict relaxation scope; managed public runtime proof is still pending."
        }
        None => FDM_REASON,
    };
    let mut features = BTreeMap::from([
        (
            "mesh.topology.mixed_p1".to_string(),
            feature_capability(
                mesh_status,
                mesh_reason,
                "conforming P1; prism6 magnetic cells; pyramid5/tet4 air cells; tri3/quad4 facets",
            ),
        ),
        (
            "mesh.swept.prism".to_string(),
            feature_capability(
                mesh_status,
                mesh_reason,
                "requested_layers=realized_layers={1,2,3}; magnetic_node_planes=requested_layers+1; magnetic_cells=prism6; no prism-to-tet conversion",
            ),
        ),
        (
            "mesh.transition.pyramid_tet".to_string(),
            feature_capability(
                mesh_status,
                mesh_reason,
                "pyramid5 transition air; tet4 far air; shared conforming nodes",
            ),
        ),
        (
            "mesh.exact_layer_count".to_string(),
            feature_capability(
                mesh_status,
                mesh_reason,
                "requested_layers=realized_layers={1,2,3}; magnetic_node_planes=requested_layers+1; accepted topology-bound certificate required",
            ),
        ),
    ]);
    for id in MIXED_P1_MESH_FEATURE_CAPABILITY_IDS {
        features
            .get_mut(id)
            .expect("mixed-P1 mesh capability must exist")
            .supported_layer_counts = vec![1, 2, 3];
    }

    for (id, owner) in [
        ("fem.cpu.exchange_demag.mixed_p1", FemEngine::CpuNative),
        ("fem.gpu.exchange_demag.mixed_p1", FemEngine::NativeGpu),
    ] {
        let status = if fem_engine == Some(owner) {
            FeatureCapabilityStatus::Implemented
        } else {
            FeatureCapabilityStatus::Unsupported
        };
        let reason = match fem_engine {
            Some(engine) if engine == owner => {
                "Implemented for the bounded certified mixed-P1 relaxation lane on this device; not production executable until managed public runtime proof is stored."
            }
            Some(_) => "The capability belongs to the other FEM device lane.",
            None => FDM_REASON,
        };
        features.insert(
            id.to_string(),
            feature_capability(status, reason, OPERATOR_SCOPE),
        );
    }

    features
}

pub(crate) fn capabilities_for_fdm_engine(
    engine: FdmEngine,
    profile: FdmCapabilityProfile,
) -> BackendCapabilities {
    let capabilities = match engine {
        FdmEngine::CpuReference => BackendCapabilities {
            supports_frequency_response: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_magnetoelastic_quasistatic: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_magnetoelastic_elastodynamic: DEFERRED_STUDY_CAPABILITY,
            supports_frequency_domain_elastodynamics: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_eigenmodes: DEFERRED_STUDY_CAPABILITY,
            engine_id: RuntimeEngineId::FdmCpuReference,
            capability_profile_version: "2026-07-28".to_string(),
            supported_terms: fdm_supported_terms(profile, false),
            term_scopes: fdm_term_scopes(profile, false),
            feature_capabilities: mixed_p1_feature_capabilities(None),
            supported_demag_realizations: vec!["tensor_fft_newell".to_string()],
            // H_ani and H_dmi are exposed as derived CPU observables when the
            // plan enables the corresponding local anisotropy or DMI terms.
            // H_ant is always zero (no antenna connectivity in the reference path).
            preview_quantities: quantity_names(&[
                QuantityId::M,
                QuantityId::HEx,
                QuantityId::HDemag,
                QuantityId::HExt,
                QuantityId::Torque,
                QuantityId::HAni,
                QuantityId::HDmi,
                QuantityId::HEff,
                QuantityId::EdenEx,
                QuantityId::EdenDemag,
                QuantityId::EdenExt,
                QuantityId::EdenDrive,
                QuantityId::EdenAni,
                QuantityId::EdenDmi,
                QuantityId::EdenTotal,
            ]),
            snapshot_quantities: quantity_names(&[
                QuantityId::M,
                QuantityId::HEx,
                QuantityId::HDemag,
                QuantityId::HExt,
                QuantityId::HAni,
                QuantityId::HDmi,
                QuantityId::HEff,
                QuantityId::EdenEx,
                QuantityId::EdenDemag,
                QuantityId::EdenExt,
                QuantityId::EdenDrive,
                QuantityId::EdenAni,
                QuantityId::EdenDmi,
                QuantityId::EdenTotal,
            ]),
            scalar_outputs: vec![
                "E_ex".to_string(),
                "E_demag".to_string(),
                "E_ext".to_string(),
                "E_total".to_string(),
            ],
            resolved_quantity_registry: None,
            approximate_operators: Vec::new(),
            supports_lossy_fallback_override: false,
        },
        FdmEngine::CudaFdm => BackendCapabilities {
            supports_frequency_response: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_magnetoelastic_quasistatic: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_magnetoelastic_elastodynamic: DEFERRED_STUDY_CAPABILITY,
            supports_frequency_domain_elastodynamics: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_eigenmodes: DEFERRED_STUDY_CAPABILITY,
            engine_id: RuntimeEngineId::FdmCuda,
            capability_profile_version: "2026-07-28".to_string(),
            supported_terms: fdm_supported_terms(profile, true),
            term_scopes: fdm_term_scopes(profile, true),
            feature_capabilities: mixed_p1_feature_capabilities(None),
            supported_demag_realizations: vec!["tensor_fft_newell".to_string()],
            preview_quantities: quantity_names(&[
                QuantityId::M,
                QuantityId::HEx,
                QuantityId::HDemag,
                QuantityId::HExt,
                QuantityId::Torque,
                QuantityId::HAni,
                QuantityId::HEff,
                QuantityId::HOe,
                QuantityId::EdenEx,
                QuantityId::EdenDemag,
                QuantityId::EdenExt,
                QuantityId::EdenAni,
                QuantityId::EdenDmi,
                QuantityId::EdenTotal,
            ]),
            snapshot_quantities: quantity_names(&[
                QuantityId::M,
                QuantityId::HEx,
                QuantityId::HDemag,
                QuantityId::HExt,
                QuantityId::HAni,
                QuantityId::HEff,
                QuantityId::HOe,
                QuantityId::EdenEx,
                QuantityId::EdenDemag,
                QuantityId::EdenExt,
                QuantityId::EdenAni,
                QuantityId::EdenDmi,
                QuantityId::EdenTotal,
            ]),
            scalar_outputs: vec![
                "E_ex".to_string(),
                "E_demag".to_string(),
                "E_ext".to_string(),
                "E_total".to_string(),
            ],
            resolved_quantity_registry: None,
            approximate_operators: Vec::new(),
            supports_lossy_fallback_override: false,
        },
    };
    attach_compatibility_registry(capabilities, fullmag_ir::ExecutionPrecision::Double)
}

/// Resolve the executable quantity surface for the selected precision.
///
/// The observable materialization contract is qualified for both CUDA FP64 and
/// CUDA FP32.  Keep the precision argument in this boundary because the
/// planner/runtime use it as part of the resolved execution identity, but do
/// not silently remove qualified observable IDs from the public capability
/// surface.
pub(crate) fn capabilities_for_fdm_engine_with_precision(
    engine: FdmEngine,
    profile: FdmCapabilityProfile,
    precision: fullmag_ir::ExecutionPrecision,
) -> BackendCapabilities {
    let capabilities = capabilities_for_fdm_engine(engine, profile);
    attach_compatibility_registry(capabilities, precision)
}

pub(crate) fn capabilities_for_fem_engine(engine: FemEngine) -> BackendCapabilities {
    let capabilities = match engine {
        FemEngine::CpuNative => BackendCapabilities {
            supports_frequency_response: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_magnetoelastic_quasistatic: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_magnetoelastic_elastodynamic: DEFERRED_STUDY_CAPABILITY,
            supports_frequency_domain_elastodynamics: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_eigenmodes: DEFERRED_STUDY_CAPABILITY,
            engine_id: RuntimeEngineId::FemCpuNative,
            capability_profile_version: "2026-07-28".to_string(),
            supported_terms: vec![
                "exchange".to_string(),
                "zeeman".to_string(),
                "demag_poisson_robin".to_string(),
                "demag_poisson_dirichlet".to_string(),
                "uniaxial_anisotropy".to_string(),
                "cubic_anisotropy".to_string(),
                "interfacial_dmi".to_string(),
                "magnetoelastic".to_string(),
                "thermal".to_string(),
                "oersted".to_string(),
            ],
            term_scopes: BTreeMap::new(),
            feature_capabilities: mixed_p1_feature_capabilities(Some(FemEngine::CpuNative)),
            supported_demag_realizations: vec![
                "poisson_robin".to_string(),
                "poisson_dirichlet".to_string(),
            ],
            preview_quantities: quantity_names(&[
                QuantityId::M,
                QuantityId::HEx,
                QuantityId::HDemag,
                QuantityId::HExt,
                QuantityId::Torque,
                QuantityId::HEff,
                QuantityId::HAni,
                QuantityId::HDmi,
                QuantityId::HMel,
                QuantityId::EdenEx,
                QuantityId::EdenDemag,
                QuantityId::EdenExt,
                QuantityId::EdenAni,
                QuantityId::EdenDmi,
                QuantityId::EdenTotal,
            ]),
            snapshot_quantities: quantity_names(&[
                QuantityId::M,
                QuantityId::HEx,
                QuantityId::HDemag,
                QuantityId::HExt,
                QuantityId::HEff,
                QuantityId::HAni,
                QuantityId::HDmi,
                QuantityId::HMel,
                QuantityId::EdenEx,
                QuantityId::EdenDemag,
                QuantityId::EdenExt,
                QuantityId::EdenAni,
                QuantityId::EdenDmi,
                QuantityId::EdenTotal,
            ]),
            scalar_outputs: vec![
                "E_ex".to_string(),
                "E_demag".to_string(),
                "E_ext".to_string(),
                "E_total".to_string(),
            ],
            resolved_quantity_registry: None,
            approximate_operators: Vec::new(),
            supports_lossy_fallback_override: false,
        },
        FemEngine::NativeGpu => BackendCapabilities {
            supports_frequency_response: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_magnetoelastic_quasistatic: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_magnetoelastic_elastodynamic: DEFERRED_STUDY_CAPABILITY,
            supports_frequency_domain_elastodynamics: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_eigenmodes: DEFERRED_STUDY_CAPABILITY,
            engine_id: RuntimeEngineId::FemNativeGpu,
            capability_profile_version: "2026-07-29".to_string(),
            supported_terms: vec![
                "exchange".to_string(),
                "zeeman".to_string(),
                "demag_poisson_robin".to_string(),
                "demag_poisson_dirichlet".to_string(),
                "uniaxial_anisotropy".to_string(),
                "cubic_anisotropy".to_string(),
                "interfacial_dmi".to_string(),
                "magnetoelastic".to_string(),
                "thermal".to_string(),
                "oersted".to_string(),
            ],
            term_scopes: BTreeMap::new(),
            feature_capabilities: mixed_p1_feature_capabilities(Some(FemEngine::NativeGpu)),
            supported_demag_realizations: vec![
                "poisson_robin".to_string(),
                "poisson_dirichlet".to_string(),
            ],
            preview_quantities: quantity_names(&[
                QuantityId::M,
                QuantityId::HEx,
                QuantityId::HDemag,
                QuantityId::HExt,
                QuantityId::Torque,
                QuantityId::HEff,
                QuantityId::HAni,
                QuantityId::HDmi,
                QuantityId::HMel,
                QuantityId::EdenEx,
                QuantityId::EdenDemag,
                QuantityId::EdenExt,
                QuantityId::EdenAni,
                QuantityId::EdenDmi,
                QuantityId::EdenTotal,
            ]),
            snapshot_quantities: quantity_names(&[
                QuantityId::M,
                QuantityId::HEx,
                QuantityId::HDemag,
                QuantityId::HExt,
                QuantityId::HEff,
                QuantityId::HAni,
                QuantityId::HDmi,
                QuantityId::HMel,
                QuantityId::EdenEx,
                QuantityId::EdenDemag,
                QuantityId::EdenExt,
                QuantityId::EdenAni,
                QuantityId::EdenDmi,
                QuantityId::EdenTotal,
            ]),
            scalar_outputs: vec![
                "E_ex".to_string(),
                "E_demag".to_string(),
                "E_ext".to_string(),
                "E_total".to_string(),
            ],
            resolved_quantity_registry: None,
            approximate_operators: Vec::new(),
            supports_lossy_fallback_override: false,
        },
    };
    attach_compatibility_registry(capabilities, fullmag_ir::ExecutionPrecision::Double)
}

pub(crate) fn capabilities_for_fem_eigen_engine(engine: FemEngine) -> BackendCapabilities {
    let mut capabilities = capabilities_for_fem_engine(engine);
    capabilities.engine_id = match engine {
        FemEngine::CpuNative => RuntimeEngineId::FemEigenCpuBaseline,
        FemEngine::NativeGpu => RuntimeEngineId::FemEigenNativeGpu,
    };
    align_compatibility_registry_to_final_engine(capabilities)
}

pub(crate) fn capabilities_for_fem_frequency_response_validation_engine(
    engine: FemEngine,
) -> BackendCapabilities {
    let mut capabilities = capabilities_for_fem_engine(engine);
    #[cfg(feature = "fem-gpu")]
    {
        capabilities.engine_id = RuntimeEngineId::FemFrequencyResponseProductionCpu;
    }
    #[cfg(not(feature = "fem-gpu"))]
    {
        capabilities.engine_id = RuntimeEngineId::FemFrequencyResponseDenseValidation;
    }
    align_compatibility_registry_to_final_engine(capabilities)
}

fn align_compatibility_registry_to_final_engine(
    mut capabilities: BackendCapabilities,
) -> BackendCapabilities {
    if let Some(registry) = capabilities.resolved_quantity_registry.take() {
        capabilities.resolved_quantity_registry = Some(
            ResolvedQuantityProviderRegistry::from_compatibility_profile(
                capabilities.engine_id.as_str(),
                registry.precision,
                registry.field_quantities,
                registry.scalar_quantities,
            ),
        );
    }
    capabilities
}

pub(crate) fn mark_study_quantity_registry_as_resolved_plan(
    mut capabilities: BackendCapabilities,
) -> BackendCapabilities {
    let precision = capabilities
        .resolved_quantity_registry
        .as_ref()
        .map(|registry| registry.precision.clone())
        .unwrap_or_else(|| "unknown".to_string());
    capabilities.resolved_quantity_registry =
        Some(ResolvedQuantityProviderRegistry::from_resolved_plan(
            capabilities.engine_id.as_str(),
            precision,
            std::iter::empty::<&str>(),
            std::iter::empty::<&str>(),
        ));
    capabilities
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_resolved_quantity_providers(
        mut capabilities: BackendCapabilities,
        field_quantities: &[&str],
        scalar_quantities: &[&str],
    ) -> BackendCapabilities {
        let precision = capabilities
            .resolved_quantity_registry
            .as_ref()
            .map(|registry| registry.precision.clone())
            .unwrap_or_else(|| "unknown".to_string());
        capabilities.resolved_quantity_registry =
            Some(ResolvedQuantityProviderRegistry::from_resolved_plan(
                capabilities.engine_id.as_str(),
                precision,
                field_quantities,
                scalar_quantities,
            ));
        capabilities
    }

    fn mixed_p1_statuses(
        capabilities: &BackendCapabilities,
    ) -> BTreeMap<&str, FeatureCapabilityStatus> {
        MIXED_P1_FEATURE_CAPABILITY_IDS
            .iter()
            .map(|id| {
                (
                    *id,
                    capabilities
                        .feature_capabilities
                        .get(*id)
                        .unwrap_or_else(|| panic!("missing mixed-P1 capability '{id}'"))
                        .status,
                )
            })
            .collect()
    }

    #[test]
    fn fem_cpu_reports_bounded_mixed_p1_implementation_without_public_promotion() {
        let capabilities = capabilities_for_fem_engine(FemEngine::CpuNative);

        assert_eq!(
            mixed_p1_statuses(&capabilities),
            BTreeMap::from([
                (
                    "mesh.topology.mixed_p1",
                    FeatureCapabilityStatus::Implemented
                ),
                ("mesh.swept.prism", FeatureCapabilityStatus::Implemented),
                (
                    "mesh.transition.pyramid_tet",
                    FeatureCapabilityStatus::Implemented,
                ),
                (
                    "mesh.exact_layer_count",
                    FeatureCapabilityStatus::Implemented,
                ),
                (
                    "fem.cpu.exchange_demag.mixed_p1",
                    FeatureCapabilityStatus::Implemented,
                ),
                (
                    "fem.gpu.exchange_demag.mixed_p1",
                    FeatureCapabilityStatus::Unsupported,
                ),
            ]),
        );
        assert!(capabilities
            .feature_capabilities
            .values()
            .all(|feature| !feature.reason.is_empty() && !feature.scope.is_empty()));
        assert!(MIXED_P1_FEATURE_CAPABILITY_IDS.iter().all(|feature_id| {
            !capabilities
                .supported_terms
                .iter()
                .any(|term| term == feature_id)
        }));
        assert_eq!(
            capabilities.feature_capabilities["mesh.swept.prism"].scope,
            "requested_layers=realized_layers={1,2,3}; magnetic_node_planes=requested_layers+1; magnetic_cells=prism6; no prism-to-tet conversion",
        );
        assert_eq!(
            capabilities.feature_capabilities["mesh.exact_layer_count"].scope,
            "requested_layers=realized_layers={1,2,3}; magnetic_node_planes=requested_layers+1; accepted topology-bound certificate required",
        );
        assert_eq!(
            capabilities.feature_capabilities["mesh.exact_layer_count"].supported_layer_counts,
            vec![1, 2, 3],
        );
        let cpu_operator = &capabilities.feature_capabilities["fem.cpu.exchange_demag.mixed_p1"];
        assert_eq!(cpu_operator.status, FeatureCapabilityStatus::Implemented);
        assert!(cpu_operator
            .scope
            .contains("requested_layers=realized_layers={1,2,3}"));
        assert!(cpu_operator
            .scope
            .contains("magnetic_node_planes=requested_layers+1"));
    }

    #[test]
    fn fem_gpu_reports_bounded_mixed_p1_implementation_without_public_promotion() {
        let capabilities = capabilities_for_fem_engine(FemEngine::NativeGpu);

        assert_eq!(
            mixed_p1_statuses(&capabilities).get("fem.cpu.exchange_demag.mixed_p1"),
            Some(&FeatureCapabilityStatus::Unsupported),
        );
        assert_eq!(
            mixed_p1_statuses(&capabilities).get("fem.gpu.exchange_demag.mixed_p1"),
            Some(&FeatureCapabilityStatus::Implemented),
        );
        for id in &MIXED_P1_MESH_FEATURE_CAPABILITY_IDS {
            assert_eq!(
                capabilities
                    .feature_capabilities
                    .get(*id)
                    .map(|feature| feature.status),
                Some(FeatureCapabilityStatus::Implemented),
            );
        }
        assert_eq!(
            capabilities.feature_capabilities["mesh.exact_layer_count"].scope,
            "requested_layers=realized_layers={1,2,3}; magnetic_node_planes=requested_layers+1; accepted topology-bound certificate required",
        );
        assert_eq!(
            capabilities.feature_capabilities["mesh.exact_layer_count"].supported_layer_counts,
            vec![1, 2, 3],
        );
        let gpu_operator = &capabilities.feature_capabilities["fem.gpu.exchange_demag.mixed_p1"];
        assert_eq!(gpu_operator.status, FeatureCapabilityStatus::Implemented);
        assert!(gpu_operator
            .scope
            .contains("requested_layers=realized_layers={1,2,3}"));
        assert!(gpu_operator
            .scope
            .contains("magnetic_node_planes=requested_layers+1"));
    }

    #[test]
    fn fdm_profiles_do_not_advertise_mixed_p1_execution() {
        for engine in [FdmEngine::CpuReference, FdmEngine::CudaFdm] {
            let capabilities =
                capabilities_for_fdm_engine(engine, FdmCapabilityProfile::SingleGrid);

            assert_eq!(capabilities.feature_capabilities.len(), 6);
            assert!(capabilities
                .feature_capabilities
                .values()
                .all(|feature| feature.status == FeatureCapabilityStatus::Unsupported));
        }
    }

    #[test]
    fn backend_capabilities_deserialize_without_feature_capabilities() {
        let capabilities = capabilities_for_fem_engine(FemEngine::CpuNative);
        let mut legacy = serde_json::to_value(capabilities).expect("serialize capabilities");
        legacy
            .as_object_mut()
            .expect("capabilities serialize as an object")
            .remove("feature_capabilities");

        let decoded: BackendCapabilities =
            serde_json::from_value(legacy).expect("deserialize legacy capabilities");

        assert!(decoded.feature_capabilities.is_empty());
    }

    #[test]
    fn backend_capabilities_serialize_exact_mixed_p1_feature_contract() {
        for (engine, operator_id) in [
            (FemEngine::CpuNative, "fem.cpu.exchange_demag.mixed_p1"),
            (FemEngine::NativeGpu, "fem.gpu.exchange_demag.mixed_p1"),
        ] {
            let capabilities = capabilities_for_fem_engine(engine);
            assert_eq!(capabilities.feature_capabilities.len(), 6);

            let encoded = serde_json::to_value(capabilities).expect("serialize capabilities");
            let features = encoded["feature_capabilities"]
                .as_object()
                .expect("feature capabilities serialize as an object");
            assert_eq!(features.len(), 6);
            assert_eq!(features["mesh.topology.mixed_p1"]["status"], "implemented");
            assert_eq!(features[operator_id]["status"], "implemented");
            for id in MIXED_P1_FEATURE_CAPABILITY_IDS {
                assert!(features[id]["reason"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty()));
                assert!(features[id]["scope"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty()));
            }
        }
    }

    #[test]
    fn fem_time_domain_and_eigen_capabilities_keep_distinct_engine_ids() {
        let fem_cpu = capabilities_for_fem_engine(FemEngine::CpuNative);
        let fem_eigen_cpu = capabilities_for_fem_eigen_engine(FemEngine::CpuNative);
        let fem_response_cpu =
            capabilities_for_fem_frequency_response_validation_engine(FemEngine::CpuNative);
        let fem_gpu = capabilities_for_fem_engine(FemEngine::NativeGpu);
        let fem_eigen_gpu = capabilities_for_fem_eigen_engine(FemEngine::NativeGpu);

        assert_eq!(fem_cpu.engine_id.as_str(), "fem_cpu_native");
        assert_eq!(fem_eigen_cpu.engine_id.as_str(), "fem_eigen_cpu_baseline");
        #[cfg(feature = "fem-gpu")]
        assert_eq!(
            fem_response_cpu.engine_id.as_str(),
            "fem_frequency_response_production_cpu"
        );
        #[cfg(not(feature = "fem-gpu"))]
        assert_eq!(
            fem_response_cpu.engine_id.as_str(),
            "fem_frequency_response_dense_validation"
        );
        assert_eq!(fem_gpu.engine_id.as_str(), "fem_native_gpu");
        assert_eq!(fem_eigen_gpu.engine_id.as_str(), "fem_eigen_native_gpu");

        assert_eq!(fem_cpu.supported_terms, fem_eigen_cpu.supported_terms);
        assert_eq!(fem_cpu.supported_terms, fem_response_cpu.supported_terms);
        assert_eq!(
            fem_gpu.supported_demag_realizations,
            fem_eigen_gpu.supported_demag_realizations
        );
    }

    #[test]
    fn frequency_response_and_two_way_magnetoelasticity_are_explicitly_deferred() {
        let capabilities = [
            capabilities_for_fdm_engine(FdmEngine::CpuReference, FdmCapabilityProfile::SingleGrid),
            capabilities_for_fdm_engine(FdmEngine::CudaFdm, FdmCapabilityProfile::SingleGrid),
            capabilities_for_fem_engine(FemEngine::CpuNative),
            capabilities_for_fem_engine(FemEngine::NativeGpu),
            capabilities_for_fem_eigen_engine(FemEngine::CpuNative),
            capabilities_for_fem_eigen_engine(FemEngine::NativeGpu),
            capabilities_for_fem_frequency_response_validation_engine(FemEngine::CpuNative),
        ];

        for capability in capabilities {
            assert!(
                !capability.supports_frequency_response,
                "{} must not advertise driven frequency response execution",
                capability.engine_id.as_str()
            );
            assert!(
                !capability.supports_coupled_magnetoelastic_quasistatic,
                "{} must not advertise quasistatic two-way magnetoelasticity",
                capability.engine_id.as_str()
            );
            assert!(
                !capability.supports_coupled_magnetoelastic_elastodynamic,
                "{} must not advertise elastodynamic magnetoelasticity",
                capability.engine_id.as_str()
            );
            assert!(
                !capability.supports_frequency_domain_elastodynamics,
                "{} must not advertise frequency-domain elastodynamics",
                capability.engine_id.as_str()
            );
            assert!(
                !capability.supports_coupled_eigenmodes,
                "{} must not advertise coupled magnon-phonon eigenmodes",
                capability.engine_id.as_str()
            );
        }
    }

    #[test]
    fn multilayer_fdm_catalog_excludes_terms_the_planner_rejects() {
        for engine in [FdmEngine::CpuReference, FdmEngine::CudaFdm] {
            let capabilities =
                capabilities_for_fdm_engine(engine, FdmCapabilityProfile::Multilayer);
            for term in [
                "thermal",
                "stt",
                "sot",
                "oersted",
                "bulk_dmi",
                "magnetoelastic",
            ] {
                assert!(
                    !capabilities
                        .supported_terms
                        .iter()
                        .any(|candidate| candidate == term),
                    "{} must not advertise '{term}' for a public multilayer FDM plan",
                    capabilities.engine_id.as_str(),
                );
            }
        }
    }

    #[test]
    fn single_grid_fdm_catalog_advertises_only_current_public_fdm_terms() {
        for engine in [FdmEngine::CpuReference, FdmEngine::CudaFdm] {
            let capabilities =
                capabilities_for_fdm_engine(engine, FdmCapabilityProfile::SingleGrid);
            for term in ["thermal", "stt", "sot", "oersted"] {
                assert!(
                    capabilities
                        .supported_terms
                        .iter()
                        .any(|candidate| candidate == term),
                    "{} must advertise its executable single-grid '{term}' path",
                    capabilities.engine_id.as_str(),
                );
            }
            assert!(
                !capabilities
                    .supported_terms
                    .iter()
                    .any(|candidate| candidate == "magnetoelastic"),
                "{} must not advertise the semantic-only FDM magnetoelastic path",
                capabilities.engine_id.as_str(),
            );
        }
    }

    #[test]
    fn single_grid_cuda_oersted_scope_is_not_advertised_as_general_geometry() {
        let capabilities =
            capabilities_for_fdm_engine(FdmEngine::CudaFdm, FdmCapabilityProfile::SingleGrid);

        assert_eq!(
            capabilities.term_scopes.get("oersted").map(String::as_str),
            Some(
                "single_grid; cylinder_axis=+z/time_dependence=constant; field=precomputed_static"
            ),
        );
        assert_eq!(
            capabilities.term_scopes.get("thermal").map(String::as_str),
            Some("single_grid; fixed_timestep; adaptive=unsupported; H_therm=unmaterialized"),
        );
    }

    #[test]
    fn cuda_single_precision_advertises_qualified_observables() {
        let capabilities = capabilities_for_fdm_engine_with_precision(
            FdmEngine::CudaFdm,
            FdmCapabilityProfile::SingleGrid,
            fullmag_ir::ExecutionPrecision::Single,
        );
        for quantity in [
            "H_demag",
            "H_eff",
            "eden_ex",
            "eden_demag",
            "eden_ext",
            "eden_ani",
            "eden_dmi",
            "eden_total",
        ] {
            assert!(capabilities
                .preview_quantities
                .iter()
                .any(|id| id == quantity));
            assert!(capabilities
                .snapshot_quantities
                .iter()
                .any(|id| id == quantity));
        }
        assert!(capabilities.preview_quantities.iter().any(|id| id == "m"));
    }

    #[test]
    fn fem_capability_profile_exposes_only_materializable_energy_density_shapes() {
        let expected = [
            "eden_ex",
            "eden_demag",
            "eden_ext",
            "eden_ani",
            "eden_dmi",
            "eden_total",
        ];

        for capabilities in [
            capabilities_for_fem_engine(FemEngine::CpuNative),
            capabilities_for_fem_engine(FemEngine::NativeGpu),
        ] {
            for quantity in expected {
                assert!(
                    capabilities
                        .preview_quantities
                        .iter()
                        .any(|id| id == quantity),
                    "{} must expose materializable FEM preview quantity {quantity}",
                    capabilities.engine_id.as_str()
                );
                assert!(
                    capabilities
                        .snapshot_quantities
                        .iter()
                        .any(|id| id == quantity),
                    "{} must expose materializable FEM snapshot quantity {quantity}",
                    capabilities.engine_id.as_str()
                );
            }
        }
    }

    #[test]
    fn resolved_quantity_capability_keeps_all_five_planes_and_carrier_metadata() {
        let capabilities = with_resolved_quantity_providers(
            capabilities_for_fdm_engine(FdmEngine::CpuReference, FdmCapabilityProfile::SingleGrid),
            &["H_demag"],
            &[],
        );
        let spec = fullmag_quantities::quantity_spec("H_demag").expect("canonical quantity");
        let carrier = FieldCarrierDescriptor {
            carrier_id: "field:H_demag:full".to_string(),
            carrier_fingerprint: "verified-topology".to_string(),
            scope: "full_domain".to_string(),
            scope_kind: "full_domain".to_string(),
            scope_id: None,
            components: 3,
            indexing: "full_domain".to_string(),
            view: "full".to_string(),
            payload_version: Some("fmvp.v3".to_string()),
            payload_state: FieldPayloadState::Current,
        };

        let resolved = resolve_quantity_capability(
            &capabilities,
            spec,
            ResolvedQuantityCapabilityContext {
                scope: "full_domain",
                precision: "double",
                materialization: QuantityMaterializationCapability::Materialized,
                carriers: vec![carrier.clone()],
            },
        );

        assert_eq!(resolved.provider, QuantityProviderCapability::Available);
        assert_eq!(resolved.request, QuantityRequestCapability::FieldVector);
        assert_eq!(
            resolved.materialization,
            QuantityMaterializationCapability::Materialized
        );
        assert_eq!(resolved.render, QuantityRenderCapability::Renderable);
        assert_eq!(
            resolved.publication,
            QuantityPublicationCapability::Interactive
        );
        assert_eq!(resolved.lane, "fdm_cpu_reference");
        assert_eq!(resolved.precision, "double");
        assert_eq!(resolved.carriers, vec![carrier]);
    }

    #[test]
    fn provider_registry_keeps_scalar_and_spatial_planes_separate() {
        let mut capabilities =
            capabilities_for_fdm_engine(FdmEngine::CpuReference, FdmCapabilityProfile::SingleGrid);
        capabilities.resolved_quantity_registry =
            Some(ResolvedQuantityProviderRegistry::from_resolved_plan(
                "fdm_cpu_reference",
                "double",
                std::iter::empty::<&str>(),
                ["E_total", "H_demag"],
            ));

        let registry = capabilities
            .resolved_quantity_registry
            .as_ref()
            .expect("resolved provider registry");
        let spatial = fullmag_quantities::quantity_spec("H_demag").expect("spatial quantity");
        let scalar = fullmag_quantities::quantity_spec("E_total").expect("scalar quantity");

        assert!(!registry.contains(spatial));
        assert!(registry.contains(scalar));
    }

    #[test]
    fn provider_registry_uses_resolved_plan_projection_for_field_quantities() {
        let mut capabilities =
            capabilities_for_fdm_engine(FdmEngine::CpuReference, FdmCapabilityProfile::SingleGrid);
        capabilities.resolved_quantity_registry =
            Some(ResolvedQuantityProviderRegistry::from_resolved_plan(
                "fdm_cpu_reference",
                "double",
                ["H_demag"],
                std::iter::empty::<&str>(),
            ));

        let spec = fullmag_quantities::quantity_spec("H_demag").expect("spatial quantity");
        let resolved = resolve_quantity_capability(
            &capabilities,
            spec,
            ResolvedQuantityCapabilityContext {
                scope: "full_domain",
                precision: "double",
                materialization: QuantityMaterializationCapability::Unmaterialized,
                carriers: Vec::new(),
            },
        );

        assert_eq!(resolved.provider, QuantityProviderCapability::Available);
        assert_eq!(resolved.request, QuantityRequestCapability::FieldVector);
    }

    #[test]
    fn static_compatibility_registry_is_not_provider_truth() {
        let capabilities =
            capabilities_for_fdm_engine(FdmEngine::CpuReference, FdmCapabilityProfile::SingleGrid);
        let spec = fullmag_quantities::quantity_spec("H_demag").expect("canonical quantity");

        let resolved = resolve_quantity_capability(
            &capabilities,
            spec,
            ResolvedQuantityCapabilityContext {
                scope: "full_domain",
                precision: "double",
                materialization: QuantityMaterializationCapability::Unmaterialized,
                carriers: Vec::new(),
            },
        );

        assert_eq!(resolved.provider, QuantityProviderCapability::Unavailable);
        assert_eq!(
            resolved.reason_code.as_deref(),
            Some("quantity_registry_not_resolved_plan")
        );
    }

    #[test]
    fn fem_study_registries_match_final_engine_identity() {
        for capabilities in [
            capabilities_for_fem_eigen_engine(FemEngine::CpuNative),
            capabilities_for_fem_eigen_engine(FemEngine::NativeGpu),
            capabilities_for_fem_frequency_response_validation_engine(FemEngine::CpuNative),
        ] {
            let registry = capabilities
                .resolved_quantity_registry
                .as_ref()
                .expect("resolved FEM study registry");
            assert_eq!(registry.lane, capabilities.engine_id.as_str());
            assert_eq!(registry.precision, "double");
            assert_eq!(
                registry.source,
                QuantityProviderRegistrySource::CompatibilityProfile
            );
        }
    }

    #[test]
    fn planned_fem_study_registry_is_resolved_but_has_no_invented_providers() {
        let capabilities = mark_study_quantity_registry_as_resolved_plan(
            capabilities_for_fem_eigen_engine(FemEngine::CpuNative),
        );
        let registry = capabilities
            .resolved_quantity_registry
            .as_ref()
            .expect("resolved FEM study registry");
        assert_eq!(registry.lane, capabilities.engine_id.as_str());
        assert_eq!(
            registry.source,
            QuantityProviderRegistrySource::ResolvedPlan
        );
        assert!(registry.field_quantities.is_empty());
        assert!(registry.scalar_quantities.is_empty());

        let spec = fullmag_quantities::quantity_spec("H_demag").expect("canonical quantity");
        let resolved = resolve_quantity_capability(
            &capabilities,
            spec,
            ResolvedQuantityCapabilityContext {
                scope: "full",
                precision: "double",
                materialization: QuantityMaterializationCapability::Unmaterialized,
                carriers: Vec::new(),
            },
        );
        assert_eq!(resolved.provider, QuantityProviderCapability::Unavailable);
        assert_eq!(
            resolved.reason_code.as_deref(),
            Some("quantity_unsupported")
        );
    }

    #[test]
    fn compatibility_quantity_lists_cannot_mutate_resolved_provider_plane() {
        let mut capabilities =
            capabilities_for_fdm_engine(FdmEngine::CpuReference, FdmCapabilityProfile::SingleGrid);
        capabilities.preview_quantities = vec!["H_demag".to_string()];
        capabilities.snapshot_quantities.clear();
        capabilities.scalar_outputs.clear();
        capabilities.resolved_quantity_registry =
            Some(ResolvedQuantityProviderRegistry::from_resolved_plan(
                "fdm_cpu_reference",
                "double",
                std::iter::empty::<&str>(),
                std::iter::empty::<&str>(),
            ));

        let spec = fullmag_quantities::quantity_spec("H_demag").expect("spatial quantity");
        let resolved = resolve_quantity_capability(
            &capabilities,
            spec,
            ResolvedQuantityCapabilityContext {
                scope: "full_domain",
                precision: "double",
                materialization: QuantityMaterializationCapability::Unmaterialized,
                carriers: Vec::new(),
            },
        );

        assert_eq!(resolved.provider, QuantityProviderCapability::Unavailable);
        assert_eq!(
            resolved.reason_code.as_deref(),
            Some("quantity_unsupported")
        );
    }

    #[test]
    fn resolved_tensor_capability_is_requestable_but_not_renderable() {
        let capabilities = with_resolved_quantity_providers(
            capabilities_for_fem_engine(FemEngine::CpuNative),
            &["spin_current_tensor"],
            &[],
        );
        let spec = fullmag_quantities::quantity_spec("spin_current_tensor")
            .expect("canonical tensor quantity");

        let resolved = resolve_quantity_capability(
            &capabilities,
            spec,
            ResolvedQuantityCapabilityContext {
                scope: "magnetic_only",
                precision: "double",
                materialization: QuantityMaterializationCapability::Unmaterialized,
                carriers: Vec::new(),
            },
        );

        assert_eq!(resolved.provider, QuantityProviderCapability::Available);
        assert_eq!(
            resolved.request,
            QuantityRequestCapability::FieldVector
        );
        assert_eq!(
            resolved.materialization,
            QuantityMaterializationCapability::Unmaterialized
        );
        assert_eq!(resolved.render, QuantityRenderCapability::UnsupportedShape);
        assert_eq!(
            resolved.reason_code.as_deref(),
            Some("field_unmaterialized")
        );
        assert!(resolved.carriers.is_empty());
    }

    #[test]
    fn legacy_payload_can_never_resolve_as_current_materialization() {
        let capabilities = with_resolved_quantity_providers(
            capabilities_for_fdm_engine(FdmEngine::CpuReference, FdmCapabilityProfile::SingleGrid),
            &["m"],
            &[],
        );
        let spec = fullmag_quantities::quantity_spec("m").expect("canonical quantity");

        let resolved = resolve_quantity_capability(
            &capabilities,
            spec,
            ResolvedQuantityCapabilityContext {
                scope: "magnetic_only",
                precision: "double",
                materialization: QuantityMaterializationCapability::LegacyUnverified,
                carriers: vec![FieldCarrierDescriptor {
                    carrier_id: "legacy:m".to_string(),
                    carrier_fingerprint: "legacy-fingerprint".to_string(),
                    scope: "magnetic_only".to_string(),
                    scope_kind: "magnetic_only".to_string(),
                    scope_id: None,
                    components: 3,
                    indexing: "legacy_count_only".to_string(),
                    view: "full".to_string(),
                    payload_version: Some("fmvp.v2".to_string()),
                    payload_state: FieldPayloadState::LegacyUnverified,
                }],
            },
        );

        assert_eq!(
            resolved.materialization,
            QuantityMaterializationCapability::LegacyUnverified
        );
        assert_eq!(resolved.reason_code.as_deref(), Some("legacy_unverified"));
        assert_eq!(
            resolved.carriers[0].payload_state,
            FieldPayloadState::LegacyUnverified
        );
    }
}
