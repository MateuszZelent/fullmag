//! Real Python -> Rust scene/projection adapters -> Python source-only proof.
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use fullmag_authoring::{
    SceneDocument, scene_document_from_script_builder, scene_document_problem_projection,
};
use serde_json::{Value, json};

fn bridge(request: Value) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().to_path_buf();
    let python = std::env::var("PYTHON").unwrap_or_else(|_| "python3".to_string());
    let mut child = Command::new(python)
        .arg("-B")
        .arg(root.join("packages/fullmag-py/tests/explicit_domain_roundtrip_bridge.py"))
        .current_dir(&root)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().expect("start source-only Python authoring bridge");
    child.stdin.take().unwrap().write_all(&serde_json::to_vec(&request).unwrap()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "bridge failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).expect("one JSON bridge response")
}

#[test]
fn pinned_gsg_sources_preserve_full_ir_through_real_rust_adapters() {
    for (fixture, pin) in [
        ("50nm.py", "6da40fc7342d7c3b78223c7ae21b14111a3172be3adcea697ccef1d37f734050"),
        ("corner25nm.py", "d5616c2e9125d3cd9f24f19580ee95cd5023d5e3de31098ae31b76867c55f148"),
    ] {
        let initial = bridge(json!({"action": "export_builder", "fixture": fixture}));
        assert_eq!(initial["fixture_sha256"], pin);
        let scene: SceneDocument = serde_json::from_value(initial["scene"].clone()).unwrap();
        let projection = scene_document_problem_projection(&scene).expect("actual Rust scene projection");
        let rebuilt = scene_document_from_script_builder(&projection.builder);
        assert_eq!(rebuilt.study.shared_domain_mesh_source, scene.study.shared_domain_mesh_source);
        assert_eq!(projection.rewrite_overrides["shared_domain_mesh_source"],
                   initial["builder"]["shared_domain_mesh_source"]);
        // The typed solver builder is magnetic-only. The canonical export
        // adapter must preserve every auxiliary object in its full inventory.
        assert_eq!(projection.rewrite_overrides["geometries"].as_array().unwrap().len(), scene.objects.len());
        let result = bridge(json!({
            "action": "render_and_reimport", "fixture": fixture,
            "scene": serde_json::to_value(&scene).unwrap(),
            "overrides": projection.rewrite_overrides,
        }));
        assert_eq!(result["fixture_sha256"], initial["fixture_sha256"]);
        assert_eq!(result["process_guard_calls"], 0);
        assert_eq!(result["mesh_guard_calls"], 0);
        assert_eq!(result["meshes_generated"], 0);
        assert_eq!(result["solves_submitted"], 0);
        assert_eq!(result["routes"].as_array().unwrap().len(), 2);
        for route in result["routes"].as_array().unwrap() {
            assert_eq!(route["full_ir_equal"], true, "{fixture}: {route}");
        }
        println!("{fixture}: {result}");
    }
}
