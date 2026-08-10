use std::f64::consts::PI;

use fullmag_fdm_demag::{
    cell_pair_tensor, compute_shifted_kernel_pair, CellPairTensor, KernelBuildError,
};

const GL8_NODES: [f64; 8] = [
    -0.960_289_856_497_536_3,
    -0.796_666_477_413_626_7,
    -0.525_532_409_916_329,
    -0.183_434_642_495_649_8,
    0.183_434_642_495_649_8,
    0.525_532_409_916_329,
    0.796_666_477_413_626_7,
    0.960_289_856_497_536_3,
];

const GL8_WEIGHTS: [f64; 8] = [
    0.101_228_536_290_376_3,
    0.222_381_034_453_374_5,
    0.313_706_645_877_887_3,
    0.362_683_783_378_362,
    0.362_683_783_378_362,
    0.313_706_645_877_887_3,
    0.222_381_034_453_374_5,
    0.101_228_536_290_376_3,
];

fn cubature_cell_pair_tensor(
    source_cell: [f64; 3],
    destination_cell: [f64; 3],
    displacement: [f64; 3],
) -> CellPairTensor {
    let mut terms = [0.0; 6];
    for (dx_node, dx_weight) in GL8_NODES.into_iter().zip(GL8_WEIGHTS) {
        for (dy_node, dy_weight) in GL8_NODES.into_iter().zip(GL8_WEIGHTS) {
            for (dz_node, dz_weight) in GL8_NODES.into_iter().zip(GL8_WEIGHTS) {
                let destination = [
                    displacement[0] + 0.5 * destination_cell[0] * dx_node,
                    displacement[1] + 0.5 * destination_cell[1] * dy_node,
                    displacement[2] + 0.5 * destination_cell[2] * dz_node,
                ];
                let destination_weight = 0.125
                    * destination_cell[0]
                    * destination_cell[1]
                    * destination_cell[2]
                    * dx_weight
                    * dy_weight
                    * dz_weight;

                for (sx_node, sx_weight) in GL8_NODES.into_iter().zip(GL8_WEIGHTS) {
                    for (sy_node, sy_weight) in GL8_NODES.into_iter().zip(GL8_WEIGHTS) {
                        for (sz_node, sz_weight) in GL8_NODES.into_iter().zip(GL8_WEIGHTS) {
                            let source = [
                                0.5 * source_cell[0] * sx_node,
                                0.5 * source_cell[1] * sy_node,
                                0.5 * source_cell[2] * sz_node,
                            ];
                            let source_weight = 0.125
                                * source_cell[0]
                                * source_cell[1]
                                * source_cell[2]
                                * sx_weight
                                * sy_weight
                                * sz_weight;
                            let r = [
                                destination[0] - source[0],
                                destination[1] - source[1],
                                destination[2] - source[2],
                            ];
                            let r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
                            let inv_r3 = 1.0 / (r2 * r2.sqrt());
                            let inv_r5 = inv_r3 / r2;
                            let weight = destination_weight * source_weight;
                            terms[0] += weight * (inv_r3 - 3.0 * r[0] * r[0] * inv_r5);
                            terms[1] += weight * (inv_r3 - 3.0 * r[1] * r[1] * inv_r5);
                            terms[2] += weight * (inv_r3 - 3.0 * r[2] * r[2] * inv_r5);
                            terms[3] += weight * (-3.0 * r[0] * r[1] * inv_r5);
                            terms[4] += weight * (-3.0 * r[0] * r[2] * inv_r5);
                            terms[5] += weight * (-3.0 * r[1] * r[2] * inv_r5);
                        }
                    }
                }
            }
        }
    }
    let destination_volume = destination_cell.into_iter().product::<f64>();
    let scale = 1.0 / (4.0 * PI * destination_volume);
    CellPairTensor::new(
        terms[0] * scale,
        terms[1] * scale,
        terms[2] * scale,
        terms[3] * scale,
        terms[4] * scale,
        terms[5] * scale,
    )
}

fn assert_tensor_close(actual: CellPairTensor, expected: CellPairTensor, context: &str) {
    for (name, actual, expected) in actual
        .components()
        .into_iter()
        .zip(expected.components())
        .map(|((name, actual), (_, expected))| (name, actual, expected))
    {
        let tolerance = 3.0e-10_f64.max(3.0e-7 * expected.abs());
        assert!(
            (actual - expected).abs() <= tolerance,
            "{context} component {name}: actual={actual:.16e}, expected={expected:.16e}, tolerance={tolerance:.3e}"
        );
    }
}

fn kernel_tensor_at(kernel: &fullmag_fdm_demag::NewellKernels, lag: [isize; 3]) -> CellPairTensor {
    let wrap = |value: isize, length: usize| {
        if value >= 0 {
            value as usize
        } else {
            (length as isize + value) as usize
        }
    };
    let index = wrap(lag[2], kernel.pz) * kernel.py * kernel.px
        + wrap(lag[1], kernel.py) * kernel.px
        + wrap(lag[0], kernel.px);
    CellPairTensor::new(
        kernel.n_xx[index],
        kernel.n_yy[index],
        kernel.n_zz[index],
        kernel.n_xy[index],
        kernel.n_xz[index],
        kernel.n_yz[index],
    )
}

