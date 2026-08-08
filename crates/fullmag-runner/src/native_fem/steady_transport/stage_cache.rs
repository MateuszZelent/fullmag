use crate::types::RunError;
use fullmag_ir::{
    ConservativeCurrentClosureIR, ResolvedFemConservativeCurrentViewIR,
    ResolvedSpinTransportPlanIR, TransportCouplingIR,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// A steady one-way Ohmic source may be reused by every magnetic RHS only
/// when its complete physical identity is unchanged.  This is deliberately a
/// different policy from a magnetization-dependent LLG-stage solve.
pub(crate) const STEADY_SOURCE_CACHE_POLICY: &str = "steady_source_invariant.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct SteadySourceCacheKey {
    pub source_state_revision: String,
    pub source_field_digest: String,
    pub conductivity_digest: String,
    pub mesh_revision: String,
    pub topology_revision: String,
    pub geometry_digest: String,
    pub envelope_revision: String,
    pub envelope_digest: String,
    pub closure_revision: String,
    pub closure_digest: String,
    pub evaluation_time_bits: u64,
    pub evaluated_envelope_multiplier_bits: u64,
    pub stage_identity: u64,
}

impl SteadySourceCacheKey {
    pub(crate) fn from_view(
        view: &ResolvedFemConservativeCurrentViewIR,
    ) -> Result<Self, RunError> {
        let ConservativeCurrentClosureIR::ClosedGeometry {
            revision, digest, ..
        } = &view.closure
        else {
            return Err(RunError {
                message:
                    "steady source cache requires a closed-geometry conservative current view"
                        .into(),
            });
        };
        if !view.identity.evaluation_time_s.is_finite()
            || !view.identity.evaluated_envelope_multiplier.is_finite()
            || view.identity.stage_identity == 0
        {
            return Err(RunError {
                message: "steady source cache identity contains a non-finite time, envelope, or zero stage identity".into(),
            });
        }
        Ok(Self {
            source_state_revision: view.identity.source_state_revision.clone(),
            source_field_digest: view.identity.source_field_digest.clone(),
            conductivity_digest: view.identity.conductivity_digest.clone(),
            mesh_revision: view.identity.mesh_revision.clone(),
            topology_revision: view.identity.topology_revision.clone(),
            geometry_digest: view.identity.geometry_digest.clone(),
            envelope_revision: view.identity.envelope_revision.clone(),
            envelope_digest: view.identity.envelope_digest.clone(),
            closure_revision: revision.clone(),
            closure_digest: digest.clone(),
            evaluation_time_bits: view.identity.evaluation_time_s.to_bits(),
            evaluated_envelope_multiplier_bits: view
                .identity
                .evaluated_envelope_multiplier
                .to_bits(),
            stage_identity: view.identity.stage_identity,
        })
    }

