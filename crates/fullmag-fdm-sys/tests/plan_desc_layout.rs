use fullmag_fdm_sys::{
    fullmag_fdm_plan_desc, fullmag_fdm_plan_desc_v2, fullmag_fdm_time_policy_desc_v2,
};

#[test]
fn plan_descriptor_has_versioned_complete_layout() {
    assert_eq!(std::mem::align_of::<fullmag_fdm_plan_desc>(), 8);
    assert_eq!(std::mem::size_of::<fullmag_fdm_plan_desc>(), 1280);
    assert_eq!(std::mem::align_of::<fullmag_fdm_plan_desc_v2>(), 8);
    assert_eq!(std::mem::size_of::<fullmag_fdm_plan_desc_v2>(), 1384);

    include!(concat!(env!("OUT_DIR"), "/plan_desc_v2_layout_assertions.rs"));
}
