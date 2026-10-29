use super::*;

const OBJECT_TRANSLATION: [f64; 3] = [30e-9, -10e-9, 4e-9];

fn translated_strip_ir() -> ProblemIR {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries = vec![GeometryEntryIR::Translate {
        name: "shifted_strip".to_string(),
        base: Box::new(GeometryEntryIR::Box {
            name: "strip_base".to_string(),
            size: [100e-9, 10e-9, 4e-9],
        }),
        by: OBJECT_TRANSLATION,
    }];
    ir.regions[0].geometry = "shifted_strip".to_string();
    ir
}

fn cell_center(fdm: &fullmag_ir::FdmPlanIR, index: usize) -> [f64; 3] {
    let [nx, ny, _] = fdm.grid.cells.map(|value| value as usize);
    let x = index % nx;
    let y = (index / nx) % ny;
    let z = index / (nx * ny);
    std::array::from_fn(|axis| {
        fdm.origin_m[axis]
            + (match axis {
                0 => x,
                1 => y,
                _ => z,
            } as f64
                + 0.5)
                * fdm.cell_size[axis]
    })
}

fn fdm_plan(ir: &ProblemIR) -> fullmag_ir::FdmPlanIR {
    let planned = plan(ir).expect("FDM material case should plan");
    let BackendPlanIR::Fdm(fdm) = planned.backend_plan else {
        panic!("expected FDM plan");
    };
    fdm
}

fn fdm_multilayer_plan(ir: &ProblemIR) -> fullmag_ir::FdmMultilayerPlanIR {
    let planned = plan(ir).expect("FDM multilayer material case should plan");
    let BackendPlanIR::FdmMultilayer(fdm) = planned.backend_plan else {
        panic!("expected FDM multilayer plan");
    };
    fdm
}

fn force_cuda(ir: &mut ProblemIR) {
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
}

fn set_fully_periodic(ir: &mut ProblemIR) {
    ir.pbc = Some(fullmag_ir::FdmPeriodicityIR {
        axes: [
            fullmag_ir::AxisBoundary::Periodic,
            fullmag_ir::AxisBoundary::Periodic,
            fullmag_ir::AxisBoundary::Periodic,
        ],
        demag: fullmag_ir::FdmDemagPeriodicityIR::Open,
        image_counts: None,
    });
}

fn give_second_layer_separate_material(
    ir: &mut ProblemIR,
    interfacial_dmi: Option<f64>,
    bulk_dmi: Option<f64>,
) {
    let mut material = ir
        .materials
        .iter()
        .find(|material| material.name == ir.magnets[0].material)
        .expect("first layer material should exist")
        .clone();
    material.name = "PyRef".to_string();
    material.interfacial_dmi = interfacial_dmi;
    material.bulk_dmi = bulk_dmi;
    ir.materials.push(material);
    ir.magnets[1].material = "PyRef".to_string();
}

#[test]
fn single_grid_material_scalar_dmi_is_lowered_on_cpu_and_cuda() {
    for cuda in [false, true] {
        let mut ir = ProblemIR::bootstrap_example();
        ir.materials[0].interfacial_dmi = Some(1.75e-3);
        ir.materials[0].bulk_dmi = Some(-0.625e-3);
        set_fully_periodic(&mut ir);
        if cuda {
            force_cuda(&mut ir);
        }

        assert!(ir.energy_terms.iter().all(|term| {
            !matches!(
                term,
                fullmag_ir::EnergyTermIR::InterfacialDmi { .. }
                    | fullmag_ir::EnergyTermIR::BulkDmi { .. }
            )
        }));
        let fdm = fdm_plan(&ir);
        assert_eq!(fdm.interfacial_dmi, Some(1.75e-3), "cuda={cuda}");
        assert_eq!(fdm.bulk_dmi, Some(-0.625e-3), "cuda={cuda}");
    }
}

#[test]
fn single_grid_explicit_dmi_terms_override_material_scalars() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.materials[0].interfacial_dmi = Some(4.0e-3);
    ir.materials[0].bulk_dmi = Some(-6.0e-3);
    ir.energy_terms
        .push(fullmag_ir::EnergyTermIR::InterfacialDmi {
            d: 1.25e-3,
            interface_normal: None,
        });
    ir.energy_terms
        .push(fullmag_ir::EnergyTermIR::BulkDmi { d: -2.5e-3 });
    set_fully_periodic(&mut ir);

    let fdm = fdm_plan(&ir);
    assert_eq!(fdm.interfacial_dmi, Some(1.25e-3));
    assert_eq!(fdm.bulk_dmi, Some(-2.5e-3));
}

#[test]
fn single_grid_material_zero_dmi_remains_explicit() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.materials[0].interfacial_dmi = Some(-0.0);
    ir.materials[0].bulk_dmi = Some(0.0);
    set_fully_periodic(&mut ir);

    let fdm = fdm_plan(&ir);
    assert_eq!(
        fdm.interfacial_dmi.map(f64::to_bits),
        Some((-0.0_f64).to_bits())
    );
    assert_eq!(fdm.bulk_dmi.map(f64::to_bits), Some(0.0_f64.to_bits()));
}

