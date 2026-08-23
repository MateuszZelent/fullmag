use fullmag_fdm_sys::{fullmag_fdm_plan_desc, fullmag_fdm_plan_desc_v2};

#[test]
fn plan_descriptor_has_versioned_complete_layout() {
    macro_rules! assert_base_offset {
        ($field:ident, $expected:expr) => {
            assert_eq!(
                std::mem::offset_of!(fullmag_fdm_plan_desc_v2, base)
                    + std::mem::offset_of!(fullmag_fdm_plan_desc, $field),
                $expected,
                "unexpected offset for {}",
                stringify!($field)
            );
        };
    }

    assert_eq!(std::mem::offset_of!(fullmag_fdm_plan_desc_v2, abi_version), 0);
    assert_eq!(std::mem::offset_of!(fullmag_fdm_plan_desc_v2, struct_size), 4);
    assert_eq!(std::mem::offset_of!(fullmag_fdm_plan_desc_v2, base), 8);
    assert_eq!(std::mem::align_of::<fullmag_fdm_plan_desc>(), 8);
    assert_eq!(std::mem::size_of::<fullmag_fdm_plan_desc>(), 1280);
    assert_eq!(std::mem::align_of::<fullmag_fdm_plan_desc_v2>(), 8);
    assert_eq!(std::mem::size_of::<fullmag_fdm_plan_desc_v2>(), 1384);

    assert_base_offset!(grid, 8);
    assert_base_offset!(ms_field, 128);
    assert_base_offset!(a_field, 144);
    assert_base_offset!(alpha_field, 160);
    assert_base_offset!(dind_field, 376);
    assert_base_offset!(dbulk_field, 392);
    assert_base_offset!(zhang_li_formula, 536);
    assert_base_offset!(slonczewski_formula, 600);
    assert_base_offset!(slonczewski_active_mask, 632);
    assert_base_offset!(sot_active_mask, 712);
    assert_base_offset!(oersted_field_xyz, 848);
    assert_base_offset!(demag_kernel_xx_spectrum, 864);
    assert_base_offset!(active_mask, 936);
    assert_base_offset!(region_mask, 952);
    assert_base_offset!(exchange_pairs, 992);
    assert_base_offset!(volume_fraction, 1032);
    assert_base_offset!(demag_corr_target_idx, 1152);
    assert_base_offset!(initial_magnetization_xyz, 1184);
    assert_base_offset!(frozen_mask, 1256);
    assert_base_offset!(frozen_reference_xyz, 1272);
    assert_eq!(
        std::mem::offset_of!(fullmag_fdm_plan_desc_v2, time_policy),
        1288
    );
}
