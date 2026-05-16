use fullmag_engine::fem_pbc_benchmark::{
    build_reference_pbc_demag_benchmark_problem, run_reference_pbc_demag_benchmark,
    run_reference_pbc_demag_golden_supercell,
};

#[test]
fn fem_pbc_demag_benchmark_fixture_exposes_periodic_mesh_and_metrics() {
    let fixture = build_reference_pbc_demag_benchmark_problem(2).expect("fixture");

    assert!(fixture.problem.topology.n_nodes > 0);
    assert!(fixture.problem.topology.elements.len() > 0);
    assert!(fixture.problem.topology.periodic_node_pairs.len() > 0);
    assert_eq!(
        fixture.open_axis_count, 2,
        "fixture should keep y/z open and only x periodic"
    );
    assert_eq!(
        fixture.magnetization.len(),
        fixture.problem.topology.n_nodes
    );

    let metrics = run_reference_pbc_demag_benchmark(2, 1, 2).expect("metrics");

    assert_eq!(metrics.nodes, fixture.problem.topology.n_nodes);
    assert_eq!(metrics.elements, fixture.problem.topology.elements.len());
    assert_eq!(
        metrics.periodic_node_pairs,
        fixture.problem.topology.periodic_node_pairs.len()
    );
    assert_eq!(metrics.warmup_repeats, 1);
    assert_eq!(metrics.measured_repeats, 2);
    assert!(metrics.elapsed_ns > 0);
    assert!(metrics.demag_energy_joules.is_finite());
    assert!(metrics.demag_energy_joules >= 0.0);
    assert!(metrics.max_demag_field_amplitude.is_finite());
    assert!(metrics.max_demag_field_amplitude > 0.0);
}

#[test]
fn fem_pbc_demag_golden_supercell_matches_central_repeated_cell() {
    let metrics = run_reference_pbc_demag_golden_supercell(3).expect("golden metrics");

    assert_eq!(metrics.repeated_cells_x, 15);
    assert_eq!(metrics.mapped_nodes, metrics.primitive_nodes);
    assert!(metrics.relative_l2_error.is_finite());
    assert!(
        metrics.relative_l2_error <= 5e-3,
        "relative_l2_error={} max_relative_error={}",
        metrics.relative_l2_error,
        metrics.max_relative_error
    );
    assert!(metrics.max_relative_error.is_finite());
    assert!(metrics.primitive_demag_energy_joules.is_finite());
    assert!(metrics.repeated_demag_energy_joules.is_finite());
}