#[test]
fn multilayer_uniform_material_interfacial_dmi_is_lowered_on_cpu_and_cuda() {
    for cuda in [false, true] {
        let mut ir = if cuda {
            cuda_three_d_identity_multilayer_problem()
        } else {
            stacked_two_body_multilayer_problem()
        };
        ir.materials[0].interfacial_dmi = Some(2.375e-3);
        if !cuda {
            give_second_layer_separate_material(&mut ir, Some(2.375e-3), None);
        }

        let fdm = fdm_multilayer_plan(&ir);
        assert_eq!(fdm.interfacial_dmi, Some(2.375e-3), "cuda={cuda}");
    }
}

#[test]
fn multilayer_material_interfacial_dmi_rejects_nonuniform_effective_values() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.materials[0].interfacial_dmi = Some(2.375e-3);
    give_second_layer_separate_material(&mut ir, None, None);

    let error = plan(&ir).expect_err("nonuniform body-local DMI cannot fit one multilayer scalar");
    assert!(
        error.reasons.iter().any(|reason| {
            reason.contains("interfacial_dmi") && reason.contains("material")
        }),
        "expected an explicit material interfacial_dmi mismatch, got {:?}",
        error.reasons
    );
}

#[test]
fn multilayer_material_zero_interfacial_dmi_matches_missing_value() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.materials[0].interfacial_dmi = Some(0.0);
    give_second_layer_separate_material(&mut ir, None, None);

    let fdm = fdm_multilayer_plan(&ir);
    assert_eq!(fdm.interfacial_dmi, Some(0.0));
}

#[test]
fn multilayer_explicit_interfacial_dmi_overrides_nonuniform_material_values() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.materials[0].interfacial_dmi = Some(4.0e-3);
    give_second_layer_separate_material(&mut ir, None, None);
    ir.energy_terms
        .push(fullmag_ir::EnergyTermIR::InterfacialDmi {
            d: 0.0,
            interface_normal: None,
        });

    let fdm = fdm_multilayer_plan(&ir);
    assert_eq!(fdm.interfacial_dmi, Some(0.0));
}

#[test]
fn multilayer_material_bulk_dmi_is_not_silently_dropped() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.materials[0].bulk_dmi = Some(1.25e-3);
    give_second_layer_separate_material(&mut ir, None, Some(1.25e-3));

    let error = plan(&ir).expect_err("multilayer BulkDmi remains explicitly unsupported");
    assert!(
        error
            .reasons
            .iter()
            .any(|reason| reason.contains("BulkDmi") && reason.contains("multilayer")),
        "expected the existing multilayer BulkDmi capability rejection, got {:?}",
        error.reasons
    );
}

#[test]
fn multilayer_material_bulk_dmi_rejects_nonuniform_values_before_capability_guard() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.materials[0].bulk_dmi = Some(1.25e-3);
    give_second_layer_separate_material(&mut ir, None, Some(2.0e-3));

    let error = plan(&ir).expect_err("different body-local BulkDmi values cannot share one scalar");
    assert!(
        error.reasons.iter().any(|reason| {
            reason.contains("bulk_dmi") && reason.contains("material")
        }),
        "expected an explicit material bulk_dmi mismatch, got {:?}",
        error.reasons
    );
}

#[test]
fn single_grid_keeps_small_spatial_aex_delta() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.material_parameter_fields
        .push(fullmag_ir::MaterialParameterAssignmentIR {
            assignment_id: "small_delta_aex".to_string(),
            owner_object: "strip".to_string(),
            region_id: None,
            parameter: fullmag_ir::MaterialParameterNameIR::Aex,
            value: fullmag_ir::MaterialParameterFieldIR::Linear {
                base: 13e-12,
                // Across the 200 nm bootstrap strip this makes a non-zero sub-1e-12
                // total variation, below the old absolute flattening cutoff.
                gradient: [5e-6, 0.0, 0.0],
                frame: fullmag_ir::RegionFrameIR::Object,
                unit: Some("J/m".to_string()),
            },
            priority: 10,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        });

    let fdm = fdm_plan(&ir);
    let aex = fdm
        .material
        .a_field
        .expect("small spatial Aex delta must be retained as a cell field");
    let min = aex.iter().copied().fold(f64::INFINITY, f64::min);
    let max = aex.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    assert!(
        max - min > 9e-13,
        "resolved Aex variation was flattened: {min}..{max}"
    );
    assert!(
        max - min < 1e-12,
        "test delta must remain below the former absolute cutoff"
    );
}

