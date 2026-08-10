use std::f64::consts::PI;

use fullmag_fdm_demag::newell::{
    compute_newell_kernels, compute_newell_kernels_shifted, NewellKernels,
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

#[derive(Clone, Copy, Debug)]
struct Tensor6 {
    xx: f64,
    yy: f64,
    zz: f64,
    xy: f64,
    xz: f64,
    yz: f64,
}

impl Tensor6 {
    fn components(self) -> [(&'static str, f64); 6] {
        [
            ("xx", self.xx),
            ("yy", self.yy),
            ("zz", self.zz),
            ("xy", self.xy),
            ("xz", self.xz),
            ("yz", self.yz),
        ]
    }
}

fn kernel_tensor_at(kernel: &NewellKernels, lag: [isize; 3]) -> Tensor6 {
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

    Tensor6 {
        xx: kernel.n_xx[index],
        yy: kernel.n_yy[index],
        zz: kernel.n_zz[index],
        xy: kernel.n_xy[index],
        xz: kernel.n_xz[index],
        yz: kernel.n_yz[index],
    }
}

/// Independent double-volume Gauss-Legendre cubature of one non-overlapping
/// rectangular source/destination cell pair. This deliberately does not call
/// the production Newell functions or shifted-kernel builder.
fn cubature_cell_pair_tensor(
    source_cell: [f64; 3],
    destination_cell: [f64; 3],
    displacement: [f64; 3],
) -> Tensor6 {
    let mut tensor = [0.0_f64; 6];

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

                            tensor[0] += weight * (inv_r3 - 3.0 * r[0] * r[0] * inv_r5);
                            tensor[1] += weight * (inv_r3 - 3.0 * r[1] * r[1] * inv_r5);
                            tensor[2] += weight * (inv_r3 - 3.0 * r[2] * r[2] * inv_r5);
                            tensor[3] += weight * (-3.0 * r[0] * r[1] * inv_r5);
                            tensor[4] += weight * (-3.0 * r[0] * r[2] * inv_r5);
                            tensor[5] += weight * (-3.0 * r[1] * r[2] * inv_r5);
                        }
                    }
                }
            }
        }
    }

    let destination_volume = destination_cell[0] * destination_cell[1] * destination_cell[2];
    let scale = 1.0 / (4.0 * PI * destination_volume);
    Tensor6 {
        xx: tensor[0] * scale,
        yy: tensor[1] * scale,
        zz: tensor[2] * scale,
        xy: tensor[3] * scale,
        xz: tensor[4] * scale,
        yz: tensor[5] * scale,
    }
}

/// Independent point-dipole tensor used to verify the production far-field
/// branch. This does not call the private `asymptotic_n*` helpers.
fn point_dipole_tensor(source_volume: f64, displacement: [f64; 3]) -> Tensor6 {
    let r2 = displacement[0] * displacement[0]
        + displacement[1] * displacement[1]
        + displacement[2] * displacement[2];
    let inv_r3 = 1.0 / (r2 * r2.sqrt());
    let inv_r5 = inv_r3 / r2;
    let scale = source_volume / (4.0 * PI);

    Tensor6 {
        xx: scale * (inv_r3 - 3.0 * displacement[0] * displacement[0] * inv_r5),
        yy: scale * (inv_r3 - 3.0 * displacement[1] * displacement[1] * inv_r5),
        zz: scale * (inv_r3 - 3.0 * displacement[2] * displacement[2] * inv_r5),
        xy: scale * (-3.0 * displacement[0] * displacement[1] * inv_r5),
        xz: scale * (-3.0 * displacement[0] * displacement[2] * inv_r5),
        yz: scale * (-3.0 * displacement[1] * displacement[2] * inv_r5),
    }
}

fn assert_tensor_close(actual: Tensor6, expected: Tensor6, context: &str) {
    for ((name, actual), (_, expected)) in
        actual.components().into_iter().zip(expected.components())
    {
        let tolerance = 2.0e-10_f64.max(2.0e-7 * expected.abs());
        assert!(
            (actual - expected).abs() <= tolerance,
            "{context} component {name}: actual={actual:.16e}, expected={expected:.16e}, tolerance={tolerance:.3e}"
        );
    }
}

