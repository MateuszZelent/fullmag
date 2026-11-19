use fullmag_ir::{MaterialParameterNameIR as Parameter, ProblemIR, ProblemIRV04};
use serde_json::{json, Value};

fn problem_with_field(parameter: Parameter, field: Value, regional: bool) -> ProblemIR {
    let mut problem = ProblemIR::bootstrap_example();
    if regional {
        problem.object_regions.push(serde_json::from_value(json!({
            "region_id": "strip:core", "owner_object": "strip", "name": "core",
            "shape": {"kind": "box", "size": [1e-9, 1e-9, 1e-9], "center": [0.0, 0.0, 0.0]},
            "enabled": true,
            "material_overrides": [{"parameter": parameter, "value": field}]
        })).unwrap());
    } else {
        problem.material_parameter_fields.push(serde_json::from_value(json!({
            "assignment_id": "strip:field", "owner_object": "strip",
            "parameter": parameter, "value": field
        })).unwrap());
    }
    problem
}

fn fields() -> Vec<Value> {
    vec![
        json!({"kind": "constant", "value": 1.0}),
        json!({"kind": "linear", "base": 1.0, "gradient": [0.0, 0.0, 0.0]}),
        json!({"kind": "radial", "center": [0.0, 0.0, 0.0], "radius": 1e-9,
               "inside": 1.0, "outside": 2.0}),
        json!({"kind": "sampled", "asset_id": "material:samples",
               "component_count": 1, "location": "node"}),
    ]
}

fn migrate(problem: &ProblemIR) -> ProblemIRV04 {
    let mut value = serde_json::to_value(problem).unwrap();
    fullmag_ir::migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap();
    serde_json::from_value(value).unwrap()
}

#[test]
fn material_field_units_are_checked_in_v04_public_validation() {
    for regional in [false, true] {
        for mut field in fields() {
            field["unit"] = json!("pJ/m");
            let problem = problem_with_field(Parameter::Aex, field, regional);
            let error = migrate(&problem).validate().expect_err("V04 must reject non-SI units");
            let message = format!("{error:?}");
            assert!(message.contains("unit") && message.contains("J/m"), "{message}");
        }
    }
}

#[test]
fn material_field_units_reject_misleading_units_on_objects_and_regions() {
    for regional in [false, true] {
        for (parameter, wrong_unit, expected) in [
            (Parameter::Aex, "pJ/m", "J/m"),
            (Parameter::Ms, "kA/m", "A/m"),
            (Parameter::Ms, "mT", "A/m"),
            (Parameter::Alpha, "A/m", "1"),
            (Parameter::Ku1, "J/m", "J/m^3"),
            (Parameter::Dind, "J/m^3", "J/m^2"),
            (Parameter::Aex, "", "J/m"),
            (Parameter::Aex, "  ", "J/m"),
        ] {
            for mut field in fields() {
                field["unit"] = json!(wrong_unit);
                let problem = problem_with_field(parameter, field.clone(), regional);
                let error = problem.validate().expect_err(&format!(
                    "{parameter:?} {field} regional={regional} must reject misleading units"
                ));
                let message = format!("{error:?}");
                assert!(message.contains("unit") && message.contains(expected), "{message}");
            }
        }
    }
}

#[test]
fn material_field_units_accept_si_and_implicit_si_without_rescaling() {
    for regional in [false, true] {
        for (parameter, unit) in [
            (Parameter::Ms, "A/m"), (Parameter::Aex, "J/m"),
            (Parameter::Alpha, "1"), (Parameter::Ku1, "J/m^3"),
            (Parameter::Ku2, "J/m^3"), (Parameter::Kc1, "J/m^3"),
            (Parameter::Kc2, "J/m^3"), (Parameter::Kc3, "J/m^3"),
            (Parameter::Dind, "J/m^2"), (Parameter::Dbulk, "J/m^2"),
            (Parameter::AnisotropyAxis, "1"),
        ] {
            for mut field in fields() {
                if parameter == Parameter::AnisotropyAxis {
                    match field["kind"].as_str().unwrap() {
                        "constant" => field["value"] = json!([1.0, 0.0, 0.0]),
                        "sampled" => field["component_count"] = json!(3),
                        _ => continue,
                    }
                }
                if field["kind"] != "sampled" {
                    problem_with_field(parameter, field.clone(), regional).validate().unwrap();
                    field["unit"] = Value::Null;
                    problem_with_field(parameter, field.clone(), regional).validate().unwrap();
                }
                if unit == "1" {
                    field["unit"] = json!("dimensionless");
                    problem_with_field(parameter, field.clone(), regional).validate().unwrap();
                }
                field["unit"] = json!(unit);
                let problem = problem_with_field(parameter, field, regional);
                let before = serde_json::to_value(&problem).unwrap();
                problem.validate().unwrap();
                migrate(&problem).validate().unwrap();
                assert_eq!(serde_json::to_value(problem).unwrap(), before);
            }
        }
    }
}
