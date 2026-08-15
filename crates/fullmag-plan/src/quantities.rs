//! Quantity capability matrix for the planner (QB-15 + QB-11).
//!
//! Per backend and per quantity, records whether the quantity can be
//! evaluated (exact / derived / unsupported / planned).
//! The planner uses this matrix to:
//! - validate output requests,
//! - reject unsupported quantity requests early,
//! - inform the API capability endpoint.

use fullmag_quantities::QuantityId;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Backend family identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendFamily {
    FdmCpuReference,
    FdmCuda,
    FemCpuNative,
    FemGpu,
}

/// Capability level for a quantity on a specific backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantityCapability {
    /// Backend computes this quantity natively.
    Exact,
    /// Backend can derive this quantity from other quantities.
    Derived,
    /// Backend does not support this quantity.
    Unsupported,
    /// Support is planned but not yet implemented.
    Planned,
}

/// Capability matrix: backend × quantity → capability level.
#[derive(Debug, Clone, Default)]
pub struct CapabilityMatrix {
    entries: HashMap<(BackendFamily, QuantityId), QuantityCapability>,
}

impl CapabilityMatrix {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the capability for a (backend, quantity) pair.
    pub fn set(
        &mut self,
        backend: BackendFamily,
        quantity: QuantityId,
        capability: QuantityCapability,
    ) {
        self.entries.insert((backend, quantity), capability);
    }

    /// Get the capability for a (backend, quantity) pair.
    /// Returns `Unsupported` if not explicitly set.
    pub fn get(&self, backend: BackendFamily, quantity: QuantityId) -> QuantityCapability {
        self.entries
            .get(&(backend, quantity))
            .copied()
            .unwrap_or(QuantityCapability::Unsupported)
    }

    /// Check whether a quantity is available on a backend (Exact or Derived).
    pub fn is_available(&self, backend: BackendFamily, quantity: QuantityId) -> bool {
        matches!(
            self.get(backend, quantity),
            QuantityCapability::Exact | QuantityCapability::Derived
        )
    }

    /// List all quantities available on a given backend.
    pub fn available_for_backend(&self, backend: BackendFamily) -> Vec<QuantityId> {
        self.entries
            .iter()
            .filter(|((b, _), cap)| {
                *b == backend
                    && matches!(cap, QuantityCapability::Exact | QuantityCapability::Derived)
            })
            .map(|((_, q), _)| *q)
            .collect()
    }
}