    pub(crate) fn digest(&self) -> String {
        let bytes = serde_json::to_vec(self).expect("cache key serialization is infallible");
        format!("sha256:{:x}", Sha256::digest(bytes))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CacheObservation {
    Miss,
    Hit,
}

#[derive(Debug, Default)]
pub(crate) struct SteadySourceCache {
    key: Option<SteadySourceCacheKey>,
    view_identity_digest: Option<String>,
    hits: u64,
    misses: u64,
    invalidations: u64,
}

impl SteadySourceCache {
    pub(crate) fn publish_solve(
        &mut self,
        key: SteadySourceCacheKey,
        view_identity_digest: String,
    ) -> Result<CacheObservation, RunError> {
        if view_identity_digest.trim().is_empty() {
            return Err(RunError {
                message: "steady source cache cannot publish an empty view identity digest".into(),
            });
        }
        let observation = match (&self.key, &self.view_identity_digest) {
            (Some(existing), Some(existing_digest))
                if existing == &key && existing_digest == &view_identity_digest =>
            {
                self.hits = self.hits.saturating_add(1);
                CacheObservation::Hit
            }
            (Some(_), Some(_)) => {
                self.invalidations = self.invalidations.saturating_add(1);
                self.misses = self.misses.saturating_add(1);
                CacheObservation::Miss
            }
            _ => {
                self.misses = self.misses.saturating_add(1);
                CacheObservation::Miss
            }
        };
        self.key = Some(key);
        self.view_identity_digest = Some(view_identity_digest);
        Ok(observation)
    }

    pub(crate) fn reuse(
        &mut self,
        key: &SteadySourceCacheKey,
        view_identity_digest: &str,
    ) -> Result<CacheObservation, RunError> {
        if self.key.as_ref() != Some(key)
            || self.view_identity_digest.as_deref() != Some(view_identity_digest)
        {
            return Err(RunError {
                message: "steady source cache identity changed; a fresh transport solve is required before publishing Oersted".into(),
            });
        }
        self.hits = self.hits.saturating_add(1);
        Ok(CacheObservation::Hit)
    }

    pub(crate) fn hits(&self) -> u64 {
        self.hits
    }

    pub(crate) fn misses(&self) -> u64 {
        self.misses
    }

    pub(crate) fn invalidations(&self) -> u64 {
        self.invalidations
    }
}

pub(crate) fn validate_plan(
    resolved: &ResolvedSpinTransportPlanIR,
) -> Result<Option<SteadySourceCacheKey>, RunError> {
    let Some(descriptor) = resolved.fem_cpu_double.as_ref() else {
        return Ok(None);
    };
    if descriptor.stage_coupling != STEADY_SOURCE_CACHE_POLICY {
        return Ok(None);
    }
    if resolved.resolved_coupling != TransportCouplingIR::OneWay
        || !descriptor.oersted_source_bound
    {
        return Err(RunError {
            message: "steady source cache requires one-way transport bound to an Oersted source".into(),
        });
    }
    let Some(view) = descriptor.conservative_current_view.as_ref() else {
        return Err(RunError {
            message: "steady source cache requires a conservative current view".into(),
        });
    };
    SteadySourceCacheKey::from_view(view).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        ConservativeCurrentBoundaryFaceIR, ConservativeCurrentBoundaryRoleIR,
        ConservativeCurrentClosureIR, ConservativeCurrentIdentityIR,
        ConservativeCurrentPinsIR, ConservativeCurrentSourceCutFacePairIR,
        ConservativeCurrentSourceCutIR, ResolvedFemConservativeCurrentViewIR,
    };

    fn view() -> ResolvedFemConservativeCurrentViewIR {
        let identity = ConservativeCurrentIdentityIR {
            source_module_id: "charge".into(),
            source_state_revision: "state-1".into(),
            source_field_digest: "field-1".into(),
            conductivity_digest: "sigma-1".into(),
            mesh_revision: "mesh-1".into(),
            topology_revision: "topology-1".into(),
            geometry_digest: "geometry-1".into(),
            envelope_revision: "envelope-1".into(),
            envelope_digest: "envelope-digest-1".into(),
            evaluated_envelope_multiplier: 1.0,
            evaluation_time_s: 0.0,
            stage_identity: 7,
        };
        ResolvedFemConservativeCurrentViewIR {
            stable_vertex_ids: vec![1, 2, 3, 4],
            boundary_faces: vec![
                ConservativeCurrentBoundaryFaceIR {
                    face_vertex_ids: [1, 2, 3],
                    role: ConservativeCurrentBoundaryRoleIR::SourceCut,
                    circuit_id: Some("cut".into()),
                },
            ],
            pins: ConservativeCurrentPinsIR {
                required_source_state_revision: identity.source_state_revision.clone(),
                required_source_field_digest: identity.source_field_digest.clone(),
                required_mesh_revision: identity.mesh_revision.clone(),
                required_topology_revision: identity.topology_revision.clone(),
            },
            closure: ConservativeCurrentClosureIR::ClosedGeometry {
                operator_version: "closure.v1".into(),
                revision: "closure-1".into(),
                digest: "closure-digest-1".into(),
                source_cuts: vec![ConservativeCurrentSourceCutIR {
                    id: "cut".into(),
                    translation_m: [1.0, 0.0, 0.0],
                    potential_drop_v: 1.0,
                    face_pairs: vec![ConservativeCurrentSourceCutFacePairIR {
                        minus_face_vertex_ids: [1, 2, 3],
                        plus_face_vertex_ids: [1, 2, 4],
                    }],
                }],
            },
            identity,
            algebraic_relative_tolerance: 1.0e-10,
            physical_relative_gate: 1.0e-8,
            physical_absolute_gate_a: 1.0e-12,
            reference_mpi_gather_broadcast: false,
        }
    }

    #[test]
    fn cache_reuses_two_rhs_and_rejects_changed_final_refresh_identity() {
        let key = SteadySourceCacheKey::from_view(&view()).expect("valid cache key");
        let mut cache = SteadySourceCache::default();
        assert_eq!(
            cache
                .publish_solve(key.clone(), "view-1".into())
                .expect("initial solve"),
            CacheObservation::Miss
        );
        assert_eq!(
            cache.reuse(&key, "view-1").expect("first RHS reuse"),
            CacheObservation::Hit
        );
        assert_eq!(
            cache.reuse(&key, "view-1").expect("second RHS reuse"),
            CacheObservation::Hit
        );

        let mut changed_stage = view();
        changed_stage.identity.stage_identity = 8;
        let changed_stage_key =
            SteadySourceCacheKey::from_view(&changed_stage).expect("changed stage key");
        assert!(cache.reuse(&changed_stage_key, "view-2").is_err());

        let mut changed_source = view();
        changed_source.identity.source_state_revision = "state-2".into();
        let changed_source_key =
            SteadySourceCacheKey::from_view(&changed_source).expect("changed source key");
        assert!(cache.reuse(&changed_source_key, "view-3").is_err());
        assert_eq!(cache.hits(), 2);
        assert_eq!(cache.misses(), 1);
        assert_eq!(cache.invalidations(), 0);
    }

}