#[test]
fn translated_linear_ms_respects_world_and_object_frames() {
    for frame in [
        fullmag_ir::RegionFrameIR::Object,
        fullmag_ir::RegionFrameIR::World,
    ] {
        let frame_origin_x = if matches!(frame, fullmag_ir::RegionFrameIR::Object) {
            OBJECT_TRANSLATION[0]
        } else {
            0.0
        };
        let mut ir = translated_strip_ir();
        let gradient_x = 1e12;
        ir.material_parameter_fields
            .push(fullmag_ir::MaterialParameterAssignmentIR {
                assignment_id: "translated_linear_ms".to_string(),
                owner_object: "strip".to_string(),
                region_id: None,
                parameter: fullmag_ir::MaterialParameterNameIR::Ms,
                value: fullmag_ir::MaterialParameterFieldIR::Linear {
                    base: 800e3,
                    gradient: [gradient_x, 0.0, 0.0],
                    frame,
                    unit: Some("A/m".to_string()),
                },
                priority: 10,
                conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
            });

        let fdm = fdm_plan(&ir);
        let ms = fdm
            .material
            .ms_field
            .as_ref()
            .expect("linear Ms must be sampled");
        let first_world = cell_center(&fdm, 0);
        let expected_first = 800e3 + gradient_x * (first_world[0] - frame_origin_x);
        assert!(
        (ms[0] - expected_first).abs() < 1e-6,
        "first translated sample should use the declared coordinate frame: actual={} expected={expected_first}",
        ms[0]
    );
        let last = ms.len() - 1;
        let last_world = cell_center(&fdm, last);
        let expected_last = 800e3 + gradient_x * (last_world[0] - frame_origin_x);
        assert!(
        (ms[last] - expected_last).abs() < 1e-6,
        "last translated sample should use the declared coordinate frame: actual={} expected={expected_last}",
        ms[last]
    );
    }
}

#[test]
fn translated_object_radial_ms_uses_local_cell_centers() {
    let mut ir = translated_strip_ir();
    let radius = 9e-9;
    let inside = 700e3;
    let outside = 900e3;
    ir.material_parameter_fields
        .push(fullmag_ir::MaterialParameterAssignmentIR {
            assignment_id: "translated_radial_ms".to_string(),
            owner_object: "strip".to_string(),
            region_id: None,
            parameter: fullmag_ir::MaterialParameterNameIR::Ms,
            value: fullmag_ir::MaterialParameterFieldIR::Radial {
                center: [0.0; 3],
                radius,
                inside,
                outside,
                frame: fullmag_ir::RegionFrameIR::Object,
                unit: Some("A/m".to_string()),
            },
            priority: 10,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        });

    let fdm = fdm_plan(&ir);
    let ms = fdm
        .material
        .ms_field
        .as_ref()
        .expect("radial Ms must be sampled");
    let mut saw_inside = false;
    let mut saw_outside = false;
    for (index, value) in ms.iter().enumerate() {
        let world = cell_center(&fdm, index);
        let object: [f64; 3] = std::array::from_fn(|axis| world[axis] - OBJECT_TRANSLATION[axis]);
        let distance = object
            .iter()
            .map(|component| component * component)
            .sum::<f64>()
            .sqrt();
        let expected = if distance <= radius { inside } else { outside };
        assert_eq!(
            *value, expected,
            "radial sample {index} used the wrong object-frame coordinate"
        );
        saw_inside |= expected == inside;
        saw_outside |= expected == outside;
    }
    assert!(
        saw_inside && saw_outside,
        "fixture must contain both radial regions"
    );
}

#[test]
fn translated_object_region_constant_override_uses_local_coordinates() {
    let mut ir = translated_strip_ir();
    let region_id = "strip:translated_core".to_string();
    ir.object_regions.push(fullmag_ir::ObjectRegionIR {
        region_id: region_id.clone(),
        owner_object: "strip".to_string(),
        name: "translated_core".to_string(),
        shape: fullmag_ir::RegionShapeIR::Box {
            size: [16e-9, 8e-9, 3e-9],
            center: [0.0; 3],
        },
        frame: fullmag_ir::RegionFrameIR::Object,
        enabled: true,
        priority: 10,
        mesh_policy: None,
        material_overrides: vec![fullmag_ir::RegionMaterialOverrideIR {
            parameter: fullmag_ir::MaterialParameterNameIR::Ms,
            value: fullmag_ir::MaterialParameterFieldIR::Constant {
                value: serde_json::json!(750e3),
                unit: Some("A/m".to_string()),
            },
            priority: 10,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        }],
        texture_override: None,
        material_transition: Some(fullmag_ir::MaterialTransitionSpecIR::Sharp),
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Inherit,
    });

    let fdm = fdm_plan(&ir);
    let ms = fdm
        .material
        .ms_field
        .expect("region Ms override must be sampled");
    let center_index = (fdm.grid.cells[0] as usize / 2)
        + fdm.grid.cells[0] as usize
            * (fdm.grid.cells[1] as usize / 2
                + fdm.grid.cells[1] as usize * (fdm.grid.cells[2] as usize / 2));
    assert_eq!(
        ms[center_index], 750e3,
        "translated Object-frame region must include the local core cell"
    );
    assert!(
        ms.iter().any(|value| *value == 800e3),
        "cells outside the local region must retain the base Ms"
    );
    assert_eq!(fdm.region_mask.len(), ms.len());
    assert!(
        fdm.grid_certificate
            .as_ref()
            .is_some_and(|certificate| certificate
                .region_legend
                .iter()
                .any(|entry| entry.region_id == region_id)),
        "the region selector must remain represented in the grid certificate"
    );
}
