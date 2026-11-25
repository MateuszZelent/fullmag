//! Read-only binding of the existing DTQv2 encoding. No owner or scientific authority.
use super::*;
use std::collections::BTreeMap;

const MAGIC: &[u8; 16] = b"FM-OEF1-Q3-V2\0\0\0";
const HEADER: usize = 296;
const RECORD: usize = 96;

pub(super) fn validate_evidence_binding_v2(
    manifest: &RetainedCurrentFieldManifestV2,
    payloads: &BTreeMap<String, Vec<u8>>,
) -> Result<(), ArtifactError> {
    let b = &payloads["evidence"];
    require(
        b.len() >= HEADER && &b[..16] == MAGIC,
        "DTQv2 evidence header",
    )?;
    require(
        &b[16..80] == manifest.parent.source.view_identity_digest[7..].as_bytes()
            && &b[80..144]
                == manifest.parent.source.current_balance_certificate_digest[7..].as_bytes(),
        "DTQv2 evidence differs from parent source pins",
    )?;
    let ints: [u64; 12] = std::array::from_fn(|i| {
        u64::from_le_bytes(
            b[144 + 8 * i..152 + 8 * i]
                .try_into()
                .expect("bounded header"),
        )
    });
    let real: [f64; 7] = std::array::from_fn(|i| {
        f64::from_le_bytes(
            b[240 + 8 * i..248 + 8 * i]
                .try_into()
                .expect("bounded header"),
        )
    });
    let policy = &manifest.direct_field_policy;
    let pairs = manifest
        .source_cell_count
        .checked_mul(manifest.target_count);
    require(
        ints[0] == manifest.target_count
            && Some(ints[1]) == pairs
            && ints[3] == 0
            && ints[6] == policy.base_quadrature_order as u64
            && ints[7] == policy.maximum_subdivision_depth as u64
            && ints[8] == policy.maximum_source_target_pairs
            && ints[9] == policy.maximum_final_leaves_per_target
            && ints[10] == policy.maximum_kernel_evaluations
            && ints[11] == policy.maximum_ledger_leaf_visits
            && ints[4] <= policy.maximum_kernel_evaluations
            && ints[5] <= policy.maximum_ledger_leaf_visits
            && manifest
                .target_count
                .checked_mul(RECORD as u64)
                .and_then(|n| n.checked_add(HEADER as u64))
                == Some(b.len() as u64),
        "DTQv2 evidence counts, framing or profile binding",
    )?;
    require(
        real.iter().all(|x| x.is_finite())
            && real[0] >= 0.0
            && real[1].to_bits() == policy.absolute_tolerance_apm.to_bits()
            && real[2].to_bits() == policy.relative_tolerance.to_bits()
            && real[3].to_bits() == policy.relative_scale_floor_apm.to_bits(),
        "DTQv2 evidence options or nonfinite scalar",
    )?;
    // Preserve the signed normalization contract of closed_loop_v2; never apply it to raw H here.
    let gate = 100.0 * (1.0e-18 + 1.0e-10 * real[6]);
    let scale = 1.0 / real[4];
    require(
        real[6] >= 0.0
            && gate.is_finite()
            && real[4].abs() > gate
            && scale.is_finite()
            && scale.to_bits() == real[5].to_bits(),
        "DTQv2 evidence signed normalization",
    )?;
    let mut sums = [0_u64; 3];
    let depth_bound = manifest
        .source_cell_count
        .checked_mul(8_u64.pow(policy.maximum_subdivision_depth as u32))
        .ok_or_else(|| ArtifactError {
            message: "retained DTQ leaf bound overflow".into(),
        })?;
    for ((row, xyz), h) in b[HEADER..]
        .chunks_exact(RECORD)
        .zip(payloads["sample_xyz"].chunks_exact(24))
        .zip(payloads["h_raw"].chunks_exact(24))
    {
        require(
            &row[..24] == xyz && &row[24..48] == h,
            "DTQv2 evidence XYZ/raw H bit binding",
        )?;
        let reals: [f64; 9] = std::array::from_fn(|i| {
            f64::from_le_bytes(row[8 * i..8 * i + 8].try_into().expect("bounded record"))
        });
        let counts: [u64; 3] = std::array::from_fn(|i| {
            u64::from_le_bytes(
                row[72 + 8 * i..80 + 8 * i]
                    .try_into()
                    .expect("bounded record"),
            )
        });
        let norm = reals[3].hypot(reals[4]).hypot(reals[5]);
        let tolerance = policy
            .relative_tolerance
            .mul_add(norm, policy.absolute_tolerance_apm);
        require(
            reals.iter().all(|x| x.is_finite())
                && reals[6..].iter().all(|x| *x >= 0.0)
                && tolerance.is_finite()
                && tolerance.to_bits() == reals[7].to_bits()
                && counts[0] >= manifest.source_cell_count
                && counts[0] <= policy.maximum_final_leaves_per_target
                && counts[0] <= depth_bound
                && (counts[0] - manifest.source_cell_count) % 7 == 0
                && counts[1] >= counts[0]
                && counts[2] >= counts[0],
            "DTQv2 target scalar or work-count binding",
        )?;
        for (sum, count) in sums.iter_mut().zip(counts) {
            *sum = sum.checked_add(count).ok_or_else(|| ArtifactError {
                message: "retained DTQ aggregate work overflow".into(),
            })?;
        }
    }
    let leaves = ints[2].checked_mul(7).and_then(|n| n.checked_add(ints[1]));
    require(
        Some(sums[0]) == leaves && sums[1] == ints[4] && sums[2] == ints[5],
        "DTQv2 global work/refinement conservation",
    )
}
