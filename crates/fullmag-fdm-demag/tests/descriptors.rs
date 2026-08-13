use fullmag_fdm_demag::descriptors::{
    ActiveMaskIdentity, BoundaryPolicy, CommonTransformLayout, ConvolutionMode, CropWindow,
    FdmLayerDescriptor, GridGeometry, KernelPrecision, KernelReuseCatalog, NegativeLagMapping,
    OrientedKernelPairDescriptor, TensorRepresentation, TransferContractMetadata, TransferKind,
    TransferReference, TransformConvention, ZeroPadding,
};
use fullmag_fdm_demag::KernelReuseKey;

fn grid(origin: [f64; 3], shape: [usize; 3], spacing: [f64; 3]) -> GridGeometry {
    GridGeometry::new(origin, shape, spacing).expect("valid grid")
}

fn two_d_layer(layer_id: &str, object_id: &str, origin_z: f64) -> FdmLayerDescriptor {
    let native = grid([0.0, 0.0, origin_z], [4, 3, 2], [1.0, 1.0, 0.5]);
    let scratch = grid([0.0, 0.0, origin_z], [4, 3, 1], [1.0, 1.0, 1.0]);
    FdmLayerDescriptor::new(
        layer_id,
        object_id,
        native,
        scratch,
        ConvolutionMode::TwoDStack,
        ActiveMaskIdentity::all_active(),
        TransferKind::PushPull,
    )
    .expect("valid 2-D layer")
}

