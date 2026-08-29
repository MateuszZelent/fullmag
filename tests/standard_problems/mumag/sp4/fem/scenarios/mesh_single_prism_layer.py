"""Topology-only FEM µMAG SP4 mesh smoke.

The opt-in real-Gmsh assertion is:
    FULLMAG_RUN_SP4_MIXED_TOPOLOGY=1 PYTHONPATH=packages/fullmag-py/src \
      python3 -m pytest -q tests/standard_problems/mumag/sp4/fem/test_mixed_mesh_topology.py

The matching managed mesh command is:
    just fem-managed-headless cpu \
      tests/standard_problems/mumag/sp4/fem/scenarios/mesh_single_prism_layer.py \
      .fullmag/reports/mumag-sp4-mixed-topology

It is a topology/artifact contract only; it does not qualify a solver run.
"""

import os

import fullmag as fm


study = fm.study("mumag_sp4_fem_mesh_single_prism_layer")
study.engine("fem")
# Mixed-P1 authoring requires an explicit execution device.  The managed CPU
# recipe is the default; GPU callers can opt in without changing the fixture.
study.device(os.environ.get("FULLMAG_SP4_DEVICE", "cpu"), precision="double")
study.mode("strict")

study.universe(
    mode="manual",
    size=(700e-9, 250e-9, 250e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=15e-9,
    maximum_element_size=100e-9,
    maximum_element_growth_rate=2.5,
    grading="geometric",
)

film = study.geometry(
    fm.Box(size=(500e-9, 125e-9, 3e-9), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
film.mesh.thin_film(
    minimum_element_size=1e-9,
    maximum_element_size=3e-9,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    interface_maximum_element_size=2e-9,
    interface_thickness=2e-9,
    transition_distance=3e-9,
    edge_maximum_element_size=1.5e-9,
    edge_thickness=12e-9,
    edge_transition_distance=24e-9,
    corner_maximum_element_size=1e-9,
    corner_extent=6e-9,
    corner_transition_distance=12e-9,
    order=1,
)

study.build_domain_mesh()
