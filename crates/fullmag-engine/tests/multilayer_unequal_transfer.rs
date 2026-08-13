use std::f64::consts::PI;

use fullmag_engine::multilayer::{
    collapse_kernel_z_plane, FdmLayerRuntime, KernelPair, MultilayerDemagRuntime,
};
use fullmag_fdm_demag::descriptors::{
    ActiveMaskIdentity, CommonTransformLayout, ConvolutionMode, FdmLayerDescriptor, GridGeometry,
};
use fullmag_fdm_demag::{
    compute_shifted_kernel_pair, TransferBoundaryPolicy, TransferKind, VolumeWeightedTransfer,
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

#[derive(Clone, Copy)]
struct Tensor6 {
    xx: f64,
    yy: f64,
    zz: f64,
    xy: f64,
    xz: f64,
    yz: f64,
}

impl Tensor6 {
    fn field(self, magnetization: [f64; 3]) -> [f64; 3] {
        [
            -(self.xx * magnetization[0] + self.xy * magnetization[1] + self.xz * magnetization[2]),
            -(self.xy * magnetization[0] + self.yy * magnetization[1] + self.yz * magnetization[2]),
            -(self.xz * magnetization[0] + self.yz * magnetization[1] + self.zz * magnetization[2]),
        ]
    }
}

fn cubature_cell_pair_tensor(
    source_cell: [f64; 3],
    destination_cell: [f64; 3],
    displacement: [f64; 3],
) -> Tensor6 {
    let mut tensor = [0.0; 6];
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
    let destination_volume = destination_cell.into_iter().product::<f64>();
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

fn descriptor(
    name: &str,
    origin_z: f64,
    native_thickness: f64,
    transfer_kind: TransferKind,
) -> FdmLayerDescriptor {
    FdmLayerDescriptor::new(
        name,
        name,
        GridGeometry::new(
            [0.0, 0.0, origin_z],
            [1, 1, 1],
            [1.0, 1.0, native_thickness],
        )
        .expect("native grid"),
        GridGeometry::new([0.0, 0.0, origin_z], [1, 1, 1], [1.0, 1.0, 2.0]).expect("scratch grid"),
        ConvolutionMode::TwoDStack,
        ActiveMaskIdentity::all_active(),
        transfer_kind,
    )
    .expect("layer descriptor")
}

fn runtime() -> MultilayerDemagRuntime {
    let descriptors = vec![
        descriptor("thin", 0.0, 1.0, TransferKind::PushPull),
        descriptor("thick", 4.0, 2.0, TransferKind::Identity),
    ];
    let layout = CommonTransformLayout::for_pair(
        [1, 1, 1],
        [1, 1, 1],
        ConvolutionMode::TwoDStack,
        [0; 3],
        [0; 3],
        [0; 3],
        [1, 1, 1],
        [2, 2, 1],
        0.25,
    )
    .expect("transform layout");
    let mut pairs = Vec::new();
    for &(source, destination) in &[(0, 1), (1, 0)] {
        let source_cell = [1.0, 1.0, descriptors[source].native.spacing[2]];
        let destination_cell = [1.0, 1.0, descriptors[destination].native.spacing[2]];
        let offset = [
            0.0,
            0.0,
            descriptors[destination].scratch.origin[2] - descriptors[source].scratch.origin[2]
                + 0.5 * (destination_cell[2] - source_cell[2]),
        ];
        let kernel = compute_shifted_kernel_pair([1, 1, 1], source_cell, destination_cell, offset)
            .expect("unequal-thickness kernel");
        pairs.push(KernelPair {
            src_layer: source,
            dst_layer: destination,
            kernel: collapse_kernel_z_plane(kernel).expect("2-D kernel"),
        });
    }
    MultilayerDemagRuntime::new_with_layout_and_descriptors(
        pairs,
        [1, 1, 1],
        [1.0, 1.0, 2.0],
        layout,
        descriptors,
    )
    .expect("multilayer runtime")
}

fn layer(name: &str, origin_z: f64, thickness: f64, m: [f64; 3]) -> FdmLayerRuntime {
    FdmLayerRuntime {
        magnet_name: name.to_string(),
        grid: [1, 1, 1],
        cell_size: [1.0, 1.0, thickness],
        origin: [0.0, 0.0, origin_z],
        ms: 1.0,
        ms_field: None,
        exchange_stiffness: 0.0,
        damping: 0.0,
        active_mask: None,
        m: vec![m],
        h_ex: vec![[0.0; 3]],
        h_demag: vec![[0.0; 3]],
        h_eff: vec![[0.0; 3]],
        conv_grid: [1, 1, 1],
        conv_cell_size: [1.0, 1.0, 2.0],
        needs_transfer: thickness != 2.0,
        transfer_boundary_policy: TransferBoundaryPolicy::OPEN,
    }
}

fn assert_vector_close(actual: [f64; 3], expected: [f64; 3], context: &str) {
    for component in 0..3 {
        let tolerance = 3.0e-10_f64.max(3.0e-7 * expected[component].abs());
        assert!(
            (actual[component] - expected[component]).abs() <= tolerance,
            "{context} component {component}: runtime={:.16e}, direct={:.16e}, tolerance={tolerance:.3e}",
            actual[component],
            expected[component],
        );
    }
}

fn dot(left: [f64; 3], right: [f64; 3]) -> f64 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

fn cross_fields(thin_m: [f64; 3], thick_m: [f64; 3]) -> [[f64; 3]; 2] {
    let mut layers = vec![
        layer("thin", 0.0, 1.0, thin_m),
        layer("thick", 4.0, 2.0, thick_m),
    ];
    runtime()
        .compute_demag_fields_checked(&mut layers)
        .expect("runtime composition");
    [layers[0].h_demag[0], layers[1].h_demag[0]]
}

#[test]
fn unequal_two_d_push_pull_matches_direct_oracle_for_both_orientations_and_axes() {
    for source_axis in 0..3 {
        let mut magnetization = [0.0; 3];
        magnetization[source_axis] = 1.0;

        let thin_to_thick = cross_fields(magnetization, [0.0; 3]);
        let expected_thick =
            cubature_cell_pair_tensor([1.0, 1.0, 1.0], [1.0, 1.0, 2.0], [0.0, 0.0, 4.5])
                .field(magnetization);
        assert_vector_close(
            thin_to_thick[1],
            expected_thick,
            &format!("thin->thick source_axis={source_axis}"),
        );

        let thick_to_thin = cross_fields([0.0; 3], magnetization);
        let expected_thin =
            cubature_cell_pair_tensor([1.0, 1.0, 2.0], [1.0, 1.0, 1.0], [0.0, 0.0, -4.5])
                .field(magnetization);
        assert_vector_close(
            thick_to_thin[0],
            expected_thin,
            &format!("thick->thin source_axis={source_axis}"),
        );
    }
}

#[test]
fn partial_scratch_cell_preserves_moment_adjoint_and_inactive_zero() {
    let transfer = VolumeWeightedTransfer::new(
        [2, 1, 1],
        [0.5, 1.0, 1.0],
        [0.0; 3],
        [1, 1, 1],
        [1.0, 1.0, 1.0],
        [0.0; 3],
        TransferBoundaryPolicy::OPEN,
    )
    .expect("partial-cell transfer");
    let native_m = [[2.0, -4.0, 6.0], [100.0; 3]];
    let mask = [true, false];
    let scratch_h = [[0.25, -0.5, 0.75]];
    let pushed = transfer.push_m(&native_m, Some(&mask)).expect("push");
    let pulled = transfer
        .pull_h_adjoint(&scratch_h, Some(&mask))
        .expect("pull");

    assert_eq!(pushed, [[1.0, -2.0, 3.0]]);
    assert_eq!(pulled[0], scratch_h[0]);
    assert_eq!(pulled[1], [0.0; 3]);

    let scratch_volume = 1.0;
    let native_volume = 0.5;
    let lhs = scratch_volume * dot(pushed[0], scratch_h[0]);
    let rhs = native_volume * dot(native_m[0], pulled[0]);
    assert!((lhs - rhs).abs() < 1.0e-14, "lhs={lhs} rhs={rhs}");

    let inactive = [false, false];
    assert_eq!(
        transfer.push_m(&native_m, Some(&inactive)).expect("push"),
        [[0.0; 3]]
    );
    assert_eq!(
        transfer
            .pull_h_adjoint(&scratch_h, Some(&inactive))
            .expect("pull"),
        [[0.0; 3], [0.0; 3]]
    );
}

#[test]
fn unequal_two_d_cross_energy_is_reciprocal_and_matches_field_derivative() {
    const MU0: f64 = 4.0 * PI * 1.0e-7;
    let thin_m = [0.3, -0.4, 0.5];
    let thick_m = [-0.2, 0.6, 0.1];
    let fields = cross_fields(thin_m, thick_m);
    let thin_volume = 1.0;
    let thick_volume = 2.0;
    let thin_work = thin_volume * dot(thin_m, fields[0]);
    let thick_work = thick_volume * dot(thick_m, fields[1]);
    let work_tolerance = 2.0e-12_f64.max(2.0e-10 * thin_work.abs().max(thick_work.abs()));
    assert!(
        (thin_work - thick_work).abs() <= work_tolerance,
        "mutual work is not reciprocal: thin={thin_work:.16e}, thick={thick_work:.16e}"
    );

    let energy = |thin: [f64; 3]| {
        let h = cross_fields(thin, thick_m);
        -0.5 * MU0 * (thin_volume * dot(thin, h[0]) + thick_volume * dot(thick_m, h[1]))
    };
    let direction = [0.7, -0.1, 0.2];
    let epsilon = 1.0e-6;
    let plus = [
        thin_m[0] + epsilon * direction[0],
        thin_m[1] + epsilon * direction[1],
        thin_m[2] + epsilon * direction[2],
    ];
    let minus = [
        thin_m[0] - epsilon * direction[0],
        thin_m[1] - epsilon * direction[1],
        thin_m[2] - epsilon * direction[2],
    ];
    let finite_difference = (energy(plus) - energy(minus)) / (2.0 * epsilon);
    let field_derivative = -MU0 * thin_volume * dot(direction, fields[0]);
    let derivative_tolerance = 2.0e-14_f64.max(2.0e-8 * field_derivative.abs());
    assert!(
        (finite_difference - field_derivative).abs() <= derivative_tolerance,
        "energy derivative={finite_difference:.16e}, field derivative={field_derivative:.16e}, tolerance={derivative_tolerance:.3e}"
    );
}