#[test]
fn common_layout_is_computational_and_preserves_linear_extent() {
    let layout = CommonTransformLayout::for_pair(
        [3, 2, 1],
        [5, 4, 1],
        ConvolutionMode::TwoDStack,
        [1, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [5, 4, 1],
        [16, 8, 1],
        1.0 / 128.0,
    )
    .expect("valid layout");

    assert_eq!(layout.linear_extent, [7, 5, 1]);
    assert_eq!(
        layout.destination_crop,
        CropWindow::new([1, 1, 0], [5, 4, 1])
    );
    assert_eq!(layout.source_insert_offset, [1, 0, 0]);
    assert_eq!(layout.lag_zero, [1, 0, 0]);
    assert!(!layout.is_physical_mesh());
    assert_eq!(layout.convention, TransformConvention::XFastestZMajor);
    assert_eq!(
        layout.negative_lag_mapping.index_for_lag([-1, 0, 0]),
        Some([0, 0, 0])
    );
    assert_eq!(
        layout.negative_lag_mapping.index_for_lag([0, 0, 0]),
        Some([1, 0, 0])
    );
}

#[test]
fn common_layout_rejects_non_linear_fft_extent_and_bad_crop() {
    let bad_extent = CommonTransformLayout::new(
        [3, 2, 1],
        [7, 4, 1],
        [1, 7, 28],
        ZeroPadding::new([0, 0, 0], [0, 0, 0]),
        TransformConvention::XFastestZMajor,
        [0, 0, 0],
        [0, 0, 0],
        NegativeLagMapping::wrap([7, 4, 1], [0, 0, 0]),
        CropWindow::new([0, 0, 0], [3, 2, 1]),
        1.0,
        [8, 3, 1],
        ConvolutionMode::ThreeD,
    );
    assert!(bad_extent.is_err());

    let bad_crop = CommonTransformLayout::new(
        [7, 5, 1],
        [8, 8, 1],
        [1, 8, 64],
        ZeroPadding::new([0, 0, 0], [1, 3, 0]),
        TransformConvention::XFastestZMajor,
        [0, 0, 0],
        [0, 0, 0],
        NegativeLagMapping::wrap([8, 8, 1], [0, 0, 0]),
        CropWindow::new([6, 4, 0], [3, 2, 1]),
        1.0,
        [7, 5, 1],
        ConvolutionMode::TwoDStack,
    );
    assert!(bad_crop.is_err());
}

#[test]
fn negative_lag_mapping_rejects_lags_outside_declared_linear_extent() {
    let mapping = NegativeLagMapping::wrap_with_linear_extent([16, 8, 1], [4, 2, 0], [7, 5, 1]);
    assert_eq!(mapping.index_for_lag([-6, 0, 0]), Some([14, 2, 0]));
    assert_eq!(mapping.index_for_lag([-7, 0, 0]), None);
    assert_eq!(mapping.index_for_lag([7, 0, 0]), None);
}

#[test]
fn layer_descriptor_keeps_native_and_scratch_distinct_and_requires_mask_identity() {
    let layer = two_d_layer("layer:a", "object:a", 0.0);
    assert_eq!(layer.native.shape, [4, 3, 2]);
    assert_eq!(layer.scratch.shape, [4, 3, 1]);
    assert_eq!(layer.transfer.kind, TransferKind::PushPull);
    assert_eq!(layer.active_mask, ActiveMaskIdentity::all_active());
    assert!(!layer.fingerprint().is_empty());

    let missing_mask_identity = ActiveMaskIdentity {
        present: true,
        fingerprint: None,
        active_cells: Some(1),
    };
    let error = FdmLayerDescriptor::new(
        "layer:a",
        "object:a",
        grid([0.0; 3], [1, 1, 1], [1.0; 3]),
        grid([0.0; 3], [1, 1, 1], [1.0; 3]),
        ConvolutionMode::ThreeD,
        missing_mask_identity,
        TransferKind::Identity,
    )
    .expect_err("mask must not be synthesized");
    assert!(error.to_string().contains("fingerprint"));
}

#[test]
fn identity_transfer_requires_native_and_scratch_geometry_equality() {
    let error = FdmLayerDescriptor::new(
        "layer:identity",
        "object:identity",
        grid([0.0; 3], [2, 2, 2], [1.0; 3]),
        grid([0.0; 3], [2, 2, 1], [1.0; 3]),
        ConvolutionMode::TwoDStack,
        ActiveMaskIdentity::all_active(),
        TransferKind::Identity,
    )
    .expect_err("identity cannot hide a native/scratch transfer");
    assert!(error.to_string().contains("identity"));
}

#[test]
fn transfer_contract_and_boundary_are_fail_closed() {
    let mut layer = two_d_layer("layer:contract", "object:contract", 0.0);
    layer.transfer.contract = TransferContractMetadata::identity();
    assert!(layer.validate().is_err());

    let mut layer = two_d_layer("layer:pbc", "object:pbc", 0.0);
    layer.transfer.boundary = BoundaryPolicy::Periodic {
        axes: [true, false, false],
    };
    assert!(layer.validate().is_err());
}

#[test]
fn pair_rejects_mixed_modes_and_schema_mismatch() {
    let source = two_d_layer("layer:mixed-s", "object:mixed-s", 0.0);
    let destination = FdmLayerDescriptor::new(
        "layer:mixed-d",
        "object:mixed-d",
        grid([0.0, 0.0, 2.0], [2, 2, 2], [1.0; 3]),
        grid([0.0, 0.0, 2.0], [2, 2, 2], [1.0; 3]),
        ConvolutionMode::ThreeD,
        ActiveMaskIdentity::all_active(),
        TransferKind::Identity,
    )
    .unwrap();
    assert!(OrientedKernelPairDescriptor::new(
        &destination,
        &source,
        [0.0, 0.0, 2.0],
        TensorRepresentation::FullComplex,
    )
    .is_err());

    let mut layer = source;
    layer.schema_version = "fdm_multilayer_descriptor.v0".to_string();
    assert!(layer.validate().is_err());
}

#[test]
fn active_mask_fingerprint_is_preserved_as_input_not_recomputed_from_shape() {
    let mask = ActiveMaskIdentity::from_fingerprint(
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        5,
    )
    .expect("valid mask identity");
    let layer = FdmLayerDescriptor::new(
        "layer:masked",
        "object:masked",
        grid([0.0; 3], [2, 2, 2], [1.0; 3]),
        grid([0.0; 3], [2, 2, 1], [1.0; 3]),
        ConvolutionMode::TwoDStack,
        mask.clone(),
        TransferKind::PushPull,
    )
    .expect("valid masked layer");
    assert_eq!(layer.active_mask, mask);
    assert_eq!(
        layer.fingerprint_inputs.active_mask_fingerprint,
        layer.active_mask.fingerprint
    );
}

#[test]
fn two_d_scratch_must_have_exactly_one_z_cell() {
    let result = FdmLayerDescriptor::new(
        "layer:a",
        "object:a",
        grid([0.0; 3], [2, 2, 2], [1.0; 3]),
        grid([0.0; 3], [2, 2, 2], [1.0; 3]),
        ConvolutionMode::TwoDStack,
        ActiveMaskIdentity::all_active(),
        TransferKind::Identity,
    );
    assert!(result.is_err());
}

#[test]
fn oriented_pair_uses_destination_source_orientation_and_exact_extent() {
    let source = two_d_layer("layer:s", "object:s", 0.0);
    let destination = two_d_layer("layer:d", "object:d", 2.0);
    let pair = OrientedKernelPairDescriptor::new(
        &destination,
        &source,
        [0.0, 0.0, 2.0],
        TensorRepresentation::FullComplex,
    )
    .expect("valid pair");
    assert_eq!(pair.destination_layer_id, "layer:d");
    assert_eq!(pair.source_layer_id, "layer:s");
    assert_eq!(pair.linear_extent, [7, 5, 1]);
    assert_eq!(pair.source_volume, 1.0);
    assert_eq!(pair.destination_volume, 1.0);
    assert_eq!(pair.source_transfer.layer_id, "layer:s");
    assert_eq!(pair.destination_transfer.layer_id, "layer:d");
}

#[test]
fn three_d_pair_keeps_the_z_linear_extent() {
    let source = FdmLayerDescriptor::new(
        "layer:s3",
        "object:s3",
        grid([0.0; 3], [2, 3, 2], [1.0; 3]),
        grid([0.0; 3], [2, 3, 2], [1.0; 3]),
        ConvolutionMode::ThreeD,
        ActiveMaskIdentity::all_active(),
        TransferKind::Identity,
    )
    .unwrap();
    let destination = FdmLayerDescriptor::new(
        "layer:d3",
        "object:d3",
        grid([0.0, 0.0, 2.0], [4, 1, 3], [1.0; 3]),
        grid([0.0, 0.0, 2.0], [4, 1, 3], [1.0; 3]),
        ConvolutionMode::ThreeD,
        ActiveMaskIdentity::all_active(),
        TransferKind::Identity,
    )
    .unwrap();
    let pair = OrientedKernelPairDescriptor::new(
        &destination,
        &source,
        [0.0, 0.0, 2.0],
        TensorRepresentation::FullComplex,
    )
    .unwrap();
    assert_eq!(pair.linear_extent, [5, 3, 4]);
}

#[test]
fn transfer_contract_is_explicitly_volume_weighted_and_mask_preserving() {
    let contract = TransferContractMetadata::volume_weighted_moment_preserving();
    assert!(contract.adjoint_required);
    assert!(contract.preserves_volume_weighted_moment);
    assert_eq!(contract.moment_policy, "full_scratch_volume_moment_density");
    assert_eq!(contract.active_cell_policy, "preserve_active_mask");
}

#[test]
fn reuse_key_allows_only_two_d_pure_z_opposite_shift_with_equal_h() {
    let source = two_d_layer("layer:s", "object:s", 0.0);
    let destination = two_d_layer("layer:d", "object:d", 2.0);
    let pair_plus = OrientedKernelPairDescriptor::new(
        &destination,
        &source,
        [0.0, 0.0, 2.0],
        TensorRepresentation::FullComplex,
    )
    .unwrap();
    let pair_minus = OrientedKernelPairDescriptor::new(
        &source,
        &destination,
        [0.0, 0.0, -2.0],
        TensorRepresentation::FullComplex,
    )
    .unwrap();
    let plus = KernelReuseKey::from_pair(&pair_plus, KernelPrecision::F64, BoundaryPolicy::Open);
    let minus = KernelReuseKey::from_pair(&pair_minus, KernelPrecision::F64, BoundaryPolicy::Open);
    assert!(plus.can_reuse_opposite_z(&minus));

    let mut xy = minus.clone();
    xy.oriented_shift[0] = 1_000_000_000;
    assert!(!plus.can_reuse_opposite_z(&xy));

    let mut three_d = minus.clone();
    three_d.mode = ConvolutionMode::ThreeD;
    assert!(!plus.can_reuse_opposite_z(&three_d));

    let mut precision = minus.clone();
    precision.precision = KernelPrecision::F32;
    assert_ne!(plus, precision);
}

#[test]
fn runtime_reuse_key_covers_layout_precision_boundary_and_schema() {
    let source = two_d_layer("layer:s", "object:s", 0.0);
    let destination = two_d_layer("layer:d", "object:d", 2.0);
    let layout = |offset| {
        CommonTransformLayout::for_pair(
            source.scratch.shape,
            destination.scratch.shape,
            ConvolutionMode::TwoDStack,
            [offset, 0, 0],
            [0; 3],
            [offset, 0, 0],
            destination.scratch.shape,
            [8, 8, 1],
            1.0 / 64.0,
        )
        .expect("valid runtime key layout")
    };
    let f64_key = KernelReuseKey::from_layers_with_layout(
        &destination,
        &source,
        [0.0, 0.0, 2.0],
        TensorRepresentation::FullComplex,
        &layout(0),
        KernelPrecision::F64,
        BoundaryPolicy::Open,
    )
    .expect("canonical f64 runtime key");
    let shifted_layout = KernelReuseKey::from_layers_with_layout(
        &destination,
        &source,
        [0.0, 0.0, 2.0],
        TensorRepresentation::FullComplex,
        &layout(1),
        KernelPrecision::F64,
        BoundaryPolicy::Open,
    )
    .expect("layout-specific runtime key");
    let f32_key = KernelReuseKey::from_layers_with_layout(
        &destination,
        &source,
        [0.0, 0.0, 2.0],
        TensorRepresentation::FullComplex,
        &layout(0),
        KernelPrecision::F32,
        BoundaryPolicy::Open,
    )
    .expect("precision-specific runtime key");
    assert_ne!(f64_key, shifted_layout);
    assert_ne!(f64_key, f32_key);

    let periodic = KernelReuseKey::from_layers_with_layout(
        &destination,
        &source,
        [0.0, 0.0, 2.0],
        TensorRepresentation::FullComplex,
        &layout(0),
        KernelPrecision::F64,
        BoundaryPolicy::Periodic {
            axes: [true, false, false],
        },
    );
    assert!(
        periodic.is_err(),
        "periodic key must fail closed in schema v1"
    );

    let mut stale_schema = f64_key.clone();
    stale_schema.schema_version = "fdm_multilayer_descriptor.v0".to_string();
    assert_ne!(stale_schema.fingerprint(), f64_key.fingerprint());
    assert!(stale_schema.validate().is_err());
}

#[test]
fn reuse_key_rejects_unequal_oriented_cell_heights() {
    let source = FdmLayerDescriptor::new(
        "layer:s",
        "object:s",
        grid([0.0; 3], [4, 3, 2], [1.0, 1.0, 0.5]),
        grid([0.0; 3], [4, 3, 1], [1.0, 1.0, 1.0]),
        ConvolutionMode::TwoDStack,
        ActiveMaskIdentity::all_active(),
        TransferKind::PushPull,
    )
    .unwrap();
    let destination = FdmLayerDescriptor::new(
        "layer:d",
        "object:d",
        grid([0.0; 3], [4, 3, 2], [1.0, 1.0, 0.75]),
        grid([0.0; 3], [4, 3, 1], [1.0, 1.0, 1.5]),
        ConvolutionMode::TwoDStack,
        ActiveMaskIdentity::all_active(),
        TransferKind::PushPull,
    )
    .unwrap();
    let plus = OrientedKernelPairDescriptor::new(
        &destination,
        &source,
        [0.0, 0.0, 2.0],
        TensorRepresentation::FullComplex,
    )
    .unwrap();
    let minus = OrientedKernelPairDescriptor::new(
        &source,
        &destination,
        [0.0, 0.0, -2.0],
        TensorRepresentation::FullComplex,
    )
    .unwrap();
    let plus = KernelReuseKey::from_pair(&plus, KernelPrecision::F64, BoundaryPolicy::Open);
    let minus = KernelReuseKey::from_pair(&minus, KernelPrecision::F64, BoundaryPolicy::Open);
    assert!(!plus.can_reuse_opposite_z(&minus));
}

#[test]
fn parity_reuse_rejects_equal_cell_size_with_unequal_physical_thickness() {
    let source = FdmLayerDescriptor::new(
        "layer:thin",
        "object:thin",
        grid([0.0; 3], [4, 3, 2], [1.0, 1.0, 0.5]),
        grid([0.0; 3], [4, 3, 1], [1.0, 1.0, 1.0]),
        ConvolutionMode::TwoDStack,
        ActiveMaskIdentity::all_active(),
        TransferKind::PushPull,
    )
    .unwrap();
    let destination = FdmLayerDescriptor::new(
        "layer:thick",
        "object:thick",
        grid([0.0, 0.0, 2.0], [4, 3, 3], [1.0, 1.0, 0.5]),
        grid([0.0, 0.0, 2.0], [4, 3, 1], [1.0, 1.0, 1.0]),
        ConvolutionMode::TwoDStack,
        ActiveMaskIdentity::all_active(),
        TransferKind::PushPull,
    )
    .unwrap();
    let plus = OrientedKernelPairDescriptor::new(
        &destination,
        &source,
        [0.0, 0.0, 2.0],
        TensorRepresentation::FullComplex,
    )
    .unwrap();
    let minus = OrientedKernelPairDescriptor::new(
        &source,
        &destination,
        [0.0, 0.0, -2.0],
        TensorRepresentation::FullComplex,
    )
    .unwrap();
    let plus = KernelReuseKey::from_pair(&plus, KernelPrecision::F64, BoundaryPolicy::Open);
    let minus = KernelReuseKey::from_pair(&minus, KernelPrecision::F64, BoundaryPolicy::Open);
    assert!(!plus.can_reuse_opposite_z(&minus));
}

#[test]
fn transform_key_and_catalog_bind_pair_identity() {
    let source = two_d_layer("layer:s-key", "object:s-key", 0.0);
    let destination = two_d_layer("layer:d-key", "object:d-key", 2.0);
    let pair = OrientedKernelPairDescriptor::new(
        &destination,
        &source,
        [0.0, 0.0, 2.0],
        TensorRepresentation::FullComplex,
    )
    .unwrap();
    let layout = CommonTransformLayout::for_pair(
        pair.source_shape,
        pair.destination_shape,
        pair.mode,
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        pair.destination_shape,
        [16, 8, 1],
        1.0 / 128.0,
    )
    .unwrap();
    let key = KernelReuseKey::from_pair_with_layout(
        &pair,
        &layout,
        KernelPrecision::F64,
        BoundaryPolicy::Open,
    )
    .expect("pair/layout compatibility");
    assert_eq!(key.transform.linear_extent, pair.linear_extent);
    let mut catalog = KernelReuseCatalog::from_keys([key.clone()]);
    catalog
        .bind_pair(&pair, key.clone())
        .expect("bind pair to key");
    assert_eq!(catalog.kernel_key_for_pair(&pair), Some(&key));
}

#[test]
fn descriptors_serde_round_trip_and_fingerprints_are_deterministic() {
    let source = two_d_layer("layer:s", "object:s", 0.0);
    let destination = two_d_layer("layer:d", "object:d", 2.0);
    let pair = OrientedKernelPairDescriptor::new(
        &destination,
        &source,
        [0.0, 0.0, 2.0],
        TensorRepresentation::FullComplex,
    )
    .unwrap();
    let key = KernelReuseKey::from_pair(&pair, KernelPrecision::F64, BoundaryPolicy::Open);
    let catalog = KernelReuseCatalog::from_keys([key.clone()]);
    let value = serde_json::to_value((&pair, &key, &catalog)).expect("serialize descriptor ABI");
    let json = serde_json::to_string(&value).expect("canonical JSON");
    assert_eq!(json, serde_json::to_string(&value).unwrap());
    let decoded: (
        OrientedKernelPairDescriptor,
        KernelReuseKey,
        KernelReuseCatalog,
    ) = serde_json::from_value(value).expect("deserialize descriptor ABI");
    assert_eq!(decoded.0, pair);
    assert_eq!(decoded.1, key);
    assert_eq!(decoded.2, catalog);
    assert!(pair.fingerprint().starts_with("sha256:"));
    assert_eq!(pair.fingerprint(), pair.fingerprint());
    assert!(catalog.fingerprint().starts_with("sha256:"));
}

#[test]
fn transfer_reference_keeps_identity_and_contract_metadata() {
    let reference = TransferReference::new(
        "layer:s",
        TransferKind::Identity,
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        TransferContractMetadata::identity(),
    )
    .expect("valid transfer reference");
    assert_eq!(reference.layer_id, "layer:s");
    assert_eq!(reference.kind, TransferKind::Identity);
    assert!(!reference.contract.adjoint_required);
}
