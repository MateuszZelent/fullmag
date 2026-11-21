//! A `function` material field (`fm.fields.function`) passes through a
//! SceneDocument unchanged and lowers to the same `MaterialParameterFieldIR`.

use fullmag_authoring::SceneMaterialParameterField;
use fullmag_ir::{MaterialParameterFieldIR, MaterialParameterNameIR, RegionFrameIR};
use serde_json::json;

#[test]
fn scene_function_field_round_trips_and_lowers_to_the_ir_variant() {
    let payload = json!({
        "kind": "function",
        "function": {
            "expression_version": "field_expr.v1",
            "name": "alpha",
            "parameters": [{"name": "a0", "value": 0.01}, {"name": "L", "value": 6e-7}],
            "locals": [{"name": "s", "expression": "max(0.0, x / L)"}],
            "outputs": ["a0 + 0.5 * s**3"]
        },
        "frame": "world"
    });
    let scene: SceneMaterialParameterField = serde_json::from_value(payload.clone()).unwrap();
    assert_eq!(serde_json::to_value(&scene).unwrap(), payload);

    let ir: MaterialParameterFieldIR = scene.into();
    assert_eq!(serde_json::to_value(&ir).unwrap(), payload);
    let MaterialParameterFieldIR::Function { frame, .. } = &ir else {
        panic!("expected a function field, got {ir:?}");
    };
    assert_eq!(*frame, RegionFrameIR::World);
    let compiled = ir
        .compile_function(MaterialParameterNameIR::Alpha)
        .unwrap()
        .unwrap();
    assert_eq!(compiled.eval_field([3e-7, 0.0, 0.0]), 0.01 + 0.5 * 0.5_f64.powf(3.0));
}
