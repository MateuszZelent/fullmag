//! FEM periodic-boundary capability decisions before runtime execution.

use fullmag_ir::FemPlanIR;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FemStaticPbcLane {
    /// No periodic node pairs; native path unconditionally.
    None,
    /// Exchange + uniform Zeeman only. Native FEM PBC is fully supported.
    NativeExchangeOnly,
    /// Exchange + local uniaxial/cubic anisotropy or DMI without demag.
    NativeAnisotropy,
    /// Exchange + demag via algebraic P^T A P reduction in MFEM/hypre Poisson.
    NativeDemagPoisson,
    /// DMI fallback through the Rust CPU reference solver.
    #[allow(dead_code)]
    ReferenceReduction,
    /// Terms that cannot be handled by any available periodic path.
    Unsupported,
}

/// Result of the FEM static PBC capability decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FemStaticPbcDecision {
    pub lane: FemStaticPbcLane,
    /// Human-readable explanation for the chosen lane.
    pub reason: Option<String>,
    /// Interactions that could not be accommodated by the native path.
    pub unsupported_interactions: Vec<String>,
}

impl FemStaticPbcDecision {
    fn native(lane: FemStaticPbcLane) -> Self {
        Self {
            lane,
            reason: None,
            unsupported_interactions: Vec::new(),
        }
    }

    #[allow(dead_code)]
    fn reference_reduction(reason: impl Into<String>) -> Self {
        Self {
            lane: FemStaticPbcLane::ReferenceReduction,
            reason: Some(reason.into()),
            unsupported_interactions: Vec::new(),
        }
    }

    fn unsupported(reason: impl Into<String>, interactions: Vec<String>) -> Self {
        Self {
            lane: FemStaticPbcLane::Unsupported,
            reason: Some(reason.into()),
            unsupported_interactions: interactions,
        }
    }

    /// Returns `true` if the native FEM backend can execute this plan.
    pub(crate) fn is_native(&self) -> bool {
        matches!(
            self.lane,
            FemStaticPbcLane::None
                | FemStaticPbcLane::NativeExchangeOnly
                | FemStaticPbcLane::NativeAnisotropy
                | FemStaticPbcLane::NativeDemagPoisson
        )
    }
}

/// Decide which execution lane to use for a FEM plan that may carry
/// static/time-domain periodic node pairs.
pub(crate) fn fem_static_periodic_decision(plan: &FemPlanIR) -> FemStaticPbcDecision {
    if plan.mesh.periodic_node_pairs.is_empty() {
        return FemStaticPbcDecision::native(FemStaticPbcLane::None);
    }

    let mut unsupported = Vec::new();
    if plan.temperature.unwrap_or(0.0) > 0.0 {
        unsupported.push("thermal_noise".to_string());
    }
    if plan.current_density.is_some() || plan.stt_spin_polarization.is_some() {
        unsupported.push("stt".to_string());
    }
    if plan.has_oersted_cylinder
        || plan
            .oersted_field_xyz
            .as_ref()
            .is_some_and(|v| !v.is_empty())
    {
        unsupported.push("oersted".to_string());
    }
    if plan.magnetoelastic.is_some() {
        unsupported.push("magnetoelastic".to_string());
    }
    if !unsupported.is_empty() {
        return FemStaticPbcDecision::unsupported(
            format!(
                "FEM static/time-domain PBC does not support: {}. \
                 These terms require non-periodic boundary conditions or \
                 non-local operators that have no algebraic periodic reduction.",
                unsupported.join(", ")
            ),
            unsupported,
        );
    }

    let has_demag = plan.enable_demag;
    let has_dmi = plan.interfacial_dmi.is_some()
        || plan.bulk_dmi.is_some()
        || plan.dind_field.as_ref().is_some_and(|v| !v.is_empty())
        || plan.dbulk_field.as_ref().is_some_and(|v| !v.is_empty());

    if has_dmi && has_demag {
        return FemStaticPbcDecision::native(FemStaticPbcLane::NativeDemagPoisson);
    }
    if has_dmi {
        return FemStaticPbcDecision::native(FemStaticPbcLane::NativeAnisotropy);
    }
    if has_demag {
        return FemStaticPbcDecision::native(FemStaticPbcLane::NativeDemagPoisson);
    }

    let has_anisotropy = plan.material.uniaxial_anisotropy.is_some()
        || plan.material.uniaxial_anisotropy_k2.is_some()
        || plan.material.cubic_anisotropy_kc1.is_some()
        || plan.material.cubic_anisotropy_kc2.is_some()
        || plan.material.cubic_anisotropy_kc3.is_some()
        || plan
            .material
            .ku_field
            .as_ref()
            .is_some_and(|v| !v.is_empty())
        || plan
            .material
            .ku2_field
            .as_ref()
            .is_some_and(|v| !v.is_empty())
        || plan
            .material
            .kc1_field
            .as_ref()
            .is_some_and(|v| !v.is_empty())
        || plan
            .material
            .kc2_field
            .as_ref()
            .is_some_and(|v| !v.is_empty())
        || plan
            .material
            .kc3_field
            .as_ref()
            .is_some_and(|v| !v.is_empty());

    if has_anisotropy {
        return FemStaticPbcDecision::native(FemStaticPbcLane::NativeAnisotropy);
    }

    FemStaticPbcDecision::native(FemStaticPbcLane::NativeExchangeOnly)
}

/// Legacy helper used at call sites that only need a binary native-path answer.
#[allow(dead_code)]
pub(crate) fn fem_static_periodic_native_exchange_supported(plan: &FemPlanIR) -> bool {
    fem_static_periodic_decision(plan).is_native()
}