#[test]
fn unequal_2d_layer_thickness_matches_cubature_for_both_signed_z_offsets() {
    let source = [0.7, 0.9, 0.6];
    let destination = [0.7, 0.9, 1.4];
    let offset = [0.35, -0.27, 3.2];
    let kernel = compute_shifted_kernel_pair([3, 3, 1], source, destination, offset)
        .expect("2-D unequal-thickness pair is supported");
    assert_eq!(kernel.fft_shape, [6, 6, 2]);
    assert_eq!(kernel.len(), 6 * 6 * 2);

    let real = fullmag_fdm_demag::newell::compute_newell_kernels_shifted_pair(
        3,
        3,
        1,
        source,
        destination,
        offset,
    )
    .expect("real-space pair is supported");
    for lag in [[1, -1, 0], [-1, 1, 0]] {
        let displacement = [
            lag[0] as f64 * source[0] + offset[0],
            lag[1] as f64 * source[1] + offset[1],
            offset[2],
        ];
        let expected = cubature_cell_pair_tensor(source, destination, displacement);
        assert_tensor_close(
            kernel_tensor_at(&real, lag),
            expected,
            &format!("2-D lag={lag:?}"),
        );
    }
}

#[test]
fn unequal_2d_pair_keeps_xy_parity_for_positive_and_negative_z_offsets() {
    let source = [0.7, 0.9, 0.6];
    let destination = [0.7, 0.9, 1.4];
    for z_offset in [2.3, -2.3] {
        let kernel = fullmag_fdm_demag::newell::compute_newell_kernels_shifted_pair(
            3,
            3,
            1,
            source,
            destination,
            [0.0, 0.0, z_offset],
        )
        .expect("2-D unequal pair should support either signed Z orientation");
        let pp = kernel_tensor_at(&kernel, [1, 1, 0]);
        let np = kernel_tensor_at(&kernel, [-1, 1, 0]);
        let pn = kernel_tensor_at(&kernel, [1, -1, 0]);
        for (name, positive, negative_x, negative_y, x_parity, y_parity) in [
            ("xx", pp.xx, np.xx, pn.xx, 1.0, 1.0),
            ("yy", pp.yy, np.yy, pn.yy, 1.0, 1.0),
            ("zz", pp.zz, np.zz, pn.zz, 1.0, 1.0),
            ("xy", pp.xy, np.xy, pn.xy, -1.0, -1.0),
            ("xz", pp.xz, np.xz, pn.xz, -1.0, 1.0),
            ("yz", pp.yz, np.yz, pn.yz, 1.0, -1.0),
        ] {
            assert!(
                (negative_x - x_parity * positive).abs() < 2.0e-12,
                "X parity failed for {name}, z_offset={z_offset}"
            );
            assert!(
                (negative_y - y_parity * positive).abs() < 2.0e-12,
                "Y parity failed for {name}, z_offset={z_offset}"
            );
        }
    }
}

#[test]
fn unequal_3d_cell_pair_matches_cubature_and_volume_weighted_reciprocity() {
    let source = [0.7, 0.9, 0.6];
    let destination = [0.8, 1.1, 1.4];
    let displacement = [0.8, -1.1, 3.2];
    let forward = cell_pair_tensor(destination, source, displacement)
        .expect("unequal 3-D cell pair is supported");
    let expected = cubature_cell_pair_tensor(source, destination, displacement);
    assert_tensor_close(forward, expected, "3-D unequal pair");

    let reverse = cell_pair_tensor(source, destination, [-0.8, 1.1, -3.2])
        .expect("reverse unequal 3-D cell pair is supported");
    let source_volume = source.into_iter().product::<f64>();
    let destination_volume = destination.into_iter().product::<f64>();
    for ((name, forward), (_, reverse)) in
        forward.components().into_iter().zip(reverse.components())
    {
        let lhs = destination_volume * forward;
        let rhs = source_volume * reverse;
        assert!(
            (lhs - rhs).abs() <= 3.0e-10_f64.max(3.0e-8 * lhs.abs().max(rhs.abs())),
            "reciprocity failed for {name}: {lhs:.16e} != {rhs:.16e}"
        );
    }
}

#[test]
fn full_xyz_offset_preserves_orientation_signs_without_illegal_parity_reuse() {
    let cell = [0.8, 0.9, 1.1];
    let offset = [0.35, -0.27, 2.1];
    let positive =
        fullmag_fdm_demag::newell::compute_newell_kernels_shifted_pair(3, 3, 2, cell, cell, offset)
            .expect("equal-cell full offset is supported");
    let negative = fullmag_fdm_demag::newell::compute_newell_kernels_shifted_pair(
        3,
        3,
        2,
        cell,
        cell,
        [-offset[0], -offset[1], -offset[2]],
    )
    .expect("reverse equal-cell full offset is supported");

    let forward = kernel_tensor_at(&positive, [1, -1, 1]);
    let reverse = kernel_tensor_at(&negative, [-1, 1, -1]);
    for ((name, forward), (_, reverse)) in
        forward.components().into_iter().zip(reverse.components())
    {
        assert!(
            (forward - reverse).abs() <= 3.0e-12_f64.max(3.0e-9 * forward.abs().max(reverse.abs())),
            "full-offset orientation failed for {name}: {forward:.16e} != {reverse:.16e}"
        );
    }
}

#[test]
fn three_d_unequal_inplane_spacing_fails_closed_in_translational_kernel_builder() {
    let error =
        compute_shifted_kernel_pair([2, 2, 2], [0.7, 0.9, 0.6], [0.8, 0.9, 1.4], [0.0, 0.0, 2.0])
            .expect_err("a single translational kernel cannot encode unequal XY spacing");
    assert!(matches!(
        error,
        KernelBuildError::UnsupportedGeometry { .. }
    ));
}