#[test]
fn signed_z_asymptotic_branch_matches_independent_point_dipole_tensor() {
    // The production far-field cutoff is 40 cell widths. A small nonzero
    // offset with |lag|=41 keeps both physical signed distances beyond it.
    let cells = [2, 2, 42];
    let cell = [0.7, 0.9, 1.1];
    let z_shift = 0.25;
    let kernel = compute_newell_kernels_shifted(
        cells[0], cells[1], cells[2], cell[0], cell[1], cell[2], z_shift,
    );
    let source_volume = cell[0] * cell[1] * cell[2];

    for z_lag in [-41_isize, 41_isize] {
        let lag = [1, 1, z_lag];
        let displacement = [
            lag[0] as f64 * cell[0],
            lag[1] as f64 * cell[1],
            lag[2] as f64 * cell[2] + z_shift,
        ];
        let actual = kernel_tensor_at(&kernel, lag);
        let expected = point_dipole_tensor(source_volume, displacement);

        for ((name, actual), (_, expected)) in
            actual.components().into_iter().zip(expected.components())
        {
            let tolerance = 1.0e-15_f64.max(2.0e-13 * expected.abs());
            assert!(
                (actual - expected).abs() <= tolerance,
                "signed asymptotic lag={z_lag} component {name}: actual={actual:.16e}, expected={expected:.16e}"
            );
        }
    }
}

#[test]
fn large_signed_lag_cancelled_by_offset_returns_finite_exact_tensor() {
    let cells = [2, 2, 41];
    let cell = [0.7, 0.9, 1.1];
    let z_shift = 40.0 * cell[2];
    let kernel = compute_newell_kernels_shifted(
        cells[0], cells[1], cells[2], cell[0], cell[1], cell[2], z_shift,
    );
    let actual = kernel_tensor_at(&kernel, [0, 0, -40]);
    let self_kernel = compute_newell_kernels(1, 1, 1, cell[0], cell[1], cell[2]);
    let expected = kernel_tensor_at(&self_kernel, [0, 0, 0]);

    for (name, value) in actual.components() {
        assert!(
            value.is_finite(),
            "cancelled-offset component {name} is {value}"
        );
    }
    assert_tensor_close(actual, expected, "cancelled offset");
}

#[test]
fn shifted_kernel_matches_independent_cubature_for_both_z_lag_directions() {
    let cells = [3, 3, 2];
    let cell = [0.7, 0.9, 1.1];
    let z_shift = 3.25;
    let kernel = compute_newell_kernels_shifted(
        cells[0], cells[1], cells[2], cell[0], cell[1], cell[2], z_shift,
    );

    for z_lag in [-1_isize, 1_isize] {
        let lag = [1, 1, z_lag];
        let displacement = [
            lag[0] as f64 * cell[0],
            lag[1] as f64 * cell[1],
            lag[2] as f64 * cell[2] + z_shift,
        ];
        let actual = kernel_tensor_at(&kernel, lag);
        let expected = cubature_cell_pair_tensor(cell, cell, displacement);
        assert_tensor_close(actual, expected, &format!("lag={lag:?}"));
    }
}

#[test]
fn equal_cell_shifted_builder_obeys_source_destination_reciprocity() {
    let cells = [3, 3, 2];
    let cell = [0.8, 1.0, 1.2];
    let z_shift = 2.9;
    let forward = compute_newell_kernels_shifted(
        cells[0], cells[1], cells[2], cell[0], cell[1], cell[2], z_shift,
    );
    let reverse = compute_newell_kernels_shifted(
        cells[0], cells[1], cells[2], cell[0], cell[1], cell[2], -z_shift,
    );
    let forward_tensor = kernel_tensor_at(&forward, [1, -1, 1]);
    let reverse_tensor = kernel_tensor_at(&reverse, [-1, 1, -1]);
    let source_volume = cell[0] * cell[1] * cell[2];
    let destination_volume = source_volume;

    for ((name, forward_value), (_, reverse_value)) in forward_tensor
        .components()
        .into_iter()
        .zip(reverse_tensor.components())
    {
        let lhs = destination_volume * forward_value;
        let rhs = source_volume * reverse_value;
        let tolerance = 2.0e-12_f64.max(2.0e-10 * lhs.abs().max(rhs.abs()));
        assert!(
            (lhs - rhs).abs() <= tolerance,
            "volume-weighted reciprocity failed for {name}: lhs={lhs:.16e}, rhs={rhs:.16e}"
        );
    }
}

