#[test]
fn frequency_domain_golden_artifacts_are_contract_shaped() {
    let golden_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("tests/golden/frequency_domain/exchange_chain_gamma_x");

    let problem: serde_json::Value = serde_json::from_slice(
        &std::fs::read(golden_dir.join("problem.json")).expect("problem golden should exist"),
    )
    .expect("problem golden should be valid json");
    assert_eq!(
        problem["physics"]["spin_wave_bc"]["phase_convention"],
        "exp_minus_i_k_dot_delta_r"
    );

    let spectrum: serde_json::Value = serde_json::from_slice(
        &std::fs::read(golden_dir.join("spectrum.v2.json"))
            .expect("spectrum.v2 golden should exist"),
    )
    .expect("spectrum.v2 golden should be valid json");
    assert_eq!(spectrum["schema_version"], "eigen_spectrum.v2");
    assert_eq!(spectrum["samples"][1]["label"], "X");
    assert_eq!(spectrum["samples"][1]["path_s"], 50_000_000.0);
    assert_eq!(spectrum["samples"][1]["modes"][0]["branch_id"], 0);

    let branches: serde_json::Value = serde_json::from_slice(
        &std::fs::read(golden_dir.join("branches.v2.json"))
            .expect("branches.v2 golden should exist"),
    )
    .expect("branches.v2 golden should be valid json");
    assert_eq!(branches["schema_version"], "eigen_branches.v2");
    assert_eq!(branches["branches"][0]["points"][1]["sample_index"], 1);
    assert_eq!(branches["branches"][0]["points"][1]["overlap_prev"], 0.99);

    let dispersion = std::fs::read_to_string(golden_dir.join("dispersion.csv"))
        .expect("csv golden should exist");
    let header = dispersion.lines().next().expect("csv should have a header");
    for required in [
        "sample_index",
        "path_s_rad_per_m",
        "kx_rad_per_m",
        "ky_rad_per_m",
        "kz_rad_per_m",
        "branch_id",
        "residual_norm",
    ] {
        assert!(
            header.split(',').any(|column| column == required),
            "golden dispersion.csv header must contain {required}, got {header}"
        );
    }
}
