use fullmag_ir::{
    ImpressedPotentialJumpIR, RegionRefIR, StructuredCurrentClosureIR, StructuredCurrentDriveIR,
    StructuredCurrentSourceCutIR, StructuredCutAxisIR, StructuredCutNormalIR, StructuredCutPlaneIR,
};

fn closure() -> StructuredCurrentClosureIR {
    StructuredCurrentClosureIR::ClosedGeometry {
        schema_version: "structured_current_closure.v1".to_string(),
        closure_id: "loop-1".to_string(),
        source_cuts: vec![StructuredCurrentSourceCutIR {
            source_cut_id: "cut-1".to_string(),
            circuit_id: "circuit-1".to_string(),
            region: RegionRefIR {
                object_id: "loop".to_string(),
                region_id: Some("source-arm".to_string()),
            },
            plane: StructuredCutPlaneIR {
                axis: StructuredCutAxisIR::X,
                offset_m: 2.0e-9,
                normal: StructuredCutNormalIR::PositiveAxis,
            },
            drive: StructuredCurrentDriveIR::ImpressedPotentialJump(ImpressedPotentialJumpIR {
                schema_version: "impressed_potential_jump.v1".to_string(),
                drive_id: "drive-1".to_string(),
                potential_jump_v: 0.05,
            }),
        }],
    }
}

#[test]
fn structured_current_closure_is_a_typed_closed_geometry_union() {
    let value = serde_json::to_value(closure()).expect("serialize closure");

    assert_eq!(value["kind"], "closed_geometry");
    assert_eq!(value["schema_version"], "structured_current_closure.v1");
    assert_eq!(value["source_cuts"][0]["plane"]["axis"], "x");
    assert_eq!(value["source_cuts"][0]["region"]["region_id"], "source-arm");
    assert_eq!(
        value["source_cuts"][0]["drive"]["kind"],
        "impressed_potential_jump"
    );
    assert_eq!(value["source_cuts"][0]["drive"]["potential_jump_V"], 0.05);
    assert!(closure().validation_errors("current_transport").is_empty());
}

#[test]
fn structured_current_closure_rejects_duplicate_circuit_and_nonfinite_plane() {
    let mut invalid = closure();
    let StructuredCurrentClosureIR::ClosedGeometry { source_cuts, .. } = &mut invalid;
    let mut duplicate = source_cuts[0].clone();
    duplicate.source_cut_id = "cut-2".to_string();
    duplicate.drive.impressed_potential_jump_mut().drive_id = "drive-2".to_string();
    duplicate.plane.offset_m = f64::NAN;
    source_cuts.push(duplicate);

    let errors = invalid.validation_errors("current_transport");
    assert!(errors.iter().any(|error| error.contains("circuit_id")));
    assert!(errors.iter().any(|error| error.contains("offset_m")));
}

#[test]
fn structured_current_closure_rejects_certified_import_in_v1() {
    let error = serde_json::from_value::<StructuredCurrentClosureIR>(serde_json::json!({
        "schema_version": "structured_current_closure.v1",
        "closure_id": "import-1",
        "kind": "certified_import",
        "artifact_id": "artifact-1"
    }))
    .expect_err("certified_import is deferred beyond structured_current_closure.v1");

    assert!(error.to_string().contains("unknown variant"));
}

#[test]
fn structured_current_source_cut_requires_region_selector() {
    let mut value = serde_json::to_value(closure()).expect("serialize closure");
    value["source_cuts"][0]
        .as_object_mut()
        .expect("source cut object")
        .remove("region");

    let error = serde_json::from_value::<StructuredCurrentClosureIR>(value)
        .expect_err("region is required for plane intersection materialization");
    assert!(error.to_string().contains("region"));
}
