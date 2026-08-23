use fullmag_fdm_sys::{
    fullmag_fdm_grid_desc, fullmag_fdm_material_desc, fullmag_fdm_plan_desc,
    fullmag_fdm_plan_desc_v2, fullmag_fdm_time_policy_desc_v2,
};

#[test]
fn plan_descriptor_has_versioned_complete_layout() {
    assert_eq!(std::mem::align_of::<fullmag_fdm_plan_desc>(), 8);
    assert_eq!(std::mem::size_of::<fullmag_fdm_plan_desc>(), 1280);
    assert_eq!(std::mem::align_of::<fullmag_fdm_plan_desc_v2>(), 8);
    assert_eq!(std::mem::size_of::<fullmag_fdm_plan_desc_v2>(), 1384);

    include!(concat!(env!("OUT_DIR"), "/plan_desc_v2_layout_assertions.rs"));
}

#[test]
fn nested_layout_manifest_covers_every_grid_and_material_field() {
    let layout = include_str!("../../../native/include/fullmag_fdm_plan_desc_v2_layout.def");
    let grid_fields = layout
        .lines()
        .filter(|line| line.starts_with("FULLMAG_FDM_PLAN_V2_GRID_FIELD("))
        .count();
    let material_fields = layout
        .lines()
        .filter(|line| line.starts_with("FULLMAG_FDM_PLAN_V2_MATERIAL_FIELD("))
        .count();

    assert_eq!(grid_fields, 6, "grid nested-field manifest coverage drift");
    assert_eq!(
        material_fields, 4,
        "material nested-field manifest coverage drift"
    );
}
