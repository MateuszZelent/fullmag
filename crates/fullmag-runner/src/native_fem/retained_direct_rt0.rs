//! Numeric-only retained DTQ binding. Parent authentication belongs to the caller.

use crate::antenna_field_solution::closed_loop_v2::{
    is_digest, normalization_scale, ClosedLoopAcceptedSourceInputV2,
};
use crate::antenna_field_solution::direct_quadrature::{DirectOerstedSnapshot, DirectOerstedTarget};
use crate::antenna_field_solution::direct_quadrature_v2::DirectQuadratureEvidenceV2;
use crate::types::RunError;
use fullmag_fem_sys as ffi;
pub(super) use super::retained_rt0_source::freeze_verified_source;
use super::retained_rt0_source::bad;

use crate::antenna_field_solution::retained_dtq_binding::validate_budget;
pub(crate) use crate::antenna_field_solution::retained_dtq_binding::verify_retained_dtq_binding;

/// Evaluate H only from an already authenticated, accepted retained RT0 parent.
/// Source authentication and inspection-only publication remain with the runtime owner.
pub(crate) fn evaluate_retained_rt0_direct(
    source: &ClosedLoopAcceptedSourceInputV2,
    points: &[[f64; 3]],
    budget: fullmag_ir::AntennaClosedLoopDirectBudgetIR,
    observer: Option<&crate::AntennaOperationProgressObserver<'_>>,
) -> Result<DirectQuadratureEvidenceV2, RunError> {
    validate_budget(budget)?;
    if points.is_empty() || points.len() > 1_000_000
        || points.iter().flatten().any(|v| !v.is_finite())
        || !is_digest(&source.metadata.view_identity_digest)
        || !is_digest(&source.metadata.current_balance_certificate_digest)
    {
        return Err(bad("invalid retained direct targets or source binding"));
    }
    let source_count = u64::try_from(source.cells.len()).map_err(|_| bad("source count overflow"))?;
    let pairs = source_count.checked_mul(points.len() as u64).ok_or_else(|| bad("pair count overflow"))?;
    if source_count == 0 || source_count > 1_000_000 || pairs > budget.maximum_source_target_pairs {
        return Err(bad("retained direct pair budget exceeded"));
    }
    let scale_per_a = normalization_scale(source.metadata.source_current_a, source.metadata.source_absolute_flux_a)?;
    // All mandatory count/policy checks precede source/output allocation.
    let frozen = freeze_verified_source(source)?;
    let xyz_count = points.len().checked_mul(3).ok_or_else(|| bad("XYZ count overflow"))?;
    let mut flat = Vec::new();
    flat.try_reserve_exact(xyz_count).map_err(|_| bad("target allocation failed"))?;
    flat.extend(points.iter().flatten().copied());
    let mut records = Vec::new();
    records.try_reserve_exact(points.len()).map_err(|_| bad("direct records allocation failed"))?;
    records.resize(points.len(), ffi::fullmag_fem_direct_oersted_target_record_v1 {
        target_xyz_m: [f64::NAN; 3], h_xyz_apm: [f64::NAN; 3],
        estimated_error_apm: f64::NAN, tolerance_apm: f64::NAN,
        roundoff_indicator_apm: f64::NAN, final_leaf_count: 0,
        kernel_evaluations: 0, ledger_leaf_visits: 0,
    });
    let request = ffi::fullmag_fem_frozen_rt0_direct_request_v1 {
        abi_version: ffi::FULLMAG_FEM_FROZEN_RT0_DIRECT_ABI_VERSION, reserved_flags: 0,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_frozen_rt0_direct_request_v1>() as u64,
        execution_lane: ffi::fullmag_fem_steady_transport_execution_lane::FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE,
        reserved: 0, source: frozen.as_ptr(), source_count,
        target_points_xyz: flat.as_ptr(), target_points_xyz_len: xyz_count as u64,
        base_quadrature_order: fullmag_ir::ANTENNA_DIRECT_OERSTED_BASE_QUADRATURE_ORDER,
        maximum_subdivision_depth: fullmag_ir::ANTENNA_DIRECT_OERSTED_MAX_SUBDIVISION_DEPTH,
        absolute_tolerance_apm: fullmag_ir::ANTENNA_DIRECT_OERSTED_ABSOLUTE_TOLERANCE_APM,
        relative_tolerance: fullmag_ir::ANTENNA_DIRECT_OERSTED_RELATIVE_TOLERANCE,
        maximum_source_target_pairs: budget.maximum_source_target_pairs,
    };
    // Every result field is a numeric scalar, raw pointer or C character array.
    let mut result: ffi::fullmag_fem_frozen_rt0_direct_result_v1 = unsafe { std::mem::zeroed() };
    result.abi_version = ffi::FULLMAG_FEM_FROZEN_RT0_DIRECT_ABI_VERSION;
    result.struct_size = std::mem::size_of_val(&result) as u64;
    result.target_records = records.as_mut_ptr();
    result.target_records_capacity = records.len() as u64;
    let native_observer = observer.map(|_| ffi::fullmag_fem_antenna_operation_observer_v1 {
        abi_version: 1, reserved_flags: 0,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_antenna_operation_observer_v1>() as u64,
        callback: Some(super::antenna_operation_progress_callback),
        user_data: (&observer as *const Option<&crate::AntennaOperationProgressObserver<'_>>).cast_mut().cast(),
    });
    // Pointers remain owned by this stack frame for the entire synchronous call.
    let status = unsafe { ffi::fullmag_fem_evaluate_frozen_rt0_direct_observed_v1(
        &request, &mut result,
        native_observer.as_ref().map_or(std::ptr::null(), |v| v as *const _)) };
    if status != ffi::FULLMAG_FEM_OK {
        let message = result.error_message.iter().map(|b| *b as u8)
            .take_while(|b| *b != 0).collect::<Vec<_>>();
        return Err(bad(&format!("native direct status {status}: {}", String::from_utf8_lossy(&message))));
    }
    // Never dereference returned pointers. Check ownership before consuming our records.
    if result.abi_version != ffi::FULLMAG_FEM_FROZEN_RT0_DIRECT_ABI_VERSION
        || result.reserved_flags != 0 || result.struct_size != std::mem::size_of_val(&result) as u64
        || result.target_records != records.as_mut_ptr()
        || result.target_records_capacity != records.len() as u64
        || result.target_records_len != records.len() as u64
        || result.error_message.iter().any(|b| *b != 0)
    {
        return Err(bad("retained direct native header or buffer ownership"));
    }
    let snapshot = DirectOerstedSnapshot {
        targets: records.into_iter().map(|r| DirectOerstedTarget {
            target_xyz_m: r.target_xyz_m, h_xyz_apm: r.h_xyz_apm,
            estimated_error_apm: r.estimated_error_apm, tolerance_apm: r.tolerance_apm,
            roundoff_indicator_apm: r.roundoff_indicator_apm, final_leaf_count: r.final_leaf_count,
            kernel_evaluations: r.kernel_evaluations, ledger_leaf_visits: r.ledger_leaf_visits,
        }).collect(),
        source_view_identity_digest: source.metadata.view_identity_digest.clone(),
        source_target_pairs: result.source_target_pairs, refined_pairs: result.refined_pairs,
        unconverged_pair_count: result.unconverged_pair_count,
        maximum_pair_error_apm: result.maximum_pair_error_apm,
        kernel_evaluations: result.kernel_evaluations, ledger_leaf_visits: result.ledger_leaf_visits,
        base_quadrature_order: result.base_quadrature_order,
        maximum_subdivision_depth: result.maximum_subdivision_depth,
        absolute_tolerance_apm: result.absolute_tolerance_apm,
        relative_tolerance: result.relative_tolerance, relative_scale_floor_apm: result.relative_scale_floor_apm,
        maximum_source_target_pairs: result.maximum_source_target_pairs,
        maximum_final_leaves_per_target: result.maximum_final_leaves_per_target,
        maximum_kernel_evaluations: result.maximum_kernel_evaluations,
        maximum_ledger_leaf_visits: result.maximum_ledger_leaf_visits,
    };
    let evidence = DirectQuadratureEvidenceV2 {
        snapshot, signed_normalization_a: source.metadata.source_current_a,
        source_absolute_flux_a: source.metadata.source_absolute_flux_a,
        scale_per_a, current_balance_certificate_digest: source.metadata.current_balance_certificate_digest.clone(),
    };
    let raw = evidence.snapshot.targets.iter().map(|t| t.h_xyz_apm).collect::<Vec<_>>();
    verify_retained_dtq_binding(&evidence, &source.metadata, source_count, points, &raw, budget)?;
    Ok(evidence)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::antenna_field_solution::closed_loop_v2::ClosedLoopSourceMetadataV2;
    use crate::antenna_field_solution::direct_quadrature_v2::DirectQuadratureEvidenceV2;

    fn fixture() -> (DirectQuadratureEvidenceV2, ClosedLoopSourceMetadataV2, Vec<[f64;3]>, Vec<[f64;3]>) {
        let legacy = crate::antenna_field_solution::direct_quadrature::tests::example();
        let evidence = DirectQuadratureEvidenceV2 {
            snapshot: legacy.snapshot, signed_normalization_a: 3.0,
            source_absolute_flux_a: 3.0, scale_per_a: 1.0 / 3.0,
            current_balance_certificate_digest: "b".repeat(64),
        };
        let metadata = ClosedLoopSourceMetadataV2 {
            prepared_execution_digest: "c".repeat(64), accepted_charge_field_digest: "d".repeat(64),
            accepted_source_state_digest: "e".repeat(64),
            view_identity_digest: evidence.snapshot.source_view_identity_digest.clone(),
            current_balance_certificate_digest: evidence.current_balance_certificate_digest.clone(),
            digest_encoding: String::new(), periodic_operator_version: String::new(),
            closure_operator_version: String::new(), conservative_current_operator_version: String::new(),
            weak_reaction_ledger_version: String::new(), sampling_policy: String::new(),
            source_current_orientation: String::new(), source_current_a: 3.0,
            source_absolute_flux_a: 3.0, potential_jump_v: 0.0, measured_potential_jump_v: 0.0,
            gauge_mean_v: 0.0, charge_relative_residual: 0.0,
            max_paired_weak_flux_mismatch_a: 0.0, terminal_observation_currents: Default::default(),
        };
        let points = evidence.snapshot.targets.iter().map(|t|t.target_xyz_m).collect();
        let raw = evidence.snapshot.targets.iter().map(|t|t.h_xyz_apm).collect();
        (evidence,metadata,points,raw)
    }


    fn numeric_source() -> ClosedLoopAcceptedSourceInputV2 {
        use crate::antenna_field_solution::closed_loop_v2::ClosedLoopCurrentCellV2;
        let (_,metadata,_,_) = fixture();
        let cell = ClosedLoopCurrentCellV2 {
            source_element_index: 0, vertex_ids: [0,1,2,3],
            vertex_xyz_m: [-0.,0.,0.,1.,0.,0.,0.,1.,0.,0.,0.,1.],
            vertex_current_xyz_apm2: [0.;12], center_xyz_m: [0.25;3],
            center_current_xyz_apm2: [0.;3],
        };
        // Synthetic local numeric fixture; no accepted-owner authority is claimed.
        ClosedLoopAcceptedSourceInputV2 {
            metadata, stable_vertex_ids: vec![], vertex_xyz_m: vec![],
            electric_potential_v: vec![], conductivity_spm: vec![], cells: vec![cell],
            canonical_face_records: vec![([0,1,2],0.),([0,1,3],0.),([0,2,3],0.5),([1,2,3],0.5)],
            paired_weak_reactions: vec![], prepared_execution_preimage: vec![],
            accepted_charge_field_preimage: vec![], accepted_source_state_preimage: vec![],
            canonical_balance_certificate: vec![], authored_input_json: vec![],
        }
    }

    #[test]
    fn surface_and_dtq_share_identical_frozen_order() {
        let mut source = numeric_source();
        let mut second = source.cells[0].clone();
        second.source_element_index = 1;
        second.vertex_ids = [4,5,6,7];
        second.vertex_xyz_m[3] = 2.0;
        source.cells.push(second);
        source.canonical_face_records.extend([
            ([4,5,6],-0.),([4,5,7],0.),([4,6,7],1.),([5,6,7],2.),
        ]);
        let surface = super::super::retained_surface_rt0::freeze_verified_source(&source).unwrap();
        let direct = freeze_verified_source(&source).unwrap();
        assert_eq!(direct.len(),2);
        for ((a,b),cell) in surface.iter().zip(&direct).zip(&source.cells) {
            assert_eq!(a.vertices_m.map(f64::to_bits),b.vertices_m.map(f64::to_bits));
            assert_eq!(a.vertices_m.map(f64::to_bits),cell.vertex_xyz_m.map(f64::to_bits));
            assert_eq!(a.signed_coefficients_a.map(f64::to_bits),b.signed_coefficients_a.map(f64::to_bits));
        }
        assert_eq!(direct[0].signed_coefficients_a.map(f64::to_bits),[1.,-1.,0.,-0.].map(f64::to_bits));
        assert_eq!(direct[1].signed_coefficients_a.map(f64::to_bits),[4.,-2.,0.,0.].map(f64::to_bits));
        source.cells.swap(0,1);
        assert!(freeze_verified_source(&source).is_err());
        source.cells.swap(0,1);
        source.canonical_face_records.swap(0,1);
        assert!(freeze_verified_source(&source).is_err());
    }

    #[test]
    fn retained_direct_numeric_ffi_binds_complete_output() {
        let source = numeric_source();
        let points = [[2.,-0.,2.]];
        for name in ["production_default","volume_inspection_v1"] {
            let budget = fullmag_ir::antenna_closed_loop_direct_budget(name).unwrap();
            let evidence = evaluate_retained_rt0_direct(&source,&points,budget,None).unwrap();
            let raw = evidence.snapshot.targets.iter().map(|t|t.h_xyz_apm).collect::<Vec<_>>();
            verify_retained_dtq_binding(&evidence,&source.metadata,1,&points,&raw,budget).unwrap();
            assert_eq!(evidence.snapshot.source_target_pairs,1);
            assert!(evidence.snapshot.kernel_evaluations>0);
            let bytes = evidence.encode().unwrap();
            assert_eq!(DirectQuadratureEvidenceV2::decode(&bytes).unwrap().encode().unwrap(),bytes);
        }
    }

    #[test]
    fn retained_direct_rejects_mixed_budget_and_bad_inputs_before_ffi() {
        let mut source = numeric_source();
        let budget = fullmag_ir::antenna_closed_loop_direct_budget("production_default").unwrap();
        assert!(evaluate_retained_rt0_direct(&source,&[],budget,None).is_err());
        assert!(evaluate_retained_rt0_direct(&source,&[[f64::NAN,0.,0.]],budget,None).is_err());
        let mut mixed = budget;
        mixed.maximum_kernel_evaluations = 500_000_000;
        assert!(evaluate_retained_rt0_direct(&source,&[[2.;3]],mixed,None).is_err());
        source.metadata.source_current_a = 0.0;
        assert!(evaluate_retained_rt0_direct(&source,&[[2.;3]],budget,None).is_err());
    }

    #[test]
    fn retained_dtq_evidence_binds_source_policy_and_raw_bits() {
        let budget = fullmag_ir::antenna_closed_loop_direct_budget("production_default").unwrap();
        let (e,m,p,h) = fixture();
        let source_count = e.snapshot.source_target_pairs / p.len() as u64;
        verify_retained_dtq_binding(&e,&m,source_count,&p,&h,budget).unwrap();
        let bytes = e.encode().unwrap();
        assert_eq!(DirectQuadratureEvidenceV2::decode(&bytes).unwrap().encode().unwrap(),bytes);
        for mutation in 0..11 {
            let (mut e,mut m,mut p,mut h) = fixture();
            match mutation {
                0 => m.view_identity_digest = "f".repeat(64),
                1 => m.current_balance_certificate_digest = "f".repeat(64),
                2 => m.source_current_a = -3.0,
                3 => m.source_absolute_flux_a = 4.0,
                4 => e.snapshot.source_target_pairs += 1,
                5 => h[0][1] = 0.0,
                6 => p[0][0] = -0.0,
                7 => e.snapshot.maximum_source_target_pairs = 4_000_000,
                8 => e.snapshot.targets[0].estimated_error_apm = e.snapshot.targets[0].tolerance_apm,
                9 => e.snapshot.targets[0].roundoff_indicator_apm = f64::INFINITY,
                _ => { h.pop(); },
            }
            if mutation == 8 { e.snapshot.targets[0].roundoff_indicator_apm = f64::EPSILON; }
            assert!(verify_retained_dtq_binding(&e,&m,source_count,&p,&h,budget).is_err(),"mutation {mutation}");
        }
    }
}
