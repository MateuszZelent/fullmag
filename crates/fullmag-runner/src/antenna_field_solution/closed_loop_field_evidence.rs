//! Closed choice of field evidence; direct bytes retain their existing encoding.
use super::closed_loop_v2::{invalid, ClosedLoopSourceMetadataV2};
use super::direct_quadrature::DirectOerstedSnapshot;
use super::direct_quadrature_v2::DirectQuadratureEvidenceV2;
use super::surface_rt0_evidence_v1::{SurfaceRt0EvidenceV1, SurfaceRt0Snapshot};
use crate::types::RunError;
use serde_json::Value;

#[derive(Debug, Clone)]
pub(crate) enum ClosedLoopFieldSnapshot {
    Direct(DirectOerstedSnapshot),
    Surface(SurfaceRt0Snapshot),
}
#[derive(Debug, Clone)]
pub(crate) enum ClosedLoopFieldEvidence {
    Direct(DirectQuadratureEvidenceV2),
    Surface(SurfaceRt0EvidenceV1),
}
impl ClosedLoopFieldEvidence {
    pub(crate) fn new(snapshot: ClosedLoopFieldSnapshot, source: &ClosedLoopSourceMetadataV2) -> Result<Self, RunError> {
        Ok(match snapshot {
            ClosedLoopFieldSnapshot::Direct(snapshot) => Self::Direct(DirectQuadratureEvidenceV2 {
                snapshot, signed_normalization_a: source.source_current_a,
                source_absolute_flux_a: source.source_absolute_flux_a,
                scale_per_a: super::closed_loop_v2::normalization_scale(source.source_current_a, source.source_absolute_flux_a)?,
                current_balance_certificate_digest: source.current_balance_certificate_digest.clone(),
            }),
            ClosedLoopFieldSnapshot::Surface(snapshot) => Self::Surface(SurfaceRt0EvidenceV1::new(
                snapshot, source.source_current_a, source.source_absolute_flux_a,
                source.current_balance_certificate_digest.clone())?),
        })
    }
    pub(crate) fn schema(&self) -> &'static str {
        match self { Self::Direct(_) => super::direct_quadrature_v2::SCHEMA,
            Self::Surface(_) => super::surface_rt0_evidence_v1::SCHEMA }
    }
    pub(crate) fn encode(&self) -> Result<Vec<u8>, RunError> {
        match self { Self::Direct(e) => e.encode(), Self::Surface(e) => e.encode() }
    }
    pub(crate) fn decode(schema: &str, bytes: &[u8]) -> Result<Self, RunError> {
        match schema {
            super::direct_quadrature_v2::SCHEMA => Ok(Self::Direct(DirectQuadratureEvidenceV2::decode(bytes)?)),
            super::surface_rt0_evidence_v1::SCHEMA => Ok(Self::Surface(SurfaceRt0EvidenceV1::decode(bytes)?)),
            _ => Err(invalid("unknown field evidence family")),
        }
    }
    pub(crate) fn raw_h(&self) -> Vec<[f64; 3]> {
        match self { Self::Direct(e) => e.snapshot.targets.iter().map(|t|t.h_xyz_apm).collect(),
            Self::Surface(e) => e.snapshot.targets.iter().map(|t|t.h_xyz_apm).collect() }
    }
    pub(crate) fn verify_policy_binding(&self, requested: &Value, resolved: &Value) -> Result<(), RunError> {
        match self {
            Self::Direct(e) => {
                if requested.get("oersted_realization").is_some() || requested.get("surface_field_policy").is_some()
                    || resolved.get("surface_field_policy").is_some() {
                    return Err(invalid("mixed direct/surface provenance"));
                }
                e.verify_policy_binding(requested, resolved)
            },
            Self::Surface(e) => {
                if requested.get("oersted_realization").and_then(Value::as_str) != Some("analytic_rt0_surface")
                    || resolved.get("direct_field_policy").is_some() {
                    return Err(invalid("surface method provenance absent or mixed"));
                }
                let policy = requested.get("surface_field_policy").ok_or_else(||invalid("requested surface policy absent"))?;
                if resolved.get("surface_field_policy") != Some(policy) {
                    return Err(invalid("requested/resolved surface policy differs"));
                }
                let typed: fullmag_ir::AntennaSurfaceFieldPolicyIR = serde_json::from_value(policy.clone())
                    .map_err(|_|invalid("surface policy shape"))?;
                if !typed.validation_errors("surface_field_policy").is_empty() {
                    return Err(invalid("surface policy numerical gate"));
                }
                e.verify_policy_binding(policy)
            },
        }
    }
    pub(crate) fn verify_source_binding(&self, source: &ClosedLoopSourceMetadataV2, cells: usize, targets: usize) -> Result<(), RunError> {
        let expected_pairs = (cells as u64).checked_mul(targets as u64).ok_or_else(||invalid("field pair overflow"))?;
        let (current,flux,scale,certificate,pairs) = match self {
            Self::Direct(e) => {
                if e.snapshot.source_view_identity_digest != source.view_identity_digest {
                    return Err(invalid("direct field source view differs"));
                }
                (e.signed_normalization_a,e.source_absolute_flux_a,e.scale_per_a,
                    &e.current_balance_certificate_digest,e.snapshot.source_target_pairs)
            },
            Self::Surface(e) => {
                e.verify_source_binding(&source.view_identity_digest,&source.accepted_source_state_digest)?;
                (e.signed_normalization_a,e.source_absolute_flux_a,e.scale_per_a,
                    &e.current_balance_certificate_digest,e.snapshot.work_report.total[0])
            },
        };
        if current.to_bits()!=source.source_current_a.to_bits() || flux.to_bits()!=source.source_absolute_flux_a.to_bits()
            || scale.to_bits()!=super::closed_loop_v2::normalization_scale(source.source_current_a,source.source_absolute_flux_a)?.to_bits()
            || certificate!=&source.current_balance_certificate_digest || pairs!=expected_pairs {
            return Err(invalid("field evidence source, normalization or pair count differs"));
        }
        Ok(())
    }
    pub(crate) fn verify_binding(&self, positions: &[[f64;3]], raw: &[[f64;3]], per_a: &[[f64;3]]) -> Result<(), RunError> {
        match self { Self::Direct(e)=>e.verify_binding(positions,raw,per_a),
            Self::Surface(e)=>e.verify_binding(positions,raw,per_a) }
    }
}