#[test]
fn unequal_cell_cubature_obeys_nontrivial_volume_weighted_reciprocity() {
    // This establishes the mathematical contract independently. The current
    // production shifted builder still accepts only one shared cell size.
    let source_cell = [0.7, 0.9, 0.6];
    let destination_cell = [0.7, 0.9, 1.4];
    let displacement = [0.8, -1.1, 3.2];
    let forward = cubature_cell_pair_tensor(source_cell, destination_cell, displacement);
    let reverse = cubature_cell_pair_tensor(
        destination_cell,
        source_cell,
        [-displacement[0], -displacement[1], -displacement[2]],
    );
    let source_volume = source_cell[0] * source_cell[1] * source_cell[2];
    let destination_volume = destination_cell[0] * destination_cell[1] * destination_cell[2];
    assert_ne!(source_volume, destination_volume);

    for ((name, forward_value), (_, reverse_value)) in
        forward.components().into_iter().zip(reverse.components())
    {
        let lhs = destination_volume * forward_value;
        let rhs = source_volume * reverse_value;
        let tolerance = 2.0e-12_f64.max(2.0e-10 * lhs.abs().max(rhs.abs()));
        assert!(
            (lhs - rhs).abs() <= tolerance,
            "unequal-volume reciprocity failed for {name}: lhs={lhs:.16e}, rhs={rhs:.16e}"
        );
    }
}

#[test]
fn shifted_kernel_preserves_xy_parity_signs() {
    let kernel = compute_newell_kernels_shifted(3, 3, 2, 0.7, 0.9, 1.1, 3.25);
    let pp = kernel_tensor_at(&kernel, [1, 1, -1]);
    let np = kernel_tensor_at(&kernel, [-1, 1, -1]);
    let pn = kernel_tensor_at(&kernel, [1, -1, -1]);

    for (name, positive, negative_x, negative_y, x_parity, y_parity) in [
        ("xx", pp.xx, np.xx, pn.xx, 1.0, 1.0),
        ("yy", pp.yy, np.yy, pn.yy, 1.0, 1.0),
        ("zz", pp.zz, np.zz, pn.zz, 1.0, 1.0),
        ("xy", pp.xy, np.xy, pn.xy, -1.0, -1.0),
        ("xz", pp.xz, np.xz, pn.xz, -1.0, 1.0),
        ("yz", pp.yz, np.yz, pn.yz, 1.0, -1.0),
    ] {
        assert!(
            (negative_x - x_parity * positive).abs() < 1.0e-13,
            "X parity failed for {name}"
        );
        assert!(
            (negative_y - y_parity * positive).abs() < 1.0e-13,
            "Y parity failed for {name}"
        );
    }
}

#[test]
fn shifted_cross_field_is_nonzero() {
    let kernel = compute_newell_kernels_shifted(2, 2, 2, 0.8, 0.9, 1.1, 2.75);
    let tensor = kernel_tensor_at(&kernel, [1, 1, -1]);
    let magnetization = [0.7, -0.2, 0.5];
    let field = [
        -(tensor.xx * magnetization[0]
            + tensor.xy * magnetization[1]
            + tensor.xz * magnetization[2]),
        -(tensor.xy * magnetization[0]
            + tensor.yy * magnetization[1]
            + tensor.yz * magnetization[2]),
        -(tensor.xz * magnetization[0]
            + tensor.yz * magnetization[1]
            + tensor.zz * magnetization[2]),
    ];
    let norm = (field[0] * field[0] + field[1] * field[1] + field[2] * field[2]).sqrt();

    assert!(
        norm > 1.0e-6,
        "shifted cross field must be nonzero, got {field:?}"
    );
}
