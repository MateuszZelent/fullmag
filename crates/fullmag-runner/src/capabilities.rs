use crate::dispatch::{FdmEngine, FemEngine};
use crate::quantities::QuantityId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
    pub supported_demag_realizations: Vec<String>,
    pub preview_quantities: Vec<String>,
    pub snapshot_quantities: Vec<String>,
    pub scalar_outputs: Vec<String>,
    pub approximate_operators: Vec<String>,
    pub supports_frequency_response: bool,
    pub supports_coupled_magnetoelastic_quasistatic: bool,
    pub supports_coupled_magnetoelastic_elastodynamic: bool,
    pub supports_frequency_domain_elastodynamics: bool,
    pub supports_coupled_eigenmodes: bool,
    pub supports_lossy_fallback_override: bool,
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
            "single_grid; fixed_timestep; adaptive=unsupported; H_therm=unmaterialized"
                .to_string(),
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

pub(crate) fn capabilities_for_fdm_engine(
    engine: FdmEngine,
    profile: FdmCapabilityProfile,
) -> BackendCapabilities {
    match engine {
        FdmEngine::CpuReference => BackendCapabilities {
            supports_frequency_response: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_magnetoelastic_quasistatic: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_magnetoelastic_elastodynamic: DEFERRED_STUDY_CAPABILITY,
            supports_frequency_domain_elastodynamics: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_eigenmodes: DEFERRED_STUDY_CAPABILITY,
            engine_id: RuntimeEngineId::FdmCpuReference,
            capability_profile_version: "2026-07-19".to_string(),
            supported_terms: fdm_supported_terms(profile, false),
            term_scopes: fdm_term_scopes(profile, false),
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
            capability_profile_version: "2026-07-19".to_string(),
            supported_terms: fdm_supported_terms(profile, true),
            term_scopes: fdm_term_scopes(profile, true),
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
            ]),
            snapshot_quantities: quantity_names(&[
                QuantityId::M,
                QuantityId::HEx,
                QuantityId::HDemag,
                QuantityId::HExt,
                QuantityId::HAni,
                QuantityId::HEff,
                QuantityId::HOe,
            ]),
            scalar_outputs: vec![
                "E_ex".to_string(),
                "E_demag".to_string(),
                "E_ext".to_string(),
                "E_total".to_string(),
            ],
            approximate_operators: Vec::new(),
            supports_lossy_fallback_override: false,
        },
    }
}

pub(crate) fn capabilities_for_fem_engine(engine: FemEngine) -> BackendCapabilities {
    match engine {
        FemEngine::CpuNative => BackendCapabilities {
            supports_frequency_response: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_magnetoelastic_quasistatic: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_magnetoelastic_elastodynamic: DEFERRED_STUDY_CAPABILITY,
            supports_frequency_domain_elastodynamics: DEFERRED_STUDY_CAPABILITY,
            supports_coupled_eigenmodes: DEFERRED_STUDY_CAPABILITY,
            engine_id: RuntimeEngineId::FemCpuNative,
            capability_profile_version: "2026-04-04".to_string(),
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
            ]),
            scalar_outputs: vec![
                "E_ex".to_string(),
                "E_demag".to_string(),
                "E_ext".to_string(),
                "E_total".to_string(),
            ],
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
            capability_profile_version: "2026-04-04".to_string(),
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
            ]),
            scalar_outputs: vec![
                "E_ex".to_string(),
                "E_demag".to_string(),
                "E_ext".to_string(),
                "E_total".to_string(),
            ],
            approximate_operators: Vec::new(),
            supports_lossy_fallback_override: false,
        },
    }
}

pub(crate) fn capabilities_for_fem_eigen_engine(engine: FemEngine) -> BackendCapabilities {
    let mut capabilities = capabilities_for_fem_engine(engine);
    capabilities.engine_id = match engine {
        FemEngine::CpuNative => RuntimeEngineId::FemEigenCpuBaseline,
        FemEngine::NativeGpu => RuntimeEngineId::FemEigenNativeGpu,
    };
    capabilities
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
    capabilities
}

#[cfg(test)]
mod tests {
    use super::*;

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
            capabilities_for_fdm_engine(
                FdmEngine::CpuReference,
                FdmCapabilityProfile::SingleGrid,
            ),
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
            let capabilities = capabilities_for_fdm_engine(engine, FdmCapabilityProfile::Multilayer);
            for term in [
                "thermal",
                "stt",
                "sot",
                "oersted",
                "bulk_dmi",
                "magnetoelastic",
            ] {
                assert!(
                    !capabilities.supported_terms.iter().any(|candidate| candidate == term),
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
                    capabilities.supported_terms.iter().any(|candidate| candidate == term),
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
}