/// Build the default capability matrix for known backends.
///
/// This encodes the current state of quantity support across backends.
/// When a new backend gains support for a quantity, add it here.
pub fn default_capability_matrix() -> CapabilityMatrix {
    use BackendFamily::*;
    use QuantityCapability::*;
    use QuantityId::*;

    let mut m = CapabilityMatrix::new();

    // ── FDM CPU Reference ────────────────────────────────────
    let fdm_cpu_exact = [M, HEx, HDemag, HExt, HAnt, HEff, EEx, EDemag, EExt, ETotal];
    for id in fdm_cpu_exact {
        m.set(FdmCpuReference, id, Exact);
    }
    // Derived fields on FDM CPU
    for id in [HAni, HDmi, HMel, HAniCubic, HDmiBulk] {
        m.set(FdmCpuReference, id, Derived);
    }
    for id in [EdenEx, EdenDemag, EdenExt, EdenDrive, EdenAni, EdenDmi, EdenTotal, EAni, EDmi, MatMs, MatAex, MatAlpha] {
        m.set(FdmCpuReference, id, Derived);
    }
    // Planned for FDM CPU
    for id in [HOe, HTherm] {
        m.set(FdmCpuReference, id, Planned);
    }

    // ── FDM CUDA ─────────────────────────────────────────────
    for id in [M, HEx, HDemag, HExt, HAnt, HEff, EEx, EDemag, EExt, ETotal] {
        m.set(FdmCuda, id, Exact);
    }
    for id in [HAni, HDmi, EdenEx, EdenDemag, EdenExt, EdenDrive, EdenAni, EdenDmi, EdenTotal, EAni, EDmi] {
        m.set(FdmCuda, id, Derived);
    }
    for id in [
        HMel, HAniCubic, HDmiBulk, HOe, HTherm, MatMs, MatAex, MatAlpha,
    ] {
        m.set(FdmCuda, id, Planned);
    }

    // ── FEM CPU Native ───────────────────────────────────────
    for id in [M, HEx, HDemag, HExt, HEff, EEx, EDemag, EExt, ETotal] {
        m.set(FemCpuNative, id, Exact);
    }
    for id in [HAni, HDmi, EAni, EDmi] {
        m.set(FemCpuNative, id, Derived);
    }
    for id in [
        HAnt, HMel, HAniCubic, HDmiBulk, HOe, HTherm, MatMs, MatAex, MatAlpha, MatDind, MatDbulk,
    ] {
        m.set(FemCpuNative, id, Planned);
    }
    // Eigenmodes on FEM
    for id in [ModeAmplitude, ModeReal, ModeImag, ModePhase] {
        m.set(FemCpuNative, id, Exact);
    }

    // ── FEM GPU ──────────────────────────────────────────────
    for id in [M, HEx, HDemag, HExt, HEff, EEx, EDemag, EExt, ETotal] {
        m.set(FemGpu, id, Exact);
    }
    for id in [HAni, HDmi, EAni, EDmi] {
        m.set(FemGpu, id, Derived);
    }
    for id in [
        HAnt, HMel, HAniCubic, HDmiBulk, HOe, HTherm, MatMs, MatAex, MatAlpha, MatDind, MatDbulk,
    ] {
        m.set(FemGpu, id, Planned);
    }
    for id in [ModeAmplitude, ModeReal, ModeImag, ModePhase] {
        m.set(FemGpu, id, Exact);
    }

    m
}

/// Validate a list of quantity output requests against the capability matrix.
///
/// Returns a list of unsupported quantity IDs.
pub fn validate_quantity_requests(
    matrix: &CapabilityMatrix,
    backend: BackendFamily,
    requested: &[QuantityId],
) -> Vec<QuantityId> {
    requested
        .iter()
        .filter(|id| !matrix.is_available(backend, **id))
        .copied()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use QuantityId::*;

    #[test]
    fn default_matrix_covers_core_quantities() {
        let m = default_capability_matrix();
        assert!(m.is_available(BackendFamily::FdmCpuReference, M));
        assert!(m.is_available(BackendFamily::FdmCpuReference, HEx));
        assert!(m.is_available(BackendFamily::FdmCpuReference, ETotal));
        assert!(m.is_available(BackendFamily::FdmCpuReference, HAni));
        assert!(!m.is_available(BackendFamily::FdmCpuReference, HOe)); // planned
    }

    #[test]
    fn fdm_cpu_and_cuda_expose_spatial_energy_density_capabilities() {
        let m = default_capability_matrix();
        for quantity in [EdenEx, EdenDemag, EdenExt, EdenDrive, EdenAni, EdenDmi, EdenTotal] {
            assert!(m.is_available(BackendFamily::FdmCpuReference, quantity));
            assert!(m.is_available(BackendFamily::FdmCuda, quantity));
        }
    }

    #[test]
    fn fem_has_eigenmode_support() {
        let m = default_capability_matrix();
        assert!(m.is_available(BackendFamily::FemCpuNative, ModeReal));
        assert!(m.is_available(BackendFamily::FemCpuNative, ModeAmplitude));
        // FDM doesn't have eigenmodes
        assert!(!m.is_available(BackendFamily::FdmCpuReference, ModeReal));
    }

    #[test]
    fn validate_rejects_unsupported() {
        let m = default_capability_matrix();
        let unsupported =
            validate_quantity_requests(&m, BackendFamily::FdmCpuReference, &[M, HOe, HTherm]);
        assert_eq!(unsupported.len(), 2);
        assert!(unsupported.contains(&HOe));
        assert!(unsupported.contains(&HTherm));
    }
}
